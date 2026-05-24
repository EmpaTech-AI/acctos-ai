// Revolut parser — 3 layouts (5+ column tables only):
//   5-col in/out:   [date, desc, out, in, balance]         — header keyword detection
//   6-col:          [date, type, desc, out, in, balance]   — explicit columns
//   5-col legacy:   [date, type, desc, amount, balance]    — direction from balance delta
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow, maxCol,
    parseDateToDDMMYYYY,
} from './shared.js';

function isHeaderRow(cols: string[]): boolean {
    const joined = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b/.test(joined))               hits++;
    if (/description|transaction/.test(joined)) hits++;
    if (/\bout\b|debit|outgoing/.test(joined)) hits++;
    if (/\bin\b|credit|incoming/.test(joined)) hits++;
    if (/balance/.test(joined))                hits++;
    if (/\btype\b/.test(joined))               hits++;
    return hits >= 3;
}

// Detect 5-col [date, desc, out, in, balance] by inspecting header cols 2–4
function isInOut5Header(header: string[]): boolean {
    return (
        /money\s*out|outgoing|debit/i.test(header[2] ?? '') &&
        /money\s*in|incoming|credit/i.test(header[3] ?? '') &&
        /balance/i.test(header[4] ?? '')
    );
}

// Extract two £-prefixed amounts from a smashed cell, e.g. "£48.70 £436.68"
function extractTwoAmounts(s: string): [number, number] | null {
    const matches = s.match(/£\s*[\d,]+(?:\.\d{1,2})?/g);
    if (!matches || matches.length < 2) return null;
    const a = parseMoney(matches[0]);
    const b = parseMoney(matches[1]);
    if (a === null || b === null) return null;
    return [a, b];
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells);
    const rows = maxRow(cells);
    const cols = maxCol(cells);

    // Build flat ordered table (skips row-offset gaps from multi-page merging)
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

    const hasHeader = isHeaderRow(table[0].cols);
    const startAt   = hasHeader ? 1 : 0;
    const isSixCols  = cols === 5;
    const isFiveCols = cols === 4;

    const transactions: ParsedTransaction[] = [];

    // ── 5-col in/out: [date, desc, out, in, balance] ─────────────────────────
    if (isFiveCols && hasHeader && isInOut5Header(table[0].cols)) {
        for (let i = 1; i < table.length; i++) {
            const c = table[i].cols;
            const date = parseDateToDDMMYYYY(c[0]);
            if (!date) continue;

            const desc   = normStr(c[1]);
            const outAmt = parseMoney(c[2]);
            const inAmt  = parseMoney(c[3]);
            const balNum = parseMoney(c[4]);
            const bal    = balNum !== null ? formatMoney(balNum) : '';

            let moneyIn = '', moneyOut = '';

            if (outAmt !== null && outAmt > 0 && (inAmt === null || inAmt === 0)) {
                moneyOut = formatMoney(outAmt);
            } else if (inAmt !== null && inAmt > 0 && (outAmt === null || outAmt === 0)) {
                moneyIn = formatMoney(inAmt);
            } else if (inAmt !== null && outAmt !== null && inAmt > 0 && outAmt > 0) {
                if (inAmt >= outAmt) moneyIn = formatMoney(inAmt);
                else moneyOut = formatMoney(outAmt);
            } else {
                continue;
            }

            transactions.push({ date, type: '', description: desc, moneyIn, moneyOut, balance: bal });
        }
        return { transactions };
    }

    // ── 6-col and legacy 5-col ────────────────────────────────────────────────
    for (let i = startAt; i < table.length; i++) {
        const c = table[i].cols;
        const date = parseDateToDDMMYYYY(c[0]);
        if (!date) continue;

        const type = normStr(c[1]);
        const desc = normStr(c[2]);

        // ── 6-col: [date, type, desc, out, in, balance] ──────────────────────
        if (isSixCols) {
            const outAmt = parseMoney(c[3]);
            const inAmt  = parseMoney(c[4]);
            const balNum = parseMoney(c[5]);
            const bal    = balNum !== null ? formatMoney(balNum) : '';

            const d = desc.toLowerCase();
            const t = type.toUpperCase();
            const hasFrom = /\bfrom\b/.test(d);

            let moneyIn = '', moneyOut = '';

            if (hasFrom) {
                const amt = (inAmt !== null && inAmt > 0) ? inAmt : outAmt;
                if (amt === null || amt <= 0) continue;
                moneyIn = formatMoney(amt);
            } else if (t === 'MOA' && outAmt !== null && outAmt > 0 && (inAmt === null || inAmt === 0)) {
                moneyIn = formatMoney(outAmt);
            } else if (outAmt !== null && outAmt > 0 && (inAmt === null || inAmt === 0)) {
                moneyOut = formatMoney(outAmt);
            } else if (inAmt !== null && inAmt > 0 && (outAmt === null || outAmt === 0)) {
                moneyIn = formatMoney(inAmt);
            } else if (inAmt !== null && outAmt !== null && inAmt > 0 && outAmt > 0) {
                if (inAmt >= outAmt) moneyIn = formatMoney(inAmt);
                else moneyOut = formatMoney(outAmt);
            } else {
                continue;
            }

            transactions.push({ date, type, description: desc, moneyIn, moneyOut, balance: bal });
            continue;
        }

        // ── Legacy 5-col: [date, type, desc, amount, balance] ────────────────
        if (isFiveCols) {
            let amountNum = parseMoney(c[3]);
            let balNum    = parseMoney(c[4]);

            // Handle smashed "amount balance" in col 3
            if (balNum === null) {
                const pair = extractTwoAmounts(normStr(c[3]));
                if (pair) { amountNum = pair[0]; balNum = pair[1]; }
            }

            if (amountNum === null || amountNum === 0 || balNum === null) continue;
            const absAmt = Math.abs(amountNum);

            const bal = formatMoney(balNum);
            const amt = formatMoney(absAmt);
            const d   = desc.toLowerCase();
            const t   = type.toUpperCase();

            // Next table entry for balance delta direction detection
            const nextRow = table[i + 1];
            let nextBalNum: number | null = null;
            if (nextRow) {
                nextBalNum = parseMoney(nextRow.cols[4]);
                if (nextBalNum === null) {
                    const pair = extractTwoAmounts(normStr(nextRow.cols[3]));
                    if (pair) nextBalNum = pair[1];
                }
            }

            let moneyIn = '', moneyOut = '';

            if (/\bfrom\b/.test(d)) {
                moneyIn = amt;
            } else if (nextBalNum === null) {
                if (t === 'MOA') moneyIn = amt;
                else moneyOut = amt;
            } else {
                const delta = balNum - nextBalNum;
                if (Math.abs(delta) < 0.000001) continue;
                if (Math.abs(Math.abs(delta) - absAmt) > 0.01) continue;
                if (delta > 0) moneyIn = amt;
                else moneyOut = amt;
            }

            if (!moneyIn && !moneyOut) continue;
            transactions.push({ date, type, description: desc, moneyIn, moneyOut, balance: bal });
        }
    }

    return { transactions };
}
