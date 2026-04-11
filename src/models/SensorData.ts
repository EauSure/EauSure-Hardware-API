import mongoose, { Document, Schema } from 'mongoose';

export interface ISensorData extends Document {
  // Ownership triple-index
  userId: mongoose.Types.ObjectId;
  gatewayId: mongoose.Types.ObjectId;
  gatewayHardwareId: string;
  nodeId: string;               // IoT node hardware ID

  sequence: number;
  timestamp: Date;
  receivedAt: Date;

  battery: {
    percentage: number;
    voltage: number;
    current: number;
  };

  ph: {
    value: number;
    score: number;
  };

  tds: {
    value: number;
    score: number;
  };

  turbidity: {
    voltage: number;
    score: number;
  };

  temperature: {
    water: number;
    mpu: number;
    esp32: number;
  };

  event: {
    type: string;
    accelG?: number;
    dynAccelG?: number;
  };

  signal: {
    rssi: number;
    snr: number;
  };

  rawPayload?: any;
}

const SensorDataSchema = new Schema<ISensorData>({
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
  },
  nodeId: {
    type: String,
    required: true,
    index: true,
  },
  sequence: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
    index: true,
  },
  receivedAt: {
    type: Date,
    default: Date.now,
  },
  battery: {
    percentage: { type: Number, min: 0, max: 100 },
    voltage:    { type: Number, min: 0 },
    current:    { type: Number },
  },
  ph: {
    value: { type: Number, min: 0, max: 14 },
    score: { type: Number, min: 0, max: 10 },
  },
  tds: {
    value: { type: Number, min: 0 },
    score: { type: Number, min: 0, max: 10 },
  },
  turbidity: {
    voltage: { type: Number, min: 0 },
    score:   { type: Number, min: 0, max: 10 },
  },
  temperature: {
    water: Number,
    mpu:   Number,
    esp32: Number,
  },
  event: {
    type:       { type: String, default: 'None' },
    accelG:     Number,
    dynAccelG:  Number,
  },
  signal: {
    rssi: Number,
    snr:  Number,
  },
  rawPayload: Schema.Types.Mixed,
}, { timestamps: true });

// Compound indexes for efficient dashboard queries
SensorDataSchema.index({ userId: 1, timestamp: -1 });
SensorDataSchema.index({ gatewayId: 1, nodeId: 1, timestamp: -1 });
SensorDataSchema.index({ nodeId: 1, timestamp: -1 });
SensorDataSchema.index({ 'event.type': 1, timestamp: -1 });

export default mongoose.model<ISensorData>('SensorData', SensorDataSchema);
