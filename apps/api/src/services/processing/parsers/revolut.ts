// Revolut parser — covers two OCR variants, 3 table layouts each:
//   Variant A: content contains "Revolut Ltd (No"    — English Business
//   Variant B: content starts with "Revolut Business" — Bulgarian/English Business
//
// Layouts (5+ column tables only):
//   5-col in/out:   [date, desc, out, in, balance]         — header keyword detection
//   6-col:          [date, type, desc, out, in, balance]   — explicit columns
//   5-col legacy:   [date, type, desc, amount, balance]    — direction from balance delta
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, getCell, maxRow, maxCol,
    parseDateToDDMMYYYY,
} from './shared.js';

// Transaction codes that always indicate incoming money (Revolut Business legend)
const IN_CODES  = new Set(['MOA', 'MOR', 'EXI']);
const OUT_CODES = new Set(['CAR', 'MOS', 'ATM', 'EXO', 'FEE']);

function directionByCode(code: string): 'IN' | 'OUT' | '' {
    const c = normStr(code).toUpperCase();
    if (IN_CODES.has(c))  return 'IN';
    if (OUT_CODES.has(c)) return 'OUT';
    return '';
}

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

// Detect transaction-statement format: [date, desc, status, account, out, in]
// Key markers: "status" and "account" columns present, no "balance" column.
// Azure DI may shift columns across pages, but the header is stable on page 1.
function isTransactionStatement(header: string[]): boolean {
    const joined = header.join(' ').toLowerCase();
    return /\bstatus\b/.test(joined) && /\baccount\b/.test(joined) && !/\bbalance\b/.test(joined);
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

// Parse amount, falling back to the first £-prefixed decimal when the cell also
// contains a foreign-currency amount, e.g. "£30.67 1 574.00 TRY" → 30.67
function parseMoneyFirst(s: string): number | null {
    const direct = parseMoney(s);
    if (direct !== null) return direct;
    const m = normStr(s).match(/£\s*(\d+(?:\.\d{1,2})?)/);
    return m ? parseMoney('£' + m[1]) : null;
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
            const bal    = balNum !== null ? balNum.toFixed(2) : '';

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

    // ── Transaction-statement: [date, "TYPE desc", status, account, out, in] ──
    // Azure DI column positions vary across pages, so for each row we scan
    // right-to-left from col 6→3 for the first parseable £ amount, then use
    // the type code (IN_CODES/OUT_CODES) + "from" keyword for direction.
    if (hasHeader && isTransactionStatement(table[0].cols)) {
        for (let i = 1; i < table.length; i++) {
            const c = table[i].cols;
            const date = parseDateToDDMMYYYY(c[0]);
            if (!date) continue;

            // Split c[1]: "TYPE rest" → type + desc; if c[1] is bare code → desc from c[2]
            const cell1 = normStr(c[1]);
            const sp = cell1.indexOf(' ');
            let type = '', desc = '';
            if (sp > 0 && /^[A-Z]{2,4}$/.test(cell1.slice(0, sp))) {
                type = cell1.slice(0, sp);
                desc = cell1.slice(sp + 1).trim();
            } else if (/^[A-Z]{2,4}$/.test(cell1)) {
                type = cell1;
                desc = normStr(c[2]);
            } else {
                desc = cell1;
            }

            // Scan right-to-left (col 6 → 3) for the first parseable £ amount
            let amt: number | null = null;
            for (let ci = 6; ci >= 3; ci--) {
                const v = parseMoneyFirst(c[ci] ?? '');
                if (v !== null && v > 0) { amt = v; break; }
            }
            if (amt === null) continue;

            const t = type.toUpperCase();
            const d = desc.toLowerCase();
            let moneyIn = '', moneyOut = '';
            if (IN_CODES.has(t) || /\bfrom\b/.test(d) || d.includes('money added from')) {
                moneyIn = formatMoney(amt);
            } else {
                moneyOut = formatMoney(amt);
            }

            transactions.push({ date, type, description: desc, moneyIn, moneyOut, balance: '' });
        }
        return { transactions };
    }

    // ── 6-col and legacy 5-col ────────────────────────────────────────────────
    // Layout is detected per-row because multi-page documents can mix both
    // (e.g. pages where Azure DI emits 6 cols alternate with pages that only
    //  produce 5 cols).  If c[5] parses as a balance → 6-col; otherwise → legacy 5-col.
    for (let i = startAt; i < table.length; i++) {
        const c = table[i].cols;
        const date = parseDateToDDMMYYYY(c[0]);
        if (!date) continue;

        const type = normStr(c[1]);
        const desc = normStr(c[2]);

        const c5bal = parseMoney(c[5] ?? '');
        const rowIsSixCols  = isSixCols  && c5bal !== null;
        const rowIsFiveCols = isFiveCols || (isSixCols && c5bal === null);

        // ── 6-col: [date, type, desc, out, in, balance] ──────────────────────
        if (rowIsSixCols) {
            const outAmt = parseMoneyFirst(c[3]);
            const inAmt  = parseMoneyFirst(c[4]);
            const bal    = c5bal !== null ? c5bal.toFixed(2) : '';

            const d = desc.toLowerCase();
            const t = type.toUpperCase();
            const hasFrom = /\bfrom\b/.test(d) || d.includes('money added from');

            let moneyIn = '', moneyOut = '';

            // IN_CODES (MOA/MOR/EXI) and "from" descriptions → always money in
            if (IN_CODES.has(t) || hasFrom) {
                const amt = (inAmt !== null && inAmt > 0) ? inAmt : outAmt;
                if (amt === null || amt <= 0) continue;
                moneyIn = formatMoney(amt);
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
        if (rowIsFiveCols) {
            let amountNum = parseMoneyFirst(c[3]);
            let balNum    = parseMoney(c[4]);

            // Handle smashed "amount balance" in col 3
            if (balNum === null) {
                const pair = extractTwoAmounts(normStr(c[3]));
                if (pair) { amountNum = pair[0]; balNum = pair[1]; }
            }

            if (amountNum === null || amountNum === 0 || balNum === null) continue;
            const absAmt = Math.abs(amountNum);

            const bal = balNum !== null ? balNum.toFixed(2) : '';
            const amt = formatMoney(absAmt);
            const d   = desc.toLowerCase();
            const t   = type.toUpperCase();

            // Next table entry for balance delta direction detection.
            // Only use it if the next row is also legacy 5-col (c5 absent) —
            // otherwise a 6-col row's c[4] would be misread as a balance.
            const nextRow = table[i + 1];
            let nextBalNum: number | null = null;
            if (nextRow) {
                const nextC5 = parseMoney(nextRow.cols[5] ?? '');
                if (nextC5 === null) {
                    nextBalNum = parseMoney(nextRow.cols[4]);
                    if (nextBalNum === null) {
                        const pair = extractTwoAmounts(normStr(nextRow.cols[3]));
                        if (pair) nextBalNum = pair[1];
                    }
                }
            }

            let moneyIn = '', moneyOut = '';

            if (/\bfrom\b/.test(d) || d.includes('money added from')) {
                moneyIn = amt;
            } else if (nextBalNum === null) {
                // Last row or next row has no balance — use code legend
                const dir = directionByCode(t);
                if (dir === 'IN') moneyIn = amt;
                else moneyOut = amt;  // OUT or unknown → default OUT
            } else {
                const delta = balNum - nextBalNum;

                if (Math.abs(delta) < 0.000001 || Math.abs(Math.abs(delta) - absAmt) > 0.01) {
                    // Delta doesn't validate — fall back to code legend
                    const dir = directionByCode(t);
                    if (dir === 'IN') moneyIn = amt;
                    else if (dir === 'OUT') moneyOut = amt;
                    else continue;  // unknown code and no delta — skip
                } else {
                    if (delta > 0) moneyIn = amt;
                    else moneyOut = amt;
                }
            }

            if (!moneyIn && !moneyOut) continue;
            transactions.push({ date, type, description: desc, moneyIn, moneyOut, balance: bal });
        }
    }

    return { transactions };
}
