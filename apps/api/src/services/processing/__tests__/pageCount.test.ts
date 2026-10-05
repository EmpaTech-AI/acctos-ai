/**
 * A PDF is charged for the pages it has, not for the number of pieces it was
 * sent to Azure in.
 *
 * Origin: three password-protected HSBC statements of 3, 4 and 3 pages were
 * charged as 1 page each. A PDF that cannot be split is sent to Azure whole and
 * comes back as one entry, and the charge counted entries.
 *
 * Azure is mocked: nothing is sent.
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const azureResult = vi.hoisted(() => ({ value: {} as any }));
vi.hoisted(() => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'https://example.test';
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = 'test-key';
});
vi.mock('@azure/ai-form-recognizer', () => ({
    AzureKeyCredential: class {},
    DocumentAnalysisClient: class {
        async beginAnalyzeDocument() { return { pollUntilDone: async () => azureResult.value }; }
    },
}));

import { analyzePage, countPagesRead, PageData } from '../AzureExtractor.js';

async function pdfWithPages(n: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < n; i++) doc.addPage();
    return Buffer.from(await doc.save());
}

const entry = (pageCount?: number): PageData => ({ cells: [], content: 'x', ...(pageCount === undefined ? {} : { pageCount }) });
const NOT_A_PDF = Buffer.from('not a pdf');

describe('analyzePage', () => {
    it('records how many pages Azure read from the buffer', async () => {
        azureResult.value = { pages: [{}, {}, {}, {}], tables: [], content: 'statement' };
        expect((await analyzePage(NOT_A_PDF)).pageCount).toBe(4);
    });

    it('counts one page when Azure reports none', async () => {
        azureResult.value = { content: '' };
        expect((await analyzePage(NOT_A_PDF)).pageCount).toBe(1);
    });
});

describe('countPagesRead', () => {
    it('counts every page of a PDF that was sent whole', async () => {
        expect(await countPagesRead(NOT_A_PDF, [entry(4)])).toBe(4);
    });

    it('counts the pages inside each chunk of a PDF that was sent in chunks', async () => {
        expect(await countPagesRead(NOT_A_PDF, [entry(10), entry(10), entry(3)])).toBe(23);
    });

    it('counts only the pages that were read when the PDF was sent a page at a time', async () => {
        expect(await countPagesRead(NOT_A_PDF, [entry(1), null, entry(1)])).toBe(2);
    });

    it('counts nothing when nothing was read', async () => {
        expect(await countPagesRead(NOT_A_PDF, [null, null])).toBe(0);
    });

    describe('cache entries written before the page count was recorded', () => {
        it('uses the PDF page count when the whole PDF is one entry', async () => {
            expect(await countPagesRead(await pdfWithPages(4), [entry()])).toBe(4);
        });

        it('counts the entries when there is one per page', async () => {
            expect(await countPagesRead(await pdfWithPages(3), [entry(), null, entry()])).toBe(2);
        });

        it('counts a one-page PDF as one page', async () => {
            expect(await countPagesRead(await pdfWithPages(1), [entry()])).toBe(1);
        });

        it('counts the entries when the PDF cannot be opened', async () => {
            expect(await countPagesRead(NOT_A_PDF, [entry()])).toBe(1);
        });
    });
});
