/**
 * Barclays statement totals keep the sign of an overdrawn balance.
 *
 * Origin: a statement that started overdrawn ("Start balance -£5.66") was read as
 * +£5.66, while the previous statement's end balance was correctly -£5.66. The chain
 * check then raised a gap alert (£0.00 overall) and the Files sheet showed the wrong
 * opening balance. Cells below are shaped exactly as Azure DI returned them.
 */

import { describe, it, expect } from 'vitest';
import { extractBarclaysStatementTotals } from '../barclays.js';
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
