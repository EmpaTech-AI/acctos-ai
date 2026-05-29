/**
 * Barclays parser test — processes a real PDF via Azure DI (cached).
 * Results saved as _processed.xlsx next to the PDF.
 *
 * Usage (from apps/api/):
 *   npx tsx test-barclays.ts "<path-to-barclays-pdf>"
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { splitPdf } from './src/services/processing/PdfSplitter.js';
import { analyzePage } from './src/services/processing/AzureExtractor.js';
import { parse } from './src/services/processing/parsers/barclays.js';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';
import type { Cell } from './src/services/processing/parsers/shared.js';
import type { CategorizedTransaction } from './src/services/processing/AssistantCategorizer.js';

const pdfPath = process.argv[2];
if (!pdfPath) { console.error('Usage: npx tsx test-barclays.ts "<path-to-pdf>"'); process.exit(1); }

const cachePath = pdfPath + '.azure-cache.json';

async function main() {
    console.log(`\nPDF: ${path.basename(pdfPath)}`);

    // ── Azure DI (with cache) ──────────────────────────────────────────────
    interface CacheEntry { cells: Cell[]; content: string; }
    let pageData: CacheEntry[];

    if (existsSync(cachePath)) {
        console.log('Using cached Azure DI results…');
        const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
        // Support old format (Cell[][]) and new format (CacheEntry[])
        if (Array.isArray(raw[0]) || raw.length === 0) {
            pageData = (raw as Cell[][]).map(cells => ({ cells, content: '' }));
        } else {
            pageData = raw as CacheEntry[];
        }
    } else {
        console.log('Splitting PDF into pages…');
        const pages = await splitPdf(readFileSync(pdfPath));
        console.log(`${pages.length} page(s) — calling Azure DI…`);
        pageData = [];
        for (let i = 0; i < pages.length; i++) {
            process.stdout.write(`  Page ${i + 1}/${pages.length}… `);
            const data = await analyzePage(pages[i]);
            pageData.push({ cells: data.cells, content: data.content });
            console.log(`${data.cells.length} cells, ${data.content.length} chars content`);
        }
        writeFileSync(cachePath, JSON.stringify(pageData));
        console.log('Cache saved.');
    }

    // ── Merge pages (offset rows + inject combined content as context cell) ──
    const combinedContent = pageData.map(p => p.content).filter(Boolean).join(' ')
        || pageData.flatMap(p => p.cells).map(c => c.content).join(' ');
    const combined: Cell[] = [{ rowIndex: -1, columnIndex: -1, content: combinedContent }];
    let rowOffset = 0;
    for (const { cells } of pageData) {
        let pageMax = -1;
        for (const c of cells) {
            combined.push({ ...c, rowIndex: c.rowIndex + rowOffset });
            if (c.rowIndex > pageMax) pageMax = c.rowIndex;
        }
        if (pageMax >= 0) rowOffset += pageMax + 10000;
    }

    // ── Diagnostic: show raw content if no cells found ────────────────────
    const totalCells = pageData.reduce((s, p) => s + p.cells.length, 0);
    if (totalCells === 0 && combinedContent) {
        console.log('\n── Raw content (first 2000 chars) ──');
        console.log(combinedContent.slice(0, 2000));
        console.log('──');
    }

    // Detect variant
    const variant = /Premier BK AC/i.test(combinedContent) ? 'Premier BK AC' : 'Normal Layout';
    console.log(`\nVariant detected: ${variant}`);

    // ── Parse ──────────────────────────────────────────────────────────────
    const result = parse(combined);
    const txns   = result.transactions;

    // ── Print table ────────────────────────────────────────────────────────
    const W = { date: 12, desc: 50, out: 14, inn: 14 };
    const sep = '─'.repeat(W.date + W.desc + W.out + W.inn + 12);
    console.log(`\nTransactions: ${txns.length}\n${sep}`);
    console.log('Date'.padEnd(W.date) + 'Description'.padEnd(W.desc) + 'Out'.padEnd(W.out) + 'In'.padEnd(W.inn) + 'Balance');
    console.log(sep);
    for (const tx of txns) {
        console.log(
            tx.date.padEnd(W.date) +
            (tx.description || '').slice(0, W.desc - 2).padEnd(W.desc) +
            (tx.moneyOut || '').padEnd(W.out) +
            (tx.moneyIn  || '').padEnd(W.inn) +
            (tx.balance  || '')
        );
    }

    // ── Totals ─────────────────────────────────────────────────────────────
    const totalOut = txns.reduce((s, t) => s + (parseFloat(t.moneyOut?.replace(/,/g, '') || '0') || 0), 0);
    const totalIn  = txns.reduce((s, t) => s + (parseFloat(t.moneyIn?.replace(/,/g, '')  || '0') || 0), 0);
    console.log(sep);
    console.log('TOTAL'.padEnd(W.date) + ''.padEnd(W.desc) + totalOut.toFixed(2).padEnd(W.out) + totalIn.toFixed(2));
    console.log(`Money Out: ${totalOut.toFixed(2)}   Money In: ${totalIn.toFixed(2)}   Net: ${(totalIn - totalOut).toFixed(2)}`);

    // ── Save Excel ─────────────────────────────────────────────────────────
    const categorized: CategorizedTransaction[] = txns.map(t => ({
        DATE: t.date,
        'Type and Description': t.description,
        INCOME: t.moneyIn || '', SALARY: '', OTHER: '', INSURANCE: '', LOAN: '',
        CASH: '', TRAVEL: '', PHONE: '', CHARGES: t.moneyOut || '',
        Bank_Transfer: '', HMRC: '', RENT: '', BILLS: '',
        Balance: t.balance || '',
    }));

    const outPath = pdfPath + '_processed.xlsx';
    writeFileSync(outPath, buildPdfOutputExcel(categorized));
    console.log(`\nSaved: ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
