/**
 * Regression tests for the Revolut parser's Balance summary extraction.
 *
 * Origin: a Revolut Business account statement for 1 Jun – 31 Aug 2026 whose
 * parsed Money In and Money Out were both about £100k above the declared totals.
 * The transactions were right. The statement carries two GBP Balance summaries,
 * because UK clients moved from Revolut Ltd e-money to Revolut Bank UK on
 * 27/28 Jul 2026: one for 1 Jun – 27 Jul, one for 28 Jul – 31 Aug. The parser
 * kept only the last summary, so the declared totals covered five weeks while
 * the rows covered three months. The In and Out diffs equalled the first
 * summary to the penny.
 *
 * The same root cause declared £0.00 / £0.00 for a statement whose last GBP
 * summary was an empty pocket printed after the real account.
 *
 * Every fixture below is synthetic: round amounts, invented counterparties, a
 * self-consistent balance chain. No client statement data is committed here.
 * The tests run without Azure DI credentials.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../revolut.js';
import { Cell } from '../shared.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function c(rowIndex: number, columnIndex: number, content: string): Cell {
    return { rowIndex, columnIndex, content };
}

function sumIn(txns: ReturnType<typeof parse>['transactions']): number {
    return Math.round(txns.reduce((s, t) => s + (parseFloat(t.moneyIn.replace(/,/g, '')) || 0), 0) * 100) / 100;
}

function sumOut(txns: ReturnType<typeof parse>['transactions']): number {
    return Math.round(txns.reduce((s, t) => s + (parseFloat(t.moneyOut.replace(/,/g, '')) || 0), 0) * 100) / 100;
}

/** Balance summary rows as Azure DI emits them: label in col 0, value in col 1. */
function summary(row: number, sym: string, open: string, moneyIn: string, moneyOut: string, close: string): Cell[] {
    return [
        c(row,     0, 'Opening balance'), c(row,     1, `${sym}${open}`),
        c(row + 1, 0, 'Money in'),        c(row + 1, 1, `${sym}${moneyIn}`),
        c(row + 2, 0, 'Money out'),       c(row + 2, 1, `- ${sym}${moneyOut}`),
        c(row + 3, 0, 'Closing balance'), c(row + 3, 1, `${sym}${close}`),
    ];
}

/** 6-col transaction table header: [date, type, desc, out, in, balance]. */
function header(row: number): Cell[] {
    return [
        c(row, 0, 'Date (UTC)'), c(row, 2, 'Description'),
        c(row, 3, 'Money out'), c(row, 4, 'Money in'), c(row, 5, 'Balance'),
    ];
}

function txn(row: number, date: string, type: string, desc: string, out: string, inAmt: string, bal: string): Cell[] {
    const cells = [c(row, 0, date), c(row, 1, type), c(row, 2, desc), c(row, 5, bal)];
    if (out)   cells.push(c(row, 3, out));
    if (inAmt) cells.push(c(row, 4, inAmt));
    return cells;
}

const CONTEXT = c(-1, 0, 'Revolut Business\nAccount statement\nRevolut Ltd is registered in England and Wales (No. 08804411).');

// ── the bank-transition statement ────────────────────────────────────────────

/**
 * Two sequential GBP periods of one account. Rows are newest-first within each
 * period, and the second period starts on a later page (row offset 10000).
 *   Period 1: 1000.00 + 500.00 - 300.00 = 1200.00
 *   Period 2: 1200.00 + 2 000.00 - 700.00 = 2500.00
 */
function bankTransitionStatement(): Cell[] {
    return [
        CONTEXT,
        ...summary(0, '£', '1 000.00', '500.00', '300.00', '1 200.00'),
        ...header(4),
        ...txn(5, '20 Jul 2026', 'MOS', 'To Supplier One Ltd', '£300.00', '', '£1 200.00'),
        ...txn(6, '05 Jun 2026', 'MOA', 'Money added from Client One Ltd', '', '£500.00', '£1 500.00'),

        ...summary(10000, '£', '1 200.00', '2 000.00', '700.00', '2 500.00'),
        ...header(10004),
        ...txn(10005, '25 Aug 2026', 'CAR', 'Card payment Shop Two', '£700.00', '', '£2 500.00'),
        ...txn(10006, '01 Aug 2026', 'MOA', 'Money added from Client Two Ltd', '', '£2 000.00', '£3 200.00'),
    ];
}

describe('Revolut Balance summary: sequential periods (bank transition)', () => {
    it('declares the whole statement, not only the last period', () => {
        const r = parse(bankTransitionStatement());
        expect(r.statementTotals).toEqual({
            moneyIn: 2500, moneyOut: 1000, openingBalance: 1000, closingBalance: 2500,
        });
    });

    it('declared totals match the parsed rows and the balance chain', () => {
        const r = parse(bankTransitionStatement());
        const st = r.statementTotals!;
        expect(r.transactions).toHaveLength(4);
        expect(sumIn(r.transactions)).toBe(st.moneyIn);
        expect(sumOut(r.transactions)).toBe(st.moneyOut);
        expect(st.openingBalance! + st.moneyIn! - st.moneyOut!).toBeCloseTo(st.closingBalance!, 2);
    });

    it('also chains when the later period is printed first', () => {
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '1 200.00', '2 000.00', '700.00', '2 500.00'),
            ...summary(10000, '£', '1 000.00', '500.00',   '300.00', '1 200.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 2500, moneyOut: 1000, openingBalance: 1000, closingBalance: 2500,
        });
    });
});

// ── several accounts on one statement ────────────────────────────────────────

describe('Revolut Balance summary: several accounts', () => {
    it('ignores empty GBP pockets printed after the real account', () => {
        const cells = [
            CONTEXT,
            ...summary(0,     '€', '0.00', '0.00', '0.00', '0.00'),
            ...summary(10000, '£', '0.00', '0.00', '0.00', '0.00'),
            ...summary(20000, '£', '2 000.00', '4 000.00', '3 500.00', '2 500.00'),
            ...summary(30000, '£', '0.00', '0.00', '0.00', '0.00'),
            ...summary(40000, '$', '20.00', '0.00', '0.00', '20.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 4000, moneyOut: 3500, openingBalance: 2000, closingBalance: 2500,
        });
    });

    it('sums parallel GBP accounts whose balances do not chain', () => {
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '2 000.00', '4 000.00', '3 500.00', '2 500.00'),
            ...summary(10000, '£', '100.00',   '50.00',    '30.00',    '120.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 4050, moneyOut: 3530, openingBalance: 2100, closingBalance: 2620,
        });
    });

    it('does not double-count the handover balance when a second account sits beside the transition', () => {
        // Account A: 1000 -> 1200 (Revolut Ltd) -> 2500 (Revolut Bank). Account B: 100 -> 120.
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '1 000.00', '500.00',   '300.00', '1 200.00'),
            ...summary(10000, '£', '100.00',   '50.00',    '30.00',  '120.00'),
            ...summary(20000, '£', '1 200.00', '2 000.00', '700.00', '2 500.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 2550, moneyOut: 1030, openingBalance: 1100, closingBalance: 2620,
        });
    });

    it('chains both accounts when both move across the transition', () => {
        // A: 1000 -> 1200 -> 2500.  B: 100 -> 120 -> 130.  Printed A1, B1, B2, A2.
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '1 000.00', '500.00',   '300.00', '1 200.00'),
            ...summary(10000, '£', '100.00',   '50.00',    '30.00',  '120.00'),
            ...summary(20000, '£', '120.00',   '20.00',    '10.00',  '130.00'),
            ...summary(30000, '£', '1 200.00', '2 000.00', '700.00', '2 500.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 2570, moneyOut: 1040, openingBalance: 1100, closingBalance: 2630,
        });
    });

    it('chains three periods printed out of order, past an empty pocket', () => {
        // 1000 -> 1200 -> 1500 -> 1500, printed as period 2, empty pocket, period 1, period 3.
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '1 200.00', '2 000.00', '1 700.00', '1 500.00'),
            ...summary(10000, '£', '0.00',     '0.00',     '0.00',     '0.00'),
            ...summary(20000, '£', '1 000.00', '500.00',   '300.00',   '1 200.00'),
            ...summary(30000, '£', '1 500.00', '10.00',    '10.00',    '1 500.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 2510, moneyOut: 2010, openingBalance: 1000, closingBalance: 1500,
        });
    });

    it('does not treat balances one penny apart as a chain', () => {
        // 10.03 - 10.02 is below 0.01 in floating point; these are two separate accounts.
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '5.00',  '10.02', '5.00', '10.02'),
            ...summary(10000, '£', '10.03', '1.00',  '1.00', '10.03'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 11.02, moneyOut: 6, openingBalance: 15.03, closingBalance: 20.05,
        });
    });

    it('leaves the opening balance unknown when one summary is missing it', () => {
        const cells = [
            CONTEXT,
            ...summary(0, '£', '100.00', '50.00', '30.00', '120.00'),
            c(10000, 0, 'Money in'),        c(10000, 1, '£10.00'),
            c(10001, 0, 'Money out'),       c(10001, 1, '- £5.00'),
            c(10002, 0, 'Closing balance'), c(10002, 1, '£5.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 60, moneyOut: 35, openingBalance: undefined, closingBalance: 125,
        });
    });
});

// ── behaviour that must not change ───────────────────────────────────────────

describe('Revolut Balance summary: single-summary statements', () => {
    it('reads one GBP summary as before', () => {
        const cells = [CONTEXT, ...summary(0, '£', '300.00', '1 000.00', '900.00', '400.00')];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 1000, moneyOut: 900, openingBalance: 300, closingBalance: 400,
        });
    });

    it('reads the Bulgarian labels', () => {
        const cells = [
            CONTEXT,
            c(0, 0, 'Начален баланс'), c(0, 1, '£100.00'),
            c(1, 0, 'Входяща сума'),   c(1, 1, '£2 000.00'),
            c(2, 0, 'Изходяща сума'),  c(2, 1, '- £1 500.00'),
            c(3, 0, 'Краен баланс'),   c(3, 1, '£600.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 2000, moneyOut: 1500, openingBalance: 100, closingBalance: 600,
        });
    });

    it('keeps an all-zero GBP summary when it is the only one', () => {
        const cells = [CONTEXT, ...summary(0, '£', '0.00', '0.00', '0.00', '0.00')];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 0, moneyOut: 0, openingBalance: 0, closingBalance: 0,
        });
    });

    it('returns zero totals when every GBP summary is empty', () => {
        const cells = [
            CONTEXT,
            ...summary(0,     '£', '0.00', '0.00', '0.00', '0.00'),
            ...summary(10000, '£', '0.00', '0.00', '0.00', '0.00'),
        ];
        expect(parse(cells).statementTotals).toEqual({
            moneyIn: 0, moneyOut: 0, openingBalance: 0, closingBalance: 0,
        });
    });

    it('returns no totals when the statement has no GBP summary', () => {
        const cells = [CONTEXT, ...summary(0, '€', '10.00', '5.00', '0.00', '15.00')];
        expect(parse(cells).statementTotals).toBeUndefined();
    });
});
