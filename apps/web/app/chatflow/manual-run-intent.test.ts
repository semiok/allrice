import { describe, expect, it } from 'vitest';
import {
  ManualAutomationRunInputSchema,
  type RunSnapshot,
} from '@allrice/contracts';
import {
  clearManualRunIntent,
  manualRunStorageKey,
  manualRunURL,
  parseManualRunIntent,
  resolveManualRunReceipt,
  saveManualRunIntent,
  type ManualRunIntent,
} from './manual-run-intent';

const ORG = '11111111-1111-4111-8111-111111111111',
  WORKSPACE = '22222222-2222-4222-8222-222222222222',
  OWNER = '33333333-3333-4333-8333-333333333333',
  TASK = '44444444-4444-4444-8444-444444444444',
  REQUEST = '55555555-5555-4555-8555-555555555555',
  RUN = '66666666-6666-4666-8666-666666666666',
  OTHER = '77777777-7777-4777-8777-777777777777';
const now = '2026-10-22T01:00:00.000Z';
const intent: ManualRunIntent = {
  version: 1,
  storageKey: manualRunStorageKey(
    [ORG, WORKSPACE, OWNER].join('/'),
    WORKSPACE,
    TASK,
  ),
  workspaceId: WORKSPACE,
  taskId: TASK,
  request: { requestId: REQUEST, expectedRevision: 3 },
};
function receipt() {
  const run: RunSnapshot = {
    id: RUN,
    organizationId: ORG,
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    status: 'queued',
    cancelRequestedAt: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    job: {
      id: OTHER,
      organizationId: ORG,
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      status: 'queued',
      idempotencyKey: 'employee-message:' + OTHER,
      priority: 0,
      attempt: 0,
      maxAttempts: 2,
      availableAt: now,
      timeoutAt: now,
      payload: { schemaVersion: 1, type: 'allrice.employee.run', input: {} },
      lease: null,
    },
  };
  return {
    source: 'manual',
    taskId: TASK,
    request: { ...intent.request },
    requestDigest: 'sha256:' + 'a'.repeat(64),
    automationRunId: OTHER,
    requestedAt: now,
    sessionId: OTHER,
    run,
  };
}
class MemoryStorage {
  values = new Map<string, string>();
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
}
describe('manual request identity and uncertain acknowledgements', () => {
  it('accepts only the explicit request and original business revision, never a native proof or replacement due time', () => {
    expect(ManualAutomationRunInputSchema.parse(intent.request)).toEqual(
      intent.request,
    );
    for (const patch of [
      { source: 'native' },
      { scheduledAt: now },
      { runId: RUN },
      { receipt: {} },
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
    ])
      expect(
        ManualAutomationRunInputSchema.safeParse({
          ...intent.request,
          ...patch,
        }).success,
      ).toBe(false);
  });
  it('persists the original revision and restores an exact GET without choosing the latest Run', () => {
    const s = new MemoryStorage();
    saveManualRunIntent(s, intent);
    const restored = parseManualRunIntent(
      s.getItem(intent.storageKey)!,
      intent.storageKey,
    );
    expect(restored).toEqual(intent);
    const url = new URL(manualRunURL(restored, true), 'https://fixture');
    expect(url.pathname).toBe(`/api/v1/scheduled-tasks/${TASK}/run`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
    });
    expect(manualRunURL(restored)).not.toContain('requestId=');
    expect(() =>
      saveManualRunIntent(s, {
        ...intent,
        request: { requestId: OTHER, expectedRevision: 4 },
      }),
    ).toThrow();
  });
  it('does not authorize POST when persistent local state cannot be confirmed', () => {
    const s = new MemoryStorage();
    s.setItem = () => {};
    expect(() => saveManualRunIntent(s, intent)).toThrow('未发送');
  });
  it('rejects saved scope changes, credentials and replacement expected revisions with extra fields', () => {
    for (const patch of [
      { workspaceId: OTHER },
      { taskId: OTHER },
      { headers: { authorization: 'secret' } },
      { request: { ...intent.request, scheduledAt: now } },
    ])
      expect(() =>
        parseManualRunIntent(
          JSON.stringify({ ...intent, ...patch }),
          intent.storageKey,
        ),
      ).toThrow();
    const foreignKey = manualRunStorageKey(
      [ORG, WORKSPACE, OTHER].join('/'),
      WORKSPACE,
      TASK,
    );
    expect(() =>
      parseManualRunIntent(
        JSON.stringify({ ...intent, storageKey: foreignKey }),
        intent.storageKey,
      ),
    ).toThrow();
  });
  it('accepts only the original request, revision, task, owner, org and workspace receipt', () => {
    const ok = receipt();
    expect(resolveManualRunReceipt(intent, ok).kind).toBe('accepted');
    for (const body of [
      { ...ok, source: 'native' },
      { ...ok, taskId: OTHER },
      { ...ok, request: { ...ok.request, requestId: OTHER } },
      { ...ok, request: { ...ok.request, expectedRevision: 4 } },
      ...['ownerId', 'organizationId', 'workspaceId'].flatMap((field) => [
        { ...ok, run: { ...ok.run, [field]: OTHER } },
        { ...ok, run: { ...ok.run, job: { ...ok.run.job, [field]: OTHER } } },
      ]),
    ])
      expect(() => resolveManualRunReceipt(intent, body)).toThrow();
  });
  it('keeps a lost ACK/not-found or unbound rejection unresolved; only a bound confirmed rejection ends the intent', () => {
    const s = new MemoryStorage();
    saveManualRunIntent(s, intent);
    for (const body of [
      { error: 'not_found' },
      { status: 'rejected' },
      { ...receipt(), status: 'unknown' },
    ])
      expect(() => resolveManualRunReceipt(intent, body)).toThrow();
    expect(s.getItem(intent.storageKey)).not.toBeNull();
    for (const code of [
      'request_conflict',
      'revision_conflict',
      'unavailable',
      'authority_denied',
      'content_limit',
    ]) {
      const body = {
        source: 'manual',
        status: 'rejected',
        taskId: TASK,
        request: intent.request,
        code,
        message: '本次未执行',
      };
      expect(resolveManualRunReceipt(intent, body)).toEqual({
        kind: 'rejected',
        message: '本次未执行',
      });
      expect(() =>
        resolveManualRunReceipt(intent, {
          ...body,
          request: { ...intent.request, expectedRevision: 4 },
        }),
      ).toThrow();
    }
  });
  it('does not let a late page clear a different saved manual request or revision', () => {
    for (const request of [
      { requestId: OTHER, expectedRevision: 3 },
      { requestId: REQUEST, expectedRevision: 4 },
    ]) {
      const s = new MemoryStorage();
      saveManualRunIntent(s, { ...intent, request });
      expect(() => clearManualRunIntent(s, intent)).toThrow();
      expect(s.getItem(intent.storageKey)).not.toBeNull();
    }
  });
});
