// Santander parser — full rewrite matching Make.com module 1475.
// Handles both online-banking exports (DD/MM/YYYY dates, £ X.XX amounts)
// and paper statements ("1st January" dates, year from header).
// Santander Edge Up statements are dispatched to santander-edge.ts.
import {
    Cell, ParsedTransaction, ParseResult,
    buildGrid, maxRow, normStr, extractYearsFromCells, parseDateToDDMMYYYY,
} from './shared.js';
import { parse as parseEdgeUp } from './santander-edge.js';
import { parse as parseBasic } from './santander-basic.js';

// ── Money helpers ──────────────────────────────────────────────────────────────

// Allows optional space after £: "£ 146.49" or "£146.49" or "1,234.56"
function isMoneyText(s: string): boolean {
    return /^-?£?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/.test(normStr(s));
}

function parseMoneyStrict(s: string): number | null {
    if (!isMoneyText(s)) return null;
    const n = Number(normStr(s).replace(/[£,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function parseAbsStrict(s: string): number | null {
    const n = parseMoneyStrict(s);
    return n === null ? null : Math.abs(n);
}

function isLikelyDescFrag(s: string): boolean {
    const x = normStr(s);
    return Boolean(x) && !isMoneyText(x);
}

function isKnownTypeCode(s: string): boolean {
    const x = normStr(s).toUpperCase();
    return x === 'DEBIT' || x === 'ATM';
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function fmt(n: number): string { return n.toFixed(2); }

// ── Date helpers ───────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function monthNum(s: string): number | null {
    const lo = (s || '').toLowerCase();
    return MONTH_MAP[lo.slice(0, 4)] ?? MONTH_MAP[lo.slice(0, 3)] ?? null;
}

const SDATE_RE = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i;

function parseSDate(s: string): { day: number; month: number } | null {
    const m = (s || '').match(SDATE_RE);
    if (!m) return null;
    const day = Number(m[1]);
    const mon = monthNum(m[2]);
    if (!mon || day < 1 || day > 31) return null;
    return { day, month: mon };
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function fmtDate(d: number, m: number, y: number): string { return `${pad2(d)}/${pad2(m)}/${y}`; }

// ── Statement period / year ────────────────────────────────────────────────────

interface Period {
    startMonth: number | null;
    startYear:  number | null;
    endMonth:   number | null;
    endYear:    number | null;
}

const MON_PAT = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DAY_PAT = '\\d{1,2}\\s*(?:st|nd|rd|th)?\\s*';

const PERIOD_RE = new RegExp(
    `Your account summary for\\s+${DAY_PAT}(${MON_PAT})\\s+((?:19|20)\\d{2})?\\s+to\\s+${DAY_PAT}(${MON_PAT})\\s+((?:19|20)\\d{2})`,
    'i'
);

function extractPeriod(text: string): Period {
    const m = text.match(PERIOD_RE);
    if (!m) return { startMonth: null, startYear: null, endMonth: null, endYear: null };
    return {
        startMonth: monthNum(m[1]),
        startYear:  m[2] ? Number(m[2]) : null,
        endMonth:   monthNum(m[3]),
        endYear:    Number(m[4]),
    };
}

function extractStmtYear(text: string, fallback: number): number {
    const p = extractPeriod(text);
    if (p.endYear) return p.endYear;

    let m = text.match(new RegExp(`Your account summary for\\s+${DAY_PAT}(?:${MON_PAT})\\s+((?:19|20)\\d{2})`, 'i'));
    if (m) return Number(m[1]);

    m = text.match(/Statement number:\s*\d+\/((?:19|20)\d{2})/i);
    if (m) return Number(m[1]);

    return fallback;
}

function yearFromPeriod(month: number, p: Period): number {
    if (p.startMonth && p.endMonth && p.endYear && p.startMonth > p.endMonth)
        return month >= p.startMonth ? p.endYear - 1 : p.endYear;
    return p.endYear!;
}

interface YearState { rollingYear: number; prevMonth: number | null; hasRolled: boolean; }

function rollingYear(month: number, s: YearState): number {
    if (s.prevMonth !== null && s.prevMonth >= 11 && month <= 2 && !s.hasRolled) {
        s.rollingYear++;
        s.hasRolled = true;
    }
    s.prevMonth = month;
    return s.rollingYear;
}

// ── Description helpers ────────────────────────────────────────────────────────

function mergeFrag(description: string, frag: string): string {
    let desc = normStr(description);
    frag = normStr(frag).replace(/,+$/, '').trim();
    if (!frag) return desc;
    if (/^MANDATE\s+NO$/i.test(frag) && /,\s*\d{1,5}$/.test(desc))
        return desc.replace(/,\s*(\d{1,5})$/, ', MANDATE NO $1');
    if (/^MANDATE$/i.test(frag) && /\bNO\s+\d{1,5}$/.test(desc))
        return desc.replace(/\bNO\s+(\d{1,5})$/, 'MANDATE NO $1');
    if (/^NO$/i.test(frag) && /\bMANDATE\s+\d{1,5}$/.test(desc))
        return desc.replace(/\bMANDATE\s+(\d{1,5})$/, 'MANDATE NO $1');
    if (/\bREFERENCE\s+MANDATE\s+NO\s*\d+\b/i.test(desc))
        return desc.replace(/\bREFERENCE\s+(MANDATE\s+NO\s*\d+\b)/i, `REFERENCE ${frag}, $1`);
    return normStr(`${desc} ${frag}`);
}

function cleanDesc(desc: string): string {
    let x = normStr(desc);
    x = x
        .replace(/\s+,/g, ',')
        .replace(/,\s*(\d{1,5})\s+MANDATE\s+NO\b/gi, ', MANDATE NO $1')
        .replace(/\b(\d{1,5})\s+MANDATE\s+NO\b/gi, 'MANDATE NO $1')
        .replace(/,\s*NO\s*(\d{1,5})\s+MANDATE\b/gi, ', MANDATE NO $1')
        .replace(/,\s*NO(\d{1,5})\s+MANDATE\b/gi, ', MANDATE NO $1')
        .replace(/\bNO\s*(\d{1,5})\s+MANDATE\b/gi, 'MANDATE NO $1')
        .replace(/\bNO(\d{1,5})\s+MANDATE\b/gi, 'MANDATE NO $1')
        .replace(/\bMANDATE\s+(\d{1,5})\s+NO\b/gi, 'MANDATE NO $1')
        .replace(/\bMANDATE\s+(?!NO\b)(\d{1,5})\b/gi, 'MANDATE NO $1')
        .replace(/\bMANDATE\s+NO\s*(\d{1,5})\b/gi, 'MANDATE NO $1')
        .replace(/\s+,\s*/g, ', ')
        .replace(/,\s*/g, ', ')
        .replace(/,\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return x;
}

function isOpeningBal(desc: string): boolean {
    const x = normStr(desc).toLowerCase();
    return x === 'balance brought forward from previous statement' ||
           x === 'previous statement balance' ||
           x === 'brought forward balance';
}

function isClosingBal(desc: string): boolean {
    const x = normStr(desc).toLowerCase();
    return x.startsWith('balance carried forward') || x === 'current statement balance';
}

function inferDir(desc: string): 'in' | 'out' {
    const x = normStr(desc).toLowerCase();
    if (x.startsWith('faster payments receipt') || x.startsWith('cash deposit') ||
        x.startsWith('interest paid') || x.startsWith('transfer from ') ||
        x.startsWith('bill payment from ') || x.startsWith('payment from ') ||
        x.startsWith('credit from ') || x.startsWith('bank giro credit') ||
        x.includes(' payment from ')) return 'in';
    return 'out';
}

function trailingMoney(desc: string): { description: string; amount: number | null } {
    const x = normStr(desc);
    const m = x.match(/^(.*\S)\s+(-?£?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/);
    if (!m) return { description: x, amount: null };
    return { description: normStr(m[1]), amount: parseAbsStrict(m[2]) };
}

// Try DD/MM/YYYY first (online banking — date includes year).
// Fall back to "1st January" format (paper statement — year tracked separately).
function parseAnyDate(s: string, yearState: YearState, period: Period): string | null {
    const standard = parseDateToDDMMYYYY(s);
    if (standard) return standard;
    const sdate = parseSDate(s);
    if (!sdate) return null;
    const yr = (period.startMonth && period.endMonth && period.endYear)
        ? yearFromPeriod(sdate.month, period)
        : rollingYear(sdate.month, yearState);
    return fmtDate(sdate.day, sdate.month, yr);
}

function dirFromBal(prev: number | null, curr: number | null): 'in' | 'out' | '' {
    if (prev === null || curr === null) return '';
    const d = round2(curr - prev);
    return d > 0 ? 'in' : d < 0 ? 'out' : '';
}

// ── Running balance ────────────────────────────────────────────────────────────

interface RawTxn {
    date: string;
    description: string;
    moneyIn:  number | '';
    moneyOut: number | '';
    _anchor:  number | null;
    balance:  string;
}

function applyBalances(items: RawTxn[], opening: number): void {
    let running = opening;
    for (const t of items) {
        const inn = t.moneyIn  === '' ? 0 : (t.moneyIn  as number);
        const out = t.moneyOut === '' ? 0 : (t.moneyOut as number);
        if (t._anchor !== null) {
            t.balance = fmt(t._anchor);
            running = t._anchor;
        } else {
            const comp = round2(running + inn - out);
            t.balance = fmt(comp);
            running = comp;
        }
    }
}

// ── Main export ────────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    // Route to dedicated parsers based on statement type
    const allTextFull = cells.map(c => c.content).join(' ');
    if (/\bEdge\s+Up\b/i.test(allTextFull) || /^Santander\s+Edge\b/im.test(allTextFull)) {
        return parseEdgeUp(cells);
    }
    // Basic Account: paper-style statements with ordinal dates and Total money in/out summary.
    // "Basic Account" label is in non-table OCR text (not in cells), so detect by format cues.
    if (/total money in:/i.test(allTextFull) || /\bBasic\s+Account\b/i.test(allTextFull) || /\bBasic\s+Top-up\s+Debit\s+Card\b/i.test(allTextFull)) {
        return parseBasic(cells);
    }

    const grid = buildGrid(cells);
    const rows = maxRow(cells);

    const allText   = cells.map(c => c.content).join(' ');
    const period    = extractPeriod(allText);
    const years     = extractYearsFromCells(cells);
    const fallback  = years[0] ?? new Date().getFullYear();
    const stmtYear  = period.endYear ? period.endYear : extractStmtYear(allText, fallback);

    const yrState: YearState = { rollingYear: stmtYear, prevMonth: null, hasRolled: false };

    // ── Column detection ───────────────────────────────────────────────────────
    // Search ALL rows for the best transaction-table header. Score each candidate:
    //   +1 for Date, +1 for Description, +2 for Money in, +2 for Money out, +1 for Balance.
    // This handles statements where a cover/interest page precedes the real table, so the
    // correct header is on page 2 (row index ~10000+) rather than page 1.
    let dateCol = 0, descCol = 2;
    let inCol: number | null = null, outCol: number | null = null, balCol: number | null = null;
    let headerRow = -1;
    let firstHeaderRow = -1;  // earliest valid header row (may differ from best-scored)
    let bestHeaderScore = 0;

    for (let r = 0; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;
        const joined = [...row.values()].join(' ').toLowerCase();
        if (!joined.includes('date') && !joined.includes('description')) continue;

        let score = 0;
        let tDateCol = 0, tDescCol = 2;
        let tInCol: number | null = null, tOutCol: number | null = null, tBalCol: number | null = null;

        for (const [c, v] of row) {
            const lo = v.toLowerCase();
            if (/^date$/.test(lo) || (lo.includes('date') && c <= 1)) { score += 1; tDateCol = c; }
            else if (/\bdescription\b/.test(lo)) { score += 1; tDescCol = c; }
            else if (/^money\s*in$/.test(lo) || /^credits?$/.test(lo)) { score += 2; tInCol = c; }
            else if (/^money\s*out$/.test(lo) || /^debits?$/.test(lo)) { score += 2; tOutCol = c; }
            else if (/^£?\s*balance$/.test(lo)) { score += 1; tBalCol = c; }
        }

        // Track the earliest row that looks like a real transaction header (score ≥ 4).
        // This lets multi-page statements (compact 5-col on page 2, full 6-col on page 3)
        // include all transactions rather than skipping the earlier page.
        if (score >= 4 && firstHeaderRow === -1) firstHeaderRow = r;

        if (score > bestHeaderScore) {
            bestHeaderScore = score;
            headerRow = r;
            dateCol = tDateCol; descCol = tDescCol;
            inCol = tInCol; outCol = tOutCol; balCol = tBalCol;
        }
        // Perfect header (all money columns found) — stop searching
        if (tInCol !== null && tOutCol !== null && tBalCol !== null) break;
    }

    // Start from the EARLIEST valid header so we don't skip transactions on an earlier
    // page when a higher-scoring header appears on a later page.
    const firstValidHeader = firstHeaderRow >= 0 ? firstHeaderRow : headerRow;
    const startRow = firstValidHeader >= 0 ? firstValidHeader + 1 : 0;

    // ── Row loop ───────────────────────────────────────────────────────────────
    let openingBalance = 0;
    let lastBalance: number | null = null;
    const rawTxns: RawTxn[] = [];
    let lastPushed: RawTxn | null = null;

    for (let r = startRow; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;
        const keys = [...row.keys()];
        if (!keys.length) continue;
        const maxC = Math.max(...keys);

        const v: string[] = [];
        for (let c = 0; c <= maxC; c++) v[c] = normStr(row.get(c) ?? '');

        const dateText = v[dateCol] ?? '';
        const dateStr = parseAnyDate(dateText, yrState, period);
        if (!dateStr) {
            // No date — continuation row for the previous transaction, or an opening-balance row.
            if (lastPushed) {
                // (a) description continuation: date row had no description, next row has text
                const cont = normStr(v[1] ?? '');
                const isHeaderWord = /^(date|description(\s+money\s+in)?|money\s+(in|out)|balance)$/i.test(cont);
                if (!lastPushed.description && cont && !isMoneyText(cont) && !isHeaderWord) {
                    lastPushed.description = cleanDesc(cont);
                }
                // (b) amount continuation: date row had no amounts, next row has Credits/Debits
                if (lastPushed.moneyIn === '' && lastPushed.moneyOut === '') {
                    const contIn  = inCol  !== null ? parseAbsStrict(v[inCol]  ?? '') : null;
                    const contOut = outCol !== null ? parseAbsStrict(v[outCol] ?? '') : null;
                    if (contIn  !== null) lastPushed.moneyIn  = contIn;
                    if (contOut !== null) lastPushed.moneyOut = contOut;
                    // Balance may also be on continuation when absent from the date row
                    if (lastPushed._anchor === null && balCol !== null) {
                        const contBal = parseMoneyStrict(v[balCol] ?? '');
                        if (contBal !== null) lastPushed._anchor = contBal;
                    }
                }
            } else if (balCol !== null) {
                // No transactions yet — check for opening balance row with no date
                // (Santander Business format: "Previous statement balance" in description col)
                const descText = normStr(v[descCol] ?? '');
                if (isOpeningBal(descText)) {
                    const ob = parseMoneyStrict(v[balCol] ?? '');
                    if (ob !== null) { openingBalance = ob; lastBalance = ob; }
                }
            }
            continue;
        }

        // ── Description ────────────────────────────────────────────────────────
        const col1 = v[1] ?? '';
        const col2 = v[2] ?? '';
        const descVal = v[descCol] ?? '';

        let typeCode = '';
        let description = '';

        if (descVal && !isMoneyText(descVal)) {
            if (isKnownTypeCode(descVal)) { typeCode = descVal; description = (col2 && !isMoneyText(col2)) ? col2 : ''; }
            else description = descVal;
        } else if (isKnownTypeCode(col1) && col2 && !isMoneyText(col2)) {
            typeCode = col1; description = col2;
        } else if (col1 && !isKnownTypeCode(col1) && !isMoneyText(col1)) {
            description = col1;
        } else if (col2 && !isMoneyText(col2)) {
            description = col2;
        }

        // ── Money columns — per-row layout detection ──────────────────────────
        // When the header scan found explicit Money in/out column indices, use them
        // directly (handles 6-col statements: Date|Type|Desc|MoneyIn|MoneyOut|Balance).
        // Otherwise fall back to heuristics based on column count.
        let inRaw  = '';
        let outRaw = '';
        let bRaw   = '';

        // Only use detected header columns when the row actually has enough columns.
        // A 5-col header (inCol=2, outCol=3, balCol=4) found on one page must not be
        // applied to 4-col rows (maxC=3) on other pages — that would read Balance as MoneyOut.
        const minRequired = Math.max(outCol ?? 0, balCol ?? 0, inCol ?? 0);
        if (inCol !== null && outCol !== null && maxC >= minRequired) {
            inRaw  = v[inCol]  ?? '';
            outRaw = v[outCol] ?? '';
            bRaw   = balCol !== null ? (v[balCol] ?? '') : '';
        } else if (maxC >= 4) {
            const v2 = v[2] ?? '';
            // Skip v[2] as inRaw when it was already captured as the description
            // (compact Santander layout: v[2] = desc for money-out, amount for money-in).
            inRaw  = (v2 !== '' && v2 === description) ? '' : v2;
            outRaw = v[3] ?? '';
            bRaw   = v[4] ?? '';
        } else if (maxC === 3) {
            const col2Val = v[2] ?? '';
            bRaw = v[3] ?? '';

            if (!col2Val.trim()) {
                // col2 (Money Out) is empty → incoming transaction variant
                const col1Val = v[1] ?? '';
                if (isMoneyText(col1Val)) {
                    // Variant b: col1 is a bare money amount; description follows on next row
                    inRaw = col1Val;
                } else {
                    // Variant a: amount is embedded inside the description string
                    const m = description.match(/£\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/);
                    if (m) {
                        const embedded = m[0];
                        description = description.replace(embedded, '').replace(/\s+/g, ' ').trim();
                        if (inferDir(description) === 'in') inRaw  = embedded;
                        else                                outRaw = embedded;
                    }
                }
            } else if (isMoneyText(col2Val)) {
                if (inferDir(description) === 'in') inRaw  = col2Val;
                else                                outRaw = col2Val;
            }
        } else if (maxC === 2) {
            bRaw = v[2] ?? '';
        }

        // Text fragments accidentally in money cols → merge into description
        if (isLikelyDescFrag(inRaw))  { description = mergeFrag(description, inRaw);  inRaw  = ''; }
        if (isLikelyDescFrag(outRaw)) { description = mergeFrag(description, outRaw); outRaw = ''; }

        description = cleanDesc(description);

        if (isOpeningBal(description)) {
            const ob = parseMoneyStrict(bRaw);
            if (ob !== null) { openingBalance = ob; lastBalance = ob; }
            continue;
        }
        if (isClosingBal(description)) continue;

        const anchor = parseMoneyStrict(bRaw);
        const moneyIn  = parseAbsStrict(inRaw);
        const moneyOut = parseAbsStrict(outRaw);

        // Skip only if no amounts AND no description — rows with description but no
        // amounts are kept as "pending"; a continuation row will fill in the amounts.
        if (moneyIn === null && moneyOut === null && !description && !typeCode) continue;

        const txn: RawTxn = {
            date:        dateStr,
            description: cleanDesc([typeCode, description].filter(Boolean).join(' ')),
            moneyIn:     moneyIn  ?? '',
            moneyOut:    moneyOut ?? '',
            _anchor:     anchor,
            balance:     '',
        };
        rawTxns.push(txn);
        lastPushed = txn;

        if (anchor !== null) lastBalance = anchor;
    }

    // ── Finalize ───────────────────────────────────────────────────────────────
    applyBalances(rawTxns, openingBalance);

    // ── Extract statement totals from summary lines (first-page text) ──────────
    // Santander PDFs always have a summary block: "Balance brought forward...",
    // "Total credits:", "Total debits:", "Your balance at close of business..."
    // These are more reliable than summing parsed transactions (which may miss
    // rows that Azure DI failed to extract).
    let statementTotals: ParseResult['statementTotals'] | undefined;
    const summaryText = cells.find(c => c.rowIndex === -1)?.content ?? allText ?? '';
    const summaryOpenM  = summaryText.match(/Balance brought forward from[^£]*£\s*([\d,]+\.?\d*)/i);
    const summaryCloseM = summaryText.match(/Your balance at close of business[^£]*£\s*([\d,]+\.?\d*)/i);
    const summaryCredM  = summaryText.match(/Total credits?:\s*£?\s*([\d,]+\.?\d*)/i);
    const summaryDebM   = summaryText.match(/Total debits?:\s*-?£?\s*([\d,]+\.?\d*)/i);
    const summaryOpen   = summaryOpenM  ? parseFloat(summaryOpenM[1].replace(/,/g,''))  : null;
    const summaryClose  = summaryCloseM ? parseFloat(summaryCloseM[1].replace(/,/g,'')) : null;
    const summaryCred   = summaryCredM  ? parseFloat(summaryCredM[1].replace(/,/g,''))  : null;
    const summaryDeb    = summaryDebM   ? parseFloat(summaryDebM[1].replace(/,/g,''))   : null;
    if (summaryOpen !== null || summaryClose !== null || summaryCred !== null) {
        statementTotals = {
            openingBalance: summaryOpen  ?? undefined,
            closingBalance: summaryClose ?? undefined,
            moneyIn:        summaryCred  ?? 0,
            moneyOut:       summaryDeb   ?? 0,
        } as any;
    }

    // Santander Business Account PDFs list transactions oldest-first (ascending).
    return {
        ascending: true as boolean,
        statementTotals,
        transactions: rawTxns
            .filter(t => t.date && t.description && (t.moneyIn !== '' || t.moneyOut !== ''))
            .map(t => ({
                date:        t.date,
                type:        '',
                description: t.description,
                moneyIn:     t.moneyIn  !== '' ? fmt(t.moneyIn  as number) : '',
                moneyOut:    t.moneyOut !== '' ? fmt(t.moneyOut as number) : '',
                balance:     t.balance,
            })),
    };
}
