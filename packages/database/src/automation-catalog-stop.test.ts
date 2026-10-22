import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext, RunSnapshot } from '@allrice/contracts';
const f = vi.hoisted(() => ({
  db: vi.fn(),
  principal: vi.fn(),
  getRun: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('./core/client.ts', () => ({ getDatabase: f.db }));
vi.mock('./content-maintenance.ts', () => ({
  readContentPrincipal: f.principal,
}));
vi.mock('./execution/queue.ts', () => ({
  getRun: f.getRun,
  requestRunCancellationTransaction: f.cancel,
  QueueError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('./data.ts', () => ({
  DataAccessError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('./execution/automation.ts', () => ({ nextScheduleAt: vi.fn() }));
vi.mock('./dev-maintenance.ts', () => ({ acquireDevAdmission: vi.fn() }));
vi.mock('./native-schedule-authority.ts', () => ({
  lockSchedulePrincipal: vi.fn(),
}));
vi.mock('./work-automation.ts', () => ({ readWorkAutomation: vi.fn() }));
vi.mock('./native-schedule-recurring-product.ts', () => ({
  nativeRecurringProductEnabled: vi.fn(),
  readRecurringTaskProjection: vi.fn(),
  readRecurringOccurrenceRows: vi.fn(),
  recurringOccurrenceProjection: vi.fn(),
  changeRecurringTask: vi.fn(),
  getRecurringTask: vi.fn(),
}));
vi.mock('./native-schedule-once-product.ts', () => ({
  readOnceTaskProjection: vi.fn(),
  cancelOnceTask: vi.fn(),
}));
vi.mock('./native-schedule-once-state.ts', () => ({
  nativeOnceReady: vi.fn(),
}));
import {
  getAutomationCatalogOccurrenceRun,
  stopAutomationCatalogOccurrence,
} from './automation-catalog.ts';
import { QueueError } from './execution/queue.ts';

const ORG = '11111111-1111-4111-8111-111111111111',
  WORKSPACE = '22222222-2222-4222-8222-222222222222',
  OWNER = '33333333-3333-4333-8333-333333333333',
  TASK = '44444444-4444-4444-8444-444444444444',
  OCCURRENCE = '55555555-5555-4555-8555-555555555555',
  RUN = '66666666-6666-4666-8666-666666666666';
const context: RequestContext = {
  requestId: TASK,
  sessionId: OCCURRENCE,
  actor: { type: 'user', id: OWNER },
  organizationId: ORG,
  workspaceId: WORKSPACE,
  memberships: [],
  authenticatedAt: '2026-10-22T01:00:00.000Z',
};
const input = { occurrenceId: OCCURRENCE, runId: RUN };
let binding: {
  state: RunSnapshot['status'];
  job_status: RunSnapshot['job']['status'];
  cancel_requested_at: Date | null;
} | null;
let availablePlan: boolean;
let snapshot: RunSnapshot;
function tx(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  const query = strings.join('?').trim();
  if (query.startsWith('select a.*'))
    return Promise.resolve(
      availablePlan ? [{ id: TASK, clock_owner: 'native_recurring' }] : [],
    );
  if (query.startsWith('select r.state'))
    return Promise.resolve(binding ? [binding] : []);
  // Nested tagged fragments are values, not executable statements in this fake.
  return { strings, values };
}
beforeEach(() => {
  vi.clearAllMocks();
  availablePlan = true;
  binding = {
    state: 'running',
    job_status: 'running',
    cancel_requested_at: null,
  };
  snapshot = {
    id: RUN,
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    status: 'running',
    job: { status: 'running' },
    cancelRequestedAt: null,
  } as RunSnapshot;
  f.db.mockReturnValue({
    begin: (run: (transaction: typeof tx) => unknown) => run(tx),
  });
  f.principal.mockResolvedValue({ writable: true });
  f.getRun.mockImplementation(async () => snapshot);
  f.cancel.mockResolvedValue(undefined);
});
describe('catalog stop orchestration around the ordinary cancellation transaction', () => {
  it('holds the current write principal and forwards the original exact Run to the normal cancellation chain', async () => {
    await stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input);
    expect(f.principal).toHaveBeenCalledWith(context, tx, true);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(
      tx,
      context,
      RUN,
      'user_requested',
    );
    expect(f.getRun).toHaveBeenCalledExactlyOnceWith(context, WORKSPACE, RUN);
  });
  it('does not broaden the current catalog or allow read-only membership to stop a Run', async () => {
    f.principal.mockResolvedValue({ writable: false });
    await expect(
      stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.cancel).not.toHaveBeenCalled();
    expect(
      (await getAutomationCatalogOccurrenceRun(context, WORKSPACE, TASK, input))
        .canStop,
    ).toBe(false);
    availablePlan = false;
    f.principal.mockResolvedValue({ writable: true });
    await expect(
      stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input),
    ).rejects.toMatchObject({ code: 'not_found' });
    availablePlan = true;
    binding = null;
    await expect(
      stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('requires an explicit exact target and rejects extra scope or plan mutation fields before database access', async () => {
    for (const raw of [
      { runId: RUN },
      { ...input, latest: true },
      { ...input, action: 'pause' },
      { ...input, ownerId: OWNER },
    ])
      await expect(
        stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, raw),
      ).rejects.toThrow();
    await expect(
      stopAutomationCatalogOccurrence(
        { ...context, workspaceId: ORG },
        WORKSPACE,
        TASK,
        input,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(f.principal).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('preserves terminal results and repeated durable stop requests without entering the writer', async () => {
    for (const state of ['succeeded', 'failed', 'canceled'] as const) {
      binding = { state, job_status: state, cancel_requested_at: null };
      snapshot = {
        ...snapshot,
        status: state,
        job: { ...snapshot.job, status: state },
        result: { original: state },
      };
      expect(
        (await stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input))
          .run,
      ).toEqual(snapshot);
    }
    binding = {
      state: 'running',
      job_status: 'running',
      cancel_requested_at: new Date(),
    };
    await stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('only reads the original Run when completion wins the cancellation conflict', async () => {
    f.cancel.mockImplementationOnce(async () => {
      snapshot = {
        ...snapshot,
        status: 'succeeded',
        job: { ...snapshot.job, status: 'succeeded' },
        result: { original: true },
      };
      throw new QueueError('conflict');
    });
    const receipt = await stopAutomationCatalogOccurrence(
      context,
      WORKSPACE,
      TASK,
      input,
    );
    expect(receipt.run.result).toEqual({ original: true });
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.getRun).toHaveBeenCalledExactlyOnceWith(context, WORKSPACE, RUN);
  });
  it('never retries an unknown commit or a conflict whose original Run is still active', async () => {
    f.cancel.mockRejectedValueOnce(new Error('connection_lost'));
    await expect(
      stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input),
    ).rejects.toThrow('connection_lost');
    expect(f.getRun).not.toHaveBeenCalled();
    f.cancel.mockRejectedValueOnce(new QueueError('conflict'));
    await expect(
      stopAutomationCatalogOccurrence(context, WORKSPACE, TASK, input),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.cancel).toHaveBeenCalledTimes(2);
  });
});
