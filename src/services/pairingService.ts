import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';

const PAIRING_TOKEN_TTL_SEC = 5 * 60;

export interface PairingSessionTokenClaims {
  type: 'pairing_session';
  jti: string;
  userId: string;
  gatewayHardwareId: string;
  nodeId: string;
  nodeName?: string;
  bleMac?: string;
  iat?: number;
  exp?: number;
}

export function generatePairingSessionToken(input: {
  sessionId: string;
  userId: string;
  gatewayHardwareId: string;
  nodeId: string;
  nodeName?: string;
  bleMac?: string;
}): string {
  const payload: PairingSessionTokenClaims = {
    type: 'pairing_session',
    jti: input.sessionId,
    userId: input.userId,
    gatewayHardwareId: input.gatewayHardwareId,
    nodeId: input.nodeId,
    ...(input.nodeName ? { nodeName: input.nodeName } : {}),
    ...(input.bleMac ? { bleMac: input.bleMac } : {}),
  };

  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: PAIRING_TOKEN_TTL_SEC,
  });
}

export function verifyPairingSessionToken(token: string): PairingSessionTokenClaims {
  const decoded = jwt.verify(token, config.jwt.secret) as PairingSessionTokenClaims;

  if (decoded.type !== 'pairing_session') {
    throw new Error('Invalid pairing token type');
  }

  if (!decoded.jti || !decoded.userId || !decoded.gatewayHardwareId || !decoded.nodeId) {
    throw new Error('Pairing token missing required fields');
  }

  return decoded;
}

export function pairingSessionExpiresAt(): Date {
  return new Date(Date.now() + PAIRING_TOKEN_TTL_SEC * 1000);
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(16).toString('hex');
}
