import crypto from 'crypto';

/**
 * PairingService
 *
 * QR code content format (base64url-encoded JSON):
 * {
 *   "id":  "<deviceId>",          // gatewayId or nodeId
 *   "ts":  <unix seconds>,        // generation timestamp
 *   "sig": "<hex HMAC-SHA256>"    // HMAC-SHA256(id + ":" + ts, deviceSecret)
 * }
 *
 * Security properties:
 *  - HMAC is computed with the device's factory-burned secret → can't be forged
 *  - Timestamp is included in the signed payload → replay window limited to TOKEN_TTL_SEC
 *  - Token expires after TOKEN_TTL_SEC (10 min) — single-use enforced at DB level
 *    (pairingToken is cleared after first successful verification)
 */

const TOKEN_TTL_SEC = 10 * 60; // 10 minutes

/**
 * Generate a QR token for a device.
 * Called when the device first boots or when a re-pair is requested.
 * In practice this is called by the gateway/node firmware registration endpoint,
 * or pre-generated at manufacturing time and stored as pairingToken in the DB.
 *
 * @param deviceId     — hardware ID of the device
 * @param deviceSecret — factory-burned secret (from DB, select:false field)
 * @returns base64url string to encode in the QR code
 */
export function generatePairingToken(deviceId: string, deviceSecret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const message = `${deviceId}:${ts}`;
  const sig = crypto
    .createHmac('sha256', deviceSecret)
    .update(message)
    .digest('hex');

  const payload = JSON.stringify({ id: deviceId, ts, sig });
  return Buffer.from(payload).toString('base64url');
}

/**
 * Verify a QR token scanned by the user.
 *
 * @param token        — base64url string from QR scan
 * @param deviceSecret — secret fetched from DB (select:false)
 * @returns deviceId string on success, throws on failure
 */
export function verifyPairingToken(token: string, deviceSecret: string): string {
  let parsed: { id: string; ts: number; sig: string };

  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid pairing token format');
  }

  const { id, ts, sig } = parsed;

  if (!id || !ts || !sig) {
    throw new Error('Pairing token missing required fields');
  }

  // Check expiry
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - ts > TOKEN_TTL_SEC) {
    throw new Error('Pairing token has expired');
  }

  // Constant-time HMAC comparison to prevent timing attacks
  const expected = crypto
    .createHmac('sha256', deviceSecret)
    .update(`${id}:${ts}`)
    .digest('hex');

  const sigBuf      = Buffer.from(sig,      'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Pairing token signature invalid');
  }

  return id;
}

/**
 * Generate a fresh AES-128 encryption key for an IoT node pairing.
 * Returns hex string (32 chars = 16 bytes).
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Get token expiry date from now.
 */
export function tokenExpiresAt(): Date {
  return new Date(Date.now() + TOKEN_TTL_SEC * 1000);
}
