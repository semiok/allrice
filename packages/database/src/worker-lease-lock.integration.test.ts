/** MET-210 #4: a second real connection holds the run's runtime-root row or
 * its 703 advisory lock past the 5 s lock_timeout, while the production
 * heartbeat, event write, cancellation poll and usage settlement compete.
 * Isolated schema only; elapsed time is real (no clock mocking). */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
import {
  runtimeTaskFixture,
  createRuntimeFixtureDatabase,
} from './runtime.fixture.ts';
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
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    database = await createRuntimeFixtureDatabase();
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
    const f = await runtimeTaskFixture(database.db);
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
  /** `both` takes 703 then the root, as the queue does; `run` is the Run row
   * an event write locks only after it already holds its Job. */
  async function hold(
    kind: 'root' | '703' | 'both' | 'run' | 'cancel',
    runId: string,
  ) {
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
      if (kind === '703' || kind === 'both')
        await tx`select pg_advisory_xact_lock(hashtextextended(${runId},703))`;
      if (kind === 'root' || kind === 'both')
        await tx`select root_run_id from allrice_runtime_roots where root_run_id=${runId} for update`;
      if (kind === 'run')
        await tx`select id from allrice_runs where id=${runId} for update`;
      if (kind === 'cancel')
        await tx`select pg_advisory_xact_lock(hashtextextended(${runId},704))`;
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
    'durationMs',
    'firstStatementMs',
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
    const s = await setup(10);
    const before = await s.job();
    const held = await hold('703', s.f.task.runId);
    const started = Date.now();
    const beat = s.heartbeat();
    beat.catch(() => {});
    await held.waiters();
    try {
      await expect(beat).rejects.toMatchObject({ code: '55P03' });
      // Gives up before the lease end minus the 1.5 s reserve (lease: 10 s).
      expect(Date.now() - started).toBeLessThan(8_500);
    } finally {
      await held.commit();
    }
    expect((await s.job()).lease_expires_at).toEqual(before.lease_expires_at);
    const outcomes = failures('job_heartbeat').map((r) => r.outcome);
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.slice(0, -1).every((o) => o === 'retrying')).toBe(true);
    expect(outcomes.at(-1)).toBe('exhausted');
  }, 30_000);

  it('a cancel committed during the wait ends the retries without renewing', async () => {
    watchFailures();
    const s = await setup();
    const before = await s.job();
    const held = await hold('703', s.f.task.runId);
    const beat = s.heartbeat();
    beat.catch(() => {});
    await held.waiters();
    // The stop is already committed when the retry reads the lease. (A real
    // cancelRun would itself queue on 703; this is the database state it leaves.)
    await s.f
      .db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='user_requested' where id=${s.f.worker.jobId}`;
    await sleep(6_000);
    await held.commit();
    await expect(beat).rejects.toMatchObject({ code: '55P03' });
    expect((await s.job()).lease_expires_at).toEqual(before.lease_expires_at);
    expect(failures('job_heartbeat')).toMatchObject([
      { attempt: 1, outcome: 'stopped' },
    ]);
  }, 30_000);

  it('a task deadline reached during the wait is enforced by the retried heartbeat, not renewed', async () => {
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
    await expect(beat).resolves.toMatchObject({
      active: false,
      canceled: false,
      draining: true,
    });
    const job = await s.job();
    expect(job.drain_reason).toBe('timeout');
    // Only the receipt window anchored at the deadline, never a renewal.
    expect(job.drain_deadline_at.getTime()).toBe(
      before.timeout_at.getTime() + 30_000,
    );
    expect(job.lease_expires_at.getTime()).toBeLessThanOrEqual(
      job.drain_deadline_at.getTime(),
    );
    expect(failures('job_heartbeat')).toMatchObject([
      { attempt: 1, outcome: 'retrying' },
    ]);
  }, 30_000);

  it('an event write that holds its Job but then waits past the lease does not commit', async () => {
    watchFailures();
    const s = await setup(4);
    const held = await hold('run', s.f.task.runId);
    const write = s.event('late');
    write.catch(() => {});
    await held.waiters();
    // Release after the 4 s lease, before the 5 s lock_timeout.
    await sleep(4_600);
    await held.commit();
    await expect(write).rejects.toMatchObject({ code: 'lease_lost' });
    expect((await s.events()).some((e) => e.label === 'late')).toBe(false);
  }, 30_000);

  it('a heartbeat that freezes a drain but waits past its lease does not commit the drain', async () => {
    watchFailures();
    const s = await setup(3);
    await s.f
      .db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='user_requested' where id=${s.f.worker.jobId}`;
    const before = await s.job();
    // Pause the ordinary root cancellation AFTER the Job drain write. The
    // test trigger supplies only contention, never a new business lifecycle.
    await s.f.db
      .unsafe(`create function met210_hold_cancel() returns trigger language plpgsql as $$
      begin
        if old.cancel_requested_at is null and new.cancel_requested_at is not null then
          perform pg_advisory_xact_lock(hashtextextended(new.root_run_id::text,704));
        end if;
        return new;
      end $$`);
    await s.f.db.unsafe(
      'create trigger met210_hold_cancel before update on allrice_runtime_roots for each row execute function met210_hold_cancel()',
    );
    const held = await hold('cancel', s.f.task.runId);
    const beat = s.heartbeat();
    beat.catch(() => {});
    try {
      await held.waiters();
      await sleep(3_600);
      await held.commit();
      await expect(beat).rejects.toMatchObject({ code: 'lease_lost' });
      const after = await s.job();
      expect(after.drain_deadline_at).toBeNull();
      expect(after.lease_expires_at).toEqual(before.lease_expires_at);
      const [root] = await s.f
        .db`select cancel_requested_at from allrice_runtime_roots where root_run_id=${s.f.task.runId}`;
      expect(root!.cancel_requested_at).toBeNull();
    } finally {
      await held.commit();
      await beat.catch(() => {});
      await s.f.db.unsafe(
        'drop trigger met210_hold_cancel on allrice_runtime_roots',
      );
      await s.f.db.unsafe('drop function met210_hold_cancel()');
    }
  }, 30_000);

  it('an access revocation committed with the lock release is honored by the retried heartbeat', async () => {
    watchFailures();
    const s = await setup();
    const held = await hold('703', s.f.task.runId);
    const beat = s.heartbeat();
    beat.catch(() => {});
    await held.waiters();
    await sleep(6_500);
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
    await expect(s.heartbeat()).resolves.toMatchObject({
      active: false,
      canceled: true,
      draining: true,
    });
  }, 30_000);

  it('the ordinary heartbeat stops on a projected deadline the stored deadline has not reached', async () => {
    const s = await setup();
    await s.f
      .db`update allrice_task_clocks set phase='active',active_ms=${defaultTaskRuntimeMs},changed_at=clock_timestamp() where run_id=${s.f.task.runId}`;
    const [stored] = await s.f
      .db`select j.timeout_at,r.deadline_at from allrice_jobs j join allrice_runtime_roots r on r.root_run_id=j.run_id where j.id=${s.f.worker.jobId}`;
    expect(stored!.timeout_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(stored!.deadline_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const stopped = await s.heartbeat();
    expect(stopped).toMatchObject({
      active: false,
      canceled: false,
      draining: true,
      drainDeadlineAt: expect.any(String),
    });
    expect(await s.job()).toMatchObject({ drain_reason: 'timeout' });
  });

  it('a blocked ordinary model receipt rolls back without marking the call finished', async () => {
    const s = await setup();
    const input = {
      context: {
        runId: s.f.task.runId,
        organizationId: s.f.task.scope.organizationId,
        workspaceId: s.f.task.scope.workspaceId,
        delegatedBy: s.f.context.actor,
      } as ExecutionContext,
      worker: s.f.worker,
    };
    const progress = createTaskProgressRuntime(input, s.f.db);
    const callId = randomUUID(),
      nativeSessionId = randomUUID();
    await progress({ action: 'start', kind: 'model', nativeSessionId, callId });
    const receipt = {
      action: 'finish',
      kind: 'model',
      nativeSessionId,
      callId,
      resultDigest: 'sha256:' + 'a'.repeat(64),
      outcome: 'success',
    };
    const before = await s.f
      .db`select * from allrice_task_calls where run_id=${s.f.task.runId} and call_id=${callId}`;
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    const [scope] = await s.f.db`select current_schema() schema`;
    url.searchParams.set('options', `-csearch_path=${scope!.schema}`);
    const { default: postgresClient } = await import('postgres');
    const impatient = postgresClient(url.toString(), {
      max: 1,
      connection: { lock_timeout: 300 },
    });
    try {
      const held = await hold('root', s.f.task.runId);
      try {
        await expect(
          createTaskProgressRuntime(input, impatient)(receipt),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await held.commit();
      }
      expect(
        await s.f
          .db`select * from allrice_task_calls where run_id=${s.f.task.runId} and call_id=${callId}`,
      ).toEqual(before);
      await progress(receipt);
      const [after] = await s.f
        .db`select finished_at,result_digest,settled_output_tokens from allrice_task_calls where run_id=${s.f.task.runId} and call_id=${callId}`;
      expect(after).toEqual({
        finished_at: expect.any(Date),
        result_digest: receipt.resultDigest,
        settled_output_tokens: null,
      });
    } finally {
      await impatient.end({ timeout: 2 });
    }
  }, 30_000);

  it('progress, heartbeats, events and a duplicated receipt share one root through a 7 s hold', async () => {
    watchFailures();
    const s = await setup();
    const { f } = s;
    const callId = randomUUID();
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
    await progress({ action: 'start', kind: 'model', nativeSessionId, callId });
    const receipt = {
      action: 'finish',
      kind: 'model',
      nativeSessionId,
      callId,
      resultDigest: 'sha256:' + 'b'.repeat(64),
      outcome: 'success',
    };
    let running = true;
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
      // 703 and the root, as the queue takes them: every heartbeat and event
      // write that starts during the hold queues on 703 first.
      const held = await hold('both', f.task.runId);
      const settle = () => progress(receipt);
      const settling = Promise.allSettled([settle(), settle()]);
      // Longer than one heartbeat period plus lock_timeout.
      await sleep(7_000);
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
    expect(progressCalls.length).toBeGreaterThan(0);
    // Events: each written once, in order, no gaps.
    const events = await s.events();
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i));
    expect(events.flatMap((e) => (e.label ? [e.label] : []))).toEqual(written);
    // The same ordinary model receipt is accepted exactly once. No receipt
    // invents token accounting that the native model did not supply.
    const calls =
      await f.db`select finished_at,result_digest,settled_output_tokens from allrice_task_calls where run_id=${f.task.runId} and call_id=${callId}`;
    expect(calls).toEqual([
      {
        finished_at: expect.any(Date),
        result_digest: receipt.resultDigest,
        settled_output_tokens: null,
      },
    ]);
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
