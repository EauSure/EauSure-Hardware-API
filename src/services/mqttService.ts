import mqtt from 'mqtt';
import config from '../config';

class MQTTService {
  private client: mqtt.MqttClient | null = null;
  private isConnected: boolean = false;

  /**
   * Initialize MQTT client and connect to broker.
   * One-shot connect → publish → disconnect is safe for Vercel serverless.
   * For persistent gateway subscriptions, the gateway firmware connects directly.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: mqtt.IClientOptions = {
        clientId:         `${config.mqtt.clientId}-${Date.now()}`,
        clean:            true,
        connectTimeout:   5000,
        reconnectPeriod:  0,    // no auto-reconnect in serverless context
      };

      if (config.mqtt.username) {
        options.username = config.mqtt.username;
        options.password = config.mqtt.password;
      }

      this.client = mqtt.connect(config.mqtt.brokerUrl, options);

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log(`[MQTT] Connected to broker: ${config.mqtt.brokerUrl}`);
        resolve();
      });

      this.client.on('error', (error) => {
        console.error('[MQTT] Connection error:', error);
        this.isConnected = false;
        reject(error);
      });

      this.client.on('offline', () => {
        this.isConnected = false;
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });
    });
  }

  /**
   * Publish sensor data to the live-data topic.
   */
  async publishSensorData(data: any): Promise<boolean> {
    return this.publishEvent(config.mqtt.publishTopic, data);
  }

  /**
   * Publish any payload to any topic.
   * Handles connect-publish-disconnect cycle automatically for serverless.
   */
  async publishEvent(topic: string, data: any): Promise<boolean> {
    // If not connected, attempt a fresh connection
    if (!this.client || !this.isConnected) {
      try {
        await this.connect();
      } catch {
        console.warn('[MQTT] Could not connect — skipping publish');
        return false;
      }
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify(data);

      this.client!.publish(
        topic,
        payload,
        { qos: config.mqtt.qos, retain: false },
        (error) => {
          if (error) {
            console.error('[MQTT] Publish error:', error);
            resolve(false);
          } else {
            console.log(`[MQTT] Published → ${topic}`);
            resolve(true);
          }
        }
      );
    });
  }

  /**
   * Publish a typed command to a specific gateway topic.
   * commands/gateway/{gatewayHardwareId}
   */
  async publishGatewayCommand(gatewayHardwareId: string, payload: any): Promise<boolean> {
    const topic = `commands/gateway/${gatewayHardwareId}`;
    return this.publishEvent(topic, payload);
  }

  isClientConnected(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      return new Promise((resolve) => {
        this.client!.end(false, {}, () => {
          this.isConnected = false;
          resolve();
        });
      });
    }
  }
}

export default new MQTTService();
