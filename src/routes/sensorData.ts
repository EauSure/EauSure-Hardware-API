import express, { Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import SensorData from '../models/SensorData';
import Gateway from '../models/Gateway';
import IotNode from '../models/IotNode';
import { authenticate, authenticateGateway } from '../middleware/auth';
import { ensureDatabaseReady } from '../services/database';
import mqttService from '../services/mqttService';

const router = express.Router();

// =====================================================
// POST /api/sensor-data
// Receive data from Gateway (API key auth).
// Gateway posts the nodeId it received data from.
// We resolve ownership (userId, gatewayId) from DB.
// =====================================================
router.post(
  '/',
  authenticateGateway,
  [
    body('seq').isInt(),
    body('nodeId').isString().notEmpty(),
    body('gatewayHardwareId').isString().notEmpty(),
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
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const payload = req.body;
      const { nodeId, gatewayHardwareId } = payload;

      // Resolve gateway and owner from hardware IDs
      const gateway = await Gateway.findOne({ gatewayId: gatewayHardwareId }).select('+deviceSecret');
      if (!gateway || !gateway.ownerId) {
        res.status(404).json({ success: false, message: 'Gateway not registered or not paired to any account' });
        return;
      }

      const node = await IotNode.findOne({ nodeId, gatewayId: gateway._id }).select('+deviceSecret');
      if (!node) {
        res.status(404).json({ success: false, message: 'IoT node not paired to this gateway' });
        return;
      }

      // Update node last-seen and signal stats
      node.status.lastSeenAt = new Date();
      node.status.lastRssi   = payload.rssi || 0;
      node.status.lastSnr    = payload.snr  || 0;
      node.status.active     = true;
      await node.save();

      // Update gateway last-seen
      gateway.lastSeenAt        = new Date();
      gateway.status.lastHeartbeatAt = new Date();
      gateway.status.online     = true;

      await gateway.save();

      const sensorData = new SensorData({
        userId:            gateway.ownerId,
        gatewayId:         gateway._id,
        gatewayHardwareId: gateway.gatewayId,
        nodeId:            node.nodeId,
        sequence:          payload.seq,
        timestamp:         new Date(),
        receivedAt:        new Date(),
        battery: {
          percentage: payload.b  ?? 0,
          voltage:    payload.v  ?? 0,
          current:    payload.m  ?? 0,
        },
        ph: {
          value: payload.p  ?? 7.0,
          score: payload.ps ?? 10,
        },
        tds: {
          value: payload.t  ?? 0,
          score: payload.ts ?? 10,
        },
        turbidity: {
          voltage: payload.u  ?? 0,
          score:   payload.us ?? 10,
        },
        temperature: {
          water: payload.tw ?? 0,
          mpu:   payload.tm ?? 0,
          esp32: payload.te ?? 0,
        },
        event: {
          type:      payload.e  ?? 'None',
          accelG:    payload.ag,
          dynAccelG: payload.dg,
        },
        signal: {
          rssi: payload.rssi ?? 0,
          snr:  payload.snr  ?? 0,
        },
        rawPayload: payload,
      });

      await sensorData.save();

      console.log(`[API] Data saved — node:${nodeId} seq:${payload.seq} event:${payload.e || 'None'}`);

      // Broadcast for real-time dashboard
      await mqttService.publishSensorData({
        userId:     gateway.ownerId,
        gatewayId:  gateway._id,
        nodeId:     node.nodeId,
        sequence:   sensorData.sequence,
        timestamp:  sensorData.timestamp,
        battery:    sensorData.battery,
        ph:         sensorData.ph,
        tds:        sensorData.tds,
        turbidity:  sensorData.turbidity,
        temperature: sensorData.temperature,
        event:      sensorData.event,
        signal:     sensorData.signal,
      });

      res.status(201).json({
        success: true,
        message: 'Sensor data received',
        data:    { id: sensorData._id, sequence: sensorData.sequence },
      });
    } catch (err) {
      console.error('[API] Error saving sensor data:', err);
      res.status(500).json({ success: false, message: 'Failed to save sensor data' });
    }
  }
);

// =====================================================
// GET /api/sensor-data
// Paginated list with filters — JWT auth, scoped to user
// =====================================================
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('gatewayId').optional().isString(),
    query('nodeId').optional().isString(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('eventType').optional().isString(),
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
        res.status(503).json({ success: false, message: 'Database unavailable' });
        return;
      }

      const page  = parseInt(req.query.page  as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip  = (page - 1) * limit;

      // Always scope to authenticated user
      const filter: any = { userId: req.user!.id };

      if (req.query.gatewayId) filter.gatewayId = req.query.gatewayId;
      if (req.query.nodeId)    filter.nodeId     = req.query.nodeId;

      if (req.query.startDate || req.query.endDate) {
        filter.timestamp = {};
        if (req.query.startDate) filter.timestamp.$gte = new Date(req.query.startDate as string);
        if (req.query.endDate)   filter.timestamp.$lte = new Date(req.query.endDate   as string);
      }

      if (req.query.eventType) filter['event.type'] = req.query.eventType;

      const [data, total] = await Promise.all([
        SensorData.find(filter)
          .sort({ timestamp: -1 })
          .limit(limit)
          .skip(skip)
          .select('-rawPayload -__v'),
        SensorData.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[API] Error fetching sensor data:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch sensor data' });
    }
  }
);

// =====================================================
// GET /api/sensor-data/latest
// Latest reading, optionally scoped to a specific node
// =====================================================
router.get(
  '/latest',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const filter: any = { userId: req.user!.id };
      if (req.query.nodeId)    filter.nodeId    = req.query.nodeId;
      if (req.query.gatewayId) filter.gatewayId = req.query.gatewayId;

      const latest = await SensorData.findOne(filter)
        .sort({ timestamp: -1 })
        .select('-rawPayload -__v');

      if (!latest) {
        res.status(404).json({ success: false, message: 'No data found' });
        return;
      }

      res.json({ success: true, data: latest });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to fetch latest data' });
    }
  }
);

// =====================================================
// GET /api/sensor-data/stats
// Aggregated stats for a time window, scoped to user
// =====================================================
router.get(
  '/stats',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const filter: any = {
        userId:    req.user!.id,
        timestamp: { $gte: new Date(Date.now() - hours * 60 * 60 * 1000) },
      };

      if (req.query.nodeId)    filter.nodeId    = req.query.nodeId;
      if (req.query.gatewayId) filter.gatewayId = req.query.gatewayId;

      const [stats, events] = await Promise.all([
        SensorData.aggregate([
          { $match: filter },
          {
            $group: {
              _id:        null,
              avgPH:      { $avg: '$ph.value' },
              avgTDS:     { $avg: '$tds.value' },
              avgTemp:    { $avg: '$temperature.water' },
              avgBattery: { $avg: '$battery.percentage' },
              minPH:      { $min: '$ph.value' },
              maxPH:      { $max: '$ph.value' },
              minTDS:     { $min: '$tds.value' },
              maxTDS:     { $max: '$tds.value' },
              count:      { $sum: 1 },
            },
          },
        ]),
        SensorData.aggregate([
          { $match: { ...filter, 'event.type': { $ne: 'None' } } },
          { $group: { _id: '$event.type', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
      ]);

      res.json({
        success: true,
        data: {
          statistics: stats[0] || {},
          events,
          period: `Last ${hours} hours`,
        },
      });
    } catch (err) {
      console.error('[API] Error fetching stats:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch statistics' });
    }
  }
);

export default router;
