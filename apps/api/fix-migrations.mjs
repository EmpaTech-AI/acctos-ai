// Runs before `prisma migrate deploy` to remove any stuck failed-migration records.
// Safe to run repeatedly — only deletes rows where finished_at IS NULL (actually failed).
// After deletion, `migrate deploy` re-runs the migration file cleanly.
import { PrismaClient } from '@prisma/client';

const STUCK = [
    '20260710120000_add_categorization_vendor_rules',
];

console.log('[fix-migrations] Starting cleanup of stuck migrations...');
const prisma = new PrismaClient();
try {
    for (const name of STUCK) {
        // Delete regardless of rolled_back_at — catches both FAILED and ROLLED_BACK states.
        // migrate deploy will re-run the (now no-op) migration file cleanly.
        const deleted = await prisma.$executeRaw`
            DELETE FROM "_prisma_migrations"
            WHERE migration_name = ${name}
              AND finished_at IS NULL
        `;
        console.log(`[fix-migrations] ${name}: deleted ${deleted} row(s)`);
    }
} catch (e) {
    console.warn('[fix-migrations] Error:', e?.message?.slice(0, 200));
} finally {
    await prisma.$disconnect();
    console.log('[fix-migrations] Done.');
}
