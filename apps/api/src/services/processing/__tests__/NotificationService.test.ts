/**
 * The result email sends the Drive link only, never a copy of the Excel — to the
 * client and to the team.
 *
 * Origin: a VAT result for a client was later corrected on Drive in place. Anyone
 * opening the Drive link saw the fix, but the Excel attached to the client's email
 * was a separate copy that could not be updated once sent. The team has access to
 * the client's Drive folder, so its attached copy went stale the same way. Both
 * copies attach the file only if there is no Drive link.
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

import { notifyProcessingComplete, ProcessingCompleteAlert, notifyProcessingBlocked } from '../NotificationService.js';

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

    it('sends the team the Drive link without attaching the Excel', async () => {
        const { team } = await send(alert());

        expect(team.attachment).toBeUndefined();
        expect(team.text).toContain(DRIVE_URL);
        expect(team.html).toContain(DRIVE_URL);
        expect(team.text).toContain('via the link below');
        expect(team.text).not.toMatch(/attached/i);
    });

    it('attaches the Excel for team and client when the Drive upload failed', async () => {
        const { team, client } = await send(alert({ driveFileUrl: undefined }));

        for (const m of [team, client]) {
            expect(m.attachment?.filename).toBe('Example Ltd VAT_processed.xlsx');
            expect(m.text).toContain('Attached you can find');
        }
    });
});

/**
 * A statement stopped at the limit gate used to vanish: the email was marked read,
 * nothing was processed and nobody was told. Client and team now get a notice that
 * names the used-up limit and asks for the email to be sent again.
 */
describe('notifyProcessingBlocked', () => {
    async function block(a: Parameters<typeof notifyProcessingBlocked>[0]) {
        notifyProcessingBlocked(a);
        await new Promise(r => setTimeout(r, 0));
        return {
            team:   sent.find(m => m.to === 'team@example.test')!,
            client: sent.find(m => m.to === 'client@example.test')!,
        };
    }
    const rowsOut = {
        emailSubject: 'EXAMPLE TRADING LTD accounts', filenames: ['Bank-Export.xlsx'],
        reason: 'limit_exceeded' as const, resource: 'rows' as const, used: 1401, limit: 1000,
    };

    it('goes to the client and the team as a reply to the original email', async () => {
        const { team, client } = await block(rowsOut);

        expect(client).toBeDefined();
        expect(team).toBeDefined();
        expect(client.subject).toBe('Re: EXAMPLE TRADING LTD accounts');
        expect(client.attachment).toBeUndefined();
    });

    it('names the used-up limit, says the other kind still works, and asks to resend', async () => {
        const { client } = await block(rowsOut);

        expect(client.text).toContain('Excel rows limit reached');
        expect(client.text).toContain('1,401 of 1,000');
        expect(client.text).toContain('Bank-Export.xlsx');
        expect(client.text).toContain('PDF statements are still processed.');
        expect(client.text).toContain('please send this email again');
        expect(client.text).toContain('/dashboard/billing');
        expect(client.text).toContain('редовете за Excel за текущия период на фактуриране са изчерпани');
        expect(client.html).toContain('<strong>EXAMPLE TRADING LTD accounts</strong>');
    });

    it('for a manual pause, says processing is paused without a limit or billing link', async () => {
        const { client } = await block({ emailSubject: 'Re: Example Ltd', filenames: ['a.pdf'], reason: 'paused' });

        expect(client.subject).toBe('Re: Example Ltd');
        expect(client.text).toContain('processing is paused');
        expect(client.text).toContain('please send this email again');
        expect(client.text).not.toContain('/dashboard/billing');
        expect(client.text).not.toContain('limit reached');
    });
});
