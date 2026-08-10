// Halifax parser — 6-column layout (two variants):
//   Variant A (original): [date, description, type, money_in, money_out, balance]
//   Variant B (Pmnt Type / Reward): [date, pmnt_type, details, money_out(£), money_in(£), balance(£)]
// Column positions are detected dynamically from the header row so both variants work correctly.
// Summary block on page 1 carries Money In / Money Out totals and period balances.
// Two OCR formats exist for the summary block:
//   Format 1 (inline): "Money In £3,257.38   Balance on 01 June 2025 £22,226.18"
//   Format 2 (multi-line): "Money In\nMoney Out\nYour Transactions\n£46,067.61\n£60,781.74"
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
    if (/\bdate\b/.test(j))                          hits++;
    if (/description/.test(j) || /\bdetails\b/.test(j)) hits++;
    if (/\btype\b/.test(j))                           hits++;
    if (/money\s*in/.test(j))                         hits++;
    if (/money\s*out/.test(j))                        hits++;
    if (/balance/.test(j))                            hits++;
    return hits >= 3;
}

function isBalanceSummaryRow(cols: string[]): boolean {
    const j = cols.join(' ').toLowerCase();
    return j.includes('statement closing balance') || j.includes('statement opening balance');
}

function extractDeclaredTotals(content: string): ParseResult['statementTotals'] | undefined {
    const amt = (m: RegExpMatchArray | null): number | null =>
        m ? parseMoney(m[1].replace(/,/g, '')) : null;

    // Format 1 (inline): "Money In £3,257.38" / "Money Out £4,067.99"
    // Column header "Money In (£)" won't match because "(" precedes £, not a digit.
    let moneyIn  = amt(content.match(/money\s+in\s+£\s*([\d,]+\.\d{2})/i));
    let moneyOut = amt(content.match(/money\s+out\s+£\s*([\d,]+\.\d{2})/i));

    if (moneyIn === null || moneyOut === null) {
        // Format 2 (multi-line): OCR reads "Money In" and "Money Out" as separate column headers
        // with the £ amounts on subsequent lines, e.g.:
        //   Money In\nMoney Out\nYour Transactions\n£46,067.61\n£60,781.74
        // "Money In (£)" (table column header) won't match because "(£)" prevents the immediate newline.
        const ml = content.match(
            /money\s+in[\r\n]\s*money\s+out(?:[\r\n][^\r\n£]*){0,3}[\r\n]\s*£\s*([\d,]+\.\d{2})[\r\n]\s*£\s*([\d,]+\.\d{2})/i,
        );
        if (ml) {
            moneyIn  = parseMoney(ml[1].replace(/,/g, ''));
            moneyOut = parseMoney(ml[2].replace(/,/g, ''));
        }
    }

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

    // Locate first transaction header; detect column positions dynamically.
    // Defaults match variant A: [date, description, type, money_in, money_out, balance]
    let startAt  = 0;
    let COL_IN   = 3;
    let COL_OUT  = 4;
    let COL_TYPE = 2;
    let COL_DESC = 1;
    let COL_BAL  = 5;

    for (let i = 0; i < table.length; i++) {
        if (!isHeaderRow(table[i])) continue;
        startAt = i + 1;

        // Scan header cells to find actual money-in / money-out column positions.
        // This handles variant B where Money Out (£) is at col 3 and Money In (£) at col 4.
        for (let c = 0; c < table[i].length; c++) {
            const v = table[i][c].toLowerCase().replace(/\s+/g, ' ').trim();
            if (!v) continue;
            if (/money\s*in/.test(v)  && !/money\s*out/.test(v)) { COL_IN   = c; continue; }
            if (/money\s*out/.test(v) && !/money\s*in/.test(v))  { COL_OUT  = c; continue; }
            if (/description/.test(v) || v === 'details')         { COL_DESC = c; continue; }
            if (/\btype\b/.test(v) || v.includes('pmnt'))         { COL_TYPE = c; continue; }
            if (v.startsWith('balance'))                          { COL_BAL  = c; continue; }
        }
        break;
    }

    const transactions: ParsedTransaction[] = [];
    let lastDate = '';

    for (let i = startAt; i < table.length; i++) {
        const cols = table[i];
        if (cols.every(c => !c)) continue;

        // Skip repeat page headers (pages 2–4) and page-5 type legend rows
        if (isHeaderRow(cols)) continue;

        // Skip statement opening/closing balance summary rows — their cumulative totals
        // would be double-counted as transactions if left in
        if (isBalanceSummaryRow(cols)) continue;

        const parsedDate = parseDateToDDMMYYYY(cols[0]);
        if (parsedDate) lastDate = parsedDate;
        const date = parsedDate || lastDate;
        if (!date) continue;

        const inAmt  = parseMoney(cols[COL_IN]);
        const outAmt = parseMoney(cols[COL_OUT]);
        if ((inAmt === null || inAmt <= 0) && (outAmt === null || outAmt <= 0)) continue;

        const balNum = parseMoney(cols[COL_BAL]);

        transactions.push({
            date,
            type:        normStr(cols[COL_TYPE]),
            description: normStr(cols[COL_DESC]) || 'Unknown',
            moneyIn:     inAmt  !== null && inAmt  > 0 ? formatMoney(inAmt)  : '',
            moneyOut:    outAmt !== null && outAmt > 0 ? formatMoney(outAmt) : '',
            balance:     balNum !== null ? balNum.toFixed(2) : '',
        });
    }

    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}
