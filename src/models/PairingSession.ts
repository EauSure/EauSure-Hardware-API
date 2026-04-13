import mongoose, { Document, Schema } from 'mongoose';

export type PairingSessionStatus =
  | 'confirmed'
  | 'consumed'
  | 'completed'
  | 'failed'
  | 'expired';

export interface IPairingSession extends Document {
  userId: mongoose.Types.ObjectId;
  gatewayId: mongoose.Types.ObjectId;
  gatewayHardwareId: string;
  nodeId: string;
  nodeName: string;
  bleMac: string;
  tokenId: string;
  status: PairingSessionStatus;
  consumedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PairingSessionSchema = new Schema<IPairingSession>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  gatewayId: {
    type: Schema.Types.ObjectId,
    ref: 'Gateway',
    required: true,
    index: true,
  },
  gatewayHardwareId: {
    type: String,
    required: true,
    index: true,
  },
  nodeId: {
    type: String,
    required: true,
    index: true,
  },
  nodeName: {
    type: String,
    default: 'iot-node',
    trim: true,
  },
  bleMac: {
    type: String,
    default: '',
    trim: true,
  },
  tokenId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['confirmed', 'consumed', 'completed', 'failed', 'expired'],
    default: 'confirmed',
    index: true,
  },
  consumedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 },
  },
}, { timestamps: true });

PairingSessionSchema.index({ gatewayHardwareId: 1, nodeId: 1, status: 1 });

export default mongoose.model<IPairingSession>('PairingSession', PairingSessionSchema);
