import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import config from './config';
import { connectDatabase } from './services/database';
import mqttService from './services/mqttService';

// Routes
import sensorDataRoutes from './routes/sensorData';
import gatewayRoutes    from './routes/gateways';
import registryRoutes   from './routes/registry';

const app: Application = express();
app.set('trust proxy', 1);

// =====================================================
// Middleware
// =====================================================
app.use(helmet());

app.use(cors({
  origin:      config.cors.origins,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

if (config.env === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.maxRequests,
  message:  { success: false, message: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

// =====================================================
// Routes
// =====================================================
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    success:   true,
    message:   'API is healthy',
    timestamp: new Date().toISOString(),
    mqtt:      mqttService.isClientConnected(),
  });
});

app.use('/api/sensor-data', sensorDataRoutes);
app.use('/api/gateways',    gatewayRoutes);
app.use('/api/registry',    registryRoutes);   // gateway firmware endpoints

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(config.env === 'development' && { stack: err.stack }),
  });
});

// =====================================================
// Startup
// =====================================================
async function startServer() {
  try {
    await connectDatabase();

    try {
      await mqttService.connect();
    } catch {
      console.warn('[MQTT] Failed to connect — continuing without MQTT');
    }

    app.listen(config.port, () => {
      console.log('\n==============================================');
      console.log('🚀 Water Quality Monitor API');
      console.log('==============================================');
      console.log(`Environment : ${config.env}`);
      console.log(`Server      : ${config.apiBaseUrl}`);
      console.log(`Port        : ${config.port}`);
      console.log(`MongoDB     : ${config.mongodb.uri.includes('@') ? 'Atlas' : 'Local'}`);
      console.log(`MQTT        : ${mqttService.isClientConnected() ? 'Connected' : 'Disabled'}`);
      console.log('==============================================\n');
    });
  } catch (error) {
    console.error('[Startup] Failed:', error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason: any) => {
  console.error('[Unhandled Rejection]', reason);
  process.exit(1);
});

if (process.env.VERCEL !== '1') {
  startServer();
} else {
  connectDatabase().catch(console.error);
  mqttService.connect().catch(() => console.warn('[MQTT] Disabled in serverless'));
}

export default app;
