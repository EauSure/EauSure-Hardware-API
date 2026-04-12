import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';

// =====================================================
// Extend Express Request to carry the decoded token payload.
// We do NOT fetch a local User document — the user lives
// in the external auth API's database.
// =====================================================
export interface JWTPayload {
  id: string;       // user._id from external auth API
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * authenticate
 *
 * Verifies the JWT issued by the external auth API.
 * On success, attaches the decoded payload to req.user.
 * Never touches a local User collection.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Access token required' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = jwt.verify(token, config.jwt.secret) as JWTPayload;
    req.user = payload;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ success: false, message: 'Token expired' });
    } else {
      res.status(401).json({ success: false, message: 'Invalid token' });
    }
  }
}

/**
 * authenticateGateway
 *
 * Verifies the Gateway API key sent by gateway firmware.
 * Used on all /api/registry/* and POST /api/sensor-data routes.
 */
export function authenticateGateway(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers['x-api-key'] || req.headers['x-gateway-key'];

  if (!apiKey || apiKey !== config.gateway.apiKey) {
    res.status(401).json({ success: false, message: 'Invalid or missing Gateway API key' });
    return;
  }

  next();
}