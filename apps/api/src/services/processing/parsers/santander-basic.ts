import type { Cell, ParseResult, ParsedTransaction as Transaction } from './shared.js';

const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface Row {
    rowIndex: number;
    cells: string[];
}

interface ColLayout {
    date: number;
    desc: number;
    moneyIn: number;
    moneyOut: number;
    balance: number;
    amount: number; // single combined amount column
}

interface DateParts {
    day: number;
    month: number;
    year: number | null;
    explicitYear: boolean;
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function normalizeSpace(s: unknown): string {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeAmount(val: unknown): string {
    if (val === null || val === undefined) return '';
    const raw = String(val).replace(/£/g, '').trim();
    if (/[A-Z]{3}\b/i.test(raw) || raw.includes('/')) return '';
    const s = raw.replace(/\s+/g, '');
    if (!/^-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?$|^-?\d+(?:\.\d{2})?$/.test(s)) return '';
    return s;
}

function amountToNumber(val: unknown): number | null {
    const s = normalizeAmount(val);
    if (!s) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : null;
}

function balanceToNumber(val: unknown): number | null {
    const s = normalizeAmount(val);
    if (!s) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function numberToAmountString(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '';
    return Math.abs(n).toFixed(2);
}

function balanceToString(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '';
    return n.toFixed(2);
}

function extractDateParts(val: string): DateParts | null {
    if (!val) return null;
    const s = normalizeSpace(val);

    let m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (m) return { day: +m[1], month: +m[2], year: +m[3], explicitYear: true };

    m = s.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
    if (m) return { day: +m[1], month: +m[2], year: +m[3], explicitYear: true };

    m = s.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?\b/i);
    if (m) return {
        day: +m[1],
        month: MONTHS[m[2].slice(0, 3).toLowerCase()],
        year: m[3] ? +m[3] : null,
        explicitYear: !!m[3],
    };

    return null;
}

function isHeaderRow(row: Row): boolean {
    const txt = row.cells.join(' ').toLowerCase();
    return txt.includes('date') && txt.includes('description') && txt.includes('balance') &&
        (txt.includes('money in') || txt.includes('money out') || txt.includes('credit') || txt.includes('debit'));
}

function isStatementBalanceRow(desc: string): boolean {
    const d = normalizeSpace(desc).toLowerCase();
    return d.includes('previous statement balance') || d.includes('current statement balance') ||
        d.includes('balance brought forward') || d.includes('balance carried forward');
}

function looksLikeMoneyIn(desc: string): boolean {
    const d = String(desc ?? '').toLowerCase();
    return d.includes('reversal') || d.includes('receipt') || d.includes('received') ||
        d.includes('credit') || d.includes('incoming') || d.includes('faster payments receipt') ||
        d.includes('salary') || d.includes('payment from') || d.includes('transfer from') ||
        d.includes('bank giro credit') || d.includes('credit from');
}

function cleanDescription(desc: string): string {
    let s = String(desc ?? '');
    s = s.replace(/NON-STERLING TRANSACTION FEE\s*\d+[,.]\d{2}/gi, '');
    s = s.replace(/\s*,?\s*RATE\s*/gi, ' ');
    s = s.replace(/\b99\.999,99\/GBP,?\b/gi, '');
    return normalizeSpace(s);
}

function extractEmbeddedAmount(desc: string): number | null {
    if (!desc) return null;
    const m = String(desc).match(/£\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
    return m ? amountToNumber(m[1]) : null;
}

function extractTrailingAmount(desc: string): number | null {
    if (!desc) return null;
    const m = String(desc).match(/(?:^|\s)(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})(?=\s*[A-Z]{2,}|$)/);
    return m ? amountToNumber(m[1]) : null;
}

function removeTrailingAmount(desc: string): string {
    return normalizeSpace(String(desc ?? '').replace(/\s(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})$/, ''));
}

function removeTrailingAmountFromDescription(desc: string): string {
    return normalizeSpace(
        String(desc ?? '').replace(/(?:^|\s)\d{1,3}(?:,\d{3})*(?:\.\d{2})(?=\s*[A-Z]{2,}|$)/, '')
    );
}

function isAmountOnlyText(val: string): boolean {
    return /^£?\s*-?\d[\d,]*\.?\d{0,2}$/.test(normalizeSpace(val));
}

function buildGrid(cells: Cell[]): Row[] {
    const rowMap = new Map<number, Record<number, string>>();
    for (const c of cells) {
        if (c.rowIndex < 0) continue;
        if (!rowMap.has(c.rowIndex)) rowMap.set(c.rowIndex, {});
        const row = rowMap.get(c.rowIndex)!;
        row[c.columnIndex] = row[c.columnIndex]
            ? `${row[c.columnIndex]} ${c.content}`.trim()
            : c.content;
    }
    return [...rowMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([rowIndex, cols]) => {
            const maxCol = Math.max(0, ...Object.keys(cols).map(Number));
            const arr: string[] = [];
            for (let i = 0; i <= maxCol; i++) arr.push(normalizeSpace(cols[i] ?? ''));
            return { rowIndex, cells: arr };
        })
        .filter(r => r.cells.some(c => c));
}

function detectColumns(headerRow: Row | null): ColLayout {
    const hdr = headerRow?.cells ?? [];
    const COL: ColLayout = { date: -1, desc: -1, moneyIn: -1, moneyOut: -1, balance: -1, amount: -1 };

    for (let c = 0; c < hdr.length; c++) {
        const val = normalizeSpace(hdr[c]).toLowerCase();
        if (val.includes('date')) COL.date = c;
        if (val.includes('description')) COL.desc = c;
        if (val.includes('money in') || val.includes('credit')) COL.moneyIn = c;
        if (val.includes('money out') || val.includes('debit')) COL.moneyOut = c;
        if (val.includes('balance')) COL.balance = c;
    }

    // Merged "Description Money in" at col 1 → treat as single amount col
    if (COL.date === 0 && COL.desc === 1 && COL.moneyIn === 1 && COL.moneyOut === 2 && COL.balance === 3) {
        COL.moneyIn = -1;
        COL.moneyOut = -1;
        COL.amount = 2;
    }

    // Only money-out detected (no money-in) → single amount col
    if (COL.amount === -1 && COL.moneyIn === -1 && COL.moneyOut >= 0 && COL.balance >= 0) {
        COL.amount = COL.moneyOut;
        COL.moneyOut = -1;
    }

    if (COL.date === -1) COL.date = 0;
    if (COL.desc === -1) COL.desc = 1;
    if (COL.balance === -1 && hdr.length >= 4) COL.balance = 3;
    if (COL.amount === -1 && COL.moneyIn === -1 && COL.moneyOut === -1 && hdr.length >= 3) COL.amount = 2;

    return COL;
}

function extractDefaultYear(cells: Cell[]): number {
    const text = cells.map(c => c.content).join(' ');
    const m = text.match(/Your\s+account\s+summary\s+for\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+((?:19|20)\d{2})/i);
    if (m) return +m[1];
    const years = [...text.matchAll(/\b(20\d{2})\b/g)].map(x => +x[1]).filter(y => y >= 2000 && y <= 2100);
    return years.length ? Math.min(...years) : new Date().getFullYear();
}

function assignYears(rows: Row[], defaultYear: number): Map<Row, number> {
    const yearMap = new Map<Row, number>();
    let currentYear = defaultYear;
    let prevMonth: number | null = null;

    for (const r of rows) {
        if (isHeaderRow(r)) continue;
        const parts = extractDateParts(r.cells[0] ?? '');
        if (!parts) continue;

        if (parts.explicitYear && parts.year) {
            currentYear = parts.year;
        } else if (prevMonth !== null) {
            if (prevMonth === 12 && parts.month === 1) currentYear += 1;
            else if (prevMonth === 1 && parts.month === 12) currentYear -= 1;
        }

        yearMap.set(r, currentYear);
        prevMonth = parts.month;
    }

    return yearMap;
}

function detectDirection(
    rows: Row[],
    COL: ColLayout,
    yearMap: Map<Row, number>,
    defaultYear: number,
): 'newest_first' | 'oldest_first' {
    const dated: number[] = [];
    for (const r of rows) {
        if (isHeaderRow(r)) continue;
        const dateCell = COL.date >= 0 ? r.cells[COL.date] ?? '' : '';
        const parts = extractDateParts(dateCell);
        if (!parts) continue;
        const year = (parts.explicitYear && parts.year) ? parts.year : (yearMap.get(r) ?? defaultYear);
        dated.push(year * 10000 + parts.month * 100 + parts.day);
    }
    if (dated.length < 2) return 'newest_first';
    return dated[0] > dated[dated.length - 1] ? 'newest_first' : 'oldest_first';
}

function classifyAmount(
    amount: number | null,
    balance: number | null,
    prevBalance: number | null,
    desc: string,
    direction: 'newest_first' | 'oldest_first',
): { moneyIn: string; moneyOut: string } {
    if (amount === null) return { moneyIn: '', moneyOut: '' };

    if (prevBalance !== null && balance !== null) {
        const expectedIn  = +(prevBalance + amount).toFixed(2);
        const expectedOut = +(prevBalance - amount).toFixed(2);
        const actual      = +balance.toFixed(2);

        if (direction === 'oldest_first') {
            if (Math.abs(actual - expectedIn)  < 0.02) return { moneyIn: numberToAmountString(amount), moneyOut: '' };
            if (Math.abs(actual - expectedOut) < 0.02) return { moneyIn: '', moneyOut: numberToAmountString(amount) };
        } else {
            if (Math.abs(actual - expectedIn)  < 0.02) return { moneyIn: '', moneyOut: numberToAmountString(amount) };
            if (Math.abs(actual - expectedOut) < 0.02) return { moneyIn: numberToAmountString(amount), moneyOut: '' };
        }
    }

    return looksLikeMoneyIn(desc)
        ? { moneyIn: numberToAmountString(amount), moneyOut: '' }
        : { moneyIn: '', moneyOut: numberToAmountString(amount) };
}

function buildDescriptionFromRow(row: Row, COL: ColLayout): string {
    const parts: string[] = [];
    for (let c = 0; c < row.cells.length; c++) {
        if (c === COL.date) continue;
        const val = row.cells[c];
        if (!val) continue;
        const isMoneyCol =
            [COL.moneyIn, COL.moneyOut, COL.amount, COL.balance].includes(c) &&
            amountToNumber(val) !== null;
        if (!isMoneyCol) parts.push(val);
    }
    return normalizeSpace(parts.join(' '));
}

function extractDeclaredTotals(rows: Row[]): {
    openingBalance?: number;
    closingBalance?: number;
    moneyIn?: number;
    moneyOut?: number;
} {
    const result: { openingBalance?: number; closingBalance?: number; moneyIn?: number; moneyOut?: number } = {};
    for (const r of rows) {
        if (isHeaderRow(r)) break; // stop at the transaction table
        const joined = r.cells.join(' ');
        const lo = joined.toLowerCase();
        // Pick the last cell that parses as an amount (the value column)
        const lastAmt = () => {
            for (let i = r.cells.length - 1; i >= 0; i--) {
                const n = balanceToNumber(r.cells[i]);
                if (n !== null) return n;
            }
            return null;
        };
        if (lo.includes('balance brought forward') || lo.includes('brought forward balance') || lo.includes('balance carried forward')) {
            const n = lastAmt();
            if (n !== null) result.openingBalance = n;
        } else if (/total\s+(?:money\s+in|credits?)/i.test(joined)) {
            const n = lastAmt();
            if (n !== null) result.moneyIn = Math.abs(n);
        } else if (/total\s+(?:money\s+out|debits?)/i.test(joined)) {
            const n = lastAmt();
            if (n !== null) result.moneyOut = Math.abs(n);
        } else if (/balance\s+at\s+close\s+of\s+business/i.test(joined)) {
            const n = lastAmt();
            if (n !== null) result.closingBalance = n;
        }
    }
    return result;
}

export function parse(cells: Cell[]): ParseResult {
    const defaultYear = extractDefaultYear(cells);
    const rows = buildGrid(cells);
    const yearMap = assignYears(rows, defaultYear);

    // Detect direction once with initial column layout
    const initialCOL = detectColumns(rows.find(isHeaderRow) ?? null);
    const globalDirection = detectDirection(rows, initialCOL, yearMap, defaultYear);

    const transactions: Transaction[] = [];
    let currentHeader: Row | null = null;
    let COL = initialCOL;
    let direction = globalDirection;
    let prevBalance: number | null = null;
    let current: Transaction | null = null;

    function flush() {
        if (!current) return;
        let desc = cleanDescription(current.description ?? '');
        desc = removeTrailingAmountFromDescription(desc);
        current.description = desc || (current.description ?? '');
        const hasMoney = normalizeSpace(current.moneyIn) || normalizeSpace(current.moneyOut);
        if (!hasMoney || isStatementBalanceRow(current.description ?? '')) { current = null; return; }
        transactions.push(current);
        const b = balanceToNumber(current.balance);
        if (b !== null) prevBalance = b;
        current = null;
    }

    for (const r of rows) {
        if (isHeaderRow(r)) {
            flush();
            currentHeader = r;
            COL = detectColumns(currentHeader);
            direction = detectDirection(rows, COL, yearMap, defaultYear);
            continue;
        }

        if (!currentHeader) continue; // skip rows before first transaction table header

        const dateCell  = COL.date >= 0 ? r.cells[COL.date] ?? '' : '';
        const dateParts = extractDateParts(dateCell);
        const descCell  = buildDescriptionFromRow(r, COL);

        const moneyInVal  = COL.moneyIn  >= 0 ? amountToNumber(r.cells[COL.moneyIn])  : null;
        const moneyOutVal = COL.moneyOut >= 0 ? amountToNumber(r.cells[COL.moneyOut]) : null;
        let   amountVal   = COL.amount   >= 0 ? amountToNumber(r.cells[COL.amount])   : null;
        const balanceVal  = COL.balance  >= 0 ? balanceToNumber(r.cells[COL.balance]) : null;

        if (amountVal === null) {
            amountVal = extractEmbeddedAmount(descCell) ?? extractTrailingAmount(descCell);
        }

        const balance = balanceVal !== null ? balanceToString(balanceVal) : '';

        if (dateParts) {
            flush();

            const finalYear = (dateParts.explicitYear && dateParts.year)
                ? dateParts.year
                : (yearMap.get(r) ?? defaultYear);

            const date = `${pad2(dateParts.day)}/${pad2(dateParts.month)}/${finalYear}`;
            const trailingDescAmount = extractTrailingAmount(descCell);
            const descIsAmountOnly   = isAmountOnlyText(descCell);

            let moneyIn = '';
            let moneyOut = '';

            if (descIsAmountOnly && moneyInVal === null && moneyOutVal === null && balanceVal !== null) {
                moneyIn = numberToAmountString(amountToNumber(descCell));
            } else if (moneyInVal !== null || moneyOutVal !== null) {
                moneyIn  = moneyInVal  !== null ? numberToAmountString(moneyInVal)  : '';
                moneyOut = moneyOutVal !== null ? numberToAmountString(moneyOutVal) : '';
            } else if (trailingDescAmount !== null && looksLikeMoneyIn(descCell)) {
                moneyIn = numberToAmountString(trailingDescAmount);
            } else {
                const cls = classifyAmount(amountVal, balanceVal, prevBalance, descCell, direction);
                moneyIn  = cls.moneyIn;
                moneyOut = cls.moneyOut;
            }

            current = {
                date,
                type: '',
                description: descIsAmountOnly ? '' : removeTrailingAmount(descCell),
                moneyIn,
                moneyOut,
                balance,
            };

            continue;
        }

        if (current) {
            const extraParts: string[] = [];
            for (let c = 0; c < r.cells.length; c++) {
                const val = r.cells[c];
                if (!val) continue;
                const isMoneyCol =
                    [COL.moneyIn, COL.moneyOut, COL.amount, COL.balance].includes(c) &&
                    amountToNumber(val) !== null;
                if (!isMoneyCol) extraParts.push(val);
            }
            const extraDesc = normalizeSpace(extraParts.join(' '));
            if (extraDesc) current.description = normalizeSpace(`${current.description} ${extraDesc}`);

            const extraBalance = COL.balance >= 0 ? balanceToNumber(r.cells[COL.balance]) : null;
            if (!current.balance && extraBalance !== null) {
                current.balance = balanceToString(extraBalance);
            }
        }
    }

    flush();
    const declared = extractDeclaredTotals(rows);
    const statementTotals =
        declared.moneyIn !== undefined || declared.moneyOut !== undefined ||
        declared.openingBalance !== undefined || declared.closingBalance !== undefined
            ? {
                moneyIn:        declared.moneyIn        ?? 0,
                moneyOut:       declared.moneyOut       ?? 0,
                openingBalance: declared.openingBalance,
                closingBalance: declared.closingBalance,
              }
            : undefined;
    return { transactions, statementTotals, ascending: true };
}
