import dotenv from 'dotenv';
dotenv.config();

interface Config {
  env: string;
  port: number;
  apiBaseUrl: string;
  jwt: {
    secret: string;   // must match the secret used by the external auth API
  };
  mongodb: {
    uri: string;
    connectTimeoutMs: number;
    serverSelectionTimeoutMs: number;
  };
  mqtt: {
    brokerUrl: string;
    port: number;
    username?: string;
    password?: string;
    clientId: string;
    publishTopic: string;
    qos: 0 | 1 | 2;
  };
  gateway: {
    apiKey: string;
  };
  
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  cors: {
    origins: string[];
  };
  log: {
    level: string;
  };
}

const config: Config = {
  env:        process.env.NODE_ENV  || 'development',
  port:       parseInt(process.env.PORT || '3000', 10),
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',

  jwt: {
    // Must match the secret used in the external auth API.
    // In production set JWT_SECRET in Vercel env vars to the same value.
    secret: process.env.JWT_SECRET || '',  // set JWT_SECRET in Vercel — must match the auth API's JWT_SECRET
  },

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/water-quality-monitor',
    connectTimeoutMs: parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS || '30000', 10),
    serverSelectionTimeoutMs: parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || '30000', 10),
  },

  mqtt: {
    brokerUrl:    process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com',
    port:         parseInt(process.env.MQTT_PORT || '1883', 10),
    username:     process.env.MQTT_USERNAME,
    password:     process.env.MQTT_PASSWORD,
    clientId:     process.env.MQTT_CLIENT_ID || 'water-quality-api',
    publishTopic: process.env.MQTT_PUBLISH_TOPIC || 'water-quality/live-data',
    qos:          (parseInt(process.env.MQTT_QOS || '1', 10) as 0 | 1 | 2),
  },

  gateway: {
    apiKey: process.env.GATEWAY_API_KEY || 'dev-gateway-key-change-in-production',
  },

  

  rateLimit: {
    windowMs:    parseInt(process.env.RATE_LIMIT_WINDOW_MS      || '100', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS   || '1000',    10),
  },

  cors: {
    origins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(','),
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// Production guards
if (config.env === 'production') {
  const required = ['JWT_SECRET', 'MONGODB_URI', 'GATEWAY_API_KEY'];
  const missing  = required.filter(v => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!config.jwt.secret) {
    throw new Error('JWT_SECRET must be set in Vercel env vars — must match the external auth API JWT_SECRET');
  }
}

export default config;
