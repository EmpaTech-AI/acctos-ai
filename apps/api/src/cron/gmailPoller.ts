import {
    listUnreadMessages,
    getSupportedAttachments,
    markAsRead,
    listGmailLabels,
    watchInbox,
    getMessagesSince,
    getMessageMetadata,
} from '../services/google/GmailService.js';
import { startBatchProcessingJob, startProcessingJob, extractClientName } from '../services/processing/ProcessingOrchestrator.js';
import { notifyUnsupportedAttachment } from '../services/processing/NotificationService.js';
import { uploadOriginalsToDrive } from '../services/google/GoogleService.js';
import prisma from '../lib/prisma.js';

// Build a tracking context from env vars — used to record usage for Gmail-triggered jobs.
// Returns undefined if DEFAULT_TENANT_ID is not set (usage tracking disabled).
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

// ── State shared between push handler and fallback poller ─────────────────────

// Gmail label name → Gmail label ID (e.g. "Bank Statement AI" → "Label_12345")
const resolvedLabelIds = new Map<string, string>();

// The historyId from the most recent push notification (or from watch() at startup)
let lastHistoryId: string | null = null;

// Prevent overlapping fallback poll runs
let polling = false;

// Guard against push + poll race: tracks message IDs currently being processed
// so that if both paths pick up the same message simultaneously, only one proceeds.
const processingMessageIds = new Set<string>();

// ── Core per-message logic ────────────────────────────────────────────────────

/**
 * Process a single email message. Works for both the push path and the polling
 * fallback — the message metadata (id, subject, from) must already be resolved.
 */
async function processEmailMessage(
    message: { id: string; subject: string; from: string },
    processingMode: 'bank_statement' | 'vat',
): Promise<void> {
    // Deduplicate: if push and poll both pick up the same message simultaneously,
    // only the first caller proceeds — the second skips silently.
    if (processingMessageIds.has(message.id)) {
        console.log(`[GmailPoller] Message ${message.id} already being processed — skipping duplicate`);
        return;
    }
    processingMessageIds.add(message.id);

    // Mark as read immediately — before downloading attachments — so that a server
    // restart during the (potentially slow) download doesn't cause the fallback poller
    // to re-discover and double-process the same email.
    try {
        await markAsRead(message.id);
        console.log(`[GmailPoller] Message ${message.id} marked as read`);
    } catch (e: any) {
        console.warn(`[GmailPoller] markAsRead failed for ${message.id} — continuing anyway:`, e?.message);
    }

    try {
    const attachments = await getSupportedAttachments(message.id);
    const pdfs   = attachments.filter(a => a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'));
    const excels = attachments.filter(a => /\.xlsx?$/i.test(a.filename) || a.mimeType.includes('spreadsheet') || a.mimeType.includes('ms-excel'));

    if (!attachments.length) {
        console.log(`[GmailPoller] Message ${message.id} has no supported attachments — sending error reply`);
        notifyUnsupportedAttachment({ to: extractEmail(message.from), emailSubject: message.subject });
        return;
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
        // Keep the ID in the set for 10 minutes so that a second push notification
        // for the same email (Gmail fires one for INBOX arrival and one for the
        // Bank Statement AI / VAT AI filter label being applied) doesn't trigger
        // a second processing run after the first has already completed.
        setTimeout(() => processingMessageIds.delete(message.id), 10 * 60 * 1000);
    }
}

// ── Push notification handler (called by the webhook route) ───────────────────

/**
 * Called by POST /v1/gmail/push when Pub/Sub delivers a push notification.
 * Uses the Gmail history API to find newly added messages since the last
 * processed historyId, then processes any that have our label IDs.
 */
export async function handleHistoryUpdate(newHistoryId: string): Promise<void> {
    if (!lastHistoryId) {
        // Not yet initialised — store and wait for the next notification
        lastHistoryId = newHistoryId;
        console.log(`[GmailPush] Received first notification, storing historyId=${newHistoryId}`);
        return;
    }

    // Advance the cursor BEFORE the async API call so that concurrent push
    // notifications that arrive while this one is awaiting getMessagesSince
    // will query from a later historyId and won't return the same messages.
    const fromHistoryId = lastHistoryId;
    lastHistoryId = newHistoryId;

    let messages;
    try {
        messages = await getMessagesSince(fromHistoryId);
    } catch (e: any) {
        // historyId may be too old (> 7 days) — cursor already advanced, no reset needed
        console.warn(`[GmailPush] getMessagesSince failed (${e.message}) — historyId advanced to ${newHistoryId}`);
        return;
    }

    if (!messages.length) return;

    for (const msg of messages) {
        // Determine which label (if any) matched
        let matchedMode: 'bank_statement' | 'vat' | null = null;
        for (const { label, processingMode } of LABEL_MAP) {
            const labelId = resolvedLabelIds.get(label);
            if (labelId && msg.labelIds.includes(labelId)) {
                matchedMode = processingMode;
                break;
            }
        }
        if (!matchedMode) continue;

        try {
            const meta = await getMessageMetadata(msg.id);
            console.log(`[GmailPush] Triggered by push: "${meta.subject}" (${matchedMode})`);
            await processEmailMessage(meta, matchedMode);
        } catch (e: any) {
            console.error(`[GmailPush] Failed to process message ${msg.id}: ${e.message}`);
        }
    }
}

// ── Label resolution + Gmail watch setup ──────────────────────────────────────

async function resolveLabelIds(): Promise<void> {
    try {
        const allLabels = await listGmailLabels();
        for (const { label } of LABEL_MAP) {
            const found = allLabels.find(l => l.name === label);
            if (found) {
                resolvedLabelIds.set(label, found.id);
                console.log(`[GmailPush] Resolved label "${label}" → ${found.id}`);
            } else {
                console.warn(`[GmailPush] Label "${label}" not found in mailbox — push filtering will skip it`);
            }
        }
    } catch (e: any) {
        console.error(`[GmailPush] Failed to resolve label IDs: ${e.message}`);
    }
}

async function callWatch(): Promise<void> {
    const topic = process.env.PUBSUB_TOPIC;
    if (!topic) return;

    try {
        const result = await watchInbox(topic);
        lastHistoryId = result.historyId;
        const expiresAt = new Date(Number(result.expiration)).toISOString();
        console.log(`[GmailPush] watch() active — historyId=${result.historyId}, expires ${expiresAt}`);
    } catch (e: any) {
        console.error(`[GmailPush] watch() failed: ${e.message}`);
    }
}

/**
 * Set up Gmail Push Notifications on startup.
 * Resolves label IDs, calls gmail.users.watch(), and schedules renewal every
 * 6 days (watch() expires after 7 days).
 *
 * No-ops silently if PUBSUB_TOPIC is not set — the fallback poller handles
 * everything in that case.
 */
export async function initGmailWatch(): Promise<void> {
    if (!process.env.PUBSUB_TOPIC) {
        console.log('[GmailPush] PUBSUB_TOPIC not set — push notifications disabled, polling only');
        return;
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) return;

    await resolveLabelIds();
    await callWatch();

    // Renew every 6 days so the subscription never expires
    const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
    setInterval(callWatch, SIX_DAYS_MS);
}

// ── Fallback polling (5-minute interval) ──────────────────────────────────────

/**
 * Polling-based fallback — catches any emails missed by push notifications
 * (e.g. server restarts, Pub/Sub delivery failures). Runs every 5 minutes
 * when PUBSUB_TOPIC is set, or every 30 seconds when running without push.
 */
export function startGmailPollerCron(): void {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
        console.log('[GmailPoller] Google credentials not configured — skipping');
        return;
    }

    const pushEnabled     = !!process.env.PUBSUB_TOPIC;
    const intervalMs      = pushEnabled ? 5 * 60 * 1000 : 30_000;
    const intervalLabel   = pushEnabled ? '5 minutes (fallback)' : '30 seconds';

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
    }, intervalMs);

    console.log(`[GmailPoller] Fallback polling scheduled (every ${intervalLabel})`);
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
