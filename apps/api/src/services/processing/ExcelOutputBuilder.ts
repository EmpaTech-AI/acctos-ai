import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CategorizedTransaction } from './AssistantCategorizer.js';
import { ExcelTransaction } from './ExcelParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'template-bank-statement.xlsx');

// Category column keys → Excel column indices 4–15 (E–P)
const CAT_COLS: (keyof CategorizedTransaction)[] = [
    'SALARY', 'OTHER', 'INSURANCE', 'LOAN', 'CASH',
    'TRAVEL', 'PHONE', 'CHARGES', 'Bank_Transfer', 'HMRC', 'RENT', 'BILLS',
];

// Fallback formats per column index (used only if data rows exceed template rows)
const COL_FMT: Record<number, string> = {
    0:  'dd/MM/yyyy',
    2:  '#,##0.00',   // INCOME
    5:  '#,##0.00',   // OTHER
    12: '#,##0.00',   // Bank_Transfer
    16: '#,##0.00',   // Balance
};

const S_NONE   = { patternType: 'none' };
const S_YELLOW = { patternType: 'solid', fgColor: { rgb: 'FFFF00' }, bgColor: { rgb: 'FFFF00' } };

/** "DD/MM/YYYY" → Excel serial number */
function toSerial(ddmmyyyy: string): number | null {
    if (!ddmmyyyy) return null;
    const p = ddmmyyyy.split('/');
    if (p.length !== 3) return null;
    const [dd, mm, yyyy] = p.map(Number);
    if (!yyyy || !mm || !dd) return null;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return Math.floor((d.getTime() - epoch.getTime()) / 86400000);
}

/** String/number → parsed float, or null if empty/zero */
function toNum(v: unknown): number | null {
    const s = String(v ?? '').replace(/,/g, '').trim();
    if (!s) return null;
    const n = parseFloat(s);
    return isFinite(n) && n !== 0 ? n : null;
}

/**
 * Get the format string for a given column from the template's row-3 stub.
 * Falls back to COL_FMT or 'General'.
 */
function getColFmt(ws: XLSX.WorkSheet, col: number): string {
    const addr = XLSX.utils.encode_cell({ r: 2, c: col }); // row 3 = index 2
    return (ws[addr] as any)?.z ?? COL_FMT[col] ?? 'General';
}

/** Write a numeric value into the worksheet, preserving template format/style */
function writeNum(ws: XLSX.WorkSheet, r: number, c: number, v: number, fmt: string) {
    (ws as any)[XLSX.utils.encode_cell({ r, c })] = { t: 'n', v, z: fmt, s: S_NONE };
}

/** Write a text value into the worksheet */
function writeStr(ws: XLSX.WorkSheet, r: number, c: number, v: string) {
    (ws as any)[XLSX.utils.encode_cell({ r, c })] = { t: 's', v, s: S_NONE };
}

/** Ensure yellow stub exists for column D on a given row */
function ensureYellow(ws: XLSX.WorkSheet, r: number) {
    const addr = XLSX.utils.encode_cell({ r, c: 3 });
    if (!ws[addr]) {
        (ws as any)[addr] = { t: 'z', z: 'General', s: S_YELLOW };
    }
}

export function buildPdfOutputExcel(transactions: CategorizedTransaction[]): Buffer {
    const templateBuf = readFileSync(TEMPLATE_PATH);
    const wb = XLSX.read(templateBuf, { cellStyles: true, sheetStubs: true });
    const ws = wb.Sheets[wb.SheetNames[0]];

    // Pre-read template column formats from row 3 stubs
    const colFmts = Array.from({ length: 17 }, (_, c) => getColFmt(ws, c));

    transactions.forEach((t, ri) => {
        const r = ri + 2; // data starts at row index 2 (Excel row 3)

        const serial = toSerial(String(t.DATE ?? ''));
        if (serial !== null) writeNum(ws, r, 0, serial, colFmts[0]);

        const name = String(t['Type and Description'] ?? '').trim();
        if (name) writeStr(ws, r, 1, name);

        const income = toNum(t.INCOME);
        if (income !== null) writeNum(ws, r, 2, income, colFmts[2]);

        // Column D: yellow separator — ensure it exists for rows beyond template range
        ensureYellow(ws, r);

        CAT_COLS.forEach((col, i) => {
            const val = toNum((t as any)[col]);
            if (val !== null) writeNum(ws, r, 4 + i, val, colFmts[4 + i]);
        });

        const balance = toNum(t.Balance);
        if (balance !== null) writeNum(ws, r, 16, balance, colFmts[16]);
    });

    // Trim sheet range to actual data (A1:Q{last row})
    const lastRow = transactions.length + 1; // 0-indexed
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: 16 } });

    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }));
}

export function buildExcelOutputExcel(transactions: ExcelTransaction[]): Buffer {
    const EXCEL_HEADERS = ['Date', 'Type', 'Type and Description', 'Money in', 'Money out', 'Balance'];

    const rows = transactions.map(t => [
        t.Date,
        t.Type,
        t['Type and Description'],
        t['Money in'],
        t['Money out'],
        t.Balance,
    ]);

    const ws = XLSX.utils.aoa_to_sheet([EXCEL_HEADERS, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
