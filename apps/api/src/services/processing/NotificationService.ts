/**
 * Notification service — three alert types:
 *
 *  1. notifyParserError  → team
 *     Parser verification failed: parsed totals don't match the bank's declared
 *     totals or the opening→closing balance chain breaks within a file.
 *
 *  2. notifyJobFailed    → team
 *     Processing job threw an unrecoverable exception (Azure DI down, bad file,
 *     OpenAI failure, etc.).
 *
 *  3. notifyChainGap     → team + client (Universal Trade BG)
 *     All individual files pass their own checks but the overall opening→closing
 *     sequence doesn't close — the client is missing one or more bank statements.
 *
 * Delivery:
 *   - Always logs to console.
 *   - Sends email via Resend when RESEND_API_KEY is set.
 *     RESEND_FROM_EMAIL : sender address (default: notifications@acctos.ai)
 *     ALERT_TEAM_EMAIL  : team recipient (default: vasillozev@gmail.com)
 *     ALERT_CLIENT_EMAIL: client recipient (default: vasillozev@gmail.com)
 *
 * All functions are fire-and-forget — they never throw and never delay processing.
 */

import { Resend } from 'resend';

const TEAM_EMAIL   = process.env.ALERT_TEAM_EMAIL   || 'vasillozev@gmail.com';
const CLIENT_EMAIL = process.env.ALERT_CLIENT_EMAIL || 'vasillozev@gmail.com';
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL  || 'notifications@acctos.ai';

function getResend(): Resend | null {
    const key = process.env.RESEND_API_KEY;
    if (!key) return null;
    return new Resend(key);
}

// ── Payload types ─────────────────────────────────────────────────────────────

export interface ParserErrorAlert {
    jobId:    string;
    tenantId?: string;
    label:    string;
    failedFiles: Array<{
        filename:     string;
        parsedIn:     number;
        parsedOut:    number;
        declaredIn?:  number;
        declaredOut?: number;
        inDiff?:      number;
        outDiff?:     number;
        balanceDiff?: number;
    }>;
}

export interface JobFailedAlert {
    jobId:    string;
    tenantId?: string;
    filename: string;
    stage?:   string;
    error:    string;
}

export interface ChainGapAlert {
    jobId:    string;
    tenantId?: string;
    fileCount:           number;
    chainOpeningBalance: number;
    chainClosingBalance: number;
    expectedClosing:     number;
    diff:                number;
}

// ── Team: parser verification failure ─────────────────────────────────────────

export function notifyParserError(alert: ParserErrorAlert): void {
    const lines = alert.failedFiles.map(f => {
        const parts: string[] = [`• ${f.filename}`];
        if (f.inDiff  != null) parts.push(`In diff: ${f.inDiff  >= 0 ? '+' : ''}${f.inDiff.toFixed(2)}`);
        if (f.outDiff != null) parts.push(`Out diff: ${f.outDiff >= 0 ? '+' : ''}${f.outDiff.toFixed(2)}`);
        if (f.balanceDiff != null) parts.push(`Balance diff: ${f.balanceDiff >= 0 ? '+' : ''}${f.balanceDiff.toFixed(2)}`);
        return parts.join(' | ');
    });

    const subject = `[Acctos] Parser verification failed — ${alert.label}`;
    const text = [
        `Job: ${alert.jobId}`,
        `Tenant: ${alert.tenantId ?? 'unknown'}`,
        ``,
        `Failed files:`,
        ...lines,
    ].join('\n');

    console.error(`[ALERT:parser_error] ${subject}\n${text}`);
    sendEmail(TEAM_EMAIL, subject, text);
}

// ── Team: job crashed ─────────────────────────────────────────────────────────

export function notifyJobFailed(alert: JobFailedAlert): void {
    const subject = `[Acctos] Processing job failed — ${alert.filename}`;
    const text = [
        `Job: ${alert.jobId}`,
        `Tenant: ${alert.tenantId ?? 'unknown'}`,
        `File: ${alert.filename}`,
        `Stage: ${alert.stage ?? 'unknown'}`,
        ``,
        `Error: ${alert.error}`,
    ].join('\n');

    console.error(`[ALERT:job_failed] ${subject}\n${text}`);
    sendEmail(TEAM_EMAIL, subject, text);
}

// ── Team + Client: missing documents in sequence ───────────────────────────────

export function notifyChainGap(alert: ChainGapAlert): void {
    const absDiff  = Math.abs(alert.diff).toFixed(2);
    const direction = alert.diff < 0 ? 'shortfall' : 'surplus';

    const teamSubject  = `[Acctos] Chain gap detected — £${absDiff} across ${alert.fileCount} files`;
    const clientSubject = `Missing bank statement detected`;

    const teamText = [
        `Job: ${alert.jobId}`,
        `Tenant: ${alert.tenantId ?? 'unknown'}`,
        `Files in batch: ${alert.fileCount}`,
        ``,
        `Opening balance: £${alert.chainOpeningBalance.toFixed(2)}`,
        `Expected closing: £${alert.expectedClosing.toFixed(2)}`,
        `Actual closing:  £${alert.chainClosingBalance.toFixed(2)}`,
        `Gap: £${absDiff} (${direction})`,
        ``,
        `This usually means the client is missing one or more monthly statements.`,
    ].join('\n');

    const clientText = [
        `We have detected a gap of £${absDiff} across the ${alert.fileCount} bank statement files you uploaded.`,
        ``,
        `This typically means one or more monthly statements are missing from the sequence.`,
        `Please check that you have uploaded the complete set of statements and re-submit.`,
        ``,
        `If you believe all files are included, please contact us so we can investigate.`,
    ].join('\n');

    console.warn(`[ALERT:chain_gap] ${teamSubject}\n${teamText}`);
    sendEmail(TEAM_EMAIL, teamSubject, teamText);
    sendEmail(CLIENT_EMAIL, clientSubject, clientText);
}

// ── Shared email sender ───────────────────────────────────────────────────────

function sendEmail(to: string, subject: string, text: string): void {
    const resend = getResend();
    if (!resend) {
        console.warn(`[Notifications] RESEND_API_KEY not set — email not sent to ${to}: "${subject}"`);
        return;
    }

    resend.emails.send({
        from:    FROM_EMAIL,
        to,
        subject,
        text,
    }).then(result => {
        if (result.error) {
            console.error(`[Notifications] Resend error sending to ${to}:`, result.error);
        } else {
            console.log(`[Notifications] Email sent to ${to}: "${subject}" (id: ${result.data?.id})`);
        }
    }).catch(err => {
        console.error(`[Notifications] Failed to send email to ${to}:`, err.message);
    });
}
