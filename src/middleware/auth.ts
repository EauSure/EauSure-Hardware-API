import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';


// =====================================================
// JWTPayload — access token claims
// =====================================================
export interface JWTPayload {
  id: string;       // user._id
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