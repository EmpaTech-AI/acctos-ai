import { google } from 'googleapis';
import { randomBytes } from 'crypto';

function buildGmailClient() {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return google.gmail({ version: 'v1', auth });
}

export interface GmailAttachment {
    filename: string;
    mimeType: string;
    buffer: Buffer;
}

export interface GmailMessage {
    id: string;
    subject: string;
    from: string;
}

export async function listUnreadMessages(labelName: string): Promise<GmailMessage[]> {
    const gmail = buildGmailClient();
    const res = await gmail.users.messages.list({
        userId: 'me',
        q: `label:"${labelName}" is:unread has:attachment`,
        maxResults: 20,
    });

    if (!res.data.messages?.length) return [];

    const messages: GmailMessage[] = [];
    for (const msg of res.data.messages) {
        const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From'],
        });
        const headers = detail.data.payload?.headers ?? [];
        messages.push({
            id: msg.id!,
            subject: headers.find(h => h.name === 'Subject')?.value ?? '',
            from:    headers.find(h => h.name === 'From')?.value ?? '',
        });
    }
    return messages;
}

const EXCEL_MIMES = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
]);

/** Returns PDF and Excel attachments. All other file types are ignored. */
export async function getSupportedAttachments(messageId: string): Promise<GmailAttachment[]> {
    const gmail  = buildGmailClient();
    const msg    = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const parts  = flattenParts(msg.data.payload?.parts ?? []);
    const result: GmailAttachment[] = [];

    for (const part of parts) {
        if (!part.filename) continue;
        const mt = part.mimeType ?? '';
        const isPdf   = mt === 'application/pdf' || part.filename.toLowerCase().endsWith('.pdf');
        const isExcel = EXCEL_MIMES.has(mt) || /\.xlsx?$/i.test(part.filename);
        if (!isPdf && !isExcel) continue;

        let dataB64: string;
        if (part.body?.data) {
            dataB64 = part.body.data;
        } else if (part.body?.attachmentId) {
            const att = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId,
                id: part.body.attachmentId,
            });
            dataB64 = att.data.data!;
        } else {
            continue;
        }

        result.push({
            filename: part.filename,
            mimeType: mt || (isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
            buffer:   Buffer.from(dataB64, 'base64url'),
        });
    }

    return result;
}

/** @deprecated Use getSupportedAttachments which also accepts Excel files. */
export const getPdfAttachments = getSupportedAttachments;

export async function markAsRead(messageId: string): Promise<void> {
    const gmail = buildGmailClient();
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
    });
}

// ── Outbound email via Gmail API ──────────────────────────────────────────────

interface SendOpts {
    from:        string;
    to:          string;
    subject:     string;
    text?:       string;
    html?:       string;
    attachment?: { filename: string; content: Buffer };
}

function buildRawMime(opts: SendOpts): string {
    const b1 = `mp_${randomBytes(8).toString('hex')}`;
    const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;

    const lines: string[] = [
        `From: ${opts.from}`,
        `To: ${opts.to}`,
        `Subject: ${enc(opts.subject)}`,
        'MIME-Version: 1.0',
    ];

    if (opts.attachment) {
        const b2 = `alt_${b1}`;
        lines.push(`Content-Type: multipart/mixed; boundary="${b1}"`, '');
        lines.push(`--${b1}`, `Content-Type: multipart/alternative; boundary="${b2}"`, '');
        if (opts.text) {
            lines.push(`--${b2}`, 'Content-Type: text/plain; charset=UTF-8',
                'Content-Transfer-Encoding: base64', '', Buffer.from(opts.text).toString('base64'));
        }
        if (opts.html) {
            lines.push(`--${b2}`, 'Content-Type: text/html; charset=UTF-8',
                'Content-Transfer-Encoding: base64', '', Buffer.from(opts.html).toString('base64'));
        }
        lines.push(`--${b2}--`);
        lines.push(
            `--${b1}`,
            'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            `Content-Disposition: attachment; filename="${enc(opts.attachment.filename)}"`,
            'Content-Transfer-Encoding: base64', '',
            opts.attachment.content.toString('base64'),
            `--${b1}--`,
        );
    } else if (opts.html) {
        const b2 = `alt_${b1}`;
        lines.push(`Content-Type: multipart/alternative; boundary="${b2}"`, '');
        if (opts.text) {
            lines.push(`--${b2}`, 'Content-Type: text/plain; charset=UTF-8',
                'Content-Transfer-Encoding: base64', '', Buffer.from(opts.text).toString('base64'));
        }
        lines.push(`--${b2}`, 'Content-Type: text/html; charset=UTF-8',
            'Content-Transfer-Encoding: base64', '', Buffer.from(opts.html).toString('base64'));
        lines.push(`--${b2}--`);
    } else {
        lines.push('Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64', '', Buffer.from(opts.text ?? '').toString('base64'));
    }

    return Buffer.from(lines.join('\r\n')).toString('base64url');
}

/**
 * Send an email via the Gmail API using the configured OAuth2 credentials.
 * The `from` address must be the authenticated Gmail account or a verified
 * "Send As" alias configured in Gmail settings.
 */
export async function sendGmailMessage(opts: SendOpts): Promise<void> {
    const gmail = buildGmailClient();
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildRawMime(opts) } });
    console.log(`[Gmail] Email sent to ${opts.to}: "${opts.subject}"`);
}

// ─────────────────────────────────────────────────────────────────────────────

function flattenParts(parts: any[]): any[] {
    const result: any[] = [];
    for (const part of parts) {
        if (part.parts?.length) {
            result.push(...flattenParts(part.parts));
        } else {
            result.push(part);
        }
    }
    return result;
}
