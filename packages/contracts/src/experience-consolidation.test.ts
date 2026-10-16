import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ExperienceCollectionPolicySchema,
  experiencePolicySchedule,
  validateExperienceDraftOutput,
} from './experience.ts';
import {
  InternalKernelRequestSchema,
  EmployeeKernelRequestSchema,
  HarnessEventSchema,
  harnessContextKey,
} from './harness.ts';
import { nextScheduleAt } from '../../database/src/execution/automation.ts';

describe('bounded private experience methods', () => {
  it('keeps the initial watermark and provides a weekly default for existing policy', () => {
    const policy = ExperienceCollectionPolicySchema.parse({
      schemaVersion: 1,
      revision: 2,
      frequency: 'weekly',
      collectionStartedAt: '2026-10-16T00:00:00.000Z',
      authorizationSource: 'platform_automatic_experience_policy',
    });
    expect(experiencePolicySchedule(policy)).toEqual({
      frequency: 'weekly',
      timezone: 'Asia/Shanghai',
      time: '03:00',
      weekday: 1,
      monthDay: 1,
    });
    expect(policy.collectionStartedAt).toBe('2026-10-16T00:00:00.000Z');
  });
  it('accepts an all-discarded result, but refuses fabricated, duplicated or omitted sources', () => {
    const id = randomUUID(),
      other = randomUUID(),
      valid = {
        schemaVersion: 1,
        drafts: [],
        discarded: [{ sourceIds: [id], reason: '一次性要求' }],
      };
    expect(validateExperienceDraftOutput(valid, [id])).toEqual(valid);
    expect(() => validateExperienceDraftOutput(valid, [other])).toThrow(
      'SOURCE_MISMATCH',
    );
    expect(() => validateExperienceDraftOutput(valid, [id, other])).toThrow(
      'SOURCE_MISMATCH',
    );
    expect(() =>
      validateExperienceDraftOutput(
        { ...valid, discarded: [...valid.discarded, ...valid.discarded] },
        [id],
      ),
    ).toThrow('SOURCE_MISMATCH');
  });
  it('uses an explicit internal identity, never a chat UUID alias', () => {
    const kernel = InternalKernelRequestSchema.parse({
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId: null,
      userMessageId: null,
      assistantMessageId: null,
      internalTask: {
        kind: 'experience_consolidation',
        occurrenceId: randomUUID(),
      },
      systemInstructions: 'bounded',
      userRequest: '{}',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke'],
      skillVersionIds: [],
    });
    expect(harnessContextKey(kernel)).toBe(
      `experience-${kernel.internalTask.occurrenceId}`,
    );
    expect(EmployeeKernelRequestSchema.safeParse(kernel).success).toBe(false);
    const event = {
      schemaVersion: 1,
      harness: 'dsh',
      generation: 0,
      attempt: 1,
      order: 1,
      threadId: null,
      turnId: null,
      sessionId: null,
      messageId: null,
      internalTask: kernel.internalTask,
      type: 'assistant.completed',
      text: '{}',
    };
    expect(HarnessEventSchema.safeParse(event).success).toBe(true);
    expect(
      HarnessEventSchema.safeParse({ ...event, sessionId: randomUUID() })
        .success,
    ).toBe(false);
    expect(
      HarnessEventSchema.safeParse({ ...event, internalTask: undefined })
        .success,
    ).toBe(false);
  });
  it('clamps month-end and skips missed periods', () => {
    const schedule = {
      frequency: 'monthly',
      time: '03:00',
      timezone: 'Asia/Shanghai',
      monthDay: 31,
    };
    expect(
      nextScheduleAt(schedule, new Date('2027-02-01T00:00:00Z')).toISOString(),
    ).toBe('2027-02-27T19:00:00.000Z');
    expect(
      nextScheduleAt(schedule, new Date('2027-02-28T00:00:00Z')).toISOString(),
    ).toBe('2027-03-30T19:00:00.000Z');
    expect(() =>
      nextScheduleAt({ ...schedule, timezone: 'Mars/Invalid' }),
    ).toThrow();
  });
  it('handles seasonal offsets and the daylight-saving gap without spinning', () => {
    expect(
      nextScheduleAt(
        { frequency: 'daily', time: '03:00', timezone: 'America/New_York' },
        new Date('2026-03-08T05:00:00Z'),
      ).toISOString(),
    ).toBe('2026-03-08T07:00:00.000Z');
    expect(
      nextScheduleAt(
        { frequency: 'daily', time: '02:30', timezone: 'America/New_York' },
        new Date('2026-03-08T05:00:00Z'),
      ).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });
});
