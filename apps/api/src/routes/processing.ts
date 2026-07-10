import { Router, Response, NextFunction } from 'express';
import * as XLSX from 'xlsx';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import { jobStore } from '../services/processing/JobStore.js';
import { getJobRecord, listJobRecords, downloadOutputFile } from '../services/SupabaseService.js';
import { downloadDriveFile } from '../services/google/GoogleService.js';
import { ADMIN_ROLES } from '../utils/roles.js';

const router = Router();
router.use(authenticateToken);
router.use(requireRole(...ADMIN_ROLES));

/**
 * GET /v1/processing
 * List all jobs (from Supabase, newest first). Used by UI to show job history.
 */
router.get('/', async (_req: AuthenticatedRequest, res: Response) => {
    const jobs = await listJobRecords();
    res.json({ jobs });
});

/**
 * GET /v1/processing/:jobId
 * Poll job status. Checks in-memory first, then Supabase for persistent records.
 */
router.get('/:jobId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const job = jobStore.get(req.params.jobId);
    if (job) {
        const { outputBuffer, ...safe } = job as any;
        return res.json({ job: safe });
    }
    // Fallback to Supabase for jobs no longer in memory
    const record = await getJobRecord(req.params.jobId);
    if (!record) return next(createError('Job not found', 404, 'NOT_FOUND'));
    return res.json({
        job: {
            id: record.id,
            status: record.status,
            filename: record.filename,
            bankType: record.bank_type,
            transactionCount: record.transaction_count,
            completedAt: record.completed_at,
            createdAt: record.created_at,
            error: record.error,
            errorType: record.error_type,
            summary: record.summary ?? null,
        },
    });
});

/**
 * GET /v1/processing/:jobId/download
 * Download the processed Excel file. Serves from memory or Supabase Storage.
 */
router.get('/:jobId/download', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const job = jobStore.get(req.params.jobId);
    if (job) {
        if (job.status !== 'completed') return next(createError('Processing not yet complete', 400, 'NOT_READY'));
        if (!job.outputBuffer) return next(createError('Output file unavailable', 500, 'NO_OUTPUT'));
        const baseName = job.filename.replace(/\.[^.]+$/, '');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}_processed.xlsx"`);
        return res.send(job.outputBuffer);
    }
    // Fallback to Supabase Storage
    const record = await getJobRecord(req.params.jobId);
    if (!record) return next(createError('Job not found', 404, 'NOT_FOUND'));
    if (record.status !== 'completed') return next(createError('Processing not yet complete', 400, 'NOT_READY'));
    const baseName = (record.filename as string).replace(/\.[^.]+$/, '');
    const jobId    = req.params.jobId;

    // Try Supabase Storage first
    if (record.output_path) {
        const buffer = await downloadOutputFile(record.output_path as string);
        if (buffer) {
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${baseName}_processed.xlsx"`);
            return res.send(buffer);
        }
        console.warn(`[Download] ${jobId}: Supabase Storage download returned null for path "${record.output_path}"`);
    } else {
        console.warn(`[Download] ${jobId}: output_path is null in DB — Supabase Storage save likely failed at job completion`);
    }

    // Fallback: download from Google Drive using the stored Drive URL
    const driveUrl = (record.summary as Record<string, any>)?.driveUrl as string | undefined;
    if (driveUrl) {
        try {
            const { buffer } = await downloadDriveFile(driveUrl);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${baseName}_processed.xlsx"`);
            return res.send(buffer);
        } catch (e: any) {
            console.warn(`[Download] ${jobId}: Drive fallback failed:`, e?.message);
        }
    } else {
        console.warn(`[Download] ${jobId}: driveUrl missing from summary — Drive upload may have failed or not yet run`);
    }

    console.error(`[Download] ${jobId}: all download paths exhausted — file unavailable`);
    return next(createError('Output file unavailable', 500, 'NO_OUTPUT'));
});

/**
 * GET /v1/processing/:jobId/preview
 * Return the processed Excel rows as JSON for in-browser preview.
 */
router.get('/:jobId/preview', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    let buf: Buffer | null = null;
    const job = jobStore.get(req.params.jobId);
    if (job) {
        if (job.status !== 'completed') return next(createError('Processing not yet complete', 400, 'NOT_READY'));
        if (!job.outputBuffer) return next(createError('Output file unavailable', 500, 'NO_OUTPUT'));
        buf = job.outputBuffer;
    } else {
        const record = await getJobRecord(req.params.jobId);
        if (!record) return next(createError('Job not found', 404, 'NOT_FOUND'));
        if (record.status !== 'completed') return next(createError('Processing not yet complete', 400, 'NOT_READY'));
        if (!record.output_path) return next(createError('Output file unavailable', 500, 'NO_OUTPUT'));
        buf = await downloadOutputFile(record.output_path as string);
        if (!buf) return next(createError('Output file unavailable', 500, 'NO_OUTPUT'));
    }
    const workbook = XLSX.read(buf, { type: 'buffer' });
    const sheets = workbook.SheetNames.map(name => ({
        name,
        rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }) as unknown[][],
    }));
    res.json({ sheets });
});

export { router as processingRouter };
