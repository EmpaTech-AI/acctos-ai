/**
 * The processing gate checks each resource against its own limit: Excel statements
 * spend rows, PDFs spend pages.
 *
 * Origin: a tenant used up its Excel rows (1,401 of 1,000) with 317 PDF pages still
 * left. The limit pause set the account-wide scenariosPaused flag and the gate then
 * blocked every job, PDFs included. Now only the used-up resource is blocked; the
 * flag blocks everything only when no limit is exceeded (a manual pause).
 *
 * Prisma is faked: no database is touched.
 */

import { describe, it, expect } from 'vitest';
import { checkProcessingAllowed } from '../usageLimits.js';

interface FakeTenant {
    scenariosPaused?: boolean;
    pagesLimit?: number; rowsLimit?: number;
    addonPagesLimit?: number; addonRowsLimit?: number;
}

function fakePrisma(tenant: FakeTenant, usage: { pages: number; rows: number }) {
    const updates: any[] = [];
    const prisma = {
        tenant: {
            findUnique: async () => ({
                scenariosPaused: false, pagesLimit: 1000, rowsLimit: 1000,
                addonPagesLimit: 0, addonRowsLimit: 0,
                lastResetAt: new Date('2026-09-04T00:00:00Z'), billingResetDay: 4,
                ...tenant,
            }),
            update: async (args: any) => { updates.push(args.data); },
        },
        documentUsageAggregate: {
            aggregate: async () => ({ _sum: { pagesSpent: usage.pages, rowsUsed: usage.rows } }),
        },
    };
    return { prisma: prisma as any, updates };
}

const T = 'tenant-1';

describe('checkProcessingAllowed', () => {
    it('allows both kinds of statement within limits', async () => {
        const { prisma } = fakePrisma({}, { pages: 683, rows: 260 });
        expect(await checkProcessingAllowed(prisma, T, ['rows'])).toEqual({ allowed: true });
        expect(await checkProcessingAllowed(prisma, T, ['pages'])).toEqual({ allowed: true });
    });

    it('blocks Excel but still allows PDFs when only the rows are used up', async () => {
        const { prisma } = fakePrisma({ scenariosPaused: true }, { pages: 683, rows: 1401 });

        expect(await checkProcessingAllowed(prisma, T, ['rows']))
            .toEqual({ allowed: false, reason: 'limit_exceeded', resource: 'rows', used: 1401, limit: 1000 });
        expect(await checkProcessingAllowed(prisma, T, ['pages'])).toEqual({ allowed: true });
    });

    it('blocks PDFs but still allows Excel when only the pages are used up', async () => {
        const { prisma } = fakePrisma({ scenariosPaused: true }, { pages: 1000, rows: 10 });

        expect(await checkProcessingAllowed(prisma, T, ['pages']))
            .toEqual({ allowed: false, reason: 'limit_exceeded', resource: 'pages', used: 1000, limit: 1000 });
        expect(await checkProcessingAllowed(prisma, T, ['rows'])).toEqual({ allowed: true });
    });

    it('blocks a job that needs both when either one is used up', async () => {
        const { prisma } = fakePrisma({}, { pages: 10, rows: 1401 });
        const r = await checkProcessingAllowed(prisma, T, ['pages', 'rows']);
        expect(r).toMatchObject({ allowed: false, reason: 'limit_exceeded', resource: 'rows' });
    });

    it('checks both resources when the caller does not say which', async () => {
        const { prisma } = fakePrisma({}, { pages: 10, rows: 1401 });
        expect(await checkProcessingAllowed(prisma, T)).toMatchObject({ allowed: false, resource: 'rows' });
    });

    it('treats the flag as a manual pause when no limit is exceeded', async () => {
        const { prisma } = fakePrisma({ scenariosPaused: true }, { pages: 10, rows: 10 });
        expect(await checkProcessingAllowed(prisma, T, ['rows'])).toEqual({ allowed: false, reason: 'paused' });
        expect(await checkProcessingAllowed(prisma, T, ['pages'])).toEqual({ allowed: false, reason: 'paused' });
    });

    it('sets the paused flag for the dashboard when a limit is newly exceeded', async () => {
        const { prisma, updates } = fakePrisma({ scenariosPaused: false }, { pages: 683, rows: 1401 });
        await checkProcessingAllowed(prisma, T, ['pages']);
        expect(updates).toEqual([{ scenariosPaused: true }]);
    });

    it('counts add-ons towards the limit', async () => {
        const { prisma } = fakePrisma({ addonRowsLimit: 500 }, { pages: 683, rows: 1401 });
        expect(await checkProcessingAllowed(prisma, T, ['rows'])).toEqual({ allowed: true });
    });

    it('fails open on a database error', async () => {
        const prisma = { tenant: { findUnique: async () => { throw new Error('db down'); } } } as any;
        expect(await checkProcessingAllowed(prisma, T, ['rows'])).toEqual({ allowed: true });
    });
});
