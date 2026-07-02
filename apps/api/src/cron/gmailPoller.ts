import { listUnreadMessages, getSupportedAttachments, markAsRead } from '../services/google/GmailService.js';
import { startBatchProcessingJob, startProcessingJob, extractClientName } from '../services/processing/ProcessingOrchestrator.js';
import { notifyUnsupportedAttachment } from '../services/processing/NotificationService.js';
import { uploadOriginalsToDrive } from '../services/google/GoogleService.js';

function extractEmail(from: string): string {
    const m = from.match(/<([^>]+)>/);
    return m ? m[1].trim() : from.trim();
}

const LABEL_MAP = [
    { label: 'Bank Statement AI', processingMode: 'bank_statement' as const },
    { label: 'VAT AI',            processingMode: 'vat'            as const },
] as const;

const POLL_INTERVAL_MS = 30_000; // 30 seconds

// Prevent overlapping runs if a poll takes longer than the interval
let polling = false;

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
    }, POLL_INTERVAL_MS);

    console.log('[GmailPoller] Gmail polling scheduled (every 30 seconds)');
}

async function pollLabel(labelName: string, processingMode: 'bank_statement' | 'vat'): Promise<void> {
    const messages = await listUnreadMessages(labelName);
    if (!messages.length) return;

    console.log(`[GmailPoller] ${messages.length} unread message(s) for label "${labelName}"`);

    for (const message of messages) {
        try {
            const attachments = await getSupportedAttachments(message.id);
            const pdfs   = attachments.filter(a => a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'));
            const excels = attachments.filter(a => /\.xlsx?$/i.test(a.filename) || a.mimeType.includes('spreadsheet') || a.mimeType.includes('ms-excel'));

            // No supported attachments → reply with error, do not process
            if (!attachments.length) {
                console.log(`[GmailPoller] Message ${message.id} has no supported attachments (PDF/Excel) — sending error reply`);
                notifyUnsupportedAttachment({ to: extractEmail(message.from), emailSubject: message.subject });
                await markAsRead(message.id);
                continue;
            }

            // Save originals to Drive (non-blocking)
            const originalsId = processingMode === 'vat'
                ? process.env.DRIVE_VAT_ORIGINALS_FOLDER_ID
                : process.env.DRIVE_BANK_STATEMENT_ORIGINALS_FOLDER_ID;
            if (originalsId && message.subject) {
                const clientFolder = extractClientName(message.subject);
                uploadOriginalsToDrive(
                    attachments.map(a => ({ buffer: a.buffer, filename: a.filename })),
                    originalsId,
                    clientFolder,
                ).catch(e => console.warn('[GmailPoller] Originals Drive upload failed:', e?.message));
            }

            if (pdfs.length > 0) {
                // One or more PDFs → batch processing (Excel attachments alongside are ignored)
                console.log(`[GmailPoller] Processing ${pdfs.length} PDF(s) from "${message.subject}" as ${processingMode}`);
                startBatchProcessingJob(
                    pdfs.map(pdf => ({ filename: pdf.filename, mimeType: pdf.mimeType, buffer: pdf.buffer })),
                    undefined,
                    undefined,
                    processingMode,
                    message.subject,
                    message.from,
                );
            } else if (excels.length === 1) {
                // Single Excel, no PDFs → single-file processing
                console.log(`[GmailPoller] Processing Excel "${excels[0].filename}" from "${message.subject}" as ${processingMode}`);
                startProcessingJob(excels[0].filename, excels[0].mimeType, excels[0].buffer, undefined, processingMode, message.subject, extractEmail(message.from));
            } else {
                // Multiple Excel files with no PDFs → not supported via email
                console.log(`[GmailPoller] Message ${message.id} has ${excels.length} Excel files but no PDFs — sending error reply`);
                notifyUnsupportedAttachment({ to: extractEmail(message.from), emailSubject: message.subject });
                await markAsRead(message.id);
                continue;
            }

            await markAsRead(message.id);
            console.log(`[GmailPoller] Message ${message.id} queued and marked as read`);
        } catch (e: any) {
            console.error(`[GmailPoller] Failed to process message ${message.id}: ${e.message}`);
        }
    }
}
