/**
 * Regression tests for the Lloyds business "Select Statement" layout.
 *
 * Origin: a Lloyds business statement was routed to the HSBC parser, because the
 * text never names Lloyds and one payee read "FPI HSBC (FASTER PAYME...". The
 * Lloyds parser did not know the layout either, so it returned no transactions.
 *
 * Every sheet ends with "TOTAL PAYMENTS/RECEIPTS: <paid out> <paid in>". Azure DI
 * either gives that footer a row of its own, which the HSBC parser read as a
 * transaction carrying the sheet totals, or merges it into the sheet's last
 * transaction, whose own amount was then replaced by the sheet's paid-in total.
 * Income came out doubled and the categorised Money Out was short.
 *
 * Every fixture below is synthetic: round amounts, invented counterparties, a
 * self-consistent balance chain. No client statement data is committed here.
 * The tests run without Azure DI credentials.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../lloyds.js';
import { detectBankFromContent } from '../../DocumentClassifier.js';
import { Cell } from '../shared.js';

function c(rowIndex: number, columnIndex: number, content: string): Cell {
    return { rowIndex, columnIndex, content };
}

function row(r: number, date: string, activity: string, out: string, inAmt: string, bal: string): Cell[] {
    return [c(r, 0, date), c(r, 1, activity), c(r, 2, out), c(r, 3, inAmt), c(r, 4, bal)];
}

function header(r: number, date: string, balance: string): Cell[] {
    return [
        c(r, 0, date), c(r, 1, 'Activity'), c(r, 2, 'Paid out'), c(r, 3, 'Paid in'),
        c(r, 4, `Sheet: 1 Of 2 Date issued: 31/01/2026 Balance ${balance}`),
    ];
}

const CONTEXT_TEXT =
    'Select Statement - 11112222 EXAMPLE TRADING LTD\naccount statement BUSINESS ACCOUNT\n' +
    'Sort Code: 301234 Account no: 11112222\nFPI HSBC (FASTER PAYME REF 1\nTOTAL PAYMENTS/RECEIPTS:\n' +
    'BGC-Bank Giro Credit BP-Bill Payments CHG-Charge';

/**
 * Two sheets. Opening 1000.00.
 *   Sheet 1: out 100.00 + 20.00, in 500.00             → footer on its own row: 120.00 / 500.00
 *   Sheet 2: out 30.00 + 50.00 (last, footer merged), in 200.00 → footer 80.00 / 200.00
 *   Closing: 1000 + 700 - 200 = 1500.00
 */
function selectStatement(): Cell[] {
    return [
        c(-1, -1, CONTEXT_TEXT),
        // sheet 1
        ...header(0, 'Date', '1,000.00'),
        c(1, 0, '02Jan26'),                                              // brought-forward date, no amounts
        ...row(2, '03Jan26', 'FPO EXAMPLE SUPPLIER REF 1', '100.00', '', '900.00'),
        ...row(3, '05Jan26', 'FPI HSBC (FASTER PAYME REF 2', '', '500.00', '1,400.00'),
        ...row(4, '06Jan26', 'DEB EXAMPLE SHOP', '20.00', '', '1,380.00'),
        c(5, 1, 'CD 1234 TOTAL PAYMENTS/RECEIPTS:'), c(5, 2, '120.00'), c(5, 3, '500.00'),
        // sheet 2 — the header repeats, carrying the brought-forward date and balance
        ...header(10000, 'Date 06Jan26', '1,380.00'),
        ...row(10001, '10Jan26', 'DD EXAMPLE UTILITY', '30.00', '', '1,350.00'),
        ...row(10002, '12Jan26', 'BGC EXAMPLE CUSTOMER', '', '200.00', '1,550.00'),
        ...row(10003, '15Jan26', 'DEB EXAMPLE PARKING TOTAL PAYMENTS/RECEIPTS:', '50.00 80.00', '200.00', '1,500.00'),
    ];
}

describe('Lloyds Select Statement', () => {
    it('reads the transactions and ignores the sheet footers', () => {
        const r = parse(selectStatement());
        expect(r.transactions.map(t => [t.date, t.type, t.description, t.moneyIn, t.moneyOut, t.balance])).toEqual([
            ['03/01/2026', 'FPO', 'EXAMPLE SUPPLIER REF 1',       '',       '100.00', '900.00'],
            ['05/01/2026', 'FPI', 'HSBC (FASTER PAYME REF 2',     '500.00', '',       '1400.00'],
            ['06/01/2026', 'DEB', 'EXAMPLE SHOP CD 1234',         '',       '20.00',  '1380.00'],
            ['10/01/2026', 'DD',  'EXAMPLE UTILITY',              '',       '30.00',  '1350.00'],
            ['12/01/2026', 'BGC', 'EXAMPLE CUSTOMER',             '200.00', '',       '1550.00'],
            ['15/01/2026', 'DEB', 'EXAMPLE PARKING',              '',       '50.00',  '1500.00'],
        ]);
        expect(r.ascending).toBe(true);
    });

    it('declares the sum of the sheet footers, the opening balance and the closing balance', () => {
        expect(parse(selectStatement()).statementTotals).toEqual({
            moneyIn: 700, moneyOut: 200, openingBalance: 1000, closingBalance: 1500,
        });
    });

    it('parsed rows match the declared totals and chain from opening to closing', () => {
        const r = parse(selectStatement());
        const st = r.statementTotals!;
        const sum = (k: 'moneyIn' | 'moneyOut') => r.transactions.reduce((s, t) => s + (parseFloat(t[k]) || 0), 0);
        expect(sum('moneyIn')).toBeCloseTo(st.moneyIn!, 2);
        expect(sum('moneyOut')).toBeCloseTo(st.moneyOut!, 2);
        let bal = st.openingBalance!;
        for (const t of r.transactions) {
            bal += (parseFloat(t.moneyIn) || 0) - (parseFloat(t.moneyOut) || 0);
            expect(parseFloat(t.balance)).toBeCloseTo(bal, 2);
        }
        expect(bal).toBeCloseTo(st.closingBalance!, 2);
    });
});

describe('Lloyds Select Statement detection', () => {
    it('is detected as Lloyds even when a payee names HSBC', () => {
        expect(detectBankFromContent(CONTEXT_TEXT)).toBe('lloyds');
    });
});
