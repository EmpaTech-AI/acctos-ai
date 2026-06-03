import { ParsedTransaction, parseMoney } from './parsers/shared.js';
import type { CategorizedTransaction } from './AssistantCategorizer.js';

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
 * Transactions must be sorted newest-first (descending).
 */
export function computeVerification(
    transactions: ParsedTransaction[],
    declared?: { moneyIn: number; moneyOut: number },
): VerificationSummary | undefined {
    if (!transactions.length) return undefined;

    const totalIn  = transactions.reduce((s, t) => s + (parseMoney(t.moneyIn)  ?? 0), 0);
    const totalOut = transactions.reduce((s, t) => s + (parseMoney(t.moneyOut) ?? 0), 0);

    const first = transactions[0];
    const last  = transactions[transactions.length - 1];
    const closingBal = parseMoney(first.balance);
    const oldestBal  = parseMoney(last.balance);

    let openingBalance: number | null = null;
    let balanceOk = true;
    let balanceDiff: number | null = null;

    if (closingBal !== null && oldestBal !== null) {
        const lastIn  = parseMoney(last.moneyIn)  ?? 0;
        const lastOut = parseMoney(last.moneyOut) ?? 0;
        openingBalance = oldestBal - lastIn + lastOut;
        const expected = openingBalance + totalIn - totalOut;
        balanceDiff = closingBal - expected;
        balanceOk = Math.abs(balanceDiff) <= 0.02;
    }

    let declaredIn: number | undefined;
    let declaredOut: number | undefined;
    let declaredOk: boolean | undefined;

    if (declared) {
        declaredIn = declared.moneyIn;
        declaredOut = declared.moneyOut;
        declaredOk =
            Math.abs(totalIn - declared.moneyIn) <= 0.02 &&
            Math.abs(totalOut - declared.moneyOut) <= 0.02;
    }

    return {
        totalIn, totalOut,
        openingBalance,
        closingBalance: closingBal,
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
