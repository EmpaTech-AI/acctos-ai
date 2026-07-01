import cron from 'node-cron';
import { listUnreadMessages, getPdfAttachments, markAsRead } from '../services/google/GmailService.js';
import { startBatchProcessingJob } from '../services/processing/ProcessingOrchestrator.js';

const LABEL_MAP = [
    { label: 'Bank Statement AI', processingMode: 'bank_statement' as const },
    { label: 'VAT AI',            processingMode: 'vat'            as const },
] as const;

export function startGmailPollerCron(): void {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
        console.log('[GmailPoller] Google credentials not configured — skipping');
        return;
    }

    cron.schedule('*/5 * * * *', async () => {
        for (const { label, processingMode } of LABEL_MAP) {
            try {
                await pollLabel(label, processingMode);
            } catch (e: any) {
                console.error(`[GmailPoller] Error polling label "${label}": ${e.message}`);
            }
        }
    });

    console.log('[GmailPoller] Gmail polling scheduled (every 5 minutes)');
}

async function pollLabel(labelName: string, processingMode: 'bank_statement' | 'vat'): Promise<void> {
    const messages = await listUnreadMessages(labelName);
    if (!messages.length) return;

    console.log(`[GmailPoller] ${messages.length} unread message(s) for label "${labelName}"`);

    for (const message of messages) {
        try {
            const pdfs = await getPdfAttachments(message.id);

            if (!pdfs.length) {
                console.log(`[GmailPoller] Message ${message.id} has no PDF attachments — marking read`);
                await markAsRead(message.id);
                continue;
            }

            console.log(`[GmailPoller] Processing ${pdfs.length} PDF(s) from "${message.subject}" as ${processingMode}`);

            startBatchProcessingJob(
                pdfs.map(pdf => ({ filename: pdf.filename, mimeType: pdf.mimeType, buffer: pdf.buffer })),
                undefined,
                undefined,
                processingMode,
            );

            await markAsRead(message.id);
            console.log(`[GmailPoller] Message ${message.id} queued and marked as read`);
        } catch (e: any) {
            console.error(`[GmailPoller] Failed to process message ${message.id}: ${e.message}`);
        }
    }
}
