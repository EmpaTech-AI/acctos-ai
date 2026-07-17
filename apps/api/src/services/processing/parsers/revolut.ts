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
const IN_CODES  = new Set(['MOA', 'МОА', 'MOR', 'EXI']);
const OUT_CODES = new Set(['CAR', 'MOS', 'ATM', 'EXO', 'FEE', 'MBP']);

// Bulgarian month names (full and abbreviated, lowercased)
const BG_MONTHS: Record<string, number> = {
    'януари':1,'февруари':2,'март':3,'април':4,'май':5,'юни':6,
    'юли':7,'август':8,'септември':9,'октомври':10,'ноември':11,'декември':12,
    'яну':1,'фев':2,'мар':3,'апр':4,'юн':6,
    'юл':7,'авг':8,'сеп':9,'окт':10,'ное':11,'дек':12,
};

// OCR confusable fixes for Bulgarian month abbreviations.
// Azure DI misreads Cyrillic chars as Latin lookalikes (О→o, К→k, Т→t, п→n, С→c, е→e, р→p, А→a).
// Keys are all-lowercase OCR output; values are the correct Cyrillic abbreviated month.
const OCR_MONTH_FIXES: Record<string, string> = {
    okt: 'окт',  // октомври  (О→o, К→k, Т→t)
    cen: 'сеп',  // септември (С→c, е→e, п→n)
    anp: 'апр',  // април     (А→a, п→n, р→p)
};

function parseBgDate(s: string): string {
    // Allow any non-whitespace chars in the month position (handles Latin/Cyrillic mix)
    const m = s.match(/^(\d{1,2})\s+(\S+)\s+(\d{4})$/);
    if (!m) return '';
    const raw = m[2].toLowerCase();
    const monthStr = OCR_MONTH_FIXES[raw] ?? raw;
    const mon = BG_MONTHS[monthStr];
    if (!mon) return '';
    return `${m[1].padStart(2, '0')}/${String(mon).padStart(2, '0')}/${m[3]}`;
}

function parseAnyDate(s: string): string {
    return parseDateToDDMMYYYY(s) || parseBgDate(s);
}

// Extract GBP statement totals from the "Balance summary" section.
// Handles both Bulgarian and English Revolut Business statements.
// Rows look like: col0="Начален баланс" col1="£114.70"
//             or: col0="Opening balance" col1="£320.71"
function extractBgStatementTotals(grid: Map<number, Map<number, string>>): ParseResult['statementTotals'] | undefined {
    let openingBalance: number | undefined;
    let closingBalance: number | undefined;
    let moneyIn:        number | undefined;
    let moneyOut:       number | undefined;
    const rowIdxs = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);
    for (const r of rowIdxs) {
        const label = normStr(getCell(grid, r, 0)).toLowerCase();
        const val   = normStr(getCell(grid, r, 1));
        // Extract first £ amount, ignoring leading "- "
        const poundM = val.replace(/^-\s*/, '').match(/£\s*([\d\s,]+\.\d{2})/);
        const n = poundM ? parseFloat(poundM[1].replace(/[\s,]/g, '')) : null;
        if ((label === 'начален баланс' || label === 'opening balance') && n !== null) openingBalance = n;
        if ((label === 'входяща сума'   || label === 'money in')        && n !== null) moneyIn        = n;
        if ((label === 'изходяща сума'  || label === 'money out')       && n !== null) moneyOut       = n;
        if ((label === 'краен баланс'   || label === 'closing balance')  && n !== null) closingBalance = n;
    }
    if (moneyIn === undefined && moneyOut === undefined) return undefined;
    return { moneyIn: moneyIn ?? 0, moneyOut: moneyOut ?? 0, openingBalance, closingBalance };
}

function directionByCode(code: string): 'IN' | 'OUT' | '' {
    const c = normStr(code).toUpperCase();
    if (IN_CODES.has(c))  return 'IN';
    if (OUT_CODES.has(c)) return 'OUT';
    return '';
}

function isHeaderRow(cols: string[]): boolean {
    const joined = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b|дата/.test(joined))                   hits++;
    if (/description|transaction|описание/.test(joined)) hits++;
    if (/\bout\b|debit|outgoing|изходяща/.test(joined)) hits++;
    if (/\bin\b|credit|incoming|входяща/.test(joined))  hits++;
    if (/balance|баланс/.test(joined))                  hits++;
    if (/\btype\b/.test(joined))                        hits++;
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

// Extract two £-prefixed amounts from a smashed cell, e.g. "£48.70 £436.68" or "£6 000.00 £6 027.18"
// Handles space as thousands separator (Revolut Bulgarian format: £6 000.00)
function extractTwoAmounts(s: string): [number, number] | null {
    const matches = s.match(/£\s*\d+(?:[\s,]\d{3})*(?:\.\d{2})?/g);
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
    const statementTotals = extractBgStatementTotals(grid);

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

    // When the full PDF is uploaded, page 1 may produce Azure DI cells from the
    // Revolut Business banner/company header BEFORE the transaction table. Those
    // non-table rows push the actual column header down from table[0].
    // Scan the first 10 rows to locate the real header row.
    let headerIdx = -1;
    for (let i = 0; i < Math.min(table.length, 10); i++) {
        if (isHeaderRow(table[i].cols)) { headerIdx = i; break; }
    }
    const hasHeader = headerIdx >= 0;
    const startAt   = hasHeader ? headerIdx + 1 : 0;
    const headerRow = hasHeader ? table[headerIdx].cols : table[0].cols;
    console.log(`[RevolutParser] cols=${cols} headerIdx=${headerIdx} table[0]=${JSON.stringify(table[0]?.cols?.slice(0,4))} header=${JSON.stringify(headerRow.slice(0,4))}`);
    const isSixCols  = cols === 5;
    const isFiveCols = cols === 4;

    const transactions: ParsedTransaction[] = [];

    // ── 5-col in/out: [date, desc, out, in, balance] ─────────────────────────
    if (isFiveCols && hasHeader && isInOut5Header(headerRow)) {
        for (let i = startAt; i < table.length; i++) {
            const c = table[i].cols;
            const date = parseAnyDate(c[0]);
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
        return { transactions, statementTotals };
    }

    // ── Transaction-statement: [date, "TYPE desc", status, account, out, in] ──
    // Azure DI column positions vary across pages, so for each row we scan
    // right-to-left from col 6→3 for the first parseable £ amount, then use
    // the type code (IN_CODES/OUT_CODES) + "from" keyword for direction.
    if (hasHeader && isTransactionStatement(headerRow)) {
        for (let i = startAt; i < table.length; i++) {
            const c = table[i].cols;
            const date = parseAnyDate(c[0]);
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
        return { transactions, statementTotals };
    }

    // ── 6-col and legacy 5-col ────────────────────────────────────────────────
    // Layout is detected per-row because multi-page documents can mix both
    // (e.g. pages where Azure DI emits 6 cols alternate with pages that only
    //  produce 5 cols).  If c[5] parses as a balance → 6-col; otherwise → legacy 5-col.
    for (let i = startAt; i < table.length; i++) {
        const c = table[i].cols;
        const date = parseAnyDate(c[0]);
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

            // Handle smashed "amount balance" in col 4 when col 3 is empty
            // (Azure DI merges the money-in amount and balance into one col-4 cell)
            if (amountNum === null) {
                const pair4 = extractTwoAmounts(normStr(c[4]));
                if (pair4) { amountNum = pair4[0]; balNum = pair4[1]; }
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

    return { transactions, statementTotals };
}
