import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CategorizedTransaction } from './AssistantCategorizer.js';
import { ExcelTransaction } from './ExcelParser.js';
import { VerificationSummary, computeChainVerification } from './Verification.js';
import { FileSummary } from './JobStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH     = join(__dirname, 'template-bank-statement.xlsx');
const VAT_TEMPLATE_PATH = join(__dirname, 'template-vat.xlsx');

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

function addVerificationSide(ws: ExcelJS.Worksheet, v: VerificationSummary, fileSummaries?: FileSummary[]): void {
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

    if (v.balanceDiff !== null) {
        const balStatus = v.balanceOk
            ? '✓ Balance check OK'
            : `⚠ Mismatch — diff: ${(v.balanceDiff >= 0 ? '+' : '') + v.balanceDiff.toFixed(2)}`;
        write(balStatus, null, true);
    }

    // Per-file verification status
    const almostEqualV = (a: number, b: number) => Math.abs(a - b) < 0.02;
    const verifiable = (fileSummaries ?? []).filter(f =>
        (f.declaredIn != null && f.declaredOut != null) ||
        (f.openingBalance != null && f.closingBalance != null)
    );
    if (verifiable.length > 0) {
        const failed = verifiable.filter(f => {
            if (f.declaredIn != null && f.declaredOut != null) {
                return !almostEqualV(f.parsedIn, f.declaredIn) || !almostEqualV(f.parsedOut, f.declaredOut);
            }
            // opening/closing balance check
            const expected = f.openingBalance! + f.parsedIn - f.parsedOut;
            return !almostEqualV(expected, f.closingBalance!);
        });
        write('');
        write('── Per-file verification ──', null, true);
        if (failed.length === 0) {
            write(`✓ All ${verifiable.length} file${verifiable.length === 1 ? '' : 's'} verified`, null, true);

            // Chain continuity — only meaningful when every individual file is correct.
            // A non-zero diff means the opening of file N+1 doesn't match the closing of
            // file N, i.e. the client likely omitted one or more statements.
            const chain = computeChainVerification(fileSummaries!, v.totalIn, v.totalOut);
            if (chain) {
                write('');
                write('── Chain continuity ──', null, true);
                write('Opening (first file)', chain.chainOpeningBalance);
                write('Closing (last file)',  chain.chainClosingBalance);
                write('');
                // Per-period gap checks (file N closing vs file N+1 opening)
                const pairCount = fileSummaries!.length - 1;
                if (chain.gaps.length > 0) {
                    write('Per-period checks:', null, true);
                    for (const g of chain.gaps) {
                        // Strip .pdf.pdf suffix for readability
                        const label = g.afterFile.replace(/\.pdf\.pdf$/i, '');
                        const sign  = g.diff > 0 ? '+' : '';
                        write(`⚠ After ${label}: close=${g.expectedOpen.toFixed(2)}, next open=${g.actualOpen.toFixed(2)} (${sign}${g.diff.toFixed(2)})`, null, true);
                    }
                    write('');
                } else if (pairCount > 0) {
                    // All consecutive pairs link correctly — always show confirmation
                    write(`✓ All ${pairCount} consecutive period${pairCount === 1 ? '' : 's'} balance correctly`, null, true);
                    write('');
                }
                // Overall net check
                if (chain.ok) {
                    write('✓ No gaps detected', null, true);
                } else if (chain.gaps.length === 0) {
                    // Per-period all OK but overall diff — likely OD balance sign or missing file
                    write(`⚠ Net gap: ${chain.diff > 0 ? '+' : ''}${chain.diff.toFixed(2)} — verify OD balance signs or missing file`, null, true);
                } else {
                    write(`⚠ ${chain.gaps.length} gap${chain.gaps.length > 1 ? 's' : ''} detected — likely missing statement${chain.gaps.length > 1 ? 's' : ''}`, null, true);
                }
            }
        } else {
            write(`⚠ ${failed.length} of ${verifiable.length} file${verifiable.length === 1 ? '' : 's'} failed`, null, true);
            write('  (see Files tab for details)');
        }
    } else if (v.declaredIn != null && v.declaredOut != null) {
        // Fallback: single-file or no fileSummaries — use combined declared check
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

function addFileSummarySheet(workbook: ExcelJS.Workbook, files: FileSummary[]): void {
    const ws = workbook.addWorksheet('Files');

    const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5E8B' } };
    const OK_FILL:     ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6F5D6' } };
    const WARN_FILL:   ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
    const ERR_FILL:    ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };

    const cols = [
        { header: 'File',              key: 'filename',      width: 42 },
        { header: 'Txns',              key: 'transactions',  width: 7  },
        { header: 'Parsed In',         key: 'parsedIn',      width: 13 },
        { header: 'Parsed Out',        key: 'parsedOut',     width: 13 },
        { header: 'Declared In',       key: 'declaredIn',    width: 13 },
        { header: 'Declared Out',      key: 'declaredOut',   width: 13 },
        { header: 'Opening Bal',       key: 'openingBalance',width: 13 },
        { header: 'Closing Bal',       key: 'closingBalance',width: 13 },
        { header: 'In diff',           key: 'inDiff',        width: 10 },
        { header: 'Out diff',          key: 'outDiff',       width: 10 },
        { header: 'Status',            key: 'status',        width: 22 },
    ];
    ws.columns = cols;

    // Header row styling
    const hdr = ws.getRow(1);
    cols.forEach((_, i) => {
        const c = hdr.getCell(i + 1);
        c.fill = HEADER_FILL;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.alignment = { horizontal: 'center' };
    });
    hdr.commit();

    const almostEqual = (a: number, b: number) => Math.abs(a - b) < 0.02;

    files.forEach((f, idx) => {
        const row = ws.getRow(idx + 2);
        const hasDeclared  = f.declaredIn != null && f.declaredOut != null;
        const hasBalances  = !hasDeclared && f.openingBalance != null && f.closingBalance != null;

        let inDiff:   number | null = null;
        let outDiff:  number | null = null;
        let balDiff:  number | null = null;
        let ok:       boolean | null = null;
        let status:   string;
        let rowFill:  ExcelJS.Fill | undefined;

        if (hasDeclared) {
            inDiff  = Math.round((f.parsedIn  - f.declaredIn!)  * 100) / 100;
            outDiff = Math.round((f.parsedOut - f.declaredOut!) * 100) / 100;
            ok      = almostEqual(inDiff, 0) && almostEqual(outDiff, 0);
            status  = ok ? '✓ Match' : '⚠ Mismatch';
            rowFill = ok ? OK_FILL : (Math.abs(inDiff) > 1 || Math.abs(outDiff) > 1 ? ERR_FILL : WARN_FILL);
        } else if (hasBalances) {
            // opening + parsedIn - parsedOut should equal closing
            const expected = f.openingBalance! + f.parsedIn - f.parsedOut;
            balDiff = Math.round((expected - f.closingBalance!) * 100) / 100;
            ok      = almostEqual(balDiff, 0);
            status  = ok ? '✓ Balance OK' : `⚠ Balance diff: ${balDiff > 0 ? '+' : ''}${balDiff.toFixed(2)}`;
            rowFill = ok ? OK_FILL : (Math.abs(balDiff) > 1 ? ERR_FILL : WARN_FILL);
        } else {
            status = '— no check available';
        }

        row.getCell(1).value  = f.filename;
        row.getCell(2).value  = f.transactions;
        row.getCell(3).value  = f.parsedIn;   row.getCell(3).numFmt = MONEY_FMT;
        row.getCell(4).value  = f.parsedOut;  row.getCell(4).numFmt = MONEY_FMT;
        if (f.declaredIn  != null) { row.getCell(5).value = f.declaredIn;  row.getCell(5).numFmt = MONEY_FMT; }
        if (f.declaredOut != null) { row.getCell(6).value = f.declaredOut; row.getCell(6).numFmt = MONEY_FMT; }
        if (f.openingBalance != null) { row.getCell(7).value = f.openingBalance; row.getCell(7).numFmt = MONEY_FMT; }
        if (f.closingBalance != null) { row.getCell(8).value = f.closingBalance; row.getCell(8).numFmt = MONEY_FMT; }
        if (inDiff  != null) { row.getCell(9).value  = inDiff;  row.getCell(9).numFmt  = MONEY_FMT; }
        if (outDiff != null) { row.getCell(10).value = outDiff; row.getCell(10).numFmt = MONEY_FMT; }
        row.getCell(11).value = status;
        row.getCell(11).font  = { bold: ok === false };

        if (rowFill) {
            for (let c = 1; c <= cols.length; c++) row.getCell(c).fill = rowFill;
        }
        row.commit();
    });

    // Totals row
    const totRow = ws.getRow(files.length + 2);
    totRow.getCell(1).value = 'TOTAL';
    totRow.getCell(1).font  = { bold: true };
    const sumIn   = files.reduce((s, f) => s + f.parsedIn,  0);
    const sumOut  = files.reduce((s, f) => s + f.parsedOut, 0);
    const sumTxns = files.reduce((s, f) => s + f.transactions, 0);
    totRow.getCell(2).value = sumTxns;
    totRow.getCell(3).value = Math.round(sumIn  * 100) / 100; totRow.getCell(3).numFmt = MONEY_FMT;
    totRow.getCell(4).value = Math.round(sumOut * 100) / 100; totRow.getCell(4).numFmt = MONEY_FMT;
    for (let c = 1; c <= cols.length; c++) totRow.getCell(c).font = { bold: true };
    totRow.commit();

    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }];
}

export async function buildPdfOutputExcel(transactions: CategorizedTransaction[], verification?: VerificationSummary, fileSummaries?: FileSummary[]): Promise<Buffer> {
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
        addVerificationSide(ws, verification, fileSummaries);
    }

    // Per-file summary sheet (only when multiple files were processed)
    if (fileSummaries && fileSummaries.length > 0) {
        addFileSummarySheet(workbook, fileSummaries);
    }

    // Freeze first 2 rows
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 2, topLeftCell: 'A3' }];

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
}

// ── VAT output ────────────────────────────────────────────────────────────────

const VAT_EXPENSE_CATS = [
    'SALARY','OTHER','INSURANCE','LOAN','CASH','TRAVEL','PHONE',
    'CHARGES','Bank_Transfer','HMRC','RENT','BILLS',
] as const;

function parseCatMoney(s: unknown): number {
    if (!s) return 0;
    const n = Number(String(s).replace(/,/g, '').trim());
    return isFinite(n) ? Math.abs(n) : 0;
}

// VAT verification side panel: cols K=11, L=12 of the Sales sheet, starting at row 3
const VAT_VER_LABEL_COL = 11;
const VAT_VER_VALUE_COL = 12;

interface VatStats {
    total:         number;
    salesCount:    number;
    salesTotal:    number;
    expensesCount: number;
    expensesTotal: number;
}

function addVatVerificationSide(ws: ExcelJS.Worksheet, stats: VatStats): void {
    let r = 3;

    const write = (label: string, value?: number | string | null, bold = false) => {
        const row = ws.getRow(r++);
        const lc = row.getCell(VAT_VER_LABEL_COL);
        lc.value = label;
        if (bold) lc.font = { bold: true };
        if (value != null) {
            const vc = row.getCell(VAT_VER_VALUE_COL);
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

    write('VAT SUMMARY', null, true);
    write('');
    write('Total transactions', String(stats.total));
    write('');
    write('── Sales ──', null, true);
    write('Entries', String(stats.salesCount));
    write('Total net amount', stats.salesTotal);
    write('');
    write('── Expenses ──', null, true);
    write('Entries', String(stats.expensesCount));
    write('Total gross amount', stats.expensesTotal);
    write('');
    write(`✓ ${stats.salesCount + stats.expensesCount} of ${stats.total} transactions written`, null, true);
}

/**
 * Build a VAT-template Excel from categorized transactions.
 * Income rows (INCOME > 0) → Sales sheet, col E (NET AMOUNT).
 * Expense rows (any expense category > 0) → Expenses sheet, col E (GROSS).
 * Columns: C = date, D = description, E = amount.
 * A verification summary is placed to the right of the Sales table (cols K-L).
 */
export async function buildVatOutputExcel(transactions: CategorizedTransaction[], clientName?: string): Promise<Buffer> {
    const templateBuf = readFileSync(VAT_TEMPLATE_PATH);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuf as unknown as ArrayBuffer);

    if (clientName) {
        const vatReturnWs = workbook.getWorksheet('VAT Return');
        if (vatReturnWs) {
            vatReturnWs.getCell('C1').value = clientName;
            try { vatReturnWs.getCell('D1').value = clientName; } catch {}
        }
    }

    const salesWs    = workbook.getWorksheet('Sales');
    const expensesWs = workbook.getWorksheet('Expenses');
    if (!salesWs || !expensesWs) throw new Error('template-vat.xlsx is missing Sales or Expenses sheet');

    const FIRST_DATA_ROW = 5;
    let salesRow    = FIRST_DATA_ROW;
    let expensesRow = FIRST_DATA_ROW;

    const stats: VatStats = {
        total:         transactions.length,
        salesCount:    0,
        salesTotal:    0,
        expensesCount: 0,
        expensesTotal: 0,
    };

    for (const t of transactions) {
        const incomeAmt  = parseCatMoney(t.INCOME);
        const expenseAmt = VAT_EXPENSE_CATS.reduce((s, k) => s + parseCatMoney((t as any)[k]), 0);

        // Positive transaction (income) → Sales; negative (expense) → Expenses
        if (incomeAmt > 0) {
            const row = salesWs.getRow(salesRow++);
            row.getCell(3).value = t.DATE;
            row.getCell(4).value = t['Type and Description'];
            row.getCell(5).value = incomeAmt;
            row.commit();
            stats.salesCount++;
            stats.salesTotal = Math.round((stats.salesTotal + incomeAmt) * 100) / 100;
        } else if (expenseAmt > 0) {
            const row = expensesWs.getRow(expensesRow++);
            row.getCell(3).value = t.DATE;
            row.getCell(4).value = t['Type and Description'];
            row.getCell(5).value = expenseAmt;
            row.commit();
            stats.expensesCount++;
            stats.expensesTotal = Math.round((stats.expensesTotal + expenseAmt) * 100) / 100;
        }
        // Zero-amount rows (e.g. pure balance entries) are skipped — not written to either sheet
    }

    addVatVerificationSide(salesWs, stats);

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
