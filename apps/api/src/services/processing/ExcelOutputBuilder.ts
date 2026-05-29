import * as XLSX from 'xlsx';
import { readFileSync, writeFileSync } from 'fs';
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

export function buildPdfOutputExcel(transactions: CategorizedTransaction[]): Buffer {
    const templateBuf = readFileSync(TEMPLATE_PATH);
    const wb = XLSX.read(templateBuf, { cellStyles: true, sheetStubs: true });
    const ws = wb.Sheets[wb.SheetNames[0]];

    // Read column formats from row-3 stubs before clearing
    const colFmts: Record<number, string> = {
        0: 'dd/MM/yyyy',
        2: '#,##0.00', 4: '#,##0.00', 5: '#,##0.00', 6: '#,##0.00',
        7: '#,##0.00', 8: '#,##0.00', 9: '#,##0.00', 10: '#,##0.00',
        11: '#,##0.00', 12: '#,##0.00', 13: '#,##0.00', 14: '#,##0.00',
        15: '#,##0.00', 16: '#,##0.00',
    };
    for (let c = 0; c <= 16; c++) {
        const addr = XLSX.utils.encode_cell({ r: 2, c });
        const z = (ws[addr] as any)?.z;
        if (z) colFmts[c] = z;
    }

    // Clear all data rows (row index ≥ 2 = Excel row 3+)
    const existingRef = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:Q2');
    for (let r = 2; r <= existingRef.e.r; r++) {
        for (let c = 0; c <= Math.max(existingRef.e.c, 16); c++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            if (ws[addr]) delete ws[addr];
        }
    }

    // Write transactions starting at row 3 (index 2)
    transactions.forEach((t, ri) => {
        const r = ri + 2;

        const serial = toSerial(String(t.DATE ?? ''));
        if (serial !== null) {
            (ws as any)[XLSX.utils.encode_cell({ r, c: 0 })] = { t: 'n', v: serial, z: colFmts[0] };
        }

        const name = String(t['Type and Description'] ?? '').trim();
        if (name) {
            (ws as any)[XLSX.utils.encode_cell({ r, c: 1 })] = { t: 's', v: name };
        }

        const income = toNum(t.INCOME);
        if (income !== null) {
            (ws as any)[XLSX.utils.encode_cell({ r, c: 2 })] = { t: 'n', v: income, z: colFmts[2] };
        }

        CAT_COLS.forEach((col, i) => {
            const val = toNum((t as any)[col]);
            if (val !== null) {
                (ws as any)[XLSX.utils.encode_cell({ r, c: 4 + i })] = { t: 'n', v: val, z: colFmts[4 + i] };
            }
        });

        const balance = toNum(t.Balance);
        if (balance !== null) {
            (ws as any)[XLSX.utils.encode_cell({ r, c: 16 })] = { t: 'n', v: balance, z: colFmts[16] };
        }
    });

    // Update sheet range
    const lastRow = Math.max(1, transactions.length + 1);
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
