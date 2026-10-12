/**
 * A Monzo statement is recognised by its own header, not by who the holder pays.
 *
 * Origin: a 192-page Monzo personal statement was read as Barclaycard, because
 * one of its rows was a card repayment to "BARCLAYCARD NORTHAMPTON GBR". The
 * Barclaycard parser found no transactions and the job failed, twice.
 *
 * Names and numbers below are made up.
 */

import { describe, it, expect } from 'vitest';
import { detectBankFromContent, banksNamedInContent } from '../DocumentClassifier.js';

const MONZO_HEADER = [
    'monzo', 'Personal Account statement', '01/04/2025 - 31/03/2026', 'Jane Example',
    '-£850.00', 'Total outgoings', 'Sort code: 04-00-04', '+£2,000.00', 'Account number: 12345678',
    'Total deposits', 'BIC: MONZGB2L', 'IBAN: GB00 MONZ 0400 0412 3456 78',
    'Date', 'Description', '(GBP) Amount', '(GBP) Balance',
].join('\n');

describe('detectBankFromContent – Monzo', () => {
    it.each([
        ['a Barclaycard repayment', '30/03/2026\nBARCLAYCARD NORTHAMPTON GBR\n-75.00\n12.16'],
        ['a transfer to a NatWest account', '30/03/2026\nJOHN SMITH NATWEST (Faster Payments)\n-20.00\n10.00'],
        ['a Santander cycle hire', '30/03/2026\nSANTANDER CYCLES LONDON GBR\n-2.00\n8.00'],
        ['a top-up to Revolut', '30/03/2026\nRevolut ** 1234* London GBR\n-100.00\n1.00'],
        ['a Tide payee', '30/03/2026\nTIDE PLATFORM LTD (Faster Payments)\n-10.00\n0.00'],
    ])('stays Monzo when a row is %s', (_what, rowText) => {
        expect(detectBankFromContent(`${MONZO_HEADER}\n${rowText}`)).toBe('monzo');
    });

    it('still reads a Barclaycard statement as Barclaycard', () => {
        expect(detectBankFromContent('Barclaycard\nYour statement\nPayment to MONZO BANK LTD\n£50.00')).toBe('barclaycard');
    });

    it('does not claim another bank because a payee there has a Monzo BIC', () => {
        const natwest = 'NatWest\nStatement\nBIC NWBKGB2L\nPayment to J Example BIC MONZGB2L\n£20.00';
        expect(detectBankFromContent(natwest)).toBe('natwest');
    });
});

/**
 * Origin: on 11 Oct an ANNA statement and three Tide statements were read as
 * NatWest. ANNA's header prints "Intermediary BIC/SWIFT: NWBKGB2L"; the Tide
 * account had used a cash machine listed as "NATWEST BANK - …". The first failed
 * with no transactions, the second came out with dates and amounts as descriptions.
 */
describe('detectBankFromContent – ANNA and Tide', () => {
    const ANNA = [
        'ANNA', 'EXAMPLE TRANSPORT LTD', 'Statement 1 Jul 2026 - 30 Sep 2026',
        'Institution: Payrnet, Po Box 1130, Cardiff', 'Account number: 12345678 Sort code: 23-11-85',
        'IBAN: GB00PAYR23118512345678 BIC/SWIFT: PAYRGB2LXXX Intermediary BIC/SWIFT: NWBKGB2L',
        'Closing balance', '£700.00', 'Processed on', 'Created on', 'Type', 'Transaction',
        'ANNA is an Electronic Money account opened with PayrNet Ltd.',
    ].join('\n');
    const TIDE = [
        'tide', 'Business Owner:', 'EXAMPLE LTD', 'Bank statement', 'Account number: 12345678 Sort code: 040605',
        'Total paid in (£)', '1,000.00', 'Total paid out (£)', '500.00',
        '26 Aug 2026', 'Cash Withdrawal', 'NATWEST BANK - EXAMPLE STORE, LONDON (includes fee of GBP 1.00)', '500.00',
        'Bank account legal', 'Your Tide account is a bank account provided by ClearBank Limited.',
    ].join('\n');

    it('reads an ANNA statement as ANNA although its header shows a NatWest intermediary BIC', () => {
        expect(detectBankFromContent(ANNA)).toBe('anna');
    });

    it('reads a Tide statement as Tide although a row names a NatWest cash machine', () => {
        expect(detectBankFromContent(TIDE)).toBe('tide');
    });

    it('still reads a NatWest statement as NatWest when a payee there is Tide or ANNA', () => {
        const natwest = 'NatWest\nStatement\nBIC NWBKGB2L\nPayment to TIDE PLATFORM LTD\n£20.00\nPayment to ANNA MONEY PAYRNET\n£5.00';
        expect(detectBankFromContent(natwest)).toBe('natwest');
    });

    it('lists every bank a document names, issuer and payees alike', () => {
        expect(banksNamedInContent(TIDE)).toEqual(['tide', 'natwest']);
        expect(banksNamedInContent(ANNA)).toEqual(['anna', 'natwest']);
        expect(banksNamedInContent('nothing here names a bank')).toEqual([]);
    });
});
