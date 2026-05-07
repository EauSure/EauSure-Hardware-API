import mongoose from 'mongoose';
import config from '../config';

mongoose.set('bufferCommands', false);

let listenersBound = false;
let connectionPromise: Promise<void> | null = null;

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      await mongoose.connect(config.mongodb.uri, {
        connectTimeoutMS: config.mongodb.connectTimeoutMs,
        serverSelectionTimeoutMS: config.mongodb.serverSelectionTimeoutMs,
      });
      console.log('[MongoDB] Connected successfully');

      if (!listenersBound) {
        listenersBound = true;

        mongoose.connection.on('error', (error) => {
          console.error('[MongoDB] Connection error:', error);
        });

        mongoose.connection.on('disconnected', () => {
          console.log('[MongoDB] Disconnected');
        });

        process.on('SIGINT', async () => {
          await mongoose.connection.close();
          console.log('[MongoDB] Connection closed due to app termination');
          process.exit(0);
        });
      }
    } catch (error) {
      console.error('[MongoDB] Connection failed:', error);
      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

export async function ensureDatabaseReady(): Promise<boolean> {
  if (isDatabaseReady()) {
    return true;
  }

  try {
    await connectDatabase();
    return isDatabaseReady();
  } catch {
    return false;
  }
}
