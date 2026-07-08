import { PDFDocument } from 'pdf-lib';

// Barclays (and some other banks) encrypt their PDFs with an owner-only password
// (empty user password). pdf-lib copies page content streams as raw encrypted
// bytes, producing unreadable output. Azure DI can handle encrypted PDFs
// directly, so for encrypted documents we skip the per-page split and return
// the whole PDF as a single buffer. Azure DI's prebuilt-layout model will
// process all pages in one call and return row-offset table cells correctly.
function isEncrypted(buf: Buffer): boolean {
    // /Encrypt lives in the PDF trailer which is at the END of the file
    const tail = buf.toString('latin1', Math.max(0, buf.length - 8192));
    return tail.includes('/Encrypt');
}

export async function splitPdf(pdfBuffer: Buffer): Promise<Buffer[]> {
    if (isEncrypted(pdfBuffer)) {
        console.log('[PdfSplitter] Encrypted PDF detected — skipping split, sending whole document to Azure DI.');
        return [pdfBuffer];
    }

    let srcDoc: PDFDocument;
    try {
        srcDoc = await PDFDocument.load(pdfBuffer);
    } catch (loadErr: any) {
        // pdf-lib rejected the file (e.g. corrupt HTTP transfer from Make.com).
        // Azure DI can handle multi-page PDFs directly, so send the whole buffer
        // without splitting — it will process all pages in one call.
        console.warn(`[PdfSplitter] PDFDocument.load failed — sending whole buffer to Azure DI: ${loadErr?.message}`);
        return [pdfBuffer];
    }
    const pageCount = srcDoc.getPageCount();
    const pages: Buffer[] = [];

    for (let i = 0; i < pageCount; i++) {
        const singlePageDoc = await PDFDocument.create();
        const [copiedPage]  = await singlePageDoc.copyPages(srcDoc, [i]);
        singlePageDoc.addPage(copiedPage);
        const bytes = await singlePageDoc.save();
        pages.push(Buffer.from(bytes));
    }

    return pages;
}

export async function getPageCount(pdfBuffer: Buffer): Promise<number> {
    if (isEncrypted(pdfBuffer)) {
        // Load with ignoreEncryption just to count pages
        const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        return doc.getPageCount();
    }
    const doc = await PDFDocument.load(pdfBuffer);
    return doc.getPageCount();
}

/**
 * Split a PDF (including encrypted ones) into chunks of `chunkSize` pages each.
 * Used as a fallback when Azure DI rejects a large single-file submission.
 * For encrypted PDFs we load with ignoreEncryption — Azure DI can still decrypt
 * each chunk because owner-only-password PDFs have readable content streams.
 */
export async function splitIntoChunks(pdfBuffer: Buffer, chunkSize: number): Promise<Buffer[]> {
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pageCount = srcDoc.getPageCount();
    const chunks: Buffer[] = [];

    for (let start = 0; start < pageCount; start += chunkSize) {
        const end = Math.min(start + chunkSize, pageCount);
        const chunkDoc = await PDFDocument.create();
        const indices = Array.from({ length: end - start }, (_, i) => start + i);
        const copied = await chunkDoc.copyPages(srcDoc, indices);
        copied.forEach(p => chunkDoc.addPage(p));
        chunks.push(Buffer.from(await chunkDoc.save()));
    }

    console.log(`[PdfSplitter] Split ${pageCount}-page PDF into ${chunks.length} chunks of ≤${chunkSize} pages.`);
    return chunks;
}
