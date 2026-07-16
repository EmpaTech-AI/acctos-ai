import { Router } from 'express';
import { handleHistoryUpdate } from '../cron/gmailPoller.js';

const router = Router();

/**
 * POST /v1/gmail/push
 *
 * Receives Google Cloud Pub/Sub push notifications from the Gmail watch()
 * subscription. The endpoint must return 2xx within the push timeout (default
 * 10 s) — acknowledgement happens immediately, then we process asynchronously
 * so a slow run doesn't cause Pub/Sub to retry and double-process the message.
 *
 * Pub/Sub push payload:
 *   { message: { data: "<base64({"emailAddress":"...","historyId":"...})>", ... }, subscription: "..." }
 */
router.post('/push', (req, res) => {
    // Acknowledge immediately — Pub/Sub retries on non-2xx
    res.sendStatus(204);

    try {
        const message = req.body?.message;
        if (!message?.data) return;

        const raw = Buffer.from(message.data, 'base64').toString('utf-8');
        const payload = JSON.parse(raw) as { emailAddress?: string; historyId?: string | number };

        if (!payload.historyId) return;

        const historyId = String(payload.historyId);
        console.log(`[GmailPush] Push notification received — historyId=${historyId}, address=${payload.emailAddress ?? 'unknown'}`);

        // Fire-and-forget; errors are logged inside handleHistoryUpdate
        handleHistoryUpdate(historyId).catch(e =>
            console.error('[GmailPush] handleHistoryUpdate error:', e?.message),
        );
    } catch (e: any) {
        console.error('[GmailPush] Failed to parse push notification:', e.message);
    }
});

export { router as gmailWebhookRouter };
