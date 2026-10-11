/**
 * Regression tests for the Metro Bank parser.
 *
 * Origin: a statement whose Money In came out £530.00 under the bank's own total.
 * On one page Azure DI had folded the first transaction into the table's header
 * row and left that transaction's date and balance alone on the next line:
 *
 *     Date        | Transaction Cash Deposit | Money out (£) | Money in (£) 530.00 | Balance (£)
 *     06 JUL 2026 |                          |               |                     | 537.85
 *
 * The parser skipped header rows whole, so the deposit was lost, and the line
 * under it carried neither description nor amount and was dropped too.
 *
 * Every fixture below is synthetic: round amounts, invented names, a
 * self-consistent balance chain. No client statement data is committed here.
 * The tests run without Azure DI credentials.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../metro.js';
import { Cell } from '../shared.js';

function row(r: number, ...cols: string[]): Cell[] {
    return cols.map((content, columnIndex) => ({ rowIndex: r, columnIndex, content })).filter(c => c.content !== '');
}

const sum = (txns: ReturnType<typeof parse>['transactions'], k: 'moneyIn' | 'moneyOut') =>
    Math.round(txns.reduce((s, t) => s + (parseFloat(t[k]) || 0), 0) * 100) / 100;

const HEADER = ['Date', 'Transaction', 'Money out (£)', 'Money in (£)', 'Balance (£)'];

// Opening 1,000.00. In 500.00 + 300.00 = 800.00. Out 100.00 + 50.00 = 150.00. End 1,650.00.
const CONTEXT: Cell = {
    rowIndex: -1, columnIndex: 0,
    content: 'METRO BANK Your account summary Opening balance £1,000.00 Total money in £800.00 Total money out £150.00 End balance £1,650.00',
};

/** Page 1 as Azure DI normally returns it. */
const PAGE_1: Cell[] = [
    ...row(0, ...HEADER),
    ...row(1, '01 JUL 2026', 'Card Purchase 29 JUN 2026 EXAMPLE STORE LONDON GBR', '100.00', '', '900.00'),
    ...row(2, '03 JUL 2026', 'Inward Payment EXAMPLE CLIENT LTD', '', '500.00', '1,400.00'),
];

describe('Metro parser – a transaction folded into a page header', () => {
    // Page 2 (row indices carry the orchestrator's 10000-per-page offset).
    const cells: Cell[] = [
        CONTEXT,
        ...PAGE_1,
        ...row(10000, 'Date', 'Transaction Cash Deposit', 'Money out (£)', 'Money in (£) 300.00', 'Balance (£)'),
        ...row(10001, '06 JUL 2026', '', '', '', '1,700.00'),
        ...row(10002, '07 JUL 2026', 'Direct Debit EXAMPLE INSURER', '50.00', '', '1,650.00'),
    ];

    it('keeps the transaction, with the date and balance from the line under the header', () => {
        const { transactions } = parse(cells);

        expect(transactions).toHaveLength(4);
        expect(transactions[2]).toEqual({
            date: '06/07/2026', type: '', description: 'Cash Deposit',
            moneyIn: '300.00', moneyOut: '', balance: '1700.00',
        });
    });

    it('then matches the totals the bank declares', () => {
        const { transactions, statementTotals } = parse(cells);

        expect(sum(transactions, 'moneyIn')).toBe(statementTotals!.moneyIn);
        expect(sum(transactions, 'moneyOut')).toBe(statementTotals!.moneyOut);
    });

    it('reads a payment out folded into the header the same way', () => {
        const { transactions } = parse([
            CONTEXT,
            ...PAGE_1,
            ...row(10000, 'Date', 'Transaction Direct Debit EXAMPLE INSURER', 'Money out (£) 50.00', 'Money in (£)', 'Balance (£)'),
            ...row(10001, '07 JUL 2026', '', '', '', '1,350.00'),
        ]);

        expect(transactions[2]).toMatchObject({ date: '07/07/2026', description: 'Direct Debit EXAMPLE INSURER', moneyOut: '50.00', moneyIn: '', balance: '1350.00' });
    });

    it('removes only the header label, so "Transaction Charges" keeps its first word', () => {
        const { transactions } = parse([
            CONTEXT,
            ...PAGE_1,
            ...row(10000, 'Date', 'Transaction Transaction Charges', 'Money out (£) 8.40', 'Money in (£)', 'Balance (£)'),
            ...row(10001, '28 JUL 2026', '', '', '', '1,391.60'),
        ]);

        expect(transactions[2]).toMatchObject({ description: 'Transaction Charges', moneyOut: '8.40', date: '28/07/2026' });
    });
});

describe('Metro parser – ordinary pages are unchanged', () => {
    it('skips a plain repeated header and reads the rows around it', () => {
        const { transactions } = parse([
            CONTEXT,
            ...PAGE_1,
            ...row(10000, ...HEADER),
            ...row(10001, '06 JUL 2026', 'Cash Deposit', '', '300.00', '1,700.00'),
            ...row(10002, '07 JUL 2026', 'Direct Debit EXAMPLE INSURER', '50.00', '', '1,650.00'),
        ]);

        expect(transactions.map(t => t.description)).toEqual([
            'Card Purchase 29 JUN 2026 EXAMPLE STORE LONDON GBR',
            'Inward Payment EXAMPLE CLIENT LTD',
            'Cash Deposit',
            'Direct Debit EXAMPLE INSURER',
        ]);
        expect(sum(transactions, 'moneyIn')).toBe(800);
        expect(sum(transactions, 'moneyOut')).toBe(150);
    });

    it('still reads a repeated header with "Money in (£) Balance (£)" in one cell as a plain header', () => {
        const { transactions } = parse([
            CONTEXT,
            ...PAGE_1,
            ...row(10000, 'Date', 'Transaction', 'Money out (£)', 'Money in (£) Balance (£)'),
            ...row(10001, '07 JUL 2026', 'Direct Debit EXAMPLE INSURER', '50.00', '1,350.00'),
        ]);

        expect(transactions).toHaveLength(3);
        expect(transactions[2]).toMatchObject({ description: 'Direct Debit EXAMPLE INSURER', moneyOut: '50.00', moneyIn: '', balance: '1350.00' });
    });
});
