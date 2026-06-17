// Barclays Business Account parser
// Layout: 5-col  Date | Description | Money in | Money out | Balance
// Characteristics:
//   - Money out stored as negative values (e.g. "-£107.69")
//   - No statement totals in files
//   - Multi-page documents with Azure DI row offsets (+10000 per page)
//   - Continuation rows for descriptions split across rows
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney,
    buildGrid, getCell, maxCol, extractYearsFromCells,
} from './shared.js';

const MONTH_MAP: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

const SKIP_RE        = /\b(start\s+balance|opening\s+balance|balance\s+brought\s+forward|brought\s+forward|starting\s+balance)\b/i;
const CARRIED_FWD_RE = /\b(balance\s+carried\s+forward|carried\s+forward)\b/i;
const TOTAL_RE       = /\b(total\s+payments[\/\\]receipts|total\s+payments|end\s+balance)\b/i;
const FOOTER_RE      = /\b(financial\s+services\s+compensation\s+scheme|fscs\s+protect|most\s+depositors|financial\s+ombudsman\s+service|credit\s+interest\s+rate.*shown\s+on\s+your\s+statement|if\s+you\s+have\s+a\s+problem\s+with\s+your)\b/i;

const MAX_SANE_AMOUNT = 1_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: number, m: number, y: number): string {
    return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}

function extractStartYear(content: string, fallback: number): number {
    // "DD/MM/YYYY" dates in content
    const re = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
    let min: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const y = Number(m[3]);
        if (y >= 2020 && y <= 2099 && (min === null || y < min)) min = y;
    }
    return min ?? fallback;
}

function parseDateCell(s: string, resolveYear: (mon: number) => number): string {
    s = normStr(s);
    if (!s) return '';

    // Azure DI sometimes adds spaces around separators: "09/10 /2025" → "09/10/2025"
    s = s.replace(/\s*([\/.\-])\s*/g, '$1');

    // DD/MM/YYYY
    let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) {
        let d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
        if (y < 100) y += 2000;
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
        resolveYear(mo);
        return fmtDate(d, mo, y);
    }

    // DD Mon [YYYY]
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?$/);
    if (m) {
        const day = Number(m[1]);
        const mon = MONTH_MAP[m[2].slice(0,3).toLowerCase()];
        if (!mon || day < 1 || day > 31) return '';
        const year = m[3] ? Number(m[3]) : resolveYear(mon);
        return fmtDate(day, mon, year);
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
    const allText    = cells.map(c => c.content).join(' ');
    const startYear  = extractStartYear(allText, availYears[0] ?? new Date().getFullYear());

    let curYear  = startYear;
    let lastMon: number | null = null;
    const resolveYear = (mon: number): number => {
        if (lastMon !== null && mon < lastMon) curYear++;
        lastMon = mon;
        return curYear;
    };

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
    // Header: Date | Description | Money in | Money out | Balance
    let COL = { date: 0, desc: 1, in: 2, out: 3, bal: 4 };
    let startAt = 0;

    for (let i = 0; i < table.length; i++) {
        const row = table[i];
        const joined = row.join(' ').toLowerCase();
        if (!joined.includes('description') || !joined.includes('balance')) continue;

        let date = -1, desc = -1, moneyIn = -1, moneyOut = -1, bal = -1;
        for (let c = 0; c < row.length; c++) {
            const v = row[c].toLowerCase();
            if (v === 'date')                                    date    = c;
            else if (v === 'description')                        desc    = c;
            else if (v === 'money in'  || v === 'credit')        moneyIn = c;
            else if (v === 'money out' || v === 'debit')         moneyOut = c;
            else if (v === 'balance')                            bal     = c;
        }
        if (date >= 0 && desc >= 0 && bal >= 0) {
            COL = {
                date:  date  >= 0 ? date  : 0,
                desc:  desc  >= 0 ? desc  : 1,
                in:    moneyIn  >= 0 ? moneyIn  : 2,
                out:   moneyOut >= 0 ? moneyOut : 3,
                bal:   bal  >= 0 ? bal  : 4,
            };
            startAt = i + 1;
            break;
        }
    }

    const gv = (row: string[], idx: number) => idx >= 0 && idx < row.length ? row[idx] : '';

    // ── Main pass ─────────────────────────────────────────────────────────────
    const rows: Row[] = [];
    let lastDate = '';
    let initialBalance: number | null = null;

    for (let i = startAt; i < table.length; i++) {
        const row = table[i];

        // Re-detect header when it repeats on a new page
        const joined = row.join(' ').toLowerCase();
        if (joined.includes('description') && joined.includes('money out') && joined.includes('balance')) {
            continue; // header row — skip without updating COL (same layout throughout)
        }

        let moneyIn  = parseMoney(gv(row, COL.in));
        let moneyOut = parseMoney(gv(row, COL.out));
        let balance  = parseMoney(gv(row, COL.bal));

        // Money out is stored as negative — convert to positive outflow.
        // A positive value in the out column with no balance is the balance
        // overflowing into that cell on short rows at page boundaries.
        if (moneyOut !== null) {
            if (moneyOut < 0) {
                moneyOut = Math.abs(moneyOut);
            } else if (moneyOut > 0 && balance === null) {
                balance  = moneyOut;
                moneyOut = null;
            }
        }
        if (moneyIn !== null && moneyIn < 0) {
            moneyOut = (moneyOut === null) ? Math.abs(moneyIn) : moneyOut;
            moneyIn  = null;
        }

        // Sanity check
        if ((moneyIn ?? 0) > MAX_SANE_AMOUNT || (moneyOut ?? 0) > MAX_SANE_AMOUNT) continue;

        const dateCell = gv(row, COL.date);
        const parsedDate = parseDateCell(dateCell, resolveYear);
        if (parsedDate) lastDate = parsedDate;

        // Build description from non-money, non-date columns
        const descParts: string[] = [];
        for (let c = 0; c < row.length; c++) {
            if (!row[c]) continue;
            if ([COL.date, COL.in, COL.out, COL.bal].includes(c)) continue;
            descParts.push(row[c]);
        }
        const desc = descParts.filter(Boolean).join(' ').trim();

        const movement = (moneyIn ?? 0) > 0 || (moneyOut ?? 0) > 0;

        // Skip: balance markers
        if (SKIP_RE.test(desc) || SKIP_RE.test(dateCell)) {
            const bal = balance ?? (moneyIn !== null ? moneyIn : moneyOut);
            if (bal !== null) initialBalance = bal;
            continue;
        }
        if (CARRIED_FWD_RE.test(desc)) { if (balance !== null) initialBalance = initialBalance ?? balance; continue; }
        if (TOTAL_RE.test(desc) || FOOTER_RE.test(desc)) continue;

        // Amount-only row → attach to previous
        if (!dateCell && !desc && (moneyIn !== null || moneyOut !== null || balance !== null)) {
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
        if (!movement && !dateCell && !desc) {
            if (balance !== null && rows.length === 0) initialBalance = balance;
            continue;
        }

        // Noise row (no movement, no balance)
        if (!movement && balance === null) continue;

        // Continuation line (no date, no movement)
        if (!dateCell && !movement && desc) {
            if (rows.length > 0) {
                rows[rows.length - 1].desc = normStr(rows[rows.length - 1].desc + ' ' + desc);
                if (balance !== null) rows[rows.length - 1].balance = balance;
            }
            continue;
        }

        rows.push({ date: parsedDate || lastDate, desc, moneyIn, moneyOut, balance });
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
        const expBal = r.balance;

        if (lastBal !== null) {
            r.balance = lastBal - outA + inA;
            lastBal   = r.balance;
            if (expBal !== null) { r.balance = expBal; lastBal = expBal; }
        } else if (expBal !== null) {
            r.balance = expBal; lastBal = expBal;
        }

        if (TOTAL_RE.test(r.desc ?? '') || FOOTER_RE.test(r.desc ?? '')) continue;
        const moneyInStr  = inA  > 0 ? formatMoney(inA)  : '';
        const moneyOutStr = outA > 0 ? formatMoney(outA) : '';
        if (!moneyInStr && !moneyOutStr) continue;

        transactions.push({
            date:        r.date,
            type:        '',
            description: r.desc || 'Unknown',
            moneyIn:     moneyInStr,
            moneyOut:    moneyOutStr,
            balance:     r.balance !== null ? r.balance.toFixed(2) : '',
        });
    }

    return { transactions, ascending: true };
}
