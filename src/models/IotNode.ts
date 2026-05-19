import mongoose, { Document, Schema } from 'mongoose';

export interface IIotNodeStatus {
  active: boolean;
  lastSeenAt: Date | null;
  firmwareVersion: string;
  lastRssi: number;
  lastSnr: number;
  lastBattery: number;
}

export interface IIotNodeConfig {
  measureInterval: number;      // seconds — 60 (1min) to 28800 (8h)
  shakeEnabled: boolean;
  shakeThreshold: number;       // always stored in g internally
  units: 'metric' | 'imperial';
  nodeActive: boolean;
  alertMode: 'all' | 'critical_only' | 'none';
  gatewayVocalAlerts: boolean;  // per-node: gateway emits local sound alert for this node
}

export interface IIotNode extends Document {
  nodeId: string;
  deviceSecret: string;
  name: string;
  gatewayId: mongoose.Types.ObjectId | null;
  gatewayHardwareId: string | null;
  encryptionKey: string | null;
  pairedAt: Date | null;
  status: IIotNodeStatus;
  config: IIotNodeConfig;
}

const IotNodeStatusSchema = new Schema<IIotNodeStatus>({
  active: { type: Boolean, default: false },
  lastSeenAt: { type: Date, default: null },
  firmwareVersion: { type: String, default: '' },
  lastRssi: { type: Number, default: 0 },
  lastSnr: { type: Number, default: 0 },
  lastBattery: { type: Number, default: 0 },
}, { _id: false });

const IotNodeConfigSchema = new Schema<IIotNodeConfig>({
  measureInterval:    { type: Number,  default: 10800, min: 60, max: 28800 },
  shakeEnabled:       { type: Boolean, default: true },
  shakeThreshold:     { type: Number,  default: 1.1,  min: 0.5,  max: 5.0 },
  units:              { type: String,  enum: ['metric', 'imperial'], default: 'metric' },
  nodeActive:         { type: Boolean, default: true },
  alertMode:          { type: String,  enum: ['all', 'critical_only', 'none'], default: 'all' },
  gatewayVocalAlerts: { type: Boolean, default: true },
}, { _id: false });

const IotNodeSchema = new Schema<IIotNode>({
  nodeId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  deviceSecret: {
    type: String,
    required: true,
    select: false,
    trim: true,
  },
  name: {
    type: String,
    default: 'My IoT Node',
    trim: true,
  },
  gatewayId: {
    type: Schema.Types.ObjectId,
    ref: 'Gateway',
    default: null,
    index: true,
  },
  gatewayHardwareId: {
    type: String,
    default: null,
  },
  encryptionKey: {
    type: String,
    default: null,
    select: false,
  },
  pairedAt: { type: Date, default: null },
  status: { type: IotNodeStatusSchema, default: () => ({}) },
  config: { type: IotNodeConfigSchema, default: () => ({}) },
}, { timestamps: true });

export default mongoose.model<IIotNode>('IotNode', IotNodeSchema);
