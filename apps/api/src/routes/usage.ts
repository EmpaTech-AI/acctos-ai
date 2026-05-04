import { Router, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import { ADMIN_ROLES } from '../utils/roles.js';

const router = Router();

// All usage routes require authentication
router.use(authenticateToken);

/**
 * GET /v1/usage/summary
 * 
 * Returns aggregated usage summary for the current tenant.
 */
router.get('/summary', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const period = (req.query.period as string) || '30d';
        const days = parseInt(period.replace('d', '')) || 30;
        const fromDate = new Date();
        fromDate.setUTCDate(fromDate.getUTCDate() - days);
        fromDate.setUTCHours(0, 0, 0, 0); // Normalize to UTC start of day (aligns with @db.Date)

        // Get aggregated data
        const aggregates = await prisma.usageAggregate.groupBy({
            by: ['source'],
            where: {
                tenantId,
                date: { gte: fromDate },
            },
            _sum: {
                eventCount: true,
                totalCost: true,
                totalTokens: true,
            },
        });

        // Format response
        const summary: Record<string, {
            eventCount: number;
            totalCost: string;
            totalTokens: number;
        }> = {};

        for (const agg of aggregates) {
            summary[agg.source] = {
                eventCount: agg._sum.eventCount || 0,
                totalCost: (agg._sum.totalCost?.toNumber() || 0).toFixed(4),
                totalTokens: agg._sum.totalTokens || 0,
            };
        }

        // Calculate totals
        const totalCost = aggregates.reduce(
            (sum: number, agg: any) => sum + (agg._sum.totalCost?.toNumber() || 0),
            0
        );
        const totalEvents = aggregates.reduce(
            (sum: number, agg: any) => sum + (agg._sum.eventCount || 0),
            0
        );

        res.json({
            period: `${days}d`,
            from: fromDate.toISOString(),
            to: new Date().toISOString(),
            summary,
            totals: {
                events: totalEvents,
                cost: totalCost.toFixed(4),
                currency: 'EUR',
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/usage/timeseries
 * 
 * Returns daily usage data for charts.
 */
router.get('/timeseries', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const days = parseInt(req.query.days as string) || 30;
        const fromDate = new Date();
        fromDate.setUTCDate(fromDate.getUTCDate() - days);
        fromDate.setUTCHours(0, 0, 0, 0); // Normalize to UTC start of day (aligns with @db.Date)

        const aggregates = await prisma.usageAggregate.findMany({
            where: {
                tenantId,
                date: { gte: fromDate },
            },
            orderBy: { date: 'asc' },
        });

        // Group by date
        const byDate: Record<string, {
            date: string;
            make: { events: number; cost: number };
            azure: { events: number; cost: number };
            openai: { events: number; cost: number };
            total: { events: number; cost: number };
        }> = {};

        for (const agg of aggregates) {
            const dateKey = agg.date.toISOString().split('T')[0];

            if (!byDate[dateKey]) {
                byDate[dateKey] = {
                    date: dateKey,
                    make: { events: 0, cost: 0 },
                    azure: { events: 0, cost: 0 },
                    openai: { events: 0, cost: 0 },
                    total: { events: 0, cost: 0 },
                };
            }

            const source = agg.source as 'make' | 'azure' | 'openai';
            if (byDate[dateKey][source]) {
                byDate[dateKey][source].events += agg.eventCount;
                byDate[dateKey][source].cost += agg.totalCost.toNumber();
            }
            byDate[dateKey].total.events += agg.eventCount;
            byDate[dateKey].total.cost += agg.totalCost.toNumber();
        }

        res.json({
            data: Object.values(byDate),
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/usage/exports
 * 
 * Export usage data as CSV.
 */
router.get('/exports', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const days = parseInt(req.query.days as string) || 30;
        const fromDate = new Date();
        fromDate.setUTCDate(fromDate.getUTCDate() - days);

        const events = await prisma.usageEvent.findMany({
            where: {
                tenantId,
                timestamp: { gte: fromDate },
            },
            orderBy: { timestamp: 'desc' },
            take: 10000, // Limit for safety
        });

        // Generate CSV
        const headers = ['timestamp', 'source', 'documentType', 'fileType', 'step', 'bankCode', 'cost', 'tokens'];
        const rows = events.map((e: any) => [
            e.timestamp.toISOString(),
            e.source,
            e.documentType || '',
            e.fileType || '',
            e.step || '',
            e.bankCode || '',
            e.cost?.toString() || '0',
            e.tokens?.toString() || '0',
        ]);

        const csv = [headers.join(','), ...rows.map((r: string[]) => r.join(','))].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=usage-export-${Date.now()}.csv`);
        res.send(csv);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/usage/document-usage
 *
 * Query document usage for the authenticated tenant (JWT-based).
 * This is for dashboard use - no API key required.
 */
router.get('/document-usage', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        // Get query parameters
        const from = req.query.from as string;
        const to = req.query.to as string;

        // Build where clause
        const where: any = { customerId: tenantId };

        if (from || to) {
            where.date = {};
            if (from) {
                where.date.gte = new Date(from);
            }
            if (to) {
                where.date.lte = new Date(to);
            }
        }

        // Get aggregated data
        const aggregates = await prisma.documentUsageAggregate.findMany({
            where,
            orderBy: { date: 'asc' },
        });

        // Calculate totals
        const totals = {
            pagesSpent: aggregates.reduce((sum: number, agg: { pagesSpent: number }) => sum + agg.pagesSpent, 0),
            rowsUsed: aggregates.reduce((sum: number, agg: { rowsUsed: number }) => sum + agg.rowsUsed, 0),
            documentsHandled: aggregates.reduce((sum: number, agg: { documentsHandled: number }) => sum + agg.documentsHandled, 0),
        };

        // Format response
        res.json({
            customerId: tenantId,
            from: from || null,
            to: to || null,
            days: aggregates.map((agg: { date: Date; pagesSpent: number; rowsUsed: number; documentsHandled: number }) => ({
                date: agg.date.toISOString().split('T')[0],
                pagesSpent: agg.pagesSpent,
                rowsUsed: agg.rowsUsed,
                documentsHandled: agg.documentsHandled,
            })),
            totals,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/usage/openai-costs
 *
 * Fetches real token usage from the OpenAI Organization Usage API and converts
 * it to EUR using GPT-4o pricing.
 *
 * Requires an admin-level API key (sk-admin-... or an org-level project key
 * with "View usage" permission). A standard sk-proj-... key will return 403.
 *
 * Pricing applied (GPT-4o):
 *   Input  tokens : $2.50  / 1M
 *   Output tokens : $10.00 / 1M
 *   USD → EUR     : fixed rate 0.93
 */
router.get('/openai-costs', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const apiKey = process.env.OPENAI_API_KEY;

        if (!apiKey) {
            return res.json({
                inputTokens: 0, outputTokens: 0, totalTokens: 0,
                costUsd: '0.0000', costEur: '0.00',
                error: 'OPENAI_API_KEY not configured',
            });
        }

        const days = Math.min(parseInt((req.query.days as string) || '30'), 90);

        const now = new Date();
        const endTime = Math.floor(now.getTime() / 1000);
        const startTime = Math.floor(new Date(now.getTime() - days * 24 * 60 * 60 * 1000).getTime() / 1000);

        let inputTokens = 0;
        let outputTokens = 0;
        let after: string | null = null;
        let hasMore = true;

        while (hasMore) {
            const url = new URL('https://api.openai.com/v1/organization/usage/completions');
            url.searchParams.set('start_time', startTime.toString());
            url.searchParams.set('end_time', endTime.toString());
            url.searchParams.set('bucket_width', '1d');
            if (after) url.searchParams.set('after', after);

            const response = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${apiKey}` },
            });

            const data: any = await response.json().catch(() => null);

            if (!response.ok) {
                const msg = data?.error?.message || `OpenAI API error ${response.status}`;
                return res.json({
                    inputTokens: 0, outputTokens: 0, totalTokens: 0,
                    costUsd: '0.0000', costEur: '0.00',
                    error: msg,
                });
            }

            if (!data?.data) break;

            for (const bucket of data.data) {
                for (const result of bucket.results ?? []) {
                    inputTokens  += result.input_tokens  ?? 0;
                    outputTokens += result.output_tokens ?? 0;
                }
            }

            hasMore = data.has_more === true;
            after = data.next_page ?? null;
            if (!after) hasMore = false;
        }

        // GPT-4o pricing (USD per token)
        const INPUT_RATE  = 2.50  / 1_000_000;
        const OUTPUT_RATE = 10.00 / 1_000_000;
        const EUR_RATE    = 0.93;

        const costUsd = inputTokens * INPUT_RATE + outputTokens * OUTPUT_RATE;
        const costEur = costUsd * EUR_RATE;

        res.json({
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUsd: costUsd.toFixed(4),
            costEur: costEur.toFixed(2),
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /v1/usage/monthly-history
 *
 * Returns permanent monthly usage snapshots + current live month data.
 * Admin only.
 */
router.get('/monthly-history', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];

        // Get all saved snapshots
        const snapshots = await (prisma as any).monthlyUsageSnapshot.findMany({
            where: { tenantId },
            orderBy: [{ year: 'asc' }, { month: 'asc' }],
        });

        // Get current month live data from aggregate
        const now = new Date();
        const currentYear = now.getUTCFullYear();
        const currentMonth = now.getUTCMonth() + 1;
        const currentMonthStart = new Date(Date.UTC(currentYear, now.getUTCMonth(), 1));

        const currentAgg = await prisma.documentUsageAggregate.aggregate({
            where: { customerId: tenantId, date: { gte: currentMonthStart } },
            _sum: { pagesSpent: true, rowsUsed: true, documentsHandled: true },
        });

        const months = snapshots.map((s: any) => ({
            year: s.year,
            month: s.month,
            monthLabel: `${MONTH_NAMES[s.month - 1]} ${s.year}`,
            pagesSpent: s.pagesSpent,
            rowsUsed: s.rowsUsed,
            documentsHandled: s.documentsHandled ?? 0,
            isCurrent: s.year === currentYear && s.month === currentMonth,
        }));

        // Add or update current month entry
        const currentMonthEntry = {
            year: currentYear,
            month: currentMonth,
            monthLabel: `${MONTH_NAMES[currentMonth - 1]} ${currentYear}`,
            pagesSpent: currentAgg._sum.pagesSpent ?? 0,
            rowsUsed: currentAgg._sum.rowsUsed ?? 0,
            documentsHandled: (currentAgg._sum as any).documentsHandled ?? 0,
            isCurrent: true,
        };
        const existingIdx = months.findIndex((m: any) => m.year === currentYear && m.month === currentMonth);
        if (existingIdx >= 0) {
            months[existingIdx] = currentMonthEntry;
        } else {
            months.push(currentMonthEntry);
        }

        // Sort most recent first
        months.sort((a: any, b: any) => b.year !== a.year ? b.year - a.year : b.month - a.month);

        res.json({ months });
    } catch (error) {
        next(error);
    }
});

export { router as usageRouter };
