import { describe, expect, it } from 'vitest';
import {
  BridgeTerminalServerFrameSchema,
  TerminalStreamModeSchema,
  TerminalTargetSchema,
  WorkbenchTerminalBrowserFrameSchema,
  WorkbenchTerminalServerFrameSchema,
  workbenchTerminalProtocol,
  workbenchTerminalStreamProtocol,
} from './index.js';

const id = '11111111-1111-4111-8111-111111111111';
const target = {
  organizationId: id,
  workspaceId: id,
  ownerId: id,
  loginSessionId: id,
  sessionId: id,
  deviceId: id,
  grantId: id,
  grantVersion: 1,
  rootFingerprint: 'a'.repeat(64),
  label: 'Authorized folder',
};

describe('human terminal stream compatibility', () => {
  it('keeps the legacy subprotocol and advertises a distinct modern protocol', () => {
    expect(workbenchTerminalProtocol).toBe('allrice.terminal.v1');
    expect(workbenchTerminalStreamProtocol).toBe('allrice.terminal.v2');
  });

  it('preserves absent-mode legacy ready/open envelopes without inserting a mode', () => {
    const ready = {
      version: 1,
      type: 'terminal.ready',
      target,
      deviceName: 'Synthetic Bridge',
    };
    const open = { version: 1, type: 'terminal.open', id, target };
    expect(WorkbenchTerminalServerFrameSchema.parse(ready)).toEqual(ready);
    expect(BridgeTerminalServerFrameSchema.parse(open)).toEqual(open);
  });

  it.each(['pull', 'push'] as const)(
    'carries explicit %s negotiation separately from immutable terminal authority',
    (streamMode) => {
      const ready = {
        version: 1,
        type: 'terminal.ready',
        target,
        deviceName: 'Synthetic Bridge',
        streamMode,
      };
      const open = {
        version: 1,
        type: 'terminal.open',
        id,
        target,
        streamMode,
      };
      expect(WorkbenchTerminalServerFrameSchema.parse(ready)).toEqual(ready);
      expect(BridgeTerminalServerFrameSchema.parse(open)).toEqual(open);
      expect(
        TerminalTargetSchema.safeParse({ ...target, streamMode }).success,
      ).toBe(false);
    },
  );

  it('rejects invented modes and keeps the frame envelope at version 1', () => {
    for (const streamMode of ['auto', 2, null]) {
      expect(TerminalStreamModeSchema.safeParse(streamMode).success).toBe(
        false,
      );
      expect(
        BridgeTerminalServerFrameSchema.safeParse({
          version: 1,
          type: 'terminal.open',
          id,
          target,
          streamMode,
        }).success,
      ).toBe(false);
    }
    expect(
      WorkbenchTerminalServerFrameSchema.safeParse({
        version: 2,
        type: 'terminal.ready',
        target,
        deviceName: 'Synthetic Bridge',
        streamMode: 'push',
      }).success,
    ).toBe(false);
  });

  it('still accepts the legacy one-credit next envelope in both directions', () => {
    const next = { version: 1, type: 'terminal.next', requestId: id };
    expect(WorkbenchTerminalBrowserFrameSchema.parse(next)).toEqual(next);
    expect(BridgeTerminalServerFrameSchema.parse({ ...next, id })).toEqual({
      ...next,
      id,
    });
  });
});
