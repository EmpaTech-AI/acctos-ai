import {
    listUnreadMessages,
    getSupportedAttachments,
    markAsRead,
} from '../services/google/GmailService.js';
import { startBatchProcessingJob, startProcessingJob, extractClientName } from '../services/processing/ProcessingOrchestrator.js';
import { notifyUnsupportedAttachment } from '../services/processing/NotificationService.js';
import { uploadOriginalsToDrive } from '../services/google/GoogleService.js';
import prisma from '../lib/prisma.js';

function getGmailTracking() {
    const tenantId = process.env.DEFAULT_TENANT_ID;
    if (!tenantId) return undefined;
    return { prisma, tenantId };
}

function extractEmail(from: string): string {
    const m = from.match(/<([^>]+)>/);
    return m ? m[1].trim() : from.trim();
}

const LABEL_MAP = [
    { label: 'Bank Statement AI', processingMode: 'bank_statement' as const },
    { label: 'VAT AI',            processingMode: 'vat'            as const },
] as const;

// Prevent overlapping poll runs
let polling = false;

// Deduplication guard: tracks message IDs currently being processed
const processingMessageIds = new Set<string>();

// ── Core per-message logic ────────────────────────────────────────────────────

async function processEmailMessage(
    message: { id: string; subject: string; from: string },
    processingMode: 'bank_statement' | 'vat',
): Promise<void> {
    if (processingMessageIds.has(message.id)) {
        console.log(`[GmailPoller] Message ${message.id} already being processed — skipping duplicate`);
        return;
    }
    processingMessageIds.add(message.id);

    // Skip emails sent from our own system — result-delivery emails land in the
    // monitored inbox and must never trigger reprocessing.
    const senderEmail = extractEmail(message.from).toLowerCase();
    const OWN_SENDER  = (process.env.FROM_EMAIL || 'info@support.acctos.ai').toLowerCase();
    if (senderEmail === OWN_SENDER) {
        console.log(`[GmailPoller] Message ${message.id} is from our own system (${senderEmail}) — marking read and skipping`);
        await markAsRead(message.id).catch(() => {});
        setTimeout(() => processingMessageIds.delete(message.id), 10 * 60 * 1000);
        return;
    }

    // Mark as read immediately so a server restart doesn't cause a double-process.
    try {
        await markAsRead(message.id);
        console.log(`[GmailPoller] Message ${message.id} marked as read`);
    } catch (e: any) {
        console.warn(`[GmailPoller] markAsRead failed for ${message.id} — continuing anyway:`, e?.message);
    }

    try {
        const attachments = await getSupportedAttachments(message.id);
        const pdfs = attachments.filter(a => a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'));

        // Exclude already-processed output files (e.g. *_processed.xlsx sent back by the client)
        const isProcessedOutput = (a: { filename: string }) => a.filename.toLowerCase().endsWith('_processed.xlsx');
        const excels = attachments.filter(a =>
            (/\.xlsx?$/i.test(a.filename) || a.mimeType.includes('spreadsheet') || a.mimeType.includes('ms-excel'))
            && !isProcessedOutput(a)
        );
        const sourceAttachments = attachments.filter(a => !isProcessedOutput(a));

        if (!attachments.length) {
            console.log(`[GmailPoller] Message ${message.id} has no supported attachments — sending error reply`);
            notifyUnsupportedAttachment({ to: extractEmail(message.from), emailSubject: message.subject });
            return;
        }

        // If every attachment is a processed output, this is a result email bounced back — skip silently.
        if (sourceAttachments.length === 0) {
            console.log(`[GmailPoller] Message ${message.id} contains only processed output files — skipping silently`);
            return;
        }

        // Save originals to Drive — only source files, never processed outputs (non-blocking)
        const originalsId = processingMode === 'vat'
            ? process.env.DRIVE_VAT_ORIGINALS_FOLDER_ID
            : process.env.DRIVE_BANK_STATEMENT_ORIGINALS_FOLDER_ID;
        if (originalsId && message.subject) {
            const clientFolder = extractClientName(message.subject);
            uploadOriginalsToDrive(
                sourceAttachments.map(a => ({ buffer: a.buffer, filename: a.filename })),
                originalsId,
                clientFolder,
            ).catch(e => console.warn('[GmailPoller] Originals Drive upload failed:', e?.message));
        }

        if (pdfs.length > 0) {
            console.log(`[GmailPoller] Processing ${pdfs.length} PDF(s) from "${message.subject}" as ${processingMode}`);
            startBatchProcessingJob(
                pdfs.map(pdf => ({ filename: pdf.filename, mimeType: pdf.mimeType, buffer: pdf.buffer })),
                getGmailTracking(),
                undefined,
                processingMode,
                message.subject,
                message.from,
            );
        } else if (excels.length === 1) {
            console.log(`[GmailPoller] Processing Excel "${excels[0].filename}" from "${message.subject}" as ${processingMode}`);
            startProcessingJob(excels[0].filename, excels[0].mimeType, excels[0].buffer, getGmailTracking(), processingMode, message.subject, extractEmail(message.from));
        } else {
            console.log(`[GmailPoller] Message ${message.id} has ${excels.length} Excel files but no PDFs — sending error reply`);
            notifyUnsupportedAttachment({ to: extractEmail(message.from), emailSubject: message.subject });
        }
    } finally {
        setTimeout(() => processingMessageIds.delete(message.id), 10 * 60 * 1000);
    }
}

// ── Polling (30-second interval) ──────────────────────────────────────────────

export function startGmailPollerCron(): void {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
        console.log('[GmailPoller] Google credentials not configured — skipping');
        return;
    }

    setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
            for (const { label, processingMode } of LABEL_MAP) {
                try {
                    await pollLabel(label, processingMode);
                } catch (e: any) {
                    console.error(`[GmailPoller] Error polling label "${label}": ${e.message}`);
                }
            }
        } finally {
            polling = false;
        }
    }, 30_000);

    console.log('[GmailPoller] Polling scheduled (every 30 seconds)');
}

async function pollLabel(labelName: string, processingMode: 'bank_statement' | 'vat'): Promise<void> {
    const messages = await listUnreadMessages(labelName);
    if (!messages.length) return;

    console.log(`[GmailPoller] ${messages.length} unread message(s) for label "${labelName}"`);

    for (const message of messages) {
        try {
            await processEmailMessage(message, processingMode);
        } catch (e: any) {
            console.error(`[GmailPoller] Failed to process message ${message.id}: ${e.message}`);
        }
    }
}
