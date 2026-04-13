import express, { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import Gateway from '../models/Gateway';
import IotNode from '../models/IotNode';
import { authenticateGateway } from '../middleware/auth';
import { generatePairingToken, tokenExpiresAt, generateEncryptionKey } from '../services/pairingService';
import { ackCommand } from '../services/commandService';
import Command from '../models/Command';
import jwt from 'jsonwebtoken';
import config from '../config';


const router = express.Router();



function shortToken(token?: string): string {
  if (!token) return 'none';
  if (token.length <= 16) return token;
  return `${token.slice(0, 8)}...${token.slice(-8)}`;
}

function logStep(route: string, step: string, meta?: Record<string, any>) {
  const ts = new Date().toISOString();
  if (meta) {
    console.log(`[${ts}] [${route}] ${step}`, meta);
  } else {
    console.log(`[${ts}] [${route}] ${step}`);
  }
}
// =====================================================
// POST /api/registry/gateway
// Called by gateway firmware on first boot.
// Registers the gateway in DB if not already present,
// and returns its current pairing token (for QR generation
// at manufacturing time or first-boot OLED display).
//
// Auth: Gateway API key (x-api-key header)
// =====================================================
router.post(
  '/gateway',
  authenticateGateway,
  [
    body('gatewayId').isString().notEmpty(),
    body('deviceSecret').isString().notEmpty(),
    body('firmwareVersion').optional().isString(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { gatewayId, deviceSecret, firmwareVersion } = req.body;

      let gateway = await Gateway.findOne({ gatewayId }).select('+deviceSecret +pairingToken');

      if (!gateway) {
        // First time registration
        gateway = new Gateway({
          gatewayId,
          deviceSecret,
          mqttTopic: `commands/gateway/${gatewayId}`,
        });
      }

      // Refresh pairing token (new token every boot / re-registration)
      const token = generatePairingToken(gatewayId, deviceSecret);
      (gateway as any).pairingToken          = token;
      (gateway as any).pairingTokenExpiresAt = tokenExpiresAt();

      if (firmwareVersion) {
        gateway.status.firmwareVersion = firmwareVersion;
      }
      gateway.lastSeenAt     = new Date();
      gateway.status.online  = true;

      await gateway.save();

      // Return the pairing token — gateway encodes it in its QR / OLED
      res.json({
        success: true,
        data: {
          gatewayId,
          pairingToken: token,
          mqttTopic:    gateway.mqttTopic,
          // Return current config if gateway is already paired
          config: gateway.ownerId ? gateway.config : null,
        },
      });
    } catch (err) {
      console.error('[Registry] gateway registration error:', err);
      res.status(500).json({ success: false, message: 'Registration failed' });
    }
  }
);

// =====================================================
// POST /api/registry/node
// Called by gateway firmware when registering a new IoT node
// (before pairing — the node sends its ID + secret to the gateway
//  which forwards it to the API so it appears in the DB ready to pair).
//
// Auth: Gateway API key
// =====================================================
router.post(
  '/node',
  authenticateGateway,
  [
    body('nodeId').isString().notEmpty(),
    body('deviceSecret').isString().notEmpty(),
    body('gatewayHardwareId').isString().notEmpty(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { nodeId, deviceSecret, gatewayHardwareId } = req.body;

      let node = await IotNode.findOne({ nodeId }).select('+deviceSecret +pairingToken');

      if (!node) {
        node = new IotNode({ nodeId, deviceSecret });
      }

      // Generate a fresh pairing token for this node
      const token = generatePairingToken(nodeId, deviceSecret);
      (node as any).pairingToken          = token;
      (node as any).pairingTokenExpiresAt = tokenExpiresAt();
      node.status.lastSeenAt = new Date();

      await node.save();

      res.json({
        success: true,
        data: {
          nodeId,
          pairingToken: token,
          // If already paired, return current encryption key so gateway
          // can re-send ACTIVATE if needed after a reboot
          isPaired:  !!node.gatewayId,
          gatewayMatch: node.gatewayHardwareId === gatewayHardwareId,
        },
      });
    } catch (err) {
      console.error('[Registry] node registration error:', err);
      res.status(500).json({ success: false, message: 'Node registration failed' });
    }
  }
);

// =====================================================
// POST /api/registry/gateway/heartbeat
// Gateway sends periodic heartbeat — updates online status
// and returns any pending commands for this gateway.
//
// Auth: Gateway API key
// =====================================================
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

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId });
      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      gateway.lastSeenAt             = new Date();
      gateway.status.online          = true;
      gateway.status.lastHeartbeatAt = new Date();
      if (rssi !== undefined) gateway.status.rssi = rssi;
      if (snr  !== undefined) gateway.status.snr  = snr;
      await gateway.save();

      // Return any pending commands not yet sent via MQTT
      // (fallback for gateways that missed the MQTT push)
      const pendingCommands = await Command.find({
        gatewayHardwareId,
        status: 'pending',
      }).sort({ createdAt: 1 }).limit(10);

      res.json({
        success: true,
        data: {
          pendingCommands: pendingCommands.map(c => ({
            cmdId:   c._id,
            cmd:     c.type,
            nodeId:  c.nodeId,
            payload: c.payload,
          })),
        },
      });
    } catch (err) {
      console.error('[Registry] heartbeat error:', err);
      res.status(500).json({ success: false, message: 'Heartbeat failed' });
    }
  }
);

// =====================================================
// POST /api/registry/command/ack
// Gateway acknowledges a command it has processed.
//
// Auth: Gateway API key
// =====================================================
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
  }
);

router.post(
  '/pair-node',
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('nodeId').isString().notEmpty(),
    body('nodeName').optional().isString(),
    body('nodeBleMac').optional().isString(),
    body('token').isString().notEmpty(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    const route = 'Registry/pair-node';

    try {
      logStep(route, 'request received', {
        gatewayHardwareId: req.body.gatewayHardwareId,
        nodeId: req.body.nodeId,
        nodeName: req.body.nodeName,
        nodeBleMac: req.body.nodeBleMac,
        tokenPreview: shortToken(req.body.token),
      });

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logStep(route, 'validation failed', { errors: errors.array() });
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { gatewayHardwareId, nodeId, nodeName, nodeBleMac, token } = req.body;

      let payload: any;
      try {
        payload = jwt.verify(token, config.jwt.secret) as { id: string };
        logStep(route, 'jwt verified', { userId: payload.id });
      } catch (err: any) {
        logStep(route, 'jwt verification failed', { error: err?.message || String(err) });
        res.status(401).json({ success: false, message: 'Invalid token' });
        return;
      }

      logStep(route, 'looking up gateway', { gatewayHardwareId });
      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId });

      if (!gateway) {
        logStep(route, 'gateway not found', { gatewayHardwareId });
        res.status(404).json({ success: false, message: 'Gateway not found for this user' });
        return;
      }

      logStep(route, 'gateway found', {
        gatewayDbId: gateway._id?.toString(),
        ownerId: gateway.ownerId?.toString() || null,
      });

      if (!gateway.ownerId || gateway.ownerId.toString() !== payload.id) {
        logStep(route, 'gateway ownership mismatch', {
          gatewayOwnerId: gateway.ownerId?.toString() || null,
          tokenUserId: payload.id,
        });
        res.status(404).json({ success: false, message: 'Gateway not found for this user' });
        return;
      }

      logStep(route, 'looking up node', { nodeId });
      let node = await IotNode.findOne({ nodeId });

      const aesKey = generateEncryptionKey();
      logStep(route, 'generated aes key', {
        nodeExists: !!node,
        aesKeyPreview: `${aesKey.slice(0, 6)}...${aesKey.slice(-4)}`,
      });

      if (!node) {
        node = new IotNode({
          nodeId,
          gatewayId: gateway._id,
          gatewayHardwareId,
          name: nodeName || `Node ${nodeId}`,
          bleMac: nodeBleMac || '',
          encryptionKey: aesKey,
          status: {
            active: false,
            lastSeenAt: new Date(),
          },
        });
        logStep(route, 'creating new node document');
      } else {
        node.gatewayId = gateway._id;
        (node as any).gatewayHardwareId = gatewayHardwareId;
        (node as any).name = nodeName || (node as any).name;
        (node as any).bleMac = nodeBleMac || (node as any).bleMac;
        (node as any).encryptionKey = aesKey;
        node.status.lastSeenAt = new Date();
        logStep(route, 'updating existing node document', {
          existingNodeId: node._id?.toString(),
        });
      }

      await node.save();
      logStep(route, 'node saved successfully', {
        nodeDbId: node._id?.toString(),
        pairedGatewayHardwareId: gatewayHardwareId,
      });

      res.json({
        success: true,
        message: 'Node paired',
        data: {
          gatewayHardwareId,
          nodeId,
          aesKey,
          nodeName: nodeName || `Node ${nodeId}`,
        },
      });

      logStep(route, 'response sent', { status: 200, nodeId, gatewayHardwareId });
    } catch (err: any) {
      logStep(route, 'unhandled error', {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      });
      res.status(500).json({ success: false, message: 'Pairing failed' });
    }
  }
);

router.post(
  '/gateway/provision',
  [
    body('gatewayHardwareId').isString().notEmpty(),
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

      const { gatewayHardwareId, firmwareVersion, token, gatewayName } = req.body;

      // Verify JWT from UI auth service
      let payload: any;
      try {
        payload = jwt.verify(token, config.jwt.secret) as { id: string };
      } catch {
        res.status(401).json({ success: false, message: 'Invalid token' });
        return;
      }

      let gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId });

        if (!gateway) {
          gateway = new Gateway({
            gatewayId: gatewayHardwareId,
            ownerId: payload.id as any,
            pairedAt: new Date(),
            lastSeenAt: new Date(),
            mqttTopic: `commands/gateway/${gatewayHardwareId}`,
            status: {
              online: true,
              lastHeartbeatAt: new Date(),
              firmwareVersion: firmwareVersion || '',
            },
            name: gatewayName && String(gatewayName).trim()
              ? String(gatewayName).trim()
              : `Gateway ${gatewayHardwareId.slice(-6)}`,
          });
        } else {
          if (gateway.ownerId && gateway.ownerId.toString() !== payload.id) {
            res.status(409).json({
              success: false,
              message: 'Gateway already linked to another account'
            });
            return;
          }

          gateway.ownerId = payload.id as any;
          gateway.pairedAt = gateway.pairedAt || new Date();
          gateway.lastSeenAt = new Date();
          gateway.status.online = true;
          gateway.status.lastHeartbeatAt = new Date();

          if (firmwareVersion) {
            gateway.status.firmwareVersion = firmwareVersion;
          }

          if (gatewayName && String(gatewayName).trim()) {
            gateway.name = String(gatewayName).trim();
          }

          if (!gateway.mqttTopic) {
            gateway.mqttTopic = `commands/gateway/${gateway.gatewayId}`;
          }
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
  }
);

// =====================================================
// POST /api/registry/gateway/node-status
// Gateway reports IoT node status update
// (active/inactive, last seen, signal quality)
//
// Auth: Gateway API key
// =====================================================
router.post(
  '/gateway/node-status',
  authenticateGateway,
  [
    body('nodeId').isString().notEmpty(),
    body('gatewayHardwareId').isString().notEmpty(),
    body('active').isBoolean(),
    body('rssi').optional().isNumeric(),
    body('snr').optional().isNumeric(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { nodeId, active, rssi, snr } = req.body;

      const node = await IotNode.findOne({
          nodeId,
          gatewayHardwareId: req.body.gatewayHardwareId,
        });
      if (!node) {
        res.status(404).json({ success: false, message: 'Node not found' });
        return;
      }

      node.status.active    = active;
      node.status.lastSeenAt = new Date();
      if (rssi !== undefined) node.status.lastRssi = rssi;
      if (snr  !== undefined) node.status.lastSnr  = snr;
      await node.save();

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Status update failed' });
    }
  }
);

export default router;
