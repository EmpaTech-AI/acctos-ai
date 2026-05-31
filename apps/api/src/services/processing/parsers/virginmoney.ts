// Virgin Money parser
// Layout A (6-col): date | description | type | debit | credit | balance | ">"
// Layout B (5-col): date | description | type | amount | balance | ">"
// Distinguish: Layout A when col5 contains "£" OR col6 is present; else Layout B.
// Direction for Layout A: credit col (4) → in; debit col (3) → out.
// Direction for Layout B: balance delta with look-ahead (statement is reverse-chronological).
//   diff = physRows[i+1].balance - physRows[i].balance  (older − newer)
//   diff > 0 → balance went down → debit (moneyOut)
//   diff < 0 → balance went up   → credit (moneyIn)
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow, maxCol,
} from './shared.js';

const MONTH_MAP: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function parseDate(raw: string): string {
    const s = normStr(raw).replace(/[▼►▲]/g, '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2}|\d{4})$/);
    if (!m) return '';
    const day = Number(m[1]);
    const mon = MONTH_MAP[m[2].toLowerCase()];
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (!mon || day < 1 || day > 31) return '';
    return `${String(day).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${year}`;
}

function isHeaderRow(cols: string[]): boolean {
    const joined = cols.join(' ').toLowerCase();
    return (
        joined.includes('date') &&
        joined.includes('description') &&
        joined.includes('debit') &&
        joined.includes('credit') &&
        joined.includes('balance')
    );
}

function cleanOcr(s: string): string {
    return normStr(s)
        .replace(/:selected:/gi, '')
        .replace(/:unselected:/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanType(raw: string): string {
    const s = cleanOcr(raw);
    const fixes: Record<string, string> = {
        'Direct De bit': 'Direct Debit',
        'Cash Adv ance': 'Cash Advance',
    };
    return fixes[s] ?? s;
}

function signedBal(raw: string): string {
    const isOD = /\b(OD|DR)\b/i.test(raw);
    const n = parseMoney(raw);
    if (n === null) return '';
    const abs = formatMoney(Math.abs(n));
    return isOD && Math.abs(n) > 0 ? '-' + abs : abs;
}

interface PhysRow {
    date:       string;
    desc:       string;
    type:       string;
    rawBalance: string;
    balanceNum: number | null;
    // Layout A — direct in/out from credit/debit columns
    directIn:   number | null;
    directOut:  number | null;
    // Layout B — raw amount, direction via look-ahead balance delta
    amount:     number | null;
    isCompact:  boolean;
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);
    const cols = maxCol(cells);

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

    let startAt = 0;
    for (let i = 0; i < table.length; i++) {
        if (isHeaderRow(table[i].cols)) {
            startAt = i + 1;
            break;
        }
    }

    // ── Phase 1: build physical rows ────────────────────────────────────────────
    const physRows: PhysRow[] = [];
    let lastDate = '';

    for (let i = startAt; i < table.length; i++) {
        const c = table[i].cols;
        if (c.every(v => !normStr(v))) continue;
        if (isHeaderRow(c)) continue;

        const parsedDate = parseDate(c[0]);
        if (parsedDate) lastDate = parsedDate;
        const date = parsedDate || lastDate;
        if (!date) continue;

        const desc = cleanOcr(c[1]);
        if (!desc) continue;

        const type = cleanType(c[2]);

        const col3Raw = normStr(c[3] ?? '');
        const col4Raw = normStr(c[4] ?? '');
        const col5Raw = normStr(c[5] ?? '');
        const col6Raw = normStr(c[6] ?? '');

        const col3Amt = parseMoney(col3Raw);
        const col4Amt = parseMoney(col4Raw);

        // Distinguish layout:
        //  ">" or ":selected:" in col5 but NO "£" → compact (Layout B)
        //  col6 present OR col5 contains "£"       → normal  (Layout A)
        const col5HasPound = col5Raw.includes('£');
        const hasCol6      = col6Raw !== '';

        if (col5HasPound || hasCol6) {
            // Layout A: col3=debit, col4=credit, col5=balance
            const directIn  = col4Amt !== null && col4Amt > 0 ? col4Amt : null;
            const directOut = col3Amt !== null && col3Amt > 0 ? col3Amt : null;
            if (!directIn && !directOut) continue;

            physRows.push({
                date, desc, type,
                rawBalance: col5Raw,
                balanceNum: parseMoney(col5Raw),
                directIn, directOut,
                amount: null,
                isCompact: false,
            });
        } else if (col4Raw && col3Amt !== null && col3Amt > 0) {
            // Layout B: col3=amount, col4=balance, col5=">"
            physRows.push({
                date, desc, type,
                rawBalance: col4Raw,
                balanceNum: parseMoney(col4Raw),
                directIn: null, directOut: null,
                amount: col3Amt,
                isCompact: true,
            });
        }
    }

    // ── Phase 2: determine direction + emit ─────────────────────────────────────
    const transactions: ParsedTransaction[] = [];

    for (let i = 0; i < physRows.length; i++) {
        const row = physRows[i];
        const balance = signedBal(row.rawBalance);

        let moneyIn  = '';
        let moneyOut = '';

        if (!row.isCompact) {
            // Layout A: direction directly from columns
            if (row.directIn)  moneyIn  = formatMoney(row.directIn);
            else if (row.directOut) moneyOut = formatMoney(row.directOut);
        } else {
            // Layout B: use look-ahead balance delta
            // diff = nextRow.balance − thisRow.balance  (older − newer in reverse-chron order)
            //   diff > 0 → balance was higher before → debit (moneyOut)
            //   diff < 0 → balance was lower before  → credit (moneyIn)
            const amount  = row.amount!;
            const nextBal = i + 1 < physRows.length ? physRows[i + 1].balanceNum : null;
            const curBal  = row.balanceNum;

            if (nextBal !== null && curBal !== null) {
                const diff = nextBal - curBal;
                if      (Math.abs(diff - amount) <= 0.01) moneyOut = formatMoney(amount);
                else if (Math.abs(diff + amount) <= 0.01) moneyIn  = formatMoney(amount);
                else                                      moneyOut = formatMoney(amount);
            } else {
                moneyOut = formatMoney(amount);
            }
        }

        if (!moneyIn && !moneyOut) continue;

        transactions.push({ date: row.date, type: row.type, description: row.desc, moneyIn, moneyOut, balance });
    }

    return { transactions };
}
