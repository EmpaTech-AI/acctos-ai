/**
 * Vendor rules learned by the AI match whole words; rules entered by a person keep
 * substring matching.
 *
 * Origin: the AI saved short "contains" rules that matched inside other words — "Car"
 * caught every "Card purchase" (491 rows of one Mettle statement went to TRAVEL),
 * "INS" caught "Travis Perkins", "Bridge" caught "Uxbridge", "KEY" caught "Milton Keynes".
 */

import { describe, it, expect } from 'vitest';
import { applyVendorRule } from '../AssistantCategorizer.js';
import type { VendorRule } from '../../SupabaseService.js';

const ai     = (pattern: string, category: string): VendorRule => ({ pattern, match_type: 'contains', category, source: 'ai' });
const manual = (pattern: string, category: string): VendorRule => ({ pattern, match_type: 'contains', category, source: 'manual' });

describe('applyVendorRule — AI-learned rules match whole words', () => {
    it('does not match a learned word inside another word', () => {
        expect(applyVendorRule('Card purchase HG Buildbase Bexleyhea Kent', [ai('Car', 'TRAVEL')])).toBeNull();
        expect(applyVendorRule('Card purchase Travis Perkins', [ai('INS', 'INSURANCE')])).toBeNull();
        expect(applyVendorRule('Card purchase Thedirectoryguys.co.uk Uxbridge', [ai('Bridge', 'TRAVEL')])).toBeNull();
        expect(applyVendorRule('Card Purchase Milton Keynes Onst', [ai('KEY', 'TRAVEL')])).toBeNull();
        expect(applyVendorRule('Card purchase 735 Penge Limes Avenue', [ai('Lime', 'TRAVEL')])).toBeNull();
    });

    it('still matches the learned word on its own, whatever surrounds it', () => {
        expect(applyVendorRule('VIS Stratford City Car London', [ai('Car', 'TRAVEL')])).toBe('TRAVEL');
        expect(applyVendorRule('Card Payment to Flamstead Filling On 14 Mar', [ai('Filling', 'TRAVEL')])).toBe('TRAVEL');
        expect(applyVendorRule('ASDA Petrol 4223', [ai('PETROL', 'TRAVEL')])).toBe('TRAVEL');
        expect(applyVendorRule('DD Direct Debit to Halifax Ref: 1056021155010000', [ai('HALIFAX', 'LOAN')])).toBe('LOAN');
        expect(applyVendorRule('Westquay Car Park Sou Southampton', [ai('CAR PARK', 'TRAVEL')])).toBe('TRAVEL');
    });

    it('treats regex characters in a pattern literally', () => {
        expect(applyVendorRule('Card Purchase Uber *Trip On 11 Apr', [ai('Uber *Trip', 'TRAVEL')])).toBe('TRAVEL');
        expect(applyVendorRule('Card Purchase Uber Trip', [ai('Uber *Trip', 'TRAVEL')])).toBeNull();
    });
});

describe('applyVendorRule — rules entered by a person keep substring matching', () => {
    it('matches inside a word, as before', () => {
        expect(applyVendorRule('Card purchase Stoneworks By Design', [manual('STO', 'Bank_Transfer')])).toBe('Bank_Transfer');
        expect(applyVendorRule('Card purchase Hmrc Etmp', [manual('HMRC', 'HMRC')])).toBe('HMRC');
    });

    it('treats a rule with no source as entered by a person', () => {
        expect(applyVendorRule('Commission Charges', [{ pattern: 'commission', match_type: 'contains', category: 'CHARGES' }])).toBe('CHARGES');
    });

    it('first matching rule wins, in order', () => {
        const rules = [ai('Car', 'TRAVEL'), manual('Buildbase', 'OTHER')];
        expect(applyVendorRule('Card purchase HG Buildbase', rules)).toBe('OTHER');
    });
});
