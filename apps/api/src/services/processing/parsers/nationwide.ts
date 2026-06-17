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

// Strip ordinal suffixes: "22nd" → "22", "1st" → "1", "3rd" → "3", "4th" → "4"
function stripOrdinal(s: string): string {
    return s.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
}

function isDayMon(s: string): boolean {
    return /^\d{1,2}\s+[A-Za-z]{3}$/i.test(stripOrdinal(normStr(s)));
}

// Converts "5 MAR 2026", "22nd Mar 2025" or "05/03/2026" → "05/03/2026"
function toDDMMYYYY(s: string): string {
    s = stripOrdinal(normStr(s));
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
// inCol=-1 means no separate money-in column (consumer format where credits are in description).
function detectCols(row: Map<number, string>): { dateCol: number; descCol: number; outCol: number; inCol: number; balCol: number } | null {
    let dateCol = -1, descCol = -1, outCol = -1, inCol = -1, balCol = -1;
    let descHasMoneyIn = false;
    for (const [c, v] of row) {
        const lo = normStr(v).toLowerCase();
        if (lo === 'date')                                                               dateCol = c;
        else if (lo === 'description' || lo.startsWith('payment type'))                 descCol = c;
        // "Description Money in" — Azure DI merges desc+in column headers in consumer statements
        else if (/^description.*(money.*in|in.*money)/i.test(lo))                      { descCol = c; descHasMoneyIn = true; }
        else if (lo.includes('out'))                                                     outCol  = c;
        else if (lo.includes('balance'))                                                 balCol  = c;
        else if (lo.includes('in') && !lo.includes('description') && lo !== '£in')      inCol   = c;
        // "£In" is the Nationwide in-column label
        else if (lo === '£in' || lo === 'in')                                           inCol   = c;
    }
    if (dateCol < 0 || descCol < 0 || outCol < 0) return null;
    // Allow inCol=-1 when desc and in columns are merged (consumer statement format)
    if (inCol < 0 && !descHasMoneyIn) return null;
    return { dateCol, descCol, outCol, inCol, balCol: balCol >= 0 ? balCol : outCol + 2 };
}

function amt(s: string): string {
    if (!s) return '';
    if (/\d%/.test(s)) return '';  // reject "2.99% of the transaction amount" style fee-table strings
    if (/^\s*[£$€]?\s*[\d,]+\.?\d*\s+[a-zA-Z]/.test(s)) return '';  // reject "£2.94 for 7 days" style fee-table strings
    // Reject strings that don't start with an optional currency symbol + digit.
    // Azure DI sometimes puts address fragments ("LONDON, 20.00") in amount columns.
    if (!/^\s*[-£$€]?\s*\d/.test(s)) return '';
    const n = parseMoney(s);
    return n !== null && n !== 0 ? formatMoney(n) : '';
}

// Nationwide page headers / summary rows that must be skipped entirely.
const PAGE_HEADER_RE = /\b(account\s*(no|number)|statement\s*(no|number|date)|sort\s+code|account\s+holder|account\s+name|average\s+(?:credit|debit)\s+balance|average\s+balance\s+for)\b/i;

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const sortedRows = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    if (!sortedRows.length) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];
    let currentYear = '';
    let currentDate = '';
    let current: ParsedTransaction | null = null;
    let openingBalance: number | null = null;

    // Pre-scan 1: extract year from any row containing a 4-digit year (e.g. summary rows).
    // Consumer statements like "Your balance at close of business 21st Apr 2025" carry the year
    // but have no standalone year row, so we must extract it from summary text.
    for (const r of sortedRows) {
        const row = grid.get(r)!;
        for (const v of row.values()) {
            const m = normStr(v).match(/\b(20\d{2})\b/);
            if (m) { currentYear = m[1]; break; }
        }
        if (currentYear) break;
    }

    // Pre-scan 2: capture opening balance, and declared in/out totals from summary rows.
    let declaredIn:  number | null = null;
    let declaredOut: number | null = null;
    for (const r of sortedRows) {
        const row = grid.get(r)!;
        const c0 = normStr(row.get(0) ?? '');
        const lo = c0.toLowerCase();
        if (lo === 'opening balance' || lo.startsWith('balance brought forward')) {
            if (openingBalance === null) {
                const n = parseMoney(normStr(row.get(1) ?? ''));
                if (n !== null) openingBalance = n;
            }
        } else if (/^total\s+money\s+in\s*:?$/i.test(lo)) {
            const n = parseMoney(normStr(row.get(1) ?? ''));
            if (n !== null) declaredIn = Math.abs(n);
        } else if (/^total\s+money\s+out\s*:?$/i.test(lo)) {
            const n = parseMoney(normStr(row.get(1) ?? ''));
            if (n !== null) declaredOut = Math.abs(n);
        }
    }

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
        // When outCol > descCol+1, there is an extra details column between desc and out
        // (e.g. business current account: col1=payment-type, col2=merchant, col3=paid-out).
        // Merge both text cells into a single description.
        const descExtra = outCol > descCol + 1 ? normStr(row.get(descCol + 1) ?? '') : '';
        // On pages where descCol>1, c1 is a "type" column (DEBIT/ATM). Azure DI sometimes
        // places credit descriptions in c1 (no type prefix) when descCell is empty — e.g.
        // "FASTER PAYMENTS RECEIPT ... 512.00" ends up in c1 with c2 empty.
        const typeCell  = descCol > 1 ? normStr(row.get(1) ?? '') : '';
        const isTypeKw  = /^(debit|credit|atm|direct\s+debit|standing\s+order|dd|fps|bacs)$/i.test(typeCell);
        const descFull  = [descCell, descExtra, ...(descCell === '' && typeCell && !isTypeKw ? [typeCell] : [])].filter(Boolean).join(' ');
        const outCell  = normStr(row.get(outCol) ?? '');
        const inCell   = inCol >= 0 ? normStr(row.get(inCol) ?? '') : '';
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

        let moneyOut = amt(outCell);
        let moneyIn  = amt(inCell);
        // Nationwide consumer format: FASTER PAYMENTS RECEIPT credits sometimes have
        // the amount embedded at the end of the description rather than in a column.
        if (!moneyOut && !moneyIn && /\b(faster\s+payments?\s+receipt|bank\s+giro\s+credit)\b/i.test(descFull)) {
            const m = descFull.match(/\b(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/);
            if (m) { const n = parseMoney(m[1]); if (n !== null && n > 0) moneyIn = formatMoney(n); }
        }
        // ATM cash withdrawals are always debits; if Azure DI placed the amount in the
        // money-in column (alone or duplicated across both columns), clear money-in.
        if (moneyIn && /\b(cash\s+withdrawal)\b/i.test(descFull)) {
            if (!moneyOut) moneyOut = moneyIn;
            moneyIn = '';
        }
        const balance  = balanceStr(balCell);
        const hasAmount = !!(moneyOut || moneyIn);

        // Resolve date — only valid if it parses to DD/MM/YYYY
        const parsedDate = (() => {
            if (!dateCell) return '';
            const full = isDayMon(dateCell) && currentYear ? `${dateCell} ${currentYear}` : dateCell;
            return toDDMMYYYY(full);
        })();
        if (parsedDate) currentDate = parsedDate;

        const hasAny = !!(dateCell || descFull || hasAmount || balance);
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
                description: descFull,
                moneyOut,
                moneyIn,
                balance,
            };
        } else if (current) {
            // Continuation row: no date, no amount → append description, maybe fill balance
            if (descFull) current.description = normStr(`${current.description} ${descFull}`);
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

    const parsedInSum  = transactions.reduce((s, t) => s + (parseMoney(t.moneyIn)  ?? 0), 0);
    const parsedOutSum = transactions.reduce((s, t) => s + (parseMoney(t.moneyOut) ?? 0), 0);
    const hasTotals = openingBalance !== null || closingBalance !== null || declaredIn !== null || declaredOut !== null;
    const statementTotals = hasTotals ? {
        // Use declared totals when available so check scripts can compare parsed vs declared.
        moneyIn:  declaredIn  !== null ? declaredIn  : parsedInSum,
        moneyOut: declaredOut !== null ? declaredOut : parsedOutSum,
        ...(openingBalance !== null && { openingBalance }),
        ...(closingBalance !== null && { closingBalance }),
    } : undefined;

    return { transactions, statementTotals, ascending: true };
}
