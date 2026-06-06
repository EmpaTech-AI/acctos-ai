import { Cell, ParsedTransaction, ParseResult, normStr } from './shared.js';

function parseMoney(s: string): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/[£,\s]/g, '');
    const n = Number(s);
    if (!isFinite(n)) return '';
    return Math.abs(n).toFixed(2);
}

function parseSignedBalance(s: string): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/[£,\s]/g, '');
    const n = Number(s);
    if (!isFinite(n)) return '';
    return n.toFixed(2);
}

function parseDate(s: string): string {
    s = normStr(s);
    // Web format: 2026-04-30
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    // Scanned format: 30 Apr 26 or 30 Apr 2026 — allow trailing text
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
        FPI: 'FASTER PAYMENT IN',
        FPO: 'FASTER PAYMENT OUT',
        DC:  'DIRECT CREDIT',
        DD:  'DIRECT DEBIT',
        DEB: 'DEBIT CARD',
        CSH: 'CASH WITHDRAWAL',
        PAY: 'PAYMENT',
        BGC: 'BANK GIRO CREDIT',
        BP:  'BILL PAYMENT',
        CHQ: 'CHEQUE',
        SO:  'STANDING ORDER',
        TFR: 'TRANSFER',
    };
    return map[code.toUpperCase()] ?? code;
}

export function parse(cells: Cell[]): ParseResult {
    const realCells = cells.filter(c => c.rowIndex >= 0);
    if (realCells.length === 0) return { transactions: [] };

    const rowMap = new Map<number, Map<number, string>>();
    for (const cell of realCells) {
        if (!rowMap.has(cell.rowIndex)) rowMap.set(cell.rowIndex, new Map());
        rowMap.get(cell.rowIndex)!.set(cell.columnIndex, normStr(cell.content));
    }

    const rows = [...rowMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, colMap]) => ({ cells: colMap }));

    let COL_DATE = 0, COL_TYPE = 1, COL_DETAILS = 2, COL_OUT = 3, COL_IN = 4, COL_BAL = 5;
    let format: 'old' | 'new' = 'old';
    let headerFound = false;

    for (const row of rows) {
        const vals = [...row.cells.values()].map(v => v.toLowerCase());

        const isOldHeader =
            vals.includes('date') &&
            vals.some(v => v.includes('payment type')) &&
            vals.some(v => v === 'details') &&
            vals.some(v => v.includes('paid out') || v.includes('money out')) &&
            vals.some(v => v.includes('paid in') || v.includes('money in')) &&
            vals.some(v => v.startsWith('balance'));

        const isNewHeader =
            vals.includes('date') &&
            vals.some(v => v === 'description') &&
            vals.some(v => v === 'type') &&
            vals.some(v => v === 'in (£)' || v === 'in') &&
            vals.some(v => v === 'out (£)' || v === 'out') &&
            vals.some(v => v.startsWith('balance'));

        if (!isOldHeader && !isNewHeader) continue;

        format = isNewHeader ? 'new' : 'old';

        for (const [col, v] of row.cells.entries()) {
            const vl = v.toLowerCase();
            if (vl === 'date') { COL_DATE = col; continue; }
            if (format === 'old') {
                if (vl === 'payment type')        COL_TYPE    = col;
                else if (vl === 'details')         COL_DETAILS = col;
                else if (vl.includes('paid out') || vl.includes('money out'))  COL_OUT = col;
                else if (vl.includes('paid in') || vl.includes('money in'))   COL_IN  = col;
                else if (vl.startsWith('balance')) COL_BAL     = col;
            } else {
                if (vl === 'description')                              COL_DETAILS = col;
                else if (vl === 'type')                                COL_TYPE    = col;
                else if (vl === 'in (£)' || vl === 'in')              COL_IN      = col;
                else if (vl === 'out (£)' || vl === 'out')            COL_OUT     = col;
                else if (vl.startsWith('balance'))                     COL_BAL     = col;
            }
        }

        headerFound = true;
        break;
    }

    if (!headerFound) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];

    for (const row of rows) {
        const c = row.cells;
        const dateRaw = c.get(COL_DATE)    ?? '';
        const rawType = c.get(COL_TYPE)    ?? '';
        const details = c.get(COL_DETAILS) ?? '';
        const paidOut = parseMoney(c.get(COL_OUT) ?? '');
        const paidIn  = parseMoney(c.get(COL_IN)  ?? '');
        const balance = parseSignedBalance(c.get(COL_BAL) ?? '');
        const date    = parseDate(dateRaw);
        const type    = format === 'new' ? mapType(rawType) : rawType;

        if (format === 'old' && !date && transactions.length > 0 && !paidIn && !paidOut) {
            // Only treat as description continuation when type is empty — page header rows
            // (Date | Payment type | Details | …) and summary rows have non-empty type and
            // must NOT be appended to the previous transaction.
            if (!type && details) {
                transactions[transactions.length - 1].description =
                    normStr(`${transactions[transactions.length - 1].description} ${details}`);
            }
            continue;
        }

        if (!date) continue;

        const rowText = normStr(`${type} ${details}`).toUpperCase();
        if (rowText.includes('BALANCE BROUGHT FORWARD') || rowText.includes('BALANCE CARRIED FORWARD') ||
            rowText.includes('STATEMENT OPENING BALANCE') || rowText.includes('STATEMENT CLOSING BALANCE')) continue;
        if (!paidIn && !paidOut) continue;

        transactions.push({ date, type, description: details, moneyIn: paidIn, moneyOut: paidOut, balance });
    }

    // 'old' format (scanned, DD MMM YY dates) → oldest first; 'new' format (web, YYYY-MM-DD) → newest first
    return { transactions, ascending: format === 'old' };
}
