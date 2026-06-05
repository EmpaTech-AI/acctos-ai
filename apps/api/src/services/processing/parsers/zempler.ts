// Zempler Bank parser
// Column layout: Date | Card ending in | Description | Amount | Balance
// Amount: signed £ values (negative=Out, positive=In); Date: DD/MM/YYYY
// Statements are newest-first → ascending: true
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, maxRow,
} from './shared.js';

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells.filter(c => c.rowIndex >= 0));
    const rows = maxRow(cells);
    const transactions: ParsedTransaction[] = [];

    for (let r = 0; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;

        const rawDate = normStr(row.get(0) ?? '');
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) continue;

        const desc = normStr(row.get(2) ?? '');
        if (!desc) continue;

        const rawAmt = normStr(row.get(3) ?? '');
        const rawBal = normStr(row.get(4) ?? '');

        const amt = parseMoney(rawAmt);
        if (amt === null || amt === 0) continue;

        const moneyIn  = amt > 0 ? formatMoney(amt)           : '';
        const moneyOut = amt < 0 ? formatMoney(Math.abs(amt)) : '';

        // Preserve sign for overdraft balances
        const balNum = parseMoney(rawBal);
        const balance = balNum !== null ? balNum.toFixed(2) : '';

        transactions.push({ date: rawDate, type: '', description: desc, moneyIn, moneyOut, balance });
    }

    return { transactions, ascending: true };
}
