/**
 * A bank's own notes about a fee or an exchange rate do not decide a category.
 *
 * Origin: a Revolut statement of 813 rows came out with 267 ordinary payments
 * (£121,305) under CHARGES. Revolut prints "Fee: £0.20" and "FX Rate GBP 1 = EUR
 * 1.15" after the payee, and two rules the AI had learned — "FEE" and "FX Rate" —
 * sent every such row to CHARGES. A third, "Visa Rate", did the same to card
 * purchases abroad on NatWest statements, and a person's rule "TRANSACTION FEE" to
 * Lloyds card purchases, whose text ends "... Includes A Non-Sterling Transaction
 * Fee of £ 0.32". The bank's real fees meanwhile sat under Bank_Transfer, because
 * a rule on the word "Revolut" came first.
 *
 * Names and numbers below are made up in the shape of the real rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VendorRule } from '../../SupabaseService.js';

const saved = vi.hoisted(() => [] as Array<{ pattern: string; category: string }>);
const RULES = vi.hoisted(() => [] as VendorRule[]);
const RETIRED = vi.hoisted(() => [] as string[]);
vi.hoisted(() => { process.env.OPENAI_API_KEY = 'test-key'; });
vi.mock('../../SupabaseService.js', () => ({
    loadVendorCategories: async () => RULES,
    loadRetiredVendorPatterns: async () => RETIRED,
    saveAiVendorRule: async (pattern: string, category: string) => { saved.push({ pattern, category }); },
}));

import { stripBankNotes, ruleCategory, isLearnableSignal, categorize } from '../AssistantCategorizer.js';

const ai     = (pattern: string, category: string): VendorRule => ({ pattern, match_type: 'contains', category, source: 'ai' });
const manual = (pattern: string, category: string): VendorRule => ({ pattern, match_type: 'contains', category, source: 'manual' });

const REVOLUT_PAYMENT = 'To Jane Example . Example Events: February 2026 - Event Pay 2 Fee: £0.20';
const REVOLUT_CARD_FX = 'Example Cafe Helsinki FX Rate GBP 1 = EUR 1.156195, Fee: £0.42';
const TIDE_CASH       = 'Cash Withdrawal POST OFFICE - Post Office, London (includes fee of GBP 1.00) Fee (£): 0.00 Tide Card: **** **** **** 1234';
const TIDE_CARD       = 'Card Transaction EXAMPLE SUPPLIES - Example Road, Windlesham Fee (£): 0.00 Tide Card: **** **** **** 1234';
const LLOYDS_CARD     = 'Card Purchase Example Shop Bulgaria BGN 26.40 On 09 Apr at VISA Exchange Rate 2.26 The Final GBP Amount Includes A Non-Sterling Transaction Fee of £ 0.32';
const NATWEST_CARD    = "VIS INT'L 0012345678 EXAMPLE SHOP D.D. Sentilj EUR 62.97 @ 1.1505 Visa Rate";

describe('stripBankNotes', () => {
    it.each([
        ['a Revolut fee note',             REVOLUT_PAYMENT, 'To Jane Example . Example Events: February 2026 - Event Pay 2'],
        ['a Revolut exchange rate and fee', REVOLUT_CARD_FX, 'Example Cafe Helsinki'],
        ['a Tide cash withdrawal',         TIDE_CASH,       'Cash Withdrawal POST OFFICE - Post Office, London'],
        ['a Tide card payment',            TIDE_CARD,       'Card Transaction EXAMPLE SUPPLIES - Example Road, Windlesham'],
        ['a Lloyds card purchase abroad',  LLOYDS_CARD,     'Card Purchase Example Shop Bulgaria BGN 26.40 On 09 Apr'],
        ['a NatWest card purchase abroad', NATWEST_CARD,    "VIS INT'L 0012345678 EXAMPLE SHOP D.D. Sentilj EUR 62.97"],
    ])('removes the note from %s', (_what, text, expected) => {
        expect(stripBankNotes(text)).toBe(expected);
    });

    it('leaves the payee\'s own words alone, including the word "fee"', () => {
        expect(stripBankNotes('To Jane Example . Example Events: Autumn - Organiser Fee 800')).toBe('To Jane Example . Example Events: Autumn - Organiser Fee 800');
        expect(stripBankNotes('DEBIT CARD NON-GBP TRANS FEE')).toBe('DEBIT CARD NON-GBP TRANS FEE');
        expect(stripBankNotes('Fee ref: Tide fee for the transaction of £200 amount')).toBe('Fee ref: Tide fee for the transaction of £200 amount');
    });

    it('keeps a text that is nothing but a note', () => {
        expect(stripBankNotes('Fee: £0.20')).toBe('Fee: £0.20');
    });
});

describe('ruleCategory — notes do not decide the category', () => {
    // the three learned rules and the person's rule that did the damage
    const rules = [ai('FX Rate', 'CHARGES'), manual('TRANSACTION FEE', 'CHARGES'), ai('Visa Rate', 'CHARGES')];

    it.each([
        ['a Revolut payment to a person',  REVOLUT_PAYMENT],
        ['a Revolut card payment abroad',  REVOLUT_CARD_FX],
        ['a Tide card payment',            TIDE_CARD],
        ['a Lloyds card purchase abroad',  LLOYDS_CARD],
        ['a NatWest card purchase abroad', NATWEST_CARD],
    ])('leaves %s for the AI instead of calling it a charge', (_what, text) => {
        expect(ruleCategory('', text, rules)).toBeNull();
    });

    it('reads a cash withdrawal as cash although the bank notes an included fee', () => {
        expect(ruleCategory('', TIDE_CASH, rules)).toBe('CASH');
    });

    it('still lets a rule on the payee decide', () => {
        expect(ruleCategory('', REVOLUT_CARD_FX, [...rules, manual('Example Cafe', 'OTHER')])).toBe('OTHER');
    });
});

describe('ruleCategory — the bank\'s own fees are charges', () => {
    it.each([
        'DEBIT CARD NON-GBP TRANS FEE',
        'DEBIT CARD NON-GBP PURCH FEE',
        'DEB NON-GBP TRANS FEE 2.99% CD 0930 28MAR26',
        'DR Non-Sterling Transaction Fee',
        'CHG MONTHLY O/D FEE',
        'Blue Rewards Fee',
        'Monese LTD Fee payment',
    ])('"%s" is a charge without any learned rule', text => {
        expect(ruleCategory('', text, [])).toBe('CHARGES');
    });

    it('takes the bank\'s FEE code over a rule on the bank\'s name', () => {
        const rules = [manual('Revolut', 'Bank_Transfer')];
        expect(ruleCategory('FEE', 'Revolut Business Fee . Basic plan fee', rules)).toBe('CHARGES');
        expect(ruleCategory('MOS', 'To Revolut account of Jane Example', rules)).toBe('Bank_Transfer');
    });

    it('does not call a payee\'s fee a bank charge', () => {
        expect(ruleCategory('MOS', 'To Jane Example . Example Events: Autumn - Organiser Fee 800', [])).toBeNull();
        expect(ruleCategory('', 'BILL PAYMENT TO EXAMPLE ACCOUNTANTS REFERENCE TAX FEE', [])).toBeNull();
    });
});

describe('isLearnableSignal', () => {
    it.each(['Fee', 'FEE', 'Fee:', 'FX Rate', 'Visa Rate', 'Exchange Rate', 'Interest', 'Faster Payment', 'Car'])
    ('does not learn "%s"', signal => {
        expect(isLearnableSignal(signal)).toBe(false);
    });

    it.each(['Shell', 'Overdraft Fee', 'Commission Charges', 'Example Rail'])
    ('learns "%s"', signal => {
        expect(isLearnableSignal(signal)).toBe(true);
    });

    /**
     * Origin: place names such as "Luton" and "Stansted" had been learned as TRAVEL and sent
     * airport shops there. In the first trial run after they were taken out, the AI offered
     * both again. A word somebody switched off stays off.
     */
    it('does not learn a word again once its rule has been switched off', () => {
        const retired = new Set(['luton', 'bill payment']);

        expect(isLearnableSignal('Luton', retired)).toBe(false);
        expect(isLearnableSignal('LUTON', retired)).toBe(false);
        expect(isLearnableSignal('Luton Airport Parking', retired)).toBe(true);
    });
});

/**
 * The whole path with the AI faked. The fake is deliberately naive: it calls anything
 * with "fee" or "rate" in the text a charge and names that word as its signal, which is
 * what the real model did.
 */
describe('categorize — what the AI is sent and what is written out', () => {
    const sentMerchants: string[] = [];

    beforeEach(() => {
        saved.length = 0; sentMerchants.length = 0; RULES.length = 0; RETIRED.length = 0;
        vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
            const items = JSON.parse(JSON.parse(init.body).input[1].content) as Array<{ id: number; Merchant: string }>;
            const results = items.map(t => {
                sentMerchants.push(t.Merchant);
                const word = t.Merchant.match(/fx rate|fee/i)?.[0];
                if (word) return { id: t.id, category: 'CHARGES', signal: word };
                return /rail/i.test(t.Merchant)
                    ? { id: t.id, category: 'TRAVEL', signal: 'Example Rail' }
                    : { id: t.id, category: 'Bank_Transfer', signal: null };
            });
            return new Response(JSON.stringify({ output_text: JSON.stringify({ results }) }), { status: 200 });
        });
    });

    const tx = (type: string, description: string, moneyOut: string) =>
        ({ date: '01/02/2026', type, description, moneyIn: '', moneyOut, balance: '' });

    it('sends the payee without the bank\'s note and writes the full text to the Excel', async () => {
        const [row] = await categorize([tx('MOS', REVOLUT_PAYMENT, '400.20')]);

        expect(sentMerchants).toEqual(['To Jane Example . Example Events: February 2026 - Event Pay 2']);
        expect(row['Type and Description']).toBe(`MOS ${REVOLUT_PAYMENT}`);
        expect(row.CHARGES).toBe('');
        expect(row.Bank_Transfer).toBe('-400.20');
    });

    it('does not turn a too-broad word into a rule, but still learns a payee', async () => {
        await categorize([
            tx('MOS', 'To Jane Example . Example Events: Autumn - Organiser Fee 800', '800.00'),
            tx('CAR', 'Example Rail tickets', '25.00'),
        ]);

        expect(saved).toEqual([{ pattern: 'Example Rail', category: 'TRAVEL' }]);
    });

    it('does not save a rule again that somebody has switched off', async () => {
        RETIRED.push('EXAMPLE RAIL');

        await categorize([tx('CAR', 'Example Rail tickets', '25.00')]);

        expect(saved).toEqual([]);
    });
});
