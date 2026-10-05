import { DocumentAnalysisClient, AzureKeyCredential } from '@azure/ai-form-recognizer';
import { Cell } from './parsers/shared.js';
import { getPageCount, splitIntoChunks } from './PdfSplitter.js';

const CHUNK_SIZE = 10; // pages per chunk when falling back from a size error

function isSizeError(err: any): boolean {
    if (err?.statusCode === 413) return true;
    const msg: string = (err?.message ?? err?.code ?? '').toLowerCase();
    return msg.includes('too large') || msg.includes('file size') || msg.includes('content length')
        || msg.includes('maximum') || msg.includes('exceed') || msg.includes('invalidrequest');
}

export interface PageData {
    cells: Cell[];
    content: string;
    /**
     * How many PDF pages Azure read for this entry. Usually 1 — the PDF is split
     * and sent a page at a time — but a PDF that cannot be split (password
     * protected, or one pdf-lib cannot open) is sent whole, and one that is too
     * large is sent in chunks. Missing on cache entries written before this was
     * recorded.
     */
    pageCount?: number;
}

let client: DocumentAnalysisClient | null = null;

function getClient(): DocumentAnalysisClient {
    if (!client) {
        const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
        const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
        if (!endpoint || !key) {
            throw new Error('Azure Document Intelligence credentials not configured. Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY environment variables.');
        }
        client = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key));
    }
    return client;
}

/** Analyze a single-page PDF buffer with Azure prebuilt-layout model.
 *  Returns all table cells across all detected tables, plus the full page text. */
export async function analyzePage(pageBuffer: Buffer): Promise<PageData> {
    const azureClient = getClient();

    const poller = await azureClient.beginAnalyzeDocument('prebuilt-layout', pageBuffer);
    const result = await poller.pollUntilDone();

    const cells: Cell[] = [];

    if (result.tables && result.tables.length > 0) {
        let rowOffset = 0;
        for (const table of result.tables) {
            for (const cell of table.cells) {
                cells.push({
                    rowIndex: (cell.rowIndex ?? 0) + rowOffset,
                    columnIndex: cell.columnIndex ?? 0,
                    content: (cell.content ?? '').trim(),
                });
            }
            const maxRow = table.cells.reduce((m, c) => Math.max(m, c.rowIndex ?? 0), 0);
            rowOffset += maxRow + 2;
        }
    }

    return { cells, content: result.content ?? '', pageCount: result.pages?.length || 1 };
}

/**
 * How many pages of a PDF were read — what the tenant is charged and what Azure
 * bills. Counting entries is not enough: a password-protected statement comes
 * back as ONE entry however long it is, so a 4-page statement was charged as 1.
 */
export async function countPagesRead(pdfBuffer: Buffer, pageData: Array<PageData | null>): Promise<number> {
    const read = pageData.filter((p): p is PageData => p !== null);
    if (read.length === 0) return 0;
    if (read.every(p => typeof p.pageCount === 'number')) {
        return read.reduce((n, p) => n + p.pageCount!, 0);
    }
    // Older cache entries carry no count. One entry per page is the normal case;
    // fewer entries than the PDF has pages means it was sent whole or in chunks,
    // and then the PDF's own page count is what was read.
    const inPdf = await getPageCount(pdfBuffer).catch(() => 0);
    return pageData.length < inPdf ? inPdf : read.length;
}

/** Analyze multiple pages with a concurrency limit of 3 (matching Make's rate limit).
 *  If a buffer is rejected by Azure due to size, it is automatically split into
 *  CHUNK_SIZE-page pieces and each chunk is analysed separately. */
export async function analyzePages(pageBuffers: Buffer[]): Promise<Array<PageData | null>> {
    getClient();

    const CONCURRENCY = 3;
    // Each slot may expand into multiple results if a chunk fallback fires.
    const resultGroups: Array<PageData | null>[] = [];

    for (let i = 0; i < pageBuffers.length; i += CONCURRENCY) {
        const batch = pageBuffers.slice(i, i + CONCURRENCY);
        const batchGroups = await Promise.all(
            batch.map(async (buf, batchIdx) => {
                const pageIdx = i + batchIdx;
                try {
                    return [await analyzePage(buf)];
                } catch (err: any) {
                    if (isSizeError(err)) {
                        console.warn(`[AzureExtractor] Buffer ${pageIdx + 1} too large for Azure DI — retrying in ${CHUNK_SIZE}-page chunks...`);
                        try {
                            const chunks = await splitIntoChunks(buf, CHUNK_SIZE);
                            // Recursive call handles concurrency limit for the chunks.
                            const chunkResults = await analyzePages(chunks);
                            console.log(`[AzureExtractor] Chunked fallback: ${chunkResults.filter(Boolean).length}/${chunks.length} chunks succeeded.`);
                            return chunkResults;
                        } catch (splitErr: any) {
                            console.error(`[AzureExtractor] Chunked fallback failed: ${splitErr.message}`);
                        }
                    } else {
                        console.error(`[AzureExtractor] Buffer ${pageIdx + 1} failed: ${err.message}`);
                    }
                    return [null] as (PageData | null)[];
                }
            })
        );
        resultGroups.push(...batchGroups);
    }

    return resultGroups.flat();
}
