// Zempler Bank parser
// Column layout: Date | Card ending in | Description | Amount | Balance
// Amount: signed £ values (negative=Out, positive=In); Date: DD/MM/YYYY
// Statements are newest-first → ascending: true
// Note: Azure DI sometimes drops the minus sign from both Amount and Balance columns.
// We correct this after reversing to oldest-first, using the balance chain.
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, buildGrid, maxRow,
} from './shared.js';

function extractDeclaredBalances(cells: Cell[]): ParseResult['statementTotals'] | undefined {
    const content = cells.find(c => c.rowIndex < 0)?.content ?? '';
    // Format: "Opening Balance: - £2,788.53 Closing Balance: - £810.67 From..."
    // Azure DI may render £ as a replacement char; strip non-word chars between "-" and digits.
    const parseBalAmt = (raw: string): number | null => {
        const m = raw.trim().match(/^(-\s*)?[^\d]*([\d,]+\.?\d*)$/);
        if (!m) return null;
        const v = parseFloat(m[2].replace(/,/g, ''));
        return isNaN(v) ? null : (m[1] ? -v : v);
    };
    const openM  = content.match(/Opening\s+Balance:\s*([-\s\xa3£\d,.]+?)(?=\s*Closing)/i);
    const closeM = content.match(/Closing\s+Balance:\s*([-\s\xa3£\d,.]+?)(?=\s+From|\n|$)/i);
    if (!openM || !closeM) return undefined;
    const openingBalance = parseBalAmt(openM[1]);
    const closingBalance = parseBalAmt(closeM[1]);
    if (openingBalance === null || closingBalance === null) return undefined;
    return { openingBalance, closingBalance };
}

export function parse(cells: Cell[]): ParseResult {
    const grid = buildGrid(cells.filter(c => c.rowIndex >= 0));
    const rows = maxRow(cells);

    // First pass: collect valid rows in PDF order (newest-first).
    // Rows where Amount is missing but Balance is present are saved separately —
    // their amount will be inferred from the balance chain in the gap-fill pass below.
    const raw: { date: string; desc: string; amt: number; bal: number }[] = [];
    const pendingInfer: { date: string; desc: string; bal: number }[] = [];

    for (let r = 0; r <= rows; r++) {
        const row = grid.get(r);
        if (!row) continue;
        const rawDate = normStr(row.get(0) ?? '');
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) continue;
        const desc = normStr(row.get(2) ?? '');
        if (!desc) continue;
        const amt = parseMoney(normStr(row.get(3) ?? ''));
        const bal = parseMoney(normStr(row.get(4) ?? ''));
        if (bal === null) continue;
        if (amt === null) { pendingInfer.push({ date: rawDate, desc, bal }); continue; }
        if (amt === 0) continue;
        raw.push({ date: rawDate, desc, amt, bal });
    }

    // Reverse to oldest-first so balance chain formula holds: bal[N] = bal[N-1] + amt[N]
    raw.reverse();
    pendingInfer.reverse();

    // Second pass: correct missing minus signs using balance continuity
    // In oldest-first order: expected_balance = prevBalance + amount
    const transactions: ParsedTransaction[] = [];
    let prevBalance: number | null = null;

    for (const r of raw) {
        let { amt, bal } = r;

        if (prevBalance !== null) {
            // Fix missing minus on Amount: if amt is positive but balance decreased
            if (amt > 0) {
                const expectedIfOut = Math.round((prevBalance - amt) * 100) / 100;
                const expectedIfIn  = Math.round((prevBalance + amt) * 100) / 100;
                // Check which expected matches the (possibly-also-wrong) balance
                if (Math.abs(expectedIfOut - bal) < Math.abs(expectedIfIn - bal) &&
                    Math.abs(expectedIfOut - bal) < Math.abs(expectedIfOut + bal)) {
                    // Balance matches Out direction — but also check abs match for negated bal
                    if (Math.abs(expectedIfOut + bal) < 0.10) {
                        // Both amt and bal signs dropped
                        amt = -amt; bal = -bal;
                    } else if (Math.abs(expectedIfOut - bal) < 0.10) {
                        // Only amt sign dropped, bal is correct (negative)
                        amt = -amt;
                    }
                } else if (Math.abs(expectedIfOut + bal) < 0.10) {
                    // amt positive, bal positive, but expected for Out = -bal
                    amt = -amt; bal = -bal;
                }
            }
            // Fix missing minus on Balance only (amt sign is correct)
            if (bal > 0) {
                const expected = Math.round((prevBalance + amt) * 100) / 100;
                if (expected < 0 && Math.abs(bal + expected) < 0.10) {
                    bal = -bal;
                }
            }
        }

        prevBalance = bal;
        const moneyIn  = amt > 0 ? formatMoney(amt)           : '';
        const moneyOut = amt < 0 ? formatMoney(Math.abs(amt)) : '';
        const balance  = bal.toFixed(2);

        transactions.push({ date: r.date, type: '', description: r.desc, moneyIn, moneyOut, balance });
    }

    // Gap-fill pass: insert pendingInfer rows where the balance chain has a break.
    // A break at transaction T means: prevBal + T.amt ≠ T.bal.
    // If a pending row has balance = T.bal - T.amt, it bridges the gap — insert it
    // before T with amount = pendingBal - prevBal.
    const statementTotals = extractDeclaredBalances(cells);

    if (pendingInfer.length > 0) {
        const filled: ParsedTransaction[] = [];
        let gapPrev: number | null = null;

        for (const tx of transactions) {
            const txAmt = tx.moneyIn ? parseFloat(tx.moneyIn) : -(parseFloat(tx.moneyOut) || 0);
            const txBal = parseFloat(tx.balance);

            if (gapPrev !== null) {
                const expected = Math.round((gapPrev + txAmt) * 100) / 100;
                if (Math.abs(expected - txBal) > 0.02) {
                    // Gap detected — find a pending row whose balance = txBal - txAmt
                    const bridgeBal = Math.round((txBal - txAmt) * 100) / 100;
                    const idx = pendingInfer.findIndex(s => Math.abs(s.bal - bridgeBal) < 0.02);
                    if (idx >= 0) {
                        const s = pendingInfer.splice(idx, 1)[0];
                        const inferredAmt = Math.round((s.bal - gapPrev) * 100) / 100;
                        if (inferredAmt !== 0) {
                            filled.push({
                                date: s.date, type: '', description: s.desc,
                                moneyIn:  inferredAmt > 0 ? formatMoney(inferredAmt)           : '',
                                moneyOut: inferredAmt < 0 ? formatMoney(Math.abs(inferredAmt)) : '',
                                balance:  s.bal.toFixed(2),
                            });
                            gapPrev = s.bal;
                        }
                    }
                }
            }

            filled.push(tx);
            gapPrev = txBal;
        }

        return { transactions: filled, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
    }

    return { transactions, ascending: true, ...(statementTotals ? { statementTotals } : {}) };
}
