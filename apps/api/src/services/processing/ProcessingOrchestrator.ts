import { randomUUID, createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { jobStore } from './JobStore.js';
import { classify, detectBankFromContent, BankType } from './DocumentClassifier.js';
import { splitPdf } from './PdfSplitter.js';
import { analyzePages } from './AzureExtractor.js';
import { categorize } from './AssistantCategorizer.js';
import { parseExcel } from './ExcelParser.js';
import { buildPdfOutputExcel, buildExcelOutputExcel } from './ExcelOutputBuilder.js';
import { Cell, ParsedTransaction, ParseResult } from './parsers/shared.js';
import { computeVerification, applyCatVerification, logVerificationSummary } from './Verification.js';

interface TrackingContext {
    prisma: PrismaClient;
    tenantId: string;
}

import { parse as parseHsbc } from './parsers/hsbc.js';
import { parse as parseRevolut } from './parsers/revolut.js';
import { parse as parseMonzo } from './parsers/monzo.js';
import { parse as parseWise } from './parsers/wise.js';
import { parse as parseStarling } from './parsers/starling.js';
import { parse as parseNatwest } from './parsers/natwest.js';
import { parse as parseNationwide } from './parsers/nationwide.js';
import { parse as parseSantander } from './parsers/santander.js';
import { parse as parseBarclays } from './parsers/barclays.js';
import { parse as parseMetro } from './parsers/metro.js';
import { parse as parseLloyds } from './parsers/lloyds.js';
import { parse as parseTsb } from './parsers/tsb.js';
import { parse as parseTide } from './parsers/tide.js';
import { parse as parseRbs } from './parsers/rbs.js';
import { parse as parseVirginMoney } from './parsers/virginmoney.js';
import { parse as parsePockit } from './parsers/pockit.js';
import { parse as parseMettle } from './parsers/mettle.js';
import { parse as parseBarclaycard } from './parsers/barclaycard.js';
import { parse as parseZempler } from './parsers/zempler.js';
import { parse as parseCountingup } from './parsers/countingup.js';
import { parse as parseGeneric } from './parsers/generic.js';
import { parse as parseFallback } from './parsers/fallback.js';

type StandardParser = (cells: Cell[]) => ParseResult;

function getParser(bankType: BankType): StandardParser {
    switch (bankType) {
        case 'hsbc':       return parseHsbc;
        case 'revolut':    return parseRevolut;
        case 'wise':       return parseWise;
        case 'starling':   return parseStarling;
        case 'natwest':    return parseNatwest;
        case 'rbs':        return parseRbs;
        case 'virginmoney': return parseVirginMoney;
        case 'pockit':     return parsePockit;
        case 'mettle':     return parseMettle;
        case 'nationwide': return parseNationwide;
        case 'santander':  return parseSantander;
        case 'barclays':   return parseBarclays;
        case 'barclaycard': return parseBarclaycard;
        case 'zempler':    return parseZempler;
        case 'countingup': return parseCountingup;
        case 'metro':      return parseMetro;
        case 'lloyds':     return parseLloyds;
        case 'tsb':        return parseTsb;
        case 'tide':       return parseTide;
        default:           return parseGeneric;
    }
}

async function parseAllCells(pageCells: Array<Cell[] | null>, bankType: BankType): Promise<ParseResult> {
    const allTransactions: ParsedTransaction[] = [];

    if (bankType === 'monzo') {
        let pendingRow: ParsedTransaction | null | undefined = null;
        for (const cells of pageCells) {
            if (!cells) continue;
            const result = parseMonzo(cells, { pendingFromPrev: pendingRow });
            allTransactions.push(...result.transactions);
            pendingRow = result.pendingRow;
        }
        if (pendingRow) allTransactions.push(pendingRow);
        return { transactions: allTransactions };
    } else {
        // Merge all pages into one flat cell array so that state like currentDate
        // carries across page boundaries. Each page's row indices are offset to
        // avoid collisions. Synthetic context cells (rowIndex < 0) are kept once.
        const combined: Cell[] = [];
        let rowOffset = 0;
        let syntheticInjected = false;

        for (const cells of pageCells) {
            if (!cells) continue;

            let pageMaxRow = -1;
            for (const c of cells) {
                if (c.rowIndex < 0) {
                    if (!syntheticInjected) {
                        combined.push(c);
                        syntheticInjected = true;
                    }
                } else {
                    combined.push({ ...c, rowIndex: c.rowIndex + rowOffset });
                    if (c.rowIndex > pageMaxRow) pageMaxRow = c.rowIndex;
                }
            }
            if (pageMaxRow >= 0) rowOffset += pageMaxRow + 10000;
        }

        if (bankType === 'generic') {
            // AI-powered fallback: Claude detects column layout for unknown banks
            return await parseFallback(combined);
        } else {
            return getParser(bankType)(combined);
        }
    }
}

// ── Multi-file batch helpers ─────────────────────────────────────────────────

function parseTransactionDate(dateStr: string): number {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return 0;
    const [d, m, y] = parts.map(Number);
    return new Date(y, m - 1, d).getTime();
}

/**
 * Sort transactions from multiple files, keeping HSBC-style balance-blocks intact.
 * ascending=false (default) → newest first; ascending=true → oldest first (e.g. Mettle).
 */
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

/**
 * Log balance continuity warnings after sorting.
 * In descending order: row[i].balance = row[i+1].balance + row[i].moneyIn - row[i].moneyOut
 */
function parseMoney(s: string | undefined | null): number | null {
    if (!s) return null;
    const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
    return isFinite(n) ? n : null;
}

function verifyBalances(transactions: ParsedTransaction[]): void {
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
                `[BalanceCheck] ${cur.date} "${cur.description}": ` +
                `expected ${expected.toFixed(2)}, got ${curBal.toFixed(2)} ` +
                `(diff=${(curBal - expected).toFixed(2)})`
            );
        }
    }
}

export interface FileInput {
    filename: string;
    mimeType: string;
    buffer: Buffer;
}

/**
 * Start a batch job: parse all files, sort by date, verify balances, categorize, produce one Excel.
 * Deduplicates files by SHA-256 content hash before processing.
 */
export function startBatchProcessingJob(files: FileInput[], tracking?: TrackingContext): string {
    const jobId = randomUUID();

    // Deduplicate by content hash — identical bytes across differently-named files get dropped
    const seen = new Set<string>();
    const uniqueFiles: FileInput[] = [];
    const duplicatesRemoved: string[] = [];
    for (const f of files) {
        const hash = createHash('sha256').update(f.buffer).digest('hex');
        if (seen.has(hash)) {
            duplicatesRemoved.push(f.filename);
            console.warn(`[Orchestrator] Duplicate removed: "${f.filename}" (identical content already queued)`);
        } else {
            seen.add(hash);
            uniqueFiles.push(f);
        }
    }

    const batchName = uniqueFiles.length === 1 ? uniqueFiles[0].filename : `${uniqueFiles.length} files`;
    jobStore.create(jobId, batchName);

    if (duplicatesRemoved.length > 0) {
        jobStore.update(jobId, { duplicatesRemoved });
        console.log(`[Orchestrator] ${duplicatesRemoved.length} duplicate(s) removed. Processing ${uniqueFiles.length} unique file(s).`);
    }

    if (uniqueFiles.length === 0) {
        jobStore.update(jobId, { status: 'failed', error: 'All uploaded files are duplicates — no unique files to process.' });
        return jobId;
    }

    runBatchJob(jobId, uniqueFiles, tracking).catch(err => {
        console.error(`[Orchestrator] Batch job ${jobId} unhandled crash:`, err);
        jobStore.update(jobId, { status: 'failed', error: String(err?.message ?? err) });
    });

    return jobId;
}

async function runBatchJob(jobId: string, files: FileInput[], tracking?: TrackingContext): Promise<void> {
    try {
        jobStore.update(jobId, { status: 'processing', totalFiles: files.length });

        const allTransactions: ParsedTransaction[] = [];
        let confirmedBankType: BankType | null = null;
        let combinedStatementTotals: { moneyIn: number; moneyOut: number; openingBalance?: number; closingBalance?: number } | undefined;
        let ascending = false;

        for (let fi = 0; fi < files.length; fi++) {
            const { filename, mimeType, buffer } = files[fi];
            jobStore.update(jobId, { currentFile: fi + 1, currentStage: 'classify' });

            const classification = classify(filename, mimeType);
            jobStore.update(jobId, { bankType: classification.bankType, docType: classification.docType, fileFormat: classification.fileFormat });

            if (classification.fileFormat === 'excel') {
                throw new Error(`Excel files are not supported in multi-file batch. Upload "${filename}" separately.`);
            }

            // PDF: split → Azure DI → parse
            jobStore.update(jobId, { currentStage: 'extract' });
            const pageBuffers = await splitPdf(buffer);
            jobStore.update(jobId, { pageCount: pageBuffers.length });
            const pageData = await analyzePages(pageBuffers);
            console.log(`[Orchestrator] File ${fi + 1}/${files.length} Azure DI:`, pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`));

            if (tracking) {
                const pageCount = pageData.filter(p => p !== null).length;
                if (pageCount > 0) {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    const docType = classification.docType ?? '';
                    try {
                        await tracking.prisma.usageEvent.create({
                            data: {
                                tenantId: tracking.tenantId,
                                source: 'azure',
                                idempotencyKey: `azure-ocr-${jobId}-${fi}`,
                                documentType: docType || undefined,
                                fileType: 'pdf',
                                step: 'ocr',
                                timestamp: new Date(),
                            },
                        });
                        await tracking.prisma.usageAggregate.upsert({
                            where: {
                                tenantId_date_source_documentType_fileType_step_bankCode: {
                                    tenantId: tracking.tenantId, date: today,
                                    source: 'azure', documentType: docType,
                                    fileType: 'pdf', step: 'ocr', bankCode: '',
                                },
                            },
                            create: {
                                tenantId: tracking.tenantId, date: today,
                                source: 'azure', documentType: docType,
                                fileType: 'pdf', step: 'ocr', bankCode: '',
                                eventCount: pageCount, totalCost: 0, totalTokens: 0,
                            },
                            update: { eventCount: { increment: pageCount } },
                        });
                    } catch (err: any) {
                        if (!(err instanceof PrismaClientKnownRequestError && err.code === 'P2002')) {
                            console.warn('[Orchestrator] Failed to track Azure usage:', err?.message ?? err);
                        }
                    }
                }
            }

            const combinedContent = pageData.filter((p): p is NonNullable<typeof p> => p !== null).map(p => p.content).join(' ');
            const pageCells = pageData.map(p => {
                if (!p) return null;
                return [{ rowIndex: -1, columnIndex: -1, content: combinedContent }, ...p.cells] as Cell[];
            });

            let bankType = classification.bankType;
            if (bankType === 'generic') {
                const detected = detectBankFromContent(combinedContent);
                if (detected !== 'generic') {
                    console.log(`[Orchestrator] Bank detected from content: ${detected}`);
                    bankType = detected;
                } else if (confirmedBankType) {
                    console.log(`[Orchestrator] File ${fi + 1}/${files.length}: reusing confirmed bank "${confirmedBankType}" from earlier file`);
                    bankType = confirmedBankType;
                }
                jobStore.update(jobId, { bankType });
            }
            if (bankType !== 'generic' && !confirmedBankType) {
                confirmedBankType = bankType;
            }

            jobStore.update(jobId, { currentStage: 'parse' });
            const { transactions: fileTransactions, statementTotals, ascending: fileAscending } = await parseAllCells(pageCells, bankType);
            if (fileAscending) ascending = true;
            console.log(`[Orchestrator] File ${fi + 1}/${files.length} "${filename}": ${fileTransactions.length} transactions`);
            if (statementTotals) {
                if (!combinedStatementTotals) {
                    combinedStatementTotals = { ...statementTotals };
                } else {
                    combinedStatementTotals.moneyIn += statementTotals.moneyIn;
                    combinedStatementTotals.moneyOut += statementTotals.moneyOut;
                    // Opening balance: keep the first file's value (already set above)
                    // Closing balance: always use the latest file's declared value
                    if (statementTotals.closingBalance !== undefined) {
                        combinedStatementTotals.closingBalance = statementTotals.closingBalance;
                    }
                }
            }
            allTransactions.push(...fileTransactions);
        }

        if (allTransactions.length === 0) throw new Error('No transactions found in any of the uploaded files');

        // Sort by date, preserving the bank's natural order (ascending for Mettle, descending for all others)
        const sorted = files.length > 1 ? sortTransactions(allTransactions, ascending) : allTransactions;
        if (files.length > 1) verifyBalances(sorted);

        const verification = computeVerification(sorted, combinedStatementTotals, ascending);
        if (verification) logVerificationSummary(verification);

        jobStore.update(jobId, { currentStage: 'categorize', currentFile: undefined });
        const categorized = await categorize(sorted);
        if (verification) applyCatVerification(verification, categorized);
        if (verification) logVerificationSummary(verification);
        jobStore.update(jobId, { transactionCount: categorized.length, currentStage: 'output' });

        const outputBuffer = await buildPdfOutputExcel(categorized, verification);
        jobStore.update(jobId, { status: 'completed', outputBuffer, completedAt: new Date() });
        console.log(`[Orchestrator] Batch job ${jobId} completed — ${allTransactions.length} transactions from ${files.length} file(s)`);

    } catch (err: any) {
        const stage = jobStore.get(jobId)?.currentStage;
        console.error(`[Orchestrator] Batch job ${jobId} failed at stage "${stage}":`, err.message);
        jobStore.update(jobId, { status: 'failed', error: err.message || String(err), completedAt: new Date() });
    }
}

export function startProcessingJob(
    filename: string,
    mimeType: string,
    fileBuffer: Buffer,
    tracking?: TrackingContext,
): string {
    const jobId = randomUUID();
    jobStore.create(jobId, filename);

    runJob(jobId, filename, mimeType, fileBuffer, tracking).catch(err => {
        console.error(`[Orchestrator] Job ${jobId} unhandled crash:`, err);
        jobStore.update(jobId, { status: 'failed', error: String(err?.message ?? err) });
    });

    return jobId;
}

async function runJob(jobId: string, filename: string, mimeType: string, fileBuffer: Buffer, tracking?: TrackingContext): Promise<void> {
    try {
        // ── Stage: classify ──────────────────────────────────────────────────────
        jobStore.update(jobId, { status: 'processing', currentStage: 'classify' });
        const classification = classify(filename, mimeType);
        jobStore.update(jobId, {
            bankType: classification.bankType,
            docType: classification.docType,
            fileFormat: classification.fileFormat,
            currentStage: 'extract',
        });

        let outputBuffer: Buffer;

        if (classification.fileFormat === 'excel') {
            // ── Stage: extract (OpenAI two-pass for Excel) ───────────────────────
            const transactions = await parseExcel(fileBuffer);
            if (transactions.length === 0) throw new Error('No transactions found in spreadsheet');
            jobStore.update(jobId, { transactionCount: transactions.length, currentStage: 'output' });

            // ── Stage: output ────────────────────────────────────────────────────
            outputBuffer = buildExcelOutputExcel(transactions);

        } else {
            // ── Stage: extract (Azure DI page splitting + cell extraction) ───────
            const pageBuffers = await splitPdf(fileBuffer);
            jobStore.update(jobId, { pageCount: pageBuffers.length });
            const pageData = await analyzePages(pageBuffers);
            console.log(`[Orchestrator] Azure DI results per page:`, pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`));

            // Track Azure Document Intelligence usage
            if (tracking) {
                const pageCount = pageData.filter(p => p !== null).length;
                if (pageCount > 0) {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    const docType = classification.docType ?? '';
                    try {
                        await tracking.prisma.usageEvent.create({
                            data: {
                                tenantId: tracking.tenantId,
                                source: 'azure',
                                idempotencyKey: `azure-ocr-${jobId}`,
                                documentType: docType || undefined,
                                fileType: 'pdf',
                                step: 'ocr',
                                timestamp: new Date(),
                            },
                        });
                        await tracking.prisma.usageAggregate.upsert({
                            where: {
                                tenantId_date_source_documentType_fileType_step_bankCode: {
                                    tenantId: tracking.tenantId,
                                    date: today,
                                    source: 'azure',
                                    documentType: docType,
                                    fileType: 'pdf',
                                    step: 'ocr',
                                    bankCode: '',
                                },
                            },
                            create: {
                                tenantId: tracking.tenantId,
                                date: today,
                                source: 'azure',
                                documentType: docType,
                                fileType: 'pdf',
                                step: 'ocr',
                                bankCode: '',
                                eventCount: pageCount,
                                totalCost: 0,
                                totalTokens: 0,
                            },
                            update: { eventCount: { increment: pageCount } },
                        });
                    } catch (err: any) {
                        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
                            // Duplicate idempotency key — already tracked, skip
                        } else {
                            console.warn('[Orchestrator] Failed to track Azure usage:', err?.message ?? err);
                        }
                    }
                }
            }

            // Combine full-page text from all pages (headers, sidebars, footers that
            // Azure DI captures in result.content but not in table cells) into a
            // single string. This lets year detection work even when year-bearing
            // text only appears in the header of page 1.
            const combinedContent = pageData
                .filter((p): p is NonNullable<typeof p> => p !== null)
                .map(p => p.content)
                .join(' ');

            // Build per-page cell arrays, injecting a synthetic context cell at
            // rowIndex -1 so extractYearsFromCells() on any page can see years from
            // the whole document (e.g. "Issued on 06 January 2026" on page 1 informs
            // the parser running on page 2 which has no year-bearing text at all).
            const pageCells = pageData.map(p => {
                if (!p) return null;
                const cells: Cell[] = [
                    { rowIndex: -1, columnIndex: -1, content: combinedContent },
                    ...p.cells,
                ];
                return cells;
            });

            // ── Stage: parse (bank-specific parser) ──────────────────────────────
            jobStore.update(jobId, { currentStage: 'parse' });

            let bankType = classification.bankType;
            if (bankType === 'generic') {
                const allText = combinedContent;
                const detected = detectBankFromContent(allText);
                if (detected !== 'generic') {
                    console.log(`[Orchestrator] Bank detected from content: ${detected} (filename gave generic)`);
                    bankType = detected;
                    jobStore.update(jobId, { bankType: detected });
                }
            }

            const { transactions, statementTotals, ascending } = await parseAllCells(pageCells, bankType);
            if (transactions.length === 0) throw new Error('No transactions could be extracted from the document');

            console.log(`[Orchestrator] Parsed ${transactions.length} transactions:`, JSON.stringify(transactions, null, 2));
            const verification = computeVerification(transactions, statementTotals, ascending);
            if (verification) logVerificationSummary(verification);

            // ── Stage: categorize (OpenAI Assistant, 50 transactions per batch) ──
            jobStore.update(jobId, { currentStage: 'categorize' });
            const categorized = await categorize(transactions);
            if (verification) applyCatVerification(verification, categorized);
            if (verification) logVerificationSummary(verification);
            jobStore.update(jobId, { transactionCount: categorized.length, currentStage: 'output' });

            // ── Stage: output (build Excel) ───────────────────────────────────────
            outputBuffer = await buildPdfOutputExcel(categorized, verification);
        }

        jobStore.update(jobId, { status: 'completed', outputBuffer, completedAt: new Date() });
        console.log(`[Orchestrator] Job ${jobId} completed — ${filename}`);

    } catch (err: any) {
        const stage = jobStore.get(jobId)?.currentStage;
        console.error(`[Orchestrator] Job ${jobId} failed at stage "${stage}":`, err.message);
        jobStore.update(jobId, {
            status: 'failed',
            error: err.message || String(err),
            completedAt: new Date(),
        });
    }
}
