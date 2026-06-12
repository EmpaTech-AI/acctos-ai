import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, balanceStr, buildGrid,
    parseDateToDDMMYYYY
} from './shared.js';

const MONTH_MAP: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

function isYearOnly(s: string): boolean {
    return /^(19|20)\d{2}$/.test(normStr(s));
}

function isDayMon(s: string): boolean {
    return /^\d{1,2}\s+[A-Za-z]{3}$/i.test(normStr(s));
}

// Converts "5 MAR 2026" or "05/03/2026" → "05/03/2026"
function toDDMMYYYY(s: string): string {
    s = normStr(s);
    if (!s) return '';

    // Already DD/MM/YYYY
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/);
    if (slash) {
        return `${slash[1].padStart(2, '0')}/${slash[2].padStart(2, '0')}/${slash[3]}`;
    }

    // "5 MAR 2026"
    const dmY = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+((?:19|20)\d{2})$/i);
    if (dmY) {
        const mm = MONTH_MAP[dmY[2].toUpperCase()];
        if (!mm) return parseDateToDDMMYYYY(s) || '';
        return `${dmY[1].padStart(2, '0')}/${mm}/${dmY[3]}`;
    }

    return parseDateToDDMMYYYY(s) || '';
}

// Detect column indices from a Nationwide header row.
// Returns null if the row is not a valid transaction header.
function detectCols(row: Map<number, string>): { dateCol: number; descCol: number; outCol: number; inCol: number; balCol: number } | null {
    let dateCol = -1, descCol = -1, outCol = -1, inCol = -1, balCol = -1;
    for (const [c, v] of row) {
        const lo = normStr(v).toLowerCase();
        if (lo === 'date')                                                         dateCol = c;
        else if (lo === 'description')                                             descCol = c;
        else if (lo.includes('out'))                                               outCol  = c;
        else if (lo.includes('balance'))                                           balCol  = c;
        else if (lo.includes('in') && !lo.includes('description') && lo !== '£in') inCol  = c;
        // "£In" is the Nationwide in-column label
        else if (lo === '£in' || lo === 'in')                                      inCol  = c;
    }
    if (dateCol < 0 || descCol < 0 || outCol < 0 || inCol < 0) return null;
    return { dateCol, descCol, outCol, inCol, balCol: balCol >= 0 ? balCol : outCol + 2 };
}

function amt(s: string): string {
    if (/\d%/.test(s)) return '';  // reject "2.99% of the transaction amount" style fee-table strings
    if (/^\s*[£$€]?\s*[\d,]+\.?\d*\s+[a-zA-Z]/.test(s)) return '';  // reject "£2.94 for 7 days" style fee-table strings
    const n = parseMoney(s);
    return n !== null && n !== 0 ? formatMoney(n) : '';
}

// Nationwide page headers can appear mid-grid when Azure DI shifts columns.
// Any row containing these labels must be skipped entirely.
const PAGE_HEADER_RE = /\b(account\s*(no|number)|statement\s*(no|number|date)|sort\s+code|account\s+holder|account\s+name)\b/i;

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const sortedRows = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    if (!sortedRows.length) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];
    let currentYear = '';
    let currentDate = '';
    let current: ParsedTransaction | null = null;
    let openingBalance: number | null = null;

    // Default column positions (most pages use 0-4); updated whenever a header row is found.
    let dateCol = 0, descCol = 1, outCol = 2, inCol = 3, balCol = 4;

    function flush() {
        if (!current) return;
        if (current.moneyIn || current.moneyOut) {
            transactions.push(current);
        }
        current = null;
    }

    for (const r of sortedRows) {
        const row = grid.get(r)!;

        // Skip page-header rows regardless of column position (Azure DI can shift columns)
        const rawRowText = [...row.values()].join(' ');
        if (PAGE_HEADER_RE.test(rawRowText)) continue;

        const cols = detectCols(row);
        if (cols) {
            // Update column positions from this page's header
            ({ dateCol, descCol, outCol, inCol, balCol } = cols);
            flush();
            continue;
        }

        const dateCell = normStr(row.get(dateCol) ?? '');
        const descCell = normStr(row.get(descCol) ?? '');
        const outCell  = normStr(row.get(outCol) ?? '');
        const inCell   = normStr(row.get(inCol) ?? '');
        const balCell  = normStr(row.get(balCol) ?? '');

        // Standalone year row → update tracker, do not start a transaction.
        // If the description reads "Balance from statement", capture the opening balance.
        if (isYearOnly(dateCell)) {
            currentYear = dateCell;
            if (openingBalance === null) {
                const desc = normStr(row.get(descCol) ?? '');
                if (/balance\s+from\s+statement/i.test(desc)) {
                    const n = parseMoney(normStr(row.get(balCol) ?? ''));
                    if (n !== null) openingBalance = n;
                }
            }
            continue;
        }

        const moneyOut = amt(outCell);
        const moneyIn  = amt(inCell);
        const balance  = balanceStr(balCell);
        const hasAmount = !!(moneyOut || moneyIn);

        // Resolve date — only valid if it parses to DD/MM/YYYY
        const parsedDate = (() => {
            if (!dateCell) return '';
            const full = isDayMon(dateCell) && currentYear ? `${dateCell} ${currentYear}` : dateCell;
            return toDDMMYYYY(full);
        })();
        if (parsedDate) currentDate = parsedDate;

        const hasAny = !!(dateCell || descCell || hasAmount || balance);
        if (!hasAny) continue;

        // Start a new transaction only when we have a proper date OR an amount on an already-dated row.
        // This prevents fee-schedule rows ("Credit interest", "Arranged overdraft interest", etc.)
        // from accidentally creating phantom transactions.
        const startNew = parsedDate || (hasAmount && !!currentDate);
        if (startNew) {
            flush();
            current = {
                date: currentDate,
                type: '',
                description: descCell,
                moneyOut,
                moneyIn,
                balance,
            };
        } else if (current) {
            // Continuation row: no date, no amount → append description, maybe fill balance
            if (descCell) current.description = normStr(`${current.description} ${descCell}`);
            if (balance && !current.balance) current.balance = balance;
        }
    }

    flush();

    // Derive closing balance from the last transaction that has a balance value
    let closingBalance: number | null = null;
    for (let i = transactions.length - 1; i >= 0; i--) {
        const n = parseMoney(transactions[i].balance);
        if (n !== null) { closingBalance = n; break; }
    }

    const hasTotals = openingBalance !== null || closingBalance !== null;
    const statementTotals = hasTotals ? {
        moneyIn:  transactions.reduce((s, t) => s + (parseMoney(t.moneyIn)  ?? 0), 0),
        moneyOut: transactions.reduce((s, t) => s + (parseMoney(t.moneyOut) ?? 0), 0),
        ...(openingBalance !== null && { openingBalance }),
        ...(closingBalance !== null && { closingBalance }),
    } : undefined;

    return { transactions, statementTotals, ascending: true };
}
