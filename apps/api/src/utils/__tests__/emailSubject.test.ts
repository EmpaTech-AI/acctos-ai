/**
 * An email with no subject must still get a name, because the originals folder, the
 * result folder and filename, the VAT header and the result email all key off it.
 *
 * Origin: two VAT emails with an empty subject were processed but filed as
 * "_processed.xlsx" in the root folder, with no originals saved and no result email sent.
 * (Names and addresses below are made up.)
 */

import { describe, it, expect } from 'vitest';
import { subjectOrSender } from '../emailSubject.js';

describe('subjectOrSender', () => {
    it('keeps a real subject', () => {
        expect(subjectOrSender('EXAMPLE TRADING LTD accounts', 'JANE DOE <jane.doe@example.test>'))
            .toBe('EXAMPLE TRADING LTD accounts');
    });

    it("uses the sender's display name when the subject is empty", () => {
        expect(subjectOrSender('', 'Example Kebab House Ltd <owner@example.test>')).toBe('Example Kebab House Ltd');
        expect(subjectOrSender('   ', 'john smith <john.smith@example.test>')).toBe('john smith');
    });

    it('drops quotes and the trailing marker Gmail adds to some display names', () => {
        expect(subjectOrSender('', '"Example Accounting Ltd *" <info@example.test>')).toBe('Example Accounting Ltd');
    });

    it('falls back to the address when there is no display name', () => {
        expect(subjectOrSender('', '<john.smith@example.test>')).toBe('john.smith@example.test');
        expect(subjectOrSender(undefined, 'john.smith@example.test')).toBe('john.smith@example.test');
    });
});
