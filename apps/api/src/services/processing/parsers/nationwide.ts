import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid,
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
        if (!mm) return parseDateToDDMMYYYY(s) || s;
        return `${dmY[1].padStart(2, '0')}/${mm}/${dmY[3]}`;
    }

    return parseDateToDDMMYYYY(s) || s;
}

// Nationwide header: date | description | out | in | balance (exact pattern)
function isHeaderRow(row: Map<number, string>): boolean {
    const vals = [...row.values()].map(v => normStr(v).toLowerCase());
    return (
        vals.some(v => v === 'date') &&
        vals.some(v => v === 'description') &&
        vals.some(v => v.includes('out')) &&
        vals.some(v => v.includes('in') && !v.includes('description') && !v.includes('out')) &&
        vals.some(v => v.includes('balance'))
    );
}

function amt(s: string): string {
    const n = parseMoney(s);
    return n !== null ? formatMoney(n) : '';
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const sortedRows = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    if (!sortedRows.length) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];
    let currentYear = '';
    let currentDate = '';
    let current: ParsedTransaction | null = null;

    function flush() {
        if (!current) return;
        // Require both an amount and a description (matches Make.com finalize logic)
        if ((current.moneyIn || current.moneyOut) && current.description) {
            transactions.push(current);
        }
        current = null;
    }

    for (const r of sortedRows) {
        const row = grid.get(r)!;

        if (isHeaderRow(row)) {
            flush();
            continue;
        }

        const dateCell = normStr(row.get(0) ?? '');
        const descCell = normStr(row.get(1) ?? '');
        const outCell  = normStr(row.get(2) ?? '');
        const inCell   = normStr(row.get(3) ?? '');
        const balCell  = normStr(row.get(4) ?? '');

        // Standalone year row → update tracker, do not start a transaction
        if (isYearOnly(dateCell)) {
            currentYear = dateCell;
            continue;
        }

        const moneyOut = amt(outCell);
        const moneyIn  = amt(inCell);
        const balance  = amt(balCell);
        const hasAmount = !!(moneyOut || moneyIn);
        const hasAny = !!(dateCell || descCell || hasAmount || balance);

        if (!hasAny) continue;

        // Build full date: "5 MAR" + currentYear → "5 MAR 2026"
        if (dateCell) {
            let fullDate = dateCell;
            if (isDayMon(dateCell) && currentYear) fullDate = `${dateCell} ${currentYear}`;
            currentDate = toDDMMYYYY(fullDate) || currentDate;
        }

        if (dateCell || hasAmount) {
            // New transaction — use currentDate when date cell is empty but amount is present
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
    return { transactions };
}
