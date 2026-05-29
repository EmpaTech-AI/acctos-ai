/**
 * Metro Bank parser test — processes a real PDF via Azure DI (cached).
 * Results saved as _processed.xlsx next to the PDF.
 *
 * Usage (from apps/api/):
 *   npx tsx test-metro.ts "<path-to-metro-pdf>"
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { splitPdf } from './src/services/processing/PdfSplitter.js';
import { analyzePage } from './src/services/processing/AzureExtractor.js';
import { parse } from './src/services/processing/parsers/metro.js';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';
import type { Cell } from './src/services/processing/parsers/shared.js';
import type { CategorizedTransaction } from './src/services/processing/AssistantCategorizer.js';

const pdfPath = process.argv[2];
if (!pdfPath) { console.error('Usage: npx tsx test-metro.ts "<path-to-pdf>"'); process.exit(1); }

const cachePath = pdfPath + '.azure-cache.json';

async function main() {
    console.log(`\nPDF: ${path.basename(pdfPath)}`);

    // ── Azure DI (with cache) ──────────────────────────────────────────────
    let pageCells: Cell[][];

    if (existsSync(cachePath)) {
        console.log('Using cached Azure DI results…');
        pageCells = JSON.parse(readFileSync(cachePath, 'utf-8'));
    } else {
        console.log('Splitting PDF into pages…');
        const pages = await splitPdf(readFileSync(pdfPath));
        console.log(`${pages.length} page(s) — calling Azure DI…`);
        pageCells = [];
        for (let i = 0; i < pages.length; i++) {
            process.stdout.write(`  Page ${i + 1}/${pages.length}… `);
            const data = await analyzePage(pages[i]);
            pageCells.push(data.cells);
            console.log(`${data.cells.length} cells`);
        }
        writeFileSync(cachePath, JSON.stringify(pageCells));
        console.log('Cache saved.');
    }

    // ── Merge pages (offset rows to avoid collisions) ──────────────────────
    const combined: Cell[] = [];
    let rowOffset = 0;
    for (const cells of pageCells) {
        let pageMax = -1;
        for (const c of cells) {
            combined.push({ ...c, rowIndex: c.rowIndex + rowOffset });
            if (c.rowIndex > pageMax) pageMax = c.rowIndex;
        }
        if (pageMax >= 0) rowOffset += pageMax + 10000;
    }

    // ── Parse ──────────────────────────────────────────────────────────────
    const result = parse(combined);
    const txns = result.transactions;

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
        'Type and Description': [t.type, t.description].filter(Boolean).join(' '),
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
