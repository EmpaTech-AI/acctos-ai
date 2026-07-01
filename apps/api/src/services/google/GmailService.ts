import { google } from 'googleapis';

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

export async function getPdfAttachments(messageId: string): Promise<GmailAttachment[]> {
    const gmail  = buildGmailClient();
    const msg    = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const parts  = flattenParts(msg.data.payload?.parts ?? []);
    const result: GmailAttachment[] = [];

    for (const part of parts) {
        if (!part.filename) continue;
        const mt = part.mimeType ?? '';
        if (mt !== 'application/pdf' && !part.filename.toLowerCase().endsWith('.pdf')) continue;

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
            mimeType: mt || 'application/pdf',
            buffer:   Buffer.from(dataB64, 'base64url'),
        });
    }

    return result;
}

export async function markAsRead(messageId: string): Promise<void> {
    const gmail = buildGmailClient();
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
    });
}

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
