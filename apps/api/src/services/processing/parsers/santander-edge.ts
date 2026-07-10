// Santander Edge Up parser — port of Make.com module 1503.
// Handles 4–7 column layouts, ordinal dates (1st Jan 2024), and forward-
// chronological year tracking.
import {
    Cell, ParsedTransaction, ParseResult,
    buildGrid, maxRow, normStr,
} from './shared.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function extractDateParts(val: string): { day: number; month: number; year: number | null; explicitYear: boolean } | null {
    const s = normStr(val);
    if (!s) return null;

    // DD/MM/YYYY
    let m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (m) {
        const day = +m[1], month = +m[2], year = +m[3];
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { day, month, year, explicitYear: true };
    }

    // DD-MM-YYYY
    m = s.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
    if (m) {
        const day = +m[1], month = +m[2], year = +m[3];
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { day, month, year, explicitYear: true };
    }

    // Ordinal: "1st January 2024", "15 Feb 2025", "3rd March"
    m = s.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{4}))?\b/i);
    if (m) {
        const day = +m[1];
        const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
        const year = m[3] ? +m[3] : null;
        if (day >= 1 && day <= 31 && month) return { day, month, year, explicitYear: !!m[3] };
    }

    return null;
}

function isAmount(val: string): boolean {
    if (!val) return false;
    const s = val.replace(/£/g, '').trim();
    if (!/[.,]/.test(s)) return false;
    return /^-?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?\d+(\.\d{1,2})?$/.test(s);
}

function normalizeAmount(val: string): string {
    if (!val) return '';
    const m = val.replace(/£/g, '').match(/-?\d[\d,]*\.?\d{0,2}/);
    return m ? m[0].replace(/,/g, '').trim() : '';
}

function amountToNumber(val: string): number | null {
    const s = normalizeAmount(val);
    if (!s) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function numberToAmountString(n: number): string {
    if (!Number.isFinite(n)) return '';
    return Math.abs(n).toFixed(2);
}

function looksLikeMoneyIn(desc: string): boolean {
    if (!desc) return false;
    const d = desc.toLowerCase();
    if (d.includes('transfer to')) return false;
    return (
        d.includes('refund') ||
        d.includes('receipt') ||
        d.includes('received') ||
        d.includes('credit') ||
        d.includes('incoming') ||
        d.includes('salary') ||
        d.includes('payment from') ||
        d.includes('transfer from') ||
        (/^transfer\b/i.test(d) && !d.includes('to')) ||
        d.includes('interest paid') ||
        d.includes('cashback') ||
        d.includes('cheque paid in') ||
        d.includes('paid in') ||
        /direct debit payments?.*cashback/i.test(d)
    );
}

function isSkipRow(desc: string): boolean {
    const d = desc.toLowerCase();
    return (
        d.includes('previous statement balance') ||
        d.includes('current statement balance') ||
        d.includes('balance carried forward') ||
        d.includes('balance brought forward') ||
        d.includes('closing balance') ||
        d.includes('opening balance') ||
        d.includes('average credit balance') ||
        d.includes('average balance')
    );
}

function extractLastAmount(text: string): string {
    const nums = normStr(text).match(/\d[\d,]*\.\d{2}/g);
    return nums?.length ? nums[nums.length - 1] : '';
}

function cleanEmbeddedAmount(desc: string, amount: string): string {
    if (!amount) return desc;
    const escaped = amount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return normStr(desc.replace(new RegExp(`\\s+${escaped}\\s*$`), ''));
}

// Extract year from the first date with an explicit year in document text.
// Mirrors Make.com module 1498: \d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+((?:19|20)\d{2})
function extractYearFromContent(cells: Cell[]): number | null {
    const text = cells.map(c => c.content).join(' ');
    const m = text.match(/\d{1,2}\s*(?:st|nd|rd|th)?\s+[A-Za-z]+\s+((?:19|20)\d{2})/);
    return m ? +m[1] : null;
}

function appendUnique(base: string, extra: string): string {
    base = normStr(base); extra = normStr(extra);
    if (!extra || base.endsWith(extra)) return base;
    return normStr(`${base} ${extra}`);
}

// ── Layout detection ──────────────────────────────────────────────────────────

interface Layout {
    typeCol: number | null;
    descCol: number;
    moneyInCol: number | null;
    altMoneyInCol?: number;
    moneyOutCol: number;
    balanceCol: number;
    embeddedMoneyIn: boolean;
}

type RowMap = Map<number, string>;

function isTransactionHeader(r: RowMap): boolean {
    const cells: string[] = [];
    for (let c = 0; c <= 6; c++) cells[c] = normStr(r.get(c) ?? '').toLowerCase();
    const joined = cells.join(' ');
    return joined.includes('date') && joined.includes('description') &&
           joined.includes('money') && joined.includes('balance');
}

function detectLayout(rowMaps: RowMap[]): { layout: Layout; headerIdx: number } | null {
    for (let i = 0; i < rowMaps.length; i++) {
        const r = rowMaps[i];
        const cells: string[] = [];
        for (let c = 0; c <= 6; c++) cells[c] = normStr(r.get(c) ?? '').toLowerCase();
        const joined = cells.join(' ');

        if (!joined.includes('date') || !joined.includes('description') ||
            !joined.includes('money') || !joined.includes('balance')) continue;

        // 6-col: Date | Type | Desc | MoneyIn | MoneyOut | Balance
        if (cells[2].includes('description') && cells[3].includes('money in') &&
            cells[4].includes('money out') && cells[5].includes('balance')) {
            return { layout: { typeCol: 1, descCol: 2, moneyInCol: 3, moneyOutCol: 4, balanceCol: 5, embeddedMoneyIn: false }, headerIdx: i };
        }

        // 7-col: Date | Type | Desc | MoneyIn | AltIn | MoneyOut | Balance
        if (cells[2].includes('description') && cells[3].includes('money in') &&
            cells[5].includes('money out') && cells[6].includes('balance')) {
            return { layout: { typeCol: 1, descCol: 2, moneyInCol: 3, altMoneyInCol: 4, moneyOutCol: 5, balanceCol: 6, embeddedMoneyIn: false }, headerIdx: i };
        }

        // 5-col embedded: Date | Type | Desc+MoneyIn | MoneyOut | Balance
        if (cells[2].includes('description') && cells[3].includes('money out') && cells[4].includes('balance')) {
            return { layout: { typeCol: 1, descCol: 2, moneyInCol: null, moneyOutCol: 3, balanceCol: 4, embeddedMoneyIn: true }, headerIdx: i };
        }

        // OCR quirk: header has desc at c1, but data rows have type at c1 and desc at c2
        if (cells[1].includes('description') && cells[3].includes('money in') &&
            cells[4].includes('money out') && cells[5].includes('balance')) {
            return { layout: { typeCol: 1, descCol: 2, moneyInCol: 3, moneyOutCol: 4, balanceCol: 5, embeddedMoneyIn: false }, headerIdx: i };
        }

        // Azure DI merged header variant: c1="Description Money in", c2 missing, c3="Money out", c4="Balance"
        // Data rows: c0=Date, c1=TypeCode_or_Desc+embedded_in, c2=Desc_if_type_at_c1, c3=MoneyOut, c4=Balance
        if (cells[1].includes('description') && cells[1].includes('money in') &&
            cells[3].includes('money out') && cells[4].includes('balance')) {
            return { layout: { typeCol: 1, descCol: 2, moneyInCol: null, moneyOutCol: 3, balanceCol: 4, embeddedMoneyIn: true }, headerIdx: i };
        }

        // 4-col OCR merged: Date | Desc+MoneyIn | MoneyOut | Balance
        if (cells[1].includes('description') && cells[1].includes('money in') &&
            cells[2].includes('money out') && cells[3].includes('balance')) {
            return { layout: { typeCol: null, descCol: 1, moneyInCol: null, moneyOutCol: 2, balanceCol: 3, embeddedMoneyIn: true }, headerIdx: i };
        }

        // Fallback: Date | Desc | Credit/MoneyIn | Debit/MoneyOut | Balance
        if (cells[1].includes('description') &&
            (cells[2].includes('credit') || cells[2].includes('money in')) &&
            (cells[3].includes('debit') || cells[3].includes('money out')) &&
            cells[4].includes('balance')) {
            return { layout: { typeCol: null, descCol: 1, moneyInCol: 2, moneyOutCol: 3, balanceCol: 4, embeddedMoneyIn: false }, headerIdx: i };
        }
    }

    return null;
}

// ── Year assignment ───────────────────────────────────────────────────────────

function assignYears(rowMaps: RowMap[], headerIdx: number, defaultYear: number): Map<RowMap, number> {
    const yearMap = new Map<RowMap, number>();
    let currentYear = defaultYear;
    let prevMonth: number | null = null;

    for (let i = headerIdx + 1; i < rowMaps.length; i++) {
        const r = rowMaps[i];
        if (isTransactionHeader(r)) continue; // skip secondary page headers

        const parts = extractDateParts(normStr(r.get(0) ?? ''));
        if (!parts) continue;

        if (parts.explicitYear && parts.year) {
            currentYear = parts.year;
            yearMap.set(r, currentYear);
            prevMonth = parts.month;
            continue;
        }

        if (prevMonth !== null) {
            if (prevMonth === 12 && parts.month === 1) currentYear++;
            else if (prevMonth === 1  && parts.month === 12) currentYear--;
        }

        yearMap.set(r, currentYear);
        prevMonth = parts.month;
    }

    return yearMap;
}

// ── Declared totals extraction ────────────────────────────────────────────────

function extractDeclaredTotals(rowMaps: RowMap[]): ParseResult['statementTotals'] | undefined {
    let openingBalance: number | undefined;
    let moneyIn: number | undefined;
    let moneyOut: number | undefined;
    let closingBalance: number | undefined;

    for (const r of rowMaps) {
        const label = normStr(r.get(0) ?? '').toLowerCase();
        const valStr = normStr(r.get(1) ?? '');
        if (!valStr) continue;
        const v = amountToNumber(valStr);
        if (v === null) continue;

        if (/balance brought forward/.test(label))              openingBalance = v;
        else if (/\btotal money in\b/.test(label))              moneyIn = Math.abs(v);
        else if (/\btotal money out\b/.test(label))             moneyOut = Math.abs(v);
        else if (/your balance at close|balance at close of/.test(label)) closingBalance = v;
    }

    if (openingBalance === undefined && closingBalance === undefined) return undefined;
    return { moneyIn, moneyOut, openingBalance, closingBalance };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);

    // Build sorted non-empty row array (skip synthetic context rows at rowIndex < 0)
    const rowMaps: RowMap[] = [];
    for (const [r, cols] of [...grid.entries()].sort(([a], [b]) => a - b)) {
        if (r < 0) continue;
        if ([...cols.values()].some(v => v.trim())) rowMaps.push(cols);
    }

    const detected = detectLayout(rowMaps);
    if (!detected) return { transactions: [] };

    const { headerIdx } = detected;
    let layout = detected.layout; // mutable: re-detected at each page-section header

    const defaultYear = extractYearFromContent(cells) ?? new Date().getFullYear();
    const yearMap = assignYears(rowMaps, headerIdx, defaultYear);

    // ── Transaction extraction ────────────────────────────────────────────────

    interface Pending {
        date: string; type: string; description: string;
        moneyIn: string; moneyOut: string; balance: string;
    }

    const transactions: ParsedTransaction[] = [];
    let current: Pending | null = null;

    const flush = () => {
        if (!current) return;
        current.description = normStr(current.description);
        const combined = normStr(`${current.type} ${current.description}`);
        if (isSkipRow(combined) || (!current.moneyIn && !current.moneyOut)) {
            current = null; return;
        }
        transactions.push({
            date:        current.date,
            type:        current.type,
            description: current.description,
            moneyIn:     current.moneyIn,
            moneyOut:    current.moneyOut,
            balance:     current.balance,
        });
        current = null;
    };

    for (let i = headerIdx + 1; i < rowMaps.length; i++) {
        const r = rowMaps[i];

        if (isTransactionHeader(r)) {
            flush();
            const newDet = detectLayout([r]);
            if (newDet) layout = newDet.layout;
            continue;
        }

        const gc = (col: number) => normStr(r.get(col) ?? '');

        const dateParts = extractDateParts(gc(0));

        let type     = layout.typeCol !== null ? gc(layout.typeCol) : '';
        let fullDesc = gc(layout.descCol);

        // OCR quirk: description fell into type column, desc column empty
        if (!fullDesc && type && !['DEBIT', 'ATM', 'FEE'].includes(type.toUpperCase())) {
            fullDesc = type; type = '';
        }

        const rawMoneyInCell = layout.moneyInCol !== null ? gc(layout.moneyInCol) : '';
        let moneyIn = '';
        if (layout.moneyInCol !== null) {
            moneyIn = normalizeAmount(rawMoneyInCell);
            if (!moneyIn && layout.altMoneyInCol !== undefined) {
                moneyIn = normalizeAmount(gc(layout.altMoneyInCol));
            }
        }

        let moneyOut = isAmount(gc(layout.moneyOutCol)) ? normalizeAmount(gc(layout.moneyOutCol)) : '';
        const balance = isAmount(gc(layout.balanceCol)) ? normalizeAmount(gc(layout.balanceCol)) : '';

        // OCR quirk: non-money text in money-in column
        if (layout.moneyInCol !== null && rawMoneyInCell && !isAmount(rawMoneyInCell)) {
            const maybeAmt = normalizeAmount(rawMoneyInCell);
            if (maybeAmt && !moneyIn) {
                moneyIn = maybeAmt;
                const leftover = normStr(rawMoneyInCell.replace(maybeAmt, ''));
                if (leftover) fullDesc = appendUnique(fullDesc, leftover);
            } else {
                fullDesc = appendUnique(fullDesc, rawMoneyInCell);
            }
        }

        // Embedded money in for layouts where the dedicated moneyOut column is empty.
        // In Edge Up statements, if the outgoing column has no value, any trailing
        // amount in the description is always the incoming amount.
        if (!moneyIn && !moneyOut && layout.embeddedMoneyIn) {
            const rawAmt = extractLastAmount(fullDesc); // may include commas
            if (rawAmt) {
                fullDesc = cleanEmbeddedAmount(fullDesc, rawAmt);
                moneyIn = rawAmt.replace(/,/g, ''); // strip commas for storage
            }
        }

        // OCR quirk: "GBP" appears in money-in col for cash withdrawals
        if (layout.moneyInCol !== null && gc(layout.moneyInCol).toUpperCase() === 'GBP' && !moneyIn && moneyOut) {
            fullDesc = normStr(fullDesc.replace(/,?\s*([0-9,]+\.\d{2})\s+ON\s+/i, ',$1 GBP, ON '));
        }

        // If row has outgoing amount and desc doesn't look incoming, drop false moneyIn
        if (moneyOut && moneyIn && !looksLikeMoneyIn(fullDesc)) moneyIn = '';

        const combinedDesc = normStr(`${type} ${fullDesc}`);
        if (isSkipRow(combinedDesc)) { flush(); current = null; continue; }

        if (dateParts) {
            flush();
            const finalYear = (dateParts.explicitYear && dateParts.year)
                ? dateParts.year
                : (yearMap.get(r) ?? defaultYear);
            const date = `${pad2(dateParts.day)}/${pad2(dateParts.month)}/${finalYear}`;
            current = { date, type, description: fullDesc, moneyIn, moneyOut, balance };
            continue;
        }

        // Continuation row (no date)
        if (current) {
            if (fullDesc) current.description = normStr((current.description ? current.description + ' ' : '') + fullDesc);
            if (!current.moneyIn  && moneyIn)  current.moneyIn  = moneyIn;
            if (!current.moneyOut && moneyOut) current.moneyOut = moneyOut;
            if (!current.balance  && balance)  current.balance  = balance;
        }
    }

    flush();

    // ── Balance backfill ──────────────────────────────────────────────────────
    for (let i = transactions.length - 2; i >= 0; i--) {
        const curr = transactions[i];
        const next = transactions[i + 1];
        if (curr.balance) continue;
        const nextBal = amountToNumber(next.balance);
        if (nextBal === null) continue;
        curr.balance = numberToAmountString(nextBal - (amountToNumber(next.moneyIn) ?? 0) + (amountToNumber(next.moneyOut) ?? 0));
    }

    const statementTotals = extractDeclaredTotals(rowMaps);
    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}
