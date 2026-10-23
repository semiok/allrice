import { describe, expect, it } from 'vitest';
import type { RunSnapshot } from '@allrice/contracts';
import {
  clearStopOccurrenceIntent,
  parseStopOccurrenceIntent,
  resolveStopOccurrenceReceipt,
  saveStopOccurrenceIntent,
  stopOccurrenceStorageKey,
  stopOccurrenceURL,
  type StopOccurrenceIntent,
} from './stop-occurrence-intent';

const ORG = '11111111-1111-4111-8111-111111111111',
  WORKSPACE = '22222222-2222-4222-8222-222222222222',
  OWNER = '33333333-3333-4333-8333-333333333333',
  TASK = '44444444-4444-4444-8444-444444444444',
  OCCURRENCE = '55555555-5555-4555-8555-555555555555',
  RUN = '66666666-6666-4666-8666-666666666666',
  OTHER = '77777777-7777-4777-8777-777777777777';
const intent: StopOccurrenceIntent = {
  version: 1,
  storageKey: stopOccurrenceStorageKey(
    [ORG, WORKSPACE, OWNER].join('/'),
    WORKSPACE,
    TASK,
  ),
  workspaceId: WORKSPACE,
  taskId: TASK,
  occurrenceId: OCCURRENCE,
  runId: RUN,
};
const now = '2026-10-22T01:00:00.000Z';
function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN,
    organizationId: ORG,
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    status: 'running',
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
      status: 'running',
      idempotencyKey: 'original-occurrence',
      priority: 0,
      attempt: 1,
      maxAttempts: 1,
      availableAt: now,
      timeoutAt: now,
      payload: { schemaVersion: 1, type: 'employee.chat', input: {} },
      lease: null,
    },
    ...overrides,
  };
}
function receipt(snapshot = run()) {
  return {
    taskId: TASK,
    occurrenceId: OCCURRENCE,
    run: snapshot,
    canStop: true,
  };
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

describe('exact occurrence stop identity and uncertain acknowledgement', () => {
  it('persists one scoped target before sending and restores only that target', () => {
    const storage = new MemoryStorage();
    saveStopOccurrenceIntent(storage, intent);
    expect(
      parseStopOccurrenceIntent(
        storage.getItem(intent.storageKey)!,
        intent.storageKey,
      ),
    ).toEqual(intent);
    expect(() =>
      saveStopOccurrenceIntent(storage, { ...intent, runId: OTHER }),
    ).toThrow();
    const url = new URL(stopOccurrenceURL(intent, true), 'https://fixture');
    expect(url.pathname).toBe(
      `/api/v1/scheduled-tasks/${TASK}/stop-occurrence`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspaceId: WORKSPACE,
      occurrenceId: OCCURRENCE,
      runId: RUN,
    });
    expect(stopOccurrenceURL(intent)).not.toContain('runId=');
  });
  it('does not permit changing viewer, workspace, task or adding secret headers to saved state', () => {
    for (const patch of [
      {
        storageKey: stopOccurrenceStorageKey(
          [ORG, WORKSPACE, OTHER].join('/'),
          WORKSPACE,
          TASK,
        ),
      },
      { workspaceId: OTHER },
      { taskId: OTHER },
      { headers: { authorization: 'never-persist' } },
    ])
      expect(() =>
        parseStopOccurrenceIntent(
          JSON.stringify({ ...intent, ...patch }),
          intent.storageKey,
        ),
      ).toThrow();
    expect(() =>
      stopOccurrenceStorageKey([ORG, WORKSPACE, OWNER].join('/'), OTHER, TASK),
    ).toThrow();
  });
  it('fails closed when durable local persistence is unavailable', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {};
    expect(() => saveStopOccurrenceIntent(storage, intent)).toThrow('未发送');
  });
  it('rejects readback for another plan, occurrence, Run, owner or workspace', () => {
    for (const body of [
      { ...receipt(), taskId: OTHER },
      { ...receipt(), occurrenceId: OTHER },
      receipt(run({ id: OTHER })),
      receipt(run({ ownerId: OTHER })),
      receipt(run({ workspaceId: OTHER })),
      receipt(run({ organizationId: OTHER })),
      receipt(run({ job: { ...run().job, ownerId: OTHER } })),
    ])
      expect(() => resolveStopOccurrenceReceipt(intent, body)).toThrow();
  });
  it('keeps a lost POST acknowledgement unresolved when the exact Run still has no cancel receipt', () => {
    const storage = new MemoryStorage();
    saveStopOccurrenceIntent(storage, intent);
    expect(resolveStopOccurrenceReceipt(intent, receipt()).state).toBe(
      'unconfirmed',
    );
    expect(storage.getItem(intent.storageKey)).not.toBeNull();
    expect(() => saveStopOccurrenceIntent(storage, intent)).toThrow();
  });
  it('distinguishes a durable cancel request from actual terminal outcome', () => {
    expect(
      resolveStopOccurrenceReceipt(
        intent,
        receipt(run({ cancelRequestedAt: now })),
      ).state,
    ).toBe('stopping');
    for (const status of ['succeeded', 'failed', 'canceled'] as const) {
      const snapshot = run({
        status,
        result: { original: true },
        job: { ...run().job, status },
      });
      expect(resolveStopOccurrenceReceipt(intent, receipt(snapshot))).toEqual({
        state: 'terminal',
        run: snapshot,
      });
    }
    expect(
      resolveStopOccurrenceReceipt(
        intent,
        receipt(
          run({
            status: 'needs_attention',
            job: { ...run().job, status: 'dead_letter' },
          }),
        ),
      ).state,
    ).toBe('terminal');
  });
  it('does not clear another exact Run when an earlier page finishes late', () => {
    const storage = new MemoryStorage();
    saveStopOccurrenceIntent(storage, { ...intent, runId: OTHER });
    expect(() => clearStopOccurrenceIntent(storage, intent)).toThrow();
    expect(storage.getItem(intent.storageKey)).not.toBeNull();
    clearStopOccurrenceIntent(storage, { ...intent, runId: OTHER });
    expect(storage.getItem(intent.storageKey)).toBeNull();
  });
  it('retains explicit manual identity on a native parent and refuses a native/omitted-source readback', () => {
    const manual = { ...intent, source: 'manual' as const };
    const storage = new MemoryStorage();
    saveStopOccurrenceIntent(storage, manual);
    expect(
      new URL(
        stopOccurrenceURL(manual, true),
        'https://fixture',
      ).searchParams.get('source'),
    ).toBe('manual');
    expect(() => resolveStopOccurrenceReceipt(manual, receipt())).toThrow();
    expect(() =>
      resolveStopOccurrenceReceipt(manual, {
        ...receipt(),
        source: 'native_occurrence',
      }),
    ).toThrow();
    expect(
      resolveStopOccurrenceReceipt(manual, { ...receipt(), source: 'manual' })
        .state,
    ).toBe('unconfirmed');
    expect(() => clearStopOccurrenceIntent(storage, intent)).toThrow();
    clearStopOccurrenceIntent(storage, manual);
  });
});
