import mqttService from './mqttService';
import Command, { CommandType } from '../models/Command';
import { IGateway } from '../models/Gateway';

export async function sendCommand(
  gateway: IGateway,
  type: CommandType,
  payload: Record<string, any>,
  nodeId: string | null = null,
): Promise<{ ok: boolean; commandId: string }> {
  const command = new Command({
    gatewayId: gateway._id,
    gatewayHardwareId: gateway.gatewayId,
    nodeId,
    type,
    payload,
    status: 'pending',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  await command.save();

  const mqttPayload = {
    cmdId: command._id.toString(),
    cmd: type,
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

export async function ackCommand(commandId: string): Promise<void> {
  await Command.findByIdAndUpdate(commandId, {
    status: 'acked',
    ackedAt: new Date(),
  });
}

export function buildConfirmPairingPayload(input: {
  nodeId: string;
  nodeName: string;
  bleMac: string;
  sessionId: string;
  apPassword: string;
}): Record<string, any> {
  return {
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    bleMac: input.bleMac,
    sessionId: input.sessionId,
    apPassword: input.apPassword,
  };
}

export function buildPairingKeyReadyPayload(input: {
  nodeId: string;
  aesKey: string;
}): Record<string, any> {
  return {
    nodeId: input.nodeId,
    aesKey: input.aesKey,
  };
}

export function buildSetConfigPayload(
  config: Record<string, any>,
  nodeId?: string,
): Record<string, any> {
  // Only shake config is forwarded to the node via LoRa.
  // measureInterval and nodeActive are gateway-side only.
  const nodeConfig: Record<string, any> = {};
  if (config.shakeThreshold !== undefined) nodeConfig.shakeThreshold = config.shakeThreshold;
  if (config.shakeEnabled   !== undefined) nodeConfig.shakeEnabled   = config.shakeEnabled;

  return {
    ...(nodeId ? { nodeId } : {}),
    config: nodeConfig,
  };
}
