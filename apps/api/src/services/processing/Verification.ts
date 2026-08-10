import { ParsedTransaction, parseMoney } from './parsers/shared.js';
import type { CategorizedTransaction } from './AssistantCategorizer.js';
import type { FileSummary } from './JobStore.js';

export interface VerificationSummary {
    totalIn: number;
    totalOut: number;
    openingBalance: number | null;
    closingBalance: number | null;
    balanceOk: boolean;
    balanceDiff: number | null;
    declaredIn?: number;
    declaredOut?: number;
    declaredOk?: boolean;
    /** Totals computed from the categorized Excel output (post-AI). */
    catTotalIn?: number;
    catTotalOut?: number;
    catOk?: boolean;
}

/**
 * Compute verification summary from parsed transactions.
 * ascending=true  → oldest transaction first (e.g. Mettle)
 * ascending=false → newest transaction first (default, all other banks)
 */
export function computeVerification(
    transactions: ParsedTransaction[],
    declared?: { moneyIn?: number; moneyOut?: number; openingBalance?: number; closingBalance?: number },
    ascending = false,
): VerificationSummary | undefined {
    if (!transactions.length) return undefined;

    const totalIn  = transactions.reduce((s, t) => s + (parseMoney(t.moneyIn)  ?? 0), 0);
    const totalOut = transactions.reduce((s, t) => s + (parseMoney(t.moneyOut) ?? 0), 0);

    const oldest = ascending ? transactions[0] : transactions[transactions.length - 1];
    const newest = ascending ? transactions[transactions.length - 1] : transactions[0];
    const closingBal = parseMoney(newest.balance);
    const oldestBal  = parseMoney(oldest.balance);

    let openingBalance: number | null = null;
    let closingBalance: number | null = closingBal;
    let balanceOk = true;
    let balanceDiff: number | null = null;

    const statedOpen = declared?.openingBalance ?? null;
    const statedClose = declared?.closingBalance ?? null;

    if (statedOpen !== null && statedClose !== null) {
        // Use the bank's own declared Opening/Closing Balance (more reliable than deriving
        // from transactions, which can lack balance values for overdraft rows).
        openingBalance = statedOpen;
        closingBalance = statedClose;
        const expected = openingBalance + totalIn - totalOut;
        balanceDiff = statedClose - expected;
        balanceOk = Math.abs(balanceDiff) <= 0.02;
    } else if (declared) {
        // closingBalance was initialised to closingBal above — reset it here so that
        // the "both or neither" invariant holds even when derivation below fails.
        closingBalance = null;
        // Declared totals provided but opening/closing were cleared (e.g. OCR misread the
        // Lloyds two-column header layout). Fall back to deriving opening from the first
        // transaction: opening = firstBalance - firstIn.
        // Validate before showing: if opening + totalIn - totalOut ≈ closing → reliable.
        if (closingBal !== null && oldestBal !== null) {
            const oldestIn  = parseMoney(oldest.moneyIn)  ?? 0;
            const oldestOut = parseMoney(oldest.moneyOut) ?? 0;
            // Balance column always shows the running balance AFTER the transaction.
            // Reverse the first transaction to recover the opening: opening = balance - in + out.
            const derivedOpen = oldestBal - oldestIn + oldestOut;
            const derivedDiff = Math.round((closingBal - (derivedOpen + totalIn - totalOut)) * 100) / 100;
            if (Math.abs(derivedDiff) <= 0.02) {
                openingBalance = derivedOpen;
                closingBalance = closingBal;
                balanceDiff = derivedDiff;
                balanceOk = true;
            }
            // If derivation doesn't validate either, leave both null — don't show a spurious mismatch.
        }
    } else if (closingBal !== null && oldestBal !== null) {
        // Only derive balance from transactions when we have no declared totals.
        // When declared IN/OUT totals are available (e.g. Monese), skip this check —
        // payment-date sorting reorders transactions, making first/last balance unreliable.
        const oldestIn  = parseMoney(oldest.moneyIn)  ?? 0;
        const oldestOut = parseMoney(oldest.moneyOut) ?? 0;
        openingBalance = oldestBal - oldestIn + oldestOut;
        const expected = openingBalance + totalIn - totalOut;
        balanceDiff = closingBal - expected;
        balanceOk = Math.abs(balanceDiff) <= 0.02;
    }

    let declaredIn: number | undefined;
    let declaredOut: number | undefined;
    let declaredOk: boolean | undefined;

    if (declared && declared.moneyIn != null && declared.moneyOut != null) {
        declaredIn = declared.moneyIn;
        declaredOut = declared.moneyOut;
        declaredOk =
            Math.abs(totalIn - declared.moneyIn) <= 0.02 &&
            Math.abs(totalOut - declared.moneyOut) <= 0.02;

        // When the bank declares money in/out totals, those are the authoritative
        // source of truth. The opening→closing balance continuity check is a fallback
        // for statements that don't provide declared totals — when declared totals
        // exist (and are verified above), skip the balance check to avoid spurious
        // warnings from bank-side adjustments (pending items, charges, rounding)
        // that aren't present in the transaction list.
        balanceDiff = null;
        balanceOk = true;
    }

    return {
        totalIn, totalOut,
        openingBalance,
        closingBalance,
        balanceOk, balanceDiff,
        declaredIn, declaredOut, declaredOk,
    };
}

const CAT_EXPENSE_COLS = ['SALARY','OTHER','INSURANCE','LOAN','CASH','TRAVEL','PHONE','CHARGES','Bank_Transfer','HMRC','RENT','BILLS'] as const;

/**
 * Attach post-categorization totals to an existing VerificationSummary.
 * catTotalIn  = sum of INCOME values across all categorized rows
 * catTotalOut = sum of absolute values of all expense category columns
 */
export function applyCatVerification(v: VerificationSummary, categorized: CategorizedTransaction[]): void {
    let catIn = 0, catOut = 0;
    for (const t of categorized) {
        const inc = parseMoney(t.INCOME);
        if (inc !== null && inc > 0) catIn += inc;
        for (const col of CAT_EXPENSE_COLS) {
            const val = parseMoney((t as any)[col]);
            if (val !== null && val !== 0) catOut += Math.abs(val);
        }
    }
    v.catTotalIn  = Math.round(catIn  * 100) / 100;
    v.catTotalOut = Math.round(catOut * 100) / 100;
    v.catOk = Math.abs(v.catTotalIn - v.totalIn) <= 0.02 && Math.abs(v.catTotalOut - v.totalOut) <= 0.02;
}

export function logVerificationSummary(v: VerificationSummary): void {
    console.log(
        `[TotalsCheck] Opening: ${v.openingBalance?.toFixed(2) ?? 'N/A'} | ` +
        `In: ${v.totalIn.toFixed(2)} | Out: ${v.totalOut.toFixed(2)} | ` +
        `Closing: ${v.closingBalance?.toFixed(2) ?? 'N/A'}`
    );
    if (v.balanceOk) {
        console.log(`[TotalsCheck] Balance continuity OK ✓`);
    } else {
        console.warn(`[TotalsCheck] Balance mismatch — diff: ${v.balanceDiff?.toFixed(2)}`);
    }
    if (v.declaredIn != null && v.declaredOut != null) {
        if (v.declaredOk) {
            console.log(`[TotalsCheck] Declared totals match — In: ${v.declaredIn.toFixed(2)}, Out: ${v.declaredOut.toFixed(2)} ✓`);
        } else {
            console.warn(
                `[TotalsCheck] Declared totals mismatch — ` +
                `In diff: ${(v.totalIn - v.declaredIn).toFixed(2)}, ` +
                `Out diff: ${(v.totalOut - v.declaredOut).toFixed(2)}`
            );
        }
    }
    if (v.catTotalIn != null && v.catTotalOut != null) {
        if (v.catOk) {
            console.log(`[TotalsCheck] Categorized totals match parser — In: ${v.catTotalIn.toFixed(2)}, Out: ${v.catTotalOut.toFixed(2)} ✓`);
        } else {
            console.warn(
                `[TotalsCheck] Categorized totals differ — ` +
                `In diff: ${(v.catTotalIn - v.totalIn).toFixed(2)}, ` +
                `Out diff: ${(v.catTotalOut - v.totalOut).toFixed(2)}`
            );
        }
    }
}

// ── Chain continuity ─────────────────────────────────────────────────────────

export interface ChainGap {
    afterFile:     string;  // filename of the file whose closing balance doesn't match
    beforeFile:    string;  // filename of the next file whose opening balance differs
    expectedOpen:  number;  // closing balance of afterFile (expected opening of next file)
    actualOpen:    number;  // actual opening balance of beforeFile
    diff:          number;  // actualOpen - expectedOpen
}

export interface ChainVerification {
    chainOpeningBalance: number;  // opening balance of the first file in the set
    chainClosingBalance: number;  // closing balance of the last file in the set
    expectedClosing: number;      // chainOpen + totalIn - totalOut
    diff: number;                 // actualClosing - expectedClosing (≈0 means no gaps)
    ok: boolean;
    gaps: ChainGap[];             // per-period: file[N].closing vs file[N+1].opening
}

/** Return all permutations of an array. Safe for n ≤ 7 (5040 max). */
function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const perm of permutations(rest)) result.push([arr[i], ...perm]);
    }
    return result;
}

/**
 * Sort file summaries into chronological chain order by matching closing → opening balances.
 *
 * 1. Build connected chains by matching each file's closingBalance to the next file's
 *    openingBalance — the internal order of connected chains is unambiguous.
 * 2. When multiple chains/isolated files exist (gap in the statement set), use
 *    permutation search: try every ordering of the chain segments and pick the one
 *    that minimises |actualClosing − expectedClosing|. With the correct chronological
 *    order the gap is either zero (complete set) or the true missing-statement amount
 *    (smallest possible diff). This replaces the previous "longest first, asc opening"
 *    tiebreaker which was wrong for accounts with net outflow submitted in reverse order.
 *
 * Permutation search is bounded to ≤ 7 independent chains (5040 perms); beyond that it
 * falls back to longest-chain-first with descending opening balance (net-outflow default).
 */
function sortByBalanceChain(files: FileSummary[], totalIn = 0, totalOut = 0): FileSummary[] {
    if (files.length <= 1) return files;
    const EPS = 0.02;

    // Build a successor map: file → the file whose opening matches this file's closing
    const successor = new Map<FileSummary, FileSummary>();
    for (const a of files) {
        if (a.closingBalance == null) continue;
        const next = files.find(b =>
            b !== a &&
            b.openingBalance != null &&
            Math.abs(b.openingBalance - a.closingBalance!) <= EPS,
        );
        if (next) successor.set(a, next);
    }

    // Chain starters = files not pointed to as a successor by any other file
    const incomingSet = new Set(successor.values());
    const starters = files.filter(f => !incomingSet.has(f));
    if (!starters.length) return files; // cycle — shouldn't happen

    // Walk each chain from its starter
    const visited = new Set<FileSummary>();
    const chains: FileSummary[][] = [];
    for (const start of starters) {
        if (visited.has(start)) continue;
        const chain: FileSummary[] = [];
        let cur: FileSummary | undefined = start;
        while (cur && !visited.has(cur)) {
            visited.add(cur);
            chain.push(cur);
            cur = successor.get(cur);
        }
        chains.push(chain);
    }
    for (const f of files) {
        if (!visited.has(f)) chains.push([f]);
    }

    if (chains.length === 1) return chains[0];

    // Permutation search: pick the chain ordering that minimises the gap between
    // actual and expected closing balance. This finds the correct chronological order
    // regardless of whether the account balance is increasing or decreasing.
    const gapFor = (perm: FileSummary[][]): number => {
        const flat = perm.flat();
        const open  = flat.find(f => f.openingBalance != null)?.openingBalance;
        const close = [...flat].reverse().find(f => f.closingBalance != null)?.closingBalance;
        if (open == null || close == null) return Infinity;
        const expected = Math.round((open + totalIn - totalOut) * 100) / 100;
        return Math.abs(Math.round((close - expected) * 100) / 100);
    };

    if (chains.length <= 7) {
        const perms = permutations(chains);
        let best = chains;
        let bestGap = gapFor(chains);
        for (const perm of perms) {
            const g = gapFor(perm);
            if (g < bestGap) { bestGap = g; best = perm; }
        }
        return best.flat();
    }

    // Fallback for > 7 chains: longest first, descending opening balance
    // (descending is correct for net-outflow accounts, the most common case)
    chains.sort((a, b) =>
        b.length - a.length ||
        (b[0].openingBalance ?? 0) - (a[0].openingBalance ?? 0),
    );
    return chains.flat();
}

/**
 * Check whether the opening balance of the first file + all IN - all OUT equals
 * the closing balance of the last file.  A non-zero diff indicates a missing
 * statement somewhere in the chain.
 *
 * Only call this after all individual per-file checks have passed — a failed
 * individual file would make the chain diff meaningless.
 *
 * Files are automatically sorted into chronological order by balance chain
 * (closing balance of file N must match opening balance of file N+1) so the
 * caller does not need to pre-sort them.
 *
 * @param fileSummaries  Summaries in any order (will be sorted chronologically).
 * @param totalIn        Sum of parsedIn across all files.
 * @param totalOut       Sum of parsedOut across all files.
 */
export function computeChainVerification(
    fileSummaries: FileSummary[],
    totalIn: number,
    totalOut: number,
): ChainVerification | undefined {
    const sorted    = sortByBalanceChain(fileSummaries, totalIn, totalOut);
    const withOpen  = sorted.filter(f => f.openingBalance != null);
    const withClose = sorted.filter(f => f.closingBalance != null);
    if (!withOpen.length || !withClose.length) return undefined;

    const chainOpen  = withOpen[0].openingBalance!;
    const chainClose = withClose[withClose.length - 1].closingBalance!;
    const expected   = Math.round((chainOpen + totalIn - totalOut) * 100) / 100;
    const diff       = Math.round((chainClose - expected) * 100) / 100;

    // Per-period gap detection: for each consecutive pair of files (in sorted order),
    // check whether file[N].closingBalance matches file[N+1].openingBalance (within £0.02).
    const gaps: ChainGap[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        const cur  = sorted[i];
        const next = sorted[i + 1];
        if (cur.closingBalance == null || next.openingBalance == null) continue;
        const gapDiff = Math.round((next.openingBalance - cur.closingBalance) * 100) / 100;
        if (Math.abs(gapDiff) > 0.02) {
            gaps.push({
                afterFile:    cur.filename,
                beforeFile:   next.filename,
                expectedOpen: cur.closingBalance,
                actualOpen:   next.openingBalance,
                diff:         gapDiff,
            });
        }
    }

    return {
        chainOpeningBalance: chainOpen,
        chainClosingBalance: chainClose,
        expectedClosing: expected,
        diff,
        ok: Math.abs(diff) <= 0.02 && gaps.length === 0,
        gaps,
    };
}
