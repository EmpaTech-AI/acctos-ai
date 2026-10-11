/**
 * Regression tests for the Monzo parser's declared-totals extraction.
 *
 * Origin: a Monzo Business statement for 1 Jun – 31 Aug 2026 whose parsed
 * Money In and Money Out were ~£32k and ~£26k above the declared totals. The
 * transactions were right and matched the header to the penny. Azure DI had
 * read the header's two columns interleaved, so a line of the address block
 * sat between each amount and its label:
 *
 *   +£32,534.79 ⏎ Account number: 43588045 ⏎ Total deposits
 *
 * The regexes required the label to follow the amount directly, found
 * nothing, and fell back to summing transactions. The orchestrator parses
 * Monzo one page at a time and keeps the first page's totals, so the
 * "declared" figures were page 1's rows alone.
 *
 * The same layout left the closing balance at £0.00, and "Personal Account
 * balance" was never matched at all, so personal statements' opening balance
 * came out as outgoings − deposits.
 *
 * Every fixture below is synthetic: round amounts, invented names, a
 * self-consistent balance chain. No client statement data is committed here.
 * The tests run without Azure DI credentials.
 */

import { describe, it, expect } from 'vitest';
import { parse, dropPotStatements } from '../monzo.js';
import { Cell, ParsedTransaction } from '../shared.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function c(rowIndex: number, columnIndex: number, content: string): Cell {
    return { rowIndex, columnIndex, content };
}

/** One 4-col Monzo row: [date, description, amount, balance]. */
function row(r: number, date: string, desc: string, amount: string, balance: string): Cell[] {
    return [c(r, 0, date), c(r, 1, desc), c(r, 2, amount), c(r, 3, balance)];
}

const HEADER: Cell[] = [c(0, 0, 'Date'), c(0, 1, 'Description'), c(0, 2, '(GBP) Amount'), c(0, 3, '(GBP) Balance')];

/** Parse page by page with a shared context cell, as ProcessingOrchestrator.parseAllCells does for Monzo. */
function parsePages(context: string, pages: Cell[][]) {
    const txns: ParsedTransaction[] = [];
    let statementTotals: ReturnType<typeof parse>['statementTotals'];
    for (const cells of pages) {
        const res = parse([{ rowIndex: -1, columnIndex: -1, content: context }, ...cells]);
        txns.push(...res.transactions);
        if (!statementTotals && res.statementTotals) statementTotals = res.statementTotals;
    }
    return { txns, statementTotals };
}

const sum = (txns: ParsedTransaction[], k: 'moneyIn' | 'moneyOut') =>
    Math.round(txns.reduce((s, t) => s + (parseFloat(t[k].replace(/,/g, '')) || 0), 0) * 100) / 100;

// Newest first, opening 100.00 → closing 1,250.00. In 2,000.00, Out 850.00.
const PAGE_1: Cell[] = [
    ...HEADER,
    ...row(1, '30/08/2026', 'CAFE ONE LONDON GBR', '-50.00', '1,250.00'),
    ...row(2, '29/08/2026', 'ACME LTD (Faster Payments) Reference: INV 2', '500.00', '1,300.00'),
];
const PAGE_2: Cell[] = [
    ...row(0, '20/07/2026', 'SUPPLIER CO (Faster Payments) Reference: Pay', '-800.00', '800.00'),
    ...row(1, '10/06/2026', 'ACME LTD (Faster Payments) Reference: INV 1', '1,500.00', '1,600.00'),
];

// ── tests ────────────────────────────────────────────────────────────────────

describe('Monzo declared totals', () => {
    it('reads totals when Azure DI interleaves the address column between amount and label', () => {
        const context = [
            'monzo', 'Business Account statement 01/06/2026 - 31/08/2026', 'Jane Example',
            '£1,250.00', 'EXAMPLE TRADING LTD', 'Business Account balance', '1 Sample Street',
            '(Excluding all Pots)', 'London', '£0.00', 'United Kingdom', 'Balance in Pots',
            '(This includes both Regular Pots with Monzo and Savings Pots with external providers)',
            '-£850.00', 'Total outgoings', 'Sort code: 04-00-03',
            '+£2,000.00', 'Account number: 12345678', 'Total deposits',
        ].join('\n');

        const { txns, statementTotals } = parsePages(context, [PAGE_1, PAGE_2]);

        expect(sum(txns, 'moneyIn')).toBe(2000);
        expect(sum(txns, 'moneyOut')).toBe(850);
        expect(statementTotals).toEqual({ moneyIn: 2000, moneyOut: 850, openingBalance: 100, closingBalance: 1250 });
    });

    it('still reads the layout where each label follows its amount directly', () => {
        const context = [
            'Sort code: 04-00-03 Account number: 12345678',
            '£1,250.00 Business Account balance (Excluding all Pots)',
            '£0.00', 'Balance in Pots',
            '-£850.00', 'Total outgoings', '+£2,000.00', 'Total deposits', 'Date', 'Description',
        ].join('\n');

        const { statementTotals } = parsePages(context, [PAGE_1, PAGE_2]);

        expect(statementTotals).toEqual({ moneyIn: 2000, moneyOut: 850, openingBalance: 100, closingBalance: 1250 });
    });

    it('reads the closing balance of a Personal account', () => {
        const context = [
            'Jane Example', '£1,250.00', '1 Sample Street', 'Personal Account balance', 'London',
            '(Excluding all Pots)', '£0.00', 'Balance in Pots',
            '(This includes both Regular Pots with Monzo and Savings Pots with external providers) -£850.00',
            'Total outgoings', 'Sort code: 04-00-03', '+£2,000.00', 'Account number: 12345678', 'Total deposits',
        ].join('\n');

        const { statementTotals } = parsePages(context, [PAGE_1, PAGE_2]);

        expect(statementTotals?.closingBalance).toBe(1250);
        expect(statementTotals?.openingBalance).toBe(100);
    });

    it('reads an overdrawn closing balance as negative', () => {
        const context = [
            '-£25.00 Business Account balance', '£0.00', 'Balance in Pots',
            '-£85.00', 'Total outgoings', '+£10.00', 'Total deposits',
        ].join('\n');

        const { statementTotals } = parsePages(context, [[
            ...HEADER,
            ...row(1, '02/06/2026', 'SHOP GBR', '-85.00', '-25.00'),
            ...row(2, '01/06/2026', 'ACME LTD', '10.00', '60.00'),
        ]]);

        expect(statementTotals).toEqual({ moneyIn: 10, moneyOut: 85, openingBalance: 50, closingBalance: -25 });
    });
});

/**
 * Origin: a Monzo Personal statement for Nov 2025 whose parsed Money Out was
 * £7.90 below the declared total. The oldest row, at the bottom of the last
 * page, had an empty balance cell in Azure DI's table although the balance
 * was in the page text, and the 4-col path skipped any row without one.
 */
describe('Monzo row with an empty balance cell', () => {
    it('keeps the row and rebuilds its balance from the newer row above it', () => {
        const { transactions } = parse([
            ...HEADER,
            ...row(1, '02/11/2025', 'ACME LTD (Faster Payments) Reference: SALARY', '500.00', '520.00'),
            ...row(2, '01/11/2025', 'TRANSPORT GBR', '-8.00', ''),
        ]);

        expect(transactions).toHaveLength(2);
        expect(transactions[1]).toMatchObject({ date: '01/11/2025', moneyOut: '8.00', moneyIn: '', balance: '20.00' });
    });

    it('keeps the row with a blank balance when no newer row is on the page', () => {
        const { transactions } = parse([
            ...HEADER,
            ...row(1, '01/11/2025', 'TRANSPORT GBR', '-8.00', ''),
            ...row(2, '31/10/2025', 'ACME LTD', '100.00', '28.00'),
        ]);

        expect(transactions).toHaveLength(2);
        expect(transactions[0]).toMatchObject({ moneyOut: '8.00', balance: '' });
    });
});

/**
 * A Monzo statement "including all Pots" carries each pot's own statement after
 * the account's.
 *
 * Origin: a 192-page personal statement for a year came out about £2,300 over
 * the declared totals on both sides. Pages 154 onwards were the pots, and every
 * row there is the other side of a "Transfer to Pot" / "Transfer from Pot" row
 * already in the account.
 */
describe('Monzo pot statements', () => {
    const account = { cells: [], content: 'monzo\nPersonal Account statement\n01/06/2026 - 31/08/2026\nJane Example\n-£850.00\nTotal outgoings\n+£2,000.00\nTotal deposits\nBIC: MONZGB2L' };
    const more    = { cells: [], content: 'Date\nDescription\n(GBP) Amount\n(GBP) Balance\n20/07/2026\nTransfer to Pot\n-10.00\n790.00' };
    const pot     = { cells: [], content: 'monzo\nJane Example\nPot statement\n01/06/2026 - 31/08/2026\n£10.00 Pot balance\n-£0.00\nTotal outgoings\n+£10.00\nTotal deposits\nHoliday\nPot name' };
    const potMore = { cells: [], content: 'Date\nDescription\n(GBP) Amount\n(GBP) Balance\n20/07/2026\nDeposit\n10.00\n10.00' };

    it('keeps the account pages and drops everything from the first pot statement', () => {
        expect(dropPotStatements([account, more, pot, potMore, pot, potMore])).toEqual([account, more]);
    });

    it('leaves a statement without pots alone', () => {
        const pages = [account, more, null];
        expect(dropPotStatements(pages)).toBe(pages);
    });

    it('leaves a document that is only a pot statement alone', () => {
        const pages = [pot, potMore];
        expect(dropPotStatements(pages)).toBe(pages);
    });

    it('is not triggered by a row that merely mentions a pot', () => {
        const pages = [account, { cells: [], content: '20/07/2026\nTransfer to Pot\n-10.00\n790.00\nPot statement fee\n-1.00' }];
        expect(dropPotStatements(pages)).toBe(pages);
    });
});

/**
 * Azure DI sometimes drops the minus sign from an overdrawn balance.
 *
 * Origin: ten rows of the same statement showed e.g. 83.78 between -109.66 and
 * -26.64. The amounts were right, so totals matched, but the Balance column was
 * wrong on those rows.
 */
describe('Monzo balance sign', () => {
    const NO_CONTEXT = String();

    // Newest first. -26.64 → (-57.14) → -83.78 → (-25.88) → -109.66
    it('restores a minus sign the older row proves was lost', () => {
        const { txns } = parsePages(NO_CONTEXT, [[
            ...HEADER,
            ...row(1, '25/03/2026', 'SHOP ONE LONDON GBR', '-25.88', '-109.66'),
            ...row(2, '25/03/2026', 'SHOP TWO LONDON GBR', '-57.14', '83.78'),
            ...row(3, '25/03/2026', 'SHOP THREE LONDON GBR', '-10.00', '-26.64'),
        ]]);
        expect(txns.map(t => t.balance)).toEqual(['-109.66', '-83.78', '-26.64']);
    });

    it('leaves a genuinely positive balance alone', () => {
        const { txns } = parsePages(NO_CONTEXT, [[
            ...HEADER,
            ...row(1, '25/03/2026', 'ACME LTD (Faster Payments)', '200.00', '83.78'),
            ...row(2, '25/03/2026', 'SHOP THREE LONDON GBR', '-10.00', '-116.22'),
        ]]);
        expect(txns.map(t => t.balance)).toEqual(['83.78', '-116.22']);
    });

    it('does not take a repeated header row for a balance of zero', () => {
        const { txns } = parsePages(NO_CONTEXT, [[
            ...HEADER,
            ...row(1, '25/03/2026', 'SHOP ONE LONDON GBR', '-25.00', '25.00'),
            ...HEADER.map(h => ({ ...h, rowIndex: 2 })),
        ]]);
        expect(txns[0].balance).toBe('25.00');
    });
});
