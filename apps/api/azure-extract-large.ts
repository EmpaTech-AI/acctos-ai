/**
 * azure-extract-large.ts
 *
 * Splits a large PDF into N-page chunks, extracts each with Azure DI,
 * and saves a manifest so batch-process-folder knows the parser and totals.
 *
 * Usage:
 *   npx tsx azure-extract-large.ts "<dir>" "<filename.pdf.pdf>" <parser> [chunkSize=20]
 *
 * Example:
 *   npx tsx azure-extract-large.ts "C:\...\whole file 2022-2024" \
 *     "Monese Statement 01 April 2022 - 31 March 2024.pdf.pdf" monese 20
 *
 * Output:
 *   <dir>/<base>_part01.pdf.pdf          ← split PDF chunk (persisted)
 *   <dir>/<base>_part01.pdf.azure-cache.json
 *   ...
 *   <dir>/_manifest.json                 ← parser + declared totals
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const envLines = readFileSync(join(import.meta.dirname, '.env'), 'utf8').split('\n');
for (const line of envLines) {
    const m = line.match(/^([^=]+)="?([^"]*)"?\s*$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
}

import { splitIntoChunks } from './src/services/processing/PdfSplitter.js';
import { analyzePages } from './src/services/processing/AzureExtractor.js';

const DIR        = process.argv[2];
const FILE       = process.argv[3];
const PARSER     = process.argv[4] ?? 'unknown';
const CHUNK_SIZE = parseInt(process.argv[5] ?? '20', 10);

if (!DIR || !FILE) {
    console.error('Usage: npx tsx azure-extract-large.ts "<dir>" "<file.pdf.pdf>" <parser> [chunkSize=20]');
    process.exit(1);
}

const pdfPath = join(DIR, FILE);
if (!existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`);
    process.exit(1);
}

// Base name without the trailing ".pdf" (the double-extension pattern)
// e.g. "Monese Statement ... 2024.pdf.pdf" → "Monese Statement ... 2024.pdf"
const base = FILE.replace(/\.pdf$/, '');

console.log(`\nPDF:    ${FILE}`);
console.log(`Parser: ${PARSER}`);
console.log(`Chunks: ${CHUNK_SIZE} pages each\n`);

const pdfBuffer = readFileSync(pdfPath);
const chunks    = await splitIntoChunks(pdfBuffer, CHUNK_SIZE);
const totalChunks = chunks.length;
console.log(`Split into ${totalChunks} chunks.\n`);

const partFiles: string[] = [];

for (let i = 0; i < totalChunks; i++) {
    const partNum    = String(i + 1).padStart(2, '0');
    const partName   = `${base}_part${partNum}.pdf.pdf`;
    const partPath   = join(DIR, partName);
    const cacheName  = `${base}_part${partNum}.pdf.azure-cache.json`;
    const cachePath  = join(DIR, cacheName);

    partFiles.push(partName);

    if (existsSync(cachePath)) {
        console.log(`SKIP (cached): ${partName}`);
        continue;
    }

    // Save split PDF to disk so batch-process-folder.ts can find it later
    if (!existsSync(partPath)) {
        writeFileSync(partPath, chunks[i]);
        console.log(`Saved split PDF: ${partName}`);
    }

    console.log(`Extracting chunk ${i + 1}/${totalChunks}: ${partName} ...`);
    const pageData = await analyzePages([chunks[i]]);
    writeFileSync(cachePath, JSON.stringify(pageData, null, 2));
    console.log(`  → cached: ${cacheName}`);
}

// Write/update manifest
const manifestPath = join(DIR, '_manifest.json');
let manifest: any = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
manifest.parser    = PARSER;
manifest.parts     = partFiles;
manifest.chunkSize = CHUNK_SIZE;
manifest.sourceFile = FILE;
// declaredIn / declaredOut can be filled in manually or by a totals-extraction pass
if (!manifest.declaredIn)  manifest.declaredIn  = null;
if (!manifest.declaredOut) manifest.declaredOut = null;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\nManifest saved: _manifest.json`);
console.log(`  parser:     ${manifest.parser}`);
console.log(`  parts:      ${partFiles.length}`);
console.log(`  declaredIn: ${manifest.declaredIn ?? '(fill in manually)'}`);
console.log(`  declaredOut: ${manifest.declaredOut ?? '(fill in manually)'}`);
console.log('\nDone. Now run: npx tsx batch-process-folder.ts "<dir>"');
