/**
 * Tide parser end-to-end test.
 *
 * Run from apps/api/:
 *   npx tsx test-tide.ts "<path-to-pdf>"
 *
 * Azure DI results are cached as JSON next to the PDF so subsequent runs are instant.
 */

import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

import { splitPdf } from './src/services/processing/PdfSplitter.js';
import { analyzePages } from './src/services/processing/AzureExtractor.js';
import { parse } from './src/services/processing/parsers/tide.js';
import type { Cell } from './src/services/processing/parsers/shared.js';

const pdfPath = process.argv[2];
if (!pdfPath) { console.error('Usage: npx tsx test-tide.ts "<pdf path>"'); process.exit(1); }

const cachePath = pdfPath.replace(/\.pdf$/i, '') + '_tide_cache.json';

async function main() {
    let pagesCells: Cell[][];

    if (fs.existsSync(cachePath)) {
        console.log(`[cache] loading ${cachePath}`);
        pagesCells = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } else {
        console.log(`[azure] analysing ${pdfPath} …`);
        const pdfBuffer = fs.readFileSync(pdfPath);
        const pages = await splitPdf(pdfBuffer);
        console.log(`[azure] ${pages.length} pages, sending to DI…`);
        const pageData = await analyzePages(pages);
        // Normalise OCR artefact: € → £ (Azure DI misreads £ on Tide PDFs)
        pagesCells = pageData.map(p =>
            (p?.cells ?? []).map(c => ({ ...c, content: c.content.replace(/€/g, '£') }))
        );
        fs.writeFileSync(cachePath, JSON.stringify(pagesCells, null, 2));
        console.log(`[cache] saved → ${cachePath}`);
    }

    const combinedContent = pagesCells.flat().map(c => c.content).join(' ');
    const combined: Cell[] = [
        { rowIndex: -1, columnIndex: -1, content: combinedContent },
    ];
    let rowOffset = 0;
    for (const pageCells of pagesCells) {
        for (const c of pageCells) {
            combined.push({ ...c, rowIndex: c.rowIndex + rowOffset });
        }
        const maxRow = pageCells.reduce((m, c) => Math.max(m, c.rowIndex), -1);
        if (maxRow >= 0) rowOffset += maxRow + 10000;
    }

    console.log(`\nTotal cells: ${combined.length - 1}   pages: ${pagesCells.length}\n`);

    const result = parse(combined);

    const W = { date: 12, type: 22, desc: 40, out: 12, inn: 12 };
    const sep = '─'.repeat(W.date + W.type + W.desc + W.out + W.inn + 10);

    console.log(`Transactions: ${result.transactions.length}\n${sep}`);
    console.log(
        'Date'.padEnd(W.date) + 'Type'.padEnd(W.type) +
        'Description'.padEnd(W.desc) + 'Out'.padEnd(W.out) +
        'In'.padEnd(W.inn) + 'Balance'
    );
    console.log(sep);

    for (const tx of result.transactions) {
        console.log(
            (tx.date        || '').padEnd(W.date) +
            (tx.type        || '').slice(0, W.type - 1).padEnd(W.type) +
            (tx.description || '').slice(0, W.desc - 1).padEnd(W.desc) +
            (tx.moneyOut    || '').padEnd(W.out) +
            (tx.moneyIn     || '').padEnd(W.inn) +
            (tx.balance     || '')
        );
    }

    const totalOut = result.transactions.reduce((s, tx) => s + (parseFloat(tx.moneyOut || '0') || 0), 0);
    const totalIn  = result.transactions.reduce((s, tx) => s + (parseFloat(tx.moneyIn  || '0') || 0), 0);
    const net      = totalIn - totalOut;

    console.log(sep);
    console.log(
        'TOTAL'.padEnd(W.date + W.type + W.desc) +
        totalOut.toFixed(2).padEnd(W.out) +
        totalIn.toFixed(2).padEnd(W.inn) +
        `net ${net >= 0 ? '+' : ''}${net.toFixed(2)}`
    );

    const noDate = result.transactions.filter(tx => !tx.date);
    const noAmt  = result.transactions.filter(tx => !tx.moneyOut && !tx.moneyIn);
    if (noDate.length) console.warn(`\n⚠  ${noDate.length} row(s) missing date`);
    if (noAmt.length)  console.warn(`⚠  ${noAmt.length} row(s) missing amount`);
    if (!noDate.length && !noAmt.length) console.log('\n✓  All rows OK');
}

main().catch(err => { console.error(err); process.exit(1); });
