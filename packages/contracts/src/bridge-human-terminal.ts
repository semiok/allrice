import { z } from 'zod';
import {
  BridgeDeviceSchema as Device,
  BridgeEnvironmentSchema as Environment,
  HeartbeatBridgeDeviceInputSchema as Heartbeat,
  PairBridgeDeviceResponseSchema as PairResponse,
} from './bridge.ts';

/** Human terminal capability belongs to the public Bridge transport. Keep the
 * Agent runtime's existing bridge.ts module unchanged so a Web/Bridge-only
 * extension does not create an unrelated native execution package identity. */
export const BridgeDeviceSchema = Device.extend({
  humanTerminalVersion: z.literal(1).optional(),
});
export type BridgeDevice = z.infer<typeof BridgeDeviceSchema>;

export const BridgeEnvironmentSchema = Environment.extend({
  humanTerminalVersion: z.literal(1).optional(),
});
export type BridgeEnvironment = z.infer<typeof BridgeEnvironmentSchema>;

export const HeartbeatBridgeDeviceInputSchema = Heartbeat.extend({
  environment: BridgeEnvironmentSchema.optional(),
});

export const PairBridgeDeviceResponseSchema = PairResponse.extend({
  device: BridgeDeviceSchema,
});
