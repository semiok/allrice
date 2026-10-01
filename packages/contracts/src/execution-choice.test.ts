import { describe, expect, it } from 'vitest';
import {
  resolveExecutionChoice,
  BridgeCapabilityReadinessListSchema,
} from './execution-choice.ts';
import {
  BridgeCapabilities,
  PairBridgeDeviceInputSchema,
  HeartbeatBridgeDeviceInputSchema,
} from './bridge.ts';

describe('local-first execution choice', () => {
  it.each(['busy', 'preparing'] as const)(
    'waits on local %s even when cloud is ready',
    (local) => {
      expect(resolveExecutionChoice({ local, cloudAvailable: true })).toEqual({
        location: 'local',
        status: 'wait',
        reason: `local_${local}`,
      });
    },
  );
  it('prefers local readiness and uses cloud only for unavailable local conditions', () => {
    expect(
      resolveExecutionChoice({ local: 'ready', cloudAvailable: true }).location,
    ).toBe('local');
    for (const local of ['unsupported', 'paused', 'offline', null] as const)
      expect(
        resolveExecutionChoice({ local, cloudAvailable: true }),
      ).toMatchObject({ location: 'cloud', status: 'execute' });
  });
  it('respects explicit location, local inputs and an already bound end', () => {
    expect(
      resolveExecutionChoice({
        location: 'cloud',
        local: 'ready',
        cloudAvailable: true,
      }).reason,
    ).toBe('explicit_cloud');
    expect(
      resolveExecutionChoice({
        location: 'local',
        local: 'offline',
        cloudAvailable: true,
      }),
    ).toMatchObject({ location: 'local', status: 'unavailable' });
    expect(
      resolveExecutionChoice({
        location: 'cloud',
        local: 'ready',
        cloudAvailable: true,
        localInputs: true,
      }),
    ).toMatchObject({
      location: 'none',
      status: 'unavailable',
      reason: 'local_inputs_required',
    });
    expect(
      resolveExecutionChoice({
        local: 'offline',
        cloudAvailable: true,
        localInputs: true,
      }).location,
    ).toBe('local');
    expect(
      resolveExecutionChoice({
        boundLocation: 'local',
        local: 'offline',
        cloudAvailable: true,
      }).location,
    ).toBe('local');
    expect(
      resolveExecutionChoice({
        boundLocation: 'cloud',
        local: 'ready',
        cloudAvailable: true,
      }).location,
    ).toBe('cloud');
  });
  it('requires reconciliation for unknown outcomes rather than starting another end', () => {
    expect(
      resolveExecutionChoice({
        boundLocation: 'local',
        local: 'ready',
        cloudAvailable: true,
        outcomeUnknown: true,
      }),
    ).toEqual({
      location: 'local',
      status: 'reconcile',
      reason: 'outcome_unknown',
    });
  });
});

describe('Bridge readiness wire compatibility', () => {
  const report = {
    capability: 'local.office',
    state: 'unsupported',
    reason: 'office_not_implemented',
    missing: ['office_local_adapter'],
    versions: { bridge: '0.6.0-dev.9' },
    observedAt: '2026-10-01T00:00:00.000Z',
  };
  it.each([1, 2])(
    'keeps protocol v%s pairing and heartbeat on the legacy capabilities',
    (protocolVersion) => {
      expect(
        PairBridgeDeviceInputSchema.parse({
          protocolVersion,
          code: 'ABCD-EF12',
          name: 'Legacy Mac',
          platform: 'macos-x64',
          capabilities: BridgeCapabilities,
        }).protocolVersion,
      ).toBe(protocolVersion);
      expect(
        HeartbeatBridgeDeviceInputSchema.parse({
          protocolVersion,
          capabilities: BridgeCapabilities,
        }).environment,
      ).toBeUndefined();
      expect(
        HeartbeatBridgeDeviceInputSchema.parse({
          protocolVersion,
          capabilities: BridgeCapabilities,
          environment: {
            version: 1,
            clientVersion: '0.6.0-dev.9',
            browser: 'ready',
            sandbox: 'unavailable',
            preview: 'paused',
            paused: false,
            readiness: [report],
          },
        }).environment?.readiness,
      ).toEqual([report]);
    },
  );
  it('preserves old capability enum/count limits and bounds independent reports', () => {
    expect(() =>
      HeartbeatBridgeDeviceInputSchema.parse({
        protocolVersion: 2,
        capabilities: [...BridgeCapabilities, 'local.office'],
      }),
    ).toThrow();
    expect(() =>
      HeartbeatBridgeDeviceInputSchema.parse({
        protocolVersion: 2,
        capabilities: Array(17).fill('local.fs.read'),
      }),
    ).toThrow();
    expect(() =>
      BridgeCapabilityReadinessListSchema.parse([report, report]),
    ).toThrow();
    expect(() =>
      BridgeCapabilityReadinessListSchema.parse([
        { ...report, state: 'installed' },
      ]),
    ).toThrow();
  });
});
