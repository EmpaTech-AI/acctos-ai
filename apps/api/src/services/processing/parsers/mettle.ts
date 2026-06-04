// Mettle (by NatWest) parser
// Column layout: DATE | DESCRIPTION | £ IN | £ OUT | £ BALANCE
// Rows 0-3 contain a summary section with declared totals.
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow,
    parseDateToDDMMYYYY,
} from './shared.js';

function amt(s: string): string {
    const n = parseMoney(s);
    return n !== null && n !== 0 ? formatMoney(Math.abs(n)) : '';
}

function isHeaderRow(row: Map<number, string>): boolean {
    const vals = [...row.values()].map(v => normStr(v).toLowerCase());
    return vals.some(v => v === 'date') && vals.some(v => v.includes('description'));
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);

    // ── Extract declared totals from summary rows 0-3 ────────────────────────
    // Row 1: "Money in"  | amount    (positive)
    // Row 2: "Money out" | amount    (negative, e.g. -£15,797.84)
    let statementTotals: { moneyIn: number; moneyOut: number } | undefined;
    let declaredIn: number | null = null;
    let declaredOut: number | null = null;

    for (let r = 0; r <= 4; r++) {
        const row = grid.get(r);
        if (!row) continue;
        const label = normStr(row.get(0) ?? '').toLowerCase();
        const valStr = normStr(row.get(1) ?? '');
        if (/^money\s+in/.test(label)) {
            const n = parseMoney(valStr);
            if (n !== null) declaredIn = Math.abs(n);
        } else if (/^money\s+out/.test(label)) {
            const n = parseMoney(valStr);
            if (n !== null) declaredOut = Math.abs(n);
        }
    }
    if (declaredIn !== null && declaredOut !== null) {
        statementTotals = { moneyIn: declaredIn, moneyOut: declaredOut };
    }

    // ── Find header row ───────────────────────────────────────────────────────
    let headerRowIndex = -1;
    let dateCol = 0, descCol = 1, inCol = 2, outCol = 3, balCol = 4;

    for (let r = 0; r <= Math.min(10, rows); r++) {
        const row = grid.get(r);
        if (!row || !isHeaderRow(row)) continue;
        headerRowIndex = r;
        for (const [c, v] of row) {
            const lo = normStr(v).toLowerCase();
            if (lo === 'date')                             dateCol = c;
            else if (lo.includes('description'))          descCol = c;
            else if (lo.includes('in') && !lo.includes('out') && !lo.includes('balance')) inCol = c;
            else if (lo.includes('out') && !lo.includes('balance')) outCol = c;
            else if (lo.includes('balance'))              balCol  = c;
        }
        break;
    }

    // ── Parse transactions ────────────────────────────────────────────────────
    const transactions: ParsedTransaction[] = [];

    for (let r = headerRowIndex + 1; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;

        // Skip repeated header rows from subsequent pages
        if (isHeaderRow(row)) continue;

        const rawDate = normStr(getCell(grid, r, dateCol));
        const date = rawDate ? parseDateToDDMMYYYY(rawDate) : '';
        if (!date) continue;

        const description = normStr(getCell(grid, r, descCol));
        const moneyIn  = amt(getCell(grid, r, inCol));
        const moneyOut = amt(getCell(grid, r, outCol));
        const balance  = normStr(getCell(grid, r, balCol));

        if (!moneyIn && !moneyOut) continue;

        transactions.push({ date, type: '', description, moneyIn, moneyOut, balance });
    }

    // Mettle PDF is oldest-first — preserve that order; callers use ascending=true
    return { transactions, statementTotals, ascending: true };
}
