/**
 * A tenant is charged for each file once, however many times it is processed.
 *
 * Origin: three statements of 12 pages were processed as VAT on 25 Sep 2026 with
 * wrong numbers, and again after a parser fix. Every completed run charged the
 * 12 pages again, so correcting our own mistake cost the client.
 *
 * Prisma is faked: no database is touched. Hashes are made up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recordOrchestratorUsage } from '../usageLimits.js';

function fakePrisma() {
    const events: any[] = [];
    const charged = { pages: 0, rows: 0, docs: 0 };
    const prisma = {
        tenant: { findUnique: async () => null },   // the limit re-check finds no tenant and stops
        documentUsageEvent: {
            findFirst: async (args: any) => events
                .filter(e => e.customerId === args.where.customerId
                    && e.idempotencyKey.startsWith(args.where.idempotencyKey.startsWith))
                .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0] ?? null,
            create: async (args: any) => {
                const d = args.data;
                if (events.some(e => e.customerId === d.customerId && e.idempotencyKey === d.idempotencyKey)) {
                    throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
                }
                events.push({ ...d });
            },
        },
        documentUsageAggregate: {
            upsert: async (args: any) => {
                charged.pages += args.create.pagesSpent;
                charged.rows  += args.create.rowsUsed;
                charged.docs  += args.create.documentsHandled;
            },
        },
    };
    return { prisma: prisma as any, events, charged };
}

const T = 'tenant-1';
const START = new Date('2026-10-06T09:00:00Z');
const hoursLater = (h: number) => new Date(START.getTime() + h * 3_600_000);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

describe('recordOrchestratorUsage', () => {
    it('charges every file of a first run', async () => {
        const { prisma, charged } = fakePrisma();

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [
            { hash: 'jul', pages: 3, rows: 0 },
            { hash: 'aug', pages: 4, rows: 0 },
        ] });
        expect(charged).toEqual({ pages: 7, rows: 0, docs: 2 });
    });

    it('charges nothing when the same files are run again', async () => {
        const { prisma, charged } = fakePrisma();
        const files = [{ hash: 'jul', pages: 3, rows: 0 }, { hash: 'aug', pages: 4, rows: 0 }];

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files });
        vi.setSystemTime(hoursLater(24));
        await recordOrchestratorUsage(prisma, T, { jobId: 'job-2', files: files.map(f => ({ ...f, cachedAt: START })) });
        expect(charged).toEqual({ pages: 7, rows: 0, docs: 2 });
    });

    it('charges only the statement that was added to a repeated run', async () => {
        const { prisma, charged } = fakePrisma();

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [{ hash: 'jul', pages: 3, rows: 0 }] });
        await recordOrchestratorUsage(prisma, T, { jobId: 'job-2', files: [
            { hash: 'jul', pages: 3, rows: 0, cachedAt: START },
            { hash: 'sep', pages: 5, rows: 0 },
        ] });
        expect(charged).toEqual({ pages: 8, rows: 0, docs: 2 });
    });

    it('charges an Excel statement its rows once', async () => {
        const { prisma, charged } = fakePrisma();
        const file = { hash: 'export', pages: 0, rows: 747 };

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [file] });
        await recordOrchestratorUsage(prisma, T, { jobId: 'job-2', files: [file] });
        expect(charged).toEqual({ pages: 0, rows: 747, docs: 1 });
    });

    it('charges each tenant for the same file separately', async () => {
        const { prisma, charged } = fakePrisma();
        const files = [{ hash: 'jul', pages: 3, rows: 0 }];

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files });
        await recordOrchestratorUsage(prisma, 'tenant-2', { jobId: 'job-2', files });
        expect(charged).toEqual({ pages: 6, rows: 0, docs: 2 });
    });

    it('treats a cached file read before per-file records existed as already charged', async () => {
        const { prisma, charged } = fakePrisma();
        const lastMonth = new Date('2026-09-25T16:10:00Z');

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [
            { hash: 'old', pages: 12, rows: 0, cachedAt: lastMonth },
            { hash: 'new', pages: 5, rows: 0 },
        ] });
        expect(charged).toEqual({ pages: 5, rows: 0, docs: 1 });

        // and it stays free on later runs, also after other files have been recorded
        vi.setSystemTime(hoursLater(48));
        await recordOrchestratorUsage(prisma, T, { jobId: 'job-2', files: [{ hash: 'old', pages: 12, rows: 0, cachedAt: lastMonth }] });
        await recordOrchestratorUsage(prisma, T, { jobId: 'job-3', files: [{ hash: 'older', pages: 9, rows: 0, cachedAt: lastMonth }] });
        expect(charged).toEqual({ pages: 5, rows: 0, docs: 1 });
    });

    it('charges a cached file whose first run failed, so it was never charged', async () => {
        const { prisma, charged } = fakePrisma();

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [{ hash: 'jul', pages: 3, rows: 0 }] });
        // 'aug' was read an hour later by a job that failed; the replay takes it from the cache
        vi.setSystemTime(hoursLater(2));
        await recordOrchestratorUsage(prisma, T, { jobId: 'job-3', files: [{ hash: 'aug', pages: 4, rows: 0, cachedAt: hoursLater(1) }] });
        expect(charged).toEqual({ pages: 7, rows: 0, docs: 2 });
    });

    it('records nothing for a file that cost nothing', async () => {
        const { prisma, events, charged } = fakePrisma();

        await recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [{ hash: 'empty', pages: 0, rows: 0 }] });
        expect(events).toEqual([]);
        expect(charged).toEqual({ pages: 0, rows: 0, docs: 0 });
    });

    it('never throws on a database error', async () => {
        const prisma = { documentUsageEvent: { findFirst: async () => { throw new Error('db down'); } } } as any;

        await expect(recordOrchestratorUsage(prisma, T, { jobId: 'job-1', files: [{ hash: 'jul', pages: 3, rows: 0 }] }))
            .resolves.toBeUndefined();
    });
});
