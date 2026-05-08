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

const router = express.Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const gateways = await Gateway.find({ ownerId: req.user!.id })
      .select('-deviceSecret')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: gateways });
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
    const gateway = await Gateway.findOne({
      _id: req.params.gatewayId,
      ownerId: req.user!.id,
    });

    if (!gateway) {
      res.status(404).json({ success: false, message: 'Gateway not found' });
      return;
    }

    const nodes = await IotNode.find({ gatewayId: gateway._id })
      .select('-deviceSecret -encryptionKey');

    res.json({ success: true, data: nodes });
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

router.delete('/:gatewayId/nodes/:nodeId', async (req: Request, res: Response): Promise<void> => {
  try {
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
    body('measureInterval').optional().isInt({ min: 10, max: 3600 }),
    body('shakeEnabled').optional().isBoolean(),
    body('shakeThreshold').optional().isFloat({ min: 0.5, max: 5.0 }),
    body('units').optional().isIn(['metric', 'imperial']),
    body('nodeActive').optional().isBoolean(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
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

      const allowed = ['measureInterval', 'shakeEnabled', 'shakeThreshold', 'units', 'nodeActive'];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      const { ok, commandId } = await sendCommand(
        gateway,
        'SET_CONFIG',
        buildSetConfigPayload(updates, node.nodeId),
        node.nodeId,
      );

      res.json({
        success: true,
        message: 'Node config update sent',
        data: { commandId, mqttPublished: ok, updates },
      });
    } catch (err) {
      console.error('[Gateways] node config error:', err);
      res.status(500).json({ success: false, message: 'Failed to update node config' });
    }
  },
);

export default router;
