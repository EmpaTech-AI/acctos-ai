import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import {
    applyMonthlyResetIfNeeded,
    getCurrentPeriodUsage,
    getExpectedResetDate,
    getNextResetDate,
    resumeAllScenarios,
    pauseAllScenarios,
    checkAndResumeIfPossible,
    DEFAULT_BILLING_RESET_DAY,
} from '../utils/usageLimits.js';

const router = Router();

// Most billing routes require authentication
router.use(authenticateToken);

/**
 * GET /v1/billing/plans
 * List available subscription plans
 */
router.get('/plans', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;

        const plans = await prisma.plan.findMany({
            where: { isActive: true },
            orderBy: { priceMonthly: 'asc' },
        });

        // If no plans exist yet, return default plans
        if (plans.length === 0) {
            res.json({
                plans: [
                    {
                        id: 'starter',
                        name: 'Starter',
                        documentsPerMonth: 100,
                        pagesPerMonth: 1000,
                        storageGb: 5,
                        supportSla: 'standard',
                        priceMonthly: 2900, // €29
                    },
                    {
                        id: 'professional',
                        name: 'Professional',
                        documentsPerMonth: 500,
                        pagesPerMonth: 5000,
                        storageGb: 25,
                        supportSla: 'priority',
                        priceMonthly: 9900, // €99
                    },
                    {
                        id: 'enterprise',
                        name: 'Enterprise',
                        documentsPerMonth: -1, // Unlimited
                        pagesPerMonth: -1,
                        storageGb: 100,
                        supportSla: 'enterprise',
                        priceMonthly: 29900, // €299
                    },
                ],
            });
            return;
        }

        res.json({ plans });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/billing/subscription
 * Get current subscription for tenant
 */
router.get('/subscription', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const subscription = await prisma.subscription.findUnique({
            where: { tenantId },
        });

        if (!subscription) {
            return next(createError('Subscription not found', 404, 'NOT_FOUND'));
        }

        res.json(subscription);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /v1/billing/checkout
 * Create Stripe checkout session (placeholder)
 */
router.post('/checkout', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        // Stripe integration placeholder
        if (!process.env.STRIPE_SECRET_KEY) {
            res.json({
                message: 'Stripe not configured. Set STRIPE_SECRET_KEY to enable billing.',
                checkoutUrl: null,
            });
            return;
        }

        // TODO: Implement Stripe checkout
        res.json({
            message: 'Stripe checkout not yet implemented',
            checkoutUrl: null,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/billing/portal
 * Create a Stripe Billing Portal session and return the URL.
 * Requires the tenant to have a stripeCustomerId stored from a previous purchase.
 */
router.get('/portal', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.json({ portalUrl: null, message: 'Stripe not configured' });
        }

        const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
        if (!(subscription as any)?.stripeCustomerId) {
            return res.json({
                portalUrl: null,
                message: 'No Stripe customer found — please purchase a plan first',
            });
        }

        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-01-27.acacia' as any });

        const returnUrl = (req.headers.origin as string | undefined) ?? process.env.APP_URL ?? 'https://acctos.ai';
        const session = await stripe.billingPortal.sessions.create({
            customer: (subscription as any).stripeCustomerId,
            return_url: `${returnUrl}/billing`,
        });

        res.json({ portalUrl: session.url });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/billing/raw-usage
 *
 * Returns total pages and rows consumed in the last 30 days from
 * DocumentUsageAggregate. Does not depend on the new Tenant schema fields,
 * so it works before the migration runs.
 */
router.get('/raw-usage', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const from = new Date();
        from.setUTCDate(from.getUTCDate() - 30);
        from.setUTCHours(0, 0, 0, 0);

        const agg = await prisma.documentUsageAggregate.aggregate({
            where: { customerId: tenantId, date: { gte: from } },
            _sum: { pagesSpent: true, rowsUsed: true },
        });

        res.json({
            pages: agg._sum.pagesSpent ?? 0,
            rows: agg._sum.rowsUsed ?? 0,
            from: from.toISOString(),
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/billing/entitlements
 * Get current entitlements (what the tenant is allowed to do)
 */
router.get('/entitlements', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
        const tenant = await (prisma.tenant as any).findUnique({
            where: { id: tenantId },
            select: { pagesLimit: true, rowsLimit: true, scenariosPaused: true },
        });

        res.json({
            entitlements: {
                pagesPerMonth: tenant?.pagesLimit ?? 5000,
                rowsPerMonth: tenant?.rowsLimit ?? 5000,
                status: subscription?.status || 'trialing',
            },
            scenariosPaused: tenant?.scenariosPaused ?? false,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/billing/usage-status
 *
 * Returns current period usage vs limits, add-on info, pause state, and
 * next reset date. Also lazily applies the monthly reset if due.
 */
router.get('/usage-status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        // Apply monthly reset if the period has rolled over
        await applyMonthlyResetIfNeeded(prisma, tenantId);

        const tenant = await (prisma.tenant as any).findUnique({
            where: { id: tenantId },
            select: {
                pagesLimit: true, rowsLimit: true,
                addonPagesLimit: true, addonRowsLimit: true,
                scenariosPaused: true, lastResetAt: true,
                billingResetDay: true, limitWarningFiredAt: true,
            },
        });

        if (!tenant) return next(createError('Tenant not found', 404, 'NOT_FOUND'));

        const resetDay = tenant.billingResetDay ?? DEFAULT_BILLING_RESET_DAY;
        const periodStart = tenant.lastResetAt
            ? new Date(tenant.lastResetAt)
            : getExpectedResetDate(resetDay);

        const usage = await getCurrentPeriodUsage(prisma, tenantId, periodStart);

        const docsRows = await prisma.documentUsageAggregate.findMany({
            where: { customerId: tenantId, date: { gte: periodStart } },
            select: { documentsHandled: true },
        });
        const currentDocs = Math.max(0, docsRows.reduce((sum: number, r: { documentsHandled: number }) => sum + (r.documentsHandled ?? 0), 0));

        const pagesLimit     = tenant.pagesLimit     ?? 5000;
        const rowsLimit      = tenant.rowsLimit      ?? 5000;
        const addonPages     = tenant.addonPagesLimit ?? 0;
        const addonRows      = tenant.addonRowsLimit  ?? 0;
        const totalPages     = pagesLimit + addonPages;
        const totalRows      = rowsLimit  + addonRows;

        const subscription = await prisma.subscription.findUnique({ where: { tenantId } });

        // ── Low-limit warning webhook ─────────────────────────────────────────────
        // Fire once per billing period when pages or rows remaining drop to <= 500.
        // limitWarningFiredAt is cleared on each reset so it fires again next period.
        const LOW_LIMIT_THRESHOLD = 500;
        const pagesRemaining = totalPages - usage.pages;
        const rowsRemaining  = totalRows  - usage.rows;
        const isLow = pagesRemaining <= LOW_LIMIT_THRESHOLD || rowsRemaining <= LOW_LIMIT_THRESHOLD;
        const warningAlreadySent = tenant.limitWarningFiredAt &&
            tenant.limitWarningFiredAt >= periodStart;
        if (isLow && !warningAlreadySent) {
            // Mark as fired BEFORE firing webhook — if the DB update fails, skip the
            // webhook entirely so we don't spam the client on every poll cycle.
            let markedOk = false;
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { limitWarningFiredAt: new Date() },
                });
                markedOk = true;
            } catch (e: any) {
                console.warn('[usage-status] Failed to set limitWarningFiredAt — skipping webhook to prevent spam:', e.message?.split('\n')[0]);
            }
            // Only fire webhook when the guard was successfully saved
            if (markedOk) fetch('https://services.leadconnectorhq.com/hooks/M8qlENxCOGWIcTpZuQvP/webhook-trigger/fdbf74ef-26a9-4f67-9684-240092b90613', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tenantId,
                    tenantName:     (tenant as any).name ?? tenantId,
                    pagesRemaining,
                    rowsRemaining,
                    totalPagesLimit: totalPages,
                    totalRowsLimit:  totalRows,
                    currentPages:   usage.pages,
                    currentRows:    usage.rows,
                }),
            }).catch((e) => console.error('[usage-status] Low-limit webhook failed:', e));
        }

        // ── Auto-pause when limits are exceeded ───────────────────────────────────
        // usage-status is polled every ~60 s by Layout.tsx, making this the
        // reliable heartbeat that catches limit breaches regardless of whether
        // Make.com has pushed any events to /api/usage/document.
        const exceeded = usage.pages >= totalPages || usage.rows >= totalRows;
        if (exceeded && !(tenant.scenariosPaused ?? false)) {
            console.log(
                `[usage-status] Tenant ${tenantId} over limit ` +
                `(pages ${usage.pages}/${totalPages}, rows ${usage.rows}/${totalRows}). Pausing.`
            );
            // Write the DB flag synchronously so THIS response (and all
            // subsequent polls) immediately return scenariosPaused: true —
            // no waiting for the Make.com API round-trips.
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { scenariosPaused: true },
                });
                tenant.scenariosPaused = true;
            } catch (e: any) {
                console.warn('[usage-status] Failed to set scenariosPaused flag:', e.message?.split('\n')[0]);
            }
            // Fire-and-forget: stop the actual Make.com scenarios in the background.
            pauseAllScenarios(prisma, tenantId).catch((e) =>
                console.error('[usage-status] Auto-pause Make.com calls failed:', e)
            );
        }

        res.json({
            currentPages:     usage.pages,
            currentRows:      usage.rows,
            currentDocs,
            pagesLimit,
            rowsLimit,
            addonPagesLimit:  addonPages,
            addonRowsLimit:   addonRows,
            totalPagesLimit:  totalPages,
            totalRowsLimit:   totalRows,
            pagesRemaining,
            rowsRemaining,
            limitWarning:     isLow,
            scenariosPaused:  tenant.scenariosPaused ?? false,
            lastResetAt:        periodStart.toISOString(),
            nextResetAt:        getNextResetDate(resetDay).toISOString(),
            subscriptionStatus: subscription?.status || 'trialing',
            billingResetDay:    resetDay,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /v1/billing/stripe-webhook
 *
 * Handles Stripe webhook events:
 *   - checkout.session.completed      → plan purchase / add-on purchase
 *   - customer.subscription.updated   → sync status + period end (e.g. portal plan change)
 *   - customer.subscription.deleted   → mark subscription as cancelled
 *
 * Expected metadata on the Stripe payment link / checkout session:
 *   - tenantId:       tenant CUID  (OR pass via client_reference_id query param)
 *   - addonType:      "pages" | "rows"
 *   - addonQuantity:  number (e.g. 1000)
 */
router.post('/stripe-webhook', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const sig    = req.headers['stripe-signature'] as string;
        const secret = process.env.STRIPE_WEBHOOK_SECRET;

        let event: any = req.body;
        let stripe: any = null;

        // Verify signature and keep the stripe instance for later API calls
        if (process.env.STRIPE_SECRET_KEY) {
            const Stripe = (await import('stripe')).default;
            stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-01-27.acacia' as any });
            if (secret && sig) {
                try {
                    event = stripe.webhooks.constructEvent(
                        (req as any).rawBody ?? req.body,
                        sig,
                        secret
                    );
                } catch (err: any) {
                    console.warn('[Stripe Webhook] Signature verification failed:', err.message);
                    return res.status(400).json({ error: 'Invalid signature' });
                }
            }
        }

        // ── Plan limits map ──────────────────────────────────────────────────────
        const PLAN_LIMITS: Record<string, { pagesLimit: number; rowsLimit: number }> = {
            starter:      { pagesLimit: 1000,  rowsLimit: 1000  },
            professional: { pagesLimit: 5000,  rowsLimit: 5000  },
            intermediate: { pagesLimit: 10000, rowsLimit: 10000 },
            enterprise:   { pagesLimit: 15000, rowsLimit: 15000 },
        };

        // Map known Stripe payment link IDs → planId
        const PAYMENT_LINK_TO_PLAN: Record<string, string> = {
            '7sYdRa2dM25YfqydQgaZi0h': 'starter',
            '3cI4gA2dM4e60vE4fGaZi0j': 'professional',
            'eVq14o3hQfWOa6e13uaZi0s': 'intermediate',
            'aFabJ22dM8umdiqcMcaZi0i': 'enterprise',
        };

        /**
         * Apply a plan change: cancel any pre-existing Stripe subscription for this
         * tenant, then update the DB with the new plan limits and Stripe IDs.
         */
        const applyPlanChange = async (
            tenantId: string,
            planId: string,
            newStripeCustomerId?: string,
            newStripeSubscriptionId?: string,
            newCurrentPeriodEnd?: Date,
        ) => {
            const limits = PLAN_LIMITS[planId];
            if (!limits) {
                console.warn(`[Stripe Webhook] Unknown planId: ${planId}`);
                return;
            }

            // Cancel the previous Stripe subscription to prevent duplicate charges.
            // Only attempt this when we have both a Stripe client and a new subscription ID.
            if (stripe && newStripeSubscriptionId) {
                const existing = await prisma.subscription.findUnique({
                    where: { tenantId },
                    select: { stripeSubscriptionId: true } as any,
                });
                const oldSubId = (existing as any)?.stripeSubscriptionId;
                if (oldSubId && oldSubId !== newStripeSubscriptionId) {
                    try {
                        await stripe.subscriptions.cancel(oldSubId);
                        console.log(`[Stripe Webhook] Cancelled old subscription ${oldSubId} for tenant ${tenantId}`);
                    } catch (e: any) {
                        // Log but don't abort — the new plan should still be applied.
                        console.warn(`[Stripe Webhook] Failed to cancel old subscription ${oldSubId}:`, e.message);
                    }
                }
            }

            const updateData: any = { status: planId };
            if (newStripeCustomerId)     updateData.stripeCustomerId     = newStripeCustomerId;
            if (newStripeSubscriptionId) updateData.stripeSubscriptionId = newStripeSubscriptionId;
            if (newCurrentPeriodEnd)     updateData.currentPeriodEnd     = newCurrentPeriodEnd;

            await prisma.subscription.upsert({
                where:  { tenantId },
                create: { tenantId, ...updateData },
                update: updateData,
            });
            await (prisma.tenant as any).update({ where: { id: tenantId }, data: limits });

            try {
                await checkAndResumeIfPossible(prisma, tenantId);
            } catch (e) {
                console.warn('[Stripe Webhook] Auto-resume check failed after plan change:', e);
            }
            console.log(`[Stripe Webhook] Plan updated: tenant=${tenantId}, plan=${planId}, limits=${JSON.stringify(limits)}`);
        };

        // ── checkout.session.completed ───────────────────────────────────────────
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const meta    = session.metadata || {};

            const tenantId      = (meta.tenantId || session.client_reference_id) as string | undefined;
            const addonType     = meta.addonType as 'pages' | 'rows' | undefined;
            const addonQuantity = meta.addonQuantity ? parseInt(meta.addonQuantity) : 0;

            const newStripeCustomerId     = session.customer     as string | undefined;
            const newStripeSubscriptionId = session.subscription as string | undefined;

            // Resolve planId from metadata or payment-link URL
            const paymentLinkUrl: string | undefined = session.payment_link_url || session.payment_link;
            const linkKey = paymentLinkUrl ? paymentLinkUrl.split('/').pop()?.split('?')[0] : undefined;
            const planId  = (meta.planId as string | undefined) || (linkKey ? PAYMENT_LINK_TO_PLAN[linkKey] : undefined);

            // Fetch current_period_end from the subscription object when available
            let newCurrentPeriodEnd: Date | undefined;
            if (stripe && newStripeSubscriptionId) {
                try {
                    const sub = await stripe.subscriptions.retrieve(newStripeSubscriptionId);
                    if (sub.current_period_end) {
                        newCurrentPeriodEnd = new Date(sub.current_period_end * 1000);
                    }
                } catch (e: any) {
                    console.warn('[Stripe Webhook] Could not retrieve subscription for period end:', e.message);
                }
            }

            if (tenantId && planId) {
                console.log(`[Stripe Webhook] Plan purchase: tenant=${tenantId}, plan=${planId}, sub=${newStripeSubscriptionId}`);
                await applyPlanChange(tenantId, planId, newStripeCustomerId, newStripeSubscriptionId, newCurrentPeriodEnd);
            } else if (tenantId && addonType && addonQuantity > 0) {
                console.log(`[Stripe Webhook] Add-on purchase: tenant=${tenantId}, type=${addonType}, qty=${addonQuantity}`);

                const field = addonType === 'pages' ? 'addonPagesLimit' : 'addonRowsLimit';
                const current = await (prisma.tenant as any).findUnique({
                    where: { id: tenantId }, select: { [field]: true },
                });
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data:  { [field]: (current?.[field] ?? 0) + addonQuantity },
                });
                // Save customer ID even for add-on purchases (enables portal later)
                if (newStripeCustomerId) {
                    await prisma.subscription.upsert({
                        where:  { tenantId },
                        create: { tenantId, status: 'trialing', stripeCustomerId: newStripeCustomerId } as any,
                        update: { stripeCustomerId: newStripeCustomerId } as any,
                    });
                }
                try {
                    await checkAndResumeIfPossible(prisma, tenantId);
                } catch (e) {
                    console.warn('[Stripe Webhook] Auto-resume check failed:', e);
                }
            } else {
                console.warn('[Stripe Webhook] checkout.session.completed — could not determine action', { tenantId, planId, addonType, addonQuantity });
            }
        }

        // ── customer.subscription.updated ───────────────────────────────────────
        // Fired when the customer changes plan via the Billing Portal, or when
        // Stripe renews / updates the subscription. Keeps our DB in sync.
        else if (event.type === 'customer.subscription.updated') {
            const sub = event.data.object;
            const stripeSubscriptionId = sub.id as string;
            const stripeCustomerId     = sub.customer as string;
            const newStatus            = sub.status as string; // 'active' | 'past_due' | 'canceled' | etc.
            const currentPeriodEnd     = sub.current_period_end ? new Date(sub.current_period_end * 1000) : undefined;

            // Find tenant by stripeCustomerId
            const existing = await prisma.subscription.findFirst({
                where: { stripeCustomerId } as any,
            } as any) as any;

            if (existing) {
                const updateData: any = {
                    stripeSubscriptionId,
                    currentPeriodEnd,
                };

                // Map Stripe status to our plan status.
                // If status is 'active' and we already have a plan name, keep it.
                // If Stripe says 'canceled' or 'unpaid', reflect that.
                if (['canceled', 'unpaid', 'past_due'].includes(newStatus)) {
                    updateData.status = newStatus;
                }
                // If the price changed (plan switch via portal), update plan + limits
                const newPriceId = sub.items?.data?.[0]?.price?.id as string | undefined;
                if (newPriceId) {
                    // Map Stripe Price IDs → our plan names (fill these in once live)
                    const PRICE_TO_PLAN: Record<string, string> = {
                        // e.g. 'price_xxxxx': 'professional',
                    };
                    const newPlan = PRICE_TO_PLAN[newPriceId];
                    if (newPlan && PLAN_LIMITS[newPlan]) {
                        updateData.status = newPlan;
                        await (prisma.tenant as any).update({
                            where: { id: existing.tenantId },
                            data:  PLAN_LIMITS[newPlan],
                        });
                        console.log(`[Stripe Webhook] subscription.updated: plan changed to ${newPlan} for tenant ${existing.tenantId}`);
                    }
                }

                await prisma.subscription.update({
                    where: { id: existing.id },
                    data:  updateData,
                } as any);

                if (['canceled', 'unpaid'].includes(newStatus)) {
                    console.log(`[Stripe Webhook] subscription.updated: status=${newStatus} for tenant ${existing.tenantId}`);
                }
            } else {
                console.warn(`[Stripe Webhook] subscription.updated — no tenant found for customer ${stripeCustomerId}`);
            }
        }

        // ── customer.subscription.deleted ───────────────────────────────────────
        // Fired when a subscription is fully cancelled (at period end or immediately).
        else if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object;
            const stripeCustomerId = sub.customer as string;

            const existing = await prisma.subscription.findFirst({
                where: { stripeCustomerId } as any,
            } as any) as any;

            if (existing) {
                await prisma.subscription.update({
                    where: { id: existing.id },
                    data:  { status: 'canceled', currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : undefined } as any,
                } as any);
                console.log(`[Stripe Webhook] subscription.deleted: tenant ${existing.tenantId} marked as canceled`);
            } else {
                console.warn(`[Stripe Webhook] subscription.deleted — no tenant found for customer ${stripeCustomerId}`);
            }
        }

        res.json({ received: true });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /v1/billing/webhooks
 * Handle Stripe webhooks (placeholder)
 */
router.post('/webhooks', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        // Stripe webhook handling placeholder
        // TODO: Verify signature and process events
        res.json({ received: true });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /v1/billing/reset-addon-limits
 *
 * Admin-only. Resets addonPagesLimit and addonRowsLimit to 0 for this tenant.
 * Used to clear stale values left from previous systems.
 */
router.post(
    '/reset-addon-limits',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { addonPagesLimit: 0, addonRowsLimit: 0 },
            });

            res.json({ success: true, addonPagesLimit: 0, addonRowsLimit: 0 });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * PUT /v1/billing/adjust-credits
 *
 * Admin-only. Add or remove spent pages/rows for this tenant by injecting a
 * correction record into DocumentUsageAggregate for today.
 * Accepts { pages?: number, rows?: number } as deltas (positive = add, negative = remove).
 * The total current-period usage is clamped to >= 0.
 */
router.put(
    '/adjust-credits',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            const { pages, rows, docs } = req.body as { pages?: number; rows?: number; docs?: number };

            if (pages === undefined && rows === undefined && docs === undefined) {
                return next(createError('Provide pages, rows, and/or docs delta', 400, 'VALIDATION_ERROR'));
            }

            // Determine current billing period start
            const tenant = await (prisma.tenant as any).findUnique({
                where: { id: tenantId },
                select: { lastResetAt: true },
            });
            const periodStart = tenant?.lastResetAt
                ? new Date(tenant.lastResetAt)
                : getExpectedResetDate();

            // Get current usage so we can clamp the delta
            const currentUsage = await getCurrentPeriodUsage(prisma as any, tenantId, periodStart);

            // Get ALL-TIME docs total for clamping — no date filter so that docs
            // processed before the last billing reset can still be removed.
            const docsRows = docs !== undefined
                ? await prisma.documentUsageAggregate.findMany({
                    where: { customerId: tenantId },
                    select: { documentsHandled: true },
                })
                : null;
            const totalDocs = docsRows
                ? docsRows.reduce((sum: number, r: { documentsHandled: number }) => sum + (r.documentsHandled ?? 0), 0)
                : 0;

            const pagesDelta = pages !== undefined ? Math.max(-currentUsage.pages, pages) : 0;
            const rowsDelta  = rows  !== undefined ? Math.max(-currentUsage.rows,  rows)  : 0;
            const docsDelta  = docs  !== undefined ? Math.max(-totalDocs, docs)            : 0;

            // Upsert today's correction into DocumentUsageAggregate
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);

            await prisma.documentUsageAggregate.upsert({
                where: { customerId_date: { customerId: tenantId, date: today } },
                create: { customerId: tenantId, date: today, pagesSpent: pagesDelta, rowsUsed: rowsDelta, documentsHandled: docsDelta },
                update: {
                    pagesSpent:        { increment: pagesDelta },
                    rowsUsed:          { increment: rowsDelta },
                    documentsHandled:  { increment: docsDelta },
                },
            });

            // Recalculate usage after adjustment and check pause/resume
            const newUsage = await getCurrentPeriodUsage(prisma as any, tenantId, periodStart);
            const newDocsRows = await prisma.documentUsageAggregate.findMany({
                where: { customerId: tenantId, date: { gte: periodStart } },
                select: { documentsHandled: true },
            });
            const newDocs = Math.max(0, newDocsRows.reduce((sum: number, r: { documentsHandled: number }) => sum + (r.documentsHandled ?? 0), 0));
            try {
                await checkAndResumeIfPossible(prisma as any, tenantId);
            } catch (_) {}

            res.json({ success: true, currentPages: newUsage.pages, currentRows: newUsage.rows, currentDocs: newDocs });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /v1/billing/simulate-plan
 *
 * Admin-only. Applies a plan change (subscription status + limits) without
 * requiring an actual Stripe event. Used for testing plan upgrades/downgrades.
 *
 * Body: { planId: 'starter' | 'professional' | 'enterprise' }
 */
router.post(
    '/simulate-plan',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            const { planId } = req.body as { planId?: string };

            const PLAN_LIMITS: Record<string, { pagesLimit: number; rowsLimit: number }> = {
                starter:      { pagesLimit: 1000,  rowsLimit: 1000  },
                professional: { pagesLimit: 5000,  rowsLimit: 5000  },
                intermediate: { pagesLimit: 10000, rowsLimit: 10000 },
                enterprise:   { pagesLimit: 15000, rowsLimit: 15000 },
            };

            if (!planId || !PLAN_LIMITS[planId]) {
                return next(createError('Provide planId: starter | professional | intermediate | enterprise', 400, 'VALIDATION_ERROR'));
            }

            await prisma.subscription.upsert({
                where: { tenantId },
                create: { tenantId, status: planId },
                update: { status: planId },
            });

            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: PLAN_LIMITS[planId],
            });

            try {
                await checkAndResumeIfPossible(prisma, tenantId);
            } catch (e) {
                console.warn('[Simulate Plan] Auto-resume check failed:', e);
            }

            console.log(`[Simulate Plan] tenant=${tenantId}, plan=${planId}, limits=${JSON.stringify(PLAN_LIMITS[planId])}`);
            res.json({ success: true, planId, ...PLAN_LIMITS[planId] });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /v1/billing/simulate-addon
 *
 * Admin-only. Runs the same credit logic as the Stripe webhook without
 * requiring an actual Stripe event. Used for testing add-on purchases.
 *
 * Body: { addonType: 'pages' | 'rows', addonQuantity: number }
 */
router.post(
    '/simulate-addon',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            const { addonType, addonQuantity } = req.body as { addonType?: string; addonQuantity?: number };

            if ((addonType !== 'pages' && addonType !== 'rows') || !addonQuantity || addonQuantity <= 0) {
                return next(createError('Provide addonType ("pages" or "rows") and a positive addonQuantity', 400, 'VALIDATION_ERROR'));
            }

            const updateData: any = {};
            if (addonType === 'pages') {
                const current = await (prisma.tenant as any).findUnique({
                    where: { id: tenantId }, select: { addonPagesLimit: true },
                });
                updateData.addonPagesLimit = (current?.addonPagesLimit ?? 0) + addonQuantity;
            } else {
                const current = await (prisma.tenant as any).findUnique({
                    where: { id: tenantId }, select: { addonRowsLimit: true },
                });
                updateData.addonRowsLimit = (current?.addonRowsLimit ?? 0) + addonQuantity;
            }

            await (prisma.tenant as any).update({ where: { id: tenantId }, data: updateData });

            // Auto-resume scenarios if the new quota brings usage within limits
            try {
                await checkAndResumeIfPossible(prisma, tenantId);
            } catch (e) {
                console.warn('[Simulate Addon] Auto-resume check failed:', e);
            }

            console.log(`[Simulate Addon] tenant=${tenantId}, type=${addonType}, qty=${addonQuantity}`);
            res.json({ success: true, addonType, addonQuantity, ...updateData });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /v1/billing/remove-addon
 *
 * Admin-only. Decrements addonPagesLimit or addonRowsLimit by the given
 * quantity (clamped to 0). Used for testing.
 *
 * Body: { addonType: 'pages' | 'rows', addonQuantity: number }
 */
router.post(
    '/remove-addon',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) return next(createError('No tenant selected', 400, 'NO_TENANT'));

            const { addonType, addonQuantity } = req.body as { addonType?: string; addonQuantity?: number };

            if ((addonType !== 'pages' && addonType !== 'rows') || !addonQuantity || addonQuantity <= 0) {
                return next(createError('Provide addonType ("pages" or "rows") and a positive addonQuantity', 400, 'VALIDATION_ERROR'));
            }

            const field = addonType === 'pages' ? 'addonPagesLimit' : 'addonRowsLimit';
            const current = await (prisma.tenant as any).findUnique({ where: { id: tenantId }, select: { [field]: true } });
            const newValue = Math.max(0, (current?.[field] ?? 0) - addonQuantity);

            await (prisma.tenant as any).update({ where: { id: tenantId }, data: { [field]: newValue } });

            console.log(`[Remove Addon] tenant=${tenantId}, type=${addonType}, qty=${addonQuantity}, new=${newValue}`);
            res.json({ success: true, addonType, [field]: newValue });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /v1/billing/reset-usage
 *
 * Admin-only. Deletes ALL DocumentUsageEvent and DocumentUsageAggregate
 * records for this tenant, resetting pages and rows to 0 everywhere
 * (Billing page 30-day view, Document Usage tab, usage-status).
 * Make.com credits, Azure, and OpenAI usage are NOT affected.
 *
 * Also clears scenariosPaused and sets lastResetAt to now.
 */
router.post(
    '/reset-usage',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            // ── Snapshot by calendar month BEFORE deleting (permanent history) ──
            // Wrapped in try/catch — monthly_usage_snapshots table may not exist yet
            try {
                const aggregatesToSnapshot = await prisma.documentUsageAggregate.findMany({
                    where: { customerId: tenantId },
                });
                const byMonth: Record<string, { year: number; month: number; pages: number; rows: number; docs: number }> = {};
                for (const agg of aggregatesToSnapshot) {
                    const year = agg.date.getUTCFullYear();
                    const month = agg.date.getUTCMonth() + 1;
                    const key = `${year}-${month}`;
                    if (!byMonth[key]) byMonth[key] = { year, month, pages: 0, rows: 0, docs: 0 };
                    byMonth[key].pages += agg.pagesSpent;
                    byMonth[key].rows += agg.rowsUsed;
                    byMonth[key].docs += (agg as any).documentsHandled ?? 0;
                }
                for (const snap of Object.values(byMonth)) {
                    await (prisma as any).monthlyUsageSnapshot.upsert({
                        where: { tenantId_year_month: { tenantId, year: snap.year, month: snap.month } },
                        create: { tenantId, year: snap.year, month: snap.month, pagesSpent: snap.pages, rowsUsed: snap.rows, documentsHandled: snap.docs },
                        update: { pagesSpent: { increment: snap.pages }, rowsUsed: { increment: snap.rows }, documentsHandled: { increment: snap.docs } },
                    });
                }
            } catch (e: any) {
                console.warn('[Reset Usage] Snapshot skipped — DB migration pending?', e.message?.split('\n')[0]);
            }

            // Store the exact reset timestamp so that today's pre-reset
            // aggregate rows (stored as DATE = today midnight) fall *before*
            // this value and are excluded from the new period's usage query.
            const resetDate = new Date();

            // Record the new period start. scenariosPaused is cleared below,
            // only after resumeAllScenarios() has been attempted.
            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { lastResetAt: resetDate },
            });

            // Resume Make.com scenarios, then clear the paused flag.
            try {
                await resumeAllScenarios(prisma, tenantId);
            } catch (e) {
                console.warn('[Reset Usage] Auto-resume failed:', e);
            }
            // Always clear the flag after an admin reset — usage is now 0
            // so the notification must disappear regardless of Make.com outcome.
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { scenariosPaused: false, limitWarningFiredAt: null },
                });
            } catch (e: any) {
                console.warn('[Reset Usage] Failed to clear scenariosPaused flag:', e.message?.split('\n')[0]);
            }

            console.log(`[Reset Usage] Admin reset for tenant ${tenantId}: period reset to ${resetDate.toISOString()}.`);

            res.json({ success: true, resetAt: resetDate.toISOString() });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /v1/billing/pause-processing
 *
 * Admin-only. Manually pauses new processing jobs for the tenant.
 * Running jobs are NOT interrupted — they complete normally.
 * Any new upload or email that triggers processing will be rejected until resumed.
 */
router.post(
    '/pause-processing',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;
            if (!tenantId) return next(createError('No tenant selected', 400, 'NO_TENANT'));

            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { scenariosPaused: true },
            });

            console.log(`[Billing] Processing manually paused for tenant ${tenantId} by ${req.user!.email}`);
            res.json({ success: true, processingPaused: true });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * POST /v1/billing/resume-processing
 *
 * Admin-only. Resumes processing after a manual pause or limit-based auto-pause.
 * If limits are still exceeded, the next job will re-trigger the auto-pause.
 */
router.post(
    '/resume-processing',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;
            if (!tenantId) return next(createError('No tenant selected', 400, 'NO_TENANT'));

            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { scenariosPaused: false },
            });

            console.log(`[Billing] Processing manually resumed for tenant ${tenantId} by ${req.user!.email}`);
            res.json({ success: true, processingPaused: false });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * PUT /v1/billing/set-plan
 *
 * Admin-only. Manually sets the subscription plan/status for the tenant.
 * Used when a customer pays through means other than Stripe.
 * Body: { status: 'enterprise' | 'active' | 'trialing' | string }
 */
router.put(
    '/set-plan',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            const { status } = req.body as { status?: string };
            if (!status) {
                return next(createError('Provide status', 400, 'VALIDATION_ERROR'));
            }

            // Map plan id → limits (pages + rows only — does NOT touch current usage)
            const PLAN_LIMITS: Record<string, { pagesLimit: number; rowsLimit: number }> = {
                starter:      { pagesLimit: 1000,  rowsLimit: 1000  },
                professional: { pagesLimit: 5000,  rowsLimit: 5000  },
                intermediate: { pagesLimit: 10000, rowsLimit: 10000 },
                enterprise:   { pagesLimit: 15000, rowsLimit: 15000 },
            };

            await prisma.subscription.upsert({
                where: { tenantId },
                create: { tenantId, status },
                update: { status },
            });

            // Update tenant limits if this is a known plan
            if (PLAN_LIMITS[status]) {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: PLAN_LIMITS[status],
                });
            }

            res.json({ success: true, status });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * PUT /v1/billing/reset-day
 *
 * Admin-only. Changes the day of month on which the billing period resets.
 * Also updates lastResetAt so the new period starts from the most recent
 * occurrence of that day (prevents an immediate double-reset).
 *
 * Body: { day: number }  — 1–28
 */
router.put(
    '/reset-day',
    requireRole('ORG_OWNER', 'ADMIN'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const prisma: PrismaClient = req.app.locals.prisma;
            const tenantId = req.user!.tenantId;

            if (!tenantId) {
                return next(createError('No tenant selected', 400, 'NO_TENANT'));
            }

            const { day } = req.body as { day?: number };
            if (!day || !Number.isInteger(day) || day < 1 || day > 28) {
                return next(createError('Provide day between 1 and 28', 400, 'VALIDATION_ERROR'));
            }

            // Compute the most recent occurrence of this day so that usage
            // accumulated since then is correctly attributed to the new period.
            const newPeriodStart = getExpectedResetDate(day);

            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { billingResetDay: day, lastResetAt: newPeriodStart },
            });

            console.log(`[Reset Day] Tenant ${tenantId}: billing reset day set to ${day}, period starts ${newPeriodStart.toISOString()}`);

            res.json({
                success: true,
                billingResetDay: day,
                lastResetAt: newPeriodStart.toISOString(),
                nextResetAt: getNextResetDate(day).toISOString(),
            });
        } catch (error) {
            next(error);
        }
    }
);

export { router as billingRouter };
