import { BankType, banksNamedInContent } from './DocumentClassifier.js';
import { ParseResult } from './parsers/shared.js';

const amount = (s?: string) => parseFloat((s || '').replace(/,/g, '') || '0') || 0;

/**
 * A parse fits its document when it found transactions and their Money In and
 * Money Out equal the totals the statement itself declares.
 */
export function fitsDeclaredTotals(result: ParseResult): boolean {
    const declared = result.statementTotals;
    if (!result.transactions.length || declared?.moneyIn == null || declared?.moneyOut == null) return false;
    const totalIn  = result.transactions.reduce((s, t) => s + amount(t.moneyIn), 0);
    const totalOut = result.transactions.reduce((s, t) => s + amount(t.moneyOut), 0);
    return Math.abs(totalIn - declared.moneyIn) < 0.02 && Math.abs(totalOut - declared.moneyOut) < 0.02;
}

/**
 * Second opinion on which bank a document is from.
 *
 * Content detection answers with the first bank whose name it finds, and a
 * statement names more banks than its own. Three statements in two days were read
 * as the wrong bank that way: a Monzo statement as Barclaycard (a card repayment),
 * an ANNA statement as NatWest (an intermediary BIC in the header), and Tide
 * statements as NatWest (a cash machine). Two failed with no transactions; the
 * third came out with dates and amounts where the descriptions belong.
 *
 * When the chosen bank's result does not fit the document, every other bank named
 * in the text is tried, and the first whose result does fit is returned. Nothing
 * is switched on a guess: a candidate has to find transactions AND match the
 * statement's own declared totals to the penny.
 *
 * Returns null when the current result already fits or no candidate does.
 */
export async function findBetterBank(
    content: string,
    bankType: BankType,
    current: ParseResult,
    parseAs: (bank: BankType) => Promise<ParseResult>,
): Promise<{ bankType: BankType; result: ParseResult } | null> {
    if (fitsDeclaredTotals(current)) return null;
    for (const candidate of banksNamedInContent(content)) {
        if (candidate === bankType) continue;
        let result: ParseResult;
        try {
            result = await parseAs(candidate);
        } catch {
            continue;   // a parser choking on another bank's document is not a candidate
        }
        if (fitsDeclaredTotals(result)) return { bankType: candidate, result };
    }
    return null;
}
