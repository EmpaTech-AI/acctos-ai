// Metro Bank parser — 5-column format: [date, description, money_out, money_in, balance]
// Extra description appended from columns 5+.
// Features: header scan anywhere, date fill-down, row stitching, balance backfill.
// Translated from Make.com module 1349.
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, parseDateToDDMMYYYY,
    buildGrid, getCell, maxCol,
} from './shared.js';

function isHeaderRow(cols: string[]): boolean {
    const j = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b/.test(j))               hits++;
    if (/transaction|description/.test(j)) hits++;
    if (/money\s*out|debit/.test(j))       hits++;
    if (/money\s*in|credit/.test(j))       hits++;
    if (/balance/.test(j))                 hits++;
    return hits >= 3;
}

// Metro occasionally produces a merged header+transaction row (e.g. "Inward Payment" in a header cell).
// In that case we must NOT skip the row — it contains real transaction data.
function headerContainsTransaction(cols: string[]): boolean {
    const j = cols.join(' ').toLowerCase();
    return /inward payment|outward faster payment|card purchase|atm cash withdrawal/.test(j);
}

interface PhysRow {
    date:     string;
    desc:     string;
    moneyOut: number | null;
    moneyIn:  number | null;
    balance:  number | null;
}

function hasMovement(r: PhysRow): boolean {
    return (r.moneyIn !== null && r.moneyIn > 0) || (r.moneyOut !== null && r.moneyOut > 0);
}

/** Extract bank-declared totals from Metro Bank's "Your account summary" section. */
function extractDeclaredTotals(content: string): { moneyIn: number; moneyOut: number; openingBalance: number; closingBalance: number } | null {
    // Labels and values may be on the same line (space-separated) or on separate lines,
    // depending on how Azure DI lays out the summary table.
    //   "Opening balance £2,277.06"  OR  "Opening balance\n£-20.83"
    // The £ value may be negative (e.g. £-20.83 for an overdraft closing balance).
    const sep = /\s+/;
    const pound = /£\s*(-?[\d,]+(?:\.\d{1,2})?)/;
    function after(label: RegExp): number | null {
        const m = content.match(new RegExp(label.source + sep.source + pound.source, 'i'));
        if (!m) return null;
        return parseMoney(m[1].replace(/,/g, ''));
    }
    const openingBalance = after(/Opening balance/);
    const moneyIn        = after(/Total money in/);
    const moneyOut       = after(/Total money out/);
    const closingBalance = after(/End balance/);
    if (openingBalance === null || moneyIn === null || moneyOut === null || closingBalance === null) return null;
    return { moneyIn, moneyOut, openingBalance, closingBalance };
}

export function parse(cells: Cell[]): ParseResult {
    const contextContent = cells.find(c => c.rowIndex < 0)?.content ?? '';
    const declared = extractDeclaredTotals(contextContent);

    const grid    = buildGrid(cells);
    const colCount = maxCol(cells);

    // Build ordered table from sorted row indices (skips synthetic row -1 and page-gap rows)
    const rowIndexes = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);
    const table = rowIndexes.map(r => {
        const cols: string[] = [];
        for (let c = 0; c <= colCount; c++) cols.push(normStr(getCell(grid, r, c)));
        return cols;
    });

    if (!table.length) return { transactions: [] };

    // Locate header row (may be preceded by a "Your transactions" section heading)
    let startAt = 0;
    for (let i = 0; i < table.length; i++) {
        if (isHeaderRow(table[i])) {
            startAt = headerContainsTransaction(table[i]) ? i : i + 1;
            break;
        }
    }

    // ── Pass 1: physical rows with date fill-down ────────────────────────────
    const physical: PhysRow[] = [];
    let lastDate = '';
    // Azure DI sometimes merges "Money in (£)" and "Balance (£)" into a single col[3] header cell.
    // When this happens the data rows have no col[4]; col[3] holds the running balance, not money-in.
    let mergedInBalCol = false;

    for (let i = startAt; i < table.length; i++) {
        const cols = table[i];
        if (cols.every(c => !c)) continue;           // blank row

        // Re-detect column layout when a repeat page header is encountered.
        const joined = cols.join(' ').toLowerCase();
        if (/\bdate\b/.test(joined) && /transaction/.test(joined) && /money\s*out/.test(joined)) {
            const col3Lower = (cols[3] || '').toLowerCase();
            mergedInBalCol = /money\s*in/.test(col3Lower) && /balance/.test(col3Lower);
            continue; // skip header rows — don't add them to physical[]
        }

        const parsedDate = parseDateToDDMMYYYY(cols[0]);
        if (parsedDate) lastDate = parsedDate;

        // Extra description lives in columns 5+ (col2=out, col3=in, col4=balance)
        const extras: string[] = [];
        for (let c = 5; c <= colCount; c++) {
            const v = normStr(cols[c] ?? '');
            if (v) extras.push(v);
        }
        const desc = [normStr(cols[1]), ...extras].filter(Boolean).join(' ').trim();

        // When the "Money in (£) Balance (£)" header was merged, col[3] holds the balance.
        const moneyIn  = mergedInBalCol ? null              : parseMoney(cols[3]);
        const balance  = mergedInBalCol ? parseMoney(cols[3]) : parseMoney(cols[4]);

        physical.push({
            date:     parsedDate || lastDate,
            desc,
            moneyOut: parseMoney(cols[2]),
            moneyIn,
            balance,
        });
    }

    // ── Pass 2: row stitching ────────────────────────────────────────────────
    // Metro splits transactions across multiple rows; four cases handled below.
    const txns: PhysRow[] = [];
    let pending: PhysRow | null = null;

    function flush() {
        if (!pending) return;
        if (hasMovement(pending)) txns.push(pending);
        pending = null;
    }

    for (const r of physical) {
        if (/balance\s+brought\s+forward/i.test(r.desc)) continue;

        const movement = hasMovement(r);
        const noAmounts = r.moneyIn === null && r.moneyOut === null && r.balance === null;

        // Case A: text-only continuation line — append to pending or last transaction
        if (!movement && r.desc && noAmounts) {
            if (pending) {
                pending.desc = [pending.desc, r.desc].filter(Boolean).join(' ').trim();
            } else if (txns.length) {
                const last = txns[txns.length - 1];
                last.desc = [last.desc, r.desc].filter(Boolean).join(' ').trim();
            }
            continue;
        }

        // Case B: amounts but no description — fill pending's amounts
        if (movement && !r.desc && pending) {
            if (pending.moneyIn  === null) pending.moneyIn  = r.moneyIn;
            if (pending.moneyOut === null) pending.moneyOut = r.moneyOut;
            if (pending.balance  === null) pending.balance  = r.balance;
            if (!pending.date && r.date)   pending.date     = r.date;
            flush();
            continue;
        }

        // Case C: description but no amounts — start a pending row
        if (r.desc && !movement) {
            flush();
            pending = { ...r, moneyIn: null, moneyOut: null };
            continue;
        }

        // Case D: description + amounts — normal row (merge with pending if pending is incomplete)
        if (r.desc && movement) {
            if (pending && !hasMovement(pending)) {
                pending.desc    = [pending.desc, r.desc].filter(Boolean).join(' ').trim();
                pending.moneyIn  = r.moneyIn;
                pending.moneyOut = r.moneyOut;
                if (r.balance !== null) pending.balance = r.balance;
                if (!pending.date && r.date) pending.date = r.date;
                flush();
                continue;
            }
            flush();
            txns.push({ ...r });
        }
    }
    flush();

    // ── Pass 3: balance backfill (bottom → top) ──────────────────────────────
    let currBal: number | null = null;
    for (let i = txns.length - 1; i >= 0; i--) {
        const t = txns[i];
        if (t.balance !== null) { currBal = t.balance; continue; }
        if (currBal === null) continue;
        const inAmt  = t.moneyIn  ?? 0;
        const outAmt = t.moneyOut ?? 0;
        if (inAmt === 0 && outAmt === 0) continue;
        t.balance = currBal - inAmt + outAmt;
        currBal   = t.balance;
    }

    // ── Emit ─────────────────────────────────────────────────────────────────
    const transactions: ParsedTransaction[] = [];
    for (const t of txns) {
        const moneyIn  = t.moneyIn  !== null && t.moneyIn  > 0 ? formatMoney(t.moneyIn)  : '';
        const moneyOut = t.moneyOut !== null && t.moneyOut > 0 ? formatMoney(t.moneyOut) : '';
        if (!moneyIn && !moneyOut) continue;
        transactions.push({
            date:        t.date,
            type:        '',
            description: t.desc || 'Unknown',
            moneyIn,
            moneyOut,
            balance:     t.balance !== null ? t.balance.toFixed(2) : '',
        });
    }

    const statementTotals = declared ?? undefined;
    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}
