// Quick parser test: reads the NatWest PDF, runs full pipeline, saves Excel output.
// Azure DI results are cached to <pdf>.azure-cache.json to skip re-processing.
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { splitPdf } from './src/services/processing/PdfSplitter.js';
import { analyzePages } from './src/services/processing/AzureExtractor.js';
import { classify } from './src/services/processing/DocumentClassifier.js';
import { parse as parseNatwest } from './src/services/processing/parsers/natwest.js';
import { Cell } from './src/services/processing/parsers/shared.js';
import { categorize } from './src/services/processing/AssistantCategorizer.js';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: npx tsx test-natwest.ts <path-to-pdf>'); process.exit(1); }

const fileBuffer = readFileSync(filePath);
const filename = filePath.split(/[\\/]/).pop()!;
const cachePath = filePath.replace(/\.pdf(\.\w+)?$/i, '') + '.azure-cache.json';

console.log(`\n=== Testing: ${filename} ===\n`);

const classification = classify(filename, 'application/pdf');
console.log('Classification:', classification);

// ── Azure DI — load from cache or fetch ──────────────────────────────────────
let pageData: Awaited<ReturnType<typeof analyzePages>>;

if (existsSync(cachePath)) {
    console.log(`[Cache] Loading Azure results from ${cachePath}`);
    pageData = JSON.parse(readFileSync(cachePath, 'utf8'));
    console.log('Azure DI results (cached):', pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`).join(', '));
} else {
    const pageBuffers = await splitPdf(fileBuffer);
    console.log(`Pages: ${pageBuffers.length}`);
    pageData = await analyzePages(pageBuffers);
    console.log('Azure DI results:', pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`).join(', '));
    writeFileSync(cachePath, JSON.stringify(pageData, null, 2));
    console.log(`[Cache] Saved to ${cachePath}`);
}

const combinedContent = pageData
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(p => p.content).join(' ');

// Debug: show raw cells from page 1 (first 60 cells, rows 0-5)
if (pageData[0]) {
    const p1cells = pageData[0].cells.filter(c => c.rowIndex <= 5).sort((a,b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex);
    console.log('\n--- Page 1 raw cells (rows 0-5) ---');
    for (const c of p1cells) {
        console.log(`  row${c.rowIndex} col${c.columnIndex}: "${c.content}"`);
    }
    console.log('---\n');
}

// Merge all pages with row offsets (same logic as Orchestrator)
const combined: Cell[] = [{ rowIndex: -1, columnIndex: -1, content: combinedContent }];
let rowOffset = 0;
for (const p of pageData) {
    if (!p) continue;
    let pageMaxRow = -1;
    for (const c of p.cells) {
        combined.push({ ...c, rowIndex: c.rowIndex + rowOffset });
        if (c.rowIndex > pageMaxRow) pageMaxRow = c.rowIndex;
    }
    if (pageMaxRow >= 0) rowOffset += pageMaxRow + 10000;
}

const { transactions } = parseNatwest(combined);
console.log(`\nParsed ${transactions.length} transactions`);

if (transactions.length > 0) {
    console.log('\nFirst 5:');
    transactions.slice(0, 5).forEach((t, i) =>
        console.log(`  [${i+1}] ${t.date} | ${t.description.slice(0, 45).padEnd(45)} | out:${(t.moneyOut||'').padStart(10)} in:${(t.moneyIn||'').padStart(10)} bal:${t.balance}`)
    );
    console.log('\nLast 3:');
    transactions.slice(-3).forEach((t, i) =>
        console.log(`  [${transactions.length - 2 + i}] ${t.date} | ${t.description.slice(0, 45).padEnd(45)} | out:${(t.moneyOut||'').padStart(10)} in:${(t.moneyIn||'').padStart(10)} bal:${t.balance}`)
    );
}

console.log('\nRunning categorization...');
const categorized = await categorize(transactions);
console.log('\nFirst 5 categorized:');
categorized.slice(0, 5).forEach((t, i) =>
    console.log(`  [${i+1}] ${t.DATE} | ${(t['Type and Description']||'').slice(0,40).padEnd(40)} | INCOME:${(t.INCOME||'').padStart(10)} OTHER:${(t.OTHER||'').padStart(10)} bal:${t.Balance}`)
);
const outputBuffer = await buildPdfOutputExcel(categorized);
const outPath = filePath.replace(/\.pdf(\.\w+)?$/i, '') + '_processed.xlsx';
writeFileSync(outPath, outputBuffer);
console.log(`\nOutput saved: ${outPath}`);
