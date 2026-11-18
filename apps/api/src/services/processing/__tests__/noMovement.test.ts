/**
 * When a batch gives no transactions, decide whether the statements simply had no
 * activity (each one declares £0 in and £0 out) or could not be read.
 *
 * Origin: three statements of a deposit account with no activity failed as "No
 * transactions found", with advice to ask for the bank's original export. The files
 * were fine; the account had nothing on it.
 */

import { describe, it, expect } from 'vitest';
import { noMovementError, NoMovementError } from '../noMovement.js';

const zero = (filename: string, balance = 12.34) => ({
    filename, statementTotals: { moneyIn: 0, moneyOut: 0, openingBalance: balance, closingBalance: balance },
});

describe('noMovementError', () => {
    it('names every statement and its balance when all declare no money in or out', () => {
        const err = noMovementError(3, [zero('aug.pdf'), zero('sep.pdf'), zero('oct.pdf')]);

        expect(err).toBeInstanceOf(NoMovementError);
        expect(err!.statements).toEqual([
            { filename: 'aug.pdf', openingBalance: 12.34, closingBalance: 12.34 },
            { filename: 'sep.pdf', openingBalance: 12.34, closingBalance: 12.34 },
            { filename: 'oct.pdf', openingBalance: 12.34, closingBalance: 12.34 },
        ]);
        expect(err!.message).toBe('No transactions found: all 3 statements show no money in or out');
    });

    it('words the message for a single statement', () => {
        expect(noMovementError(1, [zero('oct.pdf')])!.message).toBe('No transactions found: the statement shows no money in or out');
    });

    it('is not the case when a file has no declared totals', () => {
        expect(noMovementError(2, [zero('aug.pdf'), { filename: 'scan.pdf' }])).toBeNull();
    });

    it('is not the case when a statement declares money that was not read', () => {
        expect(noMovementError(2, [zero('aug.pdf'), { filename: 'sep.pdf', statementTotals: { moneyIn: 500, moneyOut: 0 } }])).toBeNull();
    });

    it('is not the case when some files are missing from the empty list', () => {
        expect(noMovementError(3, [zero('aug.pdf'), zero('sep.pdf')])).toBeNull();
    });
});
