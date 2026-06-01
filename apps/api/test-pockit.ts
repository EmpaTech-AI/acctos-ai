// Quick parser test: reads one or more Pockit PDFs, runs full pipeline, saves Excel output.
// Azure DI results are cached to <pdf>.azure-cache.json to skip re-processing.
// Usage: npx tsx test-pockit.ts <file1.pdf> [file2.pdf] ...
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { splitPdf } from './src/services/processing/PdfSplitter.js';
import { analyzePages } from './src/services/processing/AzureExtractor.js';
import { classify } from './src/services/processing/DocumentClassifier.js';
import { parse as parsePockit } from './src/services/processing/parsers/pockit.js';
import { Cell, ParsedTransaction, parseMoney } from './src/services/processing/parsers/shared.js';

function logTotalsVerification(
    transactions: ParsedTransaction[],
    declared?: { moneyIn: number; moneyOut: number },
): void {
    if (!transactions.length) return;
    const totalIn  = transactions.reduce((s, t) => s + (parseFloat(t.moneyIn  || '0') || 0), 0);
    const totalOut = transactions.reduce((s, t) => s + (parseFloat(t.moneyOut || '0') || 0), 0);

    if (declared) {
        const inDiff  = totalIn  - declared.moneyIn;
        const outDiff = totalOut - declared.moneyOut;
        if (Math.abs(inDiff) > 0.02 || Math.abs(outDiff) > 0.02) {
            console.warn(`  [TotalsCheck] MISMATCH vs declared — In: computed=${totalIn.toFixed(2)} declared=${declared.moneyIn.toFixed(2)} (diff=${inDiff.toFixed(2)}), Out: computed=${totalOut.toFixed(2)} declared=${declared.moneyOut.toFixed(2)} (diff=${outDiff.toFixed(2)})`);
        } else {
            console.log(`  [TotalsCheck] Declared totals match — In: ${totalIn.toFixed(2)}, Out: ${totalOut.toFixed(2)} ✓`);
        }
    }

    const first = transactions[0];
    const last  = transactions[transactions.length - 1];
    const closingBal = parseMoney(first.balance);
    const oldestBal  = parseMoney(last.balance);
    if (closingBal !== null && oldestBal !== null) {
        const lastIn  = parseMoney(last.moneyIn)  ?? 0;
        const lastOut = parseMoney(last.moneyOut) ?? 0;
        const openingBal      = oldestBal - lastIn + lastOut;
        const expectedClosing = openingBal + totalIn - totalOut;
        if (Math.abs(expectedClosing - closingBal) > 0.02) {
            console.warn(`  [TotalsCheck] Balance gap — opening: ${openingBal.toFixed(2)} + in: ${totalIn.toFixed(2)} - out: ${totalOut.toFixed(2)} = ${expectedClosing.toFixed(2)}, actual closing: ${closingBal.toFixed(2)} (diff=${(closingBal - expectedClosing).toFixed(2)})`);
        } else {
            console.log(`  [TotalsCheck] Balance continuity OK — opening: ${openingBal.toFixed(2)}, closing: ${closingBal.toFixed(2)} ✓`);
        }
    }
}
import { categorize } from './src/services/processing/AssistantCategorizer.js';
import { buildPdfOutputExcel } from './src/services/processing/ExcelOutputBuilder.js';

const filePaths = process.argv.slice(2);
if (!filePaths.length) {
    console.error('Usage: npx tsx test-pockit.ts <file1.pdf> [file2.pdf] ...');
    process.exit(1);
}

function parseTransactionDate(dateStr: string): number {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return 0;
    const [d, m, y] = parts.map(Number);
    return new Date(y, m - 1, d).getTime();
}

function sortTransactions(transactions: ParsedTransaction[]): ParsedTransaction[] {
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
    units.sort((a, b) =>
        parseTransactionDate(b[b.length - 1].date) - parseTransactionDate(a[a.length - 1].date)
    );
    return units.flat();
}

function verifyBalances(transactions: ParsedTransaction[]): void {
    let issues = 0;
    for (let i = 0; i < transactions.length - 1; i++) {
        const cur  = transactions[i];
        const next = transactions[i + 1];
        const curBal  = parseMoney(cur.balance);
        const nextBal = parseMoney(next.balance);
        if (curBal === null || nextBal === null) continue;
        const moneyIn  = parseMoney(cur.moneyIn)  ?? 0;
        const moneyOut = parseMoney(cur.moneyOut) ?? 0;
        const expected = nextBal + moneyIn - moneyOut;
        if (Math.abs(expected - curBal) > 0.02) {
            console.warn(
                `  [BalanceCheck] ${cur.date} "${cur.description.slice(0, 35)}": ` +
                `expected ${expected.toFixed(2)}, got ${curBal.toFixed(2)} ` +
                `(diff=${(curBal - expected).toFixed(2)})`
            );
            issues++;
        }
    }
    if (issues === 0) console.log('  [BalanceCheck] All balances OK');
    else console.log(`  [BalanceCheck] ${issues} discrepancies found`);
}

// ── Process each file ────────────────────────────────────────────────────────
const allTransactions: ParsedTransaction[] = [];
let combinedStatementTotals: { moneyIn: number; moneyOut: number } | undefined;

for (const filePath of filePaths) {
    const fileBuffer = readFileSync(filePath);
    const filename = filePath.split(/[\\/]/).pop()!;
    const cachePath = filePath.replace(/\.pdf(\.\w+)?$/i, '') + '.azure-cache.json';

    console.log(`\n=== File: ${filename} ===`);

    const classification = classify(filename, 'application/pdf');
    console.log('Classification:', classification);

    let pageData: Awaited<ReturnType<typeof analyzePages>>;

    if (existsSync(cachePath)) {
        console.log(`[Cache] Loading from ${cachePath}`);
        pageData = JSON.parse(readFileSync(cachePath, 'utf8'));
        console.log('Azure DI (cached):', pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`).join(', '));
    } else {
        const pageBuffers = await splitPdf(fileBuffer);
        console.log(`Pages: ${pageBuffers.length}`);
        pageData = await analyzePages(pageBuffers);
        console.log('Azure DI:', pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`).join(', '));
        writeFileSync(cachePath, JSON.stringify(pageData, null, 2));
        console.log(`[Cache] Saved to ${cachePath}`);
    }

    // Debug: show raw cells from page 1 (rows 0-8) for first file only
    if (filePath === filePaths[0] && pageData[0]) {
        const p1cells = pageData[0].cells.filter(c => c.rowIndex <= 8).sort((a,b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex);
        console.log('\n--- Page 1 raw cells (rows 0-8) ---');
        for (const c of p1cells) {
            console.log(`  row${c.rowIndex} col${c.columnIndex}: "${c.content}"`);
        }
        console.log('---');
    }

    const combinedContent = pageData
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map(p => p.content).join(' ');

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

    const { transactions, statementTotals } = parsePockit(combined);
    console.log(`Parsed ${transactions.length} transactions`);

    if (transactions.length > 0) {
        const totalIn  = transactions.reduce((s, t) => s + (parseFloat(t.moneyIn  || '0') || 0), 0);
        const totalOut = transactions.reduce((s, t) => s + (parseFloat(t.moneyOut || '0') || 0), 0);
        console.log(`Totals — Money In: ${totalIn.toFixed(2)}  Money Out: ${totalOut.toFixed(2)}`);
        console.log(`Date range: ${transactions[transactions.length - 1].date} → ${transactions[0].date}`);
        if (statementTotals) {
            console.log(`Declared by bank — Money In: ${statementTotals.moneyIn.toFixed(2)}  Money Out: ${statementTotals.moneyOut.toFixed(2)}`);
            if (!combinedStatementTotals) combinedStatementTotals = { ...statementTotals };
            else { combinedStatementTotals.moneyIn += statementTotals.moneyIn; combinedStatementTotals.moneyOut += statementTotals.moneyOut; }
        }
    }

    allTransactions.push(...transactions);
}

// ── Sort + verify + output ───────────────────────────────────────────────────
console.log(`\n=== Combined: ${allTransactions.length} transactions from ${filePaths.length} file(s) ===`);

const sorted = filePaths.length > 1 ? sortTransactions(allTransactions) : allTransactions;

if (sorted.length > 0) {
    console.log('\nFirst 5:');
    sorted.slice(0, 5).forEach((t, i) =>
        console.log(`  [${i+1}] ${t.date} | ${t.description.slice(0, 40).padEnd(40)} | out:${(t.moneyOut||'').padStart(10)} in:${(t.moneyIn||'').padStart(10)} bal:${t.balance}`)
    );
    console.log('\nLast 3:');
    sorted.slice(-3).forEach((t, i) =>
        console.log(`  [${sorted.length - 2 + i}] ${t.date} | ${t.description.slice(0, 40).padEnd(40)} | out:${(t.moneyOut||'').padStart(10)} in:${(t.moneyIn||'').padStart(10)} bal:${t.balance}`)
    );

    const totalIn  = sorted.reduce((s, t) => s + (parseFloat(t.moneyIn  || '0') || 0), 0);
    const totalOut = sorted.reduce((s, t) => s + (parseFloat(t.moneyOut || '0') || 0), 0);
    console.log(`\nTotals — Money In: ${totalIn.toFixed(2)}  Money Out: ${totalOut.toFixed(2)}`);

    if (filePaths.length > 1) {
        console.log('\nBalance verification:');
        verifyBalances(sorted);
    }

    console.log('\nTotals verification:');
    logTotalsVerification(sorted, combinedStatementTotals);
}

console.log('\nRunning categorization...');
const categorized = await categorize(sorted);
console.log('\nFirst 5 categorized:');
categorized.slice(0, 5).forEach((t, i) =>
    console.log(`  [${i+1}] ${t.DATE} | ${(t['Type and Description']||'').slice(0,40).padEnd(40)} | INCOME:${(t.INCOME||'').padStart(10)} OTHER:${(t.OTHER||'').padStart(10)} bal:${t.Balance}`)
);

const outputBuffer = await buildPdfOutputExcel(categorized);
const outPath = filePaths[0].replace(/\.pdf(\.\w+)?$/i, '') + (filePaths.length > 1 ? `_+${filePaths.length - 1}more` : '') + '_processed.xlsx';
writeFileSync(outPath, outputBuffer);
console.log(`\nOutput saved: ${outPath}`);
