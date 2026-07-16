import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { authRouter } from './routes/auth.js';
import { usageRouter } from './routes/usage.js';
import { eventsRouter } from './routes/events.js';
import { ticketsRouter } from './routes/tickets.js';
import { billingRouter } from './routes/billing.js';
import { documentUsageRouter } from './routes/documentUsage.js';
import { usersRouter } from './routes/users.js';
import { errorHandler } from './middleware/errorHandler.js';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

// Make prisma available to routes
app.locals.prisma = prisma;

// Health check — includes git commit so you can verify which code is running
import { execSync } from 'child_process';
const GIT_COMMIT = process.env.GIT_COMMIT ?? (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const STARTED_AT = new Date().toISOString();

const healthHandler = (req: any, res: any) => {
    res.json({ status: 'ok', commit: GIT_COMMIT, startedAt: STARTED_AT, timestamp: new Date().toISOString() });
};
app.get('/health',    healthHandler);
app.get('/v1/health', healthHandler);

import { integrationsRouter } from './routes/integrations.js';
import { reportsRouter } from './routes/reports.js';
import { processingRouter } from './routes/processing.js';
import { superadminRouter } from './routes/superadmin.js';
import { driveProcessRouter } from './routes/driveProcess.js';
import { startDailyReportCron } from './cron/dailyReports.js';
import { startGmailPollerCron, initGmailWatch } from './cron/gmailPoller.js';
import { gmailWebhookRouter } from './routes/gmailWebhook.js';

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/usage', documentUsageRouter);
app.use('/v1/events', eventsRouter);
app.use('/v1/usage', usageRouter);
app.use('/v1/users', usersRouter);
app.use('/v1/tickets', ticketsRouter);
app.use('/v1/billing', billingRouter);
app.use('/v1/integrations', integrationsRouter);
app.use('/v1/reports', reportsRouter);
app.use('/v1/processing', processingRouter);
app.use('/v1/superadmin', superadminRouter);
app.use('/v1/drive', driveProcessRouter);
app.use('/v1/gmail', gmailWebhookRouter);

// Start scheduled jobs
startDailyReportCron(prisma);
startGmailPollerCron();
initGmailWatch();

// Error handling
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', async () => {
    await prisma.$disconnect();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 Acctos AI API running on port ${PORT}`);
});

export { app, prisma };
