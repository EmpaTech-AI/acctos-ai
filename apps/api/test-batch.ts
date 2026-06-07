// Multi-file batch test: processes multiple PDFs together into one Excel output.
// Mirrors runBatchJob logic: classify → Azure DI (cached) → parse → sort → verify → categorize → Excel.
// Usage: npx tsx test-batch.ts <file1.pdf> <file2.pdf> [...]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { splitPdf } from './src/services/processing/PdfSplitter.js';
import { analyzePages } from './src/services/processing/AzureExtractor.js';
import { classify, detectBankFromContent } from './src/services/processing/DocumentClassifier.js';
import { Cell, ParsedTransaction, ParseResult } from './src/services/processing/parsers/shared.js';
import { computeVerification, applyCatVerification, logVerificationSummary } from './src/services/processing/Verification.js';
import { categorize } from './src/services/processing/AssistantCategorizer.js';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';

import { parse as parseHsbc }       from './src/services/processing/parsers/hsbc.js';
import { parse as parseRevolut }    from './src/services/processing/parsers/revolut.js';
import { parse as parseMonzo }      from './src/services/processing/parsers/monzo.js';
import { parse as parseWise }       from './src/services/processing/parsers/wise.js';
import { parse as parseStarling }   from './src/services/processing/parsers/starling.js';
import { parse as parseNatwest }    from './src/services/processing/parsers/natwest.js';
import { parse as parseNationwide } from './src/services/processing/parsers/nationwide.js';
import { parse as parseSantander }  from './src/services/processing/parsers/santander.js';
import { parse as parseBarclays }   from './src/services/processing/parsers/barclays.js';
import { parse as parseMetro }      from './src/services/processing/parsers/metro.js';
import { parse as parseLloyds }     from './src/services/processing/parsers/lloyds.js';
import { parse as parseTsb }        from './src/services/processing/parsers/tsb.js';
import { parse as parseTide }       from './src/services/processing/parsers/tide.js';
import { parse as parseRbs }        from './src/services/processing/parsers/rbs.js';
import { parse as parseVirginMoney } from './src/services/processing/parsers/virginmoney.js';
import { parse as parsePockit }     from './src/services/processing/parsers/pockit.js';
import { parse as parseMettle }     from './src/services/processing/parsers/mettle.js';
import { parse as parseZempler }    from './src/services/processing/parsers/zempler.js';
import { parse as parseGeneric }    from './src/services/processing/parsers/generic.js';

const filePaths = process.argv.slice(2);
if (filePaths.length < 1) {
    console.error('Usage: npx tsx test-batch.ts <file1.pdf> [file2.pdf] [...]');
    process.exit(1);
}

function getParser(bankType: string) {
    switch (bankType) {
        case 'hsbc':        return parseHsbc;
        case 'revolut':     return parseRevolut;
        case 'wise':        return parseWise;
        case 'starling':    return parseStarling;
        case 'natwest':     return parseNatwest;
        case 'rbs':         return parseRbs;
        case 'virginmoney': return parseVirginMoney;
        case 'pockit':      return parsePockit;
        case 'mettle':      return parseMettle;
        case 'nationwide':  return parseNationwide;
        case 'santander':   return parseSantander;
        case 'barclays':    return parseBarclays;
        case 'metro':       return parseMetro;
        case 'lloyds':      return parseLloyds;
        case 'tsb':         return parseTsb;
        case 'tide':        return parseTide;
        case 'zempler':     return parseZempler;
        default:            return parseGeneric;
    }
}

function parseTransactionDate(dateStr: string): number {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return 0;
    const [d, m, y] = parts.map(Number);
    return new Date(y, m - 1, d).getTime();
}

function sortTransactions(transactions: ParsedTransaction[], ascending = false): ParsedTransaction[] {
    const units: ParsedTransaction[][] = [];
    let i = 0;
    while (i < transactions.length) {
        if (!transactions[i].balance) {
            const block: ParsedTransaction[] = [transactions[i++]];
            while (i < transactions.length && !transactions[i].balance) block.push(transactions[i++]);
            if (i < transactions.length) block.push(transactions[i++]);
            units.push(block);
        } else {
            units.push([transactions[i++]]);
        }
    }
    units.sort((a, b) => {
        const diff = parseTransactionDate(b[b.length - 1].date) - parseTransactionDate(a[a.length - 1].date);
        return ascending ? -diff : diff;
    });
    return units.flat();
}

console.log(`\n=== Batch test: ${filePaths.length} files ===\n`);

const allTransactions: ParsedTransaction[] = [];
let confirmedBankType: string | null = null;
let combinedStatementTotals: { moneyIn: number; moneyOut: number } | undefined;
let ascending = false;

for (let fi = 0; fi < filePaths.length; fi++) {
    const filePath = filePaths[fi];
    const filename = filePath.split(/[\\/]/).pop()!;
    const cachePath = filePath.replace(/\.pdf(\.\w+)?$/i, '') + '.azure-cache.json';

    console.log(`\n--- File ${fi + 1}/${filePaths.length}: ${filename} ---`);

    const classification = classify(filename, 'application/pdf');
    let bankType = classification.bankType;

    // ── Azure DI — load from cache or fetch ───────────────────────────────────
    let pageData: Awaited<ReturnType<typeof analyzePages>>;

    if (existsSync(cachePath)) {
        console.log(`[Cache] ${cachePath}`);
        pageData = JSON.parse(readFileSync(cachePath, 'utf8'));
    } else {
        const fileBuffer = readFileSync(filePath);
        const pageBuffers = await splitPdf(fileBuffer);
        console.log(`Pages: ${pageBuffers.length} — calling Azure DI...`);
        pageData = await analyzePages(pageBuffers);
        writeFileSync(cachePath, JSON.stringify(pageData, null, 2));
        console.log(`[Cache] Saved to ${cachePath}`);
    }

    console.log('Azure DI:', pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`).join(', '));

    // ── Bank detection ─────────────────────────────────────────────────────────
    const combinedContent = pageData
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map(p => p.content).join(' ');

    if (bankType === 'generic') {
        const detected = detectBankFromContent(combinedContent);
        if (detected !== 'generic') {
            bankType = detected;
            console.log(`Bank detected from content: ${bankType}`);
        } else if (confirmedBankType) {
            bankType = confirmedBankType;
            console.log(`Reusing confirmed bank: ${bankType}`);
        }
    }
    if (bankType !== 'generic' && !confirmedBankType) confirmedBankType = bankType;
    console.log(`Bank: ${bankType}`);

    // ── Merge pages + parse ────────────────────────────────────────────────────
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

    // Monzo needs page-by-page parsing for cross-page pending rows
    let parseResult: ParseResult;
    if (bankType === 'monzo') {
        const txns: ParsedTransaction[] = [];
        let pendingRow = null as ParsedTransaction | null | undefined;
        for (const p of pageData) {
            if (!p) continue;
            const pageCells: Cell[] = [{ rowIndex: -1, columnIndex: -1, content: combinedContent }, ...p.cells];
            const res = parseMonzo(pageCells, { pendingFromPrev: pendingRow });
            txns.push(...res.transactions);
            pendingRow = res.pendingRow;
        }
        if (pendingRow) txns.push(pendingRow);
        parseResult = { transactions: txns };
    } else {
        parseResult = getParser(bankType)(combined);
    }

    const { transactions: fileTransactions, statementTotals, ascending: fileAscending } = parseResult;
    if (fileAscending) ascending = true;

    console.log(`Parsed ${fileTransactions.length} transactions`);
    if (statementTotals) {
        console.log(`Declared — In: ${statementTotals.moneyIn.toFixed(2)}  Out: ${statementTotals.moneyOut.toFixed(2)}`);
        if (!combinedStatementTotals) combinedStatementTotals = { ...statementTotals };
        else { combinedStatementTotals.moneyIn += statementTotals.moneyIn; combinedStatementTotals.moneyOut += statementTotals.moneyOut; }
    }

    allTransactions.push(...fileTransactions);
}

console.log(`\n=== Combined: ${allTransactions.length} transactions total ===`);

const sorted = sortTransactions(allTransactions, ascending);

console.log('\nFirst 5 (after sort):');
sorted.slice(0, 5).forEach((t, i) =>
    console.log(`  [${i+1}] ${t.date} | ${t.type.padEnd(16)} | ${t.description.slice(0, 35).padEnd(35)} | out:${(t.moneyOut||'').padStart(10)} in:${(t.moneyIn||'').padStart(10)} bal:${t.balance}`)
);
console.log('\nLast 3 (after sort):');
sorted.slice(-3).forEach((t, i) =>
    console.log(`  [${sorted.length - 2 + i}] ${t.date} | ${t.type.padEnd(16)} | ${t.description.slice(0, 35).padEnd(35)} | out:${(t.moneyOut||'').padStart(10)} in:${(t.moneyIn||'').padStart(10)} bal:${t.balance}`)
);

const totalIn  = sorted.reduce((s, t) => s + (parseFloat(t.moneyIn  || '0') || 0), 0);
const totalOut = sorted.reduce((s, t) => s + (parseFloat(t.moneyOut || '0') || 0), 0);
console.log(`\nTotals — Money In: ${totalIn.toFixed(2)}  Money Out: ${totalOut.toFixed(2)}`);
if (combinedStatementTotals) {
    console.log(`Declared combined — In: ${combinedStatementTotals.moneyIn.toFixed(2)}  Out: ${combinedStatementTotals.moneyOut.toFixed(2)}`);
}

const verification = computeVerification(sorted, combinedStatementTotals, ascending);
if (verification) {
    console.log('\nTotals verification:');
    logVerificationSummary(verification);
}

console.log('\nRunning categorization...');
const categorized = await categorize(sorted);
if (verification) applyCatVerification(verification, categorized);

console.log('\nFirst 5 categorized:');
categorized.slice(0, 5).forEach((t, i) =>
    console.log(`  [${i+1}] ${t.DATE} | ${(t['Type and Description']||'').slice(0,45).padEnd(45)} | INCOME:${(t.INCOME||'').padStart(10)} OTHER:${(t.OTHER||'').padStart(10)} bal:${t.Balance}`)
);

if (verification) {
    console.log('\nPost-categorization verification:');
    logVerificationSummary(verification);
}

const outputBuffer = await buildPdfOutputExcel(categorized, verification);
const firstFile = filePaths[0];
const outPath = firstFile.replace(/[\\/][^\\/]+$/, '') + '\\batch_processed.xlsx';
writeFileSync(outPath, outputBuffer);
console.log(`\nOutput saved: ${outPath}`);
