import mqttService from './mqttService';
import Command, { CommandType } from '../models/Command';
import { IGateway } from '../models/Gateway';
import mongoose from 'mongoose';

/**
 * CommandService
 *
 * Responsible for:
 *  1. Building a typed command payload
 *  2. Publishing it to the gateway's MQTT topic (real-time push)
 *  3. Persisting it in the Command collection (audit log + ack tracking)
 *
 * The gateway firmware subscribes to:
 *   commands/gateway/{gatewayHardwareId}
 *
 * Message format published:
 * {
 *   "cmdId": "<mongoId>",
 *   "cmd":   "<CommandType>",
 *   "nodeId": "<nodeId | null>",
 *   ...payload fields...
 * }
 */

export async function sendCommand(
  gateway: IGateway,
  type: CommandType,
  payload: Record<string, any>,
  nodeId: string | null = null
): Promise<{ ok: boolean; commandId: string }> {
  // Persist command first so we have an ID
  const command = new Command({
    gatewayId:         gateway._id,
    gatewayHardwareId: gateway.gatewayId,
    nodeId,
    type,
    payload,
    status:    'pending',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  await command.save();

  const mqttPayload = {
    cmdId:  command._id.toString(),
    cmd:    type,
    nodeId: nodeId ?? undefined,
    ...payload,
  };

  const topic = `commands/gateway/${gateway.gatewayId}`;
  const published = await mqttService.publishEvent(topic, mqttPayload);

  if (published) {
    command.status = 'sent';
    command.sentAt = new Date();
    await command.save();
  } else {
    command.status = 'failed';
    await command.save();
  }

  return { ok: published, commandId: command._id.toString() };
}

/**
 * Mark a command as acked (called when gateway reports back).
 */
export async function ackCommand(commandId: string): Promise<void> {
  await Command.findByIdAndUpdate(commandId, {
    status:  'acked',
    ackedAt: new Date(),
  });
}

/**
 * Build PAIR_NODE payload — sent to gateway so it can ACTIVATE the IoT node
 * with the new encryption key.
 */
export function buildPairNodePayload(
  nodeId: string,
  encryptionKey: string,
  config: Record<string, any>
): Record<string, any> {
  return {
    nodeId,
    encKey: encryptionKey,   // hex AES-128 key
    config,
  };
}

/**
 * Build SET_CONFIG payload — sent when user updates any parameter.
 */
export function buildSetConfigPayload(
  config: Record<string, any>,
  nodeId?: string
): Record<string, any> {
  return {
    ...(nodeId ? { nodeId } : {}),
    config,
  };
}
