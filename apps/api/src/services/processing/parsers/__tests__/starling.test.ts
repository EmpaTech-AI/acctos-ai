/**
 * Regression tests for the Starling bank statement parser.
 *
 * Origin: a statement whose Money In came out overstated and Money Out understated,
 * while the closing balance still reconciled, so only the declared-totals check
 * caught it.
 *
 * Root cause: the per-page layout detection took the maximum column index over
 * EVERY row on the page. Starling prints an interest-rate disclosure table under
 * the transactions on the last page, and that table is always 6 columns wide. A
 * 5-column transaction page carrying it was therefore parsed as 6col, so col 3
 * (the single amount column) was read as money IN and col 4 (the running balance)
 * was read as money OUT.
 *
 * Every fixture below is synthetic: round amounts, invented counterparties, a
 * self-consistent balance chain. No client statement data is committed here.
 * The tests run without Azure DI credentials.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '../starling.js';
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

/**
 * Summary box + transaction table header, as Starling prints them above page 1.
 * The box is consistent with the two pages below: 2000 + 10000 - 6500 = 5500.
 */
function preamble(): Cell[] {
    return [
        // Synthetic context cell the orchestrator prepends: all page text, rowIndex -1.
        c(-1, 0, 'Starling Bank 24hr Customer Service: 0000 000 0000\nStatement 01/03/2025 - 31/03/2025'),
        c(0, 0, 'Opening Balance'), c(0, 1, '£2000.00'),
        c(1, 0, 'Payments In'),     c(1, 1, '£10000.00'),
        c(2, 0, 'Payments Out'),    c(2, 1, '£6500.00'),
        c(3, 0, 'Closing Balance'), c(3, 1, '£5500.00'),
        // transaction table header — 6 columns
        c(4, 0, 'Date'), c(4, 1, 'Type'), c(4, 2, 'Transaction'),
        c(4, 3, 'In'), c(4, 4, 'Out'), c(4, 5, 'Balance'),
    ];
}

/** Page 1: a genuine 6col page — col 3 = In, col 4 = Out, col 5 = Balance. */
function genuineSixColPage(): Cell[] {
    return [
        c(5, 0, '03/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Main Client Ltd (invoice)'),
        c(5, 3, '£10000.00'), c(5, 5, '£12000.00'),
        c(6, 0, '05/03/2025'), c(6, 1, 'ATM'), c(6, 2, 'ATM Operator A'),
        c(6, 4, '£200.00'), c(6, 5, '£11800.00'),
    ];
}

/**
 * Page 2: a genuine 5col page — col 3 = amount, col 4 = running balance, col 5 unused —
 * followed by the interest-rate disclosure table, which DOES reach column 5.
 * Row indices carry the orchestrator's 10000-per-page offset.
 *
 * The balance chain continues page 1: 11800 - 5000 - 400 - 100 - 50 = 6250, then
 * -150 = 6100, -100 = 6000, -500 = 5500 (the declared closing balance).
 */
function fiveColPageWithInterestTable(): Cell[] {
    return [
        c(10007, 0, '10/03/2025'), c(10007, 1, 'FASTER PAYMENT'), c(10007, 2, 'HMRC (tax payment)'),
        c(10007, 3, '£5000.00'),
        c(10008, 0, '10/03/2025'), c(10008, 1, 'FASTER PAYMENT'), c(10008, 2, 'Acme Contracting Ltd (owner)'),
        c(10008, 3, '£400.00'),
        c(10009, 0, '10/03/2025'), c(10009, 1, 'FASTER PAYMENT'), c(10009, 2, 'Card Issuer Ltd (statement)'),
        c(10009, 3, '£100.00'),
        c(10010, 0, '10/03/2025'), c(10010, 1, 'FASTER PAYMENT'), c(10010, 2, 'Trade Supplier Ltd (tools)'),
        c(10010, 3, '£50.00'), c(10010, 4, '£6250.00'),
        c(10011, 0, '12/03/2025'), c(10011, 1, 'ATM'), c(10011, 2, 'ATM Operator B'),
        c(10011, 3, '£150.00'), c(10011, 4, '£6100.00'),
        c(10012, 0, '14/03/2025'), c(10012, 1, 'FASTER PAYMENT'), c(10012, 2, 'Trade Supplier Ltd (transfer)'),
        c(10012, 3, '£100.00'), c(10012, 4, '£6000.00'),
        c(10013, 0, '28/03/2025'), c(10013, 1, 'DIRECT DEBIT'), c(10013, 2, 'Vehicle Finance Co (00000000)'),
        c(10013, 3, '£500.00'), c(10013, 4, '£5500.00'),
        // Interest-rate disclosure table — no dates in col 0, but it spans all 6 columns.
        c(10015, 0, 'We charge interest each day you'), c(10015, 1, 'Interest rate paid on Date ran'),
        c(10015, 2, '%AER 01/03/2025 -'), c(10015, 3, '%Gross 31/03/2025'),
        c(10015, 4, 'Interest rate charged'), c(10015, 5, '%EAR'),
        c(10016, 0, 'of day account balance. For fu'), c(10016, 1, 'Account Balance'),
        c(10016, 2, 'Variable'), c(10016, 3, 'Variable'),
        c(10016, 4, 'on Account Balance'), c(10016, 5, 'Variable'),
    ];
}

// ── Regression: interest disclosure table must not force a 5col page to 6col ──

describe('Starling parser – interest table must not drive column layout', () => {
    const cells: Cell[] = [
        ...preamble(),
        ...genuineSixColPage(),
        ...fiveColPageWithInterestTable(),
    ];

    it('reads the 5col page amounts as moneyOut, not moneyIn', () => {
        const { transactions } = parse(cells);

        const hmrc = transactions.find(t => t.description.includes('HMRC'));
        expect(hmrc).toBeDefined();
        // Paying HMRC is an outgoing payment. Before the fix this was moneyIn.
        expect(hmrc!.moneyIn).toBe('');
        expect(hmrc!.moneyOut).toBe('5000.00');
    });

    it('reads col 4 on a 5col page as the balance, not as moneyOut', () => {
        const { transactions } = parse(cells);

        const atm = transactions.find(t => t.description.includes('ATM Operator B'));
        expect(atm).toBeDefined();
        // Before the fix: moneyOut 6100.00 (the running balance) instead of 150.00.
        expect(atm!.moneyOut).toBe('150.00');
        expect(atm!.balance).toBe('6100.00');
    });

    it('totals reconcile against the statement-declared totals', () => {
        const { transactions, statementTotals } = parse(cells);

        expect(statementTotals).toBeDefined();
        expect(sumIn(transactions)).toBe(statementTotals!.moneyIn);
        expect(sumOut(transactions)).toBe(statementTotals!.moneyOut);
        // Explicit values so a future change to the fixture cannot quietly satisfy this.
        expect(sumIn(transactions)).toBe(10000.00);
        expect(sumOut(transactions)).toBe(6500.00);
    });

    it('survives Azure DI dropping one amount cell on the 5col page', () => {
        // Azure DI intermittently drops a single cell. On a 5col page that leaves a row
        // with only col 4 (the balance), which looks exactly like "an amount in the Out
        // column" — the 6col signature. One such row must not flip the whole page to
        // 6col and turn every other payment on it into income.
        const damaged = cells.filter(x => !(x.rowIndex === 10011 && x.columnIndex === 3));
        const { transactions } = parse(damaged);

        const hmrc = transactions.find(t => t.description.includes('HMRC'));
        expect(hmrc!.moneyOut).toBe('5000.00');
        expect(hmrc!.moneyIn).toBe('');

        const dd = transactions.find(t => t.description.includes('Vehicle Finance'));
        expect(dd!.moneyOut).toBe('500.00');
        expect(dd!.balance).toBe('5500.00');
    });

    it('ignores non-numeric text in the balance column when detecting layout', () => {
        // parseMoney strips non-digits and then reads Number(''), which is 0 — so plain
        // text such as "Variable" answers 0, not null. A stray wrapped-description or
        // footnote fragment landing in col 5 of one dated row must NOT be mistaken for a
        // balance and flip the page to 6col.
        const withStrayText: Cell[] = [...cells, c(10012, 5, 'Variable')];
        const { transactions } = parse(withStrayText);

        const hmrc = transactions.find(t => t.description.includes('HMRC'));
        expect(hmrc!.moneyOut).toBe('5000.00');
        expect(hmrc!.moneyIn).toBe('');
        expect(sumIn(transactions)).toBe(10000.00);
    });
});

// ── Guard against over-correcting: a genuine 6col page keeps its IN column ────

describe('Starling parser – genuine 6col pages are unaffected', () => {
    it('keeps an amount in the In column as moneyIn when the page has a balance column', () => {
        const cells: Cell[] = [...preamble(), ...genuineSixColPage()];
        const { transactions } = parse(cells);

        const credit = transactions.find(t => t.description.includes('Main Client Ltd'));
        expect(credit).toBeDefined();
        expect(credit!.moneyIn).toBe('10000.00');
        expect(credit!.moneyOut).toBe('');
        expect(credit!.balance).toBe('12000.00');

        const atm = transactions.find(t => t.description.includes('ATM Operator A'));
        expect(atm!.moneyOut).toBe('200.00');
        expect(atm!.balance).toBe('11800.00');
    });

    it('keeps credits as moneyIn when Azure DI drops every balance on a 6col page', () => {
        // A genuine 6col page of credits only: amounts in the In column, no Out amounts,
        // and Azure DI dropped the whole balance column. Nothing on the page carries a
        // transaction-level layout signature, so detection falls back to the whole-page
        // column scan — and the interest table below keeps that at 6col. Without the
        // fallback these credits would be read as payments out.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '03/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Main Client Ltd (invoice)'),
            c(5, 3, '£10000.00'),
            c(6, 0, '04/03/2025'), c(6, 1, 'FASTER PAYMENT'), c(6, 2, 'Second Client Ltd (invoice)'),
            c(6, 3, '£500.00'),
            // interest disclosure table, reaching col 5
            c(8, 0, 'We charge interest each day you'), c(8, 1, 'Interest rate paid on Date ran'),
            c(8, 2, '%AER'), c(8, 3, '%Gross'), c(8, 4, 'Interest rate charged'), c(8, 5, '%EAR'),
        ];
        const { transactions } = parse(cells);

        expect(transactions).toHaveLength(2);
        expect(transactions[0].moneyIn).toBe('10000.00');
        expect(transactions[0].moneyOut).toBe('');
        expect(transactions[1].moneyIn).toBe('500.00');
        expect(sumOut(transactions)).toBe(0);
    });

    it('reads a 6col page that carries the interest table below it as 6col', () => {
        // The modal Starling last page: real balances in col 5 AND the disclosure table.
        const cells: Cell[] = [
            ...preamble(),
            ...genuineSixColPage(),
            c(8, 0, 'We charge interest each day you'), c(8, 1, 'Interest rate paid on Date ran'),
            c(8, 2, '%AER'), c(8, 3, '%Gross'), c(8, 4, 'Interest rate charged'), c(8, 5, '%EAR'),
        ];
        const { transactions } = parse(cells);

        const credit = transactions.find(t => t.description.includes('Main Client Ltd'));
        expect(credit!.moneyIn).toBe('10000.00');
        expect(credit!.balance).toBe('12000.00');
    });

    it('does not invent a payment from a lone balance cell', () => {
        // col 3 empty with col 4 populated and no col 5 anywhere is genuinely ambiguous:
        // a 6col page whose balances were dropped, or a 5col page whose amount was
        // dropped. Reading it as 6col would publish £1750 of expenditure that is really
        // the account balance, and that can still reconcile. Skipping the row instead
        // makes the declared-totals check fail, which is the outcome a human sees.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '07/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Some Supplier Ltd'),
            c(5, 4, '£1750.00'),
        ];
        const { transactions } = parse(cells);
        expect(transactions.some(t => t.moneyOut === '1750.00')).toBe(false);
    });

    it('treats a zero balance as a real balance, not as missing evidence', () => {
        // A payment that empties the account leaves col 4 = 0.00. That is a balance,
        // so the page is 5col and the £250 is money out. Requiring col 4 > 0 here would
        // discard the evidence and let the disclosure table below pick 6col, publishing
        // the payment as £250 of income.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '07/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Some Supplier Ltd'),
            c(5, 3, '£250.00'), c(5, 4, '£0.00'),
            c(8, 0, 'We charge interest each day you'), c(8, 1, 'Interest rate paid on Date ran'),
            c(8, 2, '%AER'), c(8, 3, '%Gross'), c(8, 4, 'Interest rate charged'), c(8, 5, '%EAR'),
        ];
        const { transactions } = parse(cells);

        const tx = transactions.find(t => t.description.includes('Some Supplier'));
        expect(tx).toBeDefined();
        expect(tx!.moneyOut).toBe('250.00');
        expect(tx!.moneyIn).toBe('');
    });

    it('does not accept a bare integer in the balance column as a balance', () => {
        // A spilled payment reference, page number or year landing in col 5 of a dated
        // row would otherwise decide the page is 6col, which moves the balance column
        // from col 4 to col 5 for EVERY row. That corruption leaves Money In and Money
        // Out untouched, so the declared-totals check still passes and nothing
        // downstream notices — the balance column simply ships wrong.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '03/03/2025'), c(5, 1, 'DIRECT DEBIT'), c(5, 2, 'Utility Co'),
            c(5, 3, '£100.00'), c(5, 4, '£900.00'),
            c(6, 0, '04/03/2025'), c(6, 1, 'DIRECT DEBIT'), c(6, 2, 'Insurer Ltd'),
            c(6, 3, '£200.00'), c(6, 4, '£700.00'), c(6, 5, '4629'),
        ];
        const { transactions } = parse(cells);

        const second = transactions.find(t => t.description.includes('Insurer'));
        expect(second!.moneyOut).toBe('200.00');
        // col 4 is still the balance column; 4629 was never a balance.
        expect(second!.balance).toBe('700.00');
    });

    it('does not let one merged row outvote a page that plainly disagrees', () => {
        // A genuine 6col page whose col-5 balances Azure DI dropped: a credit in the In
        // column, a payment in the Out column. One row showing both columns (a merged or
        // mis-OCR'd row) must not flip the page to 5col — that would turn the credit into
        // a debit and drop the payment entirely.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '03/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Main Client Ltd (invoice)'),
            c(5, 3, '£2000.00'),
            c(6, 0, '04/03/2025'), c(6, 1, 'CONTACTLESS'), c(6, 2, 'Shop'),
            c(6, 4, '£50.00'),
            c(7, 0, '05/03/2025'), c(7, 1, 'CONTACTLESS'), c(7, 2, 'Other Shop'),
            c(7, 3, '£30.00'), c(7, 4, '£30.00'),
            c(9, 0, 'We charge interest each day you'), c(9, 1, 'Interest rate paid on Date ran'),
            c(9, 2, '%AER'), c(9, 3, '%Gross'), c(9, 4, 'Interest rate charged'), c(9, 5, '%EAR'),
        ];
        const { transactions } = parse(cells);

        const credit = transactions.find(t => t.description.includes('Main Client Ltd'));
        expect(credit!.moneyIn).toBe('2000.00');
        expect(credit!.moneyOut).toBe('');

        const shop = transactions.find(t => t.description.includes('CONTACTLESS Shop'));
        expect(shop).toBeDefined();
        expect(shop!.moneyOut).toBe('50.00');
    });

    it('does not accept a reference fragment as a money cell', () => {
        // "Ref 1" contains a digit, and parseMoney strips the letters and answers 1.
        // Treating that as a populated balance column would flip a genuine 6col page
        // of credits into payments out.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '07/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Main Client Ltd (invoice)'),
            c(5, 3, '£250.00'), c(5, 4, 'Ref 1'),
            c(6, 0, '08/03/2025'), c(6, 1, 'FASTER PAYMENT'), c(6, 2, 'Second Client Ltd (invoice)'),
            c(6, 3, '£500.00'),
            c(8, 0, 'We charge interest each day you'), c(8, 1, 'Interest rate paid on Date ran'),
            c(8, 2, '%AER'), c(8, 3, '%Gross'), c(8, 4, 'Interest rate charged'), c(8, 5, '%EAR'),
        ];
        const { transactions } = parse(cells);

        expect(sumIn(transactions)).toBe(750.00);
        expect(sumOut(transactions)).toBe(0);
    });

    it('collects layout evidence from DR-suffixed amounts', () => {
        // parseMoney signs DR/OD cells negative, so layout evidence must compare
        // magnitude. Here the DR row is the ONLY row that can supply evidence: it
        // carries amount + balance, which means 5col. If the sign were not handled the
        // row would contribute nothing, detection would fall through to the whole-page
        // scan, the interest table would pin that at 6col, and the payment below would
        // be read as income.
        const cells: Cell[] = [
            ...preamble(),
            c(5, 0, '07/03/2025'), c(5, 1, 'FASTER PAYMENT'), c(5, 2, 'Some Supplier Ltd'),
            c(5, 3, '£250.00 DR'), c(5, 4, '£1750.00'),
            c(6, 0, '08/03/2025'), c(6, 1, 'FASTER PAYMENT'), c(6, 2, 'Another Supplier Ltd'),
            c(6, 3, '£100.00'),
            c(8, 0, 'We charge interest each day you'), c(8, 1, 'Interest rate paid on Date ran'),
            c(8, 2, '%AER'), c(8, 3, '%Gross'), c(8, 4, 'Interest rate charged'), c(8, 5, '%EAR'),
        ];
        const { transactions } = parse(cells);

        const supplier = transactions.find(t => t.description.includes('Another Supplier'));
        expect(supplier).toBeDefined();
        expect(supplier!.moneyOut).toBe('100.00');
        expect(supplier!.moneyIn).toBe('');

        // KNOWN GAP, pre-dating this change: detection accepts "250.00 DR" by magnitude,
        // but extractFromSection's 5col path re-parses it with parseMoney, gets -250, and
        // drops the row on `amtNum <= 0`. So the DR payment is lost and only the £100
        // survives. Asserted explicitly so the loss is visible rather than certified by
        // omission; fixing it means making extraction sign-aware, which is a separate
        // change affecting every 5col page.
        expect(transactions).toHaveLength(1);
        expect(sumOut(transactions)).toBe(100.00);
    });
});
