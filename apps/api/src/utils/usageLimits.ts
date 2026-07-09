import axios from 'axios';
import { PrismaClient } from '@prisma/client';

// ── Tier → limit mapping ──────────────────────────────────────────────────────
export const TIER_LIMITS: Record<number, { pages: number; rows: number }> = {
    0: { pages: 5000,  rows: 5000  }, // Trial / default
    1: { pages: 1000,  rows: 1000  }, // Starter
    2: { pages: 5000,  rows: 5000  }, // Professional
    3: { pages: 15000, rows: 15000 }, // Enterprise
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Default billing reset day of month (1–28). */
export const DEFAULT_BILLING_RESET_DAY = 4;

/**
 * Returns the start date of the current billing period (resetDay of current or
 * previous month, whichever has already passed).
 */
export function getExpectedResetDate(resetDay = DEFAULT_BILLING_RESET_DAY): Date {
    const now = new Date();
    if (now.getUTCDate() >= resetDay) {
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay));
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, resetDay));
}

/**
 * Returns the start date of the NEXT billing period.
 */
export function getNextResetDate(resetDay = DEFAULT_BILLING_RESET_DAY): Date {
    const now = new Date();
    if (now.getUTCDate() >= resetDay) {
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, resetDay));
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay));
}

/**
 * Lazy monthly reset: checks if the billing period has rolled over and if so,
 * clears add-on credits, updates lastResetAt, and auto-resumes scenarios for
 * active subscribers.
 *
 * Returns true if a reset was applied.
 */
export async function applyMonthlyResetIfNeeded(
    prisma: PrismaClient,
    tenantId: string
): Promise<boolean> {
    try {
        const tenant = await (prisma.tenant as any).findUnique({
            where: { id: tenantId },
            select: { lastResetAt: true, scenariosPaused: true, billingResetDay: true },
        });
        if (!tenant) return false;

        const resetDay = tenant.billingResetDay ?? DEFAULT_BILLING_RESET_DAY;
        const expectedReset = getExpectedResetDate(resetDay);
        const needsReset = !tenant.lastResetAt || new Date(tenant.lastResetAt) < expectedReset;
        if (!needsReset) return false;

        // Check whether this tenant has an active subscription
        const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
        const isSubscribed = subscription?.status === 'active';

        // Clear add-on credits (they expire each billing period) and record reset.
        // scenariosPaused is NOT cleared here — it is cleared only after
        // resumeAllScenarios() confirms the scenarios are actually resuming,
        // so the notification stays visible until Make.com has been contacted.
        await (prisma.tenant as any).update({
            where: { id: tenantId },
            data: {
                addonPagesLimit: 0,
                addonRowsLimit: 0,
                lastResetAt: expectedReset,
                billingResetDay: resetDay,
            },
        });
        // Clear warning flag if column exists (added in later migration)
        try {
            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { limitWarningFiredAt: null },
            });
        } catch { /* column may not exist yet */ }

        if (isSubscribed && tenant.scenariosPaused) {
            try {
                await resumeAllScenarios(prisma, tenantId);
            } catch (e) {
                console.warn('[Monthly Reset] Auto-resume failed:', e);
            }
            // Always clear the flag after a billing-period reset: limits are
            // back to 0, so the pause notification must disappear regardless
            // of whether the Make.com API calls succeeded.
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { scenariosPaused: false },
                });
            } catch (e: any) {
                console.warn('[Monthly Reset] Failed to clear scenariosPaused flag:', e.message?.split('\n')[0]);
            }
        }

        console.log(`[Monthly Reset] Tenant ${tenantId} reset. isSubscribed=${isSubscribed}`);
        return true;
    } catch (e: any) {
        // Gracefully skip if the DB migration adding these fields hasn't been run yet
        console.warn('[Monthly Reset] Skipped — DB migration pending?', e.message?.split('\n')[0]);
        return false;
    }
}

/**
 * Sums pages and rows consumed since `periodStart` from DocumentUsageAggregate.
 */
export async function getCurrentPeriodUsage(
    prisma: PrismaClient,
    tenantId: string,
    periodStart: Date
): Promise<{ pages: number; rows: number }> {
    const agg = await prisma.documentUsageAggregate.aggregate({
        where: { customerId: tenantId, date: { gte: periodStart } },
        _sum: { pagesSpent: true, rowsUsed: true },
    });
    return {
        pages: Math.max(0, agg._sum.pagesSpent ?? 0),
        rows: Math.max(0, agg._sum.rowsUsed ?? 0),
    };
}

// ── Make.com helpers ──────────────────────────────────────────────────────────

async function fetchScenarios(
    prisma: PrismaClient,
    tenantId: string
): Promise<{ id: string; name: string }[]> {
    const tenant = await (prisma.tenant as any).findUnique({
        where: { id: tenantId },
        select: { makeApiKey: true, makeOrgId: true, makeFolderId: true },
    });
    if (!tenant?.makeApiKey) return [];

    const headers = { 'Authorization': `Token ${tenant.makeApiKey}` };
    const cfg = { headers, timeout: 10000 };

    let organizationId: string | undefined = tenant.makeOrgId || undefined;
    if (!organizationId) {
        try {
            const r = await axios.get('https://eu2.make.com/api/v2/users/me', cfg);
            const u = r.data.authUser || r.data.user;
            organizationId = u?.organizationId || r.data?.organizationId;
        } catch { /* ignore */ }
    }
    if (!organizationId) {
        try {
            const r = await axios.get('https://eu2.make.com/api/v2/organizations', cfg);
            organizationId = r.data.organizations?.[0]?.id;
        } catch { /* ignore */ }
    }
    if (!organizationId) return [];

    // Use the tenant's configured folder, falling back to the default production folder
    const folderId = tenant.makeFolderId || process.env.MAKE_FOLDER_ID || '449625';
    let url = `https://eu2.make.com/api/v2/scenarios?organizationId=${organizationId}&limit=200&folderId=${folderId}`;

    try {
        const r = await axios.get(url, cfg);
        return r.data.scenarios ?? [];
    } catch (e: any) {
        console.error('[usageLimits] Failed to fetch scenarios:', e.message);
        return [];
    }
}

/**
 * Pauses all Make.com scenarios for a tenant and marks the DB flag.
 */
export async function pauseAllScenarios(
    prisma: PrismaClient,
    tenantId: string
): Promise<{ paused: number; failed: number }> {
    const tenant = await (prisma.tenant as any).findUnique({
        where: { id: tenantId },
        select: { makeApiKey: true },
    });

    if (!tenant?.makeApiKey) return { paused: 0, failed: 0 };

    const scenarios = await fetchScenarios(prisma, tenantId);
    const headers = { 'Authorization': `Token ${tenant.makeApiKey}` };
    let paused = 0, failed = 0;

    for (const s of scenarios) {
        try {
            await axios.post(
                `https://eu2.make.com/api/v2/scenarios/${s.id}/stop`,
                undefined,
                { headers, timeout: 5000 }
            );
            paused++;
        } catch (e: any) {
            const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            console.warn(`[Pause] Scenario ${s.id} (${s.name}): ${detail}`);
            failed++;
        }
    }

    console.log(`[Pause] Tenant ${tenantId}: ${paused} paused, ${failed} failed`);

    // Only update the DB flag if at least one scenario was actually paused
    if (paused > 0) {
        try {
            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { scenariosPaused: true },
            });
        } catch (e: any) {
            console.warn('[Pause] DB flag skipped — migration pending?', e.message?.split('\n')[0]);
        }
    }

    return { paused, failed };
}

/**
 * Resumes all Make.com scenarios for a tenant and clears the DB flag.
 */
export async function resumeAllScenarios(
    prisma: PrismaClient,
    tenantId: string
): Promise<{ resumed: number; failed: number }> {
    const tenant = await (prisma.tenant as any).findUnique({
        where: { id: tenantId },
        select: { makeApiKey: true },
    });

    if (!tenant?.makeApiKey) return { resumed: 0, failed: 0 };

    const scenarios = await fetchScenarios(prisma, tenantId);
    const headers = { 'Authorization': `Token ${tenant.makeApiKey}` };
    let resumed = 0, failed = 0;

    for (const s of scenarios) {
        try {
            await axios.post(
                `https://eu2.make.com/api/v2/scenarios/${s.id}/start`,
                undefined,
                { headers, timeout: 5000 }
            );
            resumed++;
        } catch (e: any) {
            const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            console.warn(`[Resume] Scenario ${s.id} (${s.name}): ${detail}`);
            failed++;
        }
    }

    console.log(`[Resume] Tenant ${tenantId}: ${resumed} resumed, ${failed} failed`);

    // Only clear the DB flag if at least one scenario was actually resumed
    if (resumed > 0) {
        try {
            await (prisma.tenant as any).update({
                where: { id: tenantId },
                data: { scenariosPaused: false },
            });
        } catch (e: any) {
            console.warn('[Resume] DB flag skipped — migration pending?', e.message?.split('\n')[0]);
        }
    }

    return { resumed, failed };
}

/**
 * If scenarios are currently paused and usage is now within limits (e.g. after
 * an add-on purchase), automatically resumes all scenarios.
 *
 * Returns true if scenarios were resumed.
 */
export async function checkAndResumeIfPossible(
    prisma: PrismaClient,
    tenantId: string
): Promise<boolean> {
    try {
        const tenant = await (prisma.tenant as any).findUnique({
            where: { id: tenantId },
            select: {
                pagesLimit: true, rowsLimit: true,
                addonPagesLimit: true, addonRowsLimit: true,
                scenariosPaused: true, lastResetAt: true,
            },
        });
        if (!tenant || !tenant.scenariosPaused) return false;

        const periodStart = tenant.lastResetAt
            ? new Date(tenant.lastResetAt)
            : getExpectedResetDate();

        const usage = await getCurrentPeriodUsage(prisma, tenantId, periodStart);

        const totalPages = (tenant.pagesLimit ?? 5000) + (tenant.addonPagesLimit ?? 0);
        const totalRows  = (tenant.rowsLimit  ?? 5000) + (tenant.addonRowsLimit  ?? 0);

        if (usage.pages < totalPages && usage.rows < totalRows) {
            console.log(`[Auto-Resume] Tenant ${tenantId} now within limits — resuming scenarios.`);
            await resumeAllScenarios(prisma, tenantId);
            // Ensure the DB flag is cleared so the notification disappears even if
            // Make.com reported scenarios as already-running (resumed = 0, failed = 0).
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { scenariosPaused: false },
                });
            } catch (e: any) {
                console.warn('[Auto-Resume] Failed to clear scenariosPaused flag:', e.message?.split('\n')[0]);
            }
            return true;
        }

        return false;
    } catch (e: any) {
        console.warn('[Auto-Resume] Skipped:', e.message?.split('\n')[0]);
        return false;
    }
}

/**
 * Checks whether current period usage exceeds limits and pauses scenarios if so.
 * Also applies the monthly reset lazily.
 *
 * Returns true if scenarios were newly paused.
 */
export async function checkAndPauseIfNeeded(
    prisma: PrismaClient,
    tenantId: string
): Promise<boolean> {
    try {
        // Apply any pending monthly reset first
        await applyMonthlyResetIfNeeded(prisma, tenantId);

        const tenant = await (prisma.tenant as any).findUnique({
            where: { id: tenantId },
            select: {
                pagesLimit: true, rowsLimit: true,
                addonPagesLimit: true, addonRowsLimit: true,
                scenariosPaused: true, lastResetAt: true,
            },
        });
        if (!tenant) return false;

        const periodStart = tenant.lastResetAt
            ? new Date(tenant.lastResetAt)
            : getExpectedResetDate();

        const usage = await getCurrentPeriodUsage(prisma, tenantId, periodStart);

        const totalPages = (tenant.pagesLimit ?? 5000) + (tenant.addonPagesLimit ?? 0);
        const totalRows  = (tenant.rowsLimit  ?? 5000) + (tenant.addonRowsLimit  ?? 0);

        const exceeded = usage.pages >= totalPages || usage.rows >= totalRows;

        if (exceeded && !tenant.scenariosPaused) {
            console.log(
                `[Limit] Tenant ${tenantId} exceeded limits ` +
                `(pages ${usage.pages}/${totalPages}, rows ${usage.rows}/${totalRows}). Pausing.`
            );
            await pauseAllScenarios(prisma, tenantId);
            // Ensure the DB flag is set regardless of Make.com API outcome so
            // the dashboard notification always reflects the exceeded-limit state.
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { scenariosPaused: true },
                });
            } catch (e: any) {
                console.warn('[Limit Check] Failed to persist scenariosPaused flag:', e.message?.split('\n')[0]);
            }
            return true;
        }

        return false;
    } catch (e: any) {
        // Gracefully skip if the DB migration adding these fields hasn't been run yet
        console.warn('[Limit Check] Skipped — DB migration pending?', e.message?.split('\n')[0]);
        return false;
    }
}

/**
 * Gate check: should a NEW processing job be allowed to start for this tenant?
 *
 * - Returns { allowed: false, reason: 'paused' } when scenariosPaused is true
 *   (set either by limit auto-pause or by an admin manual stop).
 * - Returns { allowed: false, reason: 'limit_exceeded' } when current-period
 *   usage >= plan limits; also sets scenariosPaused=true as a side-effect.
 * - Returns { allowed: true } otherwise.
 *
 * Call this at the START of every job, before any work begins. Never call it
 * mid-job — running jobs always complete regardless of limit state.
 * Fails open (returns allowed: true) on DB errors so a DB blip never blocks
 * legitimate processing.
 */
export async function checkProcessingAllowed(
    prisma: PrismaClient,
    tenantId: string,
): Promise<{ allowed: true } | { allowed: false; reason: 'paused' | 'limit_exceeded' }> {
    try {
        const tenant = await (prisma.tenant as any).findUnique({
            where: { id: tenantId },
            select: {
                scenariosPaused: true,
                pagesLimit: true,
                rowsLimit: true,
                addonPagesLimit: true,
                addonRowsLimit: true,
                lastResetAt: true,
                billingResetDay: true,
            },
        });
        if (!tenant) return { allowed: true }; // unknown tenant — don't block

        if (tenant.scenariosPaused) {
            return { allowed: false, reason: 'paused' };
        }

        const resetDay   = tenant.billingResetDay ?? DEFAULT_BILLING_RESET_DAY;
        const periodStart = tenant.lastResetAt
            ? new Date(tenant.lastResetAt)
            : getExpectedResetDate(resetDay);
        const usage      = await getCurrentPeriodUsage(prisma, tenantId, periodStart);
        const totalPages = (tenant.pagesLimit ?? 5000) + (tenant.addonPagesLimit ?? 0);
        const totalRows  = (tenant.rowsLimit  ?? 5000) + (tenant.addonRowsLimit  ?? 0);

        if (usage.pages >= totalPages || usage.rows >= totalRows) {
            // Auto-set the paused flag so subsequent checks are fast (DB read only)
            try {
                await (prisma.tenant as any).update({
                    where: { id: tenantId },
                    data: { scenariosPaused: true },
                });
            } catch { /* non-fatal */ }
            return { allowed: false, reason: 'limit_exceeded' };
        }

        return { allowed: true };
    } catch (e: any) {
        // Fail open — a DB error should never block legitimate processing
        console.warn('[checkProcessingAllowed] DB error, allowing job:', e.message?.split('\n')[0]);
        return { allowed: true };
    }
}
