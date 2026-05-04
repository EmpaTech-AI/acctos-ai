import { randomUUID } from 'crypto';
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
import { parse as parseGeneric } from './parsers/generic.js';

type StandardParser = (cells: Cell[]) => ParseResult;

function getParser(bankType: BankType): StandardParser {
    switch (bankType) {
        case 'hsbc':       return parseHsbc;
        case 'revolut':    return parseRevolut;
        case 'wise':       return parseWise;
        case 'starling':   return parseStarling;
        case 'natwest':    return parseNatwest;
        case 'nationwide': return parseNationwide;
        case 'santander':  return parseSantander;
        case 'barclays':   return parseBarclays;
        case 'metro':      return parseMetro;
        default:           return parseGeneric;
    }
}

function parseAllCells(pageCells: Array<Cell[] | null>, bankType: BankType): ParsedTransaction[] {
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
    } else {
        const parser = getParser(bankType);
        for (const cells of pageCells) {
            if (!cells) continue;
            const result = parser(cells);
            allTransactions.push(...result.transactions);
        }
    }

    return allTransactions;
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

            const transactions = parseAllCells(pageCells, bankType);
            if (transactions.length === 0) throw new Error('No transactions could be extracted from the document');

            // ── Stage: categorize (OpenAI Assistant) ─────────────────────────────
            jobStore.update(jobId, { currentStage: 'categorize' });
            const categorized = await categorize(transactions);
            jobStore.update(jobId, { transactionCount: categorized.length, currentStage: 'output' });

            // ── Stage: output (build Excel) ───────────────────────────────────────
            outputBuffer = buildPdfOutputExcel(categorized);
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
