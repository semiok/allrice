import { RunSnapshotSchema, UuidSchema } from '@allrice/contracts';

export type StopOccurrenceIntent = {
  version: 1;
  storageKey: string;
  workspaceId: string;
  taskId: string;
  occurrenceId: string;
  runId: string;
  source?: 'manual' | 'native_occurrence' | 'legacy_run';
};
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'allrice:stop-occurrence:v1:';

export function stopOccurrenceStorageKey(
  scope: string,
  workspaceId: string,
  taskId: string,
) {
  const parts = scope.split('/');
  if (
    parts.length !== 3 ||
    [...parts, workspaceId, taskId].some(
      (id) => !UuidSchema.safeParse(id).success,
    ) ||
    parts[1] !== workspaceId
  )
    throw new Error('身份不完整，暂时不能停止本轮。');
  return prefix + JSON.stringify([...parts, taskId]);
}

/** Restoring the exact target grants readback only, never another POST. */
export function parseStopOccurrenceIntent(
  raw: string,
  storageKey: string,
): StopOccurrenceIntent {
  if (raw.length > 4096) throw new Error('停止记录过大。');
  const intent = JSON.parse(raw) as StopOccurrenceIntent;
  const keys = [
    'version',
    'storageKey',
    'workspaceId',
    'taskId',
    'occurrenceId',
    'runId',
  ];
  if (intent && Object.hasOwn(intent, 'source')) keys.push('source');
  const scope: unknown = storageKey.startsWith(prefix)
    ? JSON.parse(storageKey.slice(prefix.length))
    : null;
  if (
    !intent ||
    intent.version !== 1 ||
    intent.storageKey !== storageKey ||
    Object.keys(intent).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(intent, key)) ||
    !Array.isArray(scope) ||
    scope.length !== 4 ||
    scope.some((id) => typeof id !== 'string') ||
    scope[3] !== intent.taskId ||
    stopOccurrenceStorageKey(
      scope.slice(0, 3).join('/'),
      intent.workspaceId,
      intent.taskId,
    ) !== storageKey
  )
    throw new Error('停止记录的身份不匹配。');
  UuidSchema.parse(intent.occurrenceId);
  UuidSchema.parse(intent.runId);
  if (
    intent.source !== undefined &&
    !['manual', 'native_occurrence', 'legacy_run'].includes(intent.source)
  )
    throw new Error('停止记录的来源不匹配。');
  return intent;
}

export function saveStopOccurrenceIntent(
  storage: IntentStorage,
  intent: StopOccurrenceIntent,
) {
  const raw = JSON.stringify(intent);
  parseStopOccurrenceIntent(raw, intent.storageKey);
  if (storage.getItem(intent.storageKey) !== null)
    throw new Error('上一次停止本轮的结果待确认，请先查看。');
  storage.setItem(intent.storageKey, raw);
  if (storage.getItem(intent.storageKey) !== raw)
    throw new Error('无法保存停止记录，未发送请求。');
}

export function clearStopOccurrenceIntent(
  storage: IntentStorage,
  intent: StopOccurrenceIntent,
) {
  const raw = storage.getItem(intent.storageKey);
  if (raw !== null) {
    const saved = parseStopOccurrenceIntent(raw, intent.storageKey);
    if (
      saved.occurrenceId !== intent.occurrenceId ||
      saved.runId !== intent.runId ||
      saved.source !== intent.source
    )
      throw new Error('另一项停止请求拥有此记录。');
  }
  storage.removeItem(intent.storageKey);
  if (storage.getItem(intent.storageKey) !== null)
    throw new Error('无法确认停止记录已更新。');
}

export function stopOccurrenceURL(
  intent: StopOccurrenceIntent,
  readback = false,
) {
  const query = new URLSearchParams({ workspaceId: intent.workspaceId });
  if (readback) {
    query.set('occurrenceId', intent.occurrenceId);
    query.set('runId', intent.runId);
    if (intent.source) query.set('source', intent.source);
  }
  return (
    '/api/v1/scheduled-tasks/' +
    encodeURIComponent(intent.taskId) +
    '/stop-occurrence?' +
    query
  );
}

export function resolveStopOccurrenceReceipt(
  intent: StopOccurrenceIntent,
  body: unknown,
) {
  parseStopOccurrenceIntent(JSON.stringify(intent), intent.storageKey);
  if (!body || typeof body !== 'object') throw new Error('停止结果待确认。');
  const receipt = body as Record<string, unknown>;
  const run = RunSnapshotSchema.parse(receipt.run);
  const scope = JSON.parse(intent.storageKey.slice(prefix.length)) as string[];
  if (
    receipt.taskId !== intent.taskId ||
    receipt.occurrenceId !== intent.occurrenceId ||
    (intent.source !== undefined && receipt.source !== intent.source) ||
    run.id !== intent.runId ||
    run.workspaceId !== intent.workspaceId ||
    run.organizationId !== scope[0] ||
    run.ownerId !== scope[2] ||
    run.job.organizationId !== run.organizationId ||
    run.job.workspaceId !== run.workspaceId ||
    run.job.ownerId !== run.ownerId ||
    typeof receipt.canStop !== 'boolean'
  )
    throw new Error('停止结果待确认。');
  const terminal =
    ['succeeded', 'failed', 'canceled'].includes(run.status) ||
    ['succeeded', 'failed', 'dead_letter', 'canceled'].includes(run.job.status);
  return {
    run,
    state: terminal
      ? ('terminal' as const)
      : run.cancelRequestedAt
        ? ('stopping' as const)
        : ('unconfirmed' as const),
  };
}
