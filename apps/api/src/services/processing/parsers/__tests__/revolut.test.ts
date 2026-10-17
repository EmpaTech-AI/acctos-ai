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

// ── amounts over £1,000 that also show the foreign amount ────────────────────

/**
 * Origin: a Revolut Business statement whose Money Out came out £6,214.69 under
 * the declared total. Revolut prints thousands with a space, and a payment abroad
 * shows the foreign amount after the sterling one: "£1 072.35 €1 228.90". The
 * parser took the digits up to the first space, so four such payments were
 * recorded as £1 or £3.
 *
 * Newest first: 10,000.00 → -1,500.00 → 8,500.00 → -7.99 → 8,492.01 → +250.00 → 8,742.01
 */
describe('Revolut amounts with a space for thousands and a foreign amount beside them', () => {
    const cells = [
        CONTEXT,
        ...summary(0, '£', '10 000.00', '250.00', '1 507.99', '8 742.01'),
        ...header(5),
        ...txn(6, '20 Jan 2025', 'MOR', 'From Example Client Ltd', '', '£250.00', '£8 742.01'),
        ...txn(7, '10 Jan 2025', 'CAR', 'Example Tools FX Rate GBP 1 = USD 1.250718', '£7.99 $9.99', '', '£8 492.01'),
        ...txn(8, '5 Jan 2025', 'MOS', 'To Example Agency GmbH FX Rate GBP 1 = EUR 1.146007, Fee: £0.23', '£1 500.00 €1 719.01', '', '£8 500.00'),
    ];
    const { transactions, statementTotals } = parse(cells);

    it('reads the whole sterling amount', () => {
        expect(transactions.map(t => t.moneyOut)).toEqual([String(), '7.99', '1500.00']);
    });

    it('then matches the declared totals', () => {
        expect(sumIn(transactions)).toBe(statementTotals!.moneyIn);
        expect(sumOut(transactions)).toBe(statementTotals!.moneyOut);
    });

    it('does not run a small sterling amount into the foreign amount after it', () => {
        const { transactions: t } = parse([
            CONTEXT,
            ...header(0),
            ...txn(1, '5 Jan 2025', 'CAR', 'Example Shop Istanbul', '£5.00 574.00 TRY', '', '£95.00'),
        ]);
        expect(t[0].moneyOut).toBe('5.00');
    });
});

// ── accounts in other currencies ─────────────────────────────────────────────

/**
 * Origin: the same statement also held a "Main" USD account with three refunds
 * ($45.22) and two card payments. They were added to the sterling rows as if they
 * were pounds, so Money In came out £45.22 over the declared (sterling) total.
 */
describe('Revolut statement with a second account in another currency', () => {
    const gbp = [
        ...summary(0, '£', '100.00', '250.00', '50.00', '300.00'),
        ...header(5),
        ...txn(6, '20 Jan 2025', 'MOR', 'From Example Client Ltd', '', '£250.00', '£300.00'),
        ...txn(7, '10 Jan 2025', 'CAR', 'Example Shop', '£50.00', '', '£50.00'),
    ];
    const usd = [
        ...summary(10000, '$', '0.00', '45.22', '21.99', '23.23'),
        ...header(10005),
        ...txn(10006, '16 Aug 2025', 'MOR', 'Refund from Example Video', '', '$45.22', '$23.23'),
        ...txn(10007, '5 Jun 2025', 'CAR', 'Example Video', '$21.99', '', '-$21.99'),
    ];

    it('keeps the sterling rows and leaves the dollar rows out', () => {
        const { transactions, statementTotals } = parse([CONTEXT, ...gbp, ...usd]);

        expect(transactions.map(t => t.description)).toEqual(['From Example Client Ltd', 'Example Shop']);
        expect(sumIn(transactions)).toBe(statementTotals!.moneyIn);
        expect(sumOut(transactions)).toBe(statementTotals!.moneyOut);
    });

    it('keeps the rows of a statement that has no sterling account at all', () => {
        const { transactions } = parse([CONTEXT, ...usd.map(x => ({ ...x, rowIndex: x.rowIndex - 10000 }))]);

        expect(transactions).toHaveLength(2);
        expect(sumIn(transactions)).toBe(45.22);
    });
});

// ── Transaction statement in Bulgarian ───────────────────────────────────────
//
// Origin: a Revolut Business "Извлечение за трансакции" (transaction statement)
// exported in Bulgarian (17 Oct 2026) gave 0 transactions: the layout was only
// recognised by its English column names "Status" and "Account". Azure DI also
// read 3 as the Cyrillic З, "авг" as "abr", codes as Cyrillic look-alikes ("МОА"),
// £ as E, f, $ or {, put date and description in one cell, and printed the year
// on the next line. A transaction statement has no balances and no summary.

describe('Revolut transaction statement in Bulgarian', () => {
    const page2 = 10000;   // the orchestrator offsets each page's rows
    const cells: Cell[] = [
        c(0, 0, 'Дата (UTC)'), c(0, 1, 'Описание'), c(0, 3, 'Състояние'), c(0, 4, 'Сметка'), c(0, 5, 'Изходяща сума'), c(0, 6, 'Входяща сума'),
        c(1, 0, '1 юли 2026'), c(1, 1, 'CAR Example Builders Merchant'), c(1, 3, 'Завършена'), c(1, 4, 'Main · GBP'), c(1, 5, '£75.50'),
        c(2, 0, 'З юли 2026'), c(2, 1, 'MOS До Example Person · Work'), c(2, 3, 'Завършена'), c(2, 4, 'Main · GBP'), c(2, 5, 'E1 150.00'),
        c(3, 0, '3 юли 2026'), c(3, 1, 'МОА Добавени пари от Example Software Ltd • Invoice 7'), c(3, 3, 'Завършена'), c(3, 4, 'Main · GBP'), c(3, 6, 'f2 000.00'),
        c(4, 0, '4 юли 2026'), c(4, 1, 'MOR Възстановена сума от Example Hardware'), c(4, 3, 'Завършена'), c(4, 4, 'Main · GBP'), c(4, 5, '$53.86'),
        // a page where Azure merged columns: date and description share the first cell
        c(page2 + 0, 0, '27 cen 2026 CAR Example Fuel Station'), c(page2 + 0, 1, 'Завършена'), c(page2 + 0, 2, 'Main · GBP'), c(page2 + 0, 3, 'E41.82'),
        // the year printed on the next line
        c(page2 + 1, 0, '29 abr'), c(page2 + 1, 1, 'CAR Example Parking'), c(page2 + 1, 2, 'Завършена Main · GBP'), c(page2 + 1, 4, '{12.00'),
        c(page2 + 2, 0, '2026'), c(page2 + 2, 3, 'GBP'),
        // a card payment in euros: the euro amount sits alone on the next line
        c(page2 + 3, 0, '21 сеп 2026'), c(page2 + 3, 1, 'CAR Example Shop Обменен курс GBP 1 = EUR 1.17, Такса: E2.00'),
        c(page2 + 3, 2, 'Завършена'), c(page2 + 3, 3, 'Main ·'), c(page2 + 3, 4, 'E256.00'),
        c(page2 + 4, 3, 'GBP'), c(page2 + 4, 4, 'Є297.18'),
    ];
    const { transactions, statementTotals } = parse(cells);

    it('reads every transaction', () => {
        expect(transactions.map(t => t.date)).toEqual([
            '01/07/2026', '03/07/2026', '03/07/2026', '04/07/2026', '27/09/2026', '29/08/2026', '21/09/2026',
        ]);
    });

    it('takes the direction from the transaction code', () => {
        expect(transactions.filter(t => t.moneyIn).map(t => t.type)).toEqual(['MOA', 'MOR']);
        expect(sumIn(transactions)).toBe(2053.86);
        expect(sumOut(transactions)).toBe(1535.32);
    });

    it('splits a merged date cell into date, code and description', () => {
        expect(transactions[4]).toMatchObject({ type: 'CAR', description: 'Example Fuel Station', moneyOut: '41.82' });
    });

    it('has no declared totals to check against', () => {
        expect(statementTotals).toBeUndefined();
    });
});

describe('Revolut transaction statement in English', () => {
    it('reads as before', () => {
        const { transactions } = parse([
            c(0, 0, 'Date (UTC)'), c(0, 1, 'Description'), c(0, 2, 'Status'), c(0, 3, 'Account'), c(0, 4, 'Money out'), c(0, 5, 'Money in'),
            c(1, 0, '1 Jul 2026'), c(1, 1, 'CAR Example Shop'), c(1, 2, 'Completed'), c(1, 3, 'Main · GBP'), c(1, 4, '£10.00'),
            c(2, 0, '2 Jul 2026'), c(2, 1, 'MOA Money added from Example Client Ltd'), c(2, 2, 'Completed'), c(2, 3, 'Main · GBP'), c(2, 5, '£500.00'),
        ]);
        expect(transactions.map(t => [t.date, t.moneyIn, t.moneyOut])).toEqual([
            ['01/07/2026', '', '10.00'],
            ['02/07/2026', '500.00', ''],
        ]);
    });
});
