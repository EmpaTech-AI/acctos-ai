import { Buffer } from 'node:buffer';

const API_KEY  = process.env.MAILGUN_API_KEY;
const DOMAIN   = process.env.MAILGUN_DOMAIN ?? 'support.acctos.ai';
const BASE_URL = 'https://api.eu.mailgun.net/v3';

export interface SendOpts {
    from:        string;
    to:          string;
    subject:     string;
    text:        string;
    html?:       string;
    attachment?: { filename: string; content: Buffer };
}

export async function sendMailgunMessage(opts: SendOpts): Promise<void> {
    if (!API_KEY) throw new Error('MAILGUN_API_KEY not set');

    const form = new FormData();
    form.append('from',    opts.from);
    form.append('to',      opts.to);
    form.append('subject', opts.subject);
    form.append('text',    opts.text);
    if (opts.html)       form.append('html', opts.html);
    if (opts.attachment) {
        const blob = new Blob([opts.attachment.content], { type: 'application/octet-stream' });
        form.append('attachment', blob, opts.attachment.filename);
    }

    const credentials = Buffer.from(`api:${API_KEY}`).toString('base64');
    const res = await fetch(`${BASE_URL}/${DOMAIN}/messages`, {
        method:  'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body:    form,
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Mailgun ${res.status}: ${body}`);
    }
}
