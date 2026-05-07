import mongoose from 'mongoose';
import config from '../config';

mongoose.set('bufferCommands', false);

let listenersBound = false;

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function connectDatabase(): Promise<void> {
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
  }
}
