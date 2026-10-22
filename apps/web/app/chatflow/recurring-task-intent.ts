import {
  ChangeRecurringTaskInputSchema,
  CreateRecurringTaskInputSchema,
  RecurringTaskListSchema,
  RecurringTaskOperationSchema,
  RecurringTaskSchema,
  type ChangeRecurringTaskInput,
  type CreateRecurringTaskInput,
  type RecurringScheduleRule,
  type RecurringTask,
} from '@allrice/contracts';

export type RecurringTaskDraft = {
  name: string;
  prompt: string;
  kind: 'every' | 'daily' | 'weekly';
  minutes: string;
  time: string;
  timezone: string;
  weekdays: number[];
};

export type RecurringTaskContent = Pick<
  CreateRecurringTaskInput,
  'name' | 'prompt' | 'rule'
>;

type IntentScope = {
  version: 1;
  storageKey: string;
  sessionId: string;
};

export type RecurringTaskIntent = IntentScope &
  (
    | { kind: 'create'; body: CreateRecurringTaskInput }
    | { kind: 'change'; taskId: string; body: ChangeRecurringTaskInput }
  );

export type RecurringIntentResult =
  | { state: 'unconfirmed' }
  | { state: 'pending'; task: RecurringTask | null }
  | {
      state: 'settled';
      outcome: 'created' | 'applied' | 'rejected';
      task: RecurringTask | null;
      errorMessage: string | null;
    };

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'undefined';
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The caller supplies organization/workspace/viewer/AI; headers never persist. */
export function recurringStorageKey(
  scope: string,
  sessionId: string,
): string | null {
  const parts = scope.split('/');
  if (
    parts.length !== 4 ||
    [...parts, sessionId].some(
      (part) => !RecurringTaskSchema.shape.id.safeParse(part).success,
    )
  )
    return null;
  return (
    'allrice:recurring-pending:v1:' + JSON.stringify([...parts, sessionId])
  );
}

export function recurringDraft(task?: RecurringTask): RecurringTaskDraft {
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // The submitted IANA timezone remains explicit and is validated below.
  }
  return {
    name: task?.name ?? '',
    prompt: task?.prompt ?? '',
    kind: task?.rule.kind ?? 'every',
    minutes:
      task?.rule.kind === 'every' ? String(task.rule.seconds / 60) : '60',
    time:
      task && task.rule.kind !== 'every' ? task.rule.time.slice(0, 5) : '09:00',
    timezone:
      task && task.rule.kind !== 'every' ? task.rule.timezone : timezone,
    weekdays: task?.rule.kind === 'weekly' ? [...task.rule.weekdays] : [1],
  };
}

export function recurringContent(
  draft: RecurringTaskDraft,
  previousRule?: RecurringScheduleRule,
): RecurringTaskContent {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name || name.length > 160) throw new Error('请填写不超过160字的名称。');
  if (!prompt || prompt.length > 40_000)
    throw new Error('请填写不超过40000字的执行内容。');
  let rule: RecurringScheduleRule;
  if (draft.kind === 'every') {
    const minutes = Number(draft.minutes);
    const seconds = Math.round(minutes * 60);
    if (
      !draft.minutes.trim() ||
      !Number.isFinite(minutes) ||
      !Number.isSafeInteger(seconds) ||
      seconds < 60 ||
      seconds > 31_536_000 ||
      Math.abs(minutes * 60 - seconds) > 0.0000001
    )
      throw new Error('周期至少1分钟，最长365天，并需对应整秒。');
    rule = { kind: 'every', seconds };
  } else {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.time))
      throw new Error('请选择有效的执行时间。');
    // Editing text must not truncate a pre-existing rule's nonzero seconds.
    const time =
      previousRule &&
      previousRule.kind !== 'every' &&
      previousRule.time.slice(0, 5) === draft.time
        ? previousRule.time
        : draft.time + ':00';
    rule =
      draft.kind === 'weekly'
        ? {
            kind: 'weekly',
            time,
            timezone: draft.timezone.trim(),
            weekdays: [...draft.weekdays].sort((a, b) => a - b),
          }
        : { kind: 'daily', time, timezone: draft.timezone.trim() };
    if (draft.kind === 'weekly' && draft.weekdays.length === 0)
      throw new Error('请至少选择一个执行日。');
    try {
      new Intl.DateTimeFormat('en', { timeZone: rule.timezone });
    } catch {
      throw new Error('请填写有效的IANA时区，例如 Asia/Shanghai。');
    }
  }
  const parsed = CreateRecurringTaskInputSchema.safeParse({
    clientRequestId: '00000000-0000-4000-8000-000000000000',
    name,
    prompt,
    rule,
  });
  if (!parsed.success) throw new Error('名称、执行内容或周期格式不正确。');
  return {
    name: parsed.data.name,
    prompt: parsed.data.prompt,
    rule: parsed.data.rule,
  };
}

/** Restoring this record never grants permission to send its write again. */
export function parseRecurringIntent(
  raw: string,
  storageKey: string,
): RecurringTaskIntent {
  if (raw.length > 250_000) throw new Error('saved request too large');
  const entry = object(JSON.parse(raw));
  const keys = ['version', 'storageKey', 'sessionId', 'kind', 'body'];
  if (entry?.kind === 'change') keys.push('taskId');
  if (
    !entry ||
    entry.version !== 1 ||
    entry.storageKey !== storageKey ||
    Object.keys(entry).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(entry, key))
  )
    throw new Error('saved request scope or shape changed');
  const sessionId = RecurringTaskSchema.shape.sessionId.parse(entry.sessionId);
  const prefix = 'allrice:recurring-pending:v1:';
  const scope: unknown = storageKey.startsWith(prefix)
    ? JSON.parse(storageKey.slice(prefix.length))
    : null;
  if (
    !Array.isArray(scope) ||
    scope.length !== 5 ||
    scope.some((part) => typeof part !== 'string') ||
    scope[4] !== sessionId ||
    recurringStorageKey(scope.slice(0, 4).join('/'), sessionId) !== storageKey
  )
    throw new Error('saved request session changed');
  if (entry.kind === 'create') {
    const body = CreateRecurringTaskInputSchema.parse(entry.body);
    if (stable(body) !== stable(entry.body))
      throw new Error('saved body changed');
    return { version: 1, storageKey, sessionId, kind: 'create', body };
  }
  if (entry.kind !== 'change') throw new Error('saved request kind changed');
  const body = ChangeRecurringTaskInputSchema.parse(entry.body);
  if (stable(body) !== stable(entry.body))
    throw new Error('saved body changed');
  return {
    version: 1,
    storageKey,
    sessionId,
    kind: 'change',
    taskId: RecurringTaskSchema.shape.id.parse(entry.taskId),
    body,
  };
}

export function saveRecurringIntent(
  storage: IntentStorage,
  intent: RecurringTaskIntent,
): void {
  const serialized = JSON.stringify(intent);
  parseRecurringIntent(serialized, intent.storageKey);
  if (storage.getItem(intent.storageKey) !== null)
    throw new Error('unconfirmed request already saved');
  storage.setItem(intent.storageKey, serialized);
  if (storage.getItem(intent.storageKey) !== serialized)
    throw new Error('request persistence unconfirmed');
}

export function clearRecurringIntent(
  storage: IntentStorage,
  intent: RecurringTaskIntent,
): void {
  const saved = storage.getItem(intent.storageKey);
  if (
    saved !== null &&
    stable(parseRecurringIntent(saved, intent.storageKey)) !== stable(intent)
  )
    throw new Error('another request owns this saved state');
  storage.removeItem(intent.storageKey);
  if (storage.getItem(intent.storageKey) !== null)
    throw new Error('request confirmation persistence unconfirmed');
}

export function recurringIntentURL(intent: RecurringTaskIntent): string {
  const root =
    '/api/v1/sessions/' +
    encodeURIComponent(intent.sessionId) +
    '/schedule-tasks';
  return intent.kind === 'create'
    ? root +
        '?clientRequestId=' +
        encodeURIComponent(intent.body.clientRequestId)
    : root +
        '/' +
        encodeURIComponent(intent.taskId) +
        '?operationId=' +
        encodeURIComponent(intent.body.operationId);
}

export function resolveRecurringIntent(
  intent: RecurringTaskIntent,
  result: { source: 'write' | 'readback'; status: number; body: unknown },
): RecurringIntentResult {
  const envelope = object(result.body);
  const ok = result.status >= 200 && result.status < 300;
  if (intent.kind === 'create') {
    if (!ok) return { state: 'unconfirmed' };
    let value: unknown;
    if (result.source === 'write') value = envelope?.task;
    else {
      const list = RecurringTaskListSchema.safeParse(result.body);
      if (
        !list.success ||
        list.data.nextCursor !== null ||
        list.data.tasks.length !== 1 ||
        stable(list.data.request) !== stable(intent.body)
      )
        return { state: 'unconfirmed' };
      value = list.data.tasks[0];
    }
    const task = RecurringTaskSchema.safeParse(value);
    if (
      !task.success ||
      task.data.sessionId !== intent.sessionId ||
      task.data.clientRequestId !== intent.body.clientRequestId
    )
      return { state: 'unconfirmed' };
    return {
      state: 'settled',
      outcome: 'created',
      task: task.data,
      errorMessage: null,
    };
  }
  const conflictReceipt = result.source === 'write' && result.status === 409;
  if (!ok && !conflictReceipt) return { state: 'unconfirmed' };
  const operation = RecurringTaskOperationSchema.safeParse(envelope?.operation);
  if (
    !operation.success ||
    operation.data.operationId !== intent.body.operationId ||
    operation.data.taskId !== intent.taskId ||
    stable(operation.data.request) !== stable(intent.body) ||
    (operation.data.task !== null &&
      (operation.data.task.id !== intent.taskId ||
        operation.data.task.sessionId !== intent.sessionId)) ||
    (conflictReceipt && operation.data.status !== 'rejected')
  )
    return { state: 'unconfirmed' };
  if (operation.data.status === 'pending')
    return { state: 'pending', task: operation.data.task };
  return {
    state: 'settled',
    outcome: operation.data.status,
    task: operation.data.task,
    errorMessage: operation.data.errorMessage,
  };
}

export function mergeRecurringTasks(
  fresh: RecurringTask[],
  previous: RecurringTask[],
): RecurringTask[] {
  const old = new Map(previous.map((task) => [task.id, task]));
  const result = fresh.map((task) => {
    const prior = old.get(task.id);
    old.delete(task.id);
    return prior &&
      (prior.revision > task.revision ||
        (prior.revision === task.revision &&
          Date.parse(prior.updatedAt) > Date.parse(task.updatedAt)))
      ? prior
      : task;
  });
  return [...result, ...old.values()];
}
