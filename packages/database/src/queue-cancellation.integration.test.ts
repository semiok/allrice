import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { closeDatabase } from './core/client.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { defaultAssistantRunConfiguration } from '@allrice/contracts';
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
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
    const [scope] = await database.db<
      { schema: string }[]
    >`select current_schema() schema`;
    const schema = scope!.schema;
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.searchParams.set('options', '-csearch_path=' + schema + ',public');
    vi.stubEnv('DATABASE_URL', url.href);
  }, 120000);
  afterAll(async () => {
    await closeDatabase();
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup() {
    const f = await assistantFixture(database.db);
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
    const callId = randomUUID();
    await f.runtime.prepareModelUsage({
      ...f.base,
      runId: f.task.runId,
      callId,
      requestedOutputTokens: 100,
    });
    await f.runtime.dispatchModelUsage({
      ...f.base,
      runId: f.task.runId,
      callId,
      inputTokens: 100,
      outputTokens: 100,
      requestDigest: 'sha256:' + 'a'.repeat(64),
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
    const settle = () =>
      f.runtime.settleUsage({
        ...f.base,
        callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 20,
          output_tokens: 7,
        },
      });
    const finish = () => finishJobDrain(f.worker);
    return { f, callId, row, cancel, heartbeat, settle, finish };
  }
  it.each(['heartbeat', 'maintenance'] as const)(
    '%s preserves late usage/stopped receipts, denies new admission and finalizes once',
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
        s.f.runtime.prepareModelUsage({
          ...s.f.base,
          runId: s.f.task.runId,
          callId: randomUUID(),
          requestedOutputTokens: 100,
        }),
      ).rejects.toThrow('lease_lost');
      await expect(s.settle()).resolves.toBeDefined();
      await expect(s.settle()).resolves.toBeDefined();
      await expect(
        s.f.runtime.settleUsage({
          ...s.f.base,
          callId: s.callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 21,
            output_tokens: 7,
          },
        }),
      ).rejects.toThrow('conflict');
      await expect(
        s.f.runtime.confirmStopped({ ...s.f.base, runId: s.f.task.runId }),
      ).resolves.toEqual({ stopped: true });
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
    await expect(s.settle()).rejects.toThrow('lease_lost');
    const [instance] =
      await database.db`select stopped_at,status from allrice_assistant_instances where run_id=${s.f.task.runId}`;
    expect(instance!.stopped_at).toBeNull();
    expect(instance!.status).toBe('cancel_requested');
    const admissions =
      await database.db`select finished_at from allrice_assistant_model_admissions where call_id=${s.callId}`;
    expect(admissions[0]!.finished_at).toBeNull();
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
    await expect(s.settle()).rejects.toThrow('lease_lost');
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
  it.each(['heartbeat', 'maintenance', 'authority'] as const)(
    'timeout stays failed after %s, cancellation and a refreshed deadline',
    async (trigger) => {
      const s = await setup();
      await database.db`update allrice_jobs set created_at=clock_timestamp()-interval '2 seconds',timeout_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
      if (trigger === 'heartbeat')
        expect(await s.heartbeat()).toMatchObject({
          active: false,
          canceled: false,
          draining: true,
        });
      else if (trigger === 'maintenance') await maintainQueue();
      else
        expect(
          await s.f.runtime.assertCurrentAuthority(s.f.base),
        ).toMatchObject({
          cancelRequested: true,
          stopReason: 'timeout',
          drainDeadlineAt: expect.any(String),
        });
      const first = await s.row();
      expect(first.drain_reason).toBe('timeout');
      expect(first.status).toBe('running');
      await database.db`update allrice_jobs set timeout_at=clock_timestamp()+interval '10 minutes' where id=${s.f.worker.jobId}`;
      await s.cancel();
      expect((await s.row()).drain_reason).toBe('timeout');
      await s.settle();
      await s.f.runtime.confirmStopped({ ...s.f.base, runId: s.f.task.runId });
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
    const f = await assistantFixture(database.db);
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
      await tx`delete from allrice_assistant_instances where root_run_id=${f.task.runId}`;
      await tx`delete from allrice_assistant_roots where root_run_id=${f.task.runId}`;
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
      // that configureRoot will need once creation commits.
      await database.db.begin(async (tx) => {
        await tx`select id from allrice_jobs where id=${f.worker.jobId} for update nowait`;
      });
      release();
      await heldRun;
      await creation;
      await cancellation;
      await expect(
        f.runtime.configureRoot({
          task: f.task,
          configuration: {
            ...defaultAssistantRunConfiguration(),
            allowAssistants: true,
          },
          nativeSessionId: f.nativeSessionId,
          worker: f.worker,
          allowedTools: ['read'],
        }),
      ).rejects.toThrow('canceled');
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
  it.each(['heartbeat', 'maintenance', 'authority'] as const)(
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
      await database.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy,phase,changed_at,started_at)
      values(${f.task.runId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${database.db.json({ ...policy })},'active',clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '2 seconds')`;
      await database.db.begin((tx) => refreshTaskClock(tx, f.task.runId));
      if (trigger === 'heartbeat')
        expect(await s.heartbeat()).toMatchObject({
          active: false,
          draining: true,
        });
      else if (trigger === 'maintenance') await maintainQueue();
      else
        expect(await f.runtime.assertCurrentAuthority(f.base)).toMatchObject({
          cancelRequested: true,
          stopReason: 'timeout',
        });
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
        f.runtime.prepareModelUsage({
          ...f.base,
          runId: f.task.runId,
          callId: randomUUID(),
          requestedOutputTokens: 100,
        }),
      ).rejects.toThrow('lease_lost');
      await s.settle();
      await f.runtime.confirmStopped({ ...f.base, runId: f.task.runId });
      await s.finish();
      const final = await s.row();
      expect(final.status).toBe('failed');
      expect(final.last_error_code).toBe('JOB_TIMEOUT');
    },
  );
});
