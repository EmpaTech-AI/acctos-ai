// NatWest parser — 6-col (Details/Withdrawn/Paid In) and 4-col (Description/Amount) variants
// Adapted from Make scenarios 1.5.4, modules 1326 + 1333
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow,
    parseDateToDDMMYYYY, extractYearsFromCells,
} from './shared.js';

const MONTH_MAP: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

// Strip leading card-terminal or sort-code references that Azure DI puts in D2.
// E.g. "3442 02APR24 CD Rest of description" → "Rest of description"
//      "602012 02APR 1314 Merchant Name"      → "Merchant Name"
function stripRefPrefix(s: string): string {
    // 4-digit card terminal + DDMMMYY + optional CD/D/C suffix: "3442 02APR24 CD"
    s = s.replace(/^\d{4}\s+\d{2}[A-Za-z]{3}\d{2}\s*[CDcd]{0,2}\s*/i, '');
    // 6-digit sort code + DDMMM + 4-digit time: "602012 02APR 1314"
    s = s.replace(/^\d{6}\s+\d{2}[A-Za-z]{3}\s+\d{4}\s*/i, '');
    return normStr(s);
}

function amt(s: string): string {
    const n = parseMoney(s);
    return n !== null && n !== 0 ? formatMoney(Math.abs(n)) : '';
}

// Balance preserving sign: parseMoney handles OD suffix → negative; format accordingly
function signedBal(rawBal: string, odColText = ''): string {
    const isOD = /\bOD\b/i.test(rawBal) || /\bOD\b/i.test(odColText);
    const n = parseMoney(rawBal);
    if (n === null) return '';
    const absStr = formatMoney(n);  // always positive
    return isOD && Number(absStr) > 0 ? '-' + absStr : absStr;
}

function isHeaderRow(row: Map<number, string>): boolean {
    const vals = [...row.values()].map(v => normStr(v).toLowerCase());
    return (
        vals.some(v => v === 'date' || v.startsWith('date ')) &&
        vals.some(v => v.includes('detail') || v.includes('desc') || v.includes('narrat'))
    );
}

// ─── Statement period extraction from full-page OCR text ─────────────────────

interface Period { startYear: number; endYear: number; endMonth: number }

function extractPeriod(ocrText: string): Period | null {
    // "16 AUG 2025 to 14 NOV 2025"
    const m = ocrText.match(
        /(\d{1,2})\s+([A-Za-z]{3,})\s+(20\d{2})\s+(?:to|–|-)\s+\d{1,2}\s+([A-Za-z]{3,})\s+(20\d{2})/i,
    );
    if (m) {
        return {
            startYear: Number(m[3]),
            endYear:   Number(m[5]),
            endMonth:  MONTH_MAP[m[4].slice(0, 3).toLowerCase()] ?? 12,
        };
    }
    // "01/01/2026 … 31/01/2026"
    const r = ocrText.match(/(\d{2})\/\d{2}\/(20\d{2})\s.+?(\d{2})\/(\d{2})\/(20\d{2})/);
    if (r) {
        return { startYear: Number(r[2]), endYear: Number(r[5]), endMonth: Number(r[4]) };
    }
    return null;
}

function resolveYear(monthNum: number, period: Period | null, fallback: number): number {
    if (!period || period.startYear === period.endYear) return period?.endYear ?? fallback;
    // If month is later than the statement end-month it belongs to the earlier year
    return monthNum > period.endMonth ? period.startYear : period.endYear;
}

function parseDate(rawDate: string, period: Period | null, fallback: number): string {
    if (!rawDate) return '';
    // Only trust a direct parse when the raw string already contains a 4-digit year;
    // otherwise parseDateToDDMMYYYY falls back to year 2000 for "DD MMM" dates.
    const direct = /\b\d{4}\b/.test(rawDate) ? parseDateToDDMMYYYY(rawDate) : '';
    if (direct) return direct;
    // "5 MAR" / "05 March"
    const short = rawDate.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
    if (short) {
        const monthNum = MONTH_MAP[short[2].slice(0, 3).toLowerCase()];
        if (monthNum) {
            const year = resolveYear(monthNum, period, fallback);
            return parseDateToDDMMYYYY(`${rawDate} ${year}`) || '';
        }
    }
    return '';
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    const grid  = buildGrid(cells);
    const rows  = maxRow(cells);

    const ocrText = cells
        .filter(c => c.rowIndex < 0)
        .map(c => normStr(c.content))
        .join(' ');

    // ── Column layout detection — scan first rows to find actual header ──────
    // Row 0 may be a spanning "Period covered:" cell; the real header can be
    // on row 1 (or later). Scan up to the first 8 rows.
    let header: Map<number, string> | undefined;
    let headerRowIndex = -1;
    for (let r = 0; r <= Math.min(8, rows); r++) {
        const row = grid.get(r);
        if (row && isHeaderRow(row)) { header = row; headerRowIndex = r; break; }
    }

    let is6col = false;
    let dateCol = 0, d1Col = 1, d2Col = -1, typeCol = -1;
    let outCol = -1, inCol = -1, amountCol = -1, balCol = -1, odCol = -1;

    if (header) {
        let hasDetails = false, hasWithdrawn = false, hasPaidIn = false;
        let detailCount = 0;

        for (const [c, v] of header) {
            const lo = normStr(v).toLowerCase();
            if (lo === 'date' || lo.startsWith('date '))                                      dateCol = c;
            else if (lo.includes('detail')) { hasDetails = true; detailCount++; if (detailCount === 1) d1Col = c; else d2Col = c; }
            else if (lo.includes('desc') || lo.includes('narrat'))                            d1Col = c;
            else if (lo === 'type' || lo.startsWith('type '))                                 typeCol = c;
            else if (lo.includes('withdrawn') && lo.includes('paid in'))                        amountCol = c; // combined "Paid In(£) Withdrawn(£)" column
            else if (lo.includes('withdrawn') || lo.includes('paid out') || lo.includes('debit')) { hasWithdrawn = true; outCol = c; }
            else if (lo === 'od')                                                              odCol = c;
            else if (lo.includes('paid in') || lo.includes('credit'))                        { hasPaidIn = true; inCol = c; }
            else if (lo.includes('amount') && !lo.includes('bal'))                           amountCol = c;
            else if (lo.includes('bal'))                                                      balCol = c;
        }

        if (balCol === -1) balCol = Math.max(...header.keys());
        // If the highest column is an amount column there is no balance column
        if (balCol === outCol || balCol === inCol) balCol = -1;
        is6col = hasDetails && hasWithdrawn && hasPaidIn;

        // Blank D2 column: gap between d1Col and outCol in the 6-col layout
        if (is6col && d2Col === -1 && outCol > d1Col + 1) d2Col = d1Col + 1;

        // 4-col single-amount fallback when no amount/in/out columns found
        if (!is6col && inCol === -1 && outCol === -1 && amountCol === -1) {
            amountCol = balCol > 2 ? balCol - 1 : 2;
        }
    } else {
        amountCol = 2;
        balCol = 3;
    }

    // ── Year / period resolution ──────────────────────────────────────────────
    const period = extractPeriod(ocrText);
    let fallbackYear = new Date().getFullYear();
    if (period) {
        fallbackYear = period.endYear;
    } else {
        const years = extractYearsFromCells(cells.filter(c => c.rowIndex >= 0));
        if (years.length > 0) fallbackYear = years[years.length - 1];
    }

    // ── Main row loop ─────────────────────────────────────────────────────────
    const transactions: ParsedTransaction[] = [];
    let currentDate = '';
    let prevBalance: number | null = null;
    let current: ParsedTransaction | null = null;

    function flush() {
        if (!current) return;
        if ((current.moneyIn || current.moneyOut) && (current.description || current.type)) {
            transactions.push(current);
        }
        current = null;
    }

    for (let r = headerRowIndex + 1; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;

        // Skip repeated header rows from subsequent pages
        if (isHeaderRow(row)) { flush(); continue; }

        const rawDate = normStr(getCell(grid, r, dateCol));
        const d1      = normStr(getCell(grid, r, d1Col));
        const d2raw   = d2Col >= 0 ? normStr(getCell(grid, r, d2Col)) : '';
        const d2      = stripRefPrefix(d2raw);
        const rawBal  = balCol >= 0 ? normStr(getCell(grid, r, balCol)) : '';
        // OD indicator: from dedicated header column if present; otherwise check the cell
        // immediately right of the balance column (NatWest puts "OD" there as a separate cell).
        // Guard: only check balCol+1 when balCol is valid (avoid reading date/desc columns).
        const rawOD   = odCol >= 0 ? normStr(getCell(grid, r, odCol))
            : (balCol >= 0 ? normStr(getCell(grid, r, balCol + 1)) : '');
        // For "Date|Description|Type|Paid in|Paid out" format: typeCol is set, d1=description.
        // For "Date|Details|[blank]|Withdrawn|Paid In|Balance" format: typeCol=-1, d1=type, d2=description.
        const txType  = typeCol >= 0 ? normStr(getCell(grid, r, typeCol)) : d1;
        const txDesc  = typeCol >= 0 ? d1 : d2;

        // ── Amount calculation ────────────────────────────────────────────────
        let moneyIn = '', moneyOut = '';

        if (is6col || (inCol >= 0 && outCol >= 0)) {
            if (outCol >= 0) moneyOut = amt(getCell(grid, r, outCol));
            if (inCol  >= 0) moneyIn  = amt(getCell(grid, r, inCol));
        } else if (inCol >= 0) {
            moneyIn = amt(getCell(grid, r, inCol));
        } else if (outCol >= 0) {
            moneyOut = amt(getCell(grid, r, outCol));
        } else {
            // Single amount column — direction inferred from balance delta
            const rawAmt = amountCol >= 0 ? normStr(getCell(grid, r, amountCol)) : '';
            const amtN   = parseMoney(rawAmt);
            const balN   = parseMoney(rawBal);

            if (amtN !== null && amtN !== 0) {
                if (amtN < 0) {
                    moneyOut = formatMoney(Math.abs(amtN));
                } else if (prevBalance !== null && balN !== null) {
                    if (balN >= prevBalance) moneyIn  = formatMoney(amtN);
                    else                     moneyOut = formatMoney(amtN);
                } else {
                    moneyIn = formatMoney(amtN);
                }
            }

            if (balN !== null) prevBalance = balN;
        }

        const hasAmount = !!(moneyIn || moneyOut);
        const balance = signedBal(rawBal, rawOD);
        const date = parseDate(rawDate, period, fallbackYear);

        if (date) {
            flush();
            currentDate = date;
            current = { date: currentDate, type: txType, description: txDesc, moneyOut, moneyIn, balance };
        } else if (current) {
            // Continuation row — may be a true continuation (description wraps) or a
            // separate same-date transaction (NatWest omits the date on rows 2+ of the
            // same date group).  Distinguish: in 6-col mode amounts arrive on the final
            // continuation line BEFORE current has an amount; in 4-col fallback mode
            // each row is self-contained, so a continuation row with an amount while
            // current already has one is a new transaction sharing the same date.
            if (hasAmount && (current.moneyIn || current.moneyOut)) {
                flush();
                current = { date: currentDate, type: txType, description: txDesc, moneyOut, moneyIn, balance };
            } else {
                if (typeCol >= 0) {
                    // 4/5-col export format: d1 is the description column
                    if (d1) current.description = normStr(`${current.description} ${d1}`);
                } else {
                    // 6-col statement format: d1 is type, d2 is description
                    if (d1 && !current.type) current.type        = d1;
                    if (d2)                  current.description = normStr(`${current.description} ${d2}`);
                }
                if (balance && !current.balance)   current.balance  = balance;
                if (moneyOut && !current.moneyOut) current.moneyOut = moneyOut;
                if (moneyIn  && !current.moneyIn)  current.moneyIn  = moneyIn;
            }
        } else if (hasAmount && currentDate) {
            // Orphaned amount with no preceding date row (page-break edge case)
            current = { date: currentDate, type: txType, description: txDesc, moneyOut, moneyIn, balance };
        }
    }

    flush();

    // Extract declared totals from the Summary block (rows 0–8 of page 1).
    // NatWest statements print "Paid In" / "Withdrawn" as label+value pairs.
    let statementTotals: { moneyIn: number; moneyOut: number } | undefined;
    let paidInDecl: number | null = null;
    let withdrawnDecl: number | null = null;
    for (const [r, row] of grid) {
        if (r < 0 || r > 8) continue;
        const label = normStr(row.get(0) ?? '').toLowerCase();
        const val   = parseMoney(normStr(row.get(1) ?? ''));
        if (label === 'paid in'   && val !== null) paidInDecl   = val;
        if (label === 'withdrawn' && val !== null) withdrawnDecl = val;
    }
    if (paidInDecl !== null && withdrawnDecl !== null) {
        statementTotals = { moneyIn: paidInDecl, moneyOut: withdrawnDecl };
    }

    return { transactions, statementTotals, ascending: true };
}
