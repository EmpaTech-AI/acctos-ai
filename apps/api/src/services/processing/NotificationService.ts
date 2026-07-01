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
 *     ALERT_TEAM_EMAIL  : team recipient (default: vasil.lozev@aiassist.bg)
 *     ALERT_CLIENT_EMAIL: client recipient (default: vasil.lozev@aiassist.bg)
 *
 * All functions are fire-and-forget — they never throw and never delay processing.
 */

import { Resend } from 'resend';

const TEAM_EMAIL   = process.env.ALERT_TEAM_EMAIL   || 'vasil.lozev@aiassist.bg';
const CLIENT_EMAIL = process.env.ALERT_CLIENT_EMAIL || 'vasil.lozev@aiassist.bg';
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL  || 'notifications@acctos.ai';

function getResend(): Resend | null {
    const key = process.env.RESEND_API_KEY;
    if (!key) return null;
    return new Resend(key);
}

// ── Payload types ─────────────────────────────────────────────────────────────

export interface ParserErrorAlert {
    jobId:         string;
    tenantId?:     string;
    emailSubject?: string;
    label:         string;
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
    jobId:         string;
    tenantId?:     string;
    emailSubject?: string;
    filename:      string;
    stage?:        string;
    stageElapsedSec?: number;
    error:         string;
    errorType?:    'client' | 'system';
}

export interface ChainGapAlert {
    jobId:         string;
    tenantId?:     string;
    emailSubject?: string;
    fileCount:           number;
    chainOpeningBalance: number;
    chainClosingBalance: number;
    expectedClosing:     number;
    diff:                number;
}

export interface InsufficientFilesAlert {
    jobId:           string;
    tenantId?:       string;
    emailSubject?:   string;
    fileCount:       number;
    minimumRequired: number;
    processingMode:  'bank_statement' | 'vat';
}

// ── Team: parser verification failure ─────────────────────────────────────────

export function notifyParserError(alert: ParserErrorAlert): void {
    const clientName = alert.emailSubject ?? alert.label;
    const lines = alert.failedFiles.map(f => {
        const parts: string[] = [`• ${f.filename}`];
        if (f.inDiff  != null) parts.push(`In diff: ${f.inDiff  >= 0 ? '+' : ''}${f.inDiff.toFixed(2)}`);
        if (f.outDiff != null) parts.push(`Out diff: ${f.outDiff >= 0 ? '+' : ''}${f.outDiff.toFixed(2)}`);
        if (f.balanceDiff != null) parts.push(`Balance diff: ${f.balanceDiff >= 0 ? '+' : ''}${f.balanceDiff.toFixed(2)}`);
        return parts.join(' | ');
    });

    const subject = `[Acctos] Parser verification failed — ${clientName}`;
    const text = [
        `Client: ${clientName}`,
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

const STAGE_LABELS: Record<string, string> = {
    classify:   'File classification',
    extract:    'Azure Document Intelligence (OCR)',
    parse:      'Bank parser (transaction extraction)',
    categorize: 'AI categorization (OpenAI)',
    output:     'Excel output generation',
};

const CLIENT_ERROR_ACTIONS: Record<string, string> = {
    extract:    'Ask the client to re-export or re-scan the file. It may be damaged, password-protected, or in an unsupported format.',
    parse:      'Ask the client to provide the original bank export (not a printout or screenshot). The file may be from an unsupported bank.',
    classify:   'Ask the client to upload the original file in PDF or Excel format.',
    categorize: 'Check the file content — the transactions may be in an unexpected format.',
    output:     'The file content is unusual. Try processing again or inspect the transactions manually.',
};

const SYSTEM_ERROR_ACTIONS: Record<string, string> = {
    extract:    'Check Azure Document Intelligence service status. The client can retry — the file is likely fine.',
    parse:      'This is likely a code bug in our parser. Check the server logs for a stack trace.',
    classify:   'Unexpected classification failure. Check server logs.',
    categorize: 'Check OpenAI API status and quota. The client can retry once the issue is resolved.',
    output:     'Unexpected error building the Excel output. Check server logs.',
};

export function notifyJobFailed(alert: JobFailedAlert): void {
    const isClientError = alert.errorType === 'client';
    const clientName = alert.emailSubject ?? alert.filename;
    const stageLabel = STAGE_LABELS[alert.stage ?? ''] ?? alert.stage ?? 'unknown';
    const elapsed = alert.stageElapsedSec ? `${alert.stageElapsedSec}s` : 'unknown';

    const actionMap = isClientError ? CLIENT_ERROR_ACTIONS : SYSTEM_ERROR_ACTIONS;
    const action = actionMap[alert.stage ?? ''] ?? 'Check the server logs for more details.';

    const errorTypeLabel = isClientError
        ? 'CLIENT ERROR — problem with the uploaded file'
        : 'SYSTEM ERROR — our infrastructure or code failed';

    const subject = isClientError
        ? `[Acctos] File could not be processed — ${clientName}`
        : `[Acctos] SYSTEM ERROR — ${clientName}`;

    const text = [
        `Client: ${clientName}`,
        `Type: ${errorTypeLabel}`,
        ``,
        `File: ${alert.filename}`,
        `Stage: ${stageLabel}`,
        `Time in stage: ${elapsed}`,
        `Tenant: ${alert.tenantId ?? 'unknown'}`,
        ``,
        `Error message:`,
        `  ${alert.error}`,
        ``,
        `What to do:`,
        `  ${action}`,
        ``,
        `──────────────────────────`,
        `Job ID: ${alert.jobId}`,
    ].join('\n');

    console.error(`[ALERT:job_failed] ${subject}\n${text}`);
    sendEmail(TEAM_EMAIL, subject, text);
}

// ── Team + Client: missing documents in sequence ───────────────────────────────

export function notifyChainGap(alert: ChainGapAlert): void {
    const absDiff   = Math.abs(alert.diff).toFixed(2);
    const direction = alert.diff < 0 ? 'shortfall' : 'surplus';
    const clientName = alert.emailSubject ?? 'unknown client';

    const teamSubject   = `[Acctos] Chain gap detected — ${clientName} — £${absDiff} across ${alert.fileCount} files`;
    const clientSubject = `Missing bank statement detected — ${clientName}`;

    const teamText = [
        `Client: ${clientName}`,
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
        `We have detected a gap of £${absDiff} across the ${alert.fileCount} bank statement files received for ${clientName}.`,
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

// ── Team + Client: not enough files for a complete period ─────────────────────

export function notifyInsufficientFiles(alert: InsufficientFilesAlert): void {
    const modeLabel  = alert.processingMode === 'vat' ? 'VAT' : 'Bank Statement';
    const periodDesc = alert.processingMode === 'vat'
        ? 'quarterly report (minimum 3 files — one per quarter)'
        : 'annual report (minimum 12 files — one per month)';
    const missing    = alert.minimumRequired - alert.fileCount;
    const label      = alert.emailSubject ?? `Job ${alert.jobId}`;

    const teamSubject   = `[Acctos] Insufficient files — ${label} (${alert.fileCount}/${alert.minimumRequired} ${modeLabel})`;
    const clientSubject = `Action required — missing files for ${modeLabel} report`;

    const teamText = [
        `Job: ${alert.jobId}`,
        `Tenant: ${alert.tenantId ?? 'unknown'}`,
        `Email subject: ${alert.emailSubject ?? 'n/a'}`,
        ``,
        `Files received: ${alert.fileCount}`,
        `Minimum required: ${alert.minimumRequired}`,
        `Missing: ${missing}`,
        ``,
        `Processing has started with the files received. The report may be incomplete.`,
    ].join('\n');

    const clientText = [
        `We received ${alert.fileCount} file${alert.fileCount !== 1 ? 's' : ''} for your ${modeLabel} ${periodDesc}.`,
        ``,
        `To produce a complete report we need at least ${alert.minimumRequired} files, ` +
        `so ${missing} file${missing !== 1 ? 's are' : ' is'} missing.`,
        ``,
        `We have started processing the files already received — you will get the results shortly.`,
        `Please send the missing files in a follow-up email so we can complete the report.`,
        ``,
        `If you believe you have sent all the files, please reply to this email and we will investigate.`,
    ].join('\n');

    console.warn(`[ALERT:insufficient_files] ${teamSubject}`);
    sendEmail(TEAM_EMAIL, teamSubject, teamText);
    sendEmail(CLIENT_EMAIL, clientSubject, clientText);
}

// ── Accountant: processed result with Excel attachment ────────────────────────

export interface ProcessingCompleteAlert {
    to:           string;
    emailSubject: string;
    xlsxBuffer:   Buffer;
    filename:     string;
}

export function notifyProcessingComplete(alert: ProcessingCompleteAlert): void {
    const resend = getResend();
    if (!resend) {
        console.warn(`[Notifications] RESEND_API_KEY not set — reply email not sent to ${alert.to}`);
        return;
    }

    const replySubject = /^re:/i.test(alert.emailSubject)
        ? alert.emailSubject
        : `Re: ${alert.emailSubject}`;

    const text = [
        'Your bank statements have been processed and categorised.',
        'Please find the Excel report attached.',
        '',
        'If you have any questions, please reply to this email.',
    ].join('\n');

    resend.emails.send({
        from:    FROM_EMAIL,
        to:      alert.to,
        subject: replySubject,
        text,
        attachments: [{
            filename: alert.filename,
            content:  alert.xlsxBuffer,
        }],
    }).then(result => {
        if (result.error) {
            console.error(`[Notifications] Resend error sending reply to ${alert.to}:`, result.error);
        } else {
            console.log(`[Notifications] Reply with Excel sent to ${alert.to}: "${replySubject}" (id: ${result.data?.id})`);
        }
    }).catch(err => {
        console.error(`[Notifications] Failed to send reply email to ${alert.to}:`, err.message);
    });
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
