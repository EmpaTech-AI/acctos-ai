import { randomUUID, createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { jobStore, FileSummary } from './JobStore.js';
import { classify, detectBankFromContent, BankType } from './DocumentClassifier.js';
import { splitPdf } from './PdfSplitter.js';
import { analyzePages, PageData } from './AzureExtractor.js';
import { categorize } from './AssistantCategorizer.js';
import { parseExcel } from './ExcelParser.js';
import { buildPdfOutputExcel, buildExcelOutputExcel, buildVatOutputExcel, VatStats } from './ExcelOutputBuilder.js';
import { Cell, ParsedTransaction, ParseResult } from './parsers/shared.js';
import { computeVerification, applyCatVerification, logVerificationSummary, computeChainVerification } from './Verification.js';
import { notifyParserError, notifyChainGap, notifyJobFailed, notifyInsufficientFiles, notifyProcessingComplete, BankSummary } from './NotificationService.js';
import {
    getAzureCache, saveAzureCache,
    createJobRecord, updateJobRecord, saveOutputFile,
} from '../SupabaseService.js';
import { uploadToDriveFolder, uploadToDriveSubfolder } from '../google/GoogleService.js';

function getDriveFolderId(processingMode?: 'bank_statement' | 'vat'): string {
    return processingMode === 'vat'
        ? (process.env.DRIVE_VAT_FOLDER_ID ?? '')
        : (process.env.DRIVE_BANK_STATEMENT_FOLDER_ID ?? '');
}

function driveFilename(name: string): string {
    return name.replace(/\.(pdf|xlsx?|csv)$/i, '') + '_processed.xlsx';
}

/**
 * Extract the client name from an email subject by stripping service keywords
 * ("Bank Statement AI", "VAT AI") wherever they appear, then cleaning up
 * leftover separators and whitespace.
 * Examples:
 *   "dan brown Bank Statement AI"  → "dan brown"
 *   "Bank Statement AI dan brown"  → "dan brown"
 *   "ELVIS CURRAJ - Bank Statement AI" → "ELVIS CURRAJ"
 *   "vat ai GANEV&CO"              → "GANEV&CO"
 */
export function extractClientName(subject: string): string {
    return subject
        .replace(/bank\s+statement\s+ai/gi, '')
        .replace(/vat\s+ai/gi, '')
        .replace(/^\s*[-–—]\s*|\s*[-–—]\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

/** Sanitise a string so it's safe to use as a Drive filename. */
function safeDriveFilename(subject: string): string {
    return subject.replace(/[\\/:*?"<>|]/g, '_').trim() + '_processed.xlsx';
}

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
import { parse as parseBarclaysBusiness } from './parsers/barclays-business.js';
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
import { parse as parseAnna } from './parsers/anna.js';
import { parse as parseMonese } from './parsers/monese.js';
import { parse as parseGeneric } from './parsers/generic.js';
import { parse as parseFallback } from './parsers/fallback.js';

type StandardParser = (cells: Cell[]) => ParseResult;

// ── Error classification ──────────────────────────────────────────────────────
// 'client' = bad/unsupported file uploaded by the client
// 'system' = our infrastructure or code failed
const CLIENT_ERROR_PATTERNS = [
    /no transactions (could be extracted|found)/i,
    /excel files not supported in multi-file/i,
    /unsupported file/i,
    /password.protected/i,
    /corrupt/i,
];

function classifyError(err: Error): 'client' | 'system' {
    const msg = err.message || '';
    return CLIENT_ERROR_PATTERNS.some(p => p.test(msg)) ? 'client' : 'system';
}

// ── Stage timing helper ───────────────────────────────────────────────────────
function makeStageTimer() {
    const starts: Partial<Record<string, number>> = {};
    return {
        start(stage: string) { starts[stage] = Date.now(); },
        elapsed(stage: string): number { return starts[stage] ? Math.round((Date.now() - starts[stage]!) / 1000) : 0; },
        all(): Partial<Record<string, number>> { return starts; },
    };
}

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
        case 'barclays':          return parseBarclays;
        case 'barclays-business': return parseBarclaysBusiness;
        case 'barclaycard':       return parseBarclaycard;
        case 'zempler':    return parseZempler;
        case 'countingup': return parseCountingup;
        case 'anna':       return parseAnna;
        case 'monese':     return parseMonese;
        case 'metro':      return parseMetro;
        case 'lloyds':     return parseLloyds;
        case 'tsb':        return parseTsb;
        case 'tide':       return parseTide;
        case 'anna':       return parseAnna;
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
 * @param bankHint  Optional bank type override — use when files are named-page splits of a known
 *                  bank's statement and filename/content detection would be unreliable.
 */
export function startBatchProcessingJob(files: FileInput[], tracking?: TrackingContext, bankHint?: BankType, processingMode?: 'bank_statement' | 'vat', emailSubject?: string, senderEmail?: string): string {
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
    createJobRecord({ id: jobId, filename: batchName, processingMode }).catch(() => {});

    if (duplicatesRemoved.length > 0) {
        jobStore.update(jobId, { duplicatesRemoved });
        console.log(`[Orchestrator] ${duplicatesRemoved.length} duplicate(s) removed. Processing ${uniqueFiles.length} unique file(s).`);
    }

    if (uniqueFiles.length === 0) {
        jobStore.update(jobId, { status: 'failed', error: 'All uploaded files are duplicates — no unique files to process.' });
        return jobId;
    }

    runBatchJob(jobId, uniqueFiles, tracking, bankHint, processingMode, emailSubject, senderEmail).catch(err => {
        console.error(`[Orchestrator] Batch job ${jobId} unhandled crash:`, err);
        jobStore.update(jobId, { status: 'failed', error: String(err?.message ?? err) });
    });

    return jobId;
}

async function runBatchJob(jobId: string, files: FileInput[], tracking?: TrackingContext, bankHint?: BankType, processingMode?: 'bank_statement' | 'vat', emailSubject?: string, senderEmail?: string): Promise<void> {
    const timer = makeStageTimer();
    try {
        jobStore.update(jobId, { status: 'processing', totalFiles: files.length });

        // Warn when the client hasn't sent enough files for a complete period
        const minFiles = processingMode === 'vat' ? 3 : 12;
        if (files.length < minFiles) {
            notifyInsufficientFiles({
                jobId,
                tenantId:        tracking?.tenantId,
                emailSubject,
                fileCount:       files.length,
                minimumRequired: minFiles,
                processingMode:  processingMode ?? 'bank_statement',
            });
        }

        const allTransactions: ParsedTransaction[] = [];
        let confirmedBankType: BankType | null = bankHint ?? null;
        if (confirmedBankType) console.log(`[Orchestrator] Bank hint applied: ${confirmedBankType}`);
        let combinedStatementTotals: { moneyIn: number; moneyOut: number; openingBalance?: number; closingBalance?: number } | undefined;
        const fileTotals: Array<{ moneyIn: number; moneyOut: number; openingBalance?: number; closingBalance?: number }> = [];
        const fileSummaries: FileSummary[] = [];
        let ascending = false;

        for (let fi = 0; fi < files.length; fi++) {
            const { filename, mimeType, buffer } = files[fi];
            jobStore.update(jobId, { currentFile: fi + 1, currentStage: 'classify' });

            const classification = classify(filename, mimeType);
            jobStore.update(jobId, { bankType: classification.bankType, docType: classification.docType, fileFormat: classification.fileFormat });

            if (classification.fileFormat === 'excel') {
                throw new Error(`Excel files are not supported in multi-file batch. Upload "${filename}" separately.`);
            }

            // PDF: split → Azure DI (or cache) → parse
            jobStore.update(jobId, { currentStage: 'extract' });
            const fileHash = createHash('sha256').update(buffer).digest('hex');
            const cachedPages = await getAzureCache(fileHash);
            let pageData: Array<PageData | null>;
            let usedAzure = false;
            if (cachedPages) {
                console.log(`[Orchestrator] Azure cache HIT for file ${fi + 1}: "${filename}"`);
                pageData = cachedPages;
                jobStore.update(jobId, { pageCount: cachedPages.filter(p => p !== null).length });
            } else {
                const pageBuffers = await splitPdf(buffer);
                jobStore.update(jobId, { pageCount: pageBuffers.length });
                pageData = await analyzePages(pageBuffers);
                usedAzure = true;
                console.log(`[Orchestrator] File ${fi + 1}/${files.length} Azure DI:`, pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`));
                saveAzureCache(fileHash, filename, pageData).catch(() => {});
            }

            if (usedAzure && tracking) {
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

            // Per-file summary for the output Excel "Files" sheet
            const parsedInFile  = Math.round(fileTransactions.reduce((s, t) => s + (parseFloat((t.moneyIn  || '0').replace(/,/g, '')) || 0), 0) * 100) / 100;
            const parsedOutFile = Math.round(fileTransactions.reduce((s, t) => s + (parseFloat((t.moneyOut || '0').replace(/,/g, '')) || 0), 0) * 100) / 100;
            fileSummaries.push({
                filename,
                transactions: fileTransactions.length,
                parsedIn:  parsedInFile,
                parsedOut: parsedOutFile,
                declaredIn:     statementTotals?.moneyIn,
                declaredOut:    statementTotals?.moneyOut,
                openingBalance: statementTotals?.openingBalance,
                closingBalance: statementTotals?.closingBalance,
            });
            if (statementTotals) {
                fileTotals.push(statementTotals);
                if (!combinedStatementTotals) {
                    combinedStatementTotals = { ...statementTotals };
                } else {
                    combinedStatementTotals.moneyIn += statementTotals.moneyIn;
                    combinedStatementTotals.moneyOut += statementTotals.moneyOut;
                }
            }
            allTransactions.push(...fileTransactions);
        }

        // Chain resolution: files may be uploaded in any order (e.g. alphabetical).
        // Find the true first file (openingBalance not matched by any closingBalance) and
        // true last file (closingBalance not matched by any openingBalance), then set the
        // combined opening/closing accordingly instead of using upload-order values.
        if (combinedStatementTotals && fileTotals.length > 1) {
            const allClose = new Set(
                fileTotals.filter(t => t.closingBalance !== undefined).map(t => Math.round(t.closingBalance! * 100))
            );
            const allOpen = new Set(
                fileTotals.filter(t => t.openingBalance !== undefined).map(t => Math.round(t.openingBalance! * 100))
            );
            const firstFile = fileTotals.find(t => t.openingBalance !== undefined && !allClose.has(Math.round(t.openingBalance * 100)));
            const lastFile  = fileTotals.find(t => t.closingBalance !== undefined && !allOpen.has(Math.round(t.closingBalance * 100)));
            if (firstFile?.openingBalance !== undefined) combinedStatementTotals.openingBalance = firstFile.openingBalance;
            if (lastFile?.closingBalance  !== undefined) combinedStatementTotals.closingBalance  = lastFile.closingBalance;
        } else if (combinedStatementTotals && fileTotals.length === 1) {
            combinedStatementTotals.openingBalance = fileTotals[0].openingBalance;
            combinedStatementTotals.closingBalance  = fileTotals[0].closingBalance;
        }

        if (allTransactions.length === 0) throw new Error('No transactions found in any of the uploaded files');

        // Sort by date, preserving the bank's natural order (ascending for Mettle, descending for all others)
        const sorted = files.length > 1 ? sortTransactions(allTransactions, ascending) : allTransactions;
        if (files.length > 1) verifyBalances(sorted);

        const verification = computeVerification(sorted, combinedStatementTotals, ascending);
        if (verification) logVerificationSummary(verification);

        // ── Notifications ────────────────────────────────────────────────────────
        const almostEq = (a: number, b: number) => Math.abs(a - b) < 0.02;

        // 1. Per-file parser verification failure → team alert
        const failedFiles = fileSummaries.filter(f => {
            if (f.declaredIn != null && f.declaredOut != null)
                return !almostEq(f.parsedIn, f.declaredIn) || !almostEq(f.parsedOut, f.declaredOut);
            if (f.openingBalance != null && f.closingBalance != null)
                return !almostEq(f.openingBalance + f.parsedIn - f.parsedOut, f.closingBalance);
            return false;
        });
        if (failedFiles.length > 0) {
            notifyParserError({
                jobId,
                tenantId:     tracking?.tenantId,
                emailSubject: emailSubject,
                label: `batch (${files.length} files)`,
                failedFiles: failedFiles.map(f => ({
                    filename:    f.filename,
                    parsedIn:    f.parsedIn,
                    parsedOut:   f.parsedOut,
                    declaredIn:  f.declaredIn,
                    declaredOut: f.declaredOut,
                    inDiff:  f.declaredIn  != null ? Math.round((f.parsedIn  - f.declaredIn)  * 100) / 100 : undefined,
                    outDiff: f.declaredOut != null ? Math.round((f.parsedOut - f.declaredOut) * 100) / 100 : undefined,
                })),
            });
        }

        // 2. Chain gap (all individual files OK, but overall sequence doesn't close) → client alert
        if (failedFiles.length === 0 && verification) {
            const chain = computeChainVerification(fileSummaries, verification.totalIn, verification.totalOut);
            if (chain && !chain.ok) {
                notifyChainGap({
                    jobId,
                    tenantId:            tracking?.tenantId,
                    emailSubject:        emailSubject,
                    fileCount:           files.length,
                    chainOpeningBalance: chain.chainOpeningBalance,
                    chainClosingBalance: chain.chainClosingBalance,
                    expectedClosing:     chain.expectedClosing,
                    diff:                chain.diff,
                });
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

        jobStore.update(jobId, { currentStage: 'categorize', currentFile: undefined });
        const categorized = await categorize(sorted);
        if (verification) applyCatVerification(verification, categorized);
        if (verification) logVerificationSummary(verification);
        jobStore.update(jobId, { transactionCount: categorized.length, currentStage: 'output' });

        let outputBuffer: Buffer;
        let vatStats: VatStats | undefined;
        if (processingMode === 'vat') {
            const result = await buildVatOutputExcel(categorized, emailSubject ? extractClientName(emailSubject) : undefined);
            outputBuffer = result.buffer;
            vatStats = result.vatStats;
        } else {
            outputBuffer = await buildPdfOutputExcel(categorized, verification, fileSummaries.length > 1 ? fileSummaries : undefined);
        }
        jobStore.update(jobId, { status: 'completed', outputBuffer, completedAt: new Date() });
        console.log(`[Orchestrator] Batch job ${jobId} completed — ${allTransactions.length} transactions from ${files.length} file(s)`);
        const _bankType  = jobStore.get(jobId)?.bankType;
        const _txCount   = jobStore.get(jobId)?.transactionCount;
        const _batchName = jobStore.get(jobId)?.filename ?? 'batch';

        // Supabase persist (non-blocking, independent of Drive)
        void (async () => {
            const outputPath = await saveOutputFile(jobId, outputBuffer);
            await updateJobRecord(jobId, {
                status: 'completed',
                bank_type: _bankType,
                transaction_count: _txCount,
                output_path: outputPath ?? undefined,
                completed_at: new Date().toISOString(),
            });
        })().catch(e => console.warn('[Orchestrator] Supabase persist (batch) failed:', e?.message));

        // Drive upload + reply email (non-blocking, independent of Supabase)
        // Reply fires after upload so we can include the Drive link; falls back
        // to attachment-only if Drive is unavailable.
        void (async () => {
            let driveFileUrl: string | undefined;
            const folderId = getDriveFolderId(processingMode);
            if (folderId) {
                try {
                    if (emailSubject) {
                        const clientFolder = extractClientName(emailSubject);
                        const fn = safeDriveFilename(emailSubject);
                        console.log(`[Orchestrator] Uploading to Drive: "${fn}" → "${clientFolder}/"`);
                        driveFileUrl = await uploadToDriveSubfolder(outputBuffer, fn, folderId, clientFolder) ?? undefined;
                    } else {
                        const fn = driveFilename(_batchName);
                        console.log(`[Orchestrator] Uploading to Drive: "${fn}"`);
                        driveFileUrl = await uploadToDriveFolder(outputBuffer, fn, folderId) ?? undefined;
                    }
                } catch (e: any) {
                    console.warn('[Orchestrator] Drive upload (batch) failed:', e?.message);
                }
            } else {
                console.log('[Orchestrator] Drive upload skipped — folder ID not configured');
            }

            if (senderEmail && emailSubject) {
                const replyFilename = safeDriveFilename(emailSubject);
                const clientName = extractClientName(emailSubject);
                const bankSummary: BankSummary | undefined = verification ? {
                    total:           categorized.length,
                    moneyIn:         verification.totalIn,
                    moneyOut:        verification.totalOut,
                    openingBalance:  verification.openingBalance,
                    closingBalance:  verification.closingBalance,
                    balanceDiff:     verification.balanceDiff,
                    balanceOk:       verification.balanceOk,
                    declaredIn:      verification.declaredIn,
                    declaredOut:     verification.declaredOut,
                    declaredOk:      verification.declaredOk,
                    catTotalIn:      processingMode !== 'vat' ? verification.catTotalIn  : undefined,
                    catTotalOut:     processingMode !== 'vat' ? verification.catTotalOut : undefined,
                    catOk:           processingMode !== 'vat' ? verification.catOk       : undefined,
                } : undefined;
                notifyProcessingComplete({ to: senderEmail, emailSubject, clientName, xlsxBuffer: outputBuffer, filename: replyFilename, driveFileUrl, vatSummary: vatStats, bankSummary });
            }
        })().catch(e => console.warn('[Orchestrator] Drive+email (batch) failed:', e?.message));

    } catch (err: any) {
        const stage = jobStore.get(jobId)?.currentStage;
        const errorType = classifyError(err);
        const elapsed = stage ? timer.elapsed(stage) : 0;
        console.error(`[Orchestrator][${errorType.toUpperCase()}] Batch job ${jobId} failed at stage "${stage}" (${elapsed}s):`, err.message);
        jobStore.update(jobId, { status: 'failed', error: err.message || String(err), errorType, completedAt: new Date() });
        updateJobRecord(jobId, {
            status: 'failed',
            error: (err.message || String(err)).slice(0, 2000),
            error_type: errorType,
            completed_at: new Date().toISOString(),
        }).catch(() => {});
        notifyJobFailed({
            jobId,
            tenantId:     tracking?.tenantId,
            emailSubject: emailSubject,
            filename:     `batch (${files.length} files)`,
            stage,
            stageElapsedSec: elapsed,
            error:    err.message || String(err),
            errorType,
        });
    }
}

export function startProcessingJob(
    filename: string,
    mimeType: string,
    fileBuffer: Buffer,
    tracking?: TrackingContext,
    processingMode?: 'bank_statement' | 'vat',
): string {
    const jobId = randomUUID();
    jobStore.create(jobId, filename);
    createJobRecord({ id: jobId, filename, processingMode }).catch(() => {});

    runJob(jobId, filename, mimeType, fileBuffer, tracking, processingMode).catch(err => {
        console.error(`[Orchestrator] Job ${jobId} unhandled crash:`, err);
        jobStore.update(jobId, { status: 'failed', error: String(err?.message ?? err) });
    });

    return jobId;
}

async function runJob(jobId: string, filename: string, mimeType: string, fileBuffer: Buffer, tracking?: TrackingContext, processingMode?: 'bank_statement' | 'vat'): Promise<void> {
    const timer = makeStageTimer();
    try {
        // ── Stage: classify ──────────────────────────────────────────────────────
        timer.start('classify');
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
            timer.start('extract');
            const excelTransactions = await parseExcel(fileBuffer);
            if (excelTransactions.length === 0) throw new Error('No transactions found in spreadsheet');

            // Convert ExcelTransaction → ParsedTransaction for categorization (both modes)
            const parsed = excelTransactions.map(t => ({
                date:        t.Date,
                type:        '',                       // 'Type and Description' already includes the type code
                description: t['Type and Description'],
                moneyIn:     t['Money in'],
                moneyOut:    t['Money out'],
                balance:     t.Balance,
            }));
            timer.start('categorize');
            jobStore.update(jobId, { transactionCount: parsed.length, currentStage: 'categorize' });
            const categorized = await categorize(parsed);
            timer.start('output');
            jobStore.update(jobId, { transactionCount: categorized.length, currentStage: 'output' });

            if (processingMode === 'vat') {
                ({ buffer: outputBuffer } = await buildVatOutputExcel(categorized, filename));
            } else {
                outputBuffer = await buildPdfOutputExcel(categorized);
            }

        } else {
            // ── Stage: extract (Azure DI or cache) ───────────────────────────────
            timer.start('extract');
            const fileHash = createHash('sha256').update(fileBuffer).digest('hex');
            const cachedPages = await getAzureCache(fileHash);
            let pageData: Array<PageData | null>;
            let usedAzure = false;
            if (cachedPages) {
                console.log(`[Orchestrator] Azure cache HIT for "${filename}"`);
                pageData = cachedPages;
                jobStore.update(jobId, { pageCount: cachedPages.filter(p => p !== null).length });
            } else {
                const pageBuffers = await splitPdf(fileBuffer);
                jobStore.update(jobId, { pageCount: pageBuffers.length });
                pageData = await analyzePages(pageBuffers);
                usedAzure = true;
                console.log(`[Orchestrator] Azure DI results per page:`, pageData.map((p, i) => `page${i+1}:${p?.cells?.length ?? 'null'}cells`));
                saveAzureCache(fileHash, filename, pageData).catch(() => {});
            }

            // Track Azure Document Intelligence usage (only when we actually called Azure)
            if (usedAzure && tracking) {
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
            timer.start('parse');
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

            console.log(`[Orchestrator] Parsed ${transactions.length} transactions from "${filename}"`);
            const verification = computeVerification(transactions, statementTotals, ascending);
            if (verification) logVerificationSummary(verification);

            // Parser verification failure → team alert
            if (verification && (verification.declaredOk === false || (verification.balanceDiff !== null && !verification.balanceOk))) {
                notifyParserError({
                    jobId,
                    tenantId: tracking?.tenantId,
                    label:    filename,
                    failedFiles: [{
                        filename,
                        parsedIn:    verification.totalIn,
                        parsedOut:   verification.totalOut,
                        declaredIn:  verification.declaredIn,
                        declaredOut: verification.declaredOut,
                        inDiff:      verification.declaredIn  != null ? Math.round((verification.totalIn  - verification.declaredIn)  * 100) / 100 : undefined,
                        outDiff:     verification.declaredOut != null ? Math.round((verification.totalOut - verification.declaredOut) * 100) / 100 : undefined,
                        balanceDiff: verification.balanceDiff ?? undefined,
                    }],
                });
            }

            // ── Stage: categorize (OpenAI Assistant, 50 transactions per batch) ──
            timer.start('categorize');
            jobStore.update(jobId, { currentStage: 'categorize' });
            const categorized = await categorize(transactions);
            if (verification) applyCatVerification(verification, categorized);
            if (verification) logVerificationSummary(verification);
            timer.start('output');
            jobStore.update(jobId, { transactionCount: categorized.length, currentStage: 'output' });

            // ── Stage: output (build Excel) ───────────────────────────────────────
            if (processingMode === 'vat') {
                ({ buffer: outputBuffer } = await buildVatOutputExcel(categorized, filename));
            } else {
                outputBuffer = await buildPdfOutputExcel(categorized, verification);
            }
        }

        jobStore.update(jobId, { status: 'completed', outputBuffer, completedAt: new Date() });
        console.log(`[Orchestrator] Job ${jobId} completed — ${filename}`);
        const _bankType = jobStore.get(jobId)?.bankType;
        const _txCount  = jobStore.get(jobId)?.transactionCount;

        // Supabase persist (non-blocking, independent of Drive)
        void (async () => {
            const outputPath = await saveOutputFile(jobId, outputBuffer);
            await updateJobRecord(jobId, {
                status: 'completed',
                bank_type: _bankType,
                transaction_count: _txCount,
                output_path: outputPath ?? undefined,
                completed_at: new Date().toISOString(),
            });
        })().catch(e => console.warn('[Orchestrator] Supabase persist (single) failed:', e?.message));

        // Drive upload (non-blocking, independent of Supabase)
        void (async () => {
            const folderId = getDriveFolderId(processingMode);
            if (!folderId) {
                console.log('[Orchestrator] Drive upload skipped — folder ID not configured');
                return;
            }
            const fn = driveFilename(filename);
            console.log(`[Orchestrator] Uploading to Drive: "${fn}"`);
            await uploadToDriveFolder(outputBuffer, fn, folderId);
        })().catch(e => console.warn('[Orchestrator] Drive upload (single) failed:', e?.message));

    } catch (err: any) {
        const stage = jobStore.get(jobId)?.currentStage;
        const errorType = classifyError(err);
        const elapsed = stage ? timer.elapsed(stage) : 0;
        console.error(`[Orchestrator][${errorType.toUpperCase()}] Job ${jobId} failed at stage "${stage}" (${elapsed}s):`, err.message);
        jobStore.update(jobId, {
            status: 'failed',
            error: err.message || String(err),
            errorType,
            completedAt: new Date(),
        });
        updateJobRecord(jobId, {
            status: 'failed',
            error: (err.message || String(err)).slice(0, 2000),
            error_type: errorType,
            completed_at: new Date().toISOString(),
        }).catch(() => {});
        notifyJobFailed({
            jobId,
            tenantId: tracking?.tenantId,
            filename,
            stage,
            stageElapsedSec: elapsed,
            error: err.message || String(err),
            errorType,
        });
    }
}
