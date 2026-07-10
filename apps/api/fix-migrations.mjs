// Runs before `prisma migrate deploy` to remove any stuck failed-migration records.
// Safe to run repeatedly — only deletes rows where finished_at IS NULL (actually failed).
// After deletion, `migrate deploy` re-runs the migration file cleanly.
import { PrismaClient } from '@prisma/client';

const STUCK = [
    '20260710120000_add_categorization_vendor_rules',
];

const prisma = new PrismaClient();
try {
    for (const name of STUCK) {
        const deleted = await prisma.$executeRaw`
            DELETE FROM "_prisma_migrations"
            WHERE migration_name = ${name}
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
        `;
        if (deleted > 0) console.log(`[fix-migrations] Cleared: ${name}`);
    }
} catch (e) {
    console.warn('[fix-migrations] Skipped:', e?.message?.slice(0, 120));
} finally {
    await prisma.$disconnect();
}
