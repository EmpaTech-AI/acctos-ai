/**
 * Regression tests for detecting Mettle statements from their text.
 *
 * Origin: a batch of three Mettle statements (Jun–Aug 2026). Two had filenames
 * with no bank name ("June_Statement_2026-06.pdf"), so the bank came from the
 * content, and detection returned NatWest. Mettle statements are headed
 * "mettle. by NatWest" and their footer names "National Westminster Bank plc
 * trading as Mettle", and the NatWest check ran first. The NatWest parser then
 * lost nearly all Money In. Only the third file, whose filename said Mettle,
 * was parsed correctly.
 *
 * NatWest's own FSCS footer also names Mettle, which is why the Mettle check
 * must key on Mettle's branding text rather than the word "mettle".
 *
 * The text below is synthetic apart from the banks' standard footer wording.
 */

import { describe, it, expect } from 'vitest';
import { detectBankFromContent } from '../../DocumentClassifier.js';

const METTLE_TEXT = [
    'mettle.', 'by & NatWest',
    'Statement 01 Jun 2026 to 30 Jun 2026',
    'Account Details Account number 12345678 Sort code 04-03-33',
    'Main account summary', 'Balance on 01 Jun 2026', '£1,000.00',
    'DATE', 'DESCRIPTION', '£IN', '£ OUT', '£ BALANCE',
    '01 Jun 2026', 'Example Supplier Card purchase', '10.00', '990.00',
    'The Mettle bank account is provided by National Westminster Bank plc trading as Mettle.',
    'This limit is applied to the total of any deposits you have with the following: National Westminster Bank Plc, NatWest Premier, Ulster Bank, NatWest Boxed and Mettle.',
    'The FSCS Information Sheet and list of exclusions can be accessed at www.mettle.co.uk/fscs-key-information',
].join('\n');

const NATWEST_TEXT = [
    'NatWest', 'Statement', 'BIC NWBKGB2L',
    '01 JUN 2026 BROUGHT FORWARD 1,000.00',
    'Deposits with National Westminster Bank plc are protected by the Financial Services Compensation Scheme.',
    'This means that all deposits with one or more of NatWest Bank, NatWest Premier, Ulster Bank and Mettle are covered under the same FSCS limit.',
].join('\n');

describe('detectBankFromContent — Mettle vs NatWest', () => {
    it('detects a Mettle statement although it names NatWest in its header and footer', () => {
        expect(detectBankFromContent(METTLE_TEXT)).toBe('mettle');
    });

    it('still detects a NatWest statement whose FSCS footer lists Mettle', () => {
        expect(detectBankFromContent(NATWEST_TEXT)).toBe('natwest');
    });
});
