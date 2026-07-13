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
 *   - Sends email via Gmail API (info@support.acctos.ai) using the same
 *     OAuth2 credentials as the Gmail poller (GOOGLE_REFRESH_TOKEN).
 *     ALERT_TEAM_EMAIL  : team recipient (default: vasil.lozev@aiassist.bg)
 *     ALERT_CLIENT_EMAIL: client recipient (default: vasil.lozev@aiassist.bg)
 *
 * All functions are fire-and-forget — they never throw and never delay processing.
 */

import { sendMailgunMessage } from '../MailgunService.js';

const TEAM_EMAIL   = process.env.ALERT_TEAM_EMAIL || 'vasil.lozev@aiassist.bg';
const CLIENT_EMAIL = process.env.ALERT_CLIENT_EMAIL || 'vasil.lozev@aiassist.bg';
const FROM_EMAIL   = 'info@support.acctos.ai';

function ukTimeStr(): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
    return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')} (UK time)`;
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
        `Date: ${ukTimeStr()}`,
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
        `Date: ${ukTimeStr()}`,
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
        `Date: ${ukTimeStr()}`,
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
        `Date: ${ukTimeStr()}`,
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
}

// ── Accountant: processed result with Excel attachment ────────────────────────

export interface VatSummary {
    total:         number;
    salesCount:    number;
    salesTotal:    number;
    expensesCount: number;
    expensesTotal: number;
}

export interface BankSummary {
    total:            number;
    moneyIn:          number;
    moneyOut:         number;
    openingBalance?:  number | null;
    closingBalance?:  number | null;
    balanceDiff?:     number | null;
    balanceOk?:       boolean;
    declaredIn?:      number;
    declaredOut?:     number;
    declaredOk?:      boolean;
    catTotalIn?:      number;
    catTotalOut?:     number;
    catOk?:           boolean;
}

export interface ProcessingCompleteAlert {
    to:            string;
    emailSubject:  string;
    clientName:    string;
    xlsxBuffer:    Buffer;
    filename:      string;
    driveFileUrl?: string;
    vatSummary?:   VatSummary;
    bankSummary?:  BankSummary;
}

export function notifyProcessingComplete(alert: ProcessingCompleteAlert): void {

    const replySubject = /^re:/i.test(alert.emailSubject)
        ? alert.emailSubject
        : `Re: ${alert.emailSubject}`;

    const name = alert.clientName || alert.emailSubject;
    const isVat = !!alert.vatSummary;
    const linkSection = alert.driveFileUrl
        ? `\nYou can also access the file via the link below:\n${alert.driveFileUrl}\n`
        : '';
    const linkSectionBg = alert.driveFileUrl
        ? `\nМожете да отворите файла и чрез следния линк:\n${alert.driveFileUrl}\n`
        : '';

    const fmt = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    const vatSummaryText = isVat ? (() => {
        const v = alert.vatSummary!;
        const written = v.salesCount + v.expensesCount;
        const writtenLine = written === v.total
            ? `✓ ${written} of ${v.total} transactions written`
            : `⚠ ${written} of ${v.total} written (${v.total - written} skipped — zero amount)`;
        return [
            '', 'VAT Summary', '-----------',
            `Total transactions: ${v.total}`,
            `Sales:    ${v.salesCount} entries / £${fmt(v.salesTotal)}`,
            `Expenses: ${v.expensesCount} entries / £${fmt(v.expensesTotal)}`,
            writtenLine, '',
        ].join('\n');
    })() : '';

    const bankSummaryText = alert.bankSummary ? (() => {
        const b = alert.bankSummary!;
        const lines: string[] = ['', 'Summary', '-------', `Total transactions: ${b.total}`];
        if (b.openingBalance != null) lines.push(`Opening balance:  £${fmt(b.openingBalance)}`);
        lines.push(`Money in:         £${fmt(b.moneyIn)}`);
        lines.push(`Money out:        £${fmt(b.moneyOut)}`);
        if (b.closingBalance != null) lines.push(`Closing balance:  £${fmt(b.closingBalance)}`);
        if (b.balanceDiff != null) lines.push(b.balanceOk ? '✓ Balance check OK' : `⚠ Balance mismatch: ${(b.balanceDiff >= 0 ? '+' : '') + b.balanceDiff.toFixed(2)}`);
        if (b.declaredIn != null) {
            lines.push('');
            lines.push(`Declared in:      £${fmt(b.declaredIn)}`);
            lines.push(`Declared out:     £${fmt(b.declaredOut ?? 0)}`);
            lines.push(b.declaredOk ? '✓ Declared totals match' : '⚠ Declared totals mismatch');
        }
        if (b.catTotalIn != null) {
            lines.push('');
            lines.push(`Categorized in:   £${fmt(b.catTotalIn)}`);
            lines.push(`Categorized out:  £${fmt(b.catTotalOut ?? 0)}`);
            lines.push(b.catOk ? '✓ Category totals match' : '⚠ Category totals mismatch');
        }
        lines.push('');
        return lines.join('\n');
    })() : '';

    const summaryText = vatSummaryText + bankSummaryText;

    const title   = isVat ? 'VAT Return Information'         : 'Bank Statement Information';
    const titleBg = isVat ? 'Информация от VAT обработката'  : 'Информация от банковото извлечение';
    const descEn  = isVat ? 'VAT return'                     : 'bank statement';
    const descBg  = isVat ? 'VAT обработката'                : 'банковото извлечение';

    const processedAt = `Processed at: ${ukTimeStr()}`;

    const text = [
        title,
        '',
        'Hi,',
        '',
        `Attached you can find the extracted ${descEn} information for ${name}.`,
        summaryText,
        processedAt,
        linkSection,
        'If you have any questions, please reply to this email.',
        '',
        '---',
        '',
        titleBg,
        '',
        'Здравейте,',
        '',
        `В прикачения файл можете да намерите свалената информация от ${descBg} за ${name}.`,
        processedAt,
        linkSectionBg,
        'Ако имате въпроси, моля отговорете на този имейл.',
    ].join('\n');

    const btnStyle = 'display:inline-block;padding:12px 24px;background:#2563eb;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px';
    const driveButton = (label: string, labelFallback: string) => alert.driveFileUrl ? `
        <p style="margin:16px 0 4px">
          <a href="${alert.driveFileUrl}" style="${btnStyle}">${label}</a>
        </p>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7280">
          ${labelFallback}: <a href="${alert.driveFileUrl}" style="color:#2563eb">${alert.driveFileUrl}</a>
        </p>` : '';

    const summaryBoxStyle = 'background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0';
    const summaryHeadStyle = 'font-weight:700;margin:0 0 10px;color:#0369a1;font-size:15px';
    const tdL = 'padding:4px 0;color:#374151';
    const tdR = 'padding:4px 0;text-align:right;font-variant-numeric:tabular-nums';

    const ok  = `;color:#16a34a;font-weight:600`;
    const err = `;color:#dc2626;font-weight:600`;
    const sep = `<tr><td colspan="2" style="padding:6px 0 2px;border-top:1px solid #e2e8f0;font-size:0"> </td></tr>`;
    const row = (label: string, val: string, extra = '') =>
        `<tr><td style="${tdL}">${label}</td><td style="${tdR}${extra}">${val}</td></tr>`;

    const vatSummaryHtml = isVat ? (() => {
        const v = alert.vatSummary!;
        const written = v.salesCount + v.expensesCount;
        const writtenOk = written === v.total;
        const writtenVal = writtenOk ? `✓ ${written} of ${v.total}` : `⚠ ${written} of ${v.total}`;
        return `<div style="${summaryBoxStyle}">
        <p style="${summaryHeadStyle}">VAT Summary</p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          ${row('Total transactions', String(v.total), ';font-weight:600')}
          ${row('Sales entries',  String(v.salesCount))}
          ${row('Sales total',    `£${fmt(v.salesTotal)}`, ok)}
          ${row('Expenses entries', String(v.expensesCount))}
          ${row('Expenses total',   `£${fmt(v.expensesTotal)}`, err)}
          ${sep}
          ${row('Written', writtenVal, writtenOk ? ok : err)}
        </table>
      </div>`;
    })() : '';

    const bankSummaryHtml = alert.bankSummary ? (() => {
        const b = alert.bankSummary!;
        let rows = row('Total transactions', String(b.total), ';font-weight:600');
        if (b.openingBalance != null) rows += row('Opening balance', `£${fmt(b.openingBalance)}`);
        rows += row('Money in',  `£${fmt(b.moneyIn)}`,  ok);
        rows += row('Money out', `£${fmt(b.moneyOut)}`, err);
        if (b.closingBalance != null) rows += row('Closing balance', `£${fmt(b.closingBalance)}`);
        if (b.balanceDiff != null) {
            const balVal = b.balanceOk ? '✓ OK' : `⚠ ${(b.balanceDiff >= 0 ? '+' : '') + b.balanceDiff.toFixed(2)}`;
            rows += row('Balance check', balVal, b.balanceOk ? ok : err);
        }
        if (b.declaredIn != null) {
            rows += sep;
            rows += row('Declared in (by bank)',  `£${fmt(b.declaredIn)}`);
            rows += row('Declared out (by bank)', `£${fmt(b.declaredOut ?? 0)}`);
            rows += row('Declared totals', b.declaredOk ? '✓ Match' : '⚠ Mismatch', b.declaredOk ? ok : err);
        }
        if (b.catTotalIn != null) {
            rows += sep;
            rows += row('Categorized in',  `£${fmt(b.catTotalIn)}`);
            rows += row('Categorized out', `£${fmt(b.catTotalOut ?? 0)}`);
            rows += row('Category totals', b.catOk ? '✓ Match' : '⚠ Mismatch', b.catOk ? ok : err);
        }
        return `<div style="${summaryBoxStyle}">
        <p style="${summaryHeadStyle}">Summary</p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
      </div>`;
    })() : '';

    const summaryHtml = vatSummaryHtml + bankSummaryHtml;

    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;color:#111827;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="font-size:20px;font-weight:700;margin:0 0 16px">${title}</h2>
      <p>Hi,</p>
      <p>Attached you can find the extracted ${descEn} information for <strong>${name}</strong>.</p>
      ${summaryHtml}
      <p style="font-size:13px;color:#6b7280;margin:8px 0">${processedAt}</p>
      ${driveButton('Open File', 'Plain link (in case the button doesn\'t work)')}
      <p style="margin-top:24px;color:#6b7280;font-size:13px">If you have any questions, please reply to this email.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
      <h2 style="font-size:20px;font-weight:700;margin:0 0 16px">${titleBg}</h2>
      <p>Здравейте,</p>
      <p>В прикачения файл можете да намерите свалената информация от ${descBg} за <strong>${name}</strong>.</p>
      ${driveButton('Отвори файла', 'Директен линк (ако бутонът не работи)')}
      <p style="margin-top:24px;color:#6b7280;font-size:13px">Ако имате въпроси, моля отговорете на този имейл.</p>
    </body></html>`;

    const sendTo = (to: string) => sendMailgunMessage({
        from:       FROM_EMAIL,
        to,
        subject:    replySubject,
        text,
        html,
        attachment: { filename: alert.filename, content: alert.xlsxBuffer },
    }).then(() => {
        console.log(`[Notifications] Reply with Excel sent to ${to}: "${replySubject}"`);
    }).catch(err => {
        console.error(`[Notifications] Failed to send reply email to ${to}:`, err.message);
    });

    sendTo(TEAM_EMAIL);
    if (alert.to && alert.to !== TEAM_EMAIL) sendTo(alert.to);
}

// ── Unsupported attachment reply ──────────────────────────────────────────────

export interface UnsupportedAttachmentAlert {
    to:           string;
    emailSubject: string;
}

export function notifyUnsupportedAttachment(alert: UnsupportedAttachmentAlert): void {

    const replySubject = /^re:/i.test(alert.emailSubject)
        ? alert.emailSubject
        : `Re: ${alert.emailSubject}`;

    const text = [
        'Unsupported file type',
        '',
        'Hi,',
        '',
        'Your email was received, but no supported files were found as attachments.',
        'Please attach PDF or Excel (.xlsx) files and try again.',
        '',
        'If you have any questions, please reply to this email.',
        '',
        '---',
        '',
        'Неподдържан тип файл',
        '',
        'Здравейте,',
        '',
        'Вашият имейл беше получен, но не открихме поддържани прикачени файлове.',
        'Моля прикачете PDF или Excel (.xlsx) файлове и опитайте отново.',
        '',
        'Ако имате въпроси, моля отговорете на този имейл.',
    ].join('\n');

    const errStyle = 'font-size:20px;font-weight:700;margin:0 0 16px;color:#dc2626';
    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;color:#111827;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="${errStyle}">Unsupported file type</h2>
      <p>Hi,</p>
      <p>Your email was received, but no supported files were found as attachments.</p>
      <p>Please attach <strong>PDF</strong> or <strong>Excel (.xlsx)</strong> files and try again.</p>
      <p style="margin-top:24px;color:#6b7280;font-size:13px">If you have any questions, please reply to this email.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
      <h2 style="${errStyle}">Неподдържан тип файл</h2>
      <p>Здравейте,</p>
      <p>Вашият имейл беше получен, но не открихме поддържани прикачени файлове.</p>
      <p>Моля прикачете <strong>PDF</strong> или <strong>Excel (.xlsx)</strong> файлове и опитайте отново.</p>
      <p style="margin-top:24px;color:#6b7280;font-size:13px">Ако имате въпроси, моля отговорете на този имейл.</p>
    </body></html>`;

    const sendTo = (to: string) => sendMailgunMessage({ from: FROM_EMAIL, to, subject: replySubject, text, html })
        .then(() => console.log(`[Notifications] Unsupported-attachment reply sent to ${to}`))
        .catch(err => console.error(`[Notifications] Failed to send unsupported-attachment reply to ${to}:`, err.message));

    sendTo(TEAM_EMAIL);
    if (alert.to && alert.to !== TEAM_EMAIL) sendTo(alert.to);
}

// ── Shared email sender ───────────────────────────────────────────────────────

function sendEmail(to: string, subject: string, text: string): void {
    sendMailgunMessage({ from: FROM_EMAIL, to, subject, text })
        .then(() => console.log(`[Notifications] Email sent to ${to}: "${subject}"`))
        .catch(err => console.error(`[Notifications] Failed to send email to ${to}:`, err.message));
}
