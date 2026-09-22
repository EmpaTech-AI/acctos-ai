import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid,
    parseDateToDDMMYYYY
} from './shared.js';

// Known Starling transaction types used in raw-text fallback
const RAW_TYPES = [
    'FASTER PAYMENT', 'CONTACTLESS', 'ONLINE PAYMENT',
    'CARD SUBSCRIPTION', 'CHIP & PIN', 'ATM',
];

// These types are always outgoing — never a credit/refund in Starling exports.
// When Azure DI places the amount in col 3 (IN) instead of col 4 (OUT),
// we correct the direction automatically.
// Excluded: CONTACTLESS, APPLE PAY, CHIP & PIN, ONLINE PAYMENT (refunds possible),
//           FASTER PAYMENT (explicitly IN or OUT depending on direction).
const ALWAYS_OUT_TYPES = new Set([
    'CARD SUBSCRIPTION', 'DIRECT DEBIT', 'STANDING ORDER',
]);

function isHeaderRow(cells: string[]): boolean {
    const j = cells.join(' ').toLowerCase();
    return (
        j.includes('date') &&
        j.includes('type') &&
        j.includes('transaction') &&
        j.includes('in') &&
        j.includes('out')
    );
}

/**
 * A cell that holds a money value, as a magnitude, or null when it does not.
 *
 * `parseMoney` alone is NOT safe for deciding whether a cell *is* money: it strips
 * every non-digit and then reads Number(''), which is 0. It answers 0 for "Variable"
 * and "%AER", and 1 for a stray reference fragment like "Ref 1". Layout detection
 * reads cells that routinely contain exactly that kind of text, and mistaking one
 * for a balance is the misdetection this module exists to prevent. So require the
 * whole cell to look like a money token before trusting the parse.
 *
 * The two decimal places are required deliberately. Without them a bare integer —
 * a payment reference, a page number, a year, a masked card fragment — reads as a
 * balance, and one such cell in col 5 of a dated row is enough to swap the balance
 * column for a whole page. That particular corruption leaves Money In and Money Out
 * untouched, so the declared-totals check still passes and nothing downstream
 * notices. Statement money on these documents is always printed to 2dp.
 *
 * Returns the magnitude: `parseMoney` signs DR/OD cells negative, and layout only
 * cares about presence and non-zero-ness, never direction.
 */
const MONEY_CELL = new RegExp(
    '^[-+]?\\s*[£$€]?\\s*-?(?:' +
        '\\d{1,3}(?:\\s*,\\s*\\d{3})+' +   // 1,604 / "1, 604" (Azure DI injects spaces)
        '|\\d+' +                           // 1604
    ')\\.\\d{2}\\s*(?:DR|OD|CR)?$',
    'i',
);

function cellAmount(raw: string): number | null {
    const s = normStr(raw);
    if (!MONEY_CELL.test(s)) return null;
    const n = parseMoney(s);
    return n === null ? null : Math.abs(n);
}

/**
 * Decide the column layout for one page-group.
 *
 * Only *transaction* rows vote. A row is a transaction row when col 0 parses as a
 * date — which excludes the interest-rate disclosure table Starling prints under
 * the last page's transactions, the legal footer, and the summary box.
 *
 * That exclusion is the point. The disclosure table is 6 columns wide on every
 * Starling statement, so a plain max-column scan over the page reports 6col for a
 * 5col transaction page, and the parser then reads col 3 (the single amount
 * column) as money IN and col 4 (the running balance) as money OUT. Seen in the
 * field: a monthly statement whose Money In came out overstated and Money Out
 * understated, while its closing balance still reconciled, so nothing downstream
 * noticed until the declared-totals check fired.
 * Worked example: __tests__/starling.test.ts.
 *
 * Evidence is weighed in order, strongest first. The ORDER IS LOAD-BEARING —
 * do not add a new rule without deciding where it sits relative to these:
 *   1. a row with col 5 holding money      → 6col. The balance column exists.
 *   2. rows with col 3 > 0 AND col 4       → 5col, but only when they OUTNUMBER the
 *      present (a 0.00 balance counts)       rows carrying col 4 alone. Amount plus
 *                                            running balance on one row is the 5col
 *                                            shape; col 4 alone is the 6col shape,
 *                                            an amount in the Out column. Both are
 *                                            counted and the majority wins, because
 *                                            a single merged or mis-OCR'd row must
 *                                            not outvote a page that plainly
 *                                            disagrees with it.
 *                                            A balance of exactly 0.00 is a real
 *                                            balance — an account emptied to zero.
 *   3. otherwise                           → fall back to the whole-page max-column
 *                                            scan, i.e. the behaviour that shipped
 *                                            before this function existed.
 *
 * Why col-4-alone never decides 6col on its own: that shape is genuinely ambiguous.
 * It is a 6col page whose balances Azure DI dropped, OR a 5col page whose amount
 * cell Azure DI dropped, and the cells alone cannot say which. Reading it as 6col
 * turns a running balance into a fabricated payment that can still reconcile, which
 * is the worst outcome this pipeline has. So it only ever votes against rule 2; it
 * never carries a page by itself.
 *
 * The fallback is NOT a safe harbour. When the disclosure table pins maxCol at 5, a
 * 5col page whose balances were all dropped is still read as 6col, and its payments
 * are still recorded as income — the original field bug, reached through rule 3.
 * Rules 1 and 2 shrink the set of pages that get there; they do not empty it. The
 * declared-totals check in Verification.ts remains the backstop for this class.
 */
function detectGroupLayout(
    rows: number[],
    grid: Map<number, Map<number, string>>,
): '6col' | '5col' {
    let amountAndBalanceRows = 0;
    let bareOutColumnRows    = 0;
    let maxCol = 0;

    for (const r of rows) {
        const row = grid.get(r);
        if (!row) continue;

        for (const c of row.keys()) if (c > maxCol) maxCol = c;

        if (!parseDateToDDMMYYYY(normStr(row.get(0) ?? ''))) continue;

        // evidence 1 (strongest) — decides immediately.
        if (cellAmount(row.get(5) ?? '') !== null) return '6col';

        // evidence 2 — tallied here, weighed after the loop.
        const col3 = cellAmount(row.get(3) ?? '');
        const col4 = cellAmount(row.get(4) ?? '');
        if (col3 !== null && col3 > 0 && col4 !== null) amountAndBalanceRows++;
        else if ((col3 === null || col3 === 0) && col4 !== null && col4 > 0) bareOutColumnRows++;
        // Do not add an early return below this line: it would outrank evidence 1.
    }

    // evidence 2 — the 5col shape must outnumber the shape that contradicts it.
    if (amountAndBalanceRows > bareOutColumnRows) return '5col';
    return maxCol >= 5 ? '6col' : '5col';       // evidence 3 (fallback)
}

function txKey(t: ParsedTransaction): string {
    return [t.date, t.type, t.description, t.moneyIn, t.moneyOut].join('|').toLowerCase();
}

// Extract the Starling summary box printed before the transaction table:
//   Opening Balance  £75.92
//   Payments In      £668.91
//   Payments Out     £733.36
//   Closing Balance  £11.47
function extractStarlingSummary(
    grid: Map<number, Map<number, string>>,
    sortedRows: number[],
): { openingBalance: number; closingBalance: number; moneyIn: number; moneyOut: number } | null {
    let openBal: number | null = null;
    let closeBal: number | null = null;
    let pIn: number | null = null;
    let pOut: number | null = null;

    for (const r of sortedRows) {
        const row = grid.get(r)!;
        const rowCells = [...row.values()];
        if (isHeaderRow(rowCells)) break; // stop at transaction table header

        const label = normStr(row.get(0) ?? '').toLowerCase();
        const value = normStr(row.get(1) ?? '');

        if (label === 'opening balance')      openBal  = parseMoney(value);
        else if (label === 'closing balance') closeBal = parseMoney(value);
        else if (label === 'payments in')     pIn      = parseMoney(value);
        else if (label === 'payments out')    pOut     = parseMoney(value);
    }

    if (openBal !== null && closeBal !== null) {
        return { openingBalance: openBal, closingBalance: closeBal, moneyIn: pIn ?? 0, moneyOut: pOut ?? 0 };
    }
    return null;
}

function extractFromSection(
    rows: number[],
    grid: Map<number, Map<number, string>>,
    layout: '6col' | '5col',
    out: ParsedTransaction[],
): void {
    for (const r of rows) {
        const row = grid.get(r)!;

        const date = parseDateToDDMMYYYY(normStr(row.get(0) ?? ''));
        if (!date) continue;

        const type     = normStr(row.get(1) ?? '');
        const desc     = normStr(row.get(2) ?? '');
        const typeDesc = [type, desc].filter(Boolean).join(' ');
        if (!typeDesc) continue;
        if (type.toUpperCase() === 'OPENING BALANCE') continue;

        const balCol = layout === '6col' ? 5 : 4;
        const balNum = parseMoney(normStr(row.get(balCol) ?? ''));
        const bal    = balNum !== null ? balNum.toFixed(2) : '';

        let moneyIn  = '';
        let moneyOut = '';

        if (layout === '6col') {
            const inAmt  = parseMoney(normStr(row.get(3) ?? ''));
            const outAmt = parseMoney(normStr(row.get(4) ?? ''));

            const typeUpper = type.toUpperCase();
            if (inAmt !== null && inAmt > 0 && (outAmt === null || outAmt === 0)) {
                // Amount only in col 3 (IN column). For types that are always outgoing,
                // Azure DI likely extracted the amount to the wrong column — correct it.
                if (ALWAYS_OUT_TYPES.has(typeUpper)) {
                    moneyOut = formatMoney(inAmt);
                } else {
                    moneyIn = formatMoney(inAmt);
                }
            } else if (outAmt !== null && outAmt > 0 && (inAmt === null || inAmt === 0)) {
                moneyOut = formatMoney(outAmt);
            } else if (inAmt !== null && outAmt !== null && inAmt > 0 && outAmt > 0) {
                if (ALWAYS_OUT_TYPES.has(typeUpper)) {
                    // Azure DI shifted columns: col 3 = real OUT amount, col 4 = EOD balance
                    // (which spilled from col 5). Use col 3 as OUT, discard col 4.
                    moneyOut = formatMoney(inAmt);
                } else {
                    // Both present — larger wins (e.g. in/out on same row for other types)
                    if (inAmt >= outAmt) moneyIn  = formatMoney(inAmt);
                    else                 moneyOut = formatMoney(outAmt);
                }
            } else {
                continue;
            }
        } else {
            // 5-col: single amount column — all treated as moneyOut per Make.com fallback
            const amtNum = parseMoney(normStr(row.get(3) ?? ''));
            if (amtNum === null || amtNum <= 0) continue;
            moneyOut = formatMoney(amtNum);
        }

        if (!moneyIn && !moneyOut) continue;

        out.push({ date, type, description: typeDesc, moneyIn, moneyOut, balance: bal });
    }
}

function rawFallback(rawText: string, existing: ParsedTransaction[]): ParseResult {
    if (!rawText) return { transactions: existing, ascending: true };

    // Find the LAST "Starling Bank 24hr Customer Service:" page header in the raw text
    const markerRe = /(?:^|\s)(?:\d+\s+)?(?:S\s+)?Starling Bank\s+24hr Customer Service:/gi;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(rawText)) !== null) lastMatch = m;

    if (!lastMatch) return { transactions: existing, ascending: true };

    // Only scan from the last page header, stop before interest/legal section
    let zone = rawText.slice(lastMatch.index);
    zone = zone.split(/Interest will be payable|Date range applicable|Interest rate paid on/i)[0];

    const typePattern = RAW_TYPES.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const orphanRe = new RegExp(
        `(\\d{1,2}[\\/\\.\\-]\\d{1,2}[\\/\\.\\-]\\d{2,4})\\s+` +
        `(${typePattern})\\s+` +
        `([\\s\\S]*?)\\s+` +
        `£\\s*([\\d,]+\\.\\d{2})` +
        `(?:\\s+£\\s*([\\d,]+\\.\\d{2}))?`,
        'gi',
    );

    const existingKeys = new Set(existing.map(txKey));
    const transactions = [...existing];

    let om: RegExpExecArray | null;
    while ((om = orphanRe.exec(zone)) !== null) {
        const date   = parseDateToDDMMYYYY(om[1]);
        const type   = normStr(om[2]);
        const desc   = normStr(om[3]);
        const amount = parseMoney(om[4]);
        const balNum = om[5] ? parseMoney(om[5]) : null;

        if (!date || !type || !desc || amount === null || amount <= 0) continue;

        const moneyIn  = type.toUpperCase() === 'FASTER PAYMENT' ? formatMoney(amount) : '';
        const moneyOut = type.toUpperCase() !== 'FASTER PAYMENT' ? formatMoney(amount) : '';
        const bal      = balNum !== null ? formatMoney(balNum) : '';

        const tx: ParsedTransaction = {
            date,
            type,
            description: `${type} ${desc}`,
            moneyIn,
            moneyOut,
            balance: bal,
        };

        const key = txKey(tx);
        if (!existingKeys.has(key)) {
            transactions.push(tx);
            existingKeys.add(key);
        }
    }

    return { transactions, ascending: true };
}

export function parse(cells: Cell[]): ParseResult {
    // Synthetic context cell (rowIndex -1) holds the full document text
    const rawText = normStr(cells.find(c => c.rowIndex < 0)?.content ?? '');

    const grid = buildGrid(cells);
    const sortedRows = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    if (!sortedRows.length) return rawFallback(rawText, []);

    const transactions: ParsedTransaction[] = [];
    let sectionRows: number[] = [];

    // PAGE_GAP: row-offset system adds 10 000 between pages when splitting page-by-page.
    // A gap ≥ this value means we've crossed a page boundary and each group should be
    // assessed for its own layout — exactly how Make.com processed each page separately.
    const PAGE_GAP = 9_000;

    function flushSection() {
        if (!sectionRows.length) { sectionRows = []; return; }

        // Split into page-groups (gaps ≥ PAGE_GAP indicate page boundaries).
        // Each group gets its own layout detection, mirroring Make.com per-page behaviour.
        const groups: number[][] = [];
        let grp: number[] = [sectionRows[0]];
        for (let i = 1; i < sectionRows.length; i++) {
            if (sectionRows[i] - sectionRows[i - 1] >= PAGE_GAP) {
                groups.push(grp);
                grp = [];
            }
            grp.push(sectionRows[i]);
        }
        groups.push(grp);

        for (const g of groups) {
            const grpLayout = detectGroupLayout(g, grid);
            extractFromSection(g, grid, grpLayout, transactions);
        }

        sectionRows = [];
    }

    for (const r of sortedRows) {
        const row = grid.get(r)!;
        const rowCells = [...row.values()];

        if (isHeaderRow(rowCells)) {
            flushSection();
            continue;
        }

        sectionRows.push(r);
    }
    flushSection();

    const starlingSummary = extractStarlingSummary(grid, sortedRows);

    // Raw text fallback only when table extraction found nothing
    if (transactions.length > 0) {
        return {
            transactions,
            ascending: true,
            ...(starlingSummary ? {
                statementTotals: {
                    moneyIn:        starlingSummary.moneyIn,
                    moneyOut:       starlingSummary.moneyOut,
                    openingBalance: starlingSummary.openingBalance,
                    closingBalance: starlingSummary.closingBalance,
                },
            } : {}),
        };
    }

    return rawFallback(rawText, transactions);
}
