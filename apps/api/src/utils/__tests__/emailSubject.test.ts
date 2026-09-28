/**
 * An email with no subject must still get a name, because the originals folder, the
 * result folder and filename, the VAT header and the result email all key off it.
 *
 * Origin: two VAT emails with an empty subject (Greek Gyros Afroviti Ltd, borislav
 * borislavov) were processed but filed as "_processed.xlsx" in the root folder, with
 * no originals saved and no result email sent.
 */

import { describe, it, expect } from 'vitest';
import { subjectOrSender } from '../emailSubject.js';

describe('subjectOrSender', () => {
    it('keeps a real subject', () => {
        expect(subjectOrSender('FS BEXLEY LONDON LTD accounts', 'EMILIA PETROVA <england20199@gmail.com>'))
            .toBe('FS BEXLEY LONDON LTD accounts');
    });

    it("uses the sender's display name when the subject is empty", () => {
        expect(subjectOrSender('', 'Greek Gyros Afroviti Ltd <greekgyrosafroviti@gmail.com>')).toBe('Greek Gyros Afroviti Ltd');
        expect(subjectOrSender('   ', 'borislav borislavov <boby.1970@hotmail.com>')).toBe('borislav borislavov');
    });

    it('drops quotes and the trailing marker Gmail adds to some display names', () => {
        expect(subjectOrSender('', '"Universal Trade BG Ltd *" <info@universaltradebgltd.com>')).toBe('Universal Trade BG Ltd');
    });

    it('falls back to the address when there is no display name', () => {
        expect(subjectOrSender('', '<boby.1970@hotmail.com>')).toBe('boby.1970@hotmail.com');
        expect(subjectOrSender(undefined, 'boby.1970@hotmail.com')).toBe('boby.1970@hotmail.com');
    });
});
