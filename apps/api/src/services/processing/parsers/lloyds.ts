import { Cell, ParsedTransaction, ParseResult, normStr } from './shared.js';

function parseMoney(s: string): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/[£,\s]/g, '');
    const n = Number(s);
    if (!isFinite(n)) return '';
    return Math.abs(n).toFixed(2);
}

function parseBalance(s: string): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/[£,\s]/g, '');
    const n = Number(s);
    if (!isFinite(n)) return '';
    return n.toFixed(2);
}

function parseDate(s: string): string {
    s = normStr(s);
    if (!s) return '';
    // Web format: 2026-04-30
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    // Scanned format: 30 Apr 26 or 30 Apr 2026 — allow trailing text e.g. "(Continued on…)"
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\b/);
    if (!m) return '';
    const MONTHS: Record<string, string> = {
        jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
        jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
    };
    const day = String(Number(m[1])).padStart(2, '0');
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return '';
    let year = m[3];
    if (year.length === 2) year = '20' + year;
    return `${day}/${mon}/${year}`;
}

function mapType(code: string): string {
    const map: Record<string, string> = {
        BGC: 'BANK GIRO CREDIT',
        BP:  'BILL PAYMENT',
        CHG: 'CHARGE',
        CHQ: 'CHEQUE',
        COR: 'CORRECTION',
        CPT: 'CASHPOINT',
        DC:  'DIRECT CREDIT',
        DD:  'DIRECT DEBIT',
        DEB: 'DEBIT CARD',
        DEP: 'DEPOSIT',
        FEE: 'FIXED SERVICE FEE',
        FPI: 'FASTER PAYMENT IN',
        FPO: 'FASTER PAYMENT OUT',
        CSH: 'CASH WITHDRAWAL',
        MPI: 'MOBILE PAYMENT IN',
        MPO: 'MOBILE PAYMENT OUT',
        PAY: 'PAYMENT',
        SO:  'STANDING ORDER',
        TFR: 'TRANSFER',
    };
    return map[code.toUpperCase()] ?? code;
}

export function parse(cells: Cell[]): ParseResult {
    const realCells = cells.filter(c => c.rowIndex >= 0);
    if (realCells.length === 0) return { transactions: [] };

    // Build row map: rowIndex → columnIndex → content
    const rowMap = new Map<number, Map<number, string>>();
    for (const cell of realCells) {
        if (!rowMap.has(cell.rowIndex)) rowMap.set(cell.rowIndex, new Map());
        rowMap.get(cell.rowIndex)!.set(cell.columnIndex, normStr(cell.content));
    }

    const rows = [...rowMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, colMap]) => ({ cells: colMap }));

    // Detect header row and column indices
    let COL_DATE = 0, COL_TYPE = 1, COL_DETAILS = 2, COL_OUT = 3, COL_IN = 4, COL_BAL = 5;
    let format: 'old' | 'new' = 'old';
    let headerFound = false;

    for (const row of rows) {
        const vals = [...row.cells.values()].map(v => v.toLowerCase());

        const isOldHeader =
            vals.includes('date') &&
            vals.some(v => v.includes('payment type')) &&
            vals.some(v => v === 'details') &&
            vals.some(v => v.includes('paid out')) &&
            vals.some(v => v.includes('paid in')) &&
            vals.some(v => v.startsWith('balance'));

        const isNewHeader =
            vals.includes('date') &&
            vals.some(v => v === 'description') &&
            vals.some(v => v === 'type') &&
            vals.some(v => v === 'in (£)' || v === 'in' || v.includes('money in')) &&
            vals.some(v => v === 'out (£)' || v === 'out' || v.includes('money out')) &&
            vals.some(v => v.startsWith('balance'));

        if (!isOldHeader && !isNewHeader) continue;

        format = isNewHeader ? 'new' : 'old';

        for (const [col, v] of row.cells.entries()) {
            const vl = v.toLowerCase();
            if (vl === 'date') { COL_DATE = col; continue; }
            if (format === 'old') {
                if (vl === 'payment type')       COL_TYPE    = col;
                else if (vl === 'details')        COL_DETAILS = col;
                else if (vl.includes('paid out')) COL_OUT     = col;
                else if (vl.includes('paid in'))  COL_IN      = col;
                else if (vl.startsWith('balance'))COL_BAL     = col;
            } else {
                if (vl === 'description')                     COL_DETAILS = col;
                else if (vl === 'type')                       COL_TYPE    = col;
                else if (vl === 'in (£)' || vl === 'in' || vl.includes('money in'))   COL_IN  = col;
                else if (vl === 'out (£)' || vl === 'out' || vl.includes('money out')) COL_OUT = col;
                else if (vl.startsWith('balance'))            COL_BAL     = col;
            }
        }

        headerFound = true;
        break;
    }

    if (!headerFound) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];

    for (const row of rows) {
        const c = row.cells;
        const dateRaw    = c.get(COL_DATE)    ?? '';
        const rawType    = c.get(COL_TYPE)    ?? '';
        const details    = c.get(COL_DETAILS) ?? '';
        const paidOut    = parseMoney(c.get(COL_OUT) ?? '');
        const paidIn     = parseMoney(c.get(COL_IN)  ?? '');
        const balance    = parseBalance(c.get(COL_BAL) ?? '');
        const date       = parseDate(dateRaw);
        const type       = format === 'new' ? mapType(rawType) : rawType;

        // Continuation row: old scanned format, no date, no amounts — append to previous
        if (format === 'old' && !date && transactions.length > 0 && !paidIn && !paidOut) {
            const last = transactions[transactions.length - 1];
            if (type)    last.type        = normStr(`${last.type} ${type}`);
            if (details) last.description = normStr(`${last.description} ${details}`);
            continue;
        }

        if (!date) continue;

        const rowText = normStr(`${type} ${details}`).toUpperCase();
        if (rowText.includes('BALANCE BROUGHT FORWARD') || rowText.includes('BALANCE CARRIED FORWARD')) continue;
        if (!paidIn && !paidOut) continue;

        transactions.push({ date, type, description: details, moneyIn: paidIn, moneyOut: paidOut, balance });
    }

    // Lloyds web format PDFs are oldest-first (earliest date at top of statement)
    return { transactions, ascending: true };
}
