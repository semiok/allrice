import { describe, expect, it } from 'vitest';
import { BridgeEnvironmentSchema as AgentEnvironmentSchema } from './bridge.js';
import {
  BridgeDeviceSchema,
  BridgeEnvironmentSchema,
  HeartbeatBridgeDeviceInputSchema,
  PairBridgeDeviceResponseSchema,
} from './index.js';

const id = '11111111-1111-4111-8111-111111111111';
const environment = {
  version: 1,
  clientVersion: '0.6.0-dev.58',
  browser: 'unavailable',
  sandbox: 'unavailable',
  preview: 'unavailable',
  paused: false,
};
const device = {
  id,
  organizationId: id,
  workspaceId: id,
  ownerId: id,
  name: 'Synthetic Bridge',
  platform: 'macos-arm64',
  protocolVersion: 2,
  capabilities: ['local.fs.list'],
  status: 'online',
  lastSeenAt: null,
  createdAt: '2026-10-22T12:00:00.000Z',
  revokedAt: null,
};

describe('public Bridge human terminal capability versions', () => {
  it('preserves old reports without introducing a terminal capability', () => {
    expect(BridgeEnvironmentSchema.parse(environment)).toEqual(environment);
    expect(BridgeDeviceSchema.parse(device)).toEqual(device);
  });

  it.each([1, 2] as const)(
    'carries capability version %i through heartbeat, device list and pairing',
    (humanTerminalVersion) => {
      const currentEnvironment = { ...environment, humanTerminalVersion };
      const currentDevice = { ...device, humanTerminalVersion };
      expect(BridgeEnvironmentSchema.parse(currentEnvironment)).toEqual(
        currentEnvironment,
      );
      expect(
        HeartbeatBridgeDeviceInputSchema.parse({
          protocolVersion: 2,
          capabilities: ['local.fs.list'],
          environment: currentEnvironment,
        }).environment,
      ).toEqual(currentEnvironment);
      expect(BridgeDeviceSchema.parse(currentDevice)).toEqual(currentDevice);
      expect(
        PairBridgeDeviceResponseSchema.parse({
          device: currentDevice,
          deviceToken: 'synthetic-terminal-device-token-not-a-real-credential',
        }).device,
      ).toEqual(currentDevice);
    },
  );

  it('rejects unknown versions without changing the pinned Agent environment', () => {
    for (const humanTerminalVersion of [0, 3, '2', true]) {
      expect(
        BridgeEnvironmentSchema.safeParse({
          ...environment,
          humanTerminalVersion,
        }).success,
      ).toBe(false);
      expect(
        BridgeDeviceSchema.safeParse({ ...device, humanTerminalVersion })
          .success,
      ).toBe(false);
    }
    expect(AgentEnvironmentSchema.parse(environment)).toEqual(environment);
    expect(
      AgentEnvironmentSchema.safeParse({
        ...environment,
        humanTerminalVersion: 2,
      }).success,
    ).toBe(false);
  });
});
