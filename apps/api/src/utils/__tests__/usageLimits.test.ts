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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyMonthlyResetIfNeeded, checkProcessingAllowed } from '../usageLimits.js';

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
        subscription: { findUnique: async () => null },
        documentUsageAggregate: {
            aggregate: async () => ({ _sum: { pagesSpent: usage.pages, rowsUsed: usage.rows } }),
        },
    };
    return { prisma: prisma as any, updates };
}

const T = 'tenant-1';

afterEach(() => vi.useRealTimers());

describe('checkProcessingAllowed', () => {
    // Inside the period that started on 4 Sep, so no monthly reset is due.
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T12:00:00Z')); });

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

/**
 * The calendar reset has to lift a limit pause — and must not touch a tenant on a
 * Stripe subscription, whose new period starts only when the renewal is paid.
 *
 * Origin: on 4 Oct 2026 a paying tenant's period restarted but processing stayed
 * blocked. The reset only cleared the pause flag for subscription status 'active',
 * and nothing ever writes that value — the status column holds the plan name. With
 * usage back at zero the leftover flag then read as a manual pause.
 *
 * This fake keeps state, and usage depends on the period it is asked about.
 */
function statefulPrisma(opts: {
    tenant?: Record<string, unknown>;
    status?: string;
    stripeSubscriptionId?: string;
    lastPeriod: { pages: number; rows: number };
}) {
    const tenant: any = {
        scenariosPaused: false, pagesLimit: 1000, rowsLimit: 1000,
        addonPagesLimit: 0, addonRowsLimit: 0,
        lastResetAt: new Date('2026-09-04T00:00:00Z'), billingResetDay: 4,
        ...opts.tenant,
    };
    const NEW_PERIOD = new Date('2026-10-04T00:00:00Z');
    const prisma = {
        tenant: {
            findUnique: async () => ({ ...tenant }),
            update: async (args: any) => { Object.assign(tenant, args.data); },
        },
        subscription: {
            findUnique: async () => (opts.status
                ? { tenantId: T, status: opts.status, stripeSubscriptionId: opts.stripeSubscriptionId ?? null }
                : null),
        },
        documentUsageAggregate: {
            aggregate: async (args: any) => {
                const u = args.where.date.gte < NEW_PERIOD ? opts.lastPeriod : { pages: 0, rows: 0 };
                return { _sum: { pagesSpent: u.pages, rowsUsed: u.rows } };
            },
        },
    };
    return { prisma: prisma as any, tenant };
}

describe('applyMonthlyResetIfNeeded', () => {
    // The morning after the period that started on 4 Sep ended.
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T08:30:00Z')); });

    it('restarts the period and lifts a limit pause when the status is a plan name', async () => {
        const { prisma, tenant } = statefulPrisma({
            tenant: { scenariosPaused: true, addonRowsLimit: 500 },
            status: 'starter',
            lastPeriod: { pages: 821, rows: 1901 },
        });

        expect(await applyMonthlyResetIfNeeded(prisma, T)).toBe(true);
        expect(tenant.lastResetAt).toEqual(new Date('2026-10-04T00:00:00Z'));
        expect(tenant.scenariosPaused).toBe(false);
        expect(tenant.addonRowsLimit).toBe(0);
    });

    it('lifts a limit pause for a tenant with no subscription record', async () => {
        const { prisma, tenant } = statefulPrisma({
            tenant: { scenariosPaused: true },
            lastPeriod: { pages: 1000, rows: 10 },
        });

        expect(await applyMonthlyResetIfNeeded(prisma, T)).toBe(true);
        expect(tenant.scenariosPaused).toBe(false);
    });

    it('restarts the period but leaves a manual pause for an admin to lift', async () => {
        const { prisma, tenant } = statefulPrisma({
            tenant: { scenariosPaused: true },
            status: 'starter',
            lastPeriod: { pages: 100, rows: 100 },
        });

        expect(await applyMonthlyResetIfNeeded(prisma, T)).toBe(true);
        expect(tenant.lastResetAt).toEqual(new Date('2026-10-04T00:00:00Z'));
        expect(tenant.scenariosPaused).toBe(true);
    });

    it('never restarts a tenant on a Stripe subscription — only its paid renewal does', async () => {
        const { prisma, tenant } = statefulPrisma({
            tenant: { scenariosPaused: true },
            status: 'starter',
            stripeSubscriptionId: 'sub_1',
            lastPeriod: { pages: 821, rows: 1401 },
        });

        expect(await applyMonthlyResetIfNeeded(prisma, T)).toBe(false);
        expect(tenant.lastResetAt).toEqual(new Date('2026-09-04T00:00:00Z'));
        expect(tenant.scenariosPaused).toBe(true);
    });

    it('does nothing inside the current period', async () => {
        const { prisma, tenant } = statefulPrisma({
            tenant: { scenariosPaused: true, lastResetAt: new Date('2026-10-04T00:00:00Z') },
            status: 'starter',
            lastPeriod: { pages: 821, rows: 1401 },
        });

        expect(await applyMonthlyResetIfNeeded(prisma, T)).toBe(false);
        expect(tenant.scenariosPaused).toBe(true);
    });

    it('lets the gate judge an emailed job against the new period before anyone opens the dashboard', async () => {
        const { prisma, tenant } = statefulPrisma({
            tenant: { scenariosPaused: true },
            status: 'starter',
            lastPeriod: { pages: 821, rows: 1401 },
        });

        expect(await checkProcessingAllowed(prisma, T, ['rows'])).toEqual({ allowed: true });
        expect(tenant.lastResetAt).toEqual(new Date('2026-10-04T00:00:00Z'));
    });

    it('keeps the gate closed for a Stripe subscriber whose renewal has not been paid', async () => {
        const { prisma } = statefulPrisma({
            tenant: { scenariosPaused: true },
            status: 'starter',
            stripeSubscriptionId: 'sub_1',
            lastPeriod: { pages: 821, rows: 1401 },
        });

        expect(await checkProcessingAllowed(prisma, T, ['rows']))
            .toEqual({ allowed: false, reason: 'limit_exceeded', resource: 'rows', used: 1401, limit: 1000 });
    });
});
