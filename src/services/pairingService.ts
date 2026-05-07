import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';

const PAIRING_TOKEN_TTL_SEC = 5 * 60;
const NODE_AP_PASSWORD_LEN = 12;

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

export interface GatewayProvisioningTokenClaims {
  type: 'gateway_provisioning';
  jti: string;
  id: string;
  gatewayHardwareId: string;
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

export function verifyGatewayProvisioningToken(token: string): GatewayProvisioningTokenClaims {
  const decoded = jwt.verify(token, config.jwt.secret) as GatewayProvisioningTokenClaims;

  if (decoded.type !== 'gateway_provisioning') {
    throw new Error('Invalid provisioning token type');
  }

  if (!decoded.jti || !decoded.id || !decoded.gatewayHardwareId) {
    throw new Error('Provisioning token missing required fields');
  }

  return decoded;
}

export function pairingSessionExpiresAt(): Date {
  return new Date(Date.now() + PAIRING_TOKEN_TTL_SEC * 1000);
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function deriveNodeApPassword(nodeId: string, deviceSecret: string): string {
  return crypto
    .createHmac('sha256', deviceSecret)
    .update(`node-ap:${nodeId}`)
    .digest('hex')
    .slice(0, NODE_AP_PASSWORD_LEN);
}

export function buildNodeProof(deviceSecret: string, nonce: string, nodeId: string, gatewayHardwareId: string): string {
  return crypto
    .createHmac('sha256', deviceSecret)
    .update(`${nonce}|${nodeId}|${gatewayHardwareId}`)
    .digest('hex');
}

export function secureEqualsHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
