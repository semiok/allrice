import {
  ManualAutomationRunInputSchema,
  ManualAutomationRunReceiptSchema,
  UuidSchema,
  type ManualAutomationRunInput,
} from '@allrice/contracts';
export type ManualRunIntent = {
  version: 1;
  storageKey: string;
  workspaceId: string;
  taskId: string;
  request: ManualAutomationRunInput;
};
const prefix = 'allrice:manual-automation:v1:';
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function manualRunStorageKey(
  scope: string,
  workspaceId: string,
  taskId: string,
) {
  const parts = scope.split('/');
  if (
    parts.length !== 3 ||
    parts[1] !== workspaceId ||
    [...parts, workspaceId, taskId].some(
      (x) => !UuidSchema.safeParse(x).success,
    )
  )
    throw new Error('身份不完整，暂时不能立即执行。');
  return prefix + JSON.stringify([...parts, taskId]);
}
export function parseManualRunIntent(
  raw: string,
  key: string,
): ManualRunIntent {
  if (raw.length > 4096) throw new Error('立即执行记录过大。');
  const intent = JSON.parse(raw) as ManualRunIntent;
  const parts: unknown = key.startsWith(prefix)
    ? JSON.parse(key.slice(prefix.length))
    : null;
  if (
    !intent ||
    intent.version !== 1 ||
    intent.storageKey !== key ||
    Object.keys(intent).sort().join(',') !==
      'request,storageKey,taskId,version,workspaceId' ||
    !Array.isArray(parts) ||
    parts.length !== 4 ||
    parts.some((x) => typeof x !== 'string') ||
    parts[3] !== intent.taskId ||
    manualRunStorageKey(
      parts.slice(0, 3).join('/'),
      intent.workspaceId,
      intent.taskId,
    ) !== key
  )
    throw new Error('立即执行记录身份不匹配。');
  ManualAutomationRunInputSchema.parse(intent.request);
  return intent;
}
export function saveManualRunIntent(
  storage: IntentStorage,
  intent: ManualRunIntent,
) {
  const raw = JSON.stringify(intent);
  parseManualRunIntent(raw, intent.storageKey);
  if (storage.getItem(intent.storageKey) !== null)
    throw new Error('已有立即执行请求待核实。');
  storage.setItem(intent.storageKey, raw);
  if (storage.getItem(intent.storageKey) !== raw)
    throw new Error('未能保存原请求，未发送立即执行。');
}
export function clearManualRunIntent(
  storage: IntentStorage,
  intent: ManualRunIntent,
) {
  const raw = storage.getItem(intent.storageKey);
  if (raw !== null) {
    const saved = parseManualRunIntent(raw, intent.storageKey);
    if (
      saved.request.requestId !== intent.request.requestId ||
      saved.request.expectedRevision !== intent.request.expectedRevision
    )
      throw new Error('另一请求拥有此记录。');
  }
  storage.removeItem(intent.storageKey);
  if (storage.getItem(intent.storageKey) !== null)
    throw new Error('无法确认原请求记录已更新。');
}
export function manualRunURL(intent: ManualRunIntent, readback = false) {
  const qs = new URLSearchParams({ workspaceId: intent.workspaceId });
  if (readback) qs.set('requestId', intent.request.requestId);
  return (
    '/api/v1/scheduled-tasks/' +
    encodeURIComponent(intent.taskId) +
    '/run?' +
    qs
  );
}
export function resolveManualRunReceipt(
  intent: ManualRunIntent,
  body: unknown,
) {
  parseManualRunIntent(JSON.stringify(intent), intent.storageKey);
  if (
    body &&
    typeof body === 'object' &&
    'status' in body &&
    body.status === 'rejected'
  ) {
    const rejection = body as Record<string, unknown>,
      request = ManualAutomationRunInputSchema.parse(rejection.request);
    if (
      rejection.source !== 'manual' ||
      rejection.taskId !== intent.taskId ||
      request.requestId !== intent.request.requestId ||
      request.expectedRevision !== intent.request.expectedRevision ||
      ![
        'request_conflict',
        'revision_conflict',
        'unavailable',
        'authority_denied',
        'content_limit',
      ].includes(String(rejection.code)) ||
      typeof rejection.message !== 'string'
    )
      throw new Error('拒绝回执与原请求不匹配。');
    return { kind: 'rejected' as const, message: rejection.message };
  }
  const receipt = ManualAutomationRunReceiptSchema.parse(body),
    parts = JSON.parse(intent.storageKey.slice(prefix.length)) as string[];
  if (
    receipt.taskId !== intent.taskId ||
    receipt.request.requestId !== intent.request.requestId ||
    receipt.request.expectedRevision !== intent.request.expectedRevision ||
    receipt.run.organizationId !== parts[0] ||
    receipt.run.workspaceId !== intent.workspaceId ||
    receipt.run.ownerId !== parts[2] ||
    receipt.run.job.organizationId !== parts[0] ||
    receipt.run.job.workspaceId !== intent.workspaceId ||
    receipt.run.job.ownerId !== parts[2]
  )
    throw new Error('立即执行回执与原请求不匹配。');
  return { kind: 'accepted' as const, receipt };
}
