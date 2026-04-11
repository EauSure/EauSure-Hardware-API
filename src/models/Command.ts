import mongoose, { Document, Schema } from 'mongoose';

export type CommandType =
  | 'PAIR_NODE'
  | 'UNPAIR_NODE'
  | 'SET_CONFIG'
  | 'MEASURE_NOW'
  | 'ACTIVATE_NODE'
  | 'DEACTIVATE_NODE'
  | 'HEALTH_CHECK';

export type CommandStatus = 'pending' | 'sent' | 'acked' | 'failed' | 'expired';

export interface ICommand extends Document {
  gatewayId: mongoose.Types.ObjectId;
  gatewayHardwareId: string;
  nodeId: string | null;        // null for gateway-level commands
  type: CommandType;
  payload: Record<string, any>;
  status: CommandStatus;
  sentAt: Date | null;
  ackedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

const CommandSchema = new Schema<ICommand>({
  gatewayId: {
    type: Schema.Types.ObjectId,
    ref: 'Gateway',
    required: true,
    index: true,
  },
  gatewayHardwareId: {
    type: String,
    required: true,
  },
  nodeId: {
    type: String,
    default: null,
  },
  type: {
    type: String,
    enum: ['PAIR_NODE', 'UNPAIR_NODE', 'SET_CONFIG', 'MEASURE_NOW',
           'ACTIVATE_NODE', 'DEACTIVATE_NODE', 'HEALTH_CHECK'],
    required: true,
  },
  payload: {
    type: Schema.Types.Mixed,
    default: {},
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'acked', 'failed', 'expired'],
    default: 'pending',
    index: true,
  },
  sentAt:   { type: Date, default: null },
  ackedAt:  { type: Date, default: null },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 5 * 60 * 1000), // 5 min TTL
    index: { expires: 0 },   // MongoDB TTL index — auto-delete expired docs
  },
}, {
  timestamps: true,
});

CommandSchema.index({ gatewayId: 1, status: 1 });
CommandSchema.index({ gatewayHardwareId: 1, status: 1 });

export default mongoose.model<ICommand>('Command', CommandSchema);
