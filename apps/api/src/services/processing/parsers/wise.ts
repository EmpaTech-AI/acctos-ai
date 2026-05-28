// Wise / TransferWise parser — ported from Make.com scenario module 1410
//
// Layout variants (detected per-row by whether c3 is populated):
//   4-col:  c0=description  c1=incoming  c2=outgoing  c3=balance
//   3-col:  c0=description  c1=signed_amount  c2=balance
//
// The date is ALWAYS embedded at the start of c0, e.g.:
//   "14 January 2025 Card transaction - Merchant"
//   "14 January 2025 Transaction: CARD-XXXXXXXX"
//
// Meta lines (date + "Transaction: TYPE-ID" in c0, no numbers elsewhere) are
// either merged into the preceding pending row or held as pendingMeta for the
// next row (so we can attach the date when c0 has no parseable date of its own).

import {
    Cell, ParsedTransaction, ParseResult,
    buildGrid, getCell, maxRow, normStr,
} from './shared.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4,  may: 5,  june: 6,
    july: 7,   august: 8,  september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
    sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Extract DD/MM/YYYY from text that contains "D Month YYYY" or "D Mon YYYY". */
function extractDateDMY(text: string): string | null {
    const m = normStr(text).match(/\b(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\b/);
    if (!m) return null;
    const mon = MONTH_MAP[m[2].toLowerCase()];
    if (!mon) return null;
    return `${String(m[1]).padStart(2, '0')}/${String(mon).padStart(2, '0')}/${m[3]}`;
}

/** Parse a (possibly signed) number, normalising unicode minus and comma separators. */
function parseNumber(s: string): number | null {
    const t = normStr(s).replace(/[−–]/g, '-').replace(/,/g, '');
    if (!t) return null;
    const m = t.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
}

function fmt2(n: number | null | undefined): string {
    if (n === null || n === undefined) return '';
    return Math.abs(n).toFixed(2);
}

function inferType(desc: string): string {
    const u = normStr(desc).toUpperCase();
    if (u.includes('CONVERTED'))                                       return 'CONVERT';
    if (u.includes('CARD TRANSACTION'))                                return 'CARD';
    if (u.includes('RECEIVED MONEY') || u.includes('SENT MONEY') ||
        u.includes('TRANSFER'))                                        return 'TRANSFER';
    return 'OTHER';
}

function looksIncoming(desc: string): boolean {
    const u = normStr(desc).toUpperCase();
    return u.includes('RECEIVED MONEY') || u.includes('CASHBACK');
}

function looksOutgoing(desc: string): boolean {
    const u = normStr(desc).toUpperCase();
    return u.includes('SENT MONEY') || u.includes('CARD TRANSACTION');
}

/** Rows whose c0 matches these are column headers, not transactions. */
function isHeaderRow(c0: string): boolean {
    const t = normStr(c0).toLowerCase();
    return (
        t === 'description'     ||
        t === 'incoming'        ||
        t === 'outgoing'        ||
        t === 'amount'          ||
        t.startsWith('gbp on ') ||
        t === 'account holder'
    );
}

// Amounts above this are OCR garbage (card/account numbers, phone numbers, etc.)
const MAX_SANE_AMOUNT = 1_000_000;

/**
 * Meta line: c0 contains a date AND "Transaction: ..." and c1/c2/c3 have no money amounts.
 * These rows carry the transaction reference id and are merged into the amount row.
 *
 * Azure DI sometimes splits "Transaction: CARD-2020404505" across c0 and c1:
 *   c0: "9 Jan 2025 Card ending in 9584 ... Transaction:"
 *   c1: "CARD-2020404505"
 * We detect this by checking whether c1 looks like a transaction ID (TYPE-digits)
 * rather than a monetary amount.
 */
function isMetaLine(c0: string, c1: string, c2: string, c3: string): boolean {
    if (!extractDateDMY(c0))            return false;
    if (!/\bTransaction:\s*/i.test(c0)) return false;
    if (parseNumber(c2) !== null || parseNumber(c3) !== null) return false;
    // c1 is either empty OR a transaction ID like "CARD-2020404505" (not a money amount)
    const c1IsTxnId = c1 === '' || /^[A-Za-z]+-\d+$/.test(normStr(c1));
    return c1IsTxnId;
}

// ── Pending row accumulator ───────────────────────────────────────────────────

interface Pending {
    desc:       string;
    mergedDesc: string | null;   // desc | metaLine (when meta is merged)
    date:       string | null;
    type:       string;
    moneyIn:    number | null;
    moneyOut:   number | null;
    balance:    number | null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);
    const result: ParsedTransaction[] = [];

    let pending: Pending | null = null;
    let pendingMeta: { date: string; text: string } | null = null;

    function flushPending(): void {
        if (!pending) return;

        const date  = pending.date ?? extractDateDMY(pending.desc) ?? null;
        const type  = pending.type || inferType(pending.desc);

        let { moneyIn, moneyOut, balance } = pending;

        // Ensure amounts are positive (OCR can produce negative values in either column)
        if (typeof moneyOut === 'number' && moneyOut < 0) moneyOut = Math.abs(moneyOut);
        if (typeof moneyIn  === 'number' && moneyIn  < 0) moneyIn  = Math.abs(moneyIn);

        const hasSomeValue =
            typeof moneyIn  === 'number' ||
            typeof moneyOut === 'number' ||
            typeof balance  === 'number' ||
            type === 'CONVERT';

        const fullDesc = pending.mergedDesc ?? pending.desc;

        if (date && fullDesc && hasSomeValue) {
            result.push({
                date,
                type,
                description: fullDesc,
                moneyIn:  fmt2(moneyIn),
                moneyOut: fmt2(moneyOut),
                balance:  balance !== null ? balance.toFixed(2) : '',
            });
        }

        pending = null;
    }

    for (let r = 0; r <= rows; r++) {
        const c0 = normStr(getCell(grid, r, 0));
        const c1 = normStr(getCell(grid, r, 1));
        const c2 = normStr(getCell(grid, r, 2));
        const c3 = normStr(getCell(grid, r, 3));

        if (!c0 && !c1 && !c2 && !c3) continue;
        if (isHeaderRow(c0))           continue;

        // ── Meta line ─────────────────────────────────────────────────────────
        if (isMetaLine(c0, c1, c2, c3)) {
            const metaDate = extractDateDMY(c0);
            if (pending) {
                if (!pending.date && metaDate) pending.date = metaDate;
                pending.mergedDesc = `${pending.desc} | ${c0}`;
            } else if (metaDate) {
                pendingMeta = { date: metaDate, text: c0 };
            }
            continue;
        }

        // ── New transaction row ───────────────────────────────────────────────
        flushPending();

        // Guard against OCR garbage (card numbers, phone numbers in amount columns)
        const n1 = parseNumber(c1), n2 = parseNumber(c2), n3 = parseNumber(c3);
        if (
            (n1 !== null && Math.abs(n1) > MAX_SANE_AMOUNT) ||
            (n2 !== null && Math.abs(n2) > MAX_SANE_AMOUNT) ||
            (n3 !== null && Math.abs(n3) > MAX_SANE_AMOUNT)
        ) continue;

        const rowIsFourCol = c3 !== '';
        let moneyIn:  number | null = null;
        let moneyOut: number | null = null;
        let balance:  number | null = null;

        if (rowIsFourCol) {
            // 4-col: [desc, incoming, outgoing, balance]
            moneyIn  = parseNumber(c1);
            moneyOut = parseNumber(c2);
            balance  = parseNumber(c3);

            // CASHBACK: Azure DI sometimes puts it in the wrong column or negated
            if (c0.toUpperCase().includes('CASHBACK')) {
                const candidates = ([parseNumber(c1), parseNumber(c2)] as (number | null)[])
                    .filter((x): x is number => x !== null && x !== 0);
                const pos = candidates.find(x => x > 0);
                if (moneyIn === null && pos !== undefined) moneyIn = pos;
                if (moneyIn === null) {
                    const neg = candidates.find(x => x < 0);
                    if (neg !== undefined) moneyIn = Math.abs(neg);
                }
            }

            // Rule 1: outgoing > 0 but description says incoming → move to moneyIn
            if (moneyIn === null && typeof moneyOut === 'number' && moneyOut > 0 && looksIncoming(c0)) {
                moneyIn = moneyOut; moneyOut = null;
            }
            // Rule 2: incoming < 0 (OCR artefact) → treat as moneyOut
            if (typeof moneyIn === 'number' && moneyIn < 0 && moneyOut === null) {
                moneyOut = moneyIn; moneyIn = null;
            }
            // Rule 3: incoming > 0 but description says outgoing → treat as moneyOut
            if (moneyOut === null && typeof moneyIn === 'number' && moneyIn > 0 && looksOutgoing(c0)) {
                moneyOut = -moneyIn; moneyIn = null;   // abs() applied in flushPending
            }
            // Fallback: "Received money" with no parsed incoming → extract from text
            if (moneyIn === null && c0.toUpperCase().includes('RECEIVED MONEY')) {
                moneyIn = parseNumber(c0);
            }

        } else {
            // 3-col: [desc, signed_amount, balance]
            const amt = parseNumber(c1);
            balance   = parseNumber(c2);

            if (typeof amt === 'number') {
                if (amt < 0) {
                    moneyOut = Math.abs(amt);
                } else if (looksOutgoing(c0)) {
                    moneyOut = amt;
                } else {
                    moneyIn = amt;
                }
            }
            // Fallback: "Received money" with no parsed amount → extract from text
            if (moneyIn === null && c0.toUpperCase().includes('RECEIVED MONEY')) {
                const n = parseNumber(c0);
                if (n !== null) moneyIn = Math.abs(n);
            }
        }

        pending = {
            desc:       c0,
            mergedDesc: null,
            date:       extractDateDMY(c0),
            type:       inferType(c0),
            moneyIn,
            moneyOut,
            balance,
        };

        // Attach a preceding meta line if this row has no date in c0
        if (pendingMeta && !pending.date) {
            pending.date       = pendingMeta.date;
            pending.mergedDesc = `${pending.desc} | ${pendingMeta.text}`;
            pendingMeta        = null;
        }
    }

    flushPending();

    return { transactions: result };
}
