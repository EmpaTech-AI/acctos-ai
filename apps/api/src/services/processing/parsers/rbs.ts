// RBS (Royal Bank of Scotland) parser — 3 table layouts from Make module 1423:
// 1) 5-col:       [date, description, type, paidIn, paidOut]         — no balance
// 2) 4-col combo: [date, description, type, "Paid in Paid out"]      — signed amount, no balance
// 3) 4-col:       [date, description, amount, balance]               — direction from delta
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow, maxCol,
    parseDateToDDMMYYYY, extractYearsFromCells,
} from './shared.js';

const MONTH_MAP: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

interface Period { fromMonth: number; fromYear: number; toMonth: number; toYear: number }

function extractPeriod(ocrText: string): Period | null {
    // "From  To  DD/MM/YYYY  DD/MM/YYYY"
    const m = ocrText.match(
        /From\s+To\s+\d{2}\/(\d{2})\/((?:19|20)\d{2})\s+\d{2}\/(\d{2})\/((?:19|20)\d{2})/i,
    );
    if (!m) return null;
    return {
        fromMonth: Number(m[1]), fromYear: Number(m[2]),
        toMonth:   Number(m[3]), toYear:   Number(m[4]),
    };
}

function resolveYearForMonth(month: number, period: Period | null, fallback: number): number {
    if (!period) return fallback;
    if (period.fromYear === period.toYear) return period.toYear;
    // Cross-year: months >= fromMonth belong to the earlier (start) year
    return month >= period.fromMonth ? period.fromYear : period.toYear;
}

function parseDate(raw: string, period: Period | null, fallback: number): string {
    const s = normStr(raw);
    if (!s) return '';
    if (/\b\d{4}\b/.test(s)) return parseDateToDDMMYYYY(s) || '';
    // "5 MAR" / "05 March"
    const short = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})$/);
    if (short) {
        const monthNum = MONTH_MAP[short[2].slice(0, 3).toLowerCase()];
        if (monthNum) {
            const year = resolveYearForMonth(monthNum, period, fallback);
            return parseDateToDDMMYYYY(`${s} ${year}`) || '';
        }
    }
    return '';
}

function isHeaderRow(cols: string[]): boolean {
    const joined = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b/.test(joined))                              hits++;
    if (/description|transaction/.test(joined))               hits++;
    if (/\btype\b/.test(joined))                              hits++;
    if (/paid\s*in|credit/.test(joined))                     hits++;
    if (/paid\s*out|debit|withdrawn|amount/.test(joined))    hits++;
    if (/balance/.test(joined))                               hits++;
    return hits >= 3;
}

function isBroughtForward(desc: string): boolean {
    return /brought forward|balance brought forward|carried forward/i.test(desc);
}

function cleanDesc(s: string): string {
    // Strip Azure DI OCR artefact ":selected:" that sometimes appears in cell content
    return normStr(s).replace(/:selected:/g, '').replace(/\s+/g, ' ').trim();
}

function descriptionSuggestsIn(desc: string): boolean {
    const d = desc.toLowerCase();
    return (
        /automated credit|automated pay in|payment from|bill payment from|received from|refund|account credit|deposit/.test(d) ||
        (/\bcredit\b/.test(d) && !d.includes('card transaction')) ||
        /\bfrom\b/.test(d)
    );
}

function descriptionSuggestsOut(desc: string): boolean {
    const d = desc.toLowerCase();
    return (
        /card transaction|card payment|online transaction|charges|cash withdrawal|direct debit|transfer to|payment to|bill payment to/.test(d) ||
        /\bto a\/c\b/.test(d)
    );
}

function signedBal(raw: string): string {
    const isOD = /\b(OD|DR)\b/i.test(raw);
    const n = parseMoney(raw);
    if (n === null) return '';
    const s = formatMoney(Math.abs(n));
    return isOD && Math.abs(n) > 0 ? '-' + s : s;
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);
    const cols = maxCol(cells);

    const ocrText = cells
        .filter(c => c.rowIndex < 0)
        .map(c => normStr(c.content))
        .join(' ');

    const period = extractPeriod(ocrText);
    let fallbackYear = new Date().getFullYear();
    if (period) {
        fallbackYear = period.toYear;
    } else {
        const years = extractYearsFromCells(cells.filter(c => c.rowIndex >= 0));
        if (years.length > 0) fallbackYear = years[years.length - 1];
    }

    // Build flat ordered table
    const table: { rowIndex: number; cols: string[] }[] = [];
    for (let r = 0; r <= rows; r++) {
        if (!grid.has(r)) continue;
        const row: string[] = [];
        for (let c = 0; c <= cols; c++) {
            row.push(normStr(getCell(grid, r, c)));
        }
        table.push({ rowIndex: r, cols: row });
    }

    if (!table.length) return { transactions: [] };

    // Layout detection from header row
    const h = table[0].cols.map(s => normStr(s).toLowerCase());

    const is5Col = (
        /\bdate\b/.test(h[0] ?? '') &&
        /description|transaction/.test(h[1] ?? '') &&
        /\btype\b/.test(h[2] ?? '') &&
        /paid\s*in|credit/.test(h[3] ?? '') &&
        /paid\s*out|debit|withdrawn/.test(h[4] ?? '')
    );

    // Header cell 3 contains BOTH "paid in" AND "paid out" (single merged column)
    const is4ColCombined = !is5Col && (
        /\bdate\b/.test(h[0] ?? '') &&
        /description|transaction/.test(h[1] ?? '') &&
        /\btype\b/.test(h[2] ?? '') &&
        /paid\s*in/.test(h[3] ?? '') &&
        /paid\s*out/.test(h[3] ?? '')
    );

    // col2 header has BOTH "type" AND "paid in" merged (e.g. "Type Paid in (£)")
    // col3 header is "paid out" — amounts are negative strings like "-£50.00"
    const is4ColTypePaidIn = !is5Col && !is4ColCombined && (
        /\bdate\b/.test(h[0] ?? '') &&
        /description|transaction/.test(h[1] ?? '') &&
        /\btype\b/.test(h[2] ?? '') && /paid\s*in/.test(h[2] ?? '') &&
        /paid\s*out/.test(h[3] ?? '')
    );

    const is4Col = !is5Col && !is4ColCombined && !is4ColTypePaidIn && (
        /\bdate\b/.test(h[0] ?? '') &&
        /description|transaction/.test(h[1] ?? '') &&
        /paid\s*in|withdrawn|amount|debit|credit/.test(h[2] ?? '') &&
        /balance/.test(h[3] ?? '')
    );

    const startAt = isHeaderRow(table[0].cols) ? 1 : 0;
    const transactions: ParsedTransaction[] = [];
    let lastDate = '';
    let currentYear = fallbackYear;

    for (let i = startAt; i < table.length; i++) {
        const c = table[i].cols;

        if (isHeaderRow(c)) {
            // Recover data from merged header+data rows (Azure DI merges header with
            // the first data row when a table continues onto a new page).
            // Pattern: col0 = "Date DD Mon", col3 = "Paid in (£) £603.00"
            const col0 = normStr(c[0]);
            const strippedDate = col0.replace(/^date\s+/i, '');
            if (strippedDate !== col0) {
                const mergedDate = parseDate(strippedDate, period, currentYear);
                if (mergedDate) {
                    lastDate = mergedDate;
                    const mdesc = cleanDesc(c[1]).replace(/^description\s+/i, '');
                    const mtype = normStr(c[2]).replace(/^type\s+/i, '');
                    const mRaw3 = normStr(c[3]).replace(/^paid\s+in\s*\([^)]*\)\s*/i, '');
                    const mRaw4 = normStr(c[4] ?? '').replace(/^paid\s+out\s*\([^)]*\)\s*/i, '');
                    const m3 = parseMoney(mRaw3);
                    const m4 = parseMoney(mRaw4);
                    const mMoneyIn  = m3 !== null && m3 > 0 ? formatMoney(m3) : '';
                    const mMoneyOut = m4 !== null && m4 !== 0 ? formatMoney(Math.abs(m4)) : '';
                    if ((mMoneyIn || mMoneyOut) && mdesc && !isBroughtForward(mdesc)) {
                        const mtype2Amt = parseMoney(mtype);
                        const mTypeFinal = (mtype2Amt !== null && mtype2Amt !== 0) ? '' : mtype;
                        transactions.push({ date: mergedDate, type: mTypeFinal, description: mdesc, moneyIn: mMoneyIn, moneyOut: mMoneyOut, balance: '' });
                    }
                }
            }
            continue;
        }

        const rawDate = normStr(c[0]);
        if (rawDate) {
            const yMatch = rawDate.match(/\b(19\d{2}|20\d{2})\b/);
            if (yMatch) currentYear = Number(yMatch[1]);
            const parsed = parseDate(rawDate, period, currentYear);
            if (parsed) lastDate = parsed;
        }

        if (!lastDate) continue;

        const desc = cleanDesc(c[1]);
        if (!desc || isBroughtForward(desc)) continue;

        // ── Format 4: "Type Paid in (£) | Paid out (£)" ────────────────────
        // Azure DI collapses the empty "Paid in" cell for debits, so the paid-out
        // amount lands at col3 with a negative sign (e.g. "-£50.00").
        // For credits, col3 is the positive paid-in amount (e.g. "£1,710.60").
        // Sign of col3 therefore determines direction.
        if (is4ColTypePaidIn) {
            const rawCol2 = normStr(c[2]);
            const rawCol3 = normStr(c[3]);

            // col2 is a type label when parseMoney yields 0/null
            const col2Amt = parseMoney(rawCol2);
            const isMoneyCol2 = col2Amt !== null && col2Amt !== 0;
            const type = isMoneyCol2 ? '' : rawCol2;

            const col3Amt = parseMoney(rawCol3);
            // col4 present on pages 2+ where col3=paid-in and col4=paid-out
            const col4Amt = parseMoney(normStr(c[4] ?? ''));

            let moneyIn  = isMoneyCol2 ? formatMoney(Math.abs(col2Amt!)) : '';
            let moneyOut = '';

            if (col3Amt !== null && col3Amt !== 0) {
                // Page 1 style: col3 holds the amount (positive=in, negative=out)
                if (col3Amt > 0) moneyIn  = formatMoney(col3Amt);
                else             moneyOut = formatMoney(Math.abs(col3Amt));
            } else if (col4Amt !== null && col4Amt !== 0) {
                // Pages 2+ style: col3 is empty paid-in, col4 holds paid-out amount
                moneyOut = formatMoney(Math.abs(col4Amt));
            }

            if (!moneyIn && !moneyOut) continue;
            transactions.push({ date: lastDate, type, description: desc, moneyIn, moneyOut, balance: '' });
            continue;
        }

        // ── Format 1: 5-col [date, desc, type, paidIn, paidOut] ─────────────
        if (is5Col) {
            const type   = normStr(c[2]);
            const inAmt  = parseMoney(c[3]);
            const outAmt = parseMoney(c[4]);
            if (inAmt === null && outAmt === null) continue;

            const moneyIn  = inAmt  !== null && inAmt  > 0 ? formatMoney(inAmt)  : '';
            const moneyOut = outAmt !== null && outAmt > 0 ? formatMoney(outAmt) : '';
            if (!moneyIn && !moneyOut) continue;

            transactions.push({ date: lastDate, type, description: desc, moneyIn, moneyOut, balance: '' });
            continue;
        }

        // ── Format 2: 4-col combo [date, desc, type, signed-amount] ─────────
        if (is4ColCombined) {
            const type   = normStr(c[2]);
            const amtNum = parseMoney(c[3]);  // negative → paid out, positive → paid in
            if (amtNum === null || amtNum === 0) continue;

            const moneyIn  = amtNum > 0 ? formatMoney(amtNum)           : '';
            const moneyOut = amtNum < 0 ? formatMoney(Math.abs(amtNum)) : '';
            if (!moneyIn && !moneyOut) continue;

            transactions.push({ date: lastDate, type, description: desc, moneyIn, moneyOut, balance: '' });
            continue;
        }

        // ── Format 3: 4-col [date, desc, amount, balance] ───────────────────
        if (is4Col) {
            const amtNum = parseMoney(c[2]);
            const balNum = parseMoney(c[3]);
            if (amtNum === null || amtNum === 0 || balNum === null) continue;

            const balance = signedBal(c[3]);
            const prevTx  = transactions.length > 0 ? transactions[transactions.length - 1] : null;
            const prevBal = prevTx ? parseMoney(prevTx.balance) : null;

            let moneyIn = '', moneyOut = '';

            if (prevBal !== null) {
                const delta = balNum - prevBal;
                if (Math.abs(Math.abs(delta) - Math.abs(amtNum)) <= 0.01) {
                    if (delta > 0) moneyIn  = formatMoney(Math.abs(amtNum));
                    else           moneyOut = formatMoney(Math.abs(amtNum));
                }
            }

            // Description heuristics as fallback or override
            if (!moneyIn && !moneyOut) {
                if (descriptionSuggestsIn(desc))       moneyIn  = formatMoney(Math.abs(amtNum));
                else if (descriptionSuggestsOut(desc)) moneyOut = formatMoney(Math.abs(amtNum));
                else                                   moneyOut = formatMoney(Math.abs(amtNum));
            }

            transactions.push({ date: lastDate, type: '', description: desc, moneyIn, moneyOut, balance });
        }
    }

    return { transactions };
}
