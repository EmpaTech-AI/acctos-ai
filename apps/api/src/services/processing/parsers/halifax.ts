// Halifax parser — 6-column layout: [date, description, type, money_in, money_out, balance]
// Summary block on page 1 carries Money In / Money Out totals and period balances:
//   "Money In £3,257.38   Balance on 01 June 2025 £22,226.18"
//   "Money Out £4,067.99  Balance on 30 June 2025 £21,415.57"
// Transactions are in ascending date order across pages 1–4; page 5 is a type legend only.
// Date format: "2 Jun 25" (D MMM YY) — handled by parseDateToDDMMYYYY.
// Note: Halifax is a division of Bank of Scotland plc — both are classified as 'halifax'.
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, parseDateToDDMMYYYY,
    buildGrid, getCell, maxCol,
} from './shared.js';

function isHeaderRow(cols: string[]): boolean {
    const j = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b/.test(j))    hits++;
    if (/description/.test(j)) hits++;
    if (/\btype\b/.test(j))    hits++;
    if (/money\s*in/.test(j))  hits++;
    if (/money\s*out/.test(j)) hits++;
    if (/balance/.test(j))     hits++;
    return hits >= 3;
}

function extractDeclaredTotals(content: string): ParseResult['statementTotals'] | undefined {
    const amt = (m: RegExpMatchArray | null): number | null =>
        m ? parseMoney(m[1].replace(/,/g, '')) : null;

    // "Money In £3,257.38" / "Money Out £4,067.99" — column header "Money In (£)" won't match
    // because it has "(" before £, not a digit
    const moneyIn  = amt(content.match(/money\s+in\s+£\s*([\d,]+\.\d{2})/i));
    const moneyOut = amt(content.match(/money\s+out\s+£\s*([\d,]+\.\d{2})/i));
    if (moneyIn === null || moneyOut === null) return undefined;

    // "Balance on 01 June 2025 £22,226.18" — first = opening, last = closing
    const balMatches = [...content.matchAll(/balance\s+on\s+\d{1,2}\s+\w+\s+\d{4}\s+£\s*([\d,]+\.\d{2})/gi)];
    const openingBalance = balMatches.length > 0
        ? amt(balMatches[0]) ?? undefined
        : undefined;
    const closingBalance = balMatches.length > 1
        ? amt(balMatches[balMatches.length - 1]) ?? undefined
        : undefined;

    return { moneyIn, moneyOut, openingBalance, closingBalance };
}

export function parse(cells: Cell[]): ParseResult {
    const contextContent  = cells.find(c => c.rowIndex < 0)?.content ?? '';
    const statementTotals = extractDeclaredTotals(contextContent);

    const grid     = buildGrid(cells);
    const colCount = maxCol(cells);

    const rowIndexes = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);
    const table = rowIndexes.map(r => {
        const cols: string[] = [];
        for (let c = 0; c <= colCount; c++) cols.push(normStr(getCell(grid, r, c)));
        return cols;
    });

    if (!table.length) return { transactions: [] };

    // Locate first transaction header; start processing after it
    let startAt = 0;
    for (let i = 0; i < table.length; i++) {
        if (isHeaderRow(table[i])) { startAt = i + 1; break; }
    }

    const transactions: ParsedTransaction[] = [];
    let lastDate = '';

    for (let i = startAt; i < table.length; i++) {
        const cols = table[i];
        if (cols.every(c => !c)) continue;

        // Skip repeat page headers (pages 2–4) and page-5 type legend rows
        if (isHeaderRow(cols)) continue;

        const parsedDate = parseDateToDDMMYYYY(cols[0]);
        if (parsedDate) lastDate = parsedDate;
        const date = parsedDate || lastDate;
        if (!date) continue;

        const inAmt  = parseMoney(cols[3]);
        const outAmt = parseMoney(cols[4]);
        if ((inAmt === null || inAmt <= 0) && (outAmt === null || outAmt <= 0)) continue;

        const balNum = parseMoney(cols[5]);

        transactions.push({
            date,
            type:        normStr(cols[2]),
            description: normStr(cols[1]) || 'Unknown',
            moneyIn:     inAmt  !== null && inAmt  > 0 ? formatMoney(inAmt)  : '',
            moneyOut:    outAmt !== null && outAmt > 0 ? formatMoney(outAmt) : '',
            balance:     balNum !== null ? balNum.toFixed(2) : '',
        });
    }

    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}
