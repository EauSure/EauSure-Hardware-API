import mongoose, { Document, Schema } from 'mongoose';

export interface IIotNodeStatus {
  active: boolean;
  lastSeenAt: Date | null;
  firmwareVersion: string;
  lastRssi: number;
  lastSnr: number;
}

export interface IIotNode extends Document {
  nodeId: string;               // hardware DEVICE_ID (e.g. 0x7CB597E9)
  deviceSecret: string;         // burned at flash, used to verify QR HMAC
  name: string;                 // user-friendly label
  gatewayId: mongoose.Types.ObjectId | null;   // ref Gateway._id
  gatewayHardwareId: string | null;            // the actual hardware gatewayId string
  encryptionKey: string | null; // AES-128 key (hex), API-generated on pairing — select:false
  pairedAt: Date | null;
  status: IIotNodeStatus;
  // Pairing token
  pairingToken: string | null;
  pairingTokenExpiresAt: Date | null;
}

const IotNodeStatusSchema = new Schema<IIotNodeStatus>({
  active:          { type: Boolean, default: false },
  lastSeenAt:      { type: Date, default: null },
  firmwareVersion: { type: String, default: '' },
  lastRssi:        { type: Number, default: 0 },
  lastSnr:         { type: Number, default: 0 },
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
    select: false,   // NEVER sent to clients
  },
  pairedAt:    { type: Date, default: null },
  status:      { type: IotNodeStatusSchema, default: () => ({}) },
  pairingToken:          { type: String, default: null, select: false },
  pairingTokenExpiresAt: { type: Date,   default: null },
}, { timestamps: true });

IotNodeSchema.index({ gatewayId: 1 });

export default mongoose.model<IIotNode>('IotNode', IotNodeSchema);
