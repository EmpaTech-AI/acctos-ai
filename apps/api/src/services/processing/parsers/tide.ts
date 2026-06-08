import { Cell, ParsedTransaction, ParseResult, normStr } from './shared.js';

function parseMoney(s: string): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/[£€,\s()]/g, '');
    const n = Number(s);
    if (!isFinite(n)) return '';
    return Math.abs(n).toFixed(2);
}

function parseSignedBalance(s: string): string {
    s = normStr(s);
    if (!s) return '';
    s = s.replace(/[£€,\s()]/g, '');
    const n = Number(s);
    if (!isFinite(n)) return '';
    return n.toFixed(2);
}

function parseDate(s: string): string {
    s = normStr(s);
    // Tide format: 2 Jul 2025 / 30 Apr 2026 (4-digit year, exact)
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    if (!m) return '';
    const MONTHS: Record<string, string> = {
        jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
        jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
    };
    const day = String(Number(m[1])).padStart(2, '0');
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return '';
    return `${day}/${mon}/${m[3]}`;
}

interface PendingPartial {
    date: string;
    type: string;
    details: string;
    paidIn: string;
    paidOut: string;
    balance: string;
}

// Azure DI misreads £ as € on Tide PDFs (Tide is GBP-only).
function fixGbp(s: string): string {
    return s.replace(/€/g, '£');
}

export function parse(cells: Cell[]): ParseResult {
    // Normalise OCR artefact: € → £ for this GBP-only bank
    const rawCells = cells.map(c => ({ ...c, content: fixGbp(c.content) }));
    const realCells = rawCells.filter(c => c.rowIndex >= 0);
    if (realCells.length === 0) return { transactions: [] };

    const rowMap = new Map<number, Map<number, string>>();
    for (const cell of realCells) {
        if (!rowMap.has(cell.rowIndex)) rowMap.set(cell.rowIndex, new Map());
        rowMap.get(cell.rowIndex)!.set(cell.columnIndex, normStr(cell.content));
    }

    const rows = [...rowMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, colMap]) => ({ cells: colMap }));

    let COL_DATE = 0, COL_TYPE = 1, COL_DETAILS = 2, COL_IN = 3, COL_OUT = 4, COL_BAL = 5;
    let headerFound = false;

    for (const row of rows) {
        const vals = [...row.cells.values()].map(v => v.toLowerCase());
        const rowText = vals.join(' ');

        if (!rowText.includes('date')) continue;
        if (!rowText.includes('transaction type')) continue;
        if (!rowText.includes('details')) continue;
        if (!vals.some(v => v.includes('paid in') || v.includes('money in'))) continue;
        if (!vals.some(v => v.includes('paid out') || v.includes('money out'))) continue;
        if (!vals.some(v => v.includes('balance'))) continue;

        for (const [col, v] of row.cells.entries()) {
            const vl = v.toLowerCase();
            if (vl === 'date')                                              COL_DATE    = col;
            else if (vl === 'transaction type')                             COL_TYPE    = col;
            else if (vl === 'details')                                      COL_DETAILS = col;
            else if (vl.includes('paid in') || vl.includes('money in'))    COL_IN      = col;
            else if (vl.includes('paid out') || vl.includes('money out'))  COL_OUT     = col;
            else if (vl.includes('balance'))                                COL_BAL     = col;
        }

        headerFound = true;
        break;
    }

    if (!headerFound) return { transactions: [] };

    const transactions: ParsedTransaction[] = [];
    let lastDate = '';
    let pendingPartial: PendingPartial | null = null;

    for (const row of rows) {
        const c = row.cells;
        const dateRaw = c.get(COL_DATE)    ?? '';
        const type    = c.get(COL_TYPE)    ?? '';
        const details = c.get(COL_DETAILS) ?? '';
        const paidIn  = parseMoney(c.get(COL_IN)  ?? '');
        const paidOut = parseMoney(c.get(COL_OUT) ?? '');
        const balance = parseSignedBalance(c.get(COL_BAL) ?? '');
        const date    = parseDate(dateRaw);

        // Skip header row
        if (dateRaw.toLowerCase() === 'date' || type.toLowerCase() === 'transaction type') continue;

        if (date) lastDate = date;

        // Detail-only continuation row → append to last transaction description
        if (details && !date && !type && !paidIn && !paidOut && !balance) {
            if (transactions.length > 0 && !pendingPartial) {
                const last = transactions[transactions.length - 1];
                last.description = normStr(`${last.description} ${details}`);
            }
            continue;
        }

        // Complete a pendingPartial when balance arrives on the next row
        if (pendingPartial && !paidIn && !paidOut && (details || balance)) {
            transactions.push({
                date: date || pendingPartial.date || lastDate,
                type: pendingPartial.type || type,
                description: normStr(`${pendingPartial.details} ${details}`),
                moneyIn: pendingPartial.paidIn,
                moneyOut: pendingPartial.paidOut,
                balance: balance || pendingPartial.balance,
            });
            pendingPartial = null;
            continue;
        }

        // Row has type/money but no balance → balance arrives on next row
        if (lastDate && type && (paidIn || paidOut) && !balance) {
            pendingPartial = { date: lastDate, type, details, paidIn, paidOut, balance: '' };
            continue;
        }

        // Row has money but no type → balance may follow
        if (!type && (paidIn || paidOut)) {
            pendingPartial = { date: lastDate, type: '', details, paidIn, paidOut, balance };
            continue;
        }

        // Normal row (date may be empty — use lastDate)
        if (lastDate && (type || details) && (paidIn || paidOut)) {
            transactions.push({
                date: lastDate,
                type,
                description: details,
                moneyIn: paidIn,
                moneyOut: paidOut,
                balance,
            });
            pendingPartial = null;
        }
    }

    // Flush any trailing pending partial
    if (pendingPartial && (pendingPartial.paidIn || pendingPartial.paidOut)) {
        transactions.push({
            date: pendingPartial.date || lastDate,
            type: pendingPartial.type,
            description: pendingPartial.details,
            moneyIn: pendingPartial.paidIn,
            moneyOut: pendingPartial.paidOut,
            balance: pendingPartial.balance,
        });
    }

    return { transactions };
}
