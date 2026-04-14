import mongoose, { Document, Schema } from 'mongoose';

export interface IIotNodeStatus {
  active: boolean;
  lastSeenAt: Date | null;
  firmwareVersion: string;
  lastRssi: number;
  lastSnr: number;
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
}

const IotNodeStatusSchema = new Schema<IIotNodeStatus>({
  active: { type: Boolean, default: false },
  lastSeenAt: { type: Date, default: null },
  firmwareVersion: { type: String, default: '' },
  lastRssi: { type: Number, default: 0 },
  lastSnr: { type: Number, default: 0 },
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
}, { timestamps: true });

IotNodeSchema.index({ gatewayId: 1 });

export default mongoose.model<IIotNode>('IotNode', IotNodeSchema);
