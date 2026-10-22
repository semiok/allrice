import { z } from 'zod';
import {
  BridgeDeviceSchema as Device,
  BridgeEnvironmentSchema as Environment,
  HeartbeatBridgeDeviceInputSchema as Heartbeat,
  PairBridgeDeviceResponseSchema as PairResponse,
} from './bridge.ts';

const HumanTerminalVersionSchema = z.union([z.literal(1), z.literal(2)]);

/** Human terminal capability belongs to the public Bridge transport. Keep the
 * Agent runtime's existing bridge.ts module unchanged so a Web/Bridge-only
 * extension does not create an unrelated native execution package identity. */
export const BridgeDeviceSchema = Device.extend({
  humanTerminalVersion: HumanTerminalVersionSchema.optional(),
});
export type BridgeDevice = z.infer<typeof BridgeDeviceSchema>;

export const BridgeEnvironmentSchema = Environment.extend({
  humanTerminalVersion: HumanTerminalVersionSchema.optional(),
});
export type BridgeEnvironment = z.infer<typeof BridgeEnvironmentSchema>;

export const HeartbeatBridgeDeviceInputSchema = Heartbeat.extend({
  environment: BridgeEnvironmentSchema.optional(),
});

export const PairBridgeDeviceResponseSchema = PairResponse.extend({
  device: BridgeDeviceSchema,
});
