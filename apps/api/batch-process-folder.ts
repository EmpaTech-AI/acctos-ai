/**
 * Batch process all PDFs in a folder → one combined Excel, sorted by date.
 * Run with: npx tsx batch-process-folder.ts "<folder path>" [vat]
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
import { buildPdfOutputExcel, buildVatOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';
import { computeVerification, applyCatVerification, computeChainVerification } from './src/services/processing/Verification.js';
import { Cell, ParseResult, ParsedTransaction, parseMoney } from './src/services/processing/parsers/shared.js';
import { FileSummary } from './src/services/processing/JobStore.js';
import { parse as parseNationwide } from './src/services/processing/parsers/nationwide.js';
import { parse as parseSantander } from './src/services/processing/parsers/santander.js';
import { parse as parseBarclays } from './src/services/processing/parsers/barclays.js';
import { parse as parseBarclaysBusiness } from './src/services/processing/parsers/barclays-business.js';
import { parse as parseHsbc } from './src/services/processing/parsers/hsbc.js';
import { parse as parseMonese } from './src/services/processing/parsers/monese.js';
import { parse as parseNatwest } from './src/services/processing/parsers/natwest.js';
import { parse as parseRevolut } from './src/services/processing/parsers/revolut.js';

const FOLDER = process.argv[2];
const MODE   = process.argv[3] === 'vat' ? 'vat' : 'bank_statement';
if (!FOLDER) { console.error('Usage: npx tsx batch-process-folder.ts "<folder>" [vat]\n'); process.exit(1); }

function getParser(bank: string): ((cells: Cell[]) => ParseResult) | null {
    switch (bank) {
        case 'nationwide': return parseNationwide;
        case 'santander':  return parseSantander;
        case 'barclays':          return parseBarclays;
        case 'barclays-business': return parseBarclaysBusiness;
        case 'hsbc':              return parseHsbc;
        case 'monese':            return parseMonese;
        case 'natwest':           return parseNatwest;
        case 'revolut':           return parseRevolut;
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

// Parse statement date from filename → sortable YYYYMMDD key.
// Supports multiple bank filename formats for chronological chain ordering.
const STMT_MONTH: Record<string, number> = {
    JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12,
};
function statementDateKey(filename: string): number {
    let m: RegExpMatchArray | null;
    // Barclays: "Statement 09-MAY-25 AC..."
    m = filename.match(/Statement\s+(\d{1,2})-([A-Za-z]{3})-(\d{2})\b/i);
    if (m) {
        const mon = STMT_MONTH[m[2].toUpperCase()] ?? 0;
        return (2000 + parseInt(m[3])) * 10000 + mon * 100 + parseInt(m[1]);
    }
    // Nationwide: "Statement_601312_42734746_04_Jul_2025"
    m = filename.match(/_(\d{1,2})_([A-Za-z]{3})_(\d{4})(?:\.|$)/i);
    if (m) {
        const mon = STMT_MONTH[m[2].toUpperCase()] ?? 0;
        return parseInt(m[3]) * 10000 + mon * 100 + parseInt(m[1]);
    }
    // Nationwide date-range: "--05-04-2025-06-05-2025" → use end date (DD-MM-YYYY)
    m = filename.match(/--(\d{2}-\d{2}-\d{4})-(\d{2}-\d{2}-\d{4})/);
    if (m) {
        const p = m[2].split('-');
        return parseInt(p[2]) * 10000 + parseInt(p[1]) * 100 + parseInt(p[0]);
    }
    return 0;
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
    // Combine all page content for the synthetic context cell (same as ProcessingOrchestrator)
    const combinedContent = pages
        .filter(Boolean)
        .map((p: any) => p.content ?? (p.cells ?? []).map((c: any) => c.content).join(' '))
        .join(' ');
    const cells: Cell[] = [{ rowIndex: -1, columnIndex: -1, content: combinedContent }];
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

    const allText = combinedContent;
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

// Sort fileResults chronologically by statement date (for correct chain continuity check).
// Transaction output is sorted separately below; this only affects fileSummaries order.
fileResults.sort((a, b) => statementDateKey(a.filename) - statementDateKey(b.filename));

// Step 2: Combine and sort all transactions chronologically (oldest first)
const allTransactions: ParsedTransaction[] = fileResults.flatMap(r => {
    // Santander returns newest-first (ascending=false) — reverse to get oldest-first
    const txns = r.ascending ? r.transactions : [...r.transactions].reverse();
    return txns;
});
allTransactions.sort((a, b) => dateToSortKey(a.date) - dateToSortKey(b.date));

console.log(`\nCombined: ${allTransactions.length} transactions across ${fileResults.length} files`);

// Step 3: Build file summaries for verification sidebar
//
// Chunked-file detection: when all files are parts of the same base document
// (e.g. _part01.pdf.pdf … _part10.pdf.pdf), the "Total Money In/Out" printed
// on the statement header covers the WHOLE document, not a single chunk.
// The parser finds those declared totals in whichever chunk contains the
// header page — comparing that chunk's transactions alone against the whole-
// document total would always fail.  Instead, lift the declared totals to the
// combined level only, and leave individual part summaries without them.
const PART_RE = /^(.+)_part\d{2}\.pdf\.pdf$/i;
const partBases = fileResults.map(r => PART_RE.exec(r.filename)?.[1]);
const isChunkedFile = partBases.every(b => b != null) && new Set(partBases).size === 1;

// For a chunked file, collect whole-document totals from all parts
// (only one chunk will have them) and suppress them at the part level.
// Opening/closing balance are also per-document, not per-chunk — suppress
// those too so the per-file check doesn't compare a 20-page chunk against
// the 2-year opening/closing balance.
let combinedDeclaredIn:   number | undefined;
let combinedDeclaredOut:  number | undefined;
let combinedOpeningBal:   number | undefined;
let combinedClosingBal:   number | undefined;
if (isChunkedFile) {
    for (const r of fileResults) {
        if (r.statementTotals?.moneyIn        != null) combinedDeclaredIn  = r.statementTotals.moneyIn;
        if (r.statementTotals?.moneyOut       != null) combinedDeclaredOut = r.statementTotals.moneyOut;
        if (r.statementTotals?.openingBalance != null) combinedOpeningBal  = r.statementTotals.openingBalance;
        if (r.statementTotals?.closingBalance != null) combinedClosingBal  = r.statementTotals.closingBalance;
    }
}

const fileSummaries: FileSummary[] = fileResults.map(r => {
    const parsedIn  = r.transactions.reduce((s, t) => s + (parseMoney(t.moneyIn)  ?? 0), 0);
    const parsedOut = r.transactions.reduce((s, t) => s + (parseMoney(t.moneyOut) ?? 0), 0);
    return {
        filename:        r.filename,
        transactions:    r.transactions.length,
        parsedIn,
        parsedOut,
        // For chunked files all statement-level values belong to the whole
        // document — suppress them at part level to avoid misleading per-file
        // failures (a 20-page chunk vs. a 2-year declared total).
        declaredIn:      isChunkedFile ? undefined : r.statementTotals?.moneyIn,
        declaredOut:     isChunkedFile ? undefined : r.statementTotals?.moneyOut,
        openingBalance:  isChunkedFile ? undefined : r.statementTotals?.openingBalance,
        closingBalance:  isChunkedFile ? undefined : r.statementTotals?.closingBalance,
    };
});

// Step 4: Combined verification
const totalParsedIn  = fileSummaries.reduce((s, f) => s + f.parsedIn,  0);
const totalParsedOut = fileSummaries.reduce((s, f) => s + f.parsedOut, 0);

// For a chunked file use the lifted whole-document totals; otherwise sum
// whatever individual files declared.
const declared = isChunkedFile
    ? (combinedDeclaredIn != null ? {
        moneyIn:        combinedDeclaredIn,
        moneyOut:       combinedDeclaredOut ?? 0,
        openingBalance: combinedOpeningBal,
        closingBalance: combinedClosingBal,
    } : undefined)
    : (fileSummaries.some(f => f.declaredIn != null) ? {
        moneyIn:  fileSummaries.reduce((s, f) => s + (f.declaredIn  ?? 0), 0),
        moneyOut: fileSummaries.reduce((s, f) => s + (f.declaredOut ?? 0), 0),
    } : undefined);

const verification = computeVerification(allTransactions, declared, true /* ascending after sort */);

// ── Notifications ─────────────────────────────────────────────────────────────
// NotificationService is already wired for the API (ProcessingOrchestrator.ts).
// Import it here if this script needs the same alerts in CLI mode:
//
//   import { notifyParserError, notifyChainGap } from './src/services/processing/NotificationService.js';
//   ... (same logic as in ProcessingOrchestrator)
//
// Set ALERT_TEAM_WEBHOOK_URL / ALERT_CLIENT_WEBHOOK_URL env vars to receive alerts.
// ─────────────────────────────────────────────────────────────────────────────

// Step 5: Categorize combined transactions
console.log(`\nCategorizing ${allTransactions.length} transactions...`);
const categorized = await categorize(allTransactions);

if (verification) applyCatVerification(verification, categorized);

// Step 6: Build one Excel file
console.log('\nBuilding Excel...');
const buffer = MODE === 'vat'
    ? await buildVatOutputExcel(categorized, basename(FOLDER))
    : await buildPdfOutputExcel(categorized, verification, fileSummaries);

const outName = `${fileResults.length}_files_processed_${MODE}.xlsx`;
const outPath = join(FOLDER, outName);
writeFileSync(outPath, buffer);
console.log(`\n✓ Saved: ${outPath}`);
console.log(`  Total transactions: ${allTransactions.length}`);
console.log(`  Money in:  ${totalParsedIn.toFixed(2)}`);
console.log(`  Money out: ${totalParsedOut.toFixed(2)}`);
