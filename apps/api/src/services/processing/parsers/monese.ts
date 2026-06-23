// Monese parser
// Layout: 5-col  Processed Date | Payment Made | Description | Amount | Balance
// Amount column uses explicit sign:  +£xxx.xx = IN,  -£xxx.xx = OUT
// Only tables with >= 4 columns are transaction tables (Make.com: columnCount >= 4)
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, formatMoney,
    buildGrid, getCell, maxCol, extractYearsFromCells,
} from './shared.js';

const MONTH_MAP: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

const SKIP_RE       = /\b(start\s+balance|opening\s+balance|balance\s+brought\s+forward|brought\s+forward)\b/i;
const CARRIED_RE    = /\b(balance\s+carried\s+forward|carried\s+forward)\b/i;
const TOTAL_RE      = /\b(total\s+payments[\/\\]receipts|end\s+balance)\b/i;
const PENDING_TYPE_RE = /^(bill\s+payment|counter\s+credit|debit|credit|contactless\s+card\s+purchase|funds\s+transfer)$/i;

const MAX_SANE = 1_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: number, m: number, y: number): string {
    return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}

/** Parse signed amount cell: +£1,234.56 or -£1,234.56 */
function parseSignedAmount(s: string): { sign: 1 | -1; amount: number } | null {
    s = normStr(s);
    const m = s.match(/^([+\-])\s*£\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2}))$/);
    if (!m) return null;
    const amount = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(amount) || amount < 0) return null;
    return { sign: m[1] === '+' ? 1 : -1, amount };
}

function parseBalance(s: string): number | null {
    s = normStr(s);
    if (!s) return null;
    const m = s.match(/£?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+(?:\.\d{2}))/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return isFinite(n) ? n : null;
}

// ── Date resolution ───────────────────────────────────────────────────────────

function makeYearResolver(startYear: number) {
    let curYear  = startYear;
    let lastMon: number | null = null;

    return function resolveYear(mon: number): number {
        if (lastMon !== null && mon < lastMon) curYear++;
        lastMon = mon;
        return curYear;
    };
}

function parseDateStr(s: string, resolveYear: (mon: number) => number): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/\s*([\/.\-])\s*/g, '$1');

    // DD/MM/YYYY
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/);
    if (m) {
        const d = +m[1], mo = +m[2], y = +m[3];
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
        resolveYear(mo);
        return fmtDate(d, mo, y);
    }

    // DD/MM (no year)
    m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m) {
        const d = +m[1], mo = +m[2];
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
        return fmtDate(d, mo, resolveYear(mo));
    }

    // DD Mon [YYYY]
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?$/);
    if (m) {
        const d = +m[1];
        const mon = MONTH_MAP[m[2].slice(0,3).toLowerCase()];
        if (!mon || d < 1 || d > 31) return '';
        const y = m[3] ? +m[3] : resolveYear(mon);
        return fmtDate(d, mon, y);
    }

    return '';
}

// ── Parser ────────────────────────────────────────────────────────────────────

interface Row {
    date:     string;
    desc:     string;
    moneyIn:  number | null;
    moneyOut: number | null;
    balance:  number | null;
}

export function parse(cells: Cell[]): ParseResult {
    const availYears = extractYearsFromCells(cells);
    const startYear  = availYears[0] ?? new Date().getFullYear();
    const resolveYear = makeYearResolver(startYear);

    const grid    = buildGrid(cells);
    const nCols   = maxCol(cells);
    const rowIdxs = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    const table = rowIdxs.map(r => {
        const row: string[] = [];
        for (let c = 0; c <= nCols; c++) row.push(normStr(getCell(grid, r, c)));
        return row;
    });

    if (!table.length) return { transactions: [] };

    // ── Column detection ──────────────────────────────────────────────────────
    // Default: Processed Date | Payment Made | Description | Amount | Balance
    let COL = { date: 0, paymentDate: 1, desc: 2, amount: 3, bal: 4 };
    let startAt = 0;

    for (let i = 0; i < table.length; i++) {
        const row    = table[i];
        const joined = row.join(' ').toLowerCase();

        if (!joined.includes('description')) continue;
        if (!joined.includes('amount') && !joined.includes('balance') &&
            !joined.includes('money out') && !joined.includes('debit')) continue;

        // Only consider rows from tables with >= 4 columns (Make.com filter)
        const nonEmpty = row.filter(Boolean).length;
        if (nonEmpty < 4) continue;

        let date = -1, payDate = -1, desc = -1, amount = -1, bal = -1;
        for (let c = 0; c < row.length; c++) {
            const v = row[c].toLowerCase();
            if      (v.includes('processed date') || v === 'date')        date    = c;
            else if (v.includes('payment made'))                           payDate = c;
            else if (v.includes('description') && !v.includes('money'))   desc    = c;
            else if (v.includes('amount'))                                 amount  = c;
            else if (v.includes('balance'))                                bal     = c;
        }

        if (desc >= 0 && (amount >= 0 || bal >= 0)) {
            COL = {
                date:        date    >= 0 ? date    : 0,
                paymentDate: payDate >= 0 ? payDate : (date >= 0 ? -1 : 1),
                desc:        desc,
                amount:      amount  >= 0 ? amount  : -1,
                bal:         bal     >= 0 ? bal     : 4,
            };
            startAt = i + 1;
            break;
        }
    }

    const gv = (row: string[], idx: number) => idx >= 0 && idx < row.length ? row[idx] : '';

    // ── Main pass ─────────────────────────────────────────────────────────────
    const rows: Row[] = [];
    let lastDate      = '';
    let initialBalance: number | null = null;
    let pendingDesc   = '';

    for (let i = startAt; i < table.length; i++) {
        const row    = table[i];
        const joined = row.join(' ').toLowerCase();

        // Re-detect header on a new page (repeating headers)
        if (joined.includes('description') && joined.includes('amount') && joined.includes('balance')) {
            continue;
        }

        // Skip very short rows (< 4 non-empty cells) — footers, page numbers, etc.
        const nonEmpty = row.filter(Boolean).length;
        if (nonEmpty < 2) continue;

        // ── Dates ──
        let dateRaw = gv(row, COL.date);
        let parsedDate = parseDateStr(dateRaw, resolveYear);

        // Fall back to Payment Made column if Processed Date is empty
        if (!parsedDate && COL.paymentDate >= 0) {
            const payRaw = gv(row, COL.paymentDate);
            parsedDate = parseDateStr(payRaw, resolveYear);
        }

        if (parsedDate) lastDate = parsedDate;
        const effectiveDate = parsedDate || lastDate;

        // ── Amount ──
        let moneyIn:  number | null = null;
        let moneyOut: number | null = null;

        if (COL.amount >= 0) {
            const amtRaw = gv(row, COL.amount);
            const parsed = parseSignedAmount(amtRaw);
            if (parsed) {
                if (parsed.sign === 1)  moneyIn  = parsed.amount;
                else                    moneyOut = parsed.amount;
            }
        }

        // ── Balance ──
        const balance = parseBalance(gv(row, COL.bal));

        // ── Description ──
        const descParts: string[] = [];
        for (let c = 0; c < row.length; c++) {
            if (!row[c]) continue;
            if (c === COL.date || c === COL.paymentDate) continue;
            if (c === COL.amount && parseSignedAmount(row[c])) continue;
            if (c === COL.bal   && parseBalance(row[c]) !== null) continue;
            descParts.push(row[c]);
        }
        const desc = descParts.filter(Boolean).join(' ').trim();

        // ── Skip markers ──
        if (SKIP_RE.test(desc)) {
            const bal = balance ?? (moneyIn ?? moneyOut ?? null);
            if (bal !== null) initialBalance = bal;
            continue;
        }
        if (CARRIED_RE.test(desc)) {
            if (balance !== null) initialBalance = initialBalance ?? balance;
            continue;
        }
        if (TOTAL_RE.test(desc)) continue;

        const movement = (moneyIn ?? 0) > 0 || (moneyOut ?? 0) > 0;

        // Sanity check
        if ((moneyIn  ?? 0) > MAX_SANE) continue;
        if ((moneyOut ?? 0) > MAX_SANE) continue;

        // Amount/balance-only row — attach to previous
        if (!dateRaw && !desc && (movement || balance !== null)) {
            if (rows.length > 0) {
                const prev = rows[rows.length - 1];
                if (prev.moneyIn  === null && moneyIn  !== null) prev.moneyIn  = moneyIn;
                if (prev.moneyOut === null && moneyOut !== null) prev.moneyOut = moneyOut;
                if (balance !== null) prev.balance = balance;
            } else if (balance !== null) {
                initialBalance = balance;
            }
            continue;
        }

        // Fully empty row
        if (!movement && !dateRaw && !desc) {
            if (balance !== null && rows.length === 0) initialBalance = balance;
            continue;
        }

        // Type-only pending rows (e.g. "Debit", "Credit" on their own)
        if (!movement && balance === null && PENDING_TYPE_RE.test(desc)) {
            pendingDesc = normStr(pendingDesc + ' ' + desc);
            continue;
        }

        // Continuation line — no date, no movement
        if (!dateRaw && !movement && desc) {
            if (rows.length > 0) {
                rows[rows.length - 1].desc = normStr(rows[rows.length - 1].desc + ' ' + desc);
                if (balance !== null) rows[rows.length - 1].balance = balance;
            } else {
                pendingDesc = normStr(pendingDesc + ' ' + desc);
            }
            continue;
        }

        // Merge pending description from before
        const fullDesc = normStr((pendingDesc ? pendingDesc + ' ' : '') + desc) || '[No Description]';
        pendingDesc = '';

        rows.push({ date: effectiveDate, desc: fullDesc, moneyIn, moneyOut, balance });
    }

    // ── Recover initialBalance ────────────────────────────────────────────────
    if (initialBalance === null) {
        let delta = 0;
        for (const r of rows) {
            delta += (r.moneyIn ?? 0) - (r.moneyOut ?? 0);
            if (r.balance !== null) { initialBalance = r.balance - delta; break; }
        }
    }

    // ── Sequential forward balance ────────────────────────────────────────────
    let lastBal = initialBalance;
    const transactions: ParsedTransaction[] = [];

    for (const r of rows) {
        const inA   = r.moneyIn  ?? 0;
        const outA  = r.moneyOut ?? 0;

        // Infer amounts from balance delta when both are zero but we have an explicit balance
        if (inA === 0 && outA === 0 && lastBal !== null && r.balance !== null) {
            const diff = +(r.balance - lastBal).toFixed(2);
            if (diff > 0) r.moneyIn  = diff;
            else if (diff < 0) r.moneyOut = Math.abs(diff);
        }

        const expBal = r.balance;
        if (lastBal !== null) {
            r.balance = lastBal - (r.moneyOut ?? 0) + (r.moneyIn ?? 0);
            lastBal   = r.balance;
            if (expBal !== null) { r.balance = expBal; lastBal = expBal; }
        } else if (expBal !== null) {
            r.balance = expBal; lastBal = expBal;
        }

        const moneyInStr  = (r.moneyIn  ?? 0) > 0 ? formatMoney(r.moneyIn!)  : '';
        const moneyOutStr = (r.moneyOut ?? 0) > 0 ? formatMoney(r.moneyOut!) : '';
        if (!moneyInStr && !moneyOutStr) continue;

        transactions.push({
            date:        r.date,
            type:        '',
            description: r.desc,
            moneyIn:     moneyInStr,
            moneyOut:    moneyOutStr,
            balance:     r.balance !== null ? r.balance.toFixed(2) : '',
        });
    }

    return { transactions, ascending: true };
}
