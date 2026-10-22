import { describe, expect, it } from 'vitest';
import {
  ChangeRecurringTaskInputSchema,
  CreateRecurringTaskInputSchema,
  RecurringOccurrenceSchema,
  RecurringScheduleRuleSchema,
  FixedRecurringScheduleRuleSchema,
  RecurringTaskDetailQuerySchema,
  RecurringTaskHistorySchema,
  RecurringTaskListQuerySchema,
  RecurringTaskListSchema,
  RecurringTaskOperationSchema,
  RecurringTaskSchema,
  type RecurringTask,
} from './recurring-schedule.ts';

const TASK = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OCCURRENCE = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const NOW = '2030-01-01T00:00:00.000Z';

function create() {
  return {
    clientRequestId: REQUEST,
    name: 'Daily report',
    prompt: 'Summarize this chat',
    rule: {
      kind: 'daily' as const,
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
    },
  };
}
function task(patch: Partial<RecurringTask> = {}): RecurringTask {
  const { name, prompt, rule } = create();
  return {
    id: TASK,
    clientRequestId: REQUEST,
    sessionId: SESSION,
    name,
    prompt,
    rule,
    revision: 1,
    status: 'enabled',
    nextRunAt: '2030-01-02T01:30:00.000Z',
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    canManage: true,
    latestOccurrence: null,
    ...patch,
  };
}
function occurrence() {
  return {
    id: OCCURRENCE,
    taskId: TASK,
    revision: 1,
    scheduledAt: NOW,
    status: 'queued' as const,
    runId: RUN,
    errorMessage: null,
  };
}

describe('recurring schedule rules have bounded, explicit semantics', () => {
  it('keeps monthly business rules out of fixed native rules', () => {
    const monthly = {
      kind: 'monthly',
      monthDay: 31,
      time: '02:30:45',
      timezone: 'America/New_York',
    };
    expect(RecurringScheduleRuleSchema.parse(monthly)).toEqual(monthly);
    expect(FixedRecurringScheduleRuleSchema.safeParse(monthly).success).toBe(
      false,
    );
    for (const monthDay of [0, 32, 1.5])
      expect(
        RecurringScheduleRuleSchema.safeParse({ ...monthly, monthDay }).success,
      ).toBe(false);
    for (const kind of ['daily', 'weekly', 'every']) {
      const fixed =
        kind === 'every'
          ? { kind, seconds: 60 }
          : {
              kind,
              time: '09:30:00',
              timezone: 'Asia/Shanghai',
              ...(kind === 'weekly' ? { weekdays: [1, 3] } : {}),
            };
      expect(FixedRecurringScheduleRuleSchema.parse(fixed)).toEqual(fixed);
    }
  });
  it.each([60, 61, 3_600, 31_536_000])(
    'accepts an elapsed interval of %s whole seconds',
    (seconds) => {
      expect(
        RecurringScheduleRuleSchema.parse({ kind: 'every', seconds }),
      ).toEqual({ kind: 'every', seconds });
    },
  );

  it.each([
    0,
    59,
    -60,
    60.5,
    31_536_001,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])('rejects an invalid elapsed interval %s', (seconds) => {
    expect(
      RecurringScheduleRuleSchema.safeParse({ kind: 'every', seconds }).success,
    ).toBe(false);
  });

  it.each([
    ['00:00:00', 'UTC'],
    ['23:59:59', 'Asia/Shanghai'],
    ['02:30:00', 'America/New_York'],
    ['01:30:00', 'Europe/London'],
  ])(
    'retains daily wall time %s and timezone %s without guessing DST execution instants',
    (time, timezone) => {
      expect(
        RecurringScheduleRuleSchema.parse({ kind: 'daily', time, timezone }),
      ).toEqual({ kind: 'daily', time, timezone });
    },
  );

  it.each(
    [[1], [7], [1, 3, 7], [1, 2, 3, 4, 5, 6, 7]].map((weekdays) => ({
      weekdays,
    })),
  )('preserves canonical weekly ISO weekdays $weekdays', ({ weekdays }) => {
    const rule = {
      kind: 'weekly',
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
      weekdays,
    };
    expect(RecurringScheduleRuleSchema.parse(rule)).toEqual(rule);
    expect(
      CreateRecurringTaskInputSchema.parse({ ...create(), rule }).rule,
    ).toEqual(rule);
  });

  it.each(
    [[], [0], [8], [1.5], [1, 1], [7, 1], [1, 2, 3, 4, 5, 6, 7, 7]].map(
      (weekdays) => ({ weekdays }),
    ),
  )('rejects noncanonical weekly weekdays $weekdays', ({ weekdays }) => {
    expect(
      RecurringScheduleRuleSchema.safeParse({
        kind: 'weekly',
        time: '09:30:00',
        timezone: 'UTC',
        weekdays,
      }).success,
    ).toBe(false);
  });

  it.each([
    { kind: 'daily', time: '24:00:00', timezone: 'UTC' },
    { kind: 'daily', time: '12:60:00', timezone: 'UTC' },
    { kind: 'daily', time: '09:30', timezone: 'UTC' },
    { kind: 'daily', time: '09:30:00.000', timezone: 'UTC' },
    { kind: 'daily', time: '09:30:00', timezone: 'not/a-timezone' },
    { kind: 'daily', time: '09:30:00', timezone: '' },
    { kind: 'every', seconds: 60, timezone: 'UTC' },
    { kind: 'daily', time: '09:30:00', timezone: 'UTC', seconds: 60 },
    { kind: 'weekly', day: 1, time: '09:30:00', timezone: 'UTC' },
    { kind: 'weekly', weekdays: [1], time: '09:30', timezone: 'UTC' },
    {
      kind: 'weekly',
      weekdays: [1],
      time: '09:30:00',
      timezone: 'Mars/Invalid',
    },
    {
      kind: 'weekly',
      weekdays: [1],
      time: '09:30:00',
      timezone: 'UTC',
      day: 1,
    },
    { kind: 'monthly', day: 1, time: '09:30:00', timezone: 'UTC' },
    { kind: 'cron', expression: '* * * * *' },
  ])('rejects unsupported or ambiguous rule data %j', (rule) => {
    expect(RecurringScheduleRuleSchema.safeParse(rule).success).toBe(false);
  });
});

describe('recurring write DTOs bind identity while excluding client authority', () => {
  it('accepts a flat creation request and normalizes content once', () => {
    const input = create();
    expect(
      CreateRecurringTaskInputSchema.parse({
        ...input,
        name: ' Daily report ',
        prompt: ' Summarize this chat ',
      }),
    ).toEqual(input);
    expect(
      CreateRecurringTaskInputSchema.safeParse({ task: input }).success,
    ).toBe(false);
    expect(
      CreateRecurringTaskInputSchema.safeParse({
        ...input,
        clientRequestId: undefined,
      }).success,
    ).toBe(false);
  });

  it.each([
    'organizationId',
    'workspaceId',
    'ownerId',
    'employeeAssignmentId',
    'employeeInstanceId',
    'sessionId',
    'nextRunAt',
    'canManage',
    'headers',
  ])(
    'rejects client supplied %s instead of deriving authority from the current chat',
    (key) => {
      expect(
        CreateRecurringTaskInputSchema.safeParse({
          ...create(),
          [key]: key === 'headers' ? {} : SESSION,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    { name: '' },
    { name: 'a'.repeat(161) },
    { prompt: '   ' },
    { prompt: 'a'.repeat(40_001) },
  ])('rejects invalid business content %j', (patch) => {
    expect(
      CreateRecurringTaskInputSchema.safeParse({ ...create(), ...patch })
        .success,
    ).toBe(false);
  });

  it.each(['pause', 'resume', 'delete'] as const)(
    'represents %s as an exact revisioned operation',
    (action) => {
      const request = { operationId: OPERATION, expectedRevision: 3, action };
      expect(ChangeRecurringTaskInputSchema.parse(request)).toEqual(request);
      expect(
        ChangeRecurringTaskInputSchema.safeParse({
          ...request,
          prompt: 'unexpected changed content',
        }).success,
      ).toBe(false);
    },
  );

  it('requires the complete new configuration for an update', () => {
    const { name, prompt, rule } = create();
    const content = { name, prompt, rule };
    const request = {
      operationId: OPERATION,
      expectedRevision: 3,
      action: 'update',
      ...content,
    };
    expect(ChangeRecurringTaskInputSchema.parse(request)).toEqual(request);
    for (const key of ['name', 'prompt', 'rule']) {
      const incomplete = { ...request } as Record<string, unknown>;
      delete incomplete[key];
      expect(ChangeRecurringTaskInputSchema.safeParse(incomplete).success).toBe(
        false,
      );
    }
  });

  it.each([
    { operationId: undefined },
    { operationId: 'not-a-uuid' },
    { expectedRevision: undefined },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'DELETE' },
    { action: 'cancel' },
  ])('rejects an unbound management operation %j', (patch) => {
    expect(
      ChangeRecurringTaskInputSchema.safeParse({
        operationId: OPERATION,
        expectedRevision: 1,
        action: 'pause',
        ...patch,
      }).success,
    ).toBe(false);
  });
});

describe('recurring exact reads cannot degrade to paginated absence', () => {
  it('keeps opaque cursor bytes unchanged for both list and history', () => {
    const cursor = 'opaque:+/cursor?=&%';
    expect(RecurringTaskListQuerySchema.parse({ cursor })).toEqual({ cursor });
    expect(RecurringTaskDetailQuerySchema.parse({ cursor })).toEqual({
      cursor,
    });
    expect(
      RecurringTaskListQuerySchema.parse({ clientRequestId: REQUEST }),
    ).toEqual({ clientRequestId: REQUEST });
    expect(
      RecurringTaskDetailQuerySchema.parse({ operationId: OPERATION }),
    ).toEqual({ operationId: OPERATION });
  });

  it.each([
    { clientRequestId: REQUEST, cursor: 'page-2' },
    { clientRequestId: 'wrong' },
    { cursor: '' },
    { cursor: 'x'.repeat(4097) },
    { ownerId: SESSION },
    { operationId: OPERATION },
  ])('rejects unsupported, mixed or malformed list query %j', (query) => {
    expect(RecurringTaskListQuerySchema.safeParse(query).success).toBe(false);
  });

  it.each([
    { operationId: OPERATION, cursor: 'page-2' },
    { operationId: 'wrong' },
    { cursor: '' },
    { cursor: 'x'.repeat(4097) },
    { ownerId: SESSION },
    { clientRequestId: REQUEST },
  ])('rejects unsupported, mixed or malformed detail query %j', (query) => {
    expect(RecurringTaskDetailQuerySchema.safeParse(query).success).toBe(false);
  });

  it('requires explicit pagination outcomes and bounds both result sets to fifty', () => {
    const base = {
      tasks: [task()],
      request: null,
      enabled: false,
      nextCursor: null,
    };
    expect(RecurringTaskListSchema.parse(base)).toEqual(base);
    expect(
      RecurringTaskListSchema.safeParse({ ...base, nextCursor: undefined })
        .success,
    ).toBe(false);
    expect(
      RecurringTaskListSchema.safeParse({ ...base, request: undefined })
        .success,
    ).toBe(false);
    expect(
      RecurringTaskListSchema.safeParse({
        ...base,
        tasks: Array.from({ length: 51 }, () => task()),
      }).success,
    ).toBe(false);
    expect(
      RecurringTaskListSchema.safeParse({
        ...base,
        tasks: Array.from({ length: 50 }, () => task()),
      }).success,
    ).toBe(true);
    const history = {
      task: task(),
      occurrences: [occurrence()],
      nextCursor: null,
    };
    expect(RecurringTaskHistorySchema.parse(history)).toEqual(history);
    expect(
      RecurringTaskHistorySchema.safeParse({
        ...history,
        nextCursor: undefined,
      }).success,
    ).toBe(false);
    expect(
      RecurringTaskHistorySchema.safeParse({
        ...history,
        occurrences: Array.from({ length: 51 }, () => occurrence()),
      }).success,
    ).toBe(false);
  });

  it('retains the immutable original create separately from an edited current task', () => {
    const original = create();
    const updated = task({
      name: 'Changed later',
      prompt: 'Changed business content',
      rule: { kind: 'every', seconds: 120 },
      revision: 4,
    });
    const result = RecurringTaskListSchema.parse({
      tasks: [updated],
      request: original,
      enabled: true,
      nextCursor: null,
    });
    expect(result.request).toEqual(original);
    expect(result.tasks[0]).toEqual(updated);
  });
});

describe('recurring replies preserve current permissions and durable operation facts', () => {
  it('requires a server supplied management decision and next execution outcome', () => {
    expect(
      RecurringTaskSchema.parse(task({ canManage: false, nextRunAt: null })),
    ).toMatchObject({ canManage: false, nextRunAt: null });
    expect(
      RecurringTaskSchema.safeParse({ ...task(), canManage: undefined })
        .success,
    ).toBe(false);
    expect(
      RecurringTaskSchema.safeParse({ ...task(), nextRunAt: undefined })
        .success,
    ).toBe(false);
    expect(
      RecurringTaskSchema.safeParse({ ...task(), clientRequestId: undefined })
        .success,
    ).toBe(false);
  });

  it.each(['pending', 'applied', 'rejected'] as const)(
    'preserves the complete original request for a %s operation',
    (status) => {
      const { name, prompt, rule } = create();
      const content = { name, prompt, rule };
      const request = {
        operationId: OPERATION,
        expectedRevision: 1,
        action: 'update' as const,
        ...content,
      };
      const value = {
        operationId: OPERATION,
        taskId: TASK,
        request,
        status,
        errorMessage: status === 'rejected' ? 'Revision changed' : null,
        task:
          status === 'pending' ? null : task({ revision: 3, canManage: false }),
      };
      expect(RecurringTaskOperationSchema.parse(value)).toEqual(value);
      expect(
        RecurringTaskOperationSchema.safeParse({ ...value, request: undefined })
          .success,
      ).toBe(false);
    },
  );

  it('distinguishes queued business work from periods that were not executed', () => {
    expect(RecurringOccurrenceSchema.parse(occurrence())).toMatchObject({
      status: 'queued',
      runId: RUN,
    });
    expect(
      RecurringOccurrenceSchema.parse({
        ...occurrence(),
        status: 'not_executed',
        runId: null,
        errorMessage: 'Paused',
      }),
    ).toMatchObject({ status: 'not_executed', runId: null });
    expect(
      RecurringOccurrenceSchema.safeParse({ ...occurrence(), revision: 0 })
        .success,
    ).toBe(false);
  });

  it('allows independently identified identical tasks after a prior create is confirmed', () => {
    const second = task({ id: RUN, clientRequestId: OPERATION });
    expect(
      RecurringTaskListSchema.parse({
        tasks: [task(), second],
        request: null,
        enabled: true,
        nextCursor: null,
      }).tasks,
    ).toHaveLength(2);
  });
});
