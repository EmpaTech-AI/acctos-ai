// NatWest parser — 6-col (Details/Withdrawn/Paid In), 5-col (Description/PaidIn/Withdrawn/Bal), and 4-col (Description/Amount) variants
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

// NatWest footer patterns — these appear as continuation rows at the bottom of pages
// (interest-rate table headers, paperless-statements notice) and must not be appended
// to the last transaction's description.
const NATWEST_FOOTER_RE = /switching to paperless|^arranged\s*(?:overdraft)?\s*$|^unarranged\s*(?:overdraft)?\s*$/i;

function isNatwestFooter(text: string): boolean {
    return NATWEST_FOOTER_RE.test(text.trim());
}

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
    for (let r = 0; r <= Math.min(15, rows); r++) {
        const row = grid.get(r);
        if (row && isHeaderRow(row)) { header = row; headerRowIndex = r; break; }
    } // scan up to row 15 to handle NatWest summary block pushing header to row 10+

    let is6col = false;
    let dateCol = 0, d1Col = 1, d2Col = -1, typeCol = -1;
    let outCol = -1, inCol = -1, amountCol = -1, balCol = -1, odCol = -1;

    // Detect column layout from a header row — called initially and again on each
    // repeated page header so per-page layout changes are handled correctly.
    function detectLayout(hdr: Map<number, string>): void {
        is6col = false;
        dateCol = 0; d1Col = 1; d2Col = -1; typeCol = -1;
        outCol = -1; inCol = -1; amountCol = -1; balCol = -1; odCol = -1;

        let hasDetails = false, hasWithdrawn = false, hasPaidIn = false;
        let detailCount = 0;

        for (const [c, v] of hdr) {
            const lo = normStr(v).toLowerCase();
            if (lo === 'date' || lo.startsWith('date '))                                          dateCol = c;
            else if (lo.includes('detail')) { hasDetails = true; detailCount++; if (detailCount === 1) d1Col = c; else d2Col = c; }
            else if (lo.includes('desc') || lo.includes('narrat'))                                d1Col = c;
            else if (lo === 'type' || lo.startsWith('type '))                                     typeCol = c;
            else if (lo.includes('withdrawn') || lo.includes('paid out') || lo.includes('debit')) { hasWithdrawn = true; outCol = c; }
            else if (lo === 'od')                                                                  odCol = c;
            else if (lo.includes('paid in') || lo.includes('credit'))                            { hasPaidIn = true; inCol = c; }
            else if (lo.includes('amount') && !lo.includes('bal'))                               amountCol = c;
            else if (lo.includes('bal'))                                                          balCol = c;
        }

        if (balCol === -1) balCol = Math.max(...hdr.keys());
        if (balCol === outCol || balCol === inCol) balCol = -1;
        is6col = hasDetails && hasWithdrawn && hasPaidIn;

        if (is6col && d2Col === -1 && outCol > d1Col + 1) d2Col = d1Col + 1;

        // Merged "Paid In(£) Withdrawn(£)" — Azure DI sometimes splits this across two cells:
        // c1="Description Paid" (matches desc → d1Col) and c2="In(£) Withdrawn(£)" (matches withdrawn → outCol).
        // The combined text of the adjacent cell and outCol reveals "paid in", so check both.
        if (!is6col && outCol >= 0 && inCol < 0) {
            const outColText  = normStr(hdr.get(outCol) ?? '').toLowerCase();
            const prevColText = outCol > 0 ? normStr(hdr.get(outCol - 1) ?? '').toLowerCase() : '';
            const combined    = prevColText + ' ' + outColText;
            if (outColText.includes('paid in') || outColText.includes('credit') ||
                combined.includes('paid in')) {
                amountCol = outCol;
                outCol    = -1;
            }
        }

        if (!is6col && inCol === -1 && outCol === -1 && amountCol === -1) {
            amountCol = balCol > 2 ? balCol - 1 : 2;
        }

        // "Date Description" merged header: Azure DI sometimes collapses the Date and
        // Description column labels into one cell (col0 = "Date Description") while
        // keeping them as separate columns in the data rows.
        //
        // Two variants observed in NatWest date-range statements:
        //   A) col0="Date Description" | col1="Paid In(£)" | col2="Withdrawn(£)" | col3="Bal"
        //      → data rows have 5 columns: Date | Desc | In | Out | Bal
        //      → shift all column indices right by 1; d1Col = dateCol + 1
        //   B) col0="Date Description" | col1="Paid In(£) Withdrawn(£)" | col2="Bal"
        //      → data rows also have 3 columns: Date+Desc merged | Amount | Bal
        //      → description IS in col0 (= dateCol); d1Col = dateCol
        const dateCellText = normStr(hdr.get(dateCol) ?? '').toLowerCase();
        if (dateCellText.startsWith('date ') && dateCellText.includes('desc')) {
            if (inCol >= 0 || outCol >= 0) {
                // Variant A: separate In/Out — data has an extra description column
                d1Col = dateCol + 1;
                if (inCol     >= 0) inCol++;
                if (outCol    >= 0) outCol++;
                if (amountCol >= 0) amountCol++;
                if (balCol    >= 0) balCol++;
                if (odCol     >= 0) odCol++;
            } else {
                // Variant B: merged amount column — description shares col0 with date
                d1Col = dateCol;
            }
        }
    }

    if (header) {
        detectLayout(header);
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

        // Re-detect columns on repeated page headers (layout may differ per page)
        if (isHeaderRow(row)) { flush(); detectLayout(row); continue; }

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

        // NatWest appends an interest-rate table after the last transaction (e.g.
        // "33.75% NAR" / "39.49% EAR"). Reject any row where the amount or balance
        // column contains a percent sign — these are rates, not monetary values.
        const rawAmtCol = amountCol >= 0 ? normStr(getCell(grid, r, amountCol)) :
                          inCol >= 0     ? normStr(getCell(grid, r, inCol))      : '';
        if (rawAmtCol.includes('%') || rawBal.includes('%')) continue;

        // For "Date|Description|Type|Paid in|Paid out" format: typeCol is set, d1=description.
        // For "Date|Details|[blank]|Withdrawn|Paid In|Balance" format: typeCol=-1, d1=type, d2=description.
        // For "Date|Description|Amount|Balance" (5-col merged or 4-col): typeCol=-1, d2Col=-1, d1=description.
        const txType  = typeCol >= 0 ? normStr(getCell(grid, r, typeCol)) : (d2Col >= 0 ? d1 : '');
        const txDesc  = typeCol >= 0 ? d1 : (d2Col >= 0 ? d2 : d1);

        // ── Amount calculation ────────────────────────────────────────────────
        let moneyIn = '', moneyOut = '';

        if (is6col || (inCol >= 0 && outCol >= 0)) {
            if (outCol >= 0) moneyOut = amt(getCell(grid, r, outCol));
            if (inCol  >= 0) moneyIn  = amt(getCell(grid, r, inCol));
            // Azure DI occasionally assigns a Withdrawn amount to the Paid-In column.
            // Use balance delta to detect and correct the direction.
            if (!is6col) {
                const balN = parseMoney(rawBal);
                if (balN !== null && prevBalance !== null) {
                    const delta = balN - prevBalance;
                    if (moneyIn && !moneyOut && delta < -0.005) { moneyOut = moneyIn; moneyIn = ''; }
                    else if (moneyOut && !moneyIn && delta > 0.005) { moneyIn = moneyOut; moneyOut = ''; }
                }
                if (balN !== null) prevBalance = balN;
            }
        } else if (inCol >= 0) {
            moneyIn = amt(getCell(grid, r, inCol));
        } else if (outCol >= 0) {
            moneyOut = amt(getCell(grid, r, outCol));
        } else {
            // Single amount column — direction inferred from balance delta
            let amtN = parseMoney(rawAmtCol);
            // Fallback A: Azure DI occasionally places the amount one column right of
            // the expected merged column (e.g. c3 when amountCol=2, balCol=4).
            // Scan columns between amountCol+1 and balCol-1 for a non-zero value.
            if (amtN === null && balCol > amountCol + 1) {
                for (let c = amountCol + 1; c < balCol; c++) {
                    const v = normStr(getCell(grid, r, c));
                    if (v && !v.includes('%')) {
                        const n = parseMoney(v);
                        if (n !== null && n !== 0) { amtN = n; break; }
                    }
                }
            }
            // Fallback B: NatWest occasionally embeds the amount at the end of the
            // description when the amount column is blank
            // (e.g. "Automated Credit B&M EUROPEAN VALUE 2,103.05").
            if (amtN === null && d1) {
                const m = d1.match(/([\d,]+\.\d{2})$/);
                if (m) { const n = parseMoney(m[1]); if (n !== null && n > 0) amtN = n; }
            }
            const balN = parseMoney(rawBal);

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
        // True for both merged-column (amountCol) and split 5-col (inCol+outCol without 6-col)
        const isSingleOrSplit5col = amountCol >= 0 || (!is6col && inCol >= 0 && outCol >= 0);

        if (date) {
            flush();
            currentDate = date;
            current = { date: currentDate, type: txType, description: txDesc, moneyOut, moneyIn, balance };
        } else if (current) {
            const hasAmt = !!(moneyIn || moneyOut);
            // NatWest omits the date for same-day transactions after the first — each such row
            // owns its own balance. Applies to both merged-column (amountCol) and split 5-col
            // (separate Paid-In/Withdrawn columns) formats.
            // Rows with an amount but NO balance are not real transactions — skip them.
            if (isSingleOrSplit5col && hasAmt && balance) {
                flush();
                current = { date: currentDate, type: txType, description: txDesc, moneyOut, moneyIn, balance };
            } else if (isSingleOrSplit5col && hasAmt && !balance) {
                // No balance → not a real transaction row
            } else {
                // Standard continuation — merge description/amounts into current.
                // NatWest 6-col spreads amounts onto the last continuation row.
                if (typeCol >= 0) {
                    if (d1 && !isNatwestFooter(d1)) current.description = normStr(`${current.description} ${d1}`);
                } else if (d2Col >= 0) {
                    if (d1 && !current.type && !isNatwestFooter(d1)) current.type = d1;
                    if (d2 && !isNatwestFooter(d2))                  current.description = normStr(`${current.description} ${d2}`);
                } else {
                    // 5-col merged or 4-col: d1 IS the description.
                    // Guard: when d1Col == dateCol (variant B "Date Description" merged
                    // header), continuation rows are footer/disclaimer text — skip them.
                    if (d1Col !== dateCol && d1 && !isNatwestFooter(d1)) current.description = normStr(`${current.description} ${d1}`);
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

    // Post-process: strip any NatWest footer text that slipped into descriptions.
    // Covers ARRANGED/UNARRANGED overdraft markers and the paperless-statements notice.
    for (const t of transactions) {
        let desc = t.description;
        desc = desc.replace(/\s+switching to paperless.*/i, '');
        desc = desc.replace(/(?:\s+(?:ARRANGED|UNARRANGED))+\s*$/i, '');
        t.description = normStr(desc);
    }

    // Extract declared statement totals from the summary block that sits above the header.
    // NatWest places "Previous Balance / Paid In / Withdrawn / New Balance" as grid rows
    // (rowIndex >= 0) before the transaction table header — not in OCR text (rowIndex < 0).
    let declaredIn: number | undefined, declaredOut: number | undefined;
    let declaredOpen: number | undefined, declaredClose: number | undefined;
    const scanLimit = headerRowIndex >= 0 ? headerRowIndex : 20;
    for (let r = 0; r < scanLimit; r++) {
        const row = grid.get(r);
        if (!row) continue;
        const sorted  = [...row.entries()].sort((a, b) => a[0] - b[0]);
        const label   = sorted.map(([, v]) => normStr(v)).join(' ').toLowerCase();
        let   val: number | null = null;
        for (let i = sorted.length - 1; i >= 0; i--) {
            const n = parseMoney(sorted[i][1]);
            if (n !== null) { val = Math.abs(n); break; }
        }
        if (val === null) continue;
        if (/\bpaid\s+in\b/.test(label) && !/withdrawn/.test(label)) declaredIn    = val;
        else if (/\bwithdrawn\b/.test(label))                         declaredOut   = val;
        else if (/previous\s+balance/.test(label))                    declaredOpen  = val;
        else if (/new\s+balance/.test(label))                         declaredClose = val;
    }
    const statementTotals = declaredIn !== undefined || declaredOut !== undefined
        ? {
            moneyIn:        declaredIn  ?? 0,
            moneyOut:       declaredOut ?? 0,
            openingBalance: declaredOpen,
            closingBalance: declaredClose,
          }
        : undefined;

    return { transactions, statementTotals, ascending: true };
}
