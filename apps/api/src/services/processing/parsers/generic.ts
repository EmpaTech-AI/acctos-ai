// Generic / fallback parser - used for unknown banks and assistant path
import { Cell, ParsedTransaction, ParseResult, normStr, parseDateToDDMMYYYY, buildGrid, getCell, maxRow, maxCol } from './shared.js';

const DATE_RE = /(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4})/;

function looksLikeDate(s: string): boolean {
    return DATE_RE.test(s);
}

function looksLikeAmount(s: string): boolean {
    return /^\s*[-+]?[\d,]+\.?\d{0,2}\s*$/.test(s.replace(/[£$€]/g, ''));
}

export function parse(cells: Cell[]): ParseResult {
    if (cells.length === 0) return { transactions: [] };

    const grid = buildGrid(cells);
    const rows = maxRow(cells);

    // Scan all rows to find a transaction header row.
    // A valid header needs a 'date' column plus at least one of (in / out / balance).
    // This handles PDFs where metadata/fee tables precede the transaction table.
    let dateCol = -1, descCol = -1, inCol = -1, outCol = -1, balCol = -1, typeCol = -1;
    let headerRowIndex = -1;

    for (let r = 0; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;
        let dc = -1, pc = -1, ic = -1, oc = -1, bc = -1, tc = -1;
        for (const [c, v] of row) {
            const lower = v.toLowerCase().trim();
            if (dc < 0 && (lower.includes('date') || lower === 'datum')) dc = c;
            else if (pc < 0 && (lower === 'transaction' || lower === 'transactions' || lower.includes('desc') || lower.includes('detail') || lower.includes('narrat') || lower === 'memo' || lower.includes('particulars') || lower.includes('explain'))) pc = c;
            else if (tc < 0 && (lower === 'type' || lower === 'code' || lower === 'ref')) tc = c;
            // Use specific patterns only — 'lower.includes("in")' is too broad (matches "business", "opening", "closing")
            else if (ic < 0 && (lower === 'in' || lower === 'incoming' || lower === 'inward' || lower.includes('credit') || lower.includes('paid in') || lower.includes('money in') || lower.includes('deposit'))) ic = c;
            else if (oc < 0 && (lower === 'out' || lower.includes('debit') || lower.includes('paid out') || lower.includes('money out') || lower.includes('withdraw'))) oc = c;
            else if (bc < 0 && lower.includes('bal')) bc = c;
        }
        if (dc >= 0 && (ic >= 0 || oc >= 0 || bc >= 0)) {
            dateCol = dc; descCol = pc; typeCol = tc; inCol = ic; outCol = oc; balCol = bc;
            headerRowIndex = r;
            break;
        }
    }

    // Fallback: guess by position if header not found
    if (dateCol < 0) dateCol = 0;
    if (descCol < 0) descCol = 1;

    const startRow = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
    const transactions: ParsedTransaction[] = [];

    for (let r = startRow; r <= rows; r++) {
        let rawDate = getCell(grid, r, dateCol);
        if (!rawDate || !looksLikeDate(rawDate)) continue;

        // Strip trailing non-date text (e.g. "30 May 25\nTransaction" → "30 May 25")
        const leadingDate = rawDate.match(/^(\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/);
        if (leadingDate) rawDate = leadingDate[1];

        const date = parseDateToDDMMYYYY(rawDate);
        if (!date) continue;

        const type = typeCol >= 0 ? getCell(grid, r, typeCol) : '';
        const description = descCol >= 0 ? getCell(grid, r, descCol) : '';
        const moneyIn  = inCol >= 0 ? getCell(grid, r, inCol).replace(/,/g, '') : '';
        const moneyOut = outCol >= 0 ? getCell(grid, r, outCol).replace(/,/g, '') : '';
        const balance  = balCol >= 0 ? getCell(grid, r, balCol).replace(/,/g, '') : '';

        // Skip rows with no amount data
        if (!moneyIn && !moneyOut && !balance) continue;

        transactions.push({ date, type, description, moneyIn, moneyOut, balance });
    }

    // Detect sort direction from the parsed data: if first date < last date the PDF is oldest-first
    let ascending: boolean | undefined;
    if (transactions.length >= 2) {
        const toNum = (d: string) => {
            const [dd, mm, yyyy] = d.split('/');
            return +yyyy * 10000 + +mm * 100 + +dd;
        };
        const first = toNum(transactions[0].date);
        const last  = toNum(transactions[transactions.length - 1].date);
        if (first < last) ascending = true;
    }

    return { transactions, ascending };
}
