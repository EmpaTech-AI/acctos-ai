// Counting Up bank parser
// Column layout per row (Azure DI varies):
//   4-col: Date | Details | amount | Balance
//   5-col: Date | Details | col2   | col3 | Balance
// Amount sign and column position are unreliable — balance delta determines In vs Out.
// Date format: "6 Apr 2025" → oldest-first
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, maxRow,
    parseDateToDDMMYYYY,
} from './shared.js';

export function parse(cells: Cell[]): ParseResult {
    // Statement totals are on the first page summary section
    const content = cells.find(c => c.rowIndex === -1)?.content ?? '';
    let statementTotals: { moneyIn: number; moneyOut: number } | undefined;
    const inMatch  = content.match(/Total paid in\s*£([\d,]+\.\d{2})/);
    const outMatch = content.match(/Total paid out\s*£([\d,]+\.\d{2})/);
    if (inMatch && outMatch) {
        const moneyIn  = parseMoney(inMatch[1]);
        const moneyOut = parseMoney(outMatch[1]);
        if (moneyIn !== null && moneyOut !== null) {
            statementTotals = { moneyIn, moneyOut };
        }
    }

    const grid = buildGrid(cells.filter(c => c.rowIndex >= 0));
    const rows = maxRow(cells);
    const transactions: ParsedTransaction[] = [];
    let prevBalance: number | null = null;

    for (let r = 0; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;

        const rawDate = normStr(row.get(0) ?? '');
        const date = parseDateToDDMMYYYY(rawDate);
        if (!date) continue;

        const desc = normStr(row.get(1) ?? '');
        if (!desc) continue;

        const col2 = normStr(row.get(2) ?? '');
        const col3 = normStr(row.get(3) ?? '');
        const col4 = normStr(row.get(4) ?? '');
        const maxColIdx = Math.max(...row.keys());

        let moneyIn = '';
        let moneyOut = '';
        let balance = '';
        let bal: number | null = null;
        let amt: number | null = null;

        if (maxColIdx <= 3) {
            // 4-col: col2=amount, col3=balance
            amt = parseMoney(col2);
            bal = parseMoney(col3);
            balance = col3;
        } else if (!col2) {
            // 5-col In-type: col3=In amount, col4=balance
            amt = parseMoney(col3);
            bal = parseMoney(col4);
            balance = col4;
        } else {
            // 5-col with amount in col2, col4=balance
            amt = parseMoney(col2);
            bal = parseMoney(col4);
            balance = col4;
        }

        if (amt !== null && amt !== 0) {
            const absAmt = Math.abs(amt);
            if (prevBalance !== null && bal !== null) {
                // Balance delta is the authoritative direction signal
                const delta = Math.round((bal - prevBalance) * 100) / 100;
                if (delta > 0) moneyIn  = formatMoney(absAmt);
                else           moneyOut = formatMoney(absAmt);
            } else {
                // No previous balance: fall back to sign
                if (amt < 0) moneyOut = formatMoney(absAmt);
                else         moneyIn  = formatMoney(absAmt);
            }
        }

        if (bal !== null) prevBalance = bal;
        if (!moneyIn && !moneyOut) continue;

        transactions.push({ date, type: '', description: desc, moneyIn, moneyOut, balance });
    }

    return { transactions, statementTotals, ascending: true };
}
