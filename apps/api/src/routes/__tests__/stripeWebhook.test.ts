/**
 * Stripe can reach its webhook, and nobody else can use it.
 *
 * Origin: the route sat behind the login check of the billing router, so every
 * call from Stripe — which carries a signature, not a login token — was answered
 * with 401 before the handler ran. A renewal paid on 4 Oct 2026 never reached the
 * API. The handler was tested on its own; nothing went through the route.
 *
 * These tests go through the real router on a throwaway local server. Prisma is
 * faked: no database is touched. IDs and the signing secret are made up.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import Stripe from 'stripe';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../services/processing/NotificationService.js', () => ({ notifyPaymentFailed: vi.fn() }));

import { billingRouter } from '../billing.js';
import { errorHandler } from '../../middleware/errorHandler.js';

const T = 'tenant-1';
const SECRET = 'signing-secret-for-tests';
const PERIOD_START = new Date('2026-10-04T00:00:00Z');
const PAID_AT = new Date('2026-11-03T22:00:00Z');

/** A tenant that used up its limit last period and is paused, as on 4 Oct 2026. */
function fakePrisma() {
    const tenant: any = {
        scenariosPaused: true, pagesLimit: 1000, rowsLimit: 1000,
        addonPagesLimit: 0, addonRowsLimit: 0,
        lastResetAt: PERIOD_START, billingResetDay: 4,
    };
    const subs: any[] = [{ tenantId: T, status: 'starter', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' }];
    const prisma = {
        tenant: {
            findUnique: async (args: any) => (args.where.id === T ? { ...tenant } : null),
            update: async (args: any) => { Object.assign(tenant, args.data); },
        },
        subscription: {
            findFirst: async (args: any) =>
                subs.find(s => Object.entries(args.where).every(([k, v]) => s[k] === v)) ?? null,
            findUnique: async (args: any) => subs.find(s => s.tenantId === args.where.tenantId) ?? null,
            upsert: async (args: any) => { Object.assign(subs.find(x => x.tenantId === args.where.tenantId), args.update); },
            update: async (args: any) => { Object.assign(subs.find(x => x.tenantId === args.where.tenantId), args.data); },
        },
        documentUsageAggregate: {
            aggregate: async (args: any) => {
                const u = args.where.date.gte < PAID_AT ? { pages: 1000, rows: 400 } : { pages: 0, rows: 0 };
                return { _sum: { pagesSpent: u.pages, rowsUsed: u.rows } };
            },
        },
    };
    return { prisma, tenant };
}

const renewalPaid = {
    id: 'evt_1',
    type: 'invoice.paid',
    data: {
        object: {
            billing_reason: 'subscription_cycle',
            customer: 'cus_1',
            subscription: 'sub_1',
            status_transitions: { paid_at: PAID_AT.getTime() / 1000 },
        },
    },
};

let server: Server;
let base: string;
let db: ReturnType<typeof fakePrisma>;
const app = express();

beforeAll(() => {
    // Same body handling and error handler as the real server (index.ts).
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.use('/v1/billing', billingRouter);
    app.use(errorHandler);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/billing`;
});

afterAll(() => { server.close(); });

beforeEach(() => {
    db = fakePrisma();
    app.locals.prisma = db.prisma;
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    delete process.env.STRIPE_SECRET_KEY;
});

/** Sends an event the way Stripe does: a signature header and no login token. */
async function stripeSends(event: object, opts: { signedWith?: string | null; alter?: (body: string) => string } = {}) {
    const payload = JSON.stringify(event);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.signedWith !== null) {
        headers['stripe-signature'] = Stripe.webhooks.generateTestHeaderString({ payload, secret: opts.signedWith ?? SECRET });
    }
    const res = await fetch(`${base}/stripe-webhook`, { method: 'POST', headers, body: opts.alter ? opts.alter(payload) : payload });
    return { status: res.status, body: await res.json() };
}

describe('POST /v1/billing/stripe-webhook', () => {
    it('takes a signed renewal from Stripe without a login token and starts the new period', async () => {
        expect(await stripeSends(renewalPaid)).toEqual({ status: 200, body: { received: true } });
        expect(db.tenant.lastResetAt).toEqual(PAID_AT);
        expect(db.tenant.scenariosPaused).toBe(false);
    });

    it('refuses an event with no signature', async () => {
        expect((await stripeSends(renewalPaid, { signedWith: null })).status).toBe(400);
        expect(db.tenant.lastResetAt).toEqual(PERIOD_START);
        expect(db.tenant.scenariosPaused).toBe(true);
    });

    // Also what happens when the secret is replaced in Stripe and not in the API.
    it('refuses an event signed with a different secret', async () => {
        expect((await stripeSends(renewalPaid, { signedWith: 'another-secret' })).status).toBe(400);
        expect(db.tenant.lastResetAt).toEqual(PERIOD_START);
    });

    it('refuses a signed event whose content was changed afterwards', async () => {
        const res = await stripeSends(renewalPaid, { alter: body => body.replace('cus_1', 'cus_2') });
        expect(res.status).toBe(400);
        expect(db.tenant.lastResetAt).toEqual(PERIOD_START);
    });

    it('refuses every event while the signing secret is not configured', async () => {
        delete process.env.STRIPE_WEBHOOK_SECRET;
        expect((await stripeSends(renewalPaid)).status).toBe(503);
        expect(db.tenant.lastResetAt).toEqual(PERIOD_START);
    });
});

describe('the other billing routes', () => {
    it('still ask for a login', async () => {
        for (const path of ['/plans', '/usage', '/portal']) {
            expect((await fetch(`${base}${path}`)).status, path).toBe(401);
        }
        expect((await fetch(`${base}/reset-addon-limits`, { method: 'POST' })).status).toBe(401);
    });
});
