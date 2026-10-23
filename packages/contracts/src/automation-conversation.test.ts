import { describe, expect, it } from 'vitest';
import { CreateOnceTaskInputSchema } from './native-schedule.ts';
import {
  CreateRecurringTaskInputSchema,
  ChangeRecurringTaskInputSchema,
} from './recurring-schedule.ts';

describe('conversation input compatibility and business-only edit', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const recurring = {
    clientRequestId: id,
    name: '原任务',
    prompt: '保留全部工作。',
    rule: { kind: 'every', seconds: 60 },
  };
  const once = {
    clientRequestId: id,
    name: '单次任务',
    prompt: '只回复一次。',
    runAt: '2026-12-31T00:00:00.000Z',
    timezone: 'UTC',
  };
  it('never adds a mode key/default to old create or update JSON', () => {
    for (const [schema, input] of [
      [CreateRecurringTaskInputSchema, recurring],
      [CreateOnceTaskInputSchema, once],
    ] as const) {
      expect(schema.parse(input)).toEqual(input);
      expect(Object.hasOwn(schema.parse(input), 'conversationMode')).toBe(
        false,
      );
      expect(schema.parse({ ...input, conversationMode: 'reuse' })).toEqual({
        ...input,
        conversationMode: 'reuse',
      });
    }
    const update = {
      operationId: id,
      expectedRevision: 1,
      action: 'update',
      name: recurring.name,
      prompt: recurring.prompt,
      rule: recurring.rule,
    };
    expect(ChangeRecurringTaskInputSchema.parse(update)).toEqual(update);
  });
  it('permits only an exact mode/CAS operation, with no caller target or clock fields', () => {
    const input = {
      operationId: id,
      expectedRevision: 3,
      action: 'conversation',
      conversationMode: 'new_each_run',
    };
    expect(ChangeRecurringTaskInputSchema.parse(input)).toEqual(input);
    for (const patch of [
      { conversationMode: null },
      { conversationMode: 'arbitrary' },
      { sessionId: id },
      { targetSessionId: id },
      { rule: recurring.rule },
      { prompt: '改内容' },
    ])
      expect(
        ChangeRecurringTaskInputSchema.safeParse({ ...input, ...patch })
          .success,
      ).toBe(false);
    expect(
      ChangeRecurringTaskInputSchema.safeParse({
        operationId: id,
        expectedRevision: 1,
        action: 'conversation',
      }).success,
    ).toBe(false);
  });
});
