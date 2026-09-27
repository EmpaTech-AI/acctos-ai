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
import { parse } from '../monzo.js';
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
