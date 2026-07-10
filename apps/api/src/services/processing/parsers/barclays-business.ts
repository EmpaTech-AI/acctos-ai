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

    // ── Declared totals ───────────────────────────────────────────────────────
    const statementTotals = extractDeclaredTotals(cells, table);
    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}

/**
 * Extract bank-declared totals from the Barclays Business statement summary rows.
 * The PDF typically contains "Start balance", "Total payments/receipts", "End balance"
 * rows in the cell grid that are skipped during transaction parsing.
 * Falls back to content string if cell extraction yields nothing.
 */
function extractDeclaredTotals(cells: Cell[], table: string[][]): ParseResult['statementTotals'] | undefined {
    let moneyIn: number | undefined;
    let moneyOut: number | undefined;
    let openingBalance: number | undefined;
    let closingBalance: number | undefined;

    // Pass 1: cell grid.
    // Supports two layouts:
    //   5-col (main transaction table): date | label | moneyIn | moneyOut | balance  → label in col1
    //   2-col (summary box):            label | value                                → label in col0
    for (const row of table) {
        // col1 is the desc/label column in the 5-col layout; col0 in a 2-col summary box.
        // If col1 looks like a money value (digits/commas/£) rather than a text label, prefer col0.
        const col0 = (row[0] || '').toLowerCase().trim();
        const col1 = (row[1] || '').toLowerCase().trim();
        const col1isMoneyLike = col1 !== '' && /^[£\d,.\s]+$/.test(col1);
        const label = col1isMoneyLike ? col0 : (col1 || col0);

        // Value columns — try all positions; parseMoney handles commas/£/empty gracefully.
        const allCols = [row[4], row[2], row[3], row[1]];
        const pickVal = () => allCols.reduce((acc: number | null, c) => acc ?? parseMoney(c || ''), null);

        if (/start\s+balance|opening\s+balance/.test(label)) {
            const v = pickVal();
            if (v !== null) openingBalance = Math.abs(v);
        } else if (/end\s+balance|closing\s+balance/.test(label)) {
            // Check all columns for the raw string so we can detect OD suffix.
            const raw = row[4] || row[2] || row[3] || row[1] || '';
            const v = parseMoney(raw);
            if (v !== null) closingBalance = /\bOD\b/i.test(raw) ? -Math.abs(v) : v;
        } else if (/total\s+payments?\s*[\/\\]?\s*receipts?/i.test(label)) {
            // Combined row: col2 = receipts (in), col3 = payments (out).
            // Slash between "payments" and "receipts" is optional — Azure DI sometimes drops it.
            const vIn  = parseMoney(row[2] || '');
            const vOut = parseMoney(row[3] || '');
            if (vIn  !== null) moneyIn  = Math.abs(vIn);
            if (vOut !== null) moneyOut = Math.abs(vOut);
        } else if (/total\s+payments?/i.test(label) && !/receipts?/i.test(label)) {
            const v = parseMoney(row[3] || '') ?? parseMoney(row[2] || '');
            if (v !== null) moneyOut = Math.abs(v);
        } else if (/total\s+receipts?/i.test(label)) {
            const v = parseMoney(row[2] || '') ?? parseMoney(row[3] || '');
            if (v !== null) moneyIn = Math.abs(v);
        } else if (/\bmoney\s+in\b/i.test(label) && !/\bmoney\s+out\b/i.test(label)) {
            // "Money in" as a standalone summary row label (some Barclays Business layouts).
            const v = parseMoney(row[2] || '') ?? parseMoney(row[4] || '') ?? parseMoney(row[1] || '');
            if (v !== null) moneyIn = Math.abs(v);
        } else if (/\bmoney\s+out\b/i.test(label)) {
            const v = parseMoney(row[3] || '') ?? parseMoney(row[2] || '') ?? parseMoney(row[1] || '');
            if (v !== null) moneyOut = Math.abs(v);
        }
    }

    // Pass 2: content string fallback (label followed by £amount, separated by space or newline).
    if (moneyIn === undefined || moneyOut === undefined || openingBalance === undefined || closingBalance === undefined) {
        const content = cells.find(c => c.rowIndex < 0)?.content ?? '';
        // sep: one or more whitespace chars (space, tab, newline) optionally with a £ sign
        const pick = (re: RegExp): number | undefined => {
            const m = re.exec(content);
            if (!m) return undefined;
            const v = parseMoney(m[1]);
            return v !== null ? Math.abs(v) : undefined;
        };
        // Allow space OR newline as separator between label and amount.
        const SEP = /\s+£?\s*/;
        const amt = /([\d,]+\.?\d*)/;
        const mk = (label: string) => new RegExp(label + SEP.source + amt.source, 'i');

        if (moneyIn === undefined)
            moneyIn = pick(mk('\\bMoney\\s+in\\b'))
                   ?? pick(mk('\\bTotal\\s+receipts?'));
        if (moneyOut === undefined)
            moneyOut = pick(mk('\\bMoney\\s+out\\b'))
                    ?? pick(mk('\\bTotal\\s+payments?'));
        if (openingBalance === undefined)
            openingBalance = pick(mk('\\bStart\\s+balance'))
                          ?? pick(mk('\\bOpening\\s+balance'));
        if (closingBalance === undefined) {
            const ecm = mk('\\bEnd\\s+balance').exec(content)
                     ?? mk('\\bClosing\\s+balance').exec(content);
            if (ecm) {
                const v = parseMoney(ecm[1]);
                // Check for OD in the original content near this match.
                const near = content.slice(ecm.index, ecm.index + 40);
                if (v !== null) closingBalance = /\bOD\b/i.test(near) ? -Math.abs(v) : v;
            }
        }
    }

    if (moneyIn === undefined || moneyOut === undefined) return undefined;
    return { moneyIn, moneyOut, openingBalance, closingBalance };
}
