/**
 * The result email sends the client the Drive link only, never a copy of the Excel.
 *
 * Origin: a VAT result for a client was later corrected on Drive in place. Anyone
 * opening the Drive link saw the fix, but the Excel attached to the client's email
 * was a separate copy that could not be updated once sent. The team copy keeps
 * the attachment; the client copy attaches the file only if there is no Drive link.
 *
 * Mailgun is mocked: nothing is sent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SendOpts } from '../../MailgunService.js';

const sent = vi.hoisted(() => [] as SendOpts[]);
vi.hoisted(() => {
    process.env.ALERT_TEAM_EMAIL   = 'team@example.test';
    process.env.ALERT_CLIENT_EMAIL = 'client@example.test';
});
vi.mock('../../MailgunService.js', () => ({
    sendMailgunMessage: async (opts: SendOpts) => { sent.push(opts); },
}));

import { notifyProcessingComplete, ProcessingCompleteAlert } from '../NotificationService.js';

const DRIVE_URL = 'https://docs.google.com/spreadsheets/d/EXAMPLE/edit';

function alert(overrides: Partial<ProcessingCompleteAlert> = {}): ProcessingCompleteAlert {
    return {
        to:           'sender@example.test',
        emailSubject: 'Example Ltd VAT',
        clientName:   'EXAMPLE LTD',
        xlsxBuffer:   Buffer.from('xlsx'),
        filename:     'Example Ltd VAT_processed.xlsx',
        driveFileUrl: DRIVE_URL,
        vatSummary:   { total: 3, salesCount: 1, salesTotal: 100, expensesCount: 2, expensesTotal: 50 },
        ...overrides,
    };
}

async function send(a: ProcessingCompleteAlert) {
    notifyProcessingComplete(a);
    await new Promise(r => setTimeout(r, 0));   // let the fire-and-forget sends settle
    return {
        team:   sent.find(m => m.to === 'team@example.test')!,
        client: sent.find(m => m.to === 'client@example.test')!,
    };
}

beforeEach(() => { sent.length = 0; });

describe('notifyProcessingComplete', () => {
    it('sends the client the Drive link without attaching the Excel', async () => {
        const { client } = await send(alert());

        expect(client.attachment).toBeUndefined();
        expect(client.text).toContain(DRIVE_URL);
        expect(client.html).toContain(DRIVE_URL);
        expect(client.text).toContain('via the link below');
        expect(client.text).not.toMatch(/attached/i);
        expect(client.text).not.toContain('В прикачения файл');
    });

    it('still attaches the Excel to the team copy', async () => {
        const { team } = await send(alert());

        expect(team.attachment?.filename).toBe('Example Ltd VAT_processed.xlsx');
        expect(team.text).toContain('Attached you can find');
        expect(team.text).toContain(DRIVE_URL);
    });

    it('attaches the Excel for the client when the Drive upload failed', async () => {
        const { client } = await send(alert({ driveFileUrl: undefined }));

        expect(client.attachment?.filename).toBe('Example Ltd VAT_processed.xlsx');
        expect(client.text).toContain('Attached you can find');
    });
});
