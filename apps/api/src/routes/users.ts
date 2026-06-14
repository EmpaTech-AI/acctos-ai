import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import { ADMIN_ROLES } from '../utils/roles.js';
import { startProcessingJob, startBatchProcessingJob } from '../services/processing/ProcessingOrchestrator.js';
import { BankType } from '../services/processing/DocumentClassifier.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

const router = Router();

// All user management routes require authentication + admin role
router.use(authenticateToken);

const createUserSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().optional(),
    role: z.enum(['ADMIN', 'MEMBER']),
});

const changePasswordSchema = z.object({
    password: z.string().min(8),
});

/**
 * GET /v1/users
 *
 * List all users in the current tenant.
 */
router.get('/', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const memberships = await prisma.membership.findMany({
            where: { tenantId },
            include: {
                user: {
                    select: { id: true, email: true, name: true, createdAt: true },
                },
            },
            orderBy: { user: { createdAt: 'desc' } },
        });

        res.json({
            users: memberships.map((m: any) => ({
                ...m.user,
                role: m.role,
                membershipId: m.id,
            })),
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /v1/users
 *
 * Create a new user and add them to the current tenant.
 */
router.post('/', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        const body = createUserSchema.parse(req.body);
        const hashedPassword = await bcrypt.hash(body.password, 10);

        let user = await prisma.user.findUnique({ where: { email: body.email } });

        if (!user) {
            user = await prisma.user.create({
                data: { email: body.email, password: hashedPassword, name: body.name },
            });
        }

        // Check if user already has access to this tenant
        const existingMembership = await prisma.membership.findFirst({
            where: { userId: user.id, tenantId },
        });

        if (existingMembership) {
            return res.status(409).json({
                error: { message: 'User already has access to this tenant', code: 'DUPLICATE_MEMBERSHIP' },
            });
        }

        const membership = await prisma.membership.create({
            data: { userId: user.id, tenantId, role: body.role },
        });

        res.status(201).json({
            user: { id: user.id, email: user.email, name: user.name, role: membership.role, membershipId: membership.id },
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return next(createError('Invalid input: ' + error.errors[0].message, 400, 'VALIDATION_ERROR'));
        }
        next(error);
    }
});

/**
 * PUT /v1/users/:membershipId/password
 *
 * Change the password of a user in the current tenant.
 */
router.put('/:membershipId/password', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        const membership = await prisma.membership.findFirst({
            where: { id: req.params.membershipId, tenantId },
        });

        if (!membership) {
            return next(createError('User not found in this tenant', 404, 'NOT_FOUND'));
        }

        const body = changePasswordSchema.parse(req.body);
        const hashedPassword = await bcrypt.hash(body.password, 10);

        await prisma.user.update({
            where: { id: membership.userId },
            data: { password: hashedPassword },
        });

        res.json({ success: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return next(createError('Invalid input: ' + error.errors[0].message, 400, 'VALIDATION_ERROR'));
        }
        next(error);
    }
});

/**
 * DELETE /v1/users/:membershipId
 *
 * Remove a user from the current tenant.
 */
router.delete('/:membershipId', requireRole(...ADMIN_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const tenantId = req.user!.tenantId;

        const membership = await prisma.membership.findFirst({
            where: { id: req.params.membershipId, tenantId },
        });

        if (!membership) {
            return next(createError('User not found in this tenant', 404, 'NOT_FOUND'));
        }

        // Prevent deleting yourself
        if (membership.userId === req.user!.id) {
            return next(createError('Cannot remove yourself', 400, 'SELF_DELETE'));
        }

        await prisma.membership.delete({ where: { id: membership.id } });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /v1/users/import
 *
 * Accept one or more file uploads from an admin, start async batch processing, return jobId.
 */
router.post('/import', requireRole(...ADMIN_ROLES), upload.array('files', 20), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const files = req.files as Express.Multer.File[] | undefined;
        if (!files || files.length === 0) {
            return next(createError('No files provided', 400, 'NO_FILE'));
        }

        const tenantId = req.user!.tenantId;
        const tracking = tenantId ? { prisma: req.app.locals.prisma, tenantId } : undefined;

        // Optional bank type hint for multi-file batches where filenames don't contain the bank name
        // (e.g. page-split exports: "Statements__page1-20.pdf"). Passed as query param ?bankType=santander.
        const bankHint = (req.query.bankType as BankType | undefined) || undefined;

        // Single file: use original path (supports Excel + PDF)
        // Multiple files: batch path (PDF only, sorts by date, one combined output)
        const jobId = files.length === 1
            ? startProcessingJob(files[0].originalname, files[0].mimetype, files[0].buffer, tracking)
            : startBatchProcessingJob(
                files.map(f => ({ filename: f.originalname, mimeType: f.mimetype, buffer: f.buffer })),
                tracking,
                bankHint,
            );

        res.json({ success: true, jobId });
    } catch (error) {
        next(error);
    }
});

export { router as usersRouter };
