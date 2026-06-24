/**
 * Batch process all PDFs in a folder → one combined Excel, sorted by date.
 * Run with: npx tsx batch-process-folder.ts "<folder path>"
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// Load .env
const envLines = readFileSync(join(import.meta.dirname, '.env'), 'utf8').split('\n');
for (const line of envLines) {
    const m = line.match(/^([^=]+)="?([^"]*)"?\s*$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
}

import { detectBankFromContent } from './src/services/processing/DocumentClassifier.js';
import { categorize } from './src/services/processing/AssistantCategorizer.js';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';
import { computeVerification, applyCatVerification, computeChainVerification } from './src/services/processing/Verification.js';
import { Cell, ParseResult, ParsedTransaction, parseMoney } from './src/services/processing/parsers/shared.js';
import { FileSummary } from './src/services/processing/JobStore.js';
import { parse as parseNationwide } from './src/services/processing/parsers/nationwide.js';
import { parse as parseSantander } from './src/services/processing/parsers/santander.js';
import { parse as parseBarclays } from './src/services/processing/parsers/barclays.js';
import { parse as parseBarclaysBusiness } from './src/services/processing/parsers/barclays-business.js';
import { parse as parseHsbc } from './src/services/processing/parsers/hsbc.js';
import { parse as parseMonese } from './src/services/processing/parsers/monese.js';

const FOLDER = process.argv[2];
if (!FOLDER) { console.error('Usage: npx tsx batch-process-folder.ts "<folder>"\n'); process.exit(1); }

function getParser(bank: string): ((cells: Cell[]) => ParseResult) | null {
    switch (bank) {
        case 'nationwide': return parseNationwide;
        case 'santander':  return parseSantander;
        case 'barclays':          return parseBarclays;
        case 'barclays-business': return parseBarclaysBusiness;
        case 'hsbc':              return parseHsbc;
        case 'monese':            return parseMonese;
        default:           return null;
    }
}

// DD/MM/YYYY → sortable number YYYYMMDD
function dateToSortKey(d: string): number {
    if (!d) return 0;
    const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return 0;
    return parseInt(`${m[3]}${m[2]}${m[1]}`);
}

interface FileResult {
    filename: string;
    bank: string;
    transactions: ParsedTransaction[];
    ascending: boolean;
    statementTotals?: { moneyIn: number; moneyOut: number; openingBalance?: number; closingBalance?: number };
}

async function parseFile(pdfPath: string): Promise<FileResult | null> {
    const base = pdfPath.replace(/\.pdf$/, '');
    const cachePath = base + '.azure-cache.json';
    if (!existsSync(cachePath)) return null;

    const pages: any[] = JSON.parse(readFileSync(cachePath, 'utf8'));
    const cells: Cell[] = [{ rowIndex: -1, columnIndex: -1, content: '' }];
    let rowOffset = 0;
    for (const page of pages) {
        if (!page) continue;
        let maxRow = -1;
        for (const cell of page.cells) {
            cells.push({ ...cell, rowIndex: cell.rowIndex + rowOffset });
            if (cell.rowIndex > maxRow) maxRow = cell.rowIndex;
        }
        if (maxRow >= 0) rowOffset += maxRow + 10000;
    }

    const allText = pages.map((p: any) => (p?.cells ?? []).map((c: any) => c.content).join(' ')).join(' ');
    const bank = detectBankFromContent(allText) ?? 'unknown';
    const parser = getParser(bank);
    if (!parser) {
        console.log(`  [${basename(pdfPath)}] SKIP — no parser for bank: ${bank}`);
        return null;
    }

    const { transactions, statementTotals, ascending } = parser(cells);
    return { filename: basename(pdfPath), bank, transactions, ascending: ascending ?? false, statementTotals };
}

// Files to exclude by name (duplicates etc). Case-insensitive basename match.
const EXCLUDE_FILES = ['pdf (21).pdf.pdf'];

// Find all PDFs with caches (files stored as name.pdf.pdf, cache as name.pdf.azure-cache.json)
const pdfFiles = readdirSync(FOLDER)
    .filter(f => f.endsWith('.pdf.pdf'))
    .filter(f => !EXCLUDE_FILES.some(ex => ex.toLowerCase() === f.toLowerCase()))
    .map(f => join(FOLDER, f))
    .filter(p => existsSync(p.replace(/\.pdf$/, '.azure-cache.json')))
    .sort();

console.log(`Found ${pdfFiles.length} cached PDFs in: ${FOLDER}\n`);

// Step 1: Parse all files
const fileResults: FileResult[] = [];
for (const pdf of pdfFiles) {
    process.stdout.write(`  Parsing ${basename(pdf)}... `);
    const result = await parseFile(pdf);
    if (result) {
        console.log(`${result.bank}  ${result.transactions.length} txns`);
        fileResults.push(result);
    }
}

if (!fileResults.length) { console.error('No parseable files found.'); process.exit(1); }

// Step 2: Combine and sort all transactions chronologically (oldest first)
const allTransactions: ParsedTransaction[] = fileResults.flatMap(r => {
    // Santander returns newest-first (ascending=false) — reverse to get oldest-first
    const txns = r.ascending ? r.transactions : [...r.transactions].reverse();
    return txns;
});
allTransactions.sort((a, b) => dateToSortKey(a.date) - dateToSortKey(b.date));

console.log(`\nCombined: ${allTransactions.length} transactions across ${fileResults.length} files`);

// Step 3: Build file summaries for verification sidebar
const fileSummaries: FileSummary[] = fileResults.map(r => {
    const parsedIn  = r.transactions.reduce((s, t) => s + (parseMoney(t.moneyIn)  ?? 0), 0);
    const parsedOut = r.transactions.reduce((s, t) => s + (parseMoney(t.moneyOut) ?? 0), 0);
    return {
        filename:        r.filename,
        transactions:    r.transactions.length,
        parsedIn,
        parsedOut,
        declaredIn:      r.statementTotals?.moneyIn,
        declaredOut:     r.statementTotals?.moneyOut,
        openingBalance:  r.statementTotals?.openingBalance,
        closingBalance:  r.statementTotals?.closingBalance,
    };
});

// Step 4: Combined verification (sum of all declared totals that have them)
const totalParsedIn  = fileSummaries.reduce((s, f) => s + f.parsedIn,  0);
const totalParsedOut = fileSummaries.reduce((s, f) => s + f.parsedOut, 0);
const declared = fileSummaries.some(f => f.declaredIn != null) ? {
    moneyIn:  fileSummaries.reduce((s, f) => s + (f.declaredIn  ?? 0), 0),
    moneyOut: fileSummaries.reduce((s, f) => s + (f.declaredOut ?? 0), 0),
} : undefined;

const verification = computeVerification(allTransactions, declared, true /* ascending after sort */);

// ── NOTIFICATION HOOK ──────────────────────────────────────────────────────
// TODO: Wire up email / webhook when notification service is connected.
//
// Two conditions should trigger an alert to the operator:
//
// 1. Per-file failure — our parser or categorizer produced wrong totals for
//    at least one file (parsedIn/Out ≠ declaredIn/Out, or balance equation
//    openingBalance + parsedIn − parsedOut ≠ closingBalance).
//
//    const EPS = 0.02;
//    function isFileFailed(f: FileSummary): boolean {
//        if (f.declaredIn != null && f.declaredOut != null)
//            return Math.abs(f.parsedIn - f.declaredIn)  > EPS
//                || Math.abs(f.parsedOut - f.declaredOut) > EPS;
//        if (f.openingBalance != null && f.closingBalance != null)
//            return Math.abs(f.openingBalance + f.parsedIn - f.parsedOut - f.closingBalance) > EPS;
//        return false;
//    }
//    const failedFiles = fileSummaries.filter(isFileFailed);
//    if (failedFiles.length > 0) {
//        await sendAlert({ type: 'per_file_failure', failedFiles, folder: FOLDER });
//    }
//
// 2. Chain gap — every individual file is correct, but the first opening balance
//    + totalIn − totalOut ≠ last closing balance.  This means the client omitted
//    one or more statement files and we should notify the client contact.
//
//    const chain = computeChainVerification(fileSummaries, totalParsedIn, totalParsedOut);
//    if (chain && !chain.ok) {
//        await sendAlert({
//            type: 'chain_gap',
//            diff: chain.diff,          // e.g. −1250.00 → missing ~£1 250 of movement
//            chainOpen: chain.chainOpeningBalance,
//            chainClose: chain.chainClosingBalance,
//            folder: FOLDER,
//        });
//    }
//
// sendAlert() shape (implement in src/services/notifications/):
//   export async function sendAlert(payload: AlertPayload): Promise<void> {
//       // e.g. nodemailer / SendGrid / Resend / Slack webhook
//   }
// ──────────────────────────────────────────────────────────────────────────

// Step 5: Categorize combined transactions
console.log(`\nCategorizing ${allTransactions.length} transactions...`);
const categorized = await categorize(allTransactions);

if (verification) applyCatVerification(verification, categorized);

// Step 6: Build one Excel file
console.log('\nBuilding Excel...');
const buffer = await buildPdfOutputExcel(categorized, verification, fileSummaries);

const outName = `${fileResults.length}_files_processed.xlsx`;
const outPath = join(FOLDER, outName);
writeFileSync(outPath, buffer);
console.log(`\n✓ Saved: ${outPath}`);
console.log(`  Total transactions: ${allTransactions.length}`);
console.log(`  Money in:  ${totalParsedIn.toFixed(2)}`);
console.log(`  Money out: ${totalParsedOut.toFixed(2)}`);
