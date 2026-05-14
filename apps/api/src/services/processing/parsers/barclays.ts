// Barclays parser — 1:1 port of Make.com module 1341.
// Key differences from HSBC: no type codes, dates may be missing on continuation
// rows, balance is recomputed sequentially from initialBalance.
import {
    Cell, ParsedTransaction, ParseResult,
    buildGrid, getCell, maxRow, extractYearsFromCells,
} from './shared.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PhysicalRow {
    date: string;
    description: string;
    moneyOut: number | null;
    moneyIn:  number | null;
    balance:  number | null;   // explicit OCR balance (may be null)
    computed?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normStr(x: unknown): string {
    return String(x ?? '').replace(/\s+/g, ' ').trim();
}

function stripCurrency(v: string): string {
    return v.replace(/[£$€\s]/g, '');
}

function parseMoney(v: string): number | null {
    const s = stripCurrency(v).replace(/,/g, '').trim();
    if (!s || !/\d/.test(s)) return null;
    const n = Number(s.replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? Math.abs(n) : null;
}

function isAmount(v: string): boolean {
    const s = stripCurrency(v).replace(/,/g, '').replace(/^-/, '');
    return Boolean(s) && /^\d+(\.\d{1,2})?$/.test(s);
}

function fmtMoney(n: number): string {
    return Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Year-by-flow tracking (module 1341: resolveYearByFlow) ────────────────────

const MONTH_ABBR: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

let _currentYear = 2025;
let _lastMonth: number | null = null;

function resolveYearByFlow(month: number): number {
    if (_lastMonth !== null && month < _lastMonth) _currentYear++;
    _lastMonth = month;
    return _currentYear;
}

function parseDateStr(s: string): string | null {
    s = normStr(s);
    if (!s) return null;
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?/);
    if (!m) return null;
    const day = Number(m[1]);
    const mon = MONTH_ABBR[m[2].slice(0, 3).toLowerCase()];
    if (!mon || day < 1 || day > 31) return null;
    const year = m[3] ? Number(m[3]) : resolveYearByFlow(mon);
    return `${String(day).padStart(2, '0')}/${String(mon).padStart(2, '0')}/${year}`;
}

function parseLeadingDate(desc: string): { date: string; rest: string } | null {
    const m = normStr(desc).match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?\s+/);
    if (!m) return null;
    const date = parseDateStr(`${m[1]} ${m[2]}${m[3] ? ' ' + m[3] : ''}`);
    if (!date) return null;
    return { date, rest: normStr(desc.slice(m[0].length)) };
}

// ── Skip-row detection ────────────────────────────────────────────────────────

const SKIP_RE = /\b(start\s+balance|balance\s+brought\s+forward|brought\s+forward|balance\s+carried\s+forward|carried\s+forward|total\s+payments|end\s+balance)\b/i;

function isSkipRow(desc: string): boolean {
    return SKIP_RE.test(desc);
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);

    // ── Init year tracker ─────────────────────────────────────────────────────
    const availableYears = extractYearsFromCells(cells);
    _currentYear = availableYears[0] ?? new Date().getFullYear();
    _lastMonth   = null;

    // ── Column detection from header ──────────────────────────────────────────
    let dateCol = 0, descCol = 1, outCol = 2, inCol = 3, balCol = 4;
    let headerFound = false;

    for (let r = 0; r <= Math.min(5, rows); r++) {
        const row = grid.get(r);
        if (!row) continue;
        const joined = [...row.values()].join(' ').toLowerCase();
        if (!joined.includes('description') && !joined.includes('date')) continue;

        headerFound = true;
        for (const [c, v] of row) {
            const lo = v.toLowerCase();
            if (lo.includes('date')) { dateCol = c; }
            else if (/desc|narrat|detail|particul|reference/.test(lo)) { descCol = c; }
            else if (/paid\s*out|money\s*out|withdrawn|withdrawals|debit|payments?\s*out/.test(lo)) { outCol = c; }
            else if (/paid\s*in|money\s*in|deposit|credit|payments?\s*in/.test(lo)) { inCol = c; }
            else if (lo.includes('bal')) {
                balCol = c;
                // Azure DI sometimes merges "Money in Balance" into one cell
                if (lo.includes('money in') || lo === 'in balance') inCol = c + 1;
            }
        }
        // Merged "Description Money out" header
        for (const [c, v] of row) {
            if (v.toLowerCase().includes('description') && v.toLowerCase().includes('money out')) descCol = c;
        }
        // Header row with only description but not date → fallback layout
        if (!joined.includes('date') && joined.includes('description')) {
            dateCol = 0; descCol = 0; outCol = 1; inCol = 2; balCol = 3;
        }
        if (outCol === inCol) outCol = -1;
        break;
    }

    const startRow = headerFound ? 1 : 0;

    // ── Read physical rows ────────────────────────────────────────────────────
    const physical: PhysicalRow[] = [];
    let prevDate       = '';
    let initialBalance: number | null = null;

    for (let r = startRow; r <= rows; r++) {
        const dateCell = normStr(getCell(grid, r, dateCol));
        const rawDesc  = normStr(getCell(grid, r, descCol));
        const rawOut   = stripCurrency(getCell(grid, r, outCol >= 0 ? outCol : 999));
        const rawIn    = stripCurrency(getCell(grid, r, inCol  >= 0 ? inCol  : 999));
        const rawBal   = stripCurrency(getCell(grid, r, balCol >= 0 ? balCol : 999));

        const moneyIn  = parseMoney(rawIn);
        const moneyOut = parseMoney(rawOut);
        const balance  = parseMoney(rawBal);
        const movement = (moneyIn ?? 0) > 0 || (moneyOut ?? 0) > 0;

        // Parse posting date from date cell
        const dpDate = parseDateStr(dateCell);
        let parsedDate = dpDate ?? '';

        // Build description: date cell text after the date + desc cell
        let descFromDateCell = '';
        if (dpDate && dateCell) {
            descFromDateCell = normStr(dateCell.replace(/^\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{4})?\s*/, ''));
        } else if (!dpDate && dateCell && !isAmount(stripCurrency(dateCell).replace(/,/g, ''))) {
            // Date cell has text (not a date, not an amount) → treat as extra desc
            descFromDateCell = dateCell;
        }

        let thisLineDesc = [descFromDateCell, descCol !== dateCol ? rawDesc : ''].filter(Boolean).join(' ').trim();
        if (!thisLineDesc && descCol === dateCol) thisLineDesc = rawDesc;

        // If no date from date cell, try leading date in description
        if (!parsedDate && thisLineDesc) {
            const ld = parseLeadingDate(thisLineDesc);
            if (ld) { parsedDate = ld.date; thisLineDesc = ld.rest; }
        }

        // Inherit previous date
        if (!parsedDate && prevDate) parsedDate = prevDate;

        // ── Skip rows (start balance, brought/carried forward, totals) ─────────
        if (isSkipRow(thisLineDesc) || isSkipRow(dateCell)) {
            const skipBal = balance ?? moneyIn ?? moneyOut ?? null;
            if (skipBal != null) initialBalance = skipBal;
            if (parsedDate) prevDate = parsedDate;
            continue;
        }

        // ── Empty row (no movement, no date cell, no description) ─────────────
        if (!movement && !dateCell && !thisLineDesc) {
            if (balance != null && physical.length === 0) initialBalance = balance;
            continue;
        }

        // ── Continuation: no date cell, no movement, has text → append ────────
        // (port of Make.com: `if(!dateCell && !movement && thisLineDesc)`)
        if (!dateCell && !movement && thisLineDesc) {
            if (physical.length > 0) {
                physical[physical.length - 1].description = normStr(
                    physical[physical.length - 1].description + ' ' + thisLineDesc
                );
                if (balance != null) physical[physical.length - 1].balance = balance;
            }
            continue;
        }

        // ── No date cell but HAS movement → new transaction with inherited date ─
        // (Make.com falls through to push, carrying prevDate forward)

        // Skip description-only noise rows
        if (!movement && !isAmount(rawBal.replace(/,/g, ''))) continue;

        physical.push({
            date:        parsedDate,
            description: thisLineDesc || '',
            moneyOut,
            moneyIn,
            balance,
        });

        if (parsedDate) prevDate = parsedDate;
    }

    // ── Recover initialBalance if not found from skip rows ────────────────────
    if (initialBalance == null) {
        let delta = 0;
        for (const r of physical) {
            delta = delta - (r.moneyOut ?? 0) + (r.moneyIn ?? 0);
            if (r.balance != null) { initialBalance = r.balance - delta; break; }
        }
    }

    // ── Sequential balance computation (module 1341 approach) ─────────────────
    let lastBal = initialBalance;
    for (const r of physical) {
        const out = r.moneyOut ?? 0;
        const inn = r.moneyIn  ?? 0;
        if (lastBal != null) {
            r.computed = lastBal - out + inn;
            lastBal = r.computed;
            if (r.balance != null) { r.computed = r.balance; lastBal = r.balance; }
        } else if (r.balance != null) {
            r.computed = r.balance;
            lastBal = r.balance;
        }
    }

    // ── Output ────────────────────────────────────────────────────────────────
    return {
        transactions: physical
            .filter(t => (t.moneyOut ?? 0) > 0 || (t.moneyIn ?? 0) > 0)
            .map(t => ({
                date:        t.date,
                type:        '',
                description: t.description,
                moneyIn:     (t.moneyIn  ?? 0) > 0 ? fmtMoney(t.moneyIn!)  : '',
                moneyOut:    (t.moneyOut ?? 0) > 0 ? fmtMoney(t.moneyOut!) : '',
                balance:     t.computed != null ? fmtMoney(t.computed) : (t.balance != null ? fmtMoney(t.balance) : ''),
            })),
    };
}
