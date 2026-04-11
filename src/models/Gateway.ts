import mongoose, { Document, Schema } from 'mongoose';

export interface IGatewayConfig {
  measureInterval: number;      // seconds between auto-measures
  shakeEnabled: boolean;
  shakeThreshold: number;       // G force threshold
  units: 'metric' | 'imperial';
  nodeActive: boolean;          // ACTIVATE / DEACTIVATE the IoT node
}

export interface IGatewayStatus {
  online: boolean;
  lastHeartbeatAt: Date | null;
  rssi: number;
  snr: number;
  firmwareVersion: string;
}

export interface IGateway extends Document {
  gatewayId: string;            // hardware-burned unique ID (e.g. MAC-derived)
  deviceSecret: string;         // burned at flash, used to verify QR HMAC — never sent to client
  name: string;                 // user-friendly label
  ownerId: mongoose.Types.ObjectId | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  mqttTopic: string;            // commands/gateway/{gatewayId}
  config: IGatewayConfig;
  status: IGatewayStatus;
  // Pairing token (short-lived, generated on demand when user wants to pair)
  pairingToken: string | null;
  pairingTokenExpiresAt: Date | null;
}

const GatewayConfigSchema = new Schema<IGatewayConfig>({
  measureInterval: { type: Number, default: 60, min: 10, max: 3600 },
  shakeEnabled:    { type: Boolean, default: true },
  shakeThreshold:  { type: Number, default: 1.1, min: 0.5, max: 5.0 },
  units:           { type: String, enum: ['metric', 'imperial'], default: 'metric' },
  nodeActive:      { type: Boolean, default: true },
}, { _id: false });

const GatewayStatusSchema = new Schema<IGatewayStatus>({
  online:          { type: Boolean, default: false },
  lastHeartbeatAt: { type: Date, default: null },
  rssi:            { type: Number, default: 0 },
  snr:             { type: Number, default: 0 },
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
    select: false,   // never returned in queries unless explicitly requested
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
  pairedAt:    { type: Date, default: null },
  lastSeenAt:  { type: Date, default: null },
  mqttTopic:   { type: String, default: '' },
  config:      { type: GatewayConfigSchema, default: () => ({}) },
  status:      { type: GatewayStatusSchema, default: () => ({}) },
  pairingToken:          { type: String, default: null, select: false },
  pairingTokenExpiresAt: { type: Date,   default: null },
}, { timestamps: true });

GatewaySchema.index({ ownerId: 1 });

export default mongoose.model<IGateway>('Gateway', GatewaySchema);
