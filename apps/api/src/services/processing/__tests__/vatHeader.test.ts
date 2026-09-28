/**
 * The VAT result's header (VAT Return C1) is always written, so the template's leftover
 * client name never reaches another client's file.
 *
 * Origin: template-vat.xlsx carries "60 stranici 120 FIRE LTD CORP.xlsx" in C1. It was
 * overwritten only when a client name was passed, so two results for emails without a
 * subject went out with that other client's name in the header.
 */

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildVatOutputExcel } from '../ExcelOutputBuilder.js';

async function header(buffer: Buffer): Promise<unknown> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb.getWorksheet('VAT Return')!.getCell('C1').value;
}

describe('buildVatOutputExcel header', () => {
    it('writes the client name', async () => {
        const { buffer } = await buildVatOutputExcel([], 'GREEK GYROS AFROVITI LTD');
        expect(await header(buffer)).toBe('GREEK GYROS AFROVITI LTD');
    });

    it("clears the template's leftover name when no client name is given", async () => {
        const { buffer } = await buildVatOutputExcel([], undefined);
        const value = await header(buffer);
        expect(value === '' || value === null).toBe(true);
        expect(String(value ?? '')).not.toContain('FIRE LTD');
    });
});
