import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createError } from './errorHandler.js';

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        email: string;
        tenantId?: string;
    };
}

export function authenticateToken(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return next(createError('Access denied', 401, 'UNAUTHORIZED'));
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as {
            id: string;
            email: string;
            tenantId?: string;
        };
        req.user = decoded;
        next();
    } catch (err) {
        return next(createError('Invalid token', 401, 'UNAUTHORIZED'));
    }
}

export function requireRole(...roles: string[]) {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return next(createError('Not authenticated', 401, 'UNAUTHORIZED'));
        }

        const prisma = req.app.locals.prisma;
        const membership = await prisma.membership.findFirst({
            where: {
                userId: req.user.id,
                tenantId: req.user.tenantId,
            },
        });

        if (!membership || !roles.includes(membership.role)) {
            return next(createError('Insufficient permissions', 403, 'FORBIDDEN'));
        }

        next();
    };
}
