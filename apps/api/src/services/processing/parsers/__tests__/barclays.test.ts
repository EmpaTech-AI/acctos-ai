/**
 * Barclays statement totals keep the sign of an overdrawn balance.
 *
 * Origin: a statement that started overdrawn ("Start balance -£5.66") was read as
 * +£5.66, while the previous statement's end balance was correctly -£5.66. The chain
 * check then raised a gap alert (£0.00 overall) and the Files sheet showed the wrong
 * opening balance. Cells below are shaped exactly as Azure DI returned them.
 */

import { describe, it, expect } from 'vitest';
import { extractBarclaysStatementTotals, parse } from '../barclays.js';
import type { Cell } from '../shared.js';

const summary = (start: string, moneyIn: string, moneyOut: string, end: string): Cell[] => [
    { rowIndex: 0, columnIndex: 0, content: 'Start balance' }, { rowIndex: 0, columnIndex: 1, content: start },
    { rowIndex: 1, columnIndex: 0, content: 'Money in' },      { rowIndex: 1, columnIndex: 1, content: moneyIn },
    { rowIndex: 2, columnIndex: 0, content: 'Money out' },     { rowIndex: 2, columnIndex: 1, content: moneyOut },
    { rowIndex: 3, columnIndex: 0, content: 'End balance' },   { rowIndex: 3, columnIndex: 1, content: end },
];

describe('extractBarclaysStatementTotals', () => {
    it('keeps a negative start balance (statement starts overdrawn)', () => {
        const t = extractBarclaysStatementTotals(summary('-£5.66', '£2,189.67', '£2,133.75', '£50.26'));
        expect(t).toMatchObject({ openingBalance: -5.66, moneyIn: 2189.67, moneyOut: 2133.75, closingBalance: 50.26 });
        // and the statement balances: opening + in - out = closing
        expect(Math.round((t!.openingBalance! + t!.moneyIn! - t!.moneyOut!) * 100) / 100).toBe(t!.closingBalance);
    });

    it('keeps a negative end balance (statement ends overdrawn)', () => {
        const t = extractBarclaysStatementTotals(summary('£87.15', '£1,864.20', '£1,957.01', '-£5.66'));
        expect(t).toMatchObject({ openingBalance: 87.15, closingBalance: -5.66 });
    });

    it('reads the "OD" suffix as overdrawn on either balance', () => {
        const t = extractBarclaysStatementTotals(summary('£1.74 OD', '£2,323.37', '£2,071.82', '£249.81'));
        expect(t).toMatchObject({ openingBalance: -1.74, closingBalance: 249.81 });
    });

    it('keeps positive balances positive', () => {
        const t = extractBarclaysStatementTotals(summary('£80.59', '£2,417.44', '£2,410.88', '£87.15'));
        expect(t).toMatchObject({ openingBalance: 80.59, closingBalance: 87.15 });
    });

    it('keeps the sign when the balances come from the page text instead of cells', () => {
        const cells: Cell[] = [
            { rowIndex: -1, columnIndex: 0, content: 'Continued\nMoney in\n£2,323.37\nMoney out\n£2,071.82\nStart balance\n-£1.74\nEnd balance\n£249.81 OD' },
        ];
        const t = extractBarclaysStatementTotals(cells);
        expect(t).toMatchObject({ openingBalance: -1.74, closingBalance: -249.81, moneyIn: 2323.37, moneyOut: 2071.82 });
    });
});

/**
 * The first statement of a newly opened Barclays business account.
 *
 * Origin: a statement for 12 May – 11 Jun whose table has no "brought forward"
 * row, only an "Account Opened" line with a balance of 0.00. Three things went
 * wrong at once:
 *   - every date came out a year early: an OCR fix-up glued "11 Jun 2026" into
 *     "11 Jun2026", so the statement period no longer parsed and the year fell
 *     back to the oldest one printed anywhere ("Rate effective from 18 Dec 2025");
 *   - the "Balance carried forward" line was taken as the opening balance, which
 *     turned "Account Opened" into a payment of the whole closing balance;
 *   - the FSCS notice printed under the table was appended to the description of
 *     the last transaction.
 *
 * Amounts and names below are made up; the row shapes are as Azure DI returned them.
 */

function row(r: number, ...cols: string[]): Cell[] {
    return cols.map((content, columnIndex) => ({ rowIndex: r, columnIndex, content })).filter(c => c.content !== '');
}

describe('Barclays parser – first statement of a new account', () => {
    const cells: Cell[] = [
        { rowIndex: -1, columnIndex: 0, content: [
            'BARCLAYS', 'Your Business Current Account', 'Issued on 12 June 2026',
            'At a glance', '12 May - 11 Jun 2026',
            'Start balance', '£0.00', 'Money out', '£400.00', 'Money in', '£600.50', 'End balance', '£200.50',
            'Bank of England Base Rate Information', 'Rate effective from 18 Dec 2025 was', '3.750%',
        ].join('\n') },
        ...row(0, 'Date', 'Description', 'Money out £', 'Money in £', 'Balance £'),
        ...row(1, '12 May', 'Account Opened', '', '', '0.00'),
        ...row(2, '18 May', ':unselected: Direct Credit From Example A Ref: Test', '', '0.50', '0.50'),
        ...row(3, '29 May', ':unselected: Internet Banking Transfer to Account 00000000 at 00-00-00 Payment', '400.00', '', '-399.50'),
        ...row(4, '', 'Giro Direct Credit From Example Client Ltd Ref: Invoice', '', '600.00', '200.50'),
        ...row(5, '11 Jun', 'Balance carried forward', '', '', '200.50'),
        ...row(6, '', 'Total Payments/Receipts', '400.00', '600.50'),
        ...row(8, 'Money in', '£600.50'),
        ...row(9, 'End balance', '£200.50'),
        ...row(11, 'Bank of England Base Rate Information'),
        ...row(12, 'Rate effective from 18 Dec 2025 was', '3.750%'),
        ...row(14, 'Limit of protection', '£120,000 per depositor per bank, building society or credit union.'),
        ...row(16, '', 'To ensure the FSCS can pay you promptly please ensure that the bank has your up-to-date contact details.'),
        ...row(18, '', 'Eligible deposits in business accounts are treated as if made by a single depositor.'),
        ...row(20, '', '(a) Transactions relating to the purchase and sale of your main home.'),
        ...row(26, '', 'Telephone: 0800 000 0000'),
    ];
    const { transactions, statementTotals } = parse(cells);

    it('does not turn "Account Opened" into a payment', () => {
        expect(transactions.map(t => t.description)).toEqual([
            'Direct Credit From Example A Ref: Test',
            'Internet Banking Transfer to Account 00000000 at 00-00-00 Payment',
            'Giro Direct Credit From Example Client Ltd Ref: Invoice',
        ]);
    });

    it('matches the totals the statement declares', () => {
        const total = (k: 'moneyIn' | 'moneyOut') => Math.round(transactions.reduce((s, t) => s + (parseFloat(t[k]) || 0), 0) * 100) / 100;
        expect(total('moneyIn')).toBe(600.5);
        expect(total('moneyOut')).toBe(400);
        expect(statementTotals).toMatchObject({ moneyIn: 600.5, moneyOut: 400, openingBalance: 0, closingBalance: 200.5 });
    });

    it('dates a statement that ends in June in the year of its period', () => {
        expect(transactions.map(t => t.date)).toEqual(['18/05/2026', '29/05/2026', '29/05/2026']);
    });

    it('does not append the small print under the table to the last transaction', () => {
        expect(transactions[2].description).toBe('Giro Direct Credit From Example Client Ltd Ref: Invoice');
    });
});

describe('Barclays parser – a statement that continues over two pages', () => {
    // Opening 1,000.00. Page 1: -100.00. Page 2: +250.00, and a description that runs on.
    const { transactions } = parse([
        { rowIndex: -1, columnIndex: 0, content: 'BARCLAYS\nAt a glance\n12 Jun - 11 Jul 2026\nStart balance\n£1,000.00\nMoney out\n£100.00\nMoney in\n£250.00\nEnd balance\n£1,150.00' },
        ...row(0, 'Date', 'Description', 'Money out £', 'Money in £', 'Balance £'),
        ...row(1, '12 Jun', 'Start balance', '', '', '1,000.00'),
        ...row(2, '15 Jun', 'Card Purchase Example Store On 13 Jun', '100.00', '', '900.00'),
        ...row(3, '', 'Balance carried forward', '', '', '900.00'),
        ...row(4, '', 'Some small print under the first page of the table.'),
        ...row(10, 'Date', 'Description', 'Money out £', 'Money in £', 'Balance £'),
        ...row(11, '', 'Balance brought forward', '', '', '900.00'),
        ...row(12, '20 Jun', 'Giro Direct Credit From Example Client Ltd', '', '250.00', '1,150.00'),
        ...row(13, '', 'Ref: Invoice 42'),
    ]);

    it('keeps reading after the page break, and keeps genuine continuation lines', () => {
        expect(transactions).toEqual([
            { date: '15/06/2026', type: '', description: 'Card Purchase Example Store On 13 Jun', moneyIn: '', moneyOut: '100.00', balance: '900.00' },
            { date: '20/06/2026', type: '', description: 'Giro Direct Credit From Example Client Ltd Ref: Invoice 42', moneyIn: '250.00', moneyOut: '', balance: '1150.00' },
        ]);
    });
});
