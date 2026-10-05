import { PrismaClient } from '@prisma/client';
import { PAYMENT_FAILED_STATUSES, startNewBillingPeriod } from './usageLimits.js';

// `Subscription.status` stores the plan name, so a status Stripe overwrote with
// 'past_due' / 'unpaid' is restored from the limits the plan gave the tenant.
const PLAN_BY_PAGES_LIMIT: Record<number, string> = {
    1000:  'starter',
    5000:  'professional',
    10000: 'intermediate',
    15000: 'enterprise',
};

export function planFromLimits(pagesLimit?: number | null): string {
    return PLAN_BY_PAGES_LIMIT[pagesLimit ?? -1] ?? 'active';
}

/**
 * Finds the tenant a Stripe invoice belongs to: by Stripe customer, then by
 * Stripe subscription, then by a `tenantId` in the subscription's metadata.
 * `existing` is the tenant's subscription record when one matched by Stripe id.
 */
async function findTenantForInvoice(prisma: PrismaClient, invoice: any) {
    // Stripe moved the subscription fields under `parent` in newer API versions.
    const details = invoice?.parent?.subscription_details ?? invoice?.subscription_details ?? {};
    const idOf = (v: any): string | undefined => (typeof v === 'string' ? v : v?.id) || undefined;
    const customerId     = idOf(invoice?.customer);
    const subscriptionId = idOf(details.subscription ?? invoice?.subscription);
    const metaTenantId   = details.metadata?.tenantId as string | undefined;

    let existing: any = null;
    if (customerId) {
        existing = await prisma.subscription.findFirst({ where: { stripeCustomerId: customerId } as any } as any);
    }
    if (!existing && subscriptionId) {
        existing = await prisma.subscription.findFirst({ where: { stripeSubscriptionId: subscriptionId } as any } as any);
    }
    const tenantId: string | undefined = existing?.tenantId ?? metaTenantId;
    return { existing, tenantId, customerId, subscriptionId };
}

export type RenewalResult =
    | { applied: true; tenantId: string; periodStart: Date; pauseLifted: boolean }
    | { applied: false; reason: 'not_a_renewal' }
    | { applied: false; reason: 'no_tenant'; customerId?: string }
    | { applied: false; reason: 'already_applied'; tenantId: string };

/**
 * Handles Stripe's `invoice.paid` for a subscription renewal: the tenant's new
 * billing period starts at the moment of payment — usage counts from zero and a
 * pause caused by a used-up limit is lifted.
 *
 * For a tenant on a Stripe subscription this is the ONLY thing that starts a new
 * period. There is deliberately no calendar fallback: a renewal that does not
 * arrive must leave the tenant where it is, so that someone looks at the payment.
 *
 * Origin: a renewal was paid on 4 Oct 2026 and the tenant stayed blocked. Nothing
 * listened for the payment, and the calendar reset left the pause flag set.
 *
 * Only renewals (`billing_reason: subscription_cycle`) count. The first invoice
 * of a subscription is handled by checkout.session.completed, and proration or
 * manual invoices are not a new period.
 *
 * Linking by metadata also records the Stripe ids for next time. Safe to receive
 * twice: an event older than the tenant's current period start is ignored.
 */
export async function applyPaidRenewal(prisma: PrismaClient, invoice: any): Promise<RenewalResult> {
    if (invoice?.billing_reason !== 'subscription_cycle') return { applied: false, reason: 'not_a_renewal' };

    const found = await findTenantForInvoice(prisma, invoice);
    const { tenantId, customerId, subscriptionId } = found;
    let existing = found.existing;
    if (!tenantId) return { applied: false, reason: 'no_tenant', customerId };

    const tenant = await (prisma.tenant as any).findUnique({
        where: { id: tenantId },
        select: { lastResetAt: true, pagesLimit: true },
    });
    if (!tenant) return { applied: false, reason: 'no_tenant', customerId };

    // Record the Stripe ids even for an event that turns out to be old: they are
    // what puts the tenant on the payment clock instead of the calendar.
    if (!existing) existing = await prisma.subscription.findUnique({ where: { tenantId } });
    const link: any = {};
    if (customerId     && existing?.stripeCustomerId     !== customerId)     link.stripeCustomerId     = customerId;
    if (subscriptionId && existing?.stripeSubscriptionId !== subscriptionId) link.stripeSubscriptionId = subscriptionId;
    if (!existing) link.status = planFromLimits(tenant.pagesLimit);
    if (Object.keys(link).length > 0) {
        await prisma.subscription.upsert({
            where:  { tenantId },
            create: { tenantId, ...link },
            update: link,
        } as any);
    }

    const paidAtSec = invoice.status_transitions?.paid_at;
    const periodStart = paidAtSec ? new Date(paidAtSec * 1000) : new Date();
    if (tenant.lastResetAt && new Date(tenant.lastResetAt) >= periodStart) {
        return { applied: false, reason: 'already_applied', tenantId };
    }

    if (existing && PAYMENT_FAILED_STATUSES.includes(existing.status)) {
        await prisma.subscription.update({
            where: { tenantId },
            data:  { status: planFromLimits(tenant.pagesLimit) },
        });
    }

    const { pauseLifted } = await startNewBillingPeriod(prisma, tenantId, periodStart);
    return { applied: true, tenantId, periodStart, pauseLifted };
}

export interface FailedPayment {
    /** The tenant's name, or the Stripe customer's when no tenant is linked. */
    clientName:     string;
    tenantId?:      string;
    customerId?:    string;
    customerEmail?: string;
    amountDue:      number;   // in the currency's minor unit, as Stripe sends it
    currency:       string;
    attempt:        number;
    /** When Stripe will try again by itself; null when it has given up. */
    nextAttempt:    Date | null;
    invoiceUrl?:    string;
    isRenewal:      boolean;
}

/**
 * Reads Stripe's `invoice.payment_failed` into what the team needs to act on.
 * Changes nothing: a failed renewal simply never starts the tenant's new period.
 * Stripe sends the event again for every automatic retry that fails.
 */
export async function describeFailedPayment(prisma: PrismaClient, invoice: any): Promise<FailedPayment> {
    const { tenantId, customerId } = await findTenantForInvoice(prisma, invoice);
    const tenant = tenantId
        ? await (prisma.tenant as any).findUnique({ where: { id: tenantId }, select: { name: true } })
        : null;

    return {
        clientName:    tenant?.name ?? invoice?.customer_name ?? invoice?.customer_email ?? customerId ?? 'unknown customer',
        tenantId:      tenant ? tenantId : undefined,
        customerId,
        customerEmail: invoice?.customer_email ?? undefined,
        amountDue:     invoice?.amount_due ?? 0,
        currency:      invoice?.currency ?? 'gbp',
        attempt:       invoice?.attempt_count ?? 1,
        nextAttempt:   invoice?.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
        invoiceUrl:    invoice?.hosted_invoice_url ?? undefined,
        isRenewal:     invoice?.billing_reason === 'subscription_cycle',
    };
}
