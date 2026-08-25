import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ChatFlowRealtimeRolloutPolicySchema,
  ChatFlowWakeupSchema,
  resolveChatFlowRealtimeRollout,
} from './chatflow.ts';

describe('ChatFlow contracts', () => {
  it('supports an emergency rollback without changing durable events', () => {
    const policy = ChatFlowRealtimeRolloutPolicySchema.parse({
      schemaVersion: 1,
      emergencyOff: true,
      defaultEnabled: true,
    });
    expect(resolveChatFlowRealtimeRollout(policy, {})).toBe(false);
  });

  it('supports tenant, employee and harness canaries', () => {
    const organizationId = randomUUID();
    const employeeVersionId = randomUUID();
    const policy = ChatFlowRealtimeRolloutPolicySchema.parse({
      schemaVersion: 1,
      organizationIds: [organizationId],
      employeeVersionIds: [employeeVersionId],
      harnesses: ['dsh'],
    });
    expect(
      resolveChatFlowRealtimeRollout(policy, {
        organizationId,
        employeeVersionId,
        harness: 'dsh',
      }),
    ).toBe(true);
    expect(
      resolveChatFlowRealtimeRollout(policy, {
        organizationId,
        employeeVersionId,
        harness: 'codex',
      }),
    ).toBe(false);
  });

  it('keeps wakeups intentionally smaller than durable event payloads', () => {
    expect(
      ChatFlowWakeupSchema.parse({ runId: randomUUID(), sequence: 7 }),
    ).toMatchObject({ sequence: 7 });
  });
});
