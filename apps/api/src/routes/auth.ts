import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';

const router = Router();

// JWT_EXPIRES_IN='none' → tokens never expire; otherwise use the value (e.g. '30d', '1y')
function jwtOptions(): jwt.SignOptions {
    const exp = process.env.JWT_EXPIRES_IN;
    if (!exp || exp === 'none') return {};
    return { expiresIn: exp } as jwt.SignOptions;
}

// Validation schemas
const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().optional(),
    tenantName: z.string().min(2),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});

// Register a new user and create their tenant
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const data = registerSchema.parse(req.body);

        // Check if user exists
        const existingUser = await prisma.user.findUnique({
            where: { email: data.email },
        });

        if (existingUser) {
            return next(createError('Email already registered', 400, 'EMAIL_EXISTS'));
        }

        // Create user, tenant, and membership in transaction
        const hashedPassword = await bcrypt.hash(data.password, 10);
        const slug = data.tenantName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        const result = await prisma.$transaction(async (tx: any) => {
            const user = await tx.user.create({
                data: {
                    email: data.email,
                    password: hashedPassword,
                    name: data.name,
                },
            });

            const tenant = await tx.tenant.create({
                data: {
                    name: data.tenantName,
                    slug: `${slug}-${Date.now()}`,
                },
            });

            await tx.membership.create({
                data: {
                    userId: user.id,
                    tenantId: tenant.id,
                    role: 'ORG_OWNER',
                },
            });

            // Create default subscription (trial)
            await tx.subscription.create({
                data: {
                    tenantId: tenant.id,
                    status: 'trialing',
                },
            });

            return { user, tenant };
        });

        res.status(201).json({
            message: 'Registration successful',
            userId: result.user.id,
            tenantId: result.tenant.id,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return next(createError('Invalid input: ' + error.errors[0].message, 400, 'VALIDATION_ERROR'));
        }
        next(error);
    }
});

// Login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const data = loginSchema.parse(req.body);

        const user = await prisma.user.findUnique({
            where: { email: data.email },
            include: {
                memberships: {
                    include: { tenant: true },
                },
            },
        });

        if (!user || !(await bcrypt.compare(data.password, user.password))) {
            return next(createError('Invalid credentials', 401, 'INVALID_CREDENTIALS'));
        }

        // Get first tenant as default (user can switch later)
        const defaultMembership = user.memberships[0];

        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                tenantId: defaultMembership?.tenantId,
            },
            process.env.JWT_SECRET || 'secret',
            jwtOptions()
        );

        // Audit log
        if (defaultMembership) {
            await prisma.auditLog.create({
                data: {
                    userId: user.id,
                    tenantId: defaultMembership.tenantId,
                    action: 'user.login',
                    resource: 'user',
                    resourceId: user.id,
                },
            });
        }

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
            },
            tenants: user.memberships.map((m: any) => ({
                id: m.tenant.id,
                name: m.tenant.name,
                slug: m.tenant.slug,
                role: m.role,
            })),
            activeTenant: defaultMembership?.tenantId,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return next(createError('Invalid input', 400, 'VALIDATION_ERROR'));
        }
        next(error);
    }
});

// Get current user profile
router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            include: {
                memberships: {
                    include: { tenant: true },
                },
            },
        });

        if (!user) {
            return next(createError('User not found', 404, 'NOT_FOUND'));
        }

        // Get current role for active tenant
        const currentMembership = user.memberships.find(
            (m: any) => m.tenantId === req.user!.tenantId
        );
        const currentRole = currentMembership?.role ?? null;

        // Fetch integration config status for the active tenant
        const tenantConfig = req.user!.tenantId
            ? await prisma.tenant.findUnique({
                  where: { id: req.user!.tenantId },
                  select: {
                      makeApiKey: true,
                      makeFolderId: true,
                      makeOrgId: true,
                      azureApiKey: true,
                      azureEndpoint: true,
                  },
              })
            : null;

        res.json({
            id: user.id,
            email: user.email,
            name: user.name,
            currentRole,
            tenants: user.memberships.map((m: any) => ({
                id: m.tenant.id,
                name: m.tenant.name,
                slug: m.tenant.slug,
                role: m.role,
            })),
            activeTenant: req.user!.tenantId,
            integrations: {
                makeApiKeyConfigured: !!tenantConfig?.makeApiKey,
                makeFolderId: tenantConfig?.makeFolderId || '',
                makeOrgId: tenantConfig?.makeOrgId || '',
                azureApiKeyConfigured: !!tenantConfig?.azureApiKey,
                azureEndpoint: tenantConfig?.azureEndpoint || '',
            },
        });
    } catch (error) {
        next(error);
    }
});

// Switch active tenant
router.post('/switch-tenant', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const { tenantId } = req.body;

        // Verify user has access to this tenant
        const membership = await prisma.membership.findUnique({
            where: {
                userId_tenantId: {
                    userId: req.user!.id,
                    tenantId,
                },
            },
            include: { tenant: true },
        });

        if (!membership) {
            return next(createError('Access denied to this tenant', 403, 'FORBIDDEN'));
        }

        // Issue new token with updated tenant
        const token = jwt.sign(
            {
                id: req.user!.id,
                email: req.user!.email,
                tenantId,
            },
            process.env.JWT_SECRET || 'secret',
            jwtOptions()
        );

        res.json({
            token,
            tenant: {
                id: membership.tenant.id,
                name: membership.tenant.name,
                slug: membership.tenant.slug,
                role: membership.role,
            },
        });
    } catch (error) {
        next(error);
    }
});

// Update profile (API Keys)
router.post('/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const prisma: PrismaClient = req.app.locals.prisma;
        const { makeApiKey, makeFolderId, makeOrgId, azureApiKey, azureEndpoint } = req.body;
        const tenantId = req.user!.tenantId;

        if (!tenantId) {
            return next(createError('No tenant selected', 400, 'NO_TENANT'));
        }

        // Update tenant
        const updatedTenant = await prisma.tenant.update({
            where: { id: tenantId },
            data: {
                makeApiKey: makeApiKey || undefined, // undefined means do not update if not provided
                makeFolderId: makeFolderId !== undefined ? (makeFolderId || null) : undefined,
                makeOrgId: makeOrgId !== undefined ? (makeOrgId || null) : undefined,
                azureApiKey: azureApiKey || undefined,
                azureEndpoint: azureEndpoint || undefined,
            },
        });

        // Audit Log
        await prisma.auditLog.create({
            data: {
                userId: req.user!.id,
                tenantId,
                action: 'tenant.update.keys',
                resource: 'tenant',
                resourceId: tenantId,
            }
        });

        res.json({
            message: 'Profile updated successfully',
            makeApiKeyConfigured: !!updatedTenant.makeApiKey,
            makeFolderIdConfigured: !!updatedTenant.makeFolderId,
            makeOrgIdConfigured: !!updatedTenant.makeOrgId,
            azureApiKeyConfigured: !!updatedTenant.azureApiKey,
        });
    } catch (error) {
        next(error);
    }
});

export { router as authRouter };
