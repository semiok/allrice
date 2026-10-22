import { describe, expect, it } from 'vitest';
import type {
  ChangeRecurringTaskInput,
  RecurringTask,
  RecurringTaskOperation,
} from '@allrice/contracts';
import {
  clearRecurringIntent,
  mergeRecurringTasks,
  parseRecurringIntent,
  recurringContent,
  recurringDraft,
  recurringIntentURL,
  recurringStorageKey,
  resolveRecurringIntent,
  saveRecurringIntent,
  type RecurringTaskDraft,
  type RecurringTaskIntent,
} from './recurring-task-intent';

const ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const AI = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const TASK = '66666666-6666-4666-8666-666666666666';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const OPERATION = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';
const SCOPE = [ORG, WORKSPACE, VIEWER, AI].join('/');
const KEY = recurringStorageKey(SCOPE, SESSION)!;

function task(overrides: Partial<RecurringTask> = {}): RecurringTask {
  return {
    id: TASK,
    clientRequestId: REQUEST,
    sessionId: SESSION,
    name: '日报',
    prompt: '整理这个会话的进展',
    rule: { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
    revision: 1,
    status: 'enabled',
    nextRunAt: '2026-10-21T01:30:00.000Z',
    errorMessage: null,
    createdAt: '2026-10-20T01:00:00.000Z',
    updatedAt: '2026-10-20T01:00:00.000Z',
    canManage: true,
    latestOccurrence: null,
    ...overrides,
  };
}

function createIntent(): RecurringTaskIntent & { kind: 'create' } {
  const { name, prompt, rule } = task();
  return {
    version: 1,
    storageKey: KEY,
    sessionId: SESSION,
    kind: 'create',
    body: { clientRequestId: REQUEST, name, prompt, rule },
  };
}

function changeIntent(
  body: ChangeRecurringTaskInput = {
    operationId: OPERATION,
    expectedRevision: 1,
    action: 'pause',
  },
): RecurringTaskIntent & { kind: 'change' } {
  return {
    version: 1,
    storageKey: KEY,
    sessionId: SESSION,
    kind: 'change',
    taskId: TASK,
    body,
  };
}

function operation(
  intent: RecurringTaskIntent & { kind: 'change' },
  overrides: Partial<RecurringTaskOperation> = {},
): RecurringTaskOperation {
  return {
    operationId: intent.body.operationId,
    taskId: intent.taskId,
    request: intent.body,
    status: 'applied',
    errorMessage: null,
    task: task({ revision: 2, status: 'paused' }),
    ...overrides,
  };
}

function list(
  tasks: RecurringTask[] = [task()],
  nextCursor: string | null = null,
) {
  return { tasks, enabled: true, nextCursor, request: createIntent().body };
}

function draft(patch: Partial<RecurringTaskDraft> = {}): RecurringTaskDraft {
  return { ...recurringDraft(), name: '日报', prompt: '整理进展', ...patch };
}

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('recurring task form parameters', () => {
  it('preserves weekly execution days, timezone and seconds through editing and recovery', () => {
    const weekly = task({
      rule: {
        kind: 'weekly',
        weekdays: [1, 3, 7],
        time: '09:30:05',
        timezone: 'America/New_York',
      },
    });
    const form = recurringDraft(weekly);
    expect(form).toMatchObject({
      kind: 'weekly',
      weekdays: [1, 3, 7],
      time: '09:30',
      timezone: 'America/New_York',
    });
    expect(recurringContent(form, weekly.rule).rule).toEqual(weekly.rule);
    expect(
      recurringContent({ ...form, weekdays: [2, 7] }, weekly.rule).rule,
    ).toEqual({ ...weekly.rule, weekdays: [2, 7] });
    const changed = recurringContent(
      { ...form, weekdays: [7, 2], time: '10:00' },
      weekly.rule,
    );
    expect(changed.rule).toEqual({
      kind: 'weekly',
      weekdays: [2, 7],
      time: '10:00:00',
      timezone: 'America/New_York',
    });
    const intent = {
      ...createIntent(),
      body: { clientRequestId: REQUEST, ...changed },
    };
    const storage = new MemoryStorage();
    saveRecurringIntent(storage, intent);
    expect(parseRecurringIntent(storage.getItem(KEY)!, KEY)).toEqual(intent);
  });

  it.each([[], [0], [8], [1, 1], [1.5]].map((weekdays) => ({ weekdays })))(
    'rejects invalid weekly days %j before a write',
    ({ weekdays }) => {
      expect(() =>
        recurringContent(draft({ kind: 'weekly', weekdays })),
      ).toThrow();
    },
  );
  it('creates flat normalized content with whole-second intervals', () => {
    expect(
      recurringContent(
        draft({ name: ' 日报 ', prompt: ' 整理进展 ', minutes: '1.5' }),
      ),
    ).toEqual({
      name: '日报',
      prompt: '整理进展',
      rule: { kind: 'every', seconds: 90 },
    });
    expect(recurringContent(draft({ minutes: '525600' })).rule).toEqual({
      kind: 'every',
      seconds: 31_536_000,
    });
  });

  it.each(['', '0', '0.5', '-1', 'Infinity', 'NaN', '1.001', '525601'])(
    'rejects an invalid interval %j',
    (minutes) => {
      expect(() => recurringContent(draft({ minutes }))).toThrow();
    },
  );

  it.each([
    { name: '' },
    { name: 'a'.repeat(161) },
    { prompt: '   ' },
    { prompt: 'a'.repeat(40_001) },
  ])('validates task content before preserving an intent', (patch) => {
    expect(() => recurringContent(draft(patch))).toThrow();
  });

  it('keeps an explicit daily timezone and changes only the selected wall time', () => {
    expect(
      recurringContent(
        draft({ kind: 'daily', time: '09:30', timezone: ' America/New_York ' }),
      ).rule,
    ).toEqual({
      kind: 'daily',
      time: '09:30:00',
      timezone: 'America/New_York',
    });
    const previous = {
      kind: 'daily' as const,
      time: '09:30:27',
      timezone: 'Asia/Shanghai',
    };
    expect(
      recurringContent(
        draft({ kind: 'daily', time: '09:30', timezone: 'Asia/Shanghai' }),
        previous,
      ).rule,
    ).toEqual(previous);
    expect(
      recurringContent(
        draft({ kind: 'daily', time: '10:00', timezone: 'Asia/Shanghai' }),
        previous,
      ).rule,
    ).toEqual({
      ...previous,
      time: '10:00:00',
    });
    expect(recurringDraft(task({ rule: previous }))).toMatchObject({
      kind: 'daily',
      time: '09:30',
      timezone: 'Asia/Shanghai',
    });
  });

  it.each([
    { time: '24:00', timezone: 'UTC' },
    { time: '9:30', timezone: 'UTC' },
    { time: '09:30:00', timezone: 'UTC' },
    { time: '09:30', timezone: 'not/a-zone' },
    { time: '09:30', timezone: '' },
  ])('rejects invalid daily parameters %j', (patch) => {
    expect(() =>
      recurringContent(draft({ kind: 'daily', ...patch })),
    ).toThrow();
  });

  it('can restore an interval expressed in non-minute whole seconds without changing it', () => {
    const existing = task({ rule: { kind: 'every', seconds: 61 } });
    expect(recurringContent(recurringDraft(existing)).rule).toEqual(
      existing.rule,
    );
  });
});

describe('scope-bound durable recurring intents', () => {
  it('isolates organization, workspace, viewer, AI and chat without credentials', () => {
    const keys = [KEY, recurringStorageKey(SCOPE, OTHER)];
    for (let index = 0; index < 4; index++) {
      const scope = [ORG, WORKSPACE, VIEWER, AI];
      scope[index] = OTHER;
      keys.push(recurringStorageKey(scope.join('/'), SESSION));
    }
    expect(new Set(keys).size).toBe(6);
    expect(KEY).not.toContain('Authorization');
    expect(
      recurringStorageKey([ORG, WORKSPACE, AI].join('/'), SESSION),
    ).toBeNull();
    expect(
      recurringStorageKey(
        [ORG, WORKSPACE, 'bearer-token', AI].join('/'),
        SESSION,
      ),
    ).toBeNull();
    expect(recurringStorageKey(SCOPE, '')).toBeNull();
  });

  it.each([
    createIntent(),
    changeIntent(),
    changeIntent({
      operationId: OPERATION,
      expectedRevision: 3,
      action: 'update',
      name: '编辑后的名称',
      prompt: '编辑后的完整内容',
      rule: { kind: 'every', seconds: 90 },
    }),
  ])('restores the exact UUID and full original body for %j', (intent) => {
    const storage = new MemoryStorage();
    saveRecurringIntent(storage, intent);
    expect(parseRecurringIntent(storage.getItem(KEY)!, KEY)).toEqual(intent);
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual(intent);
  });

  it('rejects a saved body moved across chats or scopes', () => {
    const intent = createIntent();
    expect(() =>
      parseRecurringIntent(
        JSON.stringify({ ...intent, sessionId: OTHER }),
        KEY,
      ),
    ).toThrow();
    expect(() =>
      parseRecurringIntent(
        JSON.stringify(intent),
        recurringStorageKey(SCOPE, OTHER)!,
      ),
    ).toThrow();
    expect(() =>
      parseRecurringIntent(
        JSON.stringify({ ...intent, storageKey: 'arbitrary-key' }),
        'arbitrary-key',
      ),
    ).toThrow();
  });

  it.each([
    (intent: ReturnType<typeof createIntent>) => ({
      ...intent,
      headers: { Authorization: 'must-not-persist' },
    }),
    (intent: ReturnType<typeof createIntent>) => ({
      ...intent,
      body: { ...intent.body, ownerId: ORG },
    }),
    (intent: ReturnType<typeof createIntent>) => ({
      ...intent,
      body: { ...intent.body, name: ' 日报 ' },
    }),
    (intent: ReturnType<typeof createIntent>) => ({
      ...intent,
      body: { ...intent.body, clientRequestId: undefined },
    }),
    (intent: ReturnType<typeof createIntent>) => ({ ...intent, version: 2 }),
  ])(
    'rejects incomplete, transformed or unrelated persisted data',
    (change) => {
      expect(() =>
        parseRecurringIntent(JSON.stringify(change(createIntent())), KEY),
      ).toThrow();
    },
  );

  it('does not overwrite an unresolved intent, even for identical content', () => {
    const storage = new MemoryStorage();
    const original = createIntent();
    saveRecurringIntent(storage, original);
    expect(() =>
      saveRecurringIntent(storage, {
        ...original,
        body: { ...original.body, clientRequestId: OTHER },
      }),
    ).toThrow('already saved');
    expect(parseRecurringIntent(storage.getItem(KEY)!, KEY)).toEqual(original);
    clearRecurringIntent(storage, original);
    const second = {
      ...original,
      body: { ...original.body, clientRequestId: OTHER },
    };
    saveRecurringIntent(storage, second);
    expect(parseRecurringIntent(storage.getItem(KEY)!, KEY)).toEqual(second);
  });

  it('requires successful persistence and exact readback before a write is allowed', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('quota');
    };
    expect(() => saveRecurringIntent(storage, createIntent())).toThrow('quota');
    const discarded = new MemoryStorage();
    discarded.setItem = () => {};
    expect(() => saveRecurringIntent(discarded, createIntent())).toThrow(
      'persistence unconfirmed',
    );
  });

  it('cannot clear another request when acknowledging a previous one', () => {
    const storage = new MemoryStorage();
    const original = createIntent();
    const newer = {
      ...original,
      body: { ...original.body, clientRequestId: OTHER },
    };
    saveRecurringIntent(storage, newer);
    expect(() => clearRecurringIntent(storage, original)).toThrow(
      'another request',
    );
    expect(parseRecurringIntent(storage.getItem(KEY)!, KEY)).toEqual(newer);
  });
});

describe('unknown recurring creates resolve only by exact original identity', () => {
  it('reads by clientRequestId independently of the list pagination window', () => {
    const intent = createIntent();
    const url = new URL(recurringIntentURL(intent), 'https://fixture.invalid');
    expect(url.pathname).toBe(`/api/v1/sessions/${SESSION}/schedule-tasks`);
    expect([...url.searchParams]).toEqual([['clientRequestId', REQUEST]]);
    expect(
      resolveRecurringIntent(intent, {
        source: 'readback',
        status: 200,
        body: list(),
      }),
    ).toMatchObject({
      state: 'settled',
      outcome: 'created',
      task: { id: TASK },
    });
    expect(
      resolveRecurringIntent(intent, {
        source: 'write',
        status: 201,
        body: { task: task({ status: 'preparing', nextRunAt: null }) },
      }),
    ).toMatchObject({
      state: 'settled',
      outcome: 'created',
      task: { status: 'preparing' },
    });
  });

  it('confirms the original create after another page edits the current task', () => {
    const intent = createIntent();
    const edited = task({
      name: '新名称',
      prompt: '新内容',
      rule: { kind: 'every', seconds: 120 },
      revision: 3,
    });
    expect(
      resolveRecurringIntent(intent, {
        source: 'readback',
        status: 200,
        body: list([edited]),
      }),
    ).toMatchObject({
      state: 'settled',
      outcome: 'created',
      task: { revision: 3, name: '新名称' },
    });
  });

  it.each([
    list([]),
    list([task()], 'opaque-cursor'),
    list([task(), task({ id: OTHER })]),
    { task: task() },
  ])('does not infer absence or replay from an inexact list %j', (body) => {
    expect(
      resolveRecurringIntent(createIntent(), {
        source: 'readback',
        status: 200,
        body,
      }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it.each([{ clientRequestId: OTHER }, { sessionId: OTHER }])(
    'requires the original task identities %j',
    (patch) => {
      expect(
        resolveRecurringIntent(createIntent(), {
          source: 'readback',
          status: 200,
          body: list([task(patch)]),
        }),
      ).toEqual({ state: 'unconfirmed' });
    },
  );

  it.each([
    { clientRequestId: OTHER },
    { name: '名称变了' },
    { prompt: '内容变了' },
    { rule: { kind: 'daily' as const, time: '09:30:00', timezone: 'UTC' } },
    {
      rule: {
        kind: 'daily' as const,
        time: '10:30:00',
        timezone: 'Asia/Shanghai',
      },
    },
  ])('requires the complete persisted original create receipt %j', (patch) => {
    const intent = createIntent();
    const body = { ...list(), request: { ...intent.body, ...patch } };
    expect(
      resolveRecurringIntent(intent, { source: 'readback', status: 200, body }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it('does not resolve a create using a normal list without its original receipt', () => {
    const body = { ...list(), request: null };
    expect(
      resolveRecurringIntent(createIntent(), {
        source: 'readback',
        status: 200,
        body,
      }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it.each([401, 403, 404, 409, 500])(
    'retains the unknown request after HTTP %s',
    (status) => {
      const intent = createIntent();
      expect(
        resolveRecurringIntent(intent, {
          source: 'readback',
          status,
          body: list(),
        }),
      ).toEqual({ state: 'unconfirmed' });
      expect(
        resolveRecurringIntent(intent, {
          source: 'write',
          status,
          body: { task: task() },
        }),
      ).toEqual({ state: 'unconfirmed' });
    },
  );
});

describe('unknown recurring management resolves only by exact operation receipt', () => {
  it('uses the original operationId without a cursor', () => {
    const intent = changeIntent();
    const url = new URL(recurringIntentURL(intent), 'https://fixture.invalid');
    expect(url.pathname).toBe(
      `/api/v1/sessions/${SESSION}/schedule-tasks/${TASK}`,
    );
    expect([...url.searchParams]).toEqual([['operationId', OPERATION]]);
    expect(
      resolveRecurringIntent(intent, {
        source: 'readback',
        status: 200,
        body: { operation: operation(intent) },
      }),
    ).toMatchObject({
      state: 'settled',
      outcome: 'applied',
      task: { revision: 2 },
    });
  });

  it('keeps an accepted pending operation saved until it is applied or rejected', () => {
    const intent = changeIntent();
    expect(
      resolveRecurringIntent(intent, {
        source: 'write',
        status: 202,
        body: {
          operation: operation(intent, { status: 'pending', task: null }),
        },
      }),
    ).toEqual({ state: 'pending', task: null });
    expect(
      resolveRecurringIntent(intent, {
        source: 'readback',
        status: 200,
        body: { operation: null },
      }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it.each([
    { operationId: OTHER },
    { taskId: OTHER },
    {
      request: {
        operationId: OTHER,
        expectedRevision: 1,
        action: 'pause' as const,
      },
    },
    {
      request: {
        operationId: OPERATION,
        expectedRevision: 2,
        action: 'pause' as const,
      },
    },
    {
      request: {
        operationId: OPERATION,
        expectedRevision: 1,
        action: 'delete' as const,
      },
    },
    { task: task({ id: OTHER }) },
    { task: task({ sessionId: OTHER }) },
  ])('does not accept another operation or revision %j', (patch) => {
    const intent = changeIntent();
    expect(
      resolveRecurringIntent(intent, {
        source: 'readback',
        status: 200,
        body: { operation: operation(intent, patch) },
      }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it.each([
    { name: '不同名称' },
    { prompt: '不同内容' },
    { rule: { kind: 'every' as const, seconds: 120 } },
  ])('also checks the complete original update body %j', (patch) => {
    const body = {
      operationId: OPERATION,
      expectedRevision: 1,
      action: 'update' as const,
      name: '日报',
      prompt: '进展',
      rule: { kind: 'every' as const, seconds: 60 },
    };
    const intent = changeIntent(body);
    expect(
      resolveRecurringIntent(intent, {
        source: 'readback',
        status: 200,
        body: {
          operation: operation(intent, { request: { ...body, ...patch } }),
        },
      }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it('confirms a 409 only through its rejected original receipt and exposes the current revision', () => {
    const intent = changeIntent();
    const body = {
      operation: operation(intent, {
        status: 'rejected',
        errorMessage: '版本已变化',
        task: task({ revision: 4 }),
      }),
    };
    expect(
      resolveRecurringIntent(intent, { source: 'write', status: 409, body }),
    ).toMatchObject({
      state: 'settled',
      outcome: 'rejected',
      errorMessage: '版本已变化',
      task: { revision: 4 },
    });
    expect(
      resolveRecurringIntent(intent, { source: 'readback', status: 200, body }),
    ).toMatchObject({ state: 'settled', outcome: 'rejected' });
    expect(
      resolveRecurringIntent(intent, { source: 'readback', status: 409, body }),
    ).toEqual({ state: 'unconfirmed' });
    expect(
      resolveRecurringIntent(intent, {
        source: 'write',
        status: 409,
        body: { operation: operation(intent) },
      }),
    ).toEqual({ state: 'unconfirmed' });
  });

  it.each([401, 403, 404, 500])(
    'keeps a management write unknown after HTTP %s',
    (status) => {
      const intent = changeIntent();
      const body = { operation: operation(intent) };
      expect(
        resolveRecurringIntent(intent, { source: 'readback', status, body }),
      ).toEqual({ state: 'unconfirmed' });
      expect(
        resolveRecurringIntent(intent, { source: 'write', status, body }),
      ).toEqual({ state: 'unconfirmed' });
    },
  );
});

describe('recurring task list receipt ordering', () => {
  it('keeps a newer confirmed revision when an older first page arrives', () => {
    const newer = task({
      revision: 3,
      status: 'paused',
      updatedAt: '2026-10-20T03:00:00.000Z',
    });
    expect(mergeRecurringTasks([task()], [newer])).toEqual([newer]);
    const sameRevisionOlder = task({ revision: 3 });
    expect(mergeRecurringTasks([sameRevisionOlder], [newer])).toEqual([newer]);
  });

  it('retains separate identical tasks and loaded pages by task identity', () => {
    const oldPage = task({ id: OTHER, clientRequestId: OTHER });
    expect(mergeRecurringTasks([task()], [oldPage])).toEqual([task(), oldPage]);
    expect(
      mergeRecurringTasks([task({ revision: 2 })], [task(), oldPage]).map(
        (item) => item.id,
      ),
    ).toEqual([TASK, OTHER]);
  });
});
