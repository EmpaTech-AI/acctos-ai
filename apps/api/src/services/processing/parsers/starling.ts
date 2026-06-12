import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid,
    parseDateToDDMMYYYY
} from './shared.js';

// Known Starling transaction types used in raw-text fallback
const RAW_TYPES = [
    'FASTER PAYMENT', 'CONTACTLESS', 'ONLINE PAYMENT',
    'CARD SUBSCRIPTION', 'CHIP & PIN', 'ATM',
];

function isHeaderRow(cells: string[]): boolean {
    const j = cells.join(' ').toLowerCase();
    return (
        j.includes('date') &&
        j.includes('type') &&
        j.includes('transaction') &&
        j.includes('in') &&
        j.includes('out')
    );
}

// Detect 6-col vs 5-col from header: 6-col has separate "in" and "out" columns
function detectLayout(headerCells: Map<number, string>): '6col' | '5col' {
    let hasIn = false;
    let hasOut = false;
    for (const v of headerCells.values()) {
        const l = v.toLowerCase();
        if ((l === 'in' || l.includes('money in')) && !l.includes('transaction')) hasIn = true;
        if ((l === 'out' || l.includes('money out')) && !l.includes('transaction')) hasOut = true;
    }
    return hasIn && hasOut ? '6col' : '5col';
}

function isInterestSection(cellValues: string[]): boolean {
    const t = cellValues.join(' ').toLowerCase();
    return (
        t.includes('interest rate paid on') ||
        t.includes('%aer') ||
        t.includes('%gross') ||
        t.includes('interest rate charged')
    );
}

function txKey(t: ParsedTransaction): string {
    return [t.date, t.type, t.description, t.moneyIn, t.moneyOut].join('|').toLowerCase();
}

function extractFromSection(
    rows: number[],
    grid: Map<number, Map<number, string>>,
    layout: '6col' | '5col',
    out: ParsedTransaction[],
): void {
    for (const r of rows) {
        const row = grid.get(r)!;

        const date = parseDateToDDMMYYYY(normStr(row.get(0) ?? ''));
        if (!date) continue;

        const type     = normStr(row.get(1) ?? '');
        const desc     = normStr(row.get(2) ?? '');
        const typeDesc = [type, desc].filter(Boolean).join(' ');
        if (!typeDesc) continue;
        if (type.toUpperCase() === 'OPENING BALANCE') continue;

        const balCol = layout === '6col' ? 5 : 4;
        const balNum = parseMoney(normStr(row.get(balCol) ?? ''));
        const bal    = balNum !== null ? balNum.toFixed(2) : '';

        let moneyIn  = '';
        let moneyOut = '';

        if (layout === '6col') {
            const inAmt  = parseMoney(normStr(row.get(3) ?? ''));
            const outAmt = parseMoney(normStr(row.get(4) ?? ''));

            if (inAmt !== null && inAmt > 0 && (outAmt === null || outAmt === 0)) {
                moneyIn = formatMoney(inAmt);
            } else if (outAmt !== null && outAmt > 0 && (inAmt === null || inAmt === 0)) {
                moneyOut = formatMoney(outAmt);
            } else if (inAmt !== null && outAmt !== null) {
                // Both present — larger wins
                if (inAmt >= outAmt) moneyIn  = formatMoney(inAmt);
                else                 moneyOut = formatMoney(outAmt);
            } else {
                continue;
            }
        } else {
            // 5-col: single amount column — all treated as moneyOut per Make.com fallback
            const amtNum = parseMoney(normStr(row.get(3) ?? ''));
            if (amtNum === null || amtNum <= 0) continue;
            moneyOut = formatMoney(amtNum);
        }

        if (!moneyIn && !moneyOut) continue;

        out.push({ date, type, description: typeDesc, moneyIn, moneyOut, balance: bal });
    }
}

function rawFallback(rawText: string, existing: ParsedTransaction[]): ParseResult {
    if (!rawText) return { transactions: existing, ascending: true };

    // Find the LAST "Starling Bank 24hr Customer Service:" page header in the raw text
    const markerRe = /(?:^|\s)(?:\d+\s+)?(?:S\s+)?Starling Bank\s+24hr Customer Service:/gi;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(rawText)) !== null) lastMatch = m;

    if (!lastMatch) return { transactions: existing, ascending: true };

    // Only scan from the last page header, stop before interest/legal section
    let zone = rawText.slice(lastMatch.index);
    zone = zone.split(/Interest will be payable|Date range applicable|Interest rate paid on/i)[0];

    const typePattern = RAW_TYPES.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const orphanRe = new RegExp(
        `(\\d{1,2}[\\/\\.\\-]\\d{1,2}[\\/\\.\\-]\\d{2,4})\\s+` +
        `(${typePattern})\\s+` +
        `([\\s\\S]*?)\\s+` +
        `£\\s*([\\d,]+\\.\\d{2})` +
        `(?:\\s+£\\s*([\\d,]+\\.\\d{2}))?`,
        'gi',
    );

    const existingKeys = new Set(existing.map(txKey));
    const transactions = [...existing];

    let om: RegExpExecArray | null;
    while ((om = orphanRe.exec(zone)) !== null) {
        const date   = parseDateToDDMMYYYY(om[1]);
        const type   = normStr(om[2]);
        const desc   = normStr(om[3]);
        const amount = parseMoney(om[4]);
        const balNum = om[5] ? parseMoney(om[5]) : null;

        if (!date || !type || !desc || amount === null || amount <= 0) continue;

        const moneyIn  = type.toUpperCase() === 'FASTER PAYMENT' ? formatMoney(amount) : '';
        const moneyOut = type.toUpperCase() !== 'FASTER PAYMENT' ? formatMoney(amount) : '';
        const bal      = balNum !== null ? formatMoney(balNum) : '';

        const tx: ParsedTransaction = {
            date,
            type,
            description: `${type} ${desc}`,
            moneyIn,
            moneyOut,
            balance: bal,
        };

        const key = txKey(tx);
        if (!existingKeys.has(key)) {
            transactions.push(tx);
            existingKeys.add(key);
        }
    }

    return { transactions, ascending: true };
}

export function parse(cells: Cell[]): ParseResult {
    // Synthetic context cell (rowIndex -1) holds the full document text
    const rawText = normStr(cells.find(c => c.rowIndex < 0)?.content ?? '');

    const grid = buildGrid(cells);
    const sortedRows = [...grid.keys()].filter(r => r >= 0).sort((a, b) => a - b);

    if (!sortedRows.length) return rawFallback(rawText, []);

    // Global maxCol fallback for sections without a header row
    const globalMaxCol = cells
        .filter(c => c.rowIndex >= 0)
        .reduce((mx, c) => Math.max(mx, c.columnIndex), 0);
    const globalLayout: '6col' | '5col' = globalMaxCol >= 5 ? '6col' : '5col';

    const transactions: ParsedTransaction[] = [];
    let sectionRows: number[] = [];
    let sectionLayout: '6col' | '5col' = globalLayout;

    function flushSection() {
        extractFromSection(sectionRows, grid, sectionLayout, transactions);
        sectionRows = [];
    }

    for (const r of sortedRows) {
        const row = grid.get(r)!;
        const rowCells = [...row.values()];

        if (isHeaderRow(rowCells)) {
            flushSection();
            sectionLayout = detectLayout(row);
            continue;
        }

        sectionRows.push(r);
    }
    flushSection();

    // Raw text fallback only when table extraction found nothing
    if (transactions.length > 0) return { transactions, ascending: true };

    return rawFallback(rawText, transactions);
}
