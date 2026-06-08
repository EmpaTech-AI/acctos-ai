// Pockit parser — 4-col layout with signed amounts and row stitching
// Layout: [date, description, amount(±), balance]
//   amount prefix: + = money in, - = money out
//   Dates: "DD MMM YYYY" (always full year)
// Multi-line transactions: description and amount may be on separate rows
// Balance backfill: missing balances computed backwards from known values
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow, maxCol,
} from './shared.js';

function parseDate(raw: string): string {
    const s = normStr(raw);
    if (!s) return '';

    // "01 MAY 2025"
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/i);
    if (m) {
        const MONTHS: Record<string, number> = {
            jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
            jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
        };
        const day = Number(m[1]);
        const mon = MONTHS[m[2].toLowerCase()];
        const year = Number(m[3]);
        if (!mon || day < 1 || day > 31) return '';
        return `${String(day).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${year}`;
    }

    // "DD/MM/YYYY" fallback
    const d = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (d) {
        let day = Number(d[1]), mon = Number(d[2]), yr = Number(d[3]);
        if (yr < 100) yr = yr <= 69 ? 2000 + yr : 1900 + yr;
        if (day < 1 || day > 31 || mon < 1 || mon > 12) return '';
        return `${String(day).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${yr}`;
    }

    return '';
}

function isHeaderRow(cols: string[]): boolean {
    const joined = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b/.test(joined))                                   hits++;
    if (/transaction|description/.test(joined))                    hits++;
    if (/money\s*out|debit/.test(joined))                         hits++;
    if (/money\s*in|credit/.test(joined))                         hits++;
    if (/balance/.test(joined))                                    hits++;
    return hits >= 3;
}

// Merged header rows that also contain transaction data — don't skip them
function headerContainsTransaction(cols: string[]): boolean {
    const joined = cols.join(' ').toLowerCase();
    return (
        /inward payment/.test(joined) ||
        /outward faster payment/.test(joined) ||
        /card purchase/.test(joined) ||
        /atm cash withdrawal/.test(joined)
    );
}

function isBroughtForward(desc: string): boolean {
    return /balance\s+brought\s+forward/i.test(desc);
}

function hasMovement(row: PhysRow): boolean {
    return (row.moneyIn !== null && row.moneyIn > 0) ||
           (row.moneyOut !== null && row.moneyOut > 0);
}

interface PhysRow {
    date:     string;
    desc:     string;
    moneyIn:  number | null;
    moneyOut: number | null;
    balance:  number | null;
}

interface TxnRow {
    date:     string;
    desc:     string;
    moneyIn:  number | null;
    moneyOut: number | null;
    balance:  number | null;
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);
    const cols = maxCol(cells);

    // Build flat ordered table
    const table: { rowIndex: number; cols: string[] }[] = [];
    for (let r = 0; r <= rows; r++) {
        if (!grid.has(r)) continue;
        const row: string[] = [];
        for (let c = 0; c <= cols; c++) {
            row.push(normStr(getCell(grid, r, c)));
        }
        table.push({ rowIndex: r, cols: row });
    }

    if (!table.length) return { transactions: [] };

    // Find header row and extract declared totals from the summary section above it
    let startAt = 0;
    let statementTotals: { moneyIn: number; moneyOut: number } | undefined;

    for (let i = 0; i < table.length; i++) {
        if (isHeaderRow(table[i].cols)) {
            startAt = headerContainsTransaction(table[i].cols) ? i : i + 1;
            break;
        }
        // Rows with "Total outgoings" / "Total loads" labels — amounts are on the previous row
        const joined = table[i].cols.join(' ').toLowerCase();
        if (/total\s*(outgoings?|loads?)/.test(joined) && i > 0) {
            let foundIn: number | null = null;
            let foundOut: number | null = null;
            for (const v of table[i - 1].cols) {
                const n = parseMoney(v);
                if (n === null) continue;
                if (n < 0 && foundOut === null) foundOut = Math.abs(n);
                else if (n > 0 && foundIn === null) foundIn = n;
            }
            if (foundIn !== null && foundOut !== null) {
                statementTotals = { moneyIn: foundIn, moneyOut: foundOut };
            }
        }
    }

    // ── Phase 1: build physical rows with date fill-down ─────────────────────
    const physical: PhysRow[] = [];
    let lastDate = '';

    for (let i = startAt; i < table.length; i++) {
        const c = table[i].cols;
        if (c.every(v => !normStr(v))) continue;  // blank row
        if (isHeaderRow(c) && !headerContainsTransaction(c)) continue;  // repeated page header

        const parsedDate = parseDate(c[0]);
        if (parsedDate) lastDate = parsedDate;
        const date = parsedDate || lastDate;

        const descMain = normStr(c[1]);
        // Append any extra columns (col4+) to description
        const extras: string[] = [];
        for (let ei = 4; ei < c.length; ei++) {
            const v = normStr(c[ei]);
            if (v) extras.push(v);
        }
        const desc = normStr([descMain, ...extras].filter(Boolean).join(' '));

        const amountRaw = normStr(c[2]);
        const amount    = parseMoney(amountRaw);
        // parseMoney may return negative for '-' prefix — store absolute value
        const absAmt    = amount !== null ? Math.abs(amount) : null;
        const balance   = parseMoney(c[3]);

        physical.push({
            date,
            desc,
            moneyOut: /^-/.test(amountRaw) && absAmt !== null ? absAmt : null,
            moneyIn:  /^\+/.test(amountRaw) && absAmt !== null ? absAmt : null,
            balance:  balance,
        });
    }

    // ── Phase 2: stitch multi-line transactions ───────────────────────────────
    const txns: TxnRow[] = [];
    let pending: TxnRow | null = null;

    function flushPending() {
        if (!pending) return;
        if (hasMovement(pending)) txns.push(pending);
        pending = null;
    }

    for (const r of physical) {
        if (isBroughtForward(r.desc)) continue;

        const movement = hasMovement(r);

        // Case A: continuation text only (no amounts, no balance, has desc)
        if (!movement && r.moneyIn === null && r.moneyOut === null && r.balance === null && r.desc) {
            if (pending) {
                pending.desc = normStr(`${pending.desc} ${r.desc}`);
            } else if (txns.length) {
                txns[txns.length - 1].desc = normStr(`${txns[txns.length - 1].desc} ${r.desc}`);
            }
            continue;
        }

        // Case B: movement but no description — attach amounts to pending
        if (movement && !r.desc && pending) {
            if (pending.moneyIn  === null) pending.moneyIn  = r.moneyIn;
            if (pending.moneyOut === null) pending.moneyOut = r.moneyOut;
            if (pending.balance  === null) pending.balance  = r.balance;
            if (!pending.date && r.date) pending.date = r.date;
            flushPending();
            continue;
        }

        // Case C: description but no movement — start pending
        if (r.desc && !movement) {
            flushPending();
            pending = { date: r.date, desc: r.desc, moneyIn: null, moneyOut: null, balance: r.balance };
            continue;
        }

        // Case D: description + movement — normal transaction
        if (r.desc && movement) {
            if (pending && !hasMovement(pending)) {
                // Merge with pending that has no movement yet
                pending.desc    = normStr(`${pending.desc} ${r.desc}`);
                pending.moneyIn  = r.moneyIn;
                pending.moneyOut = r.moneyOut;
                pending.balance  = r.balance !== null ? r.balance : pending.balance;
                if (!pending.date && r.date) pending.date = r.date;
                flushPending();
                continue;
            }
            flushPending();
            txns.push({ date: r.date, desc: r.desc, moneyIn: r.moneyIn, moneyOut: r.moneyOut, balance: r.balance });
        }
    }
    flushPending();

    // ── Phase 3: backfill missing balances (bottom → top) ────────────────────
    let currBal: number | null = null;
    for (let i = txns.length - 1; i >= 0; i--) {
        const t = txns[i];
        if (t.balance !== null) { currBal = t.balance; continue; }
        if (currBal === null) continue;
        const inAmt  = t.moneyIn  ?? 0;
        const outAmt = t.moneyOut ?? 0;
        if (inAmt === 0 && outAmt === 0) continue;
        // balance_i = balance_{i+1} - in_i + out_i
        const computed: number = currBal - inAmt + outAmt;
        t.balance = computed;
        currBal   = computed;
    }

    // ── Phase 4: emit output ──────────────────────────────────────────────────
    const transactions: ParsedTransaction[] = [];
    for (const t of txns) {
        const moneyIn  = t.moneyIn  !== null && t.moneyIn  > 0 ? formatMoney(t.moneyIn)  : '';
        const moneyOut = t.moneyOut !== null && t.moneyOut > 0 ? formatMoney(t.moneyOut) : '';
        if (!moneyIn && !moneyOut) continue;

        const balance = t.balance !== null ? t.balance.toFixed(2) : '';
        transactions.push({
            date:        t.date || '',
            type:        '',
            description: t.desc || 'Unknown',
            moneyIn,
            moneyOut,
            balance,
        });
    }

    return { transactions, statementTotals };
}
