import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runtimeTaskFixture,
  createRuntimeFixtureDatabase,
} from './runtime.fixture.ts';
import { closeDatabase } from './core/client.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import type { ExecutionContext } from '@allrice/contracts';
import { createTaskProgressRuntime } from './task-progress.ts';
import { refreshTaskClock } from './task-clock.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import {
  cancelRun,
  completeJob,
  failJob,
  finishJobDrain,
  heartbeatJob,
  maintainQueue,
} from './execution/queue.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET193 original-incarnation receipt drain — isolated PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    database = await createRuntimeFixtureDatabase();
    const [scope] = await database.db<
      { schema: string }[]
    >`select current_schema() schema`;
    const schema = scope!.schema;
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.searchParams.set('options', '-csearch_path=' + schema);
    vi.stubEnv('DATABASE_URL', url.href);
  }, 120000);
  afterAll(async () => {
    await closeDatabase();
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup() {
    const f = await runtimeTaskFixture(database.db);
    f.context.memberships = (
      await database.db`select * from allrice_memberships where user_id=${f.context.actor.id}`
    ).map((m) => ({
      id: m.id,
      userId: m.user_id,
      organizationId: m.organization_id,
      workspaceId: m.workspace_id,
      role: m.role,
      active: m.active,
    }));
    await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.task.runId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    const progress = createTaskProgressRuntime(
      {
        context: {
          runId: f.task.runId,
          organizationId: f.task.scope.organizationId,
          workspaceId: f.task.scope.workspaceId,
          delegatedBy: f.context.actor,
        } as ExecutionContext,
        worker: f.worker,
      },
      f.db,
    );
    const callId = randomUUID();
    const receipt = {
      action: 'finish',
      nativeSessionId: f.nativeSessionId,
      callId,
      kind: 'model',
      resultDigest: 'sha256:' + 'a'.repeat(64),
      outcome: 'success',
    };
    await progress({
      action: 'start',
      nativeSessionId: f.nativeSessionId,
      callId,
      kind: 'model',
    });
    const row = async () =>
      (
        await database.db`select * from allrice_jobs where id=${f.worker.jobId}`
      )[0]!;
    const cancel = () =>
      cancelRun(f.context, f.context.workspaceId!, f.task.runId, {
        reason: 'user_requested',
      });
    const heartbeat = () =>
      heartbeatJob(
        f.worker.workerId,
        f.worker.jobId,
        f.worker.leaseToken,
        30000,
      );
    const settle = () => progress(receipt);
    const finish = () => finishJobDrain(f.worker);
    return {
      f,
      callId,
      receipt,
      progress,
      row,
      cancel,
      heartbeat,
      settle,
      finish,
    };
  }
  it.each(['heartbeat', 'maintenance'] as const)(
    '%s preserves existing-call receipts, denies new admission and finalizes once',
    async (trigger) => {
      const s = await setup();
      await s.cancel();
      const before = await s.row();
      if (trigger === 'heartbeat')
        expect(await s.heartbeat()).toMatchObject({
          active: false,
          canceled: true,
          draining: true,
        });
      else await maintainQueue();
      const current = await s.row();
      expect(current.status).toBe('running');
      expect(current.lease_token).toBe(s.f.worker.leaseToken);
      expect(current.drain_deadline_at).toEqual(before.drain_deadline_at);
      await expect(
        s.progress({
          action: 'start',
          nativeSessionId: s.f.nativeSessionId,
          callId: randomUUID(),
          kind: 'model',
        }),
      ).rejects.toThrow('task_progress_lease_lost');
      await expect(s.settle()).resolves.toBeDefined();
      await expect(s.settle()).resolves.toBeDefined();
      await expect(
        s.progress({ ...s.receipt, resultDigest: 'sha256:' + 'b'.repeat(64) }),
      ).rejects.toThrow('task_progress_receipt_conflict');
      const [receipt] =
        await database.db`select finished_at,result_digest,settled_output_tokens from allrice_task_calls where run_id=${s.f.task.runId} and call_id=${s.callId}`;
      expect(receipt).toMatchObject({
        finished_at: expect.any(Date),
        result_digest: s.receipt.resultDigest,
        settled_output_tokens: null,
      });
      await expect(s.finish()).resolves.toEqual({ finalized: true });
      expect((await s.row()).status).toBe('canceled');
      await expect(s.finish()).rejects.toThrow('lease_lost');
      const events =
        await database.db`select id from allrice_run_events where run_id=${s.f.task.runId} and event_type in ('run.canceled','run.failed','run.succeeded')`;
      expect(events).toHaveLength(1);
    },
    120000,
  );
  it('repeated cancellation, heartbeat and maintenance never slide the absolute deadline', async () => {
    const s = await setup();
    await s.cancel();
    const first = await s.row();
    await Promise.all([s.cancel(), s.heartbeat(), maintainQueue()]);
    const next = await s.row();
    expect(next.drain_deadline_at).toEqual(first.drain_deadline_at);
    expect(next.lease_expires_at.getTime()).toBeLessThanOrEqual(
      first.drain_deadline_at.getTime(),
    );
    await s.finish();
  });
  it('an expired window finalizes without fabricating usage or a native stopped ACK', async () => {
    const s = await setup();
    await s.cancel();
    await database.db`update allrice_jobs set drain_deadline_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
    await maintainQueue();
    expect((await s.row()).status).toBe('canceled');
    await expect(s.settle()).rejects.toThrow('task_progress_lease_lost');
    const [call] =
      await database.db`select finished_at,settled_output_tokens from allrice_task_calls where run_id=${s.f.task.runId} and call_id=${s.callId}`;
    expect(call).toEqual({ finished_at: null, settled_output_tokens: null });
    expect(
      await database.db`select id from allrice_run_events where run_id=${s.f.task.runId} and event_type='harness.native'`,
    ).toHaveLength(0);
  });
  it('an already expired lease is never revived, even before the drain deadline', async () => {
    const s = await setup();
    await s.cancel();
    await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
    await expect(s.heartbeat()).rejects.toThrow('lease_lost');
    await maintainQueue();
    expect((await s.row()).status).toBe('canceled');
  });
  it('a replaced Worker cannot submit receipts or finalize the old incarnation', async () => {
    const s = await setup();
    await s.cancel();
    await database.db`update allrice_jobs set worker_id=${randomUUID()},lease_token=${randomUUID()} where id=${s.f.worker.jobId}`;
    await expect(s.settle()).rejects.toThrow('task_progress_lease_lost');
    await expect(s.finish()).rejects.toThrow('lease_lost');
    await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
    await maintainQueue();
    expect((await s.row()).status).toBe('canceled');
  });
  it.each(['complete', 'fail'] as const)(
    'cancellation wins the %s race and cannot retry',
    async (end) => {
      const s = await setup();
      await s.cancel();
      if (end === 'complete')
        await completeJob({ ...s.f.worker, result: { answer: 'late' } });
      else
        await failJob({
          ...s.f.worker,
          code: 'HANDLER_FAILED',
          message: 'late',
          retryable: true,
        });
      expect((await s.row()).status).toBe('canceled');
    },
  );
  it('a blocked receipt heartbeat rolls back within its database lock budget', async () => {
    const s = await setup();
    await s.cancel();
    const original = await s.row();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const blocker = database.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${s.f.task.runId},703))`;
      entered();
      await gate;
    });
    await ready;
    try {
      await expect(s.heartbeat()).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release();
      await blocker;
    }
    const after = await s.row();
    expect(after.drain_deadline_at).toEqual(original.drain_deadline_at);
    expect(after.lease_token).toBe(original.lease_token);
    await s.finish();
  }, 15000);
  it.each(['heartbeat', 'maintenance'] as const)(
    'timeout stays failed after %s, cancellation and a refreshed deadline',
    async (trigger) => {
      const s = await setup();
      await database.db`update allrice_task_clocks set phase='active',active_ms=(policy->>'timeoutMs')::double precision+1,changed_at=clock_timestamp() where run_id=${s.f.task.runId}`;
      // Maintenance scans the persisted job deadline before opening its
      // transaction, so publish this elapsed checkpoint through the real clock.
      await database.db.begin((tx) => refreshTaskClock(tx, s.f.task.runId));
      if (trigger === 'heartbeat')
        expect(await s.heartbeat()).toMatchObject({
          active: false,
          canceled: false,
          draining: true,
        });
      else if (trigger === 'maintenance') await maintainQueue();
      const first = await s.row();
      expect(first.drain_reason).toBe('timeout');
      expect(first.status).toBe('running');
      await database.db`update allrice_jobs set timeout_at=clock_timestamp()+interval '10 minutes' where id=${s.f.worker.jobId}`;
      await s.cancel();
      expect((await s.row()).drain_reason).toBe('timeout');
      await s.settle();
      await completeJob({ ...s.f.worker, result: { answer: 'too late' } });
      const final = await s.row();
      expect(final.status).toBe('failed');
      expect(final.last_error_code).toBe('JOB_TIMEOUT');
    },
  );
  it.each(['queued', 'claimed'] as const)(
    '%s cancellation has no artificial receipt window',
    async (status) => {
      const s = await setup();
      if (status === 'queued')
        await database.db`update allrice_jobs set status='queued',worker_id=null,lease_token=null,lease_expires_at=null,claimed_at=null,heartbeat_at=null where id=${s.f.worker.jobId}`;
      else
        await database.db`update allrice_jobs set status='claimed' where id=${s.f.worker.jobId}`;
      await s.cancel();
      expect((await s.row()).drain_deadline_at).toBeNull();
      await maintainQueue();
      expect((await s.row()).status).toBe('canceled');
    },
  );
  it.each(['complete', 'fail'] as const)(
    'concurrent cancellation and %s produce one consistent terminal event',
    async (ending) => {
      const s = await setup();
      const [cancel] = await Promise.allSettled([
        s.cancel(),
        ending === 'complete'
          ? completeJob({ ...s.f.worker, result: { answer: 'synthetic' } })
          : failJob({
              ...s.f.worker,
              code: 'HANDLER_FAILED',
              message: 'synthetic',
              retryable: false,
            }),
      ]);
      const job = await s.row();
      if (cancel.status === 'fulfilled') expect(job.status).toBe('canceled');
      else
        expect(job.status).toBe(ending === 'complete' ? 'succeeded' : 'failed');
      expect(
        await database.db`select id from allrice_run_events where run_id=${s.f.task.runId} and event_type in ('run.succeeded','run.failed','run.canceled')`,
      ).toHaveLength(1);
    },
  );
  it('root creation and cancellation serialize before taking job locks, including before the root exists', async () => {
    const f = await runtimeTaskFixture(database.db);
    f.context.memberships = (
      await database.db`select * from allrice_memberships where user_id=${f.context.actor.id}`
    ).map((m) => ({
      id: m.id,
      userId: m.user_id,
      organizationId: m.organization_id,
      workspaceId: m.workspace_id,
      role: m.role,
      active: m.active,
    }));
    // Remove only this new empty synthetic root, in the existing FK order;
    // no native/model dispatch or company data has ever been attached.
    await database.db.begin(async (tx) => {
      await tx`delete from allrice_runtime_budgets where root_run_id=${f.task.runId}`;
      await tx`delete from allrice_runtime_run_links where root_run_id=${f.task.runId}`;
      await tx`delete from allrice_runtime_roots where root_run_id=${f.task.runId}`;
    });
    const ledger = createRuntimeOperationLedger({
      database: database.db,
      admission: async () => {
        throw Error('unused');
      },
    });
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const heldRun = database.db.begin(async (tx) => {
      await tx`select id from allrice_runs where id=${f.task.runId} for update`;
      entered();
      await barrier;
    });
    await ready;
    const creation = ledger.createRoot({
      task: f.task,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      budgets: [
        {
          metric: 'model_calls',
          unit: 'calls',
          capacity: 12,
          currency: null,
          source: { kind: 'worker', sourceId: 'fixture-recreate' },
        },
      ],
    });
    let cancellation: Promise<unknown> | undefined;
    try {
      await expect
        .poll(
          async () =>
            database.db.begin(
              async (tx) =>
                (
                  await tx`select pg_try_advisory_xact_lock(hashtextextended(${f.task.runId},703)) available`
                )[0]!.available,
            ),
          { timeout: 5000 },
        )
        .toBe(false);
      cancellation = cancelRun(
        f.context,
        f.context.workspaceId!,
        f.task.runId,
        { reason: 'user_requested' },
      );
      await expect
        .poll(
          async () =>
            Number(
              (
                await database.db`select count(*) n from pg_locks where locktype='advisory' and not granted
        and classid=((hashtextextended(${f.task.runId},703)>>32)&4294967295)::oid
        and objid=(hashtextextended(${f.task.runId},703)&4294967295)::oid`
              )[0]!.n,
            ),
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
      // Cancellation is waiting on the pre-root mutex, not holding the job
      // that the queue will need once creation commits.
      await database.db.begin(async (tx) => {
        await tx`select id from allrice_jobs where id=${f.worker.jobId} for update nowait`;
      });
      release();
      await heldRun;
      await creation;
      await cancellation;
      await expect(
        heartbeatJob(
          f.worker.workerId,
          f.worker.jobId,
          f.worker.leaseToken,
          30000,
        ),
      ).resolves.toMatchObject({
        active: false,
        canceled: true,
        draining: true,
      });
      const [root] =
        await database.db`select cancel_requested_at from allrice_runtime_roots where root_run_id=${f.task.runId}`;
      expect(root!.cancel_requested_at).not.toBeNull();
      await finishJobDrain(f.worker);
    } finally {
      release();
      await heldRun;
      await Promise.allSettled([
        creation,
        ...(cancellation ? [cancellation] : []),
      ]);
    }
  }, 120000);
  it.each(['heartbeat', 'maintenance'] as const)(
    'durable active-time projection reaches %s without reopening its receipt deadline',
    async (trigger) => {
      const s = await setup(),
        f = s.f;
      const policy = resolveTaskRuntimePolicy([
        { scope: 'user', scopeId: f.context.actor.id, timeoutMs: 1000 },
      ]);
      await database.db`update allrice_jobs set created_at=clock_timestamp()-interval '10 seconds' where id=${f.worker.jobId}`;
      // Existing clock-test technique: advance only this isolated persisted
      // checkpoint, then execute the actual production projection on DB time.
      await database.db`update allrice_task_clocks set policy=${database.db.json({ ...policy })},phase='active',changed_at=clock_timestamp()-interval '2 seconds',started_at=clock_timestamp()-interval '2 seconds' where run_id=${f.task.runId}`;
      await database.db.begin((tx) => refreshTaskClock(tx, f.task.runId));
      if (trigger === 'heartbeat')
        expect(await s.heartbeat()).toMatchObject({
          active: false,
          draining: true,
        });
      else if (trigger === 'maintenance') await maintainQueue();
      const first = await s.row();
      expect(first.drain_reason).toBe('timeout');
      expect(first.status).toBe('running');
      await database.db.begin((tx) => refreshTaskClock(tx, f.task.runId));
      await s.heartbeat();
      await maintainQueue();
      expect((await s.row()).drain_deadline_at).toEqual(
        first.drain_deadline_at,
      );
      await expect(
        s.progress({
          action: 'start',
          nativeSessionId: f.nativeSessionId,
          callId: randomUUID(),
          kind: 'model',
        }),
      ).rejects.toThrow('task_progress_lease_lost');
      await s.settle();
      await s.finish();
      const final = await s.row();
      expect(final.status).toBe('failed');
      expect(final.last_error_code).toBe('JOB_TIMEOUT');
    },
  );
});
