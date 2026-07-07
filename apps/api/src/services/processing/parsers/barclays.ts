// Barclays parser — two layout variants detected from document content:
//   Premier BK AC : 5-col format, direction-by-sign money gate
//   Normal Layout : 4-col format, OCR fixup, posting-date grouping, raw-text date fallback
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney,
    buildGrid, getCell, maxCol, extractYearsFromCells,
} from './shared.js';

// ── Footer text stripping ────────────────────────────────────────────────────
// Strips Barclays legal, interest-rate, and contact-section text.
// Uses \s* (not \s+) so it truncates even when the footer starts at position 0
// (standalone footer cell, not just appended continuation text).
const FOOTER_TRUNCATE_RE = /\s*(?:if\s+your\s+account\s+pays\s+interest|the\s+statement\s+balance\s+or\s+the\s+cleared\s+balance|if\s+you\s+use\s+your\s+overdraft\s+facilit|if\s+you\s+need\s+to\s+transfer\s+money\s+between\s+countries|barclays\.co\.uk\/|(?:our\s+)?bank\s+charges\s+explained|tailor\s+the\s+alerts\s+you\s+receive|you\s+can\s+also\s+tailor\s+the\s+alerts|if\s+you\s+don.t\s+get\s+these\s+messages|(?:in\s+the\s+uk[)\s]|we.ll\s+charge\s+you\s+a\s+\d)|0345\s+7\s+345\s+345|open\s+24\/7\s+including\s+holidays|from\s+abroad\s+\+44|write\s+to\s+us\s+barclays|(?:names?\s+are\s+)?part\s+of\s+barclays|barclays\s+business\s+banking[,\s]+barclays\s+premier|barclays\s+premier\s+banking).*/i;

function stripFooterText(desc: string): string {
    return normStr(desc.replace(FOOTER_TRUNCATE_RE, ''));
}

// ── Constants ────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

const SKIP_RE          = /\b(start\s+balance|opening\s+balance|balance\s+brought\s+forward|brought\s+forward|starting\s+balance)\b/i;
const FOOTER_RE        = /\b(if\s+you\s+have\s+a\s+problem\s+with\s+your|compensation\s+to\s+depositors|financial\s+services\s+compensation\s+scheme|fscs\s+protect|protected\s+by\s+the\s+fscs|depositor\s+protection|transferring\s+money\s+between\s+countries|most\s+depositors|financial\s+ombudsman\s+service|credit\s+interest\s+rate.*shown\s+on\s+your\s+statement|unarranged\s+borrowing\s+rate|part\s+of\s+barclays\s*[:,]|names?\s+are\s+part\s+of\s+barclays|barclays\s+business\s+banking[,\s]+barclays\s+premier|barclays\s+premier\s+banking[,\s]+barclays\s+wealth|tesco\s+bank\s+(?:are\s+all\s+trading|tel[\s:])|if\s+your\s+account\s+pays\s+interest|the\s+statement\s+balance\s+or\s+the\s+cleared\s+balance|if\s+you\s+use\s+your\s+overdraft\s+facilit|if\s+you\s+need\s+to\s+transfer\s+money\s+between\s+countries|barclays\.co\.uk\/|bank\s+charges\s+explained|tailor\s+the\s+alerts\s+you\s+receive|if\s+you\s+don.t\s+get\s+these\s+messages|we.ll\s+charge\s+you\s+a\s+\d|our\s+main\s+number\s+\d|lost\s+and\s+stolen\s+cards|online\s+banking\s+help|open\s+24\/7\s+including\s+holidays|from\s+abroad\s+\+44|write\s+to\s+us\s+barclays)\b/i;
const CARRIED_FWD_RE   = /\b(balance\s+carried\s+forward|carried\s+forward)\b/i;
const TOTAL_RE         = /\b(total\s+payments[\/\\]receipts|total\s+payments|end\s+balance)\b/i;
const NEW_TXN_RE       = /^(card\s+purchase|card\s+payment|internet\s+banking\s+transfer|on-line\s+banking\s+bill\s+payment|giro\s+direct\s+credit|direct\s+credit|atm\s+cash\s+machine|cash\s+machine\s+withdrawal|direct\s+debit|standing\s+order|refund\s+from|transfer\s+from|asd\s+withdrawal)\b/i;
// Reasonable upper bound for a single transaction on a personal/SME account.
// Amounts above this are almost certainly OCR garbage (footnotes, phone numbers, etc.)
const MAX_SANE_AMOUNT  = 1_000_000;

// ── Shared helpers ───────────────────────────────────────────────────────────

function fixOCR(s: string): string {
    return s
        .replace(/\b(\d{1,2})\s+un\b\s*»?\)?/gi, '$1 Jun')
        .replace(/\b(\d{1,2})\s+Ju[nm]\b\s*»?\)?/gi, '$1 Jun')
        .replace(/^\s*»\)?\s*/gm, '');
}

// Azure DI marks PDF checkboxes as :selected: / :unselected:
// Also strip leading OCR noise before known Barclays transaction keywords.
// Uses a lookahead so we only strip artefacts that precede a recognisable transaction type,
// which avoids accidentally truncating merchant names (e.g. "B & Q", "7-Eleven").
function cleanSelected(s: string): string {
    return s
        .replace(/:(un)?selected:/gi, ' ')
        .replace(
            /^\s*(?:[=[\]()%]+\s*|\d{1,3}\s+|[A-Z]\s+|£\s+)(?=(?:card|dd|direct|giro|atm|internet|on[- ]line|bill|commission|interest|cash|transfer|standing|refund|asd|visa|unpaid|businesscall)\b)/i,
            '',
        )
        .replace(/\s+/g, ' ')
        .trim();
}

// Find the start year for the statement, ignoring bare 4-digit years in company/account names.
// Priority order:
//   1. Full range "DD Mon YYYY - DD Mon YYYY" → first year
//   2. Abbreviated range "DD Mon - DD Mon YYYY" (Barclays "at a glance" summary)
//      → derive start year from end year, adjusting back 1 if start month > end month (Dec→Jan)
//   3. Fallback: minimum year in any proper date context
// Commission-charge descriptions like "15 Dec 2025/12 Jan 2026" use "/" not "-" so they
// never match patterns 1 or 2 and don't poison the fallback minimum.
function extractStartYearFromContent(content: string): number | null {
    // 1. Full range
    const fullRe = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{4})\s*[-–]\s*\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\b/gi;
    const fm = fullRe.exec(content);
    if (fm) {
        const y = Number(fm[3]);
        if (y >= 2020 && y <= 2099) return y;
    }
    // 2. Abbreviated range (e.g. "31 Jan - 27 Feb 2026")
    const abbRe = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[-–]\s*\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{4})\b/gi;
    const am = abbRe.exec(content);
    if (am) {
        const startMon = MONTH_MAP[am[2].slice(0, 3).toLowerCase()];
        const endMon   = MONTH_MAP[am[3].slice(0, 3).toLowerCase()];
        const endYear  = Number(am[4]);
        if (startMon && endMon && endYear >= 2020 && endYear <= 2099) {
            return startMon > endMon ? endYear - 1 : endYear;
        }
    }
    // 3. Minimum year in any proper date context
    const re = /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{4})\b/gi;
    let min: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const y = Number(m[1]);
        if (y >= 2020 && y <= 2099 && (min === null || y < min)) min = y;
    }
    return min;
}

// Extract column mapping from a header row (shared by initial detection and mid-data re-detection)
function extractColMap(hdr: string[]): { date: number; desc: number; out: number; in: number; bal: number } | null {
    const joined = hdr.join(' ').toLowerCase();
    if (!joined.includes('description') && !joined.includes('date')) return null;
    if (!joined.includes('money out') && !joined.includes('debit') && !joined.includes('balance')) return null;

    let COL = { date: 0, desc: 1, out: 2, in: 3, bal: 4 };
    for (let c = 0; c < hdr.length; c++) {
        const v = hdr[c].toLowerCase();
        if (v.includes('date') && !v.includes('description'))       COL.date = c;
        else if (v.includes('description') && !v.includes('money'))  COL.desc = c;
        else if (v.includes('money out') || v.includes('debit'))     COL.out  = c;
        else if (v.includes('balance')) {
            COL.bal = c;
            if (v.includes('money in') || v === 'in balance') COL.in = c + 1;
        }
        else if (v.includes('money in') || v.includes('credit'))     COL.in   = c;
    }
    for (let c = 0; c < hdr.length; c++) {
        const v = hdr[c].toLowerCase();
        if (v.includes('description') && v.includes('money out')) { COL.desc = c; COL.out = c; }
    }
    if (!hdr.some(h => h.toLowerCase().includes('date'))) COL.date = 0;
    if (COL.out === COL.in) COL.out = -1;
    return COL;
}

function fmtDate(d: number, m: number, y: number): string {
    return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}

// Always calls resolveYear to keep flow-tracking state updated.
function parseBarcDate(s: string, resolveYear: (mon: number) => number): string {
    s = normStr(s).replace(/\s*([\\/.\-])\s*/g, '$1');
    if (!s) return '';

    let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?$/);
    if (m) {
        const day = Number(m[1]);
        const mon = MONTH_MAP[m[2].slice(0,3).toLowerCase()];
        if (!mon || day < 1 || day > 31) return '';
        const inferred = resolveYear(mon);
        const year = m[3] ? Number(m[3]) : inferred;
        return fmtDate(day, mon, year);
    }

    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) {
        let d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
        if (y < 100) y = y <= 69 ? 2000+y : 1900+y;
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
        return fmtDate(d, mo, y);
    }

    return '';
}

interface PhysRow {
    date:     string;
    desc:     string;
    moneyOut: number | null;
    moneyIn:  number | null;
    balance:  number | null;
}

function hasMovement(r: PhysRow): boolean {
    return (r.moneyIn !== null && r.moneyIn > 0) || (r.moneyOut !== null && r.moneyOut > 0);
}

// Two-pass stitcher used by Premier variant.
function stitch(physical: PhysRow[]): PhysRow[] {
    const txns: PhysRow[] = [];
    let pending: PhysRow | null = null;
    const flush = () => { if (pending) { if (hasMovement(pending)) txns.push(pending); pending = null; } };

    for (const r of physical) {
        const mv    = hasMovement(r);
        const noAmt = r.moneyIn === null && r.moneyOut === null && r.balance === null;

        // A: text-only continuation
        if (!mv && r.desc && noAmt) {
            if (pending) {
                pending.desc = [pending.desc, r.desc].filter(Boolean).join(' ').trim();
            } else if (txns.length) {
                const l = txns[txns.length-1];
                l.desc = [l.desc, r.desc].filter(Boolean).join(' ').trim();
            }
            continue;
        }
        // B: amounts, no desc → fill pending
        if (mv && !r.desc && pending) {
            if (pending.moneyIn  === null) pending.moneyIn  = r.moneyIn;
            if (pending.moneyOut === null) pending.moneyOut = r.moneyOut;
            if (pending.balance  === null) pending.balance  = r.balance;
            flush(); continue;
        }
        // C: desc, no amounts → start pending
        if (r.desc && !mv) { flush(); pending = { ...r, moneyIn: null, moneyOut: null }; continue; }
        // D: desc + amounts
        if (r.desc && mv) {
            if (pending && !hasMovement(pending)) {
                pending.desc     = [pending.desc, r.desc].filter(Boolean).join(' ').trim();
                pending.moneyIn  = r.moneyIn;
                pending.moneyOut = r.moneyOut;
                if (r.balance !== null) pending.balance = r.balance;
                flush(); continue;
            }
            flush(); txns.push({ ...r });
        }
    }
    flush();
    return txns;
}

// Bottom-to-top balance backfill used by Premier variant.
function backfillBalance(txns: PhysRow[]): void {
    let curr: number | null = null;
    for (let i = txns.length-1; i >= 0; i--) {
        const t = txns[i];
        if (t.balance !== null) { curr = t.balance; continue; }
        if (curr === null) continue;
        const inA = t.moneyIn ?? 0, outA = t.moneyOut ?? 0;
        if (!inA && !outA) continue;
        t.balance = curr - inA + outA;
        curr = t.balance;
    }
}

function toTransactions(txns: PhysRow[]): ParsedTransaction[] {
    return txns.flatMap(t => {
        const moneyIn  = (t.moneyIn  ?? 0) > 0 ? formatMoney(t.moneyIn!)  : '';
        const moneyOut = (t.moneyOut ?? 0) > 0 ? formatMoney(t.moneyOut!) : '';
        if (!moneyIn && !moneyOut) return [];
        return [{
            date:        t.date,
            type:        '',
            description: t.desc || 'Unknown',
            moneyIn,
            moneyOut,
            balance:     t.balance !== null ? t.balance.toFixed(2) : '',
        }];
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANT 1 — Premier BK AC
// 5-col: [date, description, money_out, money_in, balance]
// Direction-by-sign gate: negative value in any money col → moneyOut
// ═══════════════════════════════════════════════════════════════════════════════

function isPremierHeader(cols: string[]): boolean {
    const j = cols.join(' ').toLowerCase();
    let hits = 0;
    if (/\bdate\b/.test(j))              hits++;
    if (/description/.test(j))          hits++;
    if (/money\s*out|out|debit/.test(j)) hits++;
    if (/money\s*in|in|credit/.test(j))  hits++;
    if (/balance/.test(j))              hits++;
    return hits >= 3;
}

function detectInOutCols(h: string[]): { inIdx: number; outIdx: number } {
    let inIdx = 3, outIdx = 2;
    for (let i = 0; i < h.length; i++) {
        const v = h[i].toLowerCase();
        if (v.includes('money in')  || v === 'in'  || v.includes('credit')) inIdx  = i;
        if (v.includes('money out') || v === 'out' || v.includes('debit'))  outIdx = i;
    }
    if (inIdx === outIdx) { inIdx = 3; outIdx = 2; }
    return { inIdx, outIdx };
}

function parsePremier(cells: Cell[]): ParseResult {
    const rawCtx  = cells.find(c => c.rowIndex < 0)?.content ?? '';
    const availYears = extractYearsFromCells(cells);
    let curYear = extractStartYearFromContent(rawCtx) ?? availYears[0] ?? new Date().getFullYear();
    let lastMon: number | null = null;
    const resolveYear = (mon: number): number => {
        if (lastMon !== null && mon < lastMon) curYear++;
        lastMon = mon; return curYear;
    };

    const grid    = buildGrid(cells);
    const nCols   = maxCol(cells);
    const rowIdxs = [...grid.keys()].filter(r => r >= 0).sort((a,b) => a-b);
    const table   = rowIdxs.map(r => {
        const row: string[] = [];
        for (let c = 0; c <= nCols; c++) row.push(normStr(getCell(grid, r, c)));
        return row;
    });
    if (!table.length) return { transactions: [] };

    let startAt = 0, inIdx = 3, outIdx = 2;
    for (let i = 0; i < table.length; i++) {
        if (isPremierHeader(table[i])) {
            startAt = i + 1;
            ({ inIdx, outIdx } = detectInOutCols(table[i]));
            break;
        }
    }

    const physical: PhysRow[] = [];
    let lastDate = '';

    for (let i = startAt; i < table.length; i++) {
        const cols = table[i];
        if (cols.every(c => !c)) continue;

        const pd = parseBarcDate(cols[0], resolveYear);
        if (pd) lastDate = pd;

        const desc = normStr(cols[1]);
        if (SKIP_RE.test(desc) || CARRIED_FWD_RE.test(desc) || TOTAL_RE.test(desc) || FOOTER_RE.test(desc)) continue;

        // Direction-by-sign gate: parseMoney preserves sign for negative inputs
        const osVal = parseMoney(cols[outIdx] ?? '');
        const isVal = parseMoney(cols[inIdx]  ?? '');
        let moneyOut: number | null = null;
        let moneyIn:  number | null = null;

        if (osVal !== null) { if (osVal < 0) moneyOut = Math.abs(osVal); else if (osVal > 0) moneyIn = osVal; }
        if (isVal !== null) { if (isVal < 0) moneyOut = Math.abs(isVal); else if (isVal > 0) moneyIn = isVal; }

        // Fallback: no sign info → classic column mapping (absolute values)
        if (moneyOut === null && moneyIn === null) {
            moneyOut = osVal !== null && Math.abs(osVal) > 0 ? Math.abs(osVal) : null;
            moneyIn  = isVal !== null && Math.abs(isVal) > 0 ? Math.abs(isVal) : null;
        }

        physical.push({ date: pd || lastDate, desc, moneyOut, moneyIn, balance: parseMoney(cols[4] ?? '') });
    }

    const txns = stitch(physical);
    backfillBalance(txns);
    const transactions = toTransactions(txns);
    for (const t of transactions) t.description = stripFooterText(t.description);
    return { transactions, ascending: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANT 2 — Normal Layout
// 4-col: [date, description, money_out, money_in/balance]
// OCR fixup, posting-date groups, raw-text date fallback, sequential balance
// ═══════════════════════════════════════════════════════════════════════════════

function rawDateFallback(desc: string, rawText: string, resolveYear: (mon: number) => number): string {
    if (!rawText || !desc) return '';
    const key    = desc.toLowerCase().slice(0, 50);
    const rawLow = rawText.toLowerCase();
    const pos    = rawLow.indexOf(key);
    if (pos === -1) return '';

    const before = rawLow.slice(0, pos);
    const re     = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/gi;
    let lastDate = '';
    let m: RegExpExecArray | null;

    while ((m = re.exec(before)) !== null) {
        const prev = before.slice(Math.max(0, m.index - 5), m.index);
        if (/\bon\s*$/.test(prev)) continue; // skip narrative dates ("paid on 3 Jan")
        const day = Number(m[1]);
        const mon = MONTH_MAP[m[2].slice(0,3)];
        if (!mon || day < 1 || day > 31) continue;
        lastDate = fmtDate(day, mon, resolveYear(mon));
    }
    return lastDate;
}

function parseNormal(cells: Cell[]): ParseResult {
    const rawContent = fixOCR(cells.find(c => c.rowIndex < 0)?.content ?? '');

    const availYears = extractYearsFromCells(cells);
    let curYear = extractStartYearFromContent(rawContent) ?? availYears[0] ?? new Date().getFullYear();
    let lastMon: number | null = null;
    const resolveYear = (mon: number): number => {
        if (lastMon !== null && mon < lastMon) curYear++;
        lastMon = mon; return curYear;
    };

    const grid    = buildGrid(cells);
    const nCols   = maxCol(cells);
    const rowIdxs = [...grid.keys()].filter(r => r >= 0).sort((a,b) => a-b);
    const table   = rowIdxs.map(r => {
        const row: string[] = [];
        for (let c = 0; c <= nCols; c++) row.push(normStr(fixOCR(getCell(grid, r, c))));
        return row;
    });
    if (!table.length) return { transactions: [] };

    // ── Initial column detection (first header row) ───────────────────────────
    let startAt = 0;
    let COL = { date: 0, desc: 1, out: 2, in: 3, bal: 4 };

    for (let i = 0; i < table.length; i++) {
        const mapped = extractColMap(table[i]);
        if (mapped) { COL = mapped; startAt = i + 1; break; }
    }

    const gv = (row: string[], idx: number) => idx >= 0 && idx < row.length ? row[idx] : '';

    // ── Main pass ─────────────────────────────────────────────────────────────
    const physical: PhysRow[] = [];
    let prevDate          = '';
    let activePostingDate = '';
    let initialBalance: number | null = null;

    for (let i = startAt; i < table.length; i++) {
        const row = table[i];

        // Re-detect column mapping when a page header row appears mid-data
        // (happens when the whole encrypted PDF is sent as one chunk to Azure DI)
        const remapped = extractColMap(row);
        if (remapped) { COL = remapped; continue; }

        let moneyIn  = COL.in  >= 0 ? parseMoney(gv(row, COL.in))  : null;
        let moneyOut = COL.out >= 0 ? parseMoney(gv(row, COL.out)) : null;
        let balance  = parseMoney(gv(row, COL.bal));
        const dateCell = gv(row, COL.date);

        // Barclays personal layout uses explicit sign via dedicated Money in / Money out columns.
        // Negative values in either column are a sign error — flip to positive in correct column.
        if (moneyOut !== null && moneyOut < 0) { moneyIn  = (moneyIn  === null) ? Math.abs(moneyOut) : moneyIn;  moneyOut = null; }
        if (moneyIn  !== null && moneyIn  < 0) { moneyOut = (moneyOut === null) ? Math.abs(moneyIn)  : moneyOut; moneyIn  = null; }

        // Clamp unreasonably large amounts and balances (phone numbers, reference codes in
        // footer sections can land in money/balance columns and corrupt the running balance).
        if (moneyIn  !== null && Math.abs(moneyIn)  > MAX_SANE_AMOUNT) moneyIn  = null;
        if (moneyOut !== null && Math.abs(moneyOut) > MAX_SANE_AMOUNT) moneyOut = null;
        if (balance  !== null && Math.abs(balance)  > MAX_SANE_AMOUNT) balance  = null;

        const movement = (moneyIn ?? 0) > 0 || (moneyOut ?? 0) > 0;

        // Skip rows with unreasonably large amounts (footnotes, phone numbers, etc.)
        if ((moneyIn ?? 0) > MAX_SANE_AMOUNT || (moneyOut ?? 0) > MAX_SANE_AMOUNT) continue;

        let parsedDate = parseBarcDate(dateCell, resolveYear);

        // Build description from non-money, non-date columns
        const descParts: string[] = [];
        for (let c = 0; c < row.length; c++) {
            if (!row[c]) continue;
            const isMoneyCol = [COL.out, COL.in, COL.bal].includes(c);
            if (c === COL.date) {
                if (parsedDate) {
                    const rest = normStr(row[c].replace(/^\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{4})?\s*/, ''));
                    if (rest && !isMoneyCol) descParts.push(rest);
                } else if (!isMoneyCol) {
                    descParts.push(row[c]);
                }
                continue;
            }
            if (!isMoneyCol) descParts.push(row[c]);
        }
        // Strip checkbox OCR artefacts (:selected: / :unselected:)
        let desc = cleanSelected(descParts.filter(Boolean).join(' ').trim());

        // Leading date embedded in description
        if (!parsedDate && desc) {
            const m = desc.match(/^(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?\s+/);
            if (m) {
                const dp = parseBarcDate(`${m[1]} ${m[2]}${m[3] ? ' '+m[3] : ''}`, resolveYear);
                if (dp) { parsedDate = dp; desc = normStr(desc.replace(m[0], '')); }
            }
        }

        // Active posting-date group: rows without a date inherit the last seen date
        if (parsedDate) {
            activePostingDate = parsedDate;
        } else if (activePostingDate) {
            parsedDate = activePostingDate;
        }

        // Skip checks BEFORE rawDateFallback: rawDateFallback scans raw text and may
        // advance the year counter as a side effect; skip rows never need date fallback.
        // ── Skip: brought forward / opening balance ───────────────────────────
        if (SKIP_RE.test(desc) || SKIP_RE.test(dateCell)) {
            const bal = balance ?? (moneyIn !== null ? moneyIn : moneyOut);
            if (bal !== null) initialBalance = bal;
            if (parsedDate) { prevDate = parsedDate; activePostingDate = parsedDate; }
            continue;
        }
        // ── Skip: carried forward ─────────────────────────────────────────────
        if (CARRIED_FWD_RE.test(desc)) {
            if (balance !== null) initialBalance = initialBalance ?? balance;
            if (parsedDate) { prevDate = parsedDate; activePostingDate = parsedDate; }
            continue;
        }
        // ── Skip: totals / end balance ────────────────────────────────────────
        if (TOTAL_RE.test(desc) || FOOTER_RE.test(desc)) continue;

        // Raw text fallback (last resort)
        if (!parsedDate && desc) {
            const rd = rawDateFallback(desc, rawContent, resolveYear);
            if (rd) { parsedDate = rd; activePostingDate = rd; }
        }

        if (parsedDate) prevDate = parsedDate;

        // ── Amount-only row (no date cell, no desc) → attach to previous ─────
        if (!dateCell && !desc && (moneyIn !== null || moneyOut !== null || balance !== null)) {
            if (physical.length > 0) {
                const prev = physical[physical.length - 1];
                if (!prev.moneyIn  && moneyIn  !== null) prev.moneyIn  = moneyIn;
                if (!prev.moneyOut && moneyOut !== null) prev.moneyOut = moneyOut;
                if (balance !== null) prev.balance = balance;
            } else if (balance !== null) {
                initialBalance = balance;
            }
            continue;
        }

        // ── Fully empty row ───────────────────────────────────────────────────
        if (!movement && !dateCell && !desc) {
            if (balance !== null && physical.length === 0) initialBalance = balance;
            continue;
        }

        // ── Recognisable transaction keyword without date/amounts → new txn ──
        if (!dateCell && !movement && desc && NEW_TXN_RE.test(desc)) {
            physical.push({ date: parsedDate || prevDate, desc, moneyIn, moneyOut, balance });
            continue;
        }

        // ── Continuation line (no date, no movement) ──────────────────────────
        if (!dateCell && !movement && desc) {
            if (physical.length > 0) {
                physical[physical.length-1].desc = normStr(physical[physical.length-1].desc + ' ' + desc);
                if (balance !== null) physical[physical.length-1].balance = balance;
            }
            continue;
        }

        // ── Noise row (no movement, no balance) ───────────────────────────────
        if (!movement && balance === null) continue;

        physical.push({ date: parsedDate || prevDate, desc, moneyIn, moneyOut, balance });
    }

    // ── Recover initialBalance from first row with known balance ──────────────
    if (initialBalance === null) {
        let delta = 0;
        for (const r of physical) {
            delta += (r.moneyIn ?? 0) - (r.moneyOut ?? 0);
            if (r.balance !== null) { initialBalance = r.balance - delta; break; }
        }
    }

    // ── Sequential forward balance computation ────────────────────────────────
    let lastBal = initialBalance;
    const txns: PhysRow[] = [];

    for (const r of physical) {
        let inA = r.moneyIn ?? 0, outA = r.moneyOut ?? 0;
        const explBal = r.balance;

        // Infer missing amounts from balance delta
        if (lastBal !== null && explBal !== null && inA === 0 && outA === 0) {
            const diff = +(explBal - lastBal).toFixed(2);
            if (Math.abs(diff) <= MAX_SANE_AMOUNT) {
                if (diff > 0) { r.moneyIn = diff; inA = diff; }
                else if (diff < 0) { r.moneyOut = -diff; outA = -diff; }
            }
        }

        if (lastBal !== null) {
            r.balance = lastBal - outA + inA;
            lastBal   = r.balance;
            if (explBal !== null) { r.balance = explBal; lastBal = explBal; }
        } else if (explBal !== null) {
            r.balance = explBal; lastBal = explBal;
        } else if (inA > 0 || outA > 0) {
            lastBal = inA - outA; r.balance = lastBal;
        }

        txns.push({ ...r });
    }

    // ── Emit ──────────────────────────────────────────────────────────────────
    const transactions: ParsedTransaction[] = [];
    for (const t of txns) {
        if (TOTAL_RE.test(t.desc ?? '') || FOOTER_RE.test(t.desc ?? '')) continue;
        const inAmt  = (t.moneyIn  ?? 0) > 0 ? formatMoney(t.moneyIn!)  : '';
        const outAmt = (t.moneyOut ?? 0) > 0 ? formatMoney(t.moneyOut!) : '';
        if (!inAmt && !outAmt) continue;
        transactions.push({
            date:        t.date,
            type:        '',
            description: t.desc || 'Unknown',
            moneyIn:     inAmt,
            moneyOut:    outAmt,
            balance:     t.balance !== null ? t.balance.toFixed(2) : '',
        });
    }
    for (const t of transactions) t.description = stripFooterText(t.description);
    return { transactions, ascending: true };
}

// ── Statement totals extraction ───────────────────────────────────────────────
// Barclays summary section: normally 2-col rows (col0=label, col1=£amount).
// Some statements omit "Money out" / "Start balance" from the cell grid but
// always include them in the free-text content string after "Continued":
//   "Money out\n£6,168.61\n..."  "Start balance\n£1,495.64\n..."
// We try cells first then fall back to the content string for missing fields.

function extractBarclaysStatementTotals(cells: Cell[]): ParseResult['statementTotals'] | undefined {
    // Pass 1: read from cell structure (label in col0, amount in col1)
    const rows = new Map<number, Map<number, string>>();
    for (const c of cells) {
        if (c.rowIndex < 0) continue;
        if (!rows.has(c.rowIndex)) rows.set(c.rowIndex, new Map());
        rows.get(c.rowIndex)!.set(c.columnIndex, c.content);
    }
    let moneyIn: number | undefined;
    let moneyOut: number | undefined;
    let openingBalance: number | undefined;
    let closingBalance: number | undefined;
    for (const colMap of rows.values()) {
        const c0 = normStr(colMap.get(0) ?? '').toLowerCase();
        const c1 = normStr(colMap.get(1) ?? '');
        if (c0 === 'start balance' || c0 === 'opening balance') {
            const v = parseMoney(c1); if (v !== null) openingBalance = Math.abs(v);
        } else if (c0 === 'end balance' || c0 === 'closing balance') {
            const v = parseMoney(c1);
            if (v !== null) closingBalance = /\bOD\b/i.test(c1) ? -Math.abs(v) : v;
        } else if (c0 === 'money out') {
            const v = parseMoney(c1); if (v !== null) moneyOut = Math.abs(v);
        } else if (c0 === 'money in') {
            const v = parseMoney(c1); if (v !== null) moneyIn = Math.abs(v);
        }
    }

    // Pass 2: fallback to content string for any values still missing.
    // Pattern: "Label\n£amount" — the £ on the next line distinguishes
    // summary rows from column headers ("Money out £" on one line).
    if (moneyOut === undefined || openingBalance === undefined || moneyIn === undefined || closingBalance === undefined) {
        const raw = cells.find(c => c.rowIndex < 0)?.content ?? '';
        const pick = (re: RegExp): number | undefined => {
            const m = re.exec(raw);
            if (!m) return undefined;
            const v = parseMoney(m[1]);
            return v !== null ? Math.abs(v) : undefined;
        };
        if (moneyOut === undefined)      moneyOut      = pick(/\bMoney out\n[£€]?([\d,]+\.?\d*)/i);
        if (moneyIn === undefined)       moneyIn       = pick(/\bMoney in\n[£€]?([\d,]+\.?\d*)/i);
        if (openingBalance === undefined) openingBalance = pick(/\bStart balance\n[£€]?([\d,]+\.?\d*)/i);
        if (closingBalance === undefined) {
            // Use OD-aware extraction: preserve negative sign for overdraft closing balance
            const ecm = /\bEnd balance\n[£€]?([\d,]+\.?\d*)(\s*OD)?/i.exec(raw);
            if (ecm) {
                const v = parseMoney(ecm[1]);
                if (v !== null) closingBalance = ecm[2]?.trim() ? -Math.abs(v) : v;
            }
        }
    }

    if (moneyIn === undefined || moneyOut === undefined) return undefined;
    return { moneyIn, moneyOut, openingBalance, closingBalance };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    const ctx = cells.find(c => c.rowIndex < 0)?.content ?? '';
    // "Statement of Fees" is a Barclays fees notice, not a bank statement.
    // It has no transaction rows — only fee summaries that look like amounts.
    if (/\bStatement\s+of\s+Fees\b/i.test(ctx)) return { transactions: [] };
    const result = /Premier BK AC/i.test(ctx) ? parsePremier(cells) : parseNormal(cells);
    if (!result.statementTotals) {
        const totals = extractBarclaysStatementTotals(cells);
        if (totals) result.statementTotals = totals;
    }
    return result;
}
