import express, { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import Gateway from '../models/Gateway';
import IotNode from '../models/IotNode';
import { authenticate } from '../middleware/auth';
import { verifyPairingToken, generateEncryptionKey } from '../services/pairingService';
import { sendCommand, buildPairNodePayload, buildSetConfigPayload } from '../services/commandService';

const router = express.Router();

// All gateway routes require JWT auth
router.use(authenticate);

// =====================================================
// GET /api/gateways
// List all gateways owned by the authenticated user
// =====================================================
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const gateways = await Gateway.find({ ownerId: req.user!._id })
      .select('-deviceSecret -pairingToken')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: gateways });
  } catch (err) {
    console.error('[Gateways] list error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch gateways' });
  }
});

// =====================================================
// POST /api/gateways/pair
// Link a gateway to the authenticated user account via QR token
// =====================================================
router.post(
  '/pair',
  [body('token').isString().notEmpty(), body('name').optional().isString().trim()],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const { token, name } = req.body;

      // Decode token to extract the gatewayId before DB lookup
      let gatewayIdFromToken: string;
      try {
        const json = Buffer.from(token, 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        gatewayIdFromToken = parsed.id;
      } catch {
        res.status(400).json({ success: false, message: 'Malformed pairing token' });
        return;
      }

      // Fetch gateway with its secret (select:false field)
      const gateway = await Gateway.findOne({ gatewayId: gatewayIdFromToken })
        .select('+deviceSecret +pairingToken +pairingTokenExpiresAt');

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      // Check if already owned by someone else
      if (gateway.ownerId && !gateway.ownerId.equals(req.user!._id as any)) {
        res.status(409).json({ success: false, message: 'Gateway already paired to another account' });
        return;
      }

      // Verify HMAC signature
      try {
        verifyPairingToken(token, gateway.deviceSecret);
      } catch (err: any) {
        res.status(401).json({ success: false, message: err.message });
        return;
      }

      // All good — link gateway to user
      gateway.ownerId  = req.user!._id as unknown as mongoose.Types.ObjectId;
      gateway.pairedAt = new Date();
      gateway.name     = name || gateway.name;
      gateway.mqttTopic = `commands/gateway/${gateway.gatewayId}`;
      // Invalidate token after successful use (single-use)
      (gateway as any).pairingToken          = null;
      (gateway as any).pairingTokenExpiresAt = null;

      await gateway.save();

      res.status(200).json({
        success: true,
        message: 'Gateway paired successfully',
        data: {
          id:        gateway._id,
          gatewayId: gateway.gatewayId,
          name:      gateway.name,
          pairedAt:  gateway.pairedAt,
          config:    gateway.config,
          status:    gateway.status,
        },
      });
    } catch (err) {
      console.error('[Gateways] pair error:', err);
      res.status(500).json({ success: false, message: 'Pairing failed' });
    }
  }
);

// =====================================================
// DELETE /api/gateways/:gatewayId
// Unlink gateway from user account
// =====================================================
router.delete(
  '/:gatewayId',
  [param('gatewayId').isString().notEmpty()],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      // Unpair all IoT nodes attached to this gateway
      await IotNode.updateMany(
        { gatewayId: gateway._id },
        {
          $set: {
            gatewayId:         null,
            gatewayHardwareId: null,
            encryptionKey:     null,
            pairedAt:          null,
            'status.active':   false,
          },
        }
      );

      // Unlink gateway
      gateway.ownerId  = null;
      gateway.pairedAt = null;
      await gateway.save();

      res.json({ success: true, message: 'Gateway unlinked from account' });
    } catch (err) {
      console.error('[Gateways] unlink error:', err);
      res.status(500).json({ success: false, message: 'Failed to unlink gateway' });
    }
  }
);

// =====================================================
// GET /api/gateways/:gatewayId/status
// Health and connectivity of a specific gateway
// =====================================================
router.get(
  '/:gatewayId/status',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      }).select('gatewayId name status lastSeenAt');

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      res.json({ success: true, data: gateway });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to fetch status' });
    }
  }
);

// =====================================================
// PUT /api/gateways/:gatewayId/config
// Update gateway + node config — immediately pushed via MQTT
// =====================================================
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
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      // Merge config fields
      const allowed = ['measureInterval', 'shakeEnabled', 'shakeThreshold', 'units', 'nodeActive'];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      Object.assign(gateway.config, updates);
      await gateway.save();

      // Push to gateway via MQTT immediately
      const { ok, commandId } = await sendCommand(
        gateway,
        'SET_CONFIG',
        buildSetConfigPayload(updates),
        null
      );

      res.json({
        success: true,
        message: 'Config updated',
        data:    { config: gateway.config, commandId, mqttPublished: ok },
      });
    } catch (err) {
      console.error('[Gateways] config error:', err);
      res.status(500).json({ success: false, message: 'Failed to update config' });
    }
  }
);

// =====================================================
// GET /api/gateways/:gatewayId/nodes
// List IoT nodes paired to a gateway
// =====================================================
router.get(
  '/:gatewayId/nodes',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const nodes = await IotNode.find({ gatewayId: gateway._id })
        .select('-deviceSecret -pairingToken -encryptionKey');

      res.json({ success: true, data: nodes });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to fetch nodes' });
    }
  }
);

// =====================================================
// POST /api/gateways/:gatewayId/nodes/pair
// Pair an IoT node to a gateway via QR token
// =====================================================
router.post(
  '/:gatewayId/nodes/pair',
  [
    param('gatewayId').isString(),
    body('token').isString().notEmpty(),
    body('name').optional().isString().trim(),
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, errors: errors.array() });
        return;
      }

      // Verify gateway belongs to user
      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const { token, name } = req.body;

      // Decode node ID from token
      let nodeIdFromToken: string;
      try {
        const json   = Buffer.from(token, 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        nodeIdFromToken = parsed.id;
      } catch {
        res.status(400).json({ success: false, message: 'Malformed pairing token' });
        return;
      }

      // Fetch node with secret
      const node = await IotNode.findOne({ nodeId: nodeIdFromToken })
        .select('+deviceSecret +pairingToken +encryptionKey');

      if (!node) {
        res.status(404).json({ success: false, message: 'IoT node not found' });
        return;
      }

      // Check not already paired to a different gateway
      if (node.gatewayId && !node.gatewayId.equals(gateway._id as any)) {
        res.status(409).json({ success: false, message: 'IoT node already paired to another gateway' });
        return;
      }

      // Verify HMAC
      try {
        verifyPairingToken(token, node.deviceSecret);
      } catch (err: any) {
        res.status(401).json({ success: false, message: err.message });
        return;
      }

      // Generate a fresh AES-128 key for this pairing
      const encryptionKey = generateEncryptionKey();

      // Update node
      node.gatewayId         = gateway._id as unknown as mongoose.Types.ObjectId;
      node.gatewayHardwareId = gateway.gatewayId;
      node.encryptionKey     = encryptionKey;
      node.pairedAt          = new Date();
      node.name              = name || node.name;
      (node as any).pairingToken          = null;
      (node as any).pairingTokenExpiresAt = null;
      await node.save();

      // Push PAIR_NODE command to gateway via MQTT
      // Gateway will forward this to IoT node as an ACTIVATE frame with new key
      const { ok, commandId } = await sendCommand(
        gateway,
        'PAIR_NODE',
        buildPairNodePayload(node.nodeId, encryptionKey, gateway.config),
        node.nodeId
      );

      res.status(201).json({
        success: true,
        message: 'IoT node paired to gateway',
        data: {
          nodeId:       node.nodeId,
          name:         node.name,
          pairedAt:     node.pairedAt,
          commandId,
          mqttPublished: ok,
        },
      });
    } catch (err) {
      console.error('[Gateways] node pair error:', err);
      res.status(500).json({ success: false, message: 'Node pairing failed' });
    }
  }
);

// =====================================================
// DELETE /api/gateways/:gatewayId/nodes/:nodeId
// Unpair an IoT node from its gateway
// =====================================================
router.delete(
  '/:gatewayId/nodes/:nodeId',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const node = await IotNode.findOne({
        nodeId:    req.params.nodeId,
        gatewayId: gateway._id,
      });

      if (!node) {
        res.status(404).json({ success: false, message: 'IoT node not found on this gateway' });
        return;
      }

      // Push UNPAIR_NODE to gateway via MQTT
      // Gateway sends a reset frame to IoT node → node clears gatewayId + key
      await sendCommand(gateway, 'UNPAIR_NODE', { nodeId: node.nodeId }, node.nodeId);

      // Clear pairing in DB
      node.gatewayId         = null;
      node.gatewayHardwareId = null;
      node.encryptionKey     = null;
      node.pairedAt          = null;
      node.status.active     = false;
      await node.save();

      res.json({ success: true, message: 'IoT node unpaired' });
    } catch (err) {
      console.error('[Gateways] node unpair error:', err);
      res.status(500).json({ success: false, message: 'Failed to unpair node' });
    }
  }
);

// =====================================================
// POST /api/gateways/:gatewayId/nodes/:nodeId/measure
// Trigger an instant on-demand measurement
// =====================================================
router.post(
  '/:gatewayId/nodes/:nodeId/measure',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const gateway = await Gateway.findOne({
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const node = await IotNode.findOne({
        nodeId:    req.params.nodeId,
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

      const { ok, commandId } = await sendCommand(
        gateway,
        'MEASURE_NOW',
        {},
        node.nodeId
      );

      res.json({
        success: true,
        message: 'Measure command sent',
        data:    { commandId, mqttPublished: ok },
      });
    } catch (err) {
      console.error('[Gateways] measure error:', err);
      res.status(500).json({ success: false, message: 'Failed to send measure command' });
    }
  }
);

// =====================================================
// PUT /api/gateways/:gatewayId/nodes/:nodeId/config
// Update per-node config and push via MQTT
// =====================================================
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
        _id:     req.params.gatewayId,
        ownerId: req.user!._id,
      });

      if (!gateway) {
        res.status(404).json({ success: false, message: 'Gateway not found' });
        return;
      }

      const node = await IotNode.findOne({
        nodeId:    req.params.nodeId,
        gatewayId: gateway._id,
      });

      if (!node) {
        res.status(404).json({ success: false, message: 'IoT node not found' });
        return;
      }

      const allowed = ['measureInterval', 'shakeEnabled', 'shakeThreshold', 'units', 'nodeActive'];
      const updates: Record<string, any> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }

      const { ok, commandId } = await sendCommand(
        gateway,
        'SET_CONFIG',
        buildSetConfigPayload(updates, node.nodeId),
        node.nodeId
      );

      res.json({
        success: true,
        message: 'Node config update sent',
        data:    { commandId, mqttPublished: ok, updates },
      });
    } catch (err) {
      console.error('[Gateways] node config error:', err);
      res.status(500).json({ success: false, message: 'Failed to update node config' });
    }
  }
);

export default router;
