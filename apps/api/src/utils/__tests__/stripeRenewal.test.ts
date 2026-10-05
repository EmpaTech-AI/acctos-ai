/**
 * A paid Stripe renewal starts the tenant's new billing period.
 *
 * Origin: a renewal was paid on 4 Oct 2026 and the tenant stayed blocked — nothing
 * listened for the payment. applyPaidRenewal handles Stripe's `invoice.paid`, and
 * for a Stripe subscriber it is the only thing that starts a new period.
 *
 * Prisma is faked: no database is touched. IDs are made up.
 */

import { describe, it, expect } from 'vitest';
import { applyPaidRenewal, describeFailedPayment, planFromLimits } from '../stripeRenewal.js';

const T = 'tenant-1';
const PERIOD_START = new Date('2026-10-04T00:00:00Z');
const PAID_AT = new Date('2026-11-03T22:00:00Z');

function fakePrisma(opts: {
    tenant?: Record<string, unknown>;
    subscription?: Record<string, unknown> | null;
    lastPeriod?: { pages: number; rows: number };
}) {
    const tenant: any = {
        scenariosPaused: false, pagesLimit: 1000, rowsLimit: 1000,
        addonPagesLimit: 0, addonRowsLimit: 0,
        lastResetAt: PERIOD_START, billingResetDay: 4,
        ...opts.tenant,
    };
    const subs: any[] = opts.subscription === null
        ? []
        : [{ tenantId: T, status: 'starter', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', ...opts.subscription }];
    const lastPeriod = opts.lastPeriod ?? { pages: 0, rows: 0 };
    const prisma = {
        tenant: {
            findUnique: async (args: any) => (args.where.id === T ? { ...tenant } : null),
            update: async (args: any) => { Object.assign(tenant, args.data); },
        },
        subscription: {
            findFirst: async (args: any) =>
                subs.find(s => Object.entries(args.where).every(([k, v]) => s[k] === v)) ?? null,
            findUnique: async (args: any) => subs.find(s => s.tenantId === args.where.tenantId) ?? null,
            upsert: async (args: any) => {
                const s = subs.find(x => x.tenantId === args.where.tenantId);
                if (s) Object.assign(s, args.update); else subs.push({ ...args.create });
            },
            update: async (args: any) => {
                Object.assign(subs.find(x => x.tenantId === args.where.tenantId), args.data);
            },
        },
        documentUsageAggregate: {
            aggregate: async (args: any) => {
                const u = args.where.date.gte < PAID_AT ? lastPeriod : { pages: 0, rows: 0 };
                return { _sum: { pagesSpent: u.pages, rowsUsed: u.rows } };
            },
        },
    };
    return { prisma: prisma as any, tenant, subs };
}

const renewal = (over: Record<string, unknown> = {}) => ({
    billing_reason: 'subscription_cycle',
    customer: 'cus_1',
    subscription: 'sub_1',
    status_transitions: { paid_at: PAID_AT.getTime() / 1000 },
    ...over,
});

describe('applyPaidRenewal', () => {
    it('starts a new period at the moment of payment and lifts a limit pause', async () => {
        const { prisma, tenant } = fakePrisma({
            tenant: { scenariosPaused: true, addonRowsLimit: 500 },
            lastPeriod: { pages: 300, rows: 1600 },
        });

        expect(await applyPaidRenewal(prisma, renewal()))
            .toEqual({ applied: true, tenantId: T, periodStart: PAID_AT, pauseLifted: true });
        expect(tenant.lastResetAt).toEqual(PAID_AT);
        expect(tenant.scenariosPaused).toBe(false);
        expect(tenant.addonRowsLimit).toBe(0);
    });

    it('leaves a manual pause for an admin to lift', async () => {
        const { prisma, tenant } = fakePrisma({
            tenant: { scenariosPaused: true },
            lastPeriod: { pages: 100, rows: 100 },
        });

        expect(await applyPaidRenewal(prisma, renewal())).toMatchObject({ applied: true, pauseLifted: false });
        expect(tenant.lastResetAt).toEqual(PAID_AT);
        expect(tenant.scenariosPaused).toBe(true);
    });

    it('puts the plan name back when the payment arrives after a failed attempt', async () => {
        const { prisma, subs } = fakePrisma({ subscription: { status: 'past_due' } });

        expect(await applyPaidRenewal(prisma, renewal())).toMatchObject({ applied: true });
        expect(subs[0].status).toBe('starter');
    });

    it.each(['subscription_create', 'subscription_update', 'manual'])('ignores a %s invoice', async (billing_reason) => {
        const { prisma, tenant } = fakePrisma({ tenant: { scenariosPaused: true }, lastPeriod: { pages: 1000, rows: 0 } });

        expect(await applyPaidRenewal(prisma, renewal({ billing_reason })))
            .toEqual({ applied: false, reason: 'not_a_renewal' });
        expect(tenant.lastResetAt).toEqual(PERIOD_START);
        expect(tenant.scenariosPaused).toBe(true);
    });

    it('ignores an event that is older than the current period', async () => {
        const later = new Date('2026-11-04T00:00:00Z');
        const { prisma, tenant } = fakePrisma({ tenant: { lastResetAt: later } });

        expect(await applyPaidRenewal(prisma, renewal()))
            .toEqual({ applied: false, reason: 'already_applied', tenantId: T });
        expect(tenant.lastResetAt).toEqual(later);
    });

    it('still links the Stripe ids from an old event, so the tenant goes onto the payment clock', async () => {
        const { prisma, tenant, subs } = fakePrisma({
            tenant: { lastResetAt: new Date('2026-11-04T00:00:00Z') },
            subscription: { stripeCustomerId: null, stripeSubscriptionId: null },
        });
        const invoice = renewal({ customer: 'cus_9', subscription: 'sub_9', subscription_details: { metadata: { tenantId: T } } });

        expect(await applyPaidRenewal(prisma, invoice)).toMatchObject({ applied: false, reason: 'already_applied' });
        expect(subs[0]).toMatchObject({ stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9' });
        expect(tenant.lastResetAt).toEqual(new Date('2026-11-04T00:00:00Z'));
    });

    it('ignores the same event delivered twice', async () => {
        const { prisma, tenant } = fakePrisma({ tenant: { addonPagesLimit: 0 } });

        await applyPaidRenewal(prisma, renewal());
        tenant.addonPagesLimit = 1000; // bought after the renewal — must survive a redelivery
        expect(await applyPaidRenewal(prisma, renewal())).toMatchObject({ applied: false, reason: 'already_applied' });
        expect(tenant.addonPagesLimit).toBe(1000);
    });

    it('finds the tenant by the subscription it already knows when the customer is new', async () => {
        const { prisma, subs } = fakePrisma({ subscription: { stripeCustomerId: 'cus_old' } });

        expect(await applyPaidRenewal(prisma, renewal({ customer: 'cus_new' }))).toMatchObject({ applied: true, tenantId: T });
        expect(subs[0].stripeCustomerId).toBe('cus_new');
    });

    it('finds the tenant by tenantId in the subscription metadata and links the Stripe ids', async () => {
        const { prisma, tenant, subs } = fakePrisma({ subscription: { stripeCustomerId: null, stripeSubscriptionId: null } });
        const invoice = renewal({
            customer: 'cus_9',
            subscription: undefined,
            parent: { subscription_details: { subscription: 'sub_9', metadata: { tenantId: T } } },
        });

        expect(await applyPaidRenewal(prisma, invoice)).toMatchObject({ applied: true, tenantId: T });
        expect(tenant.lastResetAt).toEqual(PAID_AT);
        expect(subs[0]).toMatchObject({ stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9', status: 'starter' });
    });

    it('creates the subscription record when metadata names a tenant that has none', async () => {
        const { prisma, subs } = fakePrisma({ subscription: null });
        const invoice = renewal({ subscription_details: { metadata: { tenantId: T } } });

        expect(await applyPaidRenewal(prisma, invoice)).toMatchObject({ applied: true, tenantId: T });
        expect(subs).toEqual([{ tenantId: T, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'starter' }]);
    });

    it('reports an unknown customer and changes nothing', async () => {
        const { prisma, tenant } = fakePrisma({});

        expect(await applyPaidRenewal(prisma, renewal({ customer: 'cus_unknown', subscription: 'sub_unknown' })))
            .toEqual({ applied: false, reason: 'no_tenant', customerId: 'cus_unknown' });
        expect(tenant.lastResetAt).toEqual(PERIOD_START);
    });

    it('reports metadata that names a tenant that does not exist', async () => {
        const { prisma } = fakePrisma({ subscription: null });
        const invoice = renewal({ subscription_details: { metadata: { tenantId: 'no-such-tenant' } } });

        expect(await applyPaidRenewal(prisma, invoice)).toMatchObject({ applied: false, reason: 'no_tenant' });
    });
});

describe('describeFailedPayment', () => {
    const failed = (over: Record<string, unknown> = {}) => ({
        billing_reason: 'subscription_cycle',
        customer: 'cus_1',
        subscription: 'sub_1',
        customer_name: 'Stripe Customer Name',
        customer_email: 'payer@example.test',
        amount_due: 24900,
        currency: 'gbp',
        attempt_count: 2,
        next_payment_attempt: Date.UTC(2026, 10, 8, 9, 0, 0) / 1000,
        hosted_invoice_url: 'https://invoice.stripe.com/i/EXAMPLE',
        ...over,
    });

    it('names the tenant and carries what the team needs to act on', async () => {
        const { prisma } = fakePrisma({ tenant: { name: 'Example Trading Ltd' } });

        expect(await describeFailedPayment(prisma, failed())).toEqual({
            clientName: 'Example Trading Ltd',
            tenantId: T,
            customerId: 'cus_1',
            customerEmail: 'payer@example.test',
            amountDue: 24900,
            currency: 'gbp',
            attempt: 2,
            nextAttempt: new Date('2026-11-08T09:00:00Z'),
            invoiceUrl: 'https://invoice.stripe.com/i/EXAMPLE',
            isRenewal: true,
        });
    });

    it('changes nothing for the tenant', async () => {
        const { prisma, tenant, subs } = fakePrisma({ tenant: { scenariosPaused: true } });

        await describeFailedPayment(prisma, failed());
        expect(tenant.lastResetAt).toEqual(PERIOD_START);
        expect(tenant.scenariosPaused).toBe(true);
        expect(subs[0].status).toBe('starter');
    });

    it('falls back to the Stripe customer when no tenant is linked', async () => {
        const { prisma } = fakePrisma({});

        expect(await describeFailedPayment(prisma, failed({ customer: 'cus_unknown', subscription: 'sub_unknown' })))
            .toMatchObject({ clientName: 'Stripe Customer Name', tenantId: undefined, customerId: 'cus_unknown' });
    });

    it('reports that Stripe has stopped retrying, and a payment that is not a renewal', async () => {
        const { prisma } = fakePrisma({});

        expect(await describeFailedPayment(prisma, failed({ next_payment_attempt: null, billing_reason: 'subscription_create' })))
            .toMatchObject({ nextAttempt: null, isRenewal: false });
    });
});

describe('planFromLimits', () => {
    it('maps the pages limit a plan grants back to the plan name', () => {
        expect(planFromLimits(1000)).toBe('starter');
        expect(planFromLimits(5000)).toBe('professional');
        expect(planFromLimits(10000)).toBe('intermediate');
        expect(planFromLimits(15000)).toBe('enterprise');
    });

    it('falls back to active for limits no plan grants', () => {
        expect(planFromLimits(1234)).toBe('active');
        expect(planFromLimits(null)).toBe('active');
    });
});
