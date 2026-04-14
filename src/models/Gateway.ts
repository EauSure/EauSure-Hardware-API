import mongoose, { Document, Schema } from 'mongoose';

export interface IGatewayConfig {
  measureInterval: number;
  shakeEnabled: boolean;
  shakeThreshold: number;
  units: 'metric' | 'imperial';
  nodeActive: boolean;
}

export interface IGatewayStatus {
  online: boolean;
  lastHeartbeatAt: Date | null;
  rssi: number;
  snr: number;
  firmwareVersion: string;
}

export interface IGateway extends Document {
  gatewayId: string;
  deviceSecret: string;
  name: string;
  ownerId: mongoose.Types.ObjectId | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  mqttTopic: string;
  config: IGatewayConfig;
  status: IGatewayStatus;
}

const GatewayConfigSchema = new Schema<IGatewayConfig>({
  measureInterval: { type: Number, default: 60, min: 10, max: 3600 },
  shakeEnabled: { type: Boolean, default: true },
  shakeThreshold: { type: Number, default: 1.1, min: 0.5, max: 5.0 },
  units: { type: String, enum: ['metric', 'imperial'], default: 'metric' },
  nodeActive: { type: Boolean, default: true },
}, { _id: false });

const GatewayStatusSchema = new Schema<IGatewayStatus>({
  online: { type: Boolean, default: false },
  lastHeartbeatAt: { type: Date, default: null },
  rssi: { type: Number, default: 0 },
  snr: { type: Number, default: 0 },
  firmwareVersion: { type: String, default: '' },
}, { _id: false });

const GatewaySchema = new Schema<IGateway>({
  gatewayId: {
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
    default: 'My Gateway',
    trim: true,
  },
  ownerId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  pairedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  mqttTopic: { type: String, default: '' },
  config: { type: GatewayConfigSchema, default: () => ({}) },
  status: { type: GatewayStatusSchema, default: () => ({}) },
}, { timestamps: true });

GatewaySchema.index({ ownerId: 1 });

export default mongoose.model<IGateway>('Gateway', GatewaySchema);
