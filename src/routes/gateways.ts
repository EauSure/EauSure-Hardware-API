import express, { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import crypto from 'crypto';
import Gateway from '../models/Gateway';
import IotNode from '../models/IotNode';
import PairingSession from '../models/PairingSession';
import { authenticate } from '../middleware/auth';
import { ensureDatabaseReady } from '../services/database';
import {
  deriveGatewayProvisioningSession,
  deriveNodeApPassword,
  gatewayProvisioningExpiresAt,
  generateGatewayProvisioningToken,
  pairingSessionExpiresAt,
} from '../services/pairingService';
import {
  sendCommand,
  buildConfirmPairingPayload,
  buildSetConfigPayload,
} from '../services/commandService';

import mqtt from 'mqtt';
import config from '../config';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const dbReady = await ensureDatabaseReady();
    if (!dbReady) {
      res.status(503).json({ success: false, message: 'Database unavailable' });
      return;
    }

    const gateways = await Gateway.find({ ownerId: req.user!.id })
      .select('-deviceSecret')
      .lean()
      .sort({ createdAt: -1 });

    const now = Date.now();
    const data = gateways.map(gw => {
      if (gw.lastSeenAt) {
        gw.status = gw.status || { online: false, rssi: 0, snr: 0, firmwareVersion: '', lastHeartbeatAt: null };
        const measureIntervalMs = (gw.config?.measureInterval || 60) * 1000;
        // Consider gateway online if seen within the measure interval + 2 minutes margin
        gw.status.online = (now - new Date(gw.lastSeenAt).getTime()) < (measureIntervalMs + 120000);
      }
      return gw;
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('[Gateways] list error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch gateways' });
  }
});

router.delete(
  '/:gatewayId',
  [param('gatewayId').isString().notEmpty()],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const gateway = await Gateway.findOne({
        _id: req.params.gatewayId,
        ownerId: req.user!.id,
      }).select('+deviceSecret');

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      await IotNode.updateMany(
        { gatewayId: gateway._id },
        {
          $set: {
            gatewayId: null,
            gatewayHardwareId: null,
            encryptionKey: null,
            pairedAt: null,
            'status.active': false,
          },
        },
      );

      gateway.ownerId = null;
      gateway.pairedAt = null;
      await gateway.save();

      res.json({ success: true, message: 'Gateway unlinked from account' });
    } catch (err) {
      console.error('[Gateways] unlink error:', err);
      res.status(500).json({ success: false, message: 'Failed to unlink gateway' });
    }
  },
);

router.get('/:gatewayId/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const dbReady = await ensureDatabaseReady();
    if (!dbReady) {
      res.status(503).json({ success: false, message: 'Database unavailable' });
      return;
    }

    const gateway = await Gateway.findOne({
      _id: req.params.gatewayId,
      ownerId: req.user!.id,
    }).select('gatewayId name status lastSeenAt');

    if (!gateway) {
      res.status(404).json({ success: false, message: 'Gateway not found' });
      return;
    }

    res.json({ success: true, data: gateway });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch status' });
  }
});

router.put(
  '/:gatewayId/config',
  [
    param('gatewayId').isString(),
    body('measureInterval').optional().isInt({ min: 10, max: 3600 }),
    body('shakeEnabled').optional().isBoolean(),
    body('shakeThreshold').optional().isFloat({ min: 0.5, max: 5.0 }),
    body('units').optional().isIn(['metric', 'imperial']),
    body('nodeActive').optional().isBoolean(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({
          success: false,
          message: 'Database unavailable. Retry provisioning in a few seconds.',
        });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gateway = await Gateway.findOne({
        _id: req.params.gatewayId,
        ownerId: req.user!.id,
      }).select('+deviceSecret');

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const allowed = ['measureInterval', 'shakeEnabled', 'shakeThreshold', 'units', 'nodeActive'];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      Object.assign(gateway.config, updates);
      await gateway.save();

      const { ok, commandId } = await sendCommand(
        gateway,
        'SET_CONFIG',
        buildSetConfigPayload(updates),
        null,
      );

      res.json({
        success: true,
        message: 'Config updated',
        data: { config: gateway.config, commandId, mqttPublished: ok },
      });
    } catch (err) {
      console.error('[Gateways] config error:', err);
      res.status(500).json({ success: false, message: 'Failed to update config' });
    }
  },
);

router.get('/:gatewayId/nodes', async (req: Request, res: Response): Promise<void> => {
  try {
    const dbReady = await ensureDatabaseReady();
    if (!dbReady) {
      res.status(503).json({ success: false, message: 'Database unavailable' });
      return;
    }

    const gateway = await Gateway.findOne({
      _id: req.params.gatewayId,
      ownerId: req.user!.id,
    });

    if (!gateway) {
      res.status(404).json({ success: false, message: 'Gateway not found' });
      return;
    }

    const nodes = await IotNode.find({ gatewayId: gateway._id })
      .select('-deviceSecret -encryptionKey')
      .lean();

    const now = Date.now();
    const measureIntervalMs = (gateway.config?.measureInterval || 60) * 1000;
    const data = nodes.map(node => {
      if (node.status && node.status.lastSeenAt) {
        // Node is active if seen within the measure interval + 3 minutes margin
        node.status.active = (now - new Date(node.status.lastSeenAt).getTime()) < (measureIntervalMs + 180000);
      }
      return node;
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch nodes' });
  }
});

router.post(
  '/provisioning/session',
  [
    body('gatewayHardwareId').isString().notEmpty(),
    body('challenge').isString().isLength({ min: 8, max: 128 }),
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
          message: 'Database unavailable. Retry provisioning in a few seconds.',
        });
        return;
      }

      const gatewayHardwareId = String(req.body.gatewayHardwareId).trim().toUpperCase();
      const challenge = String(req.body.challenge).trim();

      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId }).select('+deviceSecret');
      if (!gateway) {
        res.status(404).json({
          success: false,
          message: 'Gateway is not pre-registered. Register gatewayId and deviceSecret first.',
        });
        return;
      }

      if (!gateway.deviceSecret || !gateway.deviceSecret.trim()) {
        res.status(409).json({
          success: false,
          message: 'Gateway is missing its configured device secret.',
        });
        return;
      }

      if (gateway.ownerId && gateway.ownerId.toString() !== req.user!.id) {
        res.status(409).json({
          success: false,
          message: 'Gateway already linked to another account',
        });
        return;
      }

      const sessionId = crypto.randomUUID();
      const { encKeyHex, macKeyHex, serverProof } = deriveGatewayProvisioningSession({
        deviceSecret: gateway.deviceSecret,
        gatewayHardwareId,
        challenge,
        sessionId,
      });
      const provisioningToken = generateGatewayProvisioningToken({
        sessionId,
        userId: req.user!.id,
        gatewayHardwareId,
        challenge,
      });

      res.status(201).json({
        success: true,
        data: {
          gatewayHardwareId,
          challenge,
          sessionId,
          provisioningToken,
          encKeyHex,
          macKeyHex,
          serverProof,
          expiresAt: gatewayProvisioningExpiresAt(),
        },
      });
    } catch (err) {
      console.error('[Gateways] provisioning session error:', err);
      res.status(500).json({ success: false, message: 'Failed to create provisioning session' });
    }
  },
);

router.get(
  '/:gatewayId/pairing/scan',
  [param('gatewayId').isString().notEmpty()],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const gateway = await Gateway.findOne({
        _id: req.params.gatewayId,
        ownerId: req.user!.id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      // Temporarily connect to MQTT to perform the request-response flow
      const client = mqtt.connect(config.mqtt.brokerUrl, {
        clientId: `${config.mqtt.clientId}-scan-${Date.now()}`,
        username: config.mqtt.username,
        password: config.mqtt.password,
        connectTimeout: 5000,
        reconnectPeriod: 0,
        rejectUnauthorized: false,
      });

      const eventsTopic = `events/gateway/${gateway.gatewayId}`;
      const commandsTopic = `commands/gateway/${gateway.gatewayId}`;

      let responded = false;
      const timeoutMs = 25000; // ESP32 WiFi scan can take 10-15s; give enough margin before Vercel 30s limit

      const finish = (status: number, payload: any) => {
        if (!responded) {
          responded = true;
          client.end();
          res.status(status).json(payload);
        }
      };

      client.on('connect', () => {
        client.subscribe(eventsTopic, { qos: 1 }, (err) => {
          if (err) {
            console.error('[MQTT] Scan subscribe error:', err);
            finish(500, { success: false, message: 'Failed to subscribe to MQTT' });
            return;
          }

          // Delay slightly to ensure subscription is active on broker
          setTimeout(() => {
            const payload = JSON.stringify({ cmd: 'SCAN_NODES', ts: Date.now() });
            client.publish(commandsTopic, payload, { qos: 1 });
          }, 500);

          // Start timeout
          setTimeout(() => {
            finish(408, { success: false, message: 'Scan timeout. No nodes found.' });
          }, timeoutMs);
        });
      });

      client.on('message', (topic, message) => {
        if (topic === eventsTopic) {
          try {
            const data = JSON.parse(message.toString());
            if (data.event === 'candidate_found') {
              finish(200, { success: true, data: {
                nodeId: data.nodeId,
                nodeName: data.nodeName,
                bleMac: data.bleMac
              }});
            }
          } catch (e) {
            // ignore parse errors from other events
          }
        }
      });

      client.on('error', (err) => {
        console.error('[MQTT] Scan client error:', err);
        finish(500, { success: false, message: 'MQTT connection error' });
      });

    } catch (err) {
      console.error('[Gateways] scan nodes error:', err);
      res.status(500).json({ success: false, message: 'Failed to trigger scan' });
    }
  }
);

router.post(
  '/:gatewayId/pairing/confirm-candidate',
  [
    param('gatewayId').isString().notEmpty(),
    body('nodeId').isString().notEmpty(),
    body('nodeName').optional().isString().trim(),
    body('bleMac').isString().notEmpty(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gateway = await Gateway.findOne({
        _id: req.params.gatewayId,
        ownerId: req.user!.id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const nodeId = String(req.body.nodeId).trim().toUpperCase();
      const nodeName = req.body.nodeName && String(req.body.nodeName).trim()
        ? String(req.body.nodeName).trim()
        : `Node ${nodeId}`;
      const bleMac = String(req.body.bleMac).trim().toUpperCase();

      const existingNode = await IotNode.findOne({ nodeId }).select('+encryptionKey +deviceSecret');
      if (!existingNode) {
        res.status(404).json({
          success: false,
          message: 'IoT node is not pre-registered. Register nodeId and deviceSecret first.',
        });
        return;
      }

      if (!existingNode.deviceSecret || !existingNode.deviceSecret.trim()) {
        res.status(409).json({
          success: false,
          message: 'IoT node is missing its configured device secret.',
        });
        return;
      }

      if (existingNode.gatewayId && !existingNode.gatewayId.equals(gateway._id as any)) {
        res.status(409).json({ success: false, message: 'IoT node already paired to another gateway' });
        return;
      }

      await PairingSession.updateMany(
        {
          gatewayId: gateway._id,
          nodeId,
          status: { $in: ['confirmed', 'consumed'] },
        },
        {
          $set: {
            status: 'failed',
            failedAt: new Date(),
            failureReason: 'Superseded by a newer confirmation',
          },
        },
      );

      const session = new PairingSession({
        userId: req.user!.id as unknown as mongoose.Types.ObjectId,
        gatewayId: gateway._id,
        gatewayHardwareId: gateway.gatewayId,
        nodeId,
        nodeName,
        bleMac,
        tokenId: new mongoose.Types.ObjectId().toString(),
        status: 'confirmed',
        expiresAt: pairingSessionExpiresAt(),
      });
      await session.save();

      const apPassword = deriveNodeApPassword(nodeId, existingNode.deviceSecret);

      const { ok, commandId } = await sendCommand(
        gateway,
        'CONFIRM_PAIRING',
        buildConfirmPairingPayload({
          nodeId,
          nodeName,
          bleMac,
          sessionId: session.tokenId,
          apPassword,
        }),
        nodeId,
      );

      res.status(201).json({
        success: true,
        message: 'Pairing confirmation sent to gateway',
        data: {
          nodeId,
          nodeName,
          bleMac,
          sessionId: session.tokenId,
          apPassword,
          commandId,
          mqttPublished: ok,
          expiresAt: session.expiresAt,
        },
      });
    } catch (err) {
      console.error('[Gateways] confirm candidate error:', err);
      res.status(500).json({ success: false, message: 'Failed to confirm pairing candidate' });
    }
  },
);

router.get(
  '/:gatewayId/pairing/session/:sessionId',
  [
    param('gatewayId').isString().notEmpty(),
    param('sessionId').isString().notEmpty(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const session = await PairingSession.findOne({ tokenId: req.params.sessionId });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }

      // Check ownership
      if (session.userId.toString() !== req.user!.id) {
        res.status(403).json({ success: false, message: 'Access denied' });
        return;
      }

      res.json({
        success: true,
        data: {
          status: session.status,
          failureReason: session.failureReason,
        }
      });
    } catch (err) {
      console.error('[Gateways] get session error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch session status' });
    }
  }
);

router.put(
  '/:gatewayId/location',
  [
    param('gatewayId').isString().notEmpty(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
    body('city').optional().isString().trim(),
    body('country').optional().isString().trim(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gateway = await Gateway.findOne({
        _id: req.params.gatewayId,
        ownerId: req.user!.id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      gateway.location = {
        lat: parseFloat(req.body.lat),
        lng: parseFloat(req.body.lng),
        city: req.body.city?.trim() || gateway.location?.city || '',
        country: req.body.country?.trim() || gateway.location?.country || '',
      };
      await gateway.save();

      console.log(`[Gateways] location updated — ${gateway.gatewayId} lat:${gateway.location.lat} lng:${gateway.location.lng}`);

      res.json({
        success: true,
        message: 'Gateway location updated',
        data: { location: gateway.location },
      });
    } catch (err) {
      console.error('[Gateways] location update error:', err);
      res.status(500).json({ success: false, message: 'Failed to update gateway location' });
    }
  },
);

router.delete('/:gatewayId/nodes/:nodeId', async (req: Request, res: Response): Promise<void> => {
  try {
    const dbReady = await ensureDatabaseReady();
    if (!dbReady) {
      res.status(503).json({ success: false, message: 'Database unavailable' });
      return;
    }

    const gateway = await Gateway.findOne({
      _id: req.params.gatewayId,
      ownerId: req.user!.id,
    });

    if (!gateway) {
      res.status(404).json({ success: false, message: 'Gateway not found' });
      return;
    }

    const node = await IotNode.findOne({
      nodeId: req.params.nodeId,
      gatewayId: gateway._id,
    });

    if (!node) {
      res.status(404).json({ success: false, message: 'IoT node not found on this gateway' });
      return;
    }

    await sendCommand(gateway, 'UNPAIR_NODE', { nodeId: node.nodeId }, node.nodeId);

    node.gatewayId = null;
    node.gatewayHardwareId = null;
    node.encryptionKey = null;
    node.pairedAt = null;
    node.status.active = false;
    await node.save();

    res.json({ success: true, message: 'IoT node unpaired' });
  } catch (err) {
    console.error('[Gateways] node unpair error:', err);
    res.status(500).json({ success: false, message: 'Failed to unpair node' });
  }
});

router.post('/:gatewayId/nodes/:nodeId/measure', async (req: Request, res: Response): Promise<void> => {
  try {
    const dbReady = await ensureDatabaseReady();
    if (!dbReady) {
      res.status(503).json({ success: false, message: 'Database unavailable' });
      return;
    }

    const gateway = await Gateway.findOne({
      _id: req.params.gatewayId,
      ownerId: req.user!.id,
    });

    if (!gateway) {
      res.status(404).json({ success: false, message: 'Gateway not found' });
      return;
    }

    const node = await IotNode.findOne({
      nodeId: req.params.nodeId,
      gatewayId: gateway._id,
    });

    if (!node) {
      res.status(404).json({ success: false, message: 'IoT node not found on this gateway' });
      return;
    }

    if (!node.status.active) {
      res.status(400).json({ success: false, message: 'IoT node is not active' });
      return;
    }

    const { ok, commandId } = await sendCommand(gateway, 'MEASURE_NOW', {}, node.nodeId);

    res.json({
      success: true,
      message: 'Measure command sent',
      data: { commandId, mqttPublished: ok },
    });
  } catch (err) {
    console.error('[Gateways] measure error:', err);
    res.status(500).json({ success: false, message: 'Failed to send measure command' });
  }
});

router.put(
  '/:gatewayId/nodes/:nodeId/config',
  [
    param('gatewayId').isString(),
    param('nodeId').isString(),
    body('measureInterval').optional().isInt({ min: 1800, max: 28800 }),
    body('shakeEnabled').optional().isBoolean(),
    body('shakeThreshold').optional().isFloat({ min: 0.5, max: 5.0 }),
    body('units').optional().isIn(['metric', 'imperial']),
    body('nodeActive').optional().isBoolean(),
    body('alertMode').optional().isIn(['all', 'critical_only', 'none']),
    body('gatewayVocalAlerts').optional().isBoolean(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 64 }),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const dbReady = await ensureDatabaseReady();
      if (!dbReady) {
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gateway = await Gateway.findOne({
        _id: req.params.gatewayId,
        ownerId: req.user!.id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const node = await IotNode.findOne({
        nodeId: req.params.nodeId,
        gatewayId: gateway._id,
      }).select('+deviceSecret');

      if (!node) {
        res.status(404).json({ success: false, message: 'IoT node not found' });
        return;
      }

      const allowed = ['measureInterval', 'shakeEnabled', 'shakeThreshold', 'units', 'nodeActive', 'alertMode', 'gatewayVocalAlerts', 'name'];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      // Persist config on the node document
      if (!node.config) (node as any).config = {};
      Object.assign(node.config, updates);
      if (updates.name) node.name = updates.name;
      await node.save();

      // Forward only shake config to node via LoRa SET_CONFIG
      // measureInterval and nodeActive are gateway-side only
      const hwFields = ['shakeEnabled', 'shakeThreshold'];
      const hwUpdates: Record<string, any> = {};
      for (const key of hwFields) {
        if (updates[key] !== undefined) hwUpdates[key] = updates[key];
      }

      let mqttPublished = false;
      let commandId: string | undefined;
      if (Object.keys(hwUpdates).length > 0) {
        const result = await sendCommand(
          gateway,
          'SET_CONFIG',
          buildSetConfigPayload(hwUpdates, node.nodeId),
          node.nodeId,
        );
        mqttPublished = result.ok;
        commandId = result.commandId;
      }

      res.json({
        success: true,
        message: 'Node config updated',
        data: { config: node.config, commandId, mqttPublished },
      });
    } catch (err) {
      console.error('[Gateways] node config error:', err);
      res.status(500).json({ success: false, message: 'Failed to update node config' });
    }
  },
);

export default router;
