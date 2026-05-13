// Ported from Make.com scenario – see ExcelOutputBuilder for integration.
import {
    Cell,
    normStr, parseDateToDDMMYYYY,
    ParseResult,
    TRANSACTION_CODES
} from './shared.js';

interface Row {
    c0: string; c1: string; c2: string; c3: string; c4: string; c5: string; c6: string;
    maxCol: number;
    __skipBalanceForCurrentTxn?: boolean;
}

interface PartialTxn {
    date: string;
    type: string;
    description: string;
    moneyOut: string;
    moneyIn: string;
    balance: string;
    balanceSegmentValid?: boolean | null;
}

const CODES = TRANSACTION_CODES; // already sorted longest-first in shared.ts

// ── Shared regex constants ──────────────────────────────────────────────────

const FOOTER_ROW_RE =
    /your bank account details|payment\s+type\s+and\s+details|credit interest rates|overdraft interest rates|credit interest is not paid|aer variable|ear variable|\bupto\b|\bover\b|\d+\.\d+%/i;

const SKIP_DESC_EXACT_RE =
    /^(?:payment type and details|your (?:basic )?bank account details|(?:balance )?(?:brought|carried) forward|credit interest rates|credit interest is not paid|aer variable|overdraft interest rates|arranged overdraft interest|ear variable|£)$/i;

const STRIP_DESC_RE =
    /\b(?:payment type and details|your (?:basic )?bank account details|balance (?:brought|carried) forward|(?:brought|carried) forward|credit interest rates|credit interest is not paid|aer variable|overdraft interest rates|arranged overdraft interest|ear variable)\b|\s+£\s*$/gi;

// ── Row helpers ─────────────────────────────────────────────────────────────

function emptyRow(): Row {
    return { c0: '', c1: '', c2: '', c3: '', c4: '', c5: '', c6: '', maxCol: -1 };
}

function rowHasData(row: Row): boolean {
    return [row.c0, row.c1, row.c2, row.c3, row.c4, row.c5, row.c6].some(v => v && v.trim() !== '');
}

function isStatementFooterRow(row: Row): boolean {
    const txt = [row.c0, row.c1, row.c2, row.c3, row.c4, row.c5, row.c6]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return FOOTER_ROW_RE.test(txt);
}

function isAmount(v: string): boolean {
    return Boolean(v) && /^[0-9,]+(\.\d{1,2})?$/.test(v.trim().replace(/,/g, ''));
}

function isCode(v: string): boolean {
    return CODES.includes(v.trim());
}

// ── Code / description extraction ──────────────────────────────────────────

function findCodeHit(row: Row): { code: string; colKey: 'c0' | 'c1' } | null {
    const c0 = (row.c0 || '').trim();
    if (c0 && CODES.includes(c0)) return { code: c0, colKey: 'c0' };

    const c1 = (row.c1 || '').trim();
    for (const code of CODES) {
        if (c1 === code || c1.startsWith(code + ' ')) return { code, colKey: 'c1' };
    }
    return null;
}

function extractDescriptionFromRow(
    row: Row,
    codeHit: { code: string; colKey: string } | null,
): string {
    if (isStatementFooterRow(row)) return '';

    const parts: string[] = [];

    for (const key of ['c1', 'c2'] as const) {
        let val = row[key];
        if (!val) continue;

        if (codeHit && key === codeHit.colKey) {
            if (val.trim() === codeHit.code) continue;
            const prefix = codeHit.code + ' ';
            if (val.startsWith(prefix)) val = val.slice(prefix.length).trim();
        }

        let cleaned = val.trim().replace(/\s+/g, ' ');
        if (SKIP_DESC_EXACT_RE.test(cleaned)) continue;

        cleaned = cleaned.replace(STRIP_DESC_RE, '').replace(/\s+/g, ' ').trim();
        if (cleaned) parts.push(cleaned);
    }

    return parts.join(' ').trim();
}

// ── Amount extraction ───────────────────────────────────────────────────────

function applyAmountsToTxnFromRow(txn: PartialTxn, row: Row): void {
    if (!txn || !row || isStatementFooterRow(row)) return;

    const c2 = (row.c2 || '').trim();
    const c3 = (row.c3 || '').trim();
    const c4 = (row.c4 || '').trim();
    const c5 = (row.c5 || '').trim();
    const c6 = (row.c6 || '').trim();

    const codeHit = findCodeHit(row);
    const shifted =
        codeHit?.colKey === 'c0' ||
        (row.maxCol <= 4 && !row.c5 && !row.c6 &&
            (CODES.includes((row.c0 || '').trim()) || CODES.includes((row.c1 || '').trim())));

    let outVal = '', inVal = '', balVal = '';

    if (shifted) {
        if (isAmount(c2)) outVal = c2;
        else if (isAmount(c3)) outVal = c3;
        if (isAmount(c5)) balVal = c5;
        else if (isAmount(c6)) balVal = c6;
        else if (isAmount(c4)) balVal = c4;
    } else {
        if (isAmount(c3)) outVal = c3;
        if (isAmount(c4)) inVal = c4;
        if (isAmount(c5)) balVal = c5;
        else if (isAmount(c6)) balVal = c6;
    }

    if (!outVal && !inVal) {
        if (balVal && !txn.balance && !row.__skipBalanceForCurrentTxn) txn.balance = balVal;
        return;
    }
    if (outVal && !txn.moneyOut && !txn.moneyIn) txn.moneyOut = outVal;
    if (inVal && !txn.moneyIn && !txn.moneyOut) txn.moneyIn = inVal;
    if (outVal && inVal) {
        if (!txn.moneyOut) txn.moneyOut = outVal;
        if (!txn.moneyIn) txn.moneyIn = inVal;
    }
    if (balVal && !txn.balance && !row.__skipBalanceForCurrentTxn) txn.balance = balVal;
}

// ── Balance helpers ─────────────────────────────────────────────────────────

function parseMoney(v: string): number | null {
    const s = String(v || '').replace(/,/g, '').replace(/[^\d.\-]/g, '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function fmtMoney(n: number): string {
    return Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function almostEqual(a: number, b: number): boolean { return Math.abs(a - b) < 0.01; }

function getOpeningBalance(rows: Row[]): number | null {
    for (const row of rows) {
        const txt = [row.c0, row.c1, row.c2].filter(Boolean).join(' ').replace(/\s+/g, ' ');
        if (/balance brought forward|brought forward/i.test(txt)) {
            const b = parseMoney(row.c5 || row.c6);
            if (b !== null) return b;
        }
    }
    return null;
}

function getPossibleBalance(row: Row): string {
    if (!row || isStatementFooterRow(row)) return '';
    const c4 = (row.c4 || '').trim();
    const c5 = (row.c5 || '').trim();
    const c6 = (row.c6 || '').trim();
    if (isAmount(c5)) return c5;
    if (isAmount(c6)) return c6;
    if (row.maxCol <= 4 && isAmount(c4)) return c4;
    return '';
}

function rowHasMovementAmount(row: Row, codeHit: { colKey: string } | null): boolean {
    if (!row || isStatementFooterRow(row)) return false;
    const c2 = (row.c2 || '').trim();
    const c3 = (row.c3 || '').trim();
    const c4 = (row.c4 || '').trim();
    const shifted =
        codeHit?.colKey === 'c0' ||
        (row.maxCol <= 4 && !row.c5 && !row.c6 &&
            (CODES.includes((row.c0 || '').trim()) || CODES.includes((row.c1 || '').trim())));
    return shifted ? isAmount(c2) || isAmount(c3) : isAmount(c3) || isAmount(c4);
}

function txnHasRealAmount(txn: PartialTxn): boolean {
    return Boolean(
        (txn.moneyOut || '').replace(/,/g, '').trim() ||
        (txn.moneyIn || '').replace(/,/g, '').trim(),
    );
}

function txnHasAnyAmount(txn: PartialTxn): boolean {
    return txnHasRealAmount(txn) || Boolean((txn.balance || '').replace(/,/g, '').trim());
}

// ── Direction normalisation ─────────────────────────────────────────────────

function normalizeTxnType(type: string): string {
    return type === ')))' ? 'VIS' : type;
}

function forceDirectionByType(tx: PartialTxn): void {
    if (tx.balanceSegmentValid === true) { tx.type = normalizeTxnType(tx.type); return; }
    const type = normalizeTxnType(tx.type);
    tx.type = type;

    const out = parseMoney(tx.moneyOut);
    const inn = parseMoney(tx.moneyIn);
    const bal = parseMoney(tx.balance);

    if (type === 'CR') {
        if (out !== null && inn !== null && bal === null) {
            tx.balance = tx.moneyIn; tx.moneyIn = tx.moneyOut; tx.moneyOut = ''; return;
        }
        if (out !== null && inn === null) { tx.moneyIn = tx.moneyOut; tx.moneyOut = ''; }
        return;
    }
    if (type === 'VIS' || type === 'VISA') {
        const isRefund = /\brefund\b|\breversal\b|\breturned\b|\bcredit\b/i.test(tx.description || '');
        if (!isRefund && inn !== null && out === null) { tx.moneyOut = tx.moneyIn; tx.moneyIn = ''; }
    }
}

// ── Balance solver ──────────────────────────────────────────────────────────

function fixInOutByBalance(txns: PartialTxn[], openingBalance: number | null): void {
    let prev = openingBalance;
    if (prev === null) {
        for (const tx of txns) {
            const b = parseMoney(tx.balance);
            if (b !== null) { prev = b; break; }
        }
    }
    if (prev === null) return;

    const cents = (n: number) => Math.round(n * 100);
    const fromCts = (n: number) => n / 100;

    function getSingle(tx: PartialTxn): { amount: number; existingSign: number } | null {
        const out = parseMoney(tx.moneyOut);
        const inn = parseMoney(tx.moneyIn);
        if (out !== null && inn === null) return { amount: cents(out), existingSign: -1 };
        if (inn !== null && out === null) return { amount: cents(inn), existingSign: 1 };
        if (out !== null && inn !== null && almostEqual(out, inn)) return { amount: cents(out), existingSign: 0 };
        return null;
    }

    function preferSigns(tx: PartialTxn, es: number): number[] {
        const type = normalizeTxnType(tx.type);
        const desc = tx.description || '';
        const isRef = /\brefund\b|\breversal\b|\breturned\b|\bcredit\b/i.test(desc);

        if (es === 1) {
            if (type === 'VIS' || type === 'VISA' || type === 'POS' || type === 'ATM') return isRef ? [1, -1] : [-1, 1];
            if (type === 'BP' || type === 'CR') return [1, -1];
            if (type === 'DR' || type === 'DD' || type === 'FEE') return [-1, 1];
            return [1, -1];
        }
        if (es === -1) return [-1, 1];
        if (type === 'CR') return [1, -1];
        if (type === 'DR' || type === 'DD' || type === 'FEE') return [-1, 1];
        if (type === 'BP') return [1, -1]; // BP at HSBC is often income (e.g. cleaning clients)
        if (type === 'VIS' || type === 'VISA' || type === 'POS' || type === 'ATM') return isRef ? [1, -1] : [-1, 1];
        return [-1, 1];
    }

    function penalty(tx: PartialTxn, sign: number, es: number): number {
        const type = normalizeTxnType(tx.type);
        const desc = tx.description || '';
        let p = 0;
        if (es && sign !== es)
            p += (type === 'VIS' || type === 'VISA' || type === 'POS' || type === 'ATM') ? 1 : 3;
        if (type === 'CR' && sign < 0) p += 3;
        if ((type === 'DR' || type === 'DD' || type === 'FEE') && sign > 0) p += 3;
        if ((type === 'VIS' || type === 'VISA') && sign > 0) {
            const isRef = /\brefund\b|\breversal\b|\breturned\b|\bbet365\b|\bbetfair\b|\bpaddypowe|\bbwin\b/i.test(desc);
            if (!isRef) p += 2;
        }
        return p;
    }

    function solveSegment(startBal: number, items: PartialTxn[]): number {
        if (!items.length) return startBal;
        const target = parseMoney(items[items.length - 1].balance);
        if (target === null) return startBal;

        const targetDelta = cents(target) - cents(startBal);
        const amtItems = items.map(tx => {
            const d = getSingle(tx);
            if (!d || !d.amount) return { tx, amount: 0, existingSign: 0, candidates: [0] };
            return { tx, amount: d.amount, existingSign: d.existingSign, candidates: preferSigns(tx, d.existingSign) };
        });

        let states = new Map<number, { score: number; signs: number[] }>([[0, { score: 0, signs: [] }]]);
        for (const item of amtItems) {
            const next = new Map<number, { score: number; signs: number[] }>();
            for (const [delta, state] of states) {
                for (const sign of item.candidates) {
                    const nd = delta + sign * item.amount;
                    const sc = state.score + penalty(item.tx, sign, item.existingSign);
                    const ex = next.get(nd);
                    if (!ex || sc < ex.score) next.set(nd, { score: sc, signs: [...state.signs, sign] });
                }
            }
            states = next;
        }

        const solved = states.get(targetDelta);
        if (solved) {
            for (let i = 0; i < amtItems.length; i++) {
                const { tx, amount } = amtItems[i];
                const sign = solved.signs[i];
                if (!amount || sign === 0) continue;
                const val = fmtMoney(fromCts(amount));
                if (sign < 0) { tx.moneyOut = val; tx.moneyIn = ''; }
                else { tx.moneyOut = ''; tx.moneyIn = val; }
                tx.balanceSegmentValid = true;
            }
            return target;
        }
        for (const tx of items) tx.balanceSegmentValid = false;
        return target;
    }

    let segment: PartialTxn[] = [];
    for (const tx of txns) {
        segment.push(tx);
        if (tx.balance) { prev = solveSegment(prev!, segment); segment = []; }
    }
}

// ── Row repair passes ───────────────────────────────────────────────────────

function repairMergedFeeRows(inputRows: Row[]): Row[] {
    const out: Row[] = [];
    for (const row of inputRows) {
        if (!row || isStatementFooterRow(row)) { out.push(row); continue; }

        const c1 = (row.c1 || '').trim();
        const c2 = (row.c2 || '').replace(/\s+/g, ' ').trim();
        const m = c2.match(/^Transaction Fee\s+(INT'?L\b.*)$/i);

        if (m && c1 && CODES.includes(c1) && c1 !== 'DR') {
            const amounts = (row.c3 || '').match(/[0-9,]+(?:\.\d{1,2})?/g) ?? [];
            const feeAmt = amounts[0] ?? '';
            const txnAmt = amounts[1] ?? '';

            if (feeAmt) {
                const prev = out[out.length - 1];
                const prevC1 = (prev?.c1 || '').trim();
                const prevC2 = (prev?.c2 || '').trim();
                if (prev && prevC1 === 'DR' && !prev.c3 &&
                    /^(DR\s+)?Non-Sterling\s+Transaction Fee$/i.test(`${prevC1} ${prevC2}`.trim())) {
                    prev.c2 = 'Non-Sterling Transaction Fee';
                    prev.c3 = feeAmt;
                } else {
                    out.push({ c0: row.c0 || '', c1: 'DR', c2: 'Non-Sterling Transaction Fee', c3: feeAmt, c4: '', c5: '', c6: '', maxCol: 3 });
                }
            }
            out.push({ ...row, c2: m[1].trim(), c3: txnAmt });
            continue;
        }
        out.push(row);
    }
    return out;
}

function normalizeShiftedRows(inputRows: Row[]): Row[] {
    const out: Row[] = [];
    for (const row of inputRows) {
        if (!row || isStatementFooterRow(row)) { out.push(row); continue; }

        const c0 = (row.c0 || '').trim();
        const c1 = (row.c1 || '').trim();
        const c2 = (row.c2 || '').trim();
        const c3 = (row.c3 || '').trim();
        const c4 = (row.c4 || '').trim();
        const c5 = (row.c5 || '').trim();
        const maxCol = Math.max(row.maxCol || 0, 5);

        // c0 is a code but c1 is not → shift everything right
        if (isCode(c0) && !isCode(c1)) {
            out.push({
                ...row, c0: '', c1: c0,
                c2: [c1, !isAmount(c2) ? c2 : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
                c3: isAmount(c2) ? c2 : c3,
                c4, c5, c6: row.c6 || '', maxCol,
            });
            continue;
        }
        // Continuation row: c1 has description, c2 has amount → shift
        if (!c0 && c1 && !isCode(c1) && isAmount(c2) && !c3) {
            out.push({ ...row, c1: '', c2: c1, c3: c2, c4, c5, c6: row.c6 || '', maxCol });
            continue;
        }
        // Continuation row: c1 has description, c3 has amount, c2 empty → shift
        if (!c0 && c1 && !isCode(c1) && !c2 && isAmount(c3)) {
            out.push({ ...row, c1: '', c2: c1, c3, c4, c5, c6: row.c6 || '', maxCol });
            continue;
        }

        out.push(row);
    }
    return out;
}

// ── Main parse ──────────────────────────────────────────────────────────────

export function parse(cells: Cell[]): ParseResult {
    if (!cells.length) return { transactions: [] };

    // 1. Build logical rows (group by rowIndex, then split on code in col 1)
    const sorted = [...cells].sort((a, b) =>
        a.rowIndex !== b.rowIndex ? a.rowIndex - b.rowIndex : a.columnIndex - b.columnIndex);

    const rawRows: Row[] = [];
    let cur = emptyRow();
    let lastRI = -1;

    for (const cell of sorted) {
        const col = cell.columnIndex;
        const content = normStr(cell.content);

        if (cell.rowIndex !== lastRI) {
            if (lastRI !== -1 && rowHasData(cur)) rawRows.push(cur);
            cur = emptyRow();
            lastRI = cell.rowIndex;
        }

        if (col > cur.maxCol) cur.maxCol = col;

        if (col === 0) {
            cur.c0 = content;
        } else if (col >= 1 && col <= 6) {
            if (col === 1 && content && CODES.includes(content.trim()) && rowHasData(cur)) {
                const code = content.trim();
                const hasAmt = !!(cur.c3 || cur.c4 || cur.c5 || cur.c6);
                const isATMCon = /\bATM\b/.test(cur.c1 || '') || /\bCASH\b/.test(cur.c2 || '');

                if (!(isATMCon && code === 'BP' && !hasAmt)) {
                    rawRows.push(cur);
                    cur = emptyRow();
                    cur.c1 = code;
                    cur.maxCol = Math.max(cur.maxCol, col);
                    continue;
                }
                cur.c2 = cur.c2 ? `${cur.c2} ${code}`.trim() : code;
                continue;
            }
            const key = `c${col}` as keyof Row;
            const ex = cur[key] as string;
            (cur as any)[key] = ex ? `${ex} ${content}`.trim() : content;
        }
    }
    if (rowHasData(cur)) rawRows.push(cur);

    // 2. Row post-processing
    const rows = normalizeShiftedRows(repairMergedFeeRows(rawRows));

    // 3. Opening balance
    const openingBalance = getOpeningBalance(rows);

    // 4. Build transactions
    const txns: PartialTxn[] = [];
    let currentTxn: PartialTxn | null = null;
    let currentDate = '';

    for (const row of rows) {
        if (isStatementFooterRow(row)) continue;

        const dateMatch = (row.c0 || '').match(/(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/);
        if (dateMatch) {
            const parsed = parseDateToDDMMYYYY(dateMatch[1]);
            if (parsed) currentDate = parsed;
        }

        const codeHit = findCodeHit(row);

        if (codeHit) {
            // Page-break balance: balance present but no movement on same line
            const bal = getPossibleBalance(row);
            if (bal && !rowHasMovementAmount(row, codeHit)) {
                if (currentTxn && !currentTxn.balance && txnHasRealAmount(currentTxn)) {
                    currentTxn.balance = bal;
                }
                row.__skipBalanceForCurrentTxn = true;
            }

            if (currentTxn) {
                currentTxn.description = (currentTxn.description || '').trim();
                if (txnHasAnyAmount(currentTxn)) txns.push(currentTxn);
            }

            currentTxn = { date: currentDate, type: codeHit.code, description: '', moneyOut: '', moneyIn: '', balance: '' };
        }

        if (!currentTxn) continue;

        // Description
        let descPart = extractDescriptionFromRow(row, codeHit);
        if (descPart) {
            const raw = descPart.replace(/,/g, '').trim();
            if (/^\d+(\.\d{1,2})?$/.test(raw) &&
                (raw === (currentTxn.moneyOut || '').replace(/,/g, '') ||
                    raw === (currentTxn.moneyIn || '').replace(/,/g, '') ||
                    raw === (currentTxn.balance || '').replace(/,/g, ''))) {
                descPart = '';
            }
        }
        if (descPart) {
            currentTxn.description = currentTxn.description
                ? `${currentTxn.description} ${descPart}`.trim()
                : descPart;
        }

        applyAmountsToTxnFromRow(currentTxn, row);
    }

    if (currentTxn) {
        currentTxn.description = (currentTxn.description || '').trim();
        if (txnHasAnyAmount(currentTxn)) txns.push(currentTxn);
    }

    // 5. Clean trailing duplicate numbers from descriptions
    for (const tx of txns) {
        if (!tx.description) continue;
        const m = tx.description.match(/(\d[\d,]*\.?\d*)\s*$/);
        if (!m) continue;
        const last = m[1].replace(/,/g, '');
        if (last && (
            last === (tx.moneyOut || '').replace(/,/g, '') ||
            last === (tx.moneyIn || '').replace(/,/g, '') ||
            last === (tx.balance || '').replace(/,/g, '')
        )) {
            tx.description = tx.description.slice(0, tx.description.length - m[0].length).trim();
        }
    }

    // 6. Normalise types → lock IN/OUT with balance solver
    for (const tx of txns) forceDirectionByType(tx);
    fixInOutByBalance(txns, openingBalance);

    return {
        transactions: txns.map(tx => ({
            date: tx.date,
            type: normalizeTxnType(tx.type),
            description: tx.description,
            moneyIn: tx.moneyIn || '',
            moneyOut: tx.moneyOut || '',
            balance: tx.balance || '',
        })),
    };
}
