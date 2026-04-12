import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { IUser } from '../models/User';

// =====================================================
// JWTPayload — access token claims
// =====================================================
export interface JWTPayload {
  id: string;       // user._id
  iat?: number;
  exp?: number;
}

// Refresh token has a distinct claim key to avoid
// accidentally accepting a refresh token as an access token.
interface RefreshPayload {
  userId: string;
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

// =====================================================
// Token generation
// =====================================================

/**
 * generateAccessToken
 * Short-lived JWT (15 min) — verified by `authenticate` middleware.
 * Claim key: "id"  (matches JWTPayload interface)
 */
export function generateAccessToken(user: IUser): string {
  return jwt.sign(
    { id: user._id.toString() },
    config.jwt.secret,
    { expiresIn: '15m' }
  );
}

/**
 * generateRefreshToken
 * Long-lived JWT (7 days) — used only in POST /api/auth/refresh.
 * Claim key: "userId"  (distinct from access token to prevent misuse)
 */
export function generateRefreshToken(user: IUser): string {
  return jwt.sign(
    { userId: user._id.toString() },
    config.jwt.secret,
    { expiresIn: '7d' }
  );
}

/**
 * verifyToken
 * Verifies either an access or refresh token.
 * Returns the decoded payload — caller decides which fields to use.
 *
 * @param token     - raw JWT string
 * @param isRefresh - true → expect refresh token (payload.userId)
 *                    false → expect access token  (payload.id)
 */
export function verifyToken(token: string, isRefresh = false): RefreshPayload & JWTPayload {
  const decoded = jwt.verify(token, config.jwt.secret) as RefreshPayload & JWTPayload;

  if (isRefresh && !decoded.userId) {
    throw new Error('Not a refresh token');
  }
  if (!isRefresh && !decoded.id) {
    throw new Error('Not an access token');
  }

  return decoded;
}

// =====================================================
// authenticate  — JWT middleware (access token)
// =====================================================
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

// =====================================================
// authenticateGateway  — API key middleware (firmware)
// =====================================================
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