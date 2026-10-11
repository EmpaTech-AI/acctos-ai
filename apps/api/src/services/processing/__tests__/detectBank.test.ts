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
import { detectBankFromContent } from '../DocumentClassifier.js';

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
