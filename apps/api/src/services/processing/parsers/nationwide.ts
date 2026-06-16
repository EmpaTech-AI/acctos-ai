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
    if (/^\d{6,}$/.test(s.trim())) return '';  // reject bare integers ≥6 digits (account numbers, sort codes)
    if (/\d\s+\d/.test(s)) return '';  // reject digit-space-digit e.g. "99 4 of 6" (statement/page numbers)
    const n = parseMoney(s);
    return n !== null && n !== 0 ? formatMoney(n) : '';
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const sortedRows = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    if (!sortedRows.length) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];
    let currentYear = '';
    let currentDate = '';
    let current: ParsedTransaction | null = null;
    // origDesc: description of current at the moment it was created (before any continuation rows).
    // Used to detect when continuation rows belong to the NEXT transaction, not the current one.
    let origDesc = '';

    // Default column positions (most pages use 0-4); updated whenever a header row is found.
    let dateCol = 0, descCol = 1, outCol = 2, inCol = 3, balCol = 4;

    function flush() {
        if (!current) return;
        if (current.moneyIn || current.moneyOut) {
            transactions.push(current);
        }
        current = null;
        origDesc = '';
    }

    for (const r of sortedRows) {
        const row = grid.get(r)!;

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

        // Standalone year row → update tracker, do not start a transaction
        if (isYearOnly(dateCell)) {
            currentYear = dateCell;
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
            // Amount-only row (no date, no description) following continuation rows:
            // the continuation text was added to the previous transaction but belongs to this new one.
            // Steal it back so the previous transaction keeps only its original description.
            if (!parsedDate && !descCell && hasAmount && current && origDesc !== current.description) {
                const stolen = normStr(current.description.slice(origDesc.length));
                current.description = origDesc;
                flush();
                current = { date: currentDate, type: '', description: stolen, moneyOut, moneyIn, balance };
                origDesc = stolen;
            } else {
                flush();
                current = { date: currentDate, type: '', description: descCell, moneyOut, moneyIn, balance };
                origDesc = descCell;
            }
        } else if (current) {
            // Continuation row: no date, no amount → append description, maybe fill balance
            if (descCell) current.description = normStr(`${current.description} ${descCell}`);
            if (balance && !current.balance) current.balance = balance;
        }
    }

    flush();
    return { transactions, ascending: true };
}
