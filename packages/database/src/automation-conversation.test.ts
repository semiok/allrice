import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AutomationConversationSnapshotSchema,
  automationConversationTargetId,
} from './automation-conversation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

describe('immutable ordinary automation conversation identity', () => {
  const scope = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
    },
    automationId = randomUUID(),
    source = randomUUID(),
    assignment = randomUUID(),
    instance = randomUUID();
  const trigger = {
    kind: 'scheduled' as const,
    nativeKind: 'recurring' as const,
    scheduledFor: '2026-10-31T06:30:17.000Z',
    occurrenceId: randomUUID(),
  };
  const target = automationConversationTargetId(scope, automationId, trigger);
  const body = {
    version: 1,
    automationId,
    businessRevision: 3,
    mode: 'new_each_run',
    sourceSessionId: source,
    targetSessionId: target,
    employeeAssignmentId: assignment,
    employeeInstanceId: instance,
    trigger,
  };
  const snapshot = { ...body, digest: runtimePolicyDigest(body) };
  it('keys monthly targets by paid business P, independent of arm/receipt or business revision', () => {
    expect(
      automationConversationTargetId(scope, automationId, {
        ...trigger,
        occurrenceId: randomUUID(),
      }),
    ).toBe(target);
    expect(
      automationConversationTargetId(scope, automationId, {
        ...trigger,
        scheduledFor: '2026-11-30T07:30:17.000Z',
      }),
    ).not.toBe(target);
    expect(
      automationConversationTargetId(
        { ...scope, ownerId: randomUUID() },
        automationId,
        trigger,
      ),
    ).not.toBe(target);
    expect(
      automationConversationTargetId(scope, automationId, {
        kind: 'manual',
        requestId: trigger.occurrenceId,
      }),
    ).not.toBe(target);
  });
  it('retains the complete frozen mode, revision, source, target and exact scheduled identity', () => {
    expect(AutomationConversationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
    const legacyBody = { ...body, mode: 'reuse', targetSessionId: source };
    expect(
      AutomationConversationSnapshotSchema.parse({
        ...legacyBody,
        digest: runtimePolicyDigest(legacyBody),
      }),
    ).toMatchObject({ mode: 'reuse', targetSessionId: source });
  });
  it.each([
    { ...snapshot, targetSessionId: randomUUID() },
    { ...snapshot, mode: 'reuse' },
    { ...snapshot, businessRevision: 4 },
    { ...snapshot, trigger: { kind: 'manual', requestId: randomUUID() } },
    { ...snapshot, arbitraryTarget: randomUUID() },
    { ...snapshot, digest: null },
    null,
  ])('rejects altered, extended or missing frozen documents', (value) => {
    expect(AutomationConversationSnapshotSchema.safeParse(value).success).toBe(
      false,
    );
  });
});
