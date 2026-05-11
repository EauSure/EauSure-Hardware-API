import express, { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import Gateway from '../models/Gateway';
import IotNode from '../models/IotNode';
import User from '../models/User';
import PairingSession from '../models/PairingSession';
import { authenticate, authenticateGateway } from '../middleware/auth';
import { ensureDatabaseReady } from '../services/database';
import {
  buildNodeProof,
  generateEncryptionKey,
  generatePairingSessionToken,
  secureEqualsHex,
  verifyGatewayProvisioningToken,
  verifyPairingSessionToken,
} from '../services/pairingService';
import {
  ackCommand,
  sendCommand,
  buildPairingKeyReadyPayload,
} from '../services/commandService';
import Command from '../models/Command';
import jwt from 'jsonwebtoken';
import config from '../config';

const router = express.Router();

function normalizeSecret(value: unknown): string {
  return String(value ?? '').trim();
}

function hasConfiguredSecret(value: unknown): boolean {
  return normalizeSecret(value).length > 0;
}

async function requireAdminUser(req: Request, res: Response): Promise<boolean> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Access token required' });
    return false;
  }

  const user = await User.findById(userId).select('email role');
  if (!user) {
    res.status(404).json({ success: false, message: 'Authenticated user not found' });
    return false;
  }

  if (user.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin role required' });
    return false;
  }

  return true;
}

router.post(
  '/admin/pre-register',
  authenticate,
  [
    body('kind').isIn(['gateway', 'node']),
    body('id').isString().notEmpty(),
    body('deviceSecret').isString().isLength({ min: 32, max: 256 }),
    body('name').optional().isString().trim(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({
          success: false,
          message: 'Database unavailable. Retry in a few seconds.',
        });
        return;
      }

      if (!(await requireAdminUser(req, res))) {
        return;
      }

      const kind = String(req.body.kind).trim().toLowerCase();
      const id = String(req.body.id).trim().toUpperCase();
      const deviceSecret = normalizeSecret(req.body.deviceSecret);
      const providedName = String(req.body.name ?? '').trim();

      if (kind === 'gateway') {
        let gateway = await Gateway.findOne({ gatewayId: id }).select('+deviceSecret');
        const displayName = providedName || `Gateway ${id.slice(-6)}`;

        if (!gateway) {
          gateway = new Gateway({
            gatewayId: id,
            deviceSecret,
            name: displayName,
            ownerId: null,
            pairedAt: null,
            lastSeenAt: null,
            mqttTopic: `commands/gateway/${id}`,
          });
        } else {
          gateway.deviceSecret = deviceSecret;
          if (providedName) gateway.name = providedName;
          if (!gateway.mqttTopic) gateway.mqttTopic = `commands/gateway/${id}`;
        }

        await gateway.save();

        res.status(201).json({
          success: true,
          message: 'Gateway pre-registered',
          data: {
            kind,
            id,
            name: gateway.name,
          },
        });
        return;
      }

      let node = await IotNode.findOne({ nodeId: id }).select('+deviceSecret');
      const displayName = providedName || `Node ${id}`;

      if (!node) {
        node = new IotNode({
          nodeId: id,
          deviceSecret,
          name: displayName,
          gatewayId: null,
          gatewayHardwareId: null,
          encryptionKey: null,
          pairedAt: null,
        });
      } else {
        node.deviceSecret = deviceSecret;
        if (providedName) node.name = providedName;
      }

      await node.save();

      res.status(201).json({
        success: true,
        message: 'IoT node pre-registered',
        data: {
          kind,
          id,
          name: node.name,
        },
      });
    } catch (err) {
      console.error('[Registry] admin pre-register error:', err);
      res.status(500).json({ success: false, message: 'Failed to pre-register device' });
    }
  },
);

router.post(
  '/gateway/heartbeat',
  authenticateGateway,
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('rssi').optional().isNumeric(),
    body('snr').optional().isNumeric(),
    body('battPercent').optional().isInt(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { gatewayHardwareId, rssi, snr } = req.body;

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId }).select('+deviceSecret');
      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      gateway.lastSeenAt = new Date();
      gateway.status.online = true;
      gateway.status.lastHeartbeatAt = new Date();
      if (rssi !== undefined) gateway.status.rssi = rssi;
      if (snr !== undefined) gateway.status.snr = snr;

      // Only use Vercel IP headers as a fallback if no GPS location has been set yet.
      // GPS location (set via PUT /gateways/:id/location at BLE provisioning time) takes priority.
      const hasGpsLocation = gateway.location && gateway.location.lat && gateway.location.lng;
      if (!hasGpsLocation && req.headers['x-vercel-ip-latitude'] && req.headers['x-vercel-ip-longitude']) {
        gateway.location = gateway.location || {};
        gateway.location.lat = parseFloat(req.headers['x-vercel-ip-latitude'] as string);
        gateway.location.lng = parseFloat(req.headers['x-vercel-ip-longitude'] as string);
        gateway.location.city = (req.headers['x-vercel-ip-city'] as string) || '';
        gateway.location.country = (req.headers['x-vercel-ip-country'] as string) || '';
      }

      await gateway.save();

      const pendingCommands = await Command.find({
        gatewayHardwareId,
        status: 'pending',
      }).sort({ createdAt: 1 }).limit(10);

      res.json({
        success: true,
        data: {
          pendingCommands: pendingCommands.map((c) => ({
            cmdId: c._id,
            cmd: c.type,
            nodeId: c.nodeId,
            payload: c.payload,
          })),
        },
      });
    } catch (err) {
      console.error('[Registry] heartbeat error:', err);
      res.status(500).json({ success: false, message: 'Heartbeat failed' });
    }
  },
);

router.post(
  '/command/ack',
  authenticateGateway,
  [body('cmdId').isString().notEmpty()],
  async (req: Request, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    try {
      await ackCommand(req.body.cmdId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Ack failed' });
    }
  },
);

router.post(
  '/pair-node',
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('nodeId').isString().notEmpty(),
    body('pairingToken').isString().notEmpty(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gatewayHardwareId = String(req.body.gatewayHardwareId).trim();
      const nodeId = String(req.body.nodeId).trim().toUpperCase();
      const pairingToken = String(req.body.pairingToken);

      let claims;
      try {
        claims = verifyPairingSessionToken(pairingToken);
      } catch (err: any) {
        res.status(401).json({ success: false, message: err.message || 'Invalid pairing token' });
        return;
      }

      if (claims.gatewayHardwareId !== gatewayHardwareId || claims.nodeId !== nodeId) {
        res.status(403).json({ success: false, message: 'Pairing token does not match gateway or node' });
        return;
      }

      const session = await PairingSession.findOne({ tokenId: claims.jti });
      if (!session) {
        res.status(404).json({ success: false, message: 'Pairing session not found' });
        return;
      }

      if (session.status !== 'confirmed') {
        res.status(409).json({ success: false, message: 'Pairing session is no longer valid' });
        return;
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        session.status = 'expired';
        await session.save();
        res.status(410).json({ success: false, message: 'Pairing session expired' });
        return;
      }

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId }).select('+deviceSecret');
      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      if (!gateway.ownerId || gateway.ownerId.toString() !== session.userId.toString()) {
        res.status(403).json({ success: false, message: 'Gateway ownership mismatch' });
        return;
      }

      const node = await IotNode.findOne({ nodeId }).select('+encryptionKey +deviceSecret');
      if (!node) {
        res.status(404).json({
          success: false,
          message: 'IoT node is not pre-registered. Register nodeId and deviceSecret first.',
        });
        return;
      }

      if (!hasConfiguredSecret(node.deviceSecret)) {
        res.status(409).json({
          success: false,
          message: 'IoT node is missing its configured device secret.',
        });
        return;
      }

      if (node.gatewayId && !node.gatewayId.equals(gateway._id as any)) {
        res.status(409).json({ success: false, message: 'IoT node already paired to another gateway' });
        return;
      }

      const aesKey = generateEncryptionKey();

      node.gatewayId = gateway._id;
      node.gatewayHardwareId = gatewayHardwareId;
      node.name = session.nodeName || node.name;
      node.encryptionKey = aesKey;
      node.pairedAt = new Date();
      node.status.lastSeenAt = new Date();
      node.status.active = false;

      await node.save();

      session.status = 'consumed';
      session.consumedAt = new Date();
      await session.save();

      await sendCommand(
        gateway,
        'PAIRING_KEY_READY',
        buildPairingKeyReadyPayload({ nodeId, aesKey }),
        nodeId,
      );

      res.json({
        success: true,
        message: 'Node paired',
        data: {
          gatewayHardwareId,
          nodeId,
          aesKey,
          nodeName: node.name,
        },
      });
    } catch (err) {
      console.error('[Registry] pair-node error:', err);
      res.status(500).json({ success: false, message: 'Pairing failed' });
    }
  },
);

router.post(
  '/pair-node/verify-proof',
  authenticateGateway,
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('nodeId').isString().notEmpty(),
    body('sessionId').isString().notEmpty(),
    body('nonce').isString().isLength({ min: 8, max: 128 }),
    body('proof').isString().isLength({ min: 32, max: 128 }),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gatewayHardwareId = String(req.body.gatewayHardwareId).trim();
      const nodeId = String(req.body.nodeId).trim().toUpperCase();
      const sessionId = String(req.body.sessionId).trim();
      const nonce = String(req.body.nonce).trim();
      const proof = String(req.body.proof).trim().toLowerCase();

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId }).select('+deviceSecret');
      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const session = await PairingSession.findOne({ tokenId: sessionId });
      if (!session) {
        res.status(404).json({ success: false, message: 'Pairing session not found' });
        return;
      }

      if (session.status !== 'confirmed') {
        res.status(409).json({ success: false, message: 'Pairing session is no longer valid' });
        return;
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        session.status = 'expired';
        await session.save();
        res.status(410).json({ success: false, message: 'Pairing session expired' });
        return;
      }

      if (session.gatewayHardwareId !== gatewayHardwareId || session.nodeId !== nodeId) {
        res.status(403).json({ success: false, message: 'Pairing session does not match gateway or node' });
        return;
      }

      if (!gateway.ownerId || gateway.ownerId.toString() !== session.userId.toString()) {
        res.status(403).json({ success: false, message: 'Gateway ownership mismatch' });
        return;
      }

      const node = await IotNode.findOne({ nodeId }).select('+deviceSecret');
      if (!node) {
        res.status(404).json({ success: false, message: 'IoT node not found' });
        return;
      }

      if (!hasConfiguredSecret(node.deviceSecret)) {
        res.status(409).json({ success: false, message: 'IoT node is missing its configured device secret.' });
        return;
      }

      const expectedProof = buildNodeProof(node.deviceSecret, nonce, nodeId, gatewayHardwareId);
      if (!secureEqualsHex(expectedProof, proof)) {
        res.status(403).json({ success: false, message: 'Node proof verification failed' });
        return;
      }

      const pairingToken = generatePairingSessionToken({
        sessionId: session.tokenId,
        userId: session.userId.toString(),
        gatewayHardwareId,
        nodeId,
        nodeName: session.nodeName,
        bleMac: session.bleMac,
      });

      res.json({
        success: true,
        message: 'Node proof verified',
        data: {
          pairingToken,
          expiresAt: session.expiresAt,
        },
      });
    } catch (err) {
      console.error('[Registry] verify-proof error:', err);
      res.status(500).json({ success: false, message: 'Failed to verify node proof' });
    }
  },
);

router.post(
  '/gateway/provision',
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('deviceSecret').isString().notEmpty(),
    body('firmwareVersion').optional().isString(),
    body('token').isString().notEmpty(),
    body('gatewayName').optional().isString(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gatewayHardwareId = String(req.body.gatewayHardwareId).trim();
      const firmwareVersion = req.body.firmwareVersion;
      const token = String(req.body.token);
      const gatewayName = req.body.gatewayName;
      const deviceSecret = normalizeSecret(req.body.deviceSecret);

      let userId = '';
      try {
        const provisioningClaims = verifyGatewayProvisioningToken(token);
        if (provisioningClaims.gatewayHardwareId !== gatewayHardwareId) {
          res.status(403).json({ success: false, message: 'Provisioning token does not match gateway hardware ID' });
          return;
        }
        userId = provisioningClaims.id;
      } catch {
        try {
          const payload = jwt.verify(token, config.jwt.secret) as { id: string };
          userId = String(payload.id || '');
        } catch {
          res.status(401).json({ success: false, message: 'Invalid token' });
          return;
        }
      }

      if (!userId) {
        res.status(401).json({ success: false, message: 'Invalid token payload' });
        return;
      }

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId }).select('+deviceSecret');
      if (!gateway) {
        res.status(404).json({
          success: false,
          message: 'Gateway is not pre-registered. Register gatewayId and deviceSecret first.',
        });
        return;
      }

      if (!hasConfiguredSecret(gateway.deviceSecret)) {
        res.status(409).json({
          success: false,
          message: 'Gateway is missing its configured device secret.',
        });
        return;
      }

      if (gateway.deviceSecret !== deviceSecret) {
        res.status(403).json({ success: false, message: 'Gateway device secret mismatch' });
        return;
      }

      if (gateway.ownerId && gateway.ownerId.toString() !== userId) {
        res.status(409).json({
          success: false,
          message: 'Gateway already linked to another account',
        });
        return;
      }

      gateway.ownerId = userId as any;
      gateway.pairedAt = gateway.pairedAt || new Date();
      gateway.lastSeenAt = new Date();
      gateway.status.online = true;
      gateway.status.lastHeartbeatAt = new Date();

      if (firmwareVersion) {
        gateway.status.firmwareVersion = firmwareVersion;
      }

      if (gatewayName && String(gatewayName).trim()) {
        gateway.name = String(gatewayName).trim();
      } else if (!gateway.name || !gateway.name.trim()) {
        gateway.name = `Gateway ${gatewayHardwareId.slice(-6)}`;
      }

      if (!gateway.mqttTopic) {
        gateway.mqttTopic = `commands/gateway/${gateway.gatewayId}`;
      }

      // Only use Vercel IP headers as a fallback if no GPS location has been set yet.
      // GPS location (set via PUT /gateways/:id/location at BLE provisioning time) takes priority.
      const hasGpsLocation = gateway.location && gateway.location.lat && gateway.location.lng;
      if (!hasGpsLocation && req.headers['x-vercel-ip-latitude'] && req.headers['x-vercel-ip-longitude']) {
        gateway.location = gateway.location || {};
        gateway.location.lat = parseFloat(req.headers['x-vercel-ip-latitude'] as string);
        gateway.location.lng = parseFloat(req.headers['x-vercel-ip-longitude'] as string);
        gateway.location.city = (req.headers['x-vercel-ip-city'] as string) || '';
        gateway.location.country = (req.headers['x-vercel-ip-country'] as string) || '';
      }

      await gateway.save();

      res.json({
        success: true,
        message: 'Gateway provisioned',
        data: {
          gatewayId: gateway.gatewayId,
          name: gateway.name,
          mqttTopic: gateway.mqttTopic,
          config: gateway.config,
        },
      });
    } catch (err) {
      console.error('[Registry] gateway provision error:', err);
      res.status(500).json({ success: false, message: 'Gateway provisioning failed' });
    }
  },
);

router.post(
  '/pair-node/rollback',
  authenticateGateway,
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('nodeId').isString().notEmpty(),
    body('pairingToken').isString().notEmpty(),
    body('reason').optional().isString(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gatewayHardwareId = String(req.body.gatewayHardwareId).trim();
      const nodeId = String(req.body.nodeId).trim().toUpperCase();
      const pairingToken = String(req.body.pairingToken);
      const reason = req.body.reason ? String(req.body.reason) : 'Gateway reported pairing failure';

      let claims;
      try {
        claims = verifyPairingSessionToken(pairingToken);
      } catch (err: any) {
        res.status(401).json({ success: false, message: err.message || 'Invalid pairing token' });
        return;
      }

      if (claims.gatewayHardwareId !== gatewayHardwareId || claims.nodeId !== nodeId) {
        res.status(403).json({ success: false, message: 'Pairing token does not match gateway or node' });
        return;
      }

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId });
      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const session = await PairingSession.findOne({ tokenId: claims.jti });
      if (session) {
        session.status = 'failed';
        session.failedAt = new Date();
        session.failureReason = reason;
        await session.save();
      }

      const node = await IotNode.findOne({
        nodeId,
        gatewayId: gateway._id,
        gatewayHardwareId,
      }).select('+encryptionKey +deviceSecret');

      if (!node) {
        res.json({ success: true, message: 'Nothing to rollback' });
        return;
      }

      node.gatewayId = null;
      node.gatewayHardwareId = null;
      node.encryptionKey = null;
      node.pairedAt = null;
      node.status.active = false;
      await node.save();

      res.json({
        success: true,
        message: 'Pairing rollback complete',
        data: { nodeId, gatewayHardwareId },
      });
    } catch (err) {
      console.error('[Registry] pair-node rollback error:', err);
      res.status(500).json({ success: false, message: 'Rollback failed' });
    }
  },
);

router.post(
  '/gateway/node-status',
  authenticateGateway,
  [
    body('nodeId').isString().notEmpty(),
    body('gatewayHardwareId').isString().notEmpty(),
    body('active').isBoolean(),
    body('rssi').optional().isNumeric(),
    body('snr').optional().isNumeric(),
    body('pairingToken').optional().isString(),
    body('pairingComplete').optional().isBoolean(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { nodeId, active, rssi, snr, pairingToken, pairingComplete } = req.body;

      const node = await IotNode.findOne({
        nodeId,
        gatewayHardwareId: req.body.gatewayHardwareId,
      }).select('+deviceSecret');
      if (!node) {
        res.status(404).json({ success: false, message: 'Node not found' });
        return;
      }

      node.status.active = active;
      node.status.lastSeenAt = new Date();
      if (rssi !== undefined) node.status.lastRssi = rssi;
      if (snr !== undefined) node.status.lastSnr = snr;
      await node.save();

      if (pairingComplete === true && pairingToken) {
        try {
          const claims = verifyPairingSessionToken(String(pairingToken));
          const session = await PairingSession.findOne({ tokenId: claims.jti });
          if (session) {
            session.status = 'completed';
            session.completedAt = new Date();
            await session.save();
          }
        } catch {
          // Ignore invalid completion token reports; the node status itself is still updated.
        }
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Status update failed' });
    }
  },
);

export default router;
