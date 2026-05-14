/**
 * Regression tests for the HSBC bank statement parser.
 *
 * Fixture: apps/api/test-hsbc-reference/HSBC 2026-04-26_Statement.pdf.pdf
 * Expected PDF summary:
 *   Opening Balance : £241.36
 *   Payments In     : £3,454.29
 *   Payments Out    : £3,385.20
 *   Closing Balance : £310.45
 *
 * These tests use synthetic Cell arrays that reproduce the patterns observed
 * in the real statement.  They run without Azure DI credentials.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../hsbc.js';
import { Cell } from '../shared.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function c(rowIndex: number, columnIndex: number, content: string): Cell {
    return { rowIndex, columnIndex, content };
}

function sumIn(txns: ReturnType<typeof parse>['transactions']): number {
    return txns.reduce((s, t) => s + (parseFloat(t.moneyIn.replace(/,/g, '')) || 0), 0);
}

function sumOut(txns: ReturnType<typeof parse>['transactions']): number {
    return txns.reduce((s, t) => s + (parseFloat(t.moneyOut.replace(/,/g, '')) || 0), 0);
}

// ── Bug A: VIS transactions in "Paid In" column must NOT be flipped to Paid-Out ─

describe('HSBC parser – VIS Paid-In direction (regression A)', () => {
    it('VIS amount in c4 (Paid-In column) stays as moneyIn', () => {
        // Represents: 27/03/2026  VIS  Leo Vegas Newcastle Upo  [Paid In £25.00]  [Bal 266.36]
        const cells: Cell[] = [
            // Context cell so parseDateToDDMMYYYY has a year reference
            c(-1, -1, 'Statement period 01 Mar 2026 - 30 Apr 2026'),
            // Opening balance row (date + balance, no code)
            c(0, 0, '01 Mar 2026'), c(0, 5, '241.36'),
            // VIS Leo Vegas  — amount is in column 4 (Paid In)
            c(1, 0, '27 Mar 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Leo Vegas Newcastle Upo'),
            c(1, 4, '25.00'),   // Paid In
            c(1, 5, '266.36'),  // Balance
        ];

        const { transactions: txns } = parse(cells);
        const vis = txns.find(t => t.description.includes('Leo Vegas'));
        expect(vis, 'Leo Vegas transaction missing').toBeDefined();
        expect(vis!.moneyIn).toBe('25.00');
        expect(vis!.moneyOut).toBe('');
    });

    it('VIS amount in c4 is validated as moneyIn by balance solver', () => {
        // Three consecutive VIS Paid-In transactions (White Valetta x3)
        // Balance must match after each one to prove the solver accepts moneyIn.
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Mar 2026 - 30 Apr 2026'),
            c(0, 0, '01 Mar 2026'), c(0, 5, '241.36'),
            // £60.00 Paid In → balance 301.36
            c(1, 0, '08 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'White Valetta'), c(1, 4, '60.00'), c(1, 5, '301.36'),
            // £30.00 Paid In → balance 331.36
            c(2, 0, '17 Apr 2026'), c(2, 1, 'VIS'),
            c(2, 2, 'White Valetta'), c(2, 4, '30.00'), c(2, 5, '331.36'),
            // £100.00 Paid In → balance 431.36
            c(3, 0, '23 Apr 2026'), c(3, 1, 'VIS'),
            c(3, 2, 'White Valetta'), c(3, 4, '100.00'), c(3, 5, '431.36'),
        ];

        const { transactions: txns } = parse(cells);
        const whiteVals = txns.filter(t => t.description.includes('White Valetta'));
        expect(whiteVals).toHaveLength(3);
        for (const t of whiteVals) {
            expect(t.moneyIn).not.toBe('');
            expect(t.moneyOut).toBe('');
        }
        expect(Math.round(sumIn(txns) * 100)).toBe(Math.round(190 * 100));
    });

    it('VIS amount in c3 (Paid-Out column) stays as moneyOut', () => {
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 0, '01 Apr 2026'), c(0, 5, '310.45'),
            // VIS Tesco — paid out (c3)
            c(1, 0, '02 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Tesco Express'), c(1, 3, '12.50'), c(1, 5, '297.95'),
        ];

        const { transactions: txns } = parse(cells);
        const tesco = txns.find(t => t.description.includes('Tesco'));
        expect(tesco!.moneyOut).toBe('12.50');
        expect(tesco!.moneyIn).toBe('');
    });
});

// ── Bug B: Continuation rows with their own amount must be split into new txns ─

describe('HSBC parser – implicit transaction split (regression B)', () => {
    it('continuation row with description+amount creates a new transaction', () => {
        // Azure DI merged two PDF rows: row 0 = VIS 21.Co.Uk (with amount),
        // row 1 = Tesco Stores (separate txn, no code, but has its own amount).
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Mar 2026 - 30 Apr 2026'),
            c(0, 0, '01 Mar 2026'), c(0, 5, '300.00'),
            // VIS 21.Co.Uk with amount already on its own row
            c(1, 0, '27 Mar 2026'), c(1, 1, 'VIS'),
            c(1, 2, '21.Co.Uk'), c(1, 3, '5.00'), c(1, 5, '295.00'),
            // Tesco continuation row: different rowIndex, no code, has its own amount
            c(2, 2, 'Tesco Stores 4342 Streatham'), c(2, 3, '13.59'), c(2, 5, '281.41'),
        ];

        const { transactions: txns } = parse(cells);
        expect(txns.length).toBeGreaterThanOrEqual(2);

        const tesco = txns.find(t => t.description.includes('Tesco Stores 4342'));
        expect(tesco, 'Tesco transaction missing').toBeDefined();
        expect(tesco!.moneyOut).toBe('13.59');
        // And the first txn should NOT contain Tesco in its description
        const vis21 = txns.find(t => t.description.includes('21.Co.Uk'));
        expect(vis21!.description).not.toContain('Tesco');
    });

    it('continuation row without amount stays merged with current txn (description-only)', () => {
        // Multi-line merchant name — second line has no amount, so it should append.
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 0, '01 Apr 2026'), c(0, 5, '300.00'),
            // VIS Oyster — amount on first row
            c(1, 0, '02 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Oyster Mobile App'), c(1, 3, '3.50'), c(1, 5, '296.50'),
            // Description continuation — no amount, no code
            c(2, 2, '0343 2221234'),
        ];

        const { transactions: txns } = parse(cells);
        // Only ONE transaction; the phone number is appended to description
        const oyster = txns.find(t => t.description.includes('Oyster'));
        expect(oyster).toBeDefined();
        expect(oyster!.description).toContain('0343');
        expect(txns).toHaveLength(1);
    });

    it('continuation row with moneyIn amount is also split correctly', () => {
        // Superdrug is a Paid-In transaction that follows Oyster Mobile App
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Mar 2026 - 30 Apr 2026'),
            c(0, 0, '01 Mar 2026'), c(0, 5, '300.00'),
            c(1, 0, '31 Mar 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Oyster Mobile App 0343 2221234'), c(1, 3, '3.50'), c(1, 5, '296.50'),
            // Superdrug is a SEPARATE Paid-In txn merged into the continuation row
            c(2, 2, 'Superdrug Stores P Clapham'), c(2, 4, '10.99'), c(2, 5, '307.49'),
        ];

        const { transactions: txns } = parse(cells);
        const superdrug = txns.find(t => t.description.includes('Superdrug'));
        expect(superdrug, 'Superdrug transaction missing').toBeDefined();
        expect(superdrug!.moneyIn).toBe('10.99');
        expect(superdrug!.moneyOut).toBe('');
        // Oyster must not contain Superdrug
        const oyster = txns.find(t => t.description.includes('Oyster'));
        expect(oyster!.description).not.toContain('Superdrug');
    });
});

// ── Bug B extension: ))) marker in merged c2 splits description correctly ─────

describe('HSBC parser – ))) description split (regression B2)', () => {
    it('))) in c2 splits old description, new txn gets part after ))) + location', () => {
        // Azure DI merged: "Oyster Mobile App 0343 2221234 ))) Superdrug Stores P" in c2
        // Continuation row: c2="Clapham", c3=12.98
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Mar 2026 - 30 Apr 2026'),
            c(0, 0, '01 Mar 2026'), c(0, 5, '300.00'),
            c(1, 0, '31 Mar 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Oyster Mobile App 0343 2221234 ))) Superdrug Stores P'),
            c(1, 3, '37.10'), c(1, 5, '262.90'),
            c(2, 2, 'Clapham'), c(2, 3, '12.98'), c(2, 5, '249.92'),
        ];

        const { transactions: txns } = parse(cells);
        const oyster = txns.find(t => t.description.includes('Oyster'));
        const superdrug = txns.find(t => t.description.includes('Superdrug'));

        expect(oyster, 'Oyster missing').toBeDefined();
        expect(oyster!.description).not.toContain('Superdrug');
        expect(oyster!.description).not.toContain(')))');

        expect(superdrug, 'Superdrug missing').toBeDefined();
        expect(superdrug!.description).toContain('Superdrug Stores P');
        expect(superdrug!.description).toContain('Clapham');
        expect(superdrug!.description).not.toContain(')))');
    });

    it('))) split: Welcome Home London + Sherwood Food And Mitcham', () => {
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 0, '01 Apr 2026'), c(0, 5, '300.00'),
            c(1, 0, '08 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Welcome Home London ))) Sherwood Food And'),
            c(1, 3, '7.57'), c(1, 5, '292.43'),
            c(2, 2, 'Mitcham'), c(2, 3, '0.50'), c(2, 5, '291.93'),
        ];

        const { transactions: txns } = parse(cells);
        const welcome = txns.find(t => t.description.includes('Welcome Home'));
        const sherwood = txns.find(t => t.description.includes('Sherwood'));

        expect(welcome!.description).not.toContain('Sherwood');
        expect(welcome!.description).not.toContain(')))');
        expect(sherwood!.description).toContain('Sherwood Food And');
        expect(sherwood!.description).toContain('Mitcham');
    });

    it('))) split: White . + Tariq Halal Croydon', () => {
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 0, '01 Apr 2026'), c(0, 5, '300.00'),
            c(1, 0, '17 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'White . ))) Tariq Halal Croydo'),
            c(1, 3, '20.00'), c(1, 5, '280.00'),
            c(2, 2, 'Croydon'), c(2, 3, '2.84'), c(2, 5, '277.16'),
        ];

        const { transactions: txns } = parse(cells);
        const white = txns.find(t => t.description.includes('White'));
        const tariq = txns.find(t => t.description.includes('Tariq'));

        expect(white!.description).not.toContain('Tariq');
        expect(white!.description).not.toContain(')))');
        expect(tariq!.description).toContain('Tariq Halal Croydo');
        expect(tariq!.description).toContain('Croydon');
    });

    it('))) split: Hollister White C London + Tesco Stores 5186 London', () => {
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 0, '01 Apr 2026'), c(0, 5, '300.00'),
            c(1, 0, '23 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Hollister (White C London ))) Tesco Stores 5186'),
            c(1, 3, '27.95'), c(1, 5, '272.05'),
            c(2, 2, 'London'), c(2, 3, '1.13'), c(2, 5, '270.92'),
        ];

        const { transactions: txns } = parse(cells);
        const hollister = txns.find(t => t.description.includes('Hollister'));
        const tesco = txns.find(t => t.description.includes('Tesco Stores 5186'));

        expect(hollister!.description).not.toContain('Tesco');
        expect(hollister!.description).not.toContain(')))');
        expect(tesco!.description).toContain('Tesco Stores 5186');
        expect(tesco!.description).toContain('London');
    });
});

// ── Balance summary assertions (synthetic mini-statement) ─────────────────────

describe('HSBC parser – balance math', () => {
    it('opening balance extracted from Balance Brought Forward row', () => {
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            // Balance Brought Forward row
            c(0, 0, ''), c(0, 2, 'BALANCE BROUGHT FORWARD'), c(0, 5, '241.36'),
            // One VIS out
            c(1, 0, '02 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Marks and Spencer'), c(1, 3, '50.00'), c(1, 5, '191.36'),
        ];

        const { transactions: txns } = parse(cells);
        expect(txns).toHaveLength(1);
        expect(txns[0].moneyOut).toBe('50.00');
        expect(txns[0].balance).toBe('191.36');
    });

    it('net movement: sumIn - sumOut matches closing - opening balance', () => {
        // Mini-statement: opening 241.36, two outs (50+30=80), one in (25), closing 186.36
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 2, 'BALANCE BROUGHT FORWARD'), c(0, 5, '241.36'),
            c(1, 0, '01 Apr 2026'), c(1, 1, 'VIS'), c(1, 2, 'Tesco'), c(1, 3, '50.00'), c(1, 5, '191.36'),
            c(2, 0, '02 Apr 2026'), c(2, 1, 'VIS'), c(2, 2, 'Sainsbury'), c(2, 3, '30.00'), c(2, 5, '161.36'),
            c(3, 0, '03 Apr 2026'), c(3, 1, 'CR'), c(3, 2, 'Salary'), c(3, 4, '25.00'), c(3, 5, '186.36'),
        ];

        const { transactions: txns } = parse(cells);
        const totalIn  = Math.round(sumIn(txns)  * 100);
        const totalOut = Math.round(sumOut(txns) * 100);
        const net      = totalIn - totalOut;
        // 186.36 - 241.36 = -55.00 net
        expect(net).toBe(-5500);
    });
});

// ── Wide-layout (7-column) parsing ───────────────────────────────────────────

describe('HSBC parser – wide OCR layout (maxCol >= 6)', () => {
    it('c4=Money Out, c5=Money In, c6=Balance on 7-column pages', () => {
        const cells: Cell[] = [
            c(-1, -1, 'Statement period 01 Apr 2026 - 30 Apr 2026'),
            c(0, 0, '01 Apr 2026'), c(0, 5, '300.00'),
            // Wide layout: col6 present → maxCol=6
            c(1, 0, '02 Apr 2026'), c(1, 1, 'VIS'),
            c(1, 2, 'Amazon'), c(1, 4, '29.99'), c(1, 6, '270.01'),
        ];

        const { transactions: txns } = parse(cells);
        const amz = txns.find(t => t.description.includes('Amazon'));
        expect(amz).toBeDefined();
        expect(amz!.moneyOut).toBe('29.99');
        expect(amz!.balance).toBe('270.01');
    });
});
