import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CategorizedTransaction } from './AssistantCategorizer.js';
import { ExcelTransaction } from './ExcelParser.js';
import { VerificationSummary } from './Verification.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'template-bank-statement.xlsx');

// Category column keys → Excel columns E–P (1-based: 5–16)
const CAT_COLS: (keyof CategorizedTransaction)[] = [
    'SALARY', 'OTHER', 'INSURANCE', 'LOAN', 'CASH',
    'TRAVEL', 'PHONE', 'CHARGES', 'Bank_Transfer', 'HMRC', 'RENT', 'BILLS',
];

const YELLOW_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const MONEY_FMT = '#,##0.00';

// Verification summary goes to the right of the main table (cols 19-20),
// starting at row 3, so transactions are never interrupted.
const VER_LABEL_COL = 19;
const VER_VALUE_COL = 20;

function addVerificationSide(ws: ExcelJS.Worksheet, v: VerificationSummary): void {
    let r = 3;

    const write = (label: string, value?: number | string | null, bold = false) => {
        const row = ws.getRow(r++);
        const lc = row.getCell(VER_LABEL_COL);
        lc.value = label;
        if (bold) lc.font = { bold: true };
        if (value != null) {
            const vc = row.getCell(VER_VALUE_COL);
            if (typeof value === 'number') {
                vc.value = value;
                vc.numFmt = MONEY_FMT;
            } else {
                vc.value = value;
                if (bold) vc.font = { bold: true };
            }
        }
        row.commit();
    };

    write('VERIFICATION SUMMARY', null, true);
    write('');
    if (v.openingBalance != null) write('Opening balance', v.openingBalance);
    write('Total money in',  v.totalIn);
    write('Total money out', v.totalOut);
    if (v.closingBalance != null) write('Closing balance', v.closingBalance);
    write('');

    const balStatus = v.balanceOk
        ? '✓ Balance check OK'
        : `⚠ Mismatch — diff: ${v.balanceDiff != null ? (v.balanceDiff >= 0 ? '+' : '') + v.balanceDiff.toFixed(2) : 'unknown'}`;
    write(balStatus, null, true);

    if (v.declaredIn != null && v.declaredOut != null) {
        write('');
        write('Declared in (by bank)',  v.declaredIn);
        write('Declared out (by bank)', v.declaredOut);
        write('');
        const declStatus = v.declaredOk
            ? '✓ Declared totals match'
            : `⚠ In diff: ${(v.totalIn - v.declaredIn).toFixed(2)}, Out diff: ${(v.totalOut - v.declaredOut).toFixed(2)}`;
        write(declStatus, null, true);
    }

    if (v.catTotalIn != null && v.catTotalOut != null) {
        write('');
        write('── After categorization ──', null, true);
        write('Categorized in',  v.catTotalIn);
        write('Categorized out', v.catTotalOut);
        write('');
        const catStatus = v.catOk
            ? '✓ Category totals match'
            : `⚠ In diff: ${(v.catTotalIn - v.totalIn).toFixed(2)}, Out diff: ${(v.catTotalOut - v.totalOut).toFixed(2)}`;
        write(catStatus, null, true);
    }
}

/** "DD/MM/YYYY" → Date (UTC) */
function parseDate(ddmmyyyy: string): Date | null {
    if (!ddmmyyyy) return null;
    const p = ddmmyyyy.split('/');
    if (p.length !== 3) return null;
    const [dd, mm, yyyy] = p.map(Number);
    if (!yyyy || !mm || !dd) return null;
    return new Date(Date.UTC(yyyy, mm - 1, dd));
}

/** String/number → parsed float, or null if empty/zero */
function toNum(v: unknown): number | null {
    const s = String(v ?? '').replace(/,/g, '').trim();
    if (!s) return null;
    const n = parseFloat(s);
    return isFinite(n) && n !== 0 ? n : null;
}

export async function buildPdfOutputExcel(transactions: CategorizedTransaction[], verification?: VerificationSummary): Promise<Buffer> {
    const templateBuf = readFileSync(TEMPLATE_PATH);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuf as unknown as ArrayBuffer);

    const ws = workbook.worksheets[0];

    // Apply yellow to column D (col 4) in header rows before clearing data
    for (let r = 1; r <= 2; r++) {
        ws.getRow(r).getCell(4).fill = YELLOW_FILL;
    }

    // Remove all data rows (row 3 onwards)
    const totalRows = ws.rowCount;
    if (totalRows > 2) {
        ws.spliceRows(3, totalRows - 2);
    }

    // Write transactions starting at row 3
    transactions.forEach((t, ri) => {
        const row = ws.getRow(ri + 3);

        const date = parseDate(String(t.DATE ?? ''));
        if (date !== null) {
            const cell = row.getCell(1);
            cell.value = date;
            cell.numFmt = 'dd/MM/yyyy';
        }

        const name = String(t['Type and Description'] ?? '').trim();
        if (name) row.getCell(2).value = name;

        const income = toNum(t.INCOME);
        if (income !== null) {
            const cell = row.getCell(3);
            cell.value = income;
            cell.numFmt = '#,##0.00';
        }

        // Column D (col 4) — always yellow, no data
        row.getCell(4).fill = YELLOW_FILL;

        CAT_COLS.forEach((col, i) => {
            const val = toNum((t as any)[col]);
            if (val !== null) {
                const cell = row.getCell(5 + i);
                cell.value = val;
                cell.numFmt = '#,##0.00';
            }
        });

        const balance = toNum(t.Balance);
        if (balance !== null) {
            const cell = row.getCell(17);
            cell.value = balance;
            cell.numFmt = '#,##0.00';
        }

        row.commit();
    });

    // Fill column D yellow for all remaining rows — always at least 250 beyond data, minimum row 1000
    const lastDataRow = transactions.length + 2;
    const yellowEnd = Math.max(1000, lastDataRow + 250);
    for (let r = lastDataRow + 1; r <= yellowEnd; r++) {
        const row = ws.getRow(r);
        row.getCell(4).fill = YELLOW_FILL;
        row.commit();
    }

    // Verification summary: placed to the right of the table (cols 19-20), no background colours
    if (verification) {
        addVerificationSide(ws, verification);
    }

    // Freeze first 2 rows
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 2, topLeftCell: 'A3' }];

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
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
