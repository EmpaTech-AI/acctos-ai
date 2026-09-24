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
    // Select Statement format: 17Nov25
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\b/) ?? s.match(/^(\d{1,2})([A-Za-z]{3})(\d{2})$/);
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

// Transaction codes from the Select Statement legend that prefix the Activity column
const SELECT_CODES = new Set([
    'BGC', 'BP', 'CHG', 'CHQ', 'COM', 'COR', 'CPT', 'CSH', 'CSQ', 'DC', 'DD', 'DEB', 'DEP',
    'EUR', 'FEE', 'FPI', 'FPO', 'IB', 'MPI', 'MPO', 'PAY', 'SO', 'TFR',
]);

// Every money token in a cell: "12.50 230.58" → [12.5, 230.58]
function amounts(s?: string): number[] {
    return (normStr(s ?? '').match(/\d[\d,]*\.\d{2}/g) ?? []).map(x => parseFloat(x.replace(/,/g, '')));
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

/**
 * Extract Money In / Money Out / opening / closing balance from the OCR full-text
 * that Azure DI puts in the page 1 header (outside the transaction table).
 * Lloyds web-export PDFs print these as a two-column block above the table:
 *   Money In £X    Balance on DD Month YYYY £opening
 *   Money Out £Y   Balance on DD Month YYYY £closing
 */
function extractDeclaredTotals(content: string): ParseResult['statementTotals'] | undefined {
    // Limit to page 1 header: stop at the first transaction line (DD Mon YY on its own line)
    const txIdx = content.search(/\n\d{2}\s+[A-Za-z]{3}\s+\d{2}\n/);
    const header = txIdx > 0 ? content.slice(0, txIdx) : content.slice(0, 2000);

    // Extract "Balance on <date>" followed by £ amount (opening = first, closing = last)
    const balPat = /Balance\s+on\s+\d+\s+\w+\s+\d{4}[^\n£]*\n[^£\n]*£([\d,]+\.\d{2})/gi;
    const balances: number[] = [];
    const balPoundPositions = new Set<number>();
    let bm: RegExpExecArray | null;
    while ((bm = balPat.exec(header)) !== null) {
        balances.push(parseFloat(bm[1].replace(/,/g, '')));
        balPoundPositions.add(bm.index + bm[0].lastIndexOf('£'));
    }

    // All £ amounts not belonging to a "Balance on" label → Money In / Money Out
    const amtPat = /£([\d,]+\.\d{2})/g;
    const nonBalance: number[] = [];
    let am: RegExpExecArray | null;
    while ((am = amtPat.exec(header)) !== null) {
        if (!balPoundPositions.has(am.index)) {
            nonBalance.push(parseFloat(am[1].replace(/,/g, '')));
        }
    }

    if (balances.length === 0 && nonBalance.length === 0) return undefined;

    const openingBalance = balances[0];
    const closingBalance = balances.length >= 2 ? balances[balances.length - 1] : undefined;
    const moneyIn  = nonBalance[0];
    const moneyOut = nonBalance[1];

    // Validate the balance chain. If it doesn't hold, the OCR has mis-read the
    // layout (typically picking up a running balance from the table instead of the
    // true opening balance). In that case, drop opening/closing to avoid showing
    // a spurious mismatch — Money In/Out are still reliable.
    let balanceOk = false;
    if (openingBalance !== undefined && closingBalance !== undefined &&
        moneyIn !== undefined && moneyOut !== undefined) {
        balanceOk = Math.abs(openingBalance + moneyIn - moneyOut - closingBalance) < 0.02;
    }

    return {
        openingBalance: balanceOk ? openingBalance : undefined,
        closingBalance: balanceOk ? closingBalance : undefined,
        moneyIn,
        moneyOut,
    };
}

export function parse(cells: Cell[]): ParseResult {
    // Extract declared totals from the OCR context cell (page 1 header text)
    const ctxCell = cells.find(c => c.rowIndex === -1);
    const totalsFromContext = ctxCell?.content ? extractDeclaredTotals(ctxCell.content) : undefined;

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
    let format: 'old' | 'new' | 'select' = 'old';
    let headerFound = false;
    let selectOpen: number | undefined;

    for (const row of rows) {
        const vals = [...row.cells.values()].map(v => v.toLowerCase());

        // Business "Select Statement": Date | Activity | Paid out | Paid in | "Sheet: N Of M ... Balance X".
        // The date header can carry the brought-forward date ("Date 17Nov25"); the balance header
        // carries the brought-forward balance, which on the first sheet is the opening balance.
        if (vals.some(v => /^date\b/.test(v)) && vals.includes('activity') &&
            vals.some(v => v.includes('paid out')) && vals.some(v => v.includes('paid in'))) {
            format = 'select';
            COL_TYPE = -1;
            for (const [col, v] of row.cells.entries()) {
                const vl = v.toLowerCase();
                if (/^date\b/.test(vl))           COL_DATE    = col;
                else if (vl === 'activity')       COL_DETAILS = col;
                else if (vl.includes('paid out')) COL_OUT     = col;
                else if (vl.includes('paid in'))  COL_IN      = col;
                else if (vl.includes('balance')) {
                    COL_BAL = col;
                    const b = vl.match(/balance\s+(-?[\d,]+\.\d{2})/);
                    if (b) selectOpen = parseFloat(b[1].replace(/,/g, ''));
                }
            }
            headerFound = true;
            break;
        }

        const isOldHeader =
            vals.includes('date') &&
            vals.some(v => v.includes('payment type') || v.includes('pmnt type')) &&
            vals.some(v => v === 'details') &&
            vals.some(v => v.includes('paid out') || v.includes('money out')) &&
            vals.some(v => v.includes('paid in') || v.includes('money in')) &&
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
                if (vl === 'payment type' || vl === 'pmnt type')              COL_TYPE    = col;
                else if (vl === 'details')                                     COL_DETAILS = col;
                else if (vl.includes('paid out') || vl.includes('money out')) COL_OUT     = col;
                else if (vl.includes('paid in')  || vl.includes('money in'))  COL_IN      = col;
                else if (vl.startsWith('balance'))                             COL_BAL     = col;
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
    let declaredOpen:     number | undefined;
    let declaredClose:    number | undefined;
    let declaredMoneyIn:  number | undefined;
    let declaredMoneyOut: number | undefined;

    let sheetIn = 0, sheetOut = 0, sheetFooters = 0;

    for (const row of rows) {
        const c = row.cells;
        const dateRaw    = c.get(COL_DATE)    ?? '';
        const rawType    = c.get(COL_TYPE)    ?? '';
        let   details    = c.get(COL_DETAILS) ?? '';
        let   paidOut    = parseMoney(c.get(COL_OUT) ?? '');
        let   paidIn     = parseMoney(c.get(COL_IN)  ?? '');
        const balance    = parseBalance(c.get(COL_BAL) ?? '');
        const date       = parseDate(dateRaw);
        let   type       = format === 'new' ? mapType(rawType) : rawType;

        if (format === 'select') {
            // The header repeats on every sheet
            if (details.toLowerCase() === 'activity') continue;
            // Every sheet ends with "TOTAL PAYMENTS/RECEIPTS: <paid out> <paid in>". Azure DI either
            // gives it a row of its own or merges it into the sheet's last transaction, whose amount
            // then comes first in its column ("12.50 230.58"). The footers add up to the statement totals.
            const footerAt = details.toUpperCase().indexOf('TOTAL PAYMENTS/RECEIPTS');
            if (footerAt >= 0) {
                const outs = amounts(c.get(COL_OUT)), ins = amounts(c.get(COL_IN));
                sheetOut += outs[outs.length - 1] ?? 0;
                sheetIn  += ins[ins.length - 1]  ?? 0;
                sheetFooters++;
                details = normStr(details.slice(0, footerAt));
                paidOut = outs.length > 1 ? outs[0].toFixed(2) : '';
                paidIn  = ins.length  > 1 ? ins[0].toFixed(2)  : '';
            }
            // Activity starts with the transaction code: "DEB HORIZON PARKING LT CD 1242"
            const code = details.match(/^([A-Z]{2,3})\s+(.+)$/);
            if (date && code && SELECT_CODES.has(code[1])) { type = code[1]; details = code[2]; }
            // Brought-forward row: a date and a balance, nothing else
            if (date && !details && !paidIn && !paidOut && balance && selectOpen === undefined) selectOpen = parseFloat(balance);
        }

        // Continuation row: no date, no amounts — append to previous
        if ((format === 'old' || format === 'select') && !date && transactions.length > 0 && !paidIn && !paidOut) {
            const last = transactions[transactions.length - 1];
            if (type)    last.type        = normStr(`${last.type} ${type}`);
            if (details) last.description = normStr(`${last.description} ${details}`);
            continue;
        }

        if (!date) continue;

        const rowText = normStr(`${type} ${details}`).toUpperCase();
        if (rowText.includes('STATEMENT OPENING BALANCE') || rowText.includes('BALANCE BROUGHT FORWARD')) {
            if (balance) declaredOpen = parseFloat(balance);
            continue;
        }
        if (rowText.includes('STATEMENT CLOSING BALANCE') || rowText.includes('BALANCE CARRIED FORWARD')) {
            if (balance) declaredClose = parseFloat(balance);
            // Closing row carries cumulative totals in the paid-in/out columns
            if (paidIn)  declaredMoneyIn  = parseFloat(paidIn);
            if (paidOut) declaredMoneyOut = parseFloat(paidOut);
            continue;
        }
        if (!paidIn && !paidOut) continue;

        transactions.push({ date, type, description: details, moneyIn: paidIn, moneyOut: paidOut, balance });
    }

    // Table-based detection (old scanned format with "Balance brought/carried forward" rows)
    // takes precedence; context extraction covers the new web-export format.
    const lastBalance = transactions.length ? parseFloat(transactions[transactions.length - 1].balance) : NaN;
    const statementTotals: ParseResult['statementTotals'] =
        format === 'select' && sheetFooters > 0
            ? {
                openingBalance: selectOpen,
                closingBalance: isFinite(lastBalance) ? lastBalance : undefined,
                moneyIn:        Math.round(sheetIn  * 100) / 100,
                moneyOut:       Math.round(sheetOut * 100) / 100,
              }
        : (declaredOpen !== undefined || declaredClose !== undefined || declaredMoneyIn !== undefined || declaredMoneyOut !== undefined)
            ? {
                openingBalance: declaredOpen,
                closingBalance: declaredClose,
                moneyIn:        declaredMoneyIn,
                moneyOut:       declaredMoneyOut,
              }
            : totalsFromContext;

    // Lloyds web format PDFs are oldest-first (earliest date at top of statement)
    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}
