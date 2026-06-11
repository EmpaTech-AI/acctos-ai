export interface Cell {
    rowIndex: number;
    columnIndex: number;
    content: string;
}

export interface ParsedTransaction {
    date: string;        // DD/MM/YYYY
    type: string;
    description: string;
    moneyIn: string;
    moneyOut: string;
    balance: string;
}

export interface ParseResult {
    transactions: ParsedTransaction[];
    pendingRow?: ParsedTransaction | null;
    /** Totals declared by the bank in the document itself (e.g. Pockit summary rows, HSBC summary section). */
    statementTotals?: { moneyIn: number; moneyOut: number; openingBalance?: number; closingBalance?: number };
    /** true = oldest transaction first (e.g. Mettle PDF). false/undefined = newest first (default). */
    ascending?: boolean;
}

export const TRANSACTION_CODES = [
    'DD','DR','BP','CR','VIS',')))',
    'ATM','BACS','BACST','CHAPS','CHQC','CHQR','CHQ',
    'CNP','CPT','CDM','CASH','DEP','DP','ERR','FEE',
    'FP','FT','FX','INT','INTL','IBAN','MC','MISC',
    'MOB','ONL','OVR','OD','POS','PIM','REV','REFUND',
    'RTP','SEPA','SO','SWIFT','MT103','TFR','TFR FX',
    'TRF','VISA','WDL','OBP',
].sort((a, b) => b.length - a.length);

export function normStr(x: unknown): string {
    if (x === null || x === undefined) return '';
    let s = String(x);
    if (s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return '';
    s = s.normalize('NFC').replace(/\s+/g, ' ').trim();
    s = s.replace(/^'+/, '');
    return s;
}

export function parseMoney(s: string): number | null {
    s = normStr(s);
    if (!s) return null;
    // Strip currency symbol
    s = s.replace(/[£$€]/g, '').trim();
    // Handle OD/DR debit suffix
    const isDebit = /\b(DR|OD)\b/i.test(s);
    s = s.replace(/\b(DR|OD)\b/gi, '').trim();
    // EU format: 1.234,56 → 1234.56
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    if (hasDot && hasComma) {
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
        else s = s.replace(/,/g, '');
    } else if (hasComma && !hasDot) {
        const after = s.length - s.lastIndexOf(',') - 1;
        if (after === 2) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    }
    s = s.replace(/[^\d.\-]/g, '');
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return isDebit ? -Math.abs(n) : n;
}

export function formatMoney(n: number | null): string {
    if (n === null || n === undefined) return '';
    return Math.abs(n).toFixed(2);
}

/** Like parseMoney but preserves the sign — use for balance columns, not In/Out amounts. */
export function balanceStr(s: string): string {
    const n = parseMoney(s);
    return n !== null ? n.toFixed(2) : '';
}

const MONTH_MAP: Record<string, number> = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
    jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
};

export function parseDateToDDMMYYYY(s: string, fallbackYear?: number): string {
    s = normStr(s);
    if (!s) return '';
    // Fix OCR space artefact: "14/11 /2025" → "14/11/2025"
    s = s.replace(/\s*([\\/.\-])\s*/g, '$1');

    // "01 Jul 2025" or "01 Jul" or "01 JULY 2025" or "1 January 2025"
    let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?$/);
    if (m) {
        const day = Number(m[1]);
        const monStr = m[2].slice(0, 3).toLowerCase();
        const year = Number(m[3] || fallbackYear || 2000);
        const mon = MONTH_MAP[monStr];
        if (!mon || day < 1 || day > 31 || !year) return '';
        return `${String(day).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${year}`;
    }

    // "22 Jul 24" (2-digit year)
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})$/);
    if (m) {
        const day = Number(m[1]);
        const monStr = m[2].toLowerCase();
        let year = Number(m[3]);
        year = year <= 69 ? 2000 + year : 1900 + year;
        const mon = MONTH_MAP[monStr];
        if (!mon || day < 1 || day > 31) return '';
        return `${String(day).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${year}`;
    }

    // "DD/MM/YYYY" or "DD-MM-YYYY" or "DD.MM.YYYY"
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) {
        let d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
        if (y < 100) y = y <= 69 ? 2000 + y : 1900 + y;
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
        return `${String(d).padStart(2,'0')}/${String(mo).padStart(2,'0')}/${y}`;
    }

    return '';
}

/** Convert Excel serial date (base: 1899-12-30) to DD/MM/YYYY */
export function excelSerialToDate(serial: number): string {
    if (!serial || serial < 20000 || serial > 60000) return '';
    const base = new Date(1899, 11, 30); // Dec 30 1899
    const date = new Date(base.getTime() + serial * 86400000);
    const d = String(date.getDate()).padStart(2, '0');
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    return `${d}/${mo}/${date.getFullYear()}`;
}

/** Scan all cell text for 4-digit years (2020-2099), return sorted unique list. */
export function extractYearsFromCells(cells: Cell[]): number[] {
    const found = new Set<number>();
    for (const c of cells) {
        for (const m of c.content.matchAll(/\b(20[2-9]\d)\b/g)) {
            found.add(Number(m[1]));
        }
    }
    return [...found].sort();
}

export interface StatementPeriod {
    start: Date;
    end: Date;
}

function parsePeriodDate(s: string): Date | null {
    const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const monStr = m[2].slice(0, 3).toLowerCase();
    const year = Number(m[3]);
    const mon = MONTH_MAP[monStr];
    if (!mon || day < 1 || day > 31) return null;
    return new Date(year, mon - 1, day);
}

/** Scan all cells for a date-range like "06 Dec 2025 - 05 Jan 2026".
 *  Returns parsed start/end or null if not found. */
export function extractStatementPeriod(cells: Cell[]): StatementPeriod | null {
    const periodRegex = /(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})\s*[-–]\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/;
    for (const c of cells) {
        const m = c.content.match(periodRegex);
        if (m) {
            const start = parsePeriodDate(m[1]);
            const end = parsePeriodDate(m[2]);
            if (start && end) return { start, end };
        }
    }
    return null;
}

/** Given day + month (1–12), return the year that places the date within the
 *  period bounds. Returns null if neither year in the period produces a match. */
export function inferYearFromPeriod(day: number, month: number, period: StatementPeriod): number | null {
    const years = new Set([period.start.getFullYear(), period.end.getFullYear()]);
    for (const year of years) {
        const candidate = new Date(year, month - 1, day);
        if (candidate >= period.start && candidate <= period.end) {
            return year;
        }
    }
    return null;
}

/** Build a row→col→content grid from cell array */
export function buildGrid(cells: Cell[]): Map<number, Map<number, string>> {
    const grid = new Map<number, Map<number, string>>();
    for (const c of cells) {
        if (!grid.has(c.rowIndex)) grid.set(c.rowIndex, new Map());
        grid.get(c.rowIndex)!.set(c.columnIndex, normStr(c.content));
    }
    return grid;
}

export function getCell(grid: Map<number, Map<number, string>>, r: number, c: number): string {
    return grid.get(r)?.get(c) ?? '';
}

export function maxRow(cells: Cell[]): number {
    return cells.reduce((m, c) => Math.max(m, c.rowIndex), 0);
}

export function maxCol(cells: Cell[]): number {
    return cells.reduce((m, c) => Math.max(m, c.columnIndex), 0);
}

/** Format transactions into the object format the OpenAI Assistant expects */
export function formatTransactionsForAssistant(transactions: ParsedTransaction[]): object[] {
    return transactions.map(t => ({
        'Date': t.date,
        'Description': `${t.type || ''} ${t.description || ''}`.trim() || '',
        'Money in': t.moneyIn || '',
        'Money out': t.moneyOut || '',
        'Balance': t.balance || '',
    }));
}
