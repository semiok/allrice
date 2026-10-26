/** MET-210 #4: a second real connection holds the run's runtime-root row or
 * its 703 advisory lock past the 5 s lock_timeout, while the production
 * heartbeat, event write, cancellation poll and usage settlement compete.
 * Isolated schema only; elapsed time is real (no clock mocking). */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import * as client from './core/client.ts';
import {
  appendJobEvent,
  completeJob,
  heartbeatJob,
  maintainQueue,
  requestEmployeeAccessCancellationTransaction,
} from './execution/queue.ts';
import { readTaskClock, refreshTaskClock } from './task-clock.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
import {
  defaultTaskRuntimeMs,
  resolveTaskRuntimePolicy,
} from './task-runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failureTag = '[MET-210] Worker lease transaction rolled back';

suite('MET-210 Worker lease transactions under a held root lock', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.close();
  });

  /** A Worker-shaped job: 30 s lease and an enrolled task clock, so the
   * heartbeat really takes 703 -> root -> clock -> job like production. */
  async function setup(leaseSeconds = 30) {
    const f = await assistantFixture(database.db);
    const { organizationId, workspaceId } = f.task.scope;
    await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.task.runId},${organizationId},${workspaceId},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    await f.db.begin((tx) => refreshTaskClock(tx, f.task.runId));
    await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>${leaseSeconds}) where id=${f.worker.jobId}`;
    const job = async () =>
      (await f.db`select * from allrice_jobs where id=${f.worker.jobId}`)[0]!;
    const heartbeat = () =>
      heartbeatJob(
        f.worker.workerId,
        f.worker.jobId,
        f.worker.leaseToken,
        30_000,
      );
    const event = (label: string) =>
      appendJobEvent({
        ...f.worker,
        type: 'step.started',
        payload: { handler: 'met-210-lock-test', label },
      });
    const events = async () =>
      f.db<{ sequence: number; label: string | null }[]>`
        select sequence,payload->>'label' label from allrice_run_events
        where run_id=${f.task.runId} order by sequence`;
    return { f, job, heartbeat, event, events };
  }

  /** The competing transaction. `commit(work)` runs `work` inside it first. */
  async function hold(kind: 'root' | '703', runId: string) {
    let finish!: (
      work?: (tx: postgres.TransactionSql) => Promise<unknown>,
    ) => void;
    const gate = new Promise<
      ((tx: postgres.TransactionSql) => Promise<unknown>) | undefined
    >((resolve) => {
      finish = resolve;
    });
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const done = database.db.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      if (kind === 'root')
        await tx`select root_run_id from allrice_runtime_roots where root_run_id=${runId} for update`;
      else
        await tx`select pg_advisory_xact_lock(hashtextextended(${runId},703))`;
      ready(row!.pid);
      const work = await gate;
      await work?.(tx);
    });
    const pid = await locked;
    return {
      pid,
      async waiters(count = 1) {
        await expect
          .poll(
            async () => {
              const [row] = await database.db<{ n: number }[]>`
                select count(*)::int n from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`;
              return row!.n;
            },
            { timeout: 5_000, interval: 25 },
          )
          .toBeGreaterThanOrEqual(count);
      },
      async commit(work?: (tx: postgres.TransactionSql) => Promise<unknown>) {
        finish(work);
        await done;
      },
    };
  }

  function failures(site: string) {
    const calls = [
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ];
    return calls
      .filter(([tag, record]) => tag === failureTag && record.site === site)
      .map(([, record]) => record as Record<string, unknown>);
  }
  function watchFailures() {
    vi.spyOn(console, 'warn')
      .mockImplementation(() => {})
      .mockClear();
    vi.spyOn(console, 'error')
      .mockImplementation(() => {})
      .mockClear();
  }
  const recordKeys = [
    'attempt',
    'backendPid',
    'connectionMs',
    'durationMs',
    'jobId',
    'outcome',
    'processCount',
    'runId',
    'site',
    'sqlState',
  ];

  it.each(['root', '703'] as const)(
    'a heartbeat waits out a %s lock held past lock_timeout and renews the same lease',
    async (kind) => {
      watchFailures();
      const s = await setup();
      const before = await s.job();
      const held = await hold(kind, s.f.task.runId);
      const beat = s.heartbeat();
      beat.catch(() => {});
      await held.waiters();
      await sleep(6_000);
      await held.commit();
      await expect(beat).resolves.toEqual({ active: true, canceled: false });
      const after = await s.job();
      expect(after).toMatchObject({
        status: 'running',
        attempt: before.attempt,
        worker_id: s.f.worker.workerId,
        lease_token: s.f.worker.leaseToken,
      });
      expect(after.heartbeat_at.getTime()).toBeGreaterThan(
        before.heartbeat_at.getTime(),
      );
      expect(after.lease_expires_at.getTime()).toBeGreaterThan(
        before.lease_expires_at.getTime(),
      );
      const records = failures('job_heartbeat');
      expect(records[0]).toMatchObject({
        sqlState: '55P03',
        outcome: 'retrying',
        attempt: 1,
        runId: s.f.task.runId,
        jobId: s.f.worker.jobId,
        backendPid: expect.any(Number),
      });
      expect(records[0]!.durationMs).toBeGreaterThanOrEqual(4_900);
      // IDs, codes and timings only: no SQL, parameters or messages.
      expect(Object.keys(records[0]!).sort()).toEqual(recordKeys);
    },
    30_000,
  );

  it.each(['root', '703'] as const)(
    'an event write waits out a %s lock held past lock_timeout and lands once, in order',
    async (kind) => {
      watchFailures();
      const s = await setup();
      await s.event('before');
      const held = await hold(kind, s.f.task.runId);
      const write = s.event('contended');
      write.catch(() => {});
      await held.waiters();
      await sleep(6_000);
      await held.commit();
      await write;
      await s.event('after');
      const events = await s.events();
      expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i));
      expect(events.filter((e) => e.label).map((e) => e.label)).toEqual([
        'before',
        'contended',
        'after',
      ]);
      expect(failures('job_event')[0]).toMatchObject({
        sqlState: '55P03',
        outcome: 'retrying',
        runId: s.f.task.runId,
      });
    },
    30_000,
  );

  it.each([
    ['released after expiry, before lock_timeout', 4_000],
    ['held past lock_timeout', 6_000],
  ])(
    'a lock wait never renews an expired lease (%s); the old Worker can no longer write',
    async (_case, holdMs) => {
      watchFailures();
      const s = await setup(3);
      const before = await s.job();
      const held = await hold('root', s.f.task.runId);
      const beat = s.heartbeat();
      beat.catch(() => {});
      await held.waiters();
      await sleep(holdMs);
      await held.commit();
      await expect(beat).rejects.toMatchObject({ code: 'lease_lost' });
      const after = await s.job();
      expect(after.lease_expires_at).toEqual(before.lease_expires_at);
      expect(after.heartbeat_at).toEqual(before.heartbeat_at);
      await expect(s.event('late')).rejects.toMatchObject({
        code: 'lease_lost',
      });
      await expect(
        completeJob({ ...s.f.worker, result: { answer: 'late' } }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      await maintainQueue();
      const recovered = await s.job();
      expect(recovered.lease_token).not.toBe(s.f.worker.leaseToken);
      await expect(s.heartbeat()).rejects.toMatchObject({
        code: 'lease_lost',
      });
    },
    30_000,
  );

  it('retries never outwait the lease they found', async () => {
    watchFailures();
    const s = await setup(8);
    const before = await s.job();
    const held = await hold('703', s.f.task.runId);
    const started = Date.now();
    const beat = s.heartbeat();
    beat.catch(() => {});
    await held.waiters();
    try {
      await expect(beat).rejects.toMatchObject({ code: '55P03' });
      // Lease end minus the 1.5 s reserve; the lease itself ends at 8 s.
      expect(Date.now() - started).toBeLessThan(7_500);
    } finally {
      await held.commit();
    }
    expect((await s.job()).lease_expires_at).toEqual(before.lease_expires_at);
    expect(
      failures('job_heartbeat').map((r) => [r.attempt, r.outcome]),
    ).toEqual([
      [1, 'retrying'],
      [2, 'exhausted'],
    ]);
  }, 30_000);

  it('a task deadline reached during the wait ends the retries without renewing', async () => {
    watchFailures();
    const s = await setup();
    // Active time leaves 3 s; the stored job/root deadline follow the clock.
    await s.f
      .db`update allrice_task_clocks set phase='active',active_ms=${defaultTaskRuntimeMs - 3_000},changed_at=clock_timestamp() where run_id=${s.f.task.runId}`;
    await s.f.db.begin((tx) => refreshTaskClock(tx, s.f.task.runId));
    const before = await s.job();
    const held = await hold('703', s.f.task.runId);
    const beat = s.heartbeat();
    beat.catch(() => {});
    await held.waiters();
    await sleep(6_000);
    await held.commit();
    await expect(beat).rejects.toMatchObject({ code: '55P03' });
    expect((await s.job()).lease_expires_at).toEqual(before.lease_expires_at);
    expect(failures('job_heartbeat')).toMatchObject([
      { attempt: 1, outcome: 'stopped' },
    ]);
  }, 30_000);

  it('an access revocation committed with the lock release is honored by the retried heartbeat', async () => {
    watchFailures();
    const s = await setup();
    const held = await hold('703', s.f.task.runId);
    const beat = s.heartbeat();
    beat.catch(() => {});
    await held.waiters();
    await sleep(5_600);
    // The first attempt has rolled back; its retry is waiting on 703 again.
    expect(failures('job_heartbeat')).toMatchObject([
      { attempt: 1, outcome: 'retrying' },
    ]);
    await held.commit((tx) =>
      requestEmployeeAccessCancellationTransaction(
        tx,
        s.f.task.runId,
        'employee_access_revoked',
        { actorId: null, requestId: null, actorLabel: 'met-210-lock-test' },
      ),
    );
    await expect(beat).resolves.toMatchObject({
      active: false,
      canceled: true,
      draining: true,
    });
    const job = await s.job();
    expect(job.cancel_reason).toBe('employee_access_revoked');
    expect(job.drain_reason).toBe('cancel');
    expect(job.lease_expires_at.getTime()).toBeLessThanOrEqual(
      job.drain_deadline_at.getTime(),
    );
    await expect(
      s.f.runtime.assertCurrentAuthority(s.f.base),
    ).resolves.toMatchObject({ cancelRequested: true });
  }, 30_000);

  it('the cancellation poll answers without waiting on a held root lock and writes nothing', async () => {
    const s = await setup();
    const rows = () => s.f.db`
      select (select xmin::text from allrice_runtime_roots where root_run_id=${s.f.task.runId}) root,
        (select xmin::text from allrice_assistant_roots where root_run_id=${s.f.task.runId}) assistant,
        (select xmin::text from allrice_task_clocks where run_id=${s.f.task.runId}) clock,
        (select xmin::text from allrice_jobs where id=${s.f.worker.jobId}) job`;
    const before = await rows();
    const held = await hold('root', s.f.task.runId);
    // Release after 3 s: the old locked-only poll would wait for it.
    const release = sleep(3_000).then(() => held.commit());
    try {
      const started = Date.now();
      await expect(
        s.f.runtime.assertCurrentAuthority(s.f.base),
      ).resolves.toMatchObject({ cancelRequested: false });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await release;
    }
    expect(await rows()).toEqual(before);
  }, 30_000);

  it('with the production authority hook the poll also answers without waiting on a held root lock', async () => {
    const f = await createAssistantAuthorityFixture(database.db);
    const held = await hold('root', f.rootRunId);
    const release = sleep(3_000).then(() => held.commit());
    try {
      const started = Date.now();
      await expect(
        f.runtime.assertCurrentAuthority(f.base),
      ).resolves.toMatchObject({ cancelRequested: false });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await release;
    }
  }, 30_000);

  it('the cancellation poll still stops on a projected deadline the stored deadline has not reached', async () => {
    const s = await setup();
    await s.f
      .db`update allrice_task_clocks set phase='active',active_ms=${defaultTaskRuntimeMs},changed_at=clock_timestamp() where run_id=${s.f.task.runId}`;
    const [stored] = await s.f
      .db`select j.timeout_at,r.deadline_at from allrice_jobs j join allrice_runtime_roots r on r.root_run_id=j.run_id where j.id=${s.f.worker.jobId}`;
    expect(stored!.timeout_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(stored!.deadline_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const stopped = await s.f.runtime.assertCurrentAuthority(s.f.base);
    expect(stopped).toMatchObject({
      cancelRequested: true,
      stopReason: 'timeout',
      drainDeadlineAt: expect.any(String),
    });
    expect(await s.job()).toMatchObject({ drain_reason: 'timeout' });
  });

  it('the cancellation poll still enforces a revoked grant', async () => {
    const s = await setup();
    s.f.revoke();
    await expect(s.f.runtime.assertCurrentAuthority(s.f.base)).rejects.toThrow(
      'revoked',
    );
  });

  it('a failed usage settlement is recorded with its backend and timings', async () => {
    watchFailures();
    const s = await setup();
    const callId = randomUUID();
    await s.f.runtime.prepareModelUsage({
      ...s.f.base,
      runId: s.f.task.runId,
      callId,
      requestedOutputTokens: 100,
    });
    await s.f.runtime.dispatchModelUsage({
      ...s.f.base,
      runId: s.f.task.runId,
      callId,
      inputTokens: 100,
      outputTokens: 100,
      requestDigest: 'sha256:' + 'a'.repeat(64),
    });
    // Same runtime over a pool whose sessions give up a lock after 300 ms.
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    const [scope] = await s.f.db<
      { schema: string }[]
    >`select current_schema() schema`;
    url.searchParams.set('options', `-csearch_path=${scope!.schema},public`);
    const { default: postgresClient } = await import('postgres');
    const impatient = postgresClient(url.toString(), {
      max: 1,
      connection: { lock_timeout: 300 },
    });
    try {
      const runtime = createAssistantRuntime({
        database: impatient,
        authorize: async () => {},
      });
      const held = await hold('root', s.f.task.runId);
      try {
        await expect(
          runtime.settleUsage({
            ...s.f.base,
            callId,
            amounts: {
              model_calls: 1,
              tool_calls: 0,
              input_tokens: 20,
              output_tokens: 7,
            },
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await held.commit();
      }
    } finally {
      await impatient.end({ timeout: 2 });
    }
    const [record] = failures('usage_settlement');
    expect(record).toMatchObject({
      sqlState: '55P03',
      outcome: 'failed',
      runId: s.f.task.runId,
      jobId: s.f.worker.jobId,
      backendPid: expect.any(Number),
    });
    expect(record!.durationMs).toBeGreaterThanOrEqual(250);
    expect(Object.keys(record!).sort()).toEqual(recordKeys);
  }, 30_000);

  it('polls, progress, heartbeats, events and a duplicated settlement share one root through a 6 s hold', async () => {
    watchFailures();
    const s = await setup();
    const { f } = s;
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
      requestDigest: 'sha256:' + 'b'.repeat(64),
    });
    const [budget] =
      await f.db`select spent from allrice_runtime_budgets where root_run_id=${f.task.runId} and metric='model_calls'`;
    const progress = createTaskProgressRuntime(
      {
        context: {
          runId: f.task.runId,
          organizationId: f.task.scope.organizationId,
          workspaceId: f.task.scope.workspaceId,
          delegatedBy: f.context.actor,
        } as unknown as ExecutionContext,
        worker: f.worker,
      },
      f.db,
    );
    const nativeSessionId = randomUUID();
    let running = true;
    const pollMs: number[] = [];
    const heartbeats: unknown[] = [];
    const written: string[] = [];
    const progressCalls: string[] = [];
    const clocks: number[] = [];
    const loop = async (everyMs: number, step: () => Promise<void>) => {
      while (running) {
        await step();
        await sleep(everyMs);
      }
    };
    const loops = [
      loop(250, async () => {
        const started = performance.now();
        await f.runtime.assertCurrentAuthority(f.base);
        pollMs.push(performance.now() - started);
      }),
      loop(1_000, async () => {
        heartbeats.push(await s.heartbeat());
      }),
      loop(150, async () => {
        const label = `delta-${written.length}`;
        await s.event(label);
        written.push(label);
      }),
      loop(300, async () => {
        const id = randomUUID();
        await progress({
          action: 'start',
          nativeSessionId,
          callId: id,
          kind: 'tool',
          name: 'read',
          argumentsDigest: 'sha256:' + 'd'.repeat(64),
        });
        await progress({
          action: 'finish',
          nativeSessionId,
          callId: id,
          kind: 'tool',
          resultDigest: 'sha256:' + 'c'.repeat(64),
          outcome: 'success',
        });
        progressCalls.push(id);
      }),
      loop(250, async () => {
        const clock = await f.db.begin((tx) => readTaskClock(tx, f.task.runId));
        clocks.push(clock!.activeMs);
      }),
    ];
    let settlements: PromiseSettledResult<unknown>[] = [];
    try {
      await sleep(1_000);
      const held = await hold('root', f.task.runId);
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
      const settling = Promise.allSettled([settle(), settle()]);
      await sleep(6_000);
      await held.commit();
      settlements = await settling;
      await sleep(1_500);
    } finally {
      running = false;
      await Promise.allSettled(loops);
    }
    // Every loop survived the hold: nothing rejected out of a loop.
    for (const result of await Promise.allSettled(loops))
      expect(result.status).toBe('fulfilled');
    expect(settlements.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    for (const beat of heartbeats)
      expect(beat).toEqual({ active: true, canceled: false });
    expect(failures('job_heartbeat').length).toBeGreaterThan(0);
    // The snapshot poll never queued behind the held root lock.
    expect(Math.max(...pollMs)).toBeLessThan(1_500);
    expect(progressCalls.length).toBeGreaterThan(0);
    // Events: each written once, in order, no gaps.
    const events = await s.events();
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i));
    expect(events.flatMap((e) => (e.label ? [e.label] : []))).toEqual(written);
    // Budget settled exactly once despite the duplicated settlement.
    const [after] =
      await f.db`select spent from allrice_runtime_budgets where root_run_id=${f.task.runId} and metric='model_calls'`;
    expect(Number(after!.spent) - Number(budget!.spent)).toBeLessThanOrEqual(1);
    const usage =
      await f.db`select metric,settled_amount from allrice_assistant_usage where call_id=${callId} order by metric`;
    expect(
      Object.fromEntries(
        usage.map((u) => [u.metric, Number(u.settled_amount)]),
      ),
    ).toMatchObject({ model_calls: 1, input_tokens: 20, output_tokens: 7 });
    // The clock never runs backwards, and stored deadlines are exactly the
    // clock's projection: nothing extended them while retrying.
    for (let i = 1; i < clocks.length; i++)
      expect(clocks[i]!).toBeGreaterThanOrEqual(clocks[i - 1]!);
    const job = await s.job();
    const [root] =
      await f.db`select deadline_at from allrice_runtime_roots where root_run_id=${f.task.runId}`;
    const clock = await f.db.begin((tx) => refreshTaskClock(tx, f.task.runId));
    expect(job.timeout_at.getTime()).toBeLessThanOrEqual(
      clock!.deadlineAt.getTime(),
    );
    expect(root!.deadline_at.getTime()).toBeLessThanOrEqual(
      clock!.deadlineAt.getTime(),
    );
    expect(job.lease_expires_at.getTime()).toBeLessThanOrEqual(
      job.heartbeat_at.getTime() + 30_000,
    );
  }, 60_000);
});
