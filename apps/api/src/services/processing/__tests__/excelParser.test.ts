/**
 * The spreadsheet reader on a bank's "Excel" export that is really a web page.
 *
 * Origin: a Santander statement saved as "Statements….xls" (13 Oct 2026) came
 * back "No transactions found in spreadsheet". The file is an HTML table in
 * ISO-8859-1. Read as UTF-8, every "£" became an unreadable character, the
 * amount reader only stripped £ $ € and read nothing, and all 600 rows were
 * dropped. Decoded properly, the library then guessed cell types: "04/07/2026"
 * became 7 April and "£ 45.02" a date.
 *
 * The column layout normally comes from the AI; here fetch is faked to return
 * it. Fixtures are synthetic: invented payees, round amounts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { parseExcel } from '../ExcelParser.js';

const LAYOUT = {
    'Transaction Date': '0', 'Transaction Description': '1', 'Transaction Type': '',
    'Credit Amount': '2', 'Debit Amount': '3', 'Balance': '4', 'Signed Amount': '',
};

beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(LAYOUT) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    )));
});

afterEach(() => { vi.unstubAllGlobals(); });

/** A statement page the way Santander writes it: newest first, "£ 1,234.56" amounts. */
function santanderPage(rows: string[][]): Buffer {
    const tr = (cells: string[]) => `<tr>${cells.map(v => `<td>${v}</td>`).join('')}</tr>`;
    const html = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
        + '<html><head><meta content="text/html; charset=iso-8859-1" http-equiv="Content-Type" /></head><body><table>'
        + tr(['Transactions']) + tr(['XXXX XXXX XXXX 0000:', '01/07/2026 to 30/09/2026']) + tr([])
        + tr(['Date', 'Description', 'Money in', 'Money Out', 'Balance']) + tr([])
        + rows.map(tr).join('')
        + '</table></body></html>';
    return Buffer.from(html, 'latin1');   // "£" is the single byte 0xA3, as in the real file
}

describe('parseExcel: a web page saved as .xls', () => {
    const file = santanderPage([
        ['30/09/2026', 'FASTER PAYMENTS RECEIPT FROM EXAMPLE CLIENT LTD', '£ 3,500.00', '', '£ 4,345.00'],
        ['12/08/2026', 'CARD PAYMENT TO EXAMPLE SHOP', '', '£ 45.02', '£ 845.00'],
        ['04/07/2026', 'DIRECT DEBIT PAYMENT TO EXAMPLE ENERGY', '', '£ 1,110.00', '£ 890.02'],
    ]);

    it('reads every row with its amounts', async () => {
        const tx = await parseExcel(file);
        expect(tx.map(t => [t['Money in'], t['Money out'], t.Balance])).toEqual([
            ['3500.00', '', '4345.00'],
            ['', '45.02', '845.00'],
            ['', '1110.00', '890.02'],
        ]);
    });

    it('keeps day-first dates as they are written', async () => {
        const tx = await parseExcel(file);
        expect(tx.map(t => t.Date)).toEqual(['30/09/2026', '12/08/2026', '04/07/2026']);
    });

    it('leaves no garbled character in the text', async () => {
        const tx = await parseExcel(file);
        expect(JSON.stringify(tx)).not.toMatch(/�/);
    });
});

describe('parseExcel: amounts with a sign the reader does not know', () => {
    it('still reads the number', async () => {
        const sheet = XLSX.utils.aoa_to_sheet([
            ['Date', 'Description', 'Money in', 'Money Out', 'Balance'],
            ['01/07/2026', 'EXAMPLE PAYMENT', '', '� 12.50', '� 87.50'],
            ['02/07/2026', 'EXAMPLE RECEIPT', '₺ 1 000.00', '', '₺ 1 087.50'],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
        const tx = await parseExcel(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
        expect(tx.map(t => [t['Money in'], t['Money out'], t.Balance])).toEqual([
            ['', '12.50', '87.50'],
            ['1000.00', '', '1087.50'],
        ]);
    });
});
