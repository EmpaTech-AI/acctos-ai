/**
 * A second opinion on which bank a document is from.
 *
 * Origin: three statements in two days were read as the wrong bank because a
 * name in their text belonged to someone else — a card repayment, an
 * intermediary BIC, a cash machine. When the chosen bank's result does not fit
 * the document, the other banks it names are tried, and one is taken only if its
 * result matches the statement's own declared totals.
 *
 * Parsers are faked here: each "bank" returns a canned result.
 */

import { describe, it, expect } from 'vitest';
import { findBetterBank, fitsDeclaredTotals } from '../bankFit.js';
import type { BankType } from '../DocumentClassifier.js';
import type { ParseResult, ParsedTransaction } from '../parsers/shared.js';

const NONE = String();
const tx = (moneyIn: string, moneyOut: string): ParsedTransaction =>
    ({ date: '01/08/2026', type: NONE, description: 'Example', moneyIn, moneyOut, balance: NONE });

const FITS: ParseResult      = { transactions: [tx('1,000.00', NONE), tx(NONE, '400.00')], statementTotals: { moneyIn: 1000, moneyOut: 400 } };
const OUT_IS_OFF: ParseResult = { transactions: [tx('1,000.00', NONE), tx(NONE, '400.00')], statementTotals: { moneyIn: 1000, moneyOut: 0 } };
const NO_ROWS: ParseResult    = { transactions: [] };
const NO_TOTALS: ParseResult  = { transactions: [tx('1,000.00', NONE)] };

// A Tide statement that names a NatWest cash machine: both banks are "named".
const TEXT = 'tide Bank statement Cash Withdrawal NATWEST BANK - EXAMPLE STORE Your Tide account is a bank account';

function parsers(results: Partial<Record<BankType, ParseResult | Error>>) {
    const tried: BankType[] = [];
    const parseAs = async (bank: BankType) => {
        tried.push(bank);
        const r = results[bank];
        if (r instanceof Error) throw r;
        return r ?? NO_ROWS;
    };
    return { parseAs, tried };
}

describe('fitsDeclaredTotals', () => {
    it('is true when the rows add up to the totals the statement declares', () => {
        expect(fitsDeclaredTotals(FITS)).toBe(true);
    });

    it.each([
        ['one side is off', OUT_IS_OFF],
        ['there are no rows', NO_ROWS],
        ['the statement declares no totals', NO_TOTALS],
    ])('is false when %s', (_why, result) => {
        expect(fitsDeclaredTotals(result)).toBe(false);
    });
});

describe('findBetterBank', () => {
    it('switches to a named bank whose result matches the declared totals', async () => {
        const { parseAs } = parsers({ tide: FITS });
        expect(await findBetterBank(TEXT, 'natwest', OUT_IS_OFF, parseAs)).toEqual({ bankType: 'tide', result: FITS });
    });

    it('switches when the chosen bank found nothing at all', async () => {
        const { parseAs } = parsers({ tide: FITS });
        expect(await findBetterBank(TEXT, 'natwest', NO_ROWS, parseAs)).toMatchObject({ bankType: 'tide' });
    });

    it('leaves a result that already fits alone, without trying anything', async () => {
        const { parseAs, tried } = parsers({ tide: FITS });
        expect(await findBetterBank(TEXT, 'natwest', FITS, parseAs)).toBeNull();
        expect(tried).toEqual([]);
    });

    it('does not switch when no named bank fits either', async () => {
        const { parseAs, tried } = parsers({ tide: OUT_IS_OFF });
        expect(await findBetterBank(TEXT, 'natwest', OUT_IS_OFF, parseAs)).toBeNull();
        expect(tried).toEqual(['tide']);       // and it never re-runs the bank it already has
    });

    it('does not switch to a bank that found rows but has no declared totals to check them against', async () => {
        const { parseAs } = parsers({ tide: NO_TOTALS });
        expect(await findBetterBank(TEXT, 'natwest', NO_ROWS, parseAs)).toBeNull();
    });

    it('carries on past a parser that throws on a foreign document', async () => {
        const text = `${TEXT} payment to HSBC UK`;
        const { parseAs } = parsers({ tide: new Error('not my layout'), hsbc: FITS });
        expect(await findBetterBank(text, 'natwest', NO_ROWS, parseAs)).toMatchObject({ bankType: 'hsbc' });
    });
});
