/**
 * POST /v1/drive/process
 *
 * Called by Make.com instead of the old internal webhook chain.
 * Accepts a Google Drive file link + spreadsheet ID, processes the file
 * through the Acctos pipeline, and writes results directly to the sheet.
 *
 * Auth: x-api-key header (same key as usage tracking)
 *
 * Body (multipart/form-data):
 *   spreadsheetId    — Google Sheets ID of the copied template
 *   typeOfProcessing — "bankStatement" | "vatStatement"
 *   WebContentLink   — public Google Drive download URL of the uploaded file
 *   WebViewLink      — (optional) view URL, used as fallback for file ID
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { startBatchProcessingJob } from '../services/processing/ProcessingOrchestrator.js';
import { jobStore } from '../services/processing/JobStore.js';
import { downloadDriveFile, writeRowsToSheet } from '../services/google/GoogleService.js';

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage() });

function requireApiKey(req: Request, res: Response, next: any) {
    const key = req.headers['x-api-key'];
    if (!process.env.USAGE_API_KEY || key !== process.env.USAGE_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

router.post('/process', requireApiKey, upload.none(), async (req: Request, res: Response) => {
    const { spreadsheetId, typeOfProcessing, WebContentLink, WebViewLink } = req.body as Record<string, string>;

    if (!spreadsheetId || (!WebContentLink && !WebViewLink)) {
        return res.status(400).json({ error: 'Missing spreadsheetId or file link' });
    }

    const fileLink = WebContentLink || WebViewLink;

    // Fire-and-forget — Make doesn't need to wait for the full pipeline
    res.status(202).json({ status: 'accepted' });

    processFromDrive({ spreadsheetId, typeOfProcessing, fileLink }).catch(err =>
        console.error('[DriveProcess] Unhandled error:', err.message),
    );
});

async function processFromDrive({
    spreadsheetId,
    typeOfProcessing,
    fileLink,
}: {
    spreadsheetId: string;
    typeOfProcessing: string;
    fileLink: string;
}): Promise<void> {
    console.log(`[DriveProcess] Starting — type=${typeOfProcessing} sheet=${spreadsheetId}`);

    // 1. Download file from Drive
    const { buffer, mimeType, filename } = await downloadDriveFile(fileLink);
    console.log(`[DriveProcess] Downloaded: ${filename} (${mimeType}, ${buffer.length} bytes)`);

    // 2. Run through the Acctos processing pipeline
    const processingMode = typeOfProcessing === 'vatStatement' ? 'vat' : 'bank_statement';
    const jobId = startBatchProcessingJob(
        [{ filename, mimeType, buffer }],
        undefined,
        undefined,
        processingMode,
    );
    console.log(`[DriveProcess] Job started: ${jobId}`);

    // 3. Wait for the job to complete (max 10 min)
    const job = await waitForJob(jobId, 600_000);
    if (job.status !== 'completed' || !job.outputBuffer) {
        console.error(`[DriveProcess] Job ${jobId} failed: ${job.error ?? 'no output'}`);
        return;
    }

    // 4. Parse the output Excel → data rows (skip header row)
    const workbook  = XLSX.read(job.outputBuffer, { type: 'buffer' });
    const sheet     = workbook.Sheets[workbook.SheetNames[0]];
    const allRows   = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' });
    const dataRows  = allRows.slice(1).filter((r: any[]) => r.some(c => c !== ''));

    if (!dataRows.length) {
        console.warn(`[DriveProcess] Job ${jobId} produced no data rows — skipping sheet write`);
        return;
    }

    // 5. Write to Google Sheets
    await writeRowsToSheet(spreadsheetId, dataRows);
    console.log(`[DriveProcess] Done — ${dataRows.length} rows written to sheet ${spreadsheetId}`);
}

function waitForJob(jobId: string, timeoutMs: number): Promise<ReturnType<typeof jobStore.get> & {}> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const interval = setInterval(() => {
            const job = jobStore.get(jobId);
            if (!job) {
                clearInterval(interval);
                return reject(new Error(`Job ${jobId} not found`));
            }
            if (job.status === 'completed' || job.status === 'failed') {
                clearInterval(interval);
                return resolve(job as any);
            }
            if (Date.now() > deadline) {
                clearInterval(interval);
                return reject(new Error(`Job ${jobId} timed out`));
            }
        }, 3000);
    });
}

export { router as driveProcessRouter };
