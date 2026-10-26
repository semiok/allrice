/** MET-210 supplemental regressions. All locks, clocks and writes are real PG.
 * Each suite owns one random schema; no global DB or service configuration. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import * as client from './core/client.ts';
import {
  appendJobEvent,
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  maintainQueue,
  requestEmployeeAccessCancellationTransaction,
  startClaimedJob,
} from './execution/queue.ts';
import { refreshTaskClock } from './task-clock.ts';
import {
  defaultTaskRuntimeMs,
  resolveTaskRuntimePolicy,
} from './task-runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const tag = '[MET-210] Worker lease transaction rolled back';
type Fixture = Awaited<ReturnType<typeof createAssistantAuthorityFixture>>;

suite('MET-210 supplemental lease boundaries', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  const releases = new Set<() => Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.catch(() => {});
    return promise;
  };
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }, 120_000);
  afterEach(async () => {
    await Promise.all([...releases].map((release) => release()));
    releases.clear();
    await Promise.allSettled([...pending]);
    pending.clear();
    vi.mocked(console.warn).mockClear();
    vi.mocked(console.error).mockClear();
  }, 30_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.close();
  });
  const records = (jobId: string, site?: string) =>
    [
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]
      .filter(
        ([label, data]) =>
          label === tag &&
          data.jobId === jobId &&
          (!site || data.site === site),
      )
      .map(([, data]) => data as Record<string, unknown>);
  async function setup(leaseMs = 30_000) {
    const f = await createAssistantAuthorityFixture(database.db);
    const [employee] =
      await f.db`select * from allrice_employee_runs where run_id=${f.rootRunId}`;
    // A complete persisted employee payload permits real queue takeover/start.
    const payload = {
      schemaVersion: 1,
      type: 'allrice.employee.run',
      input: {
        sessionId: f.session,
        userMessageId: employee!.user_message_id,
        assistantMessageId: employee!.assistant_message_id,
        employeeAssignmentId: f.assignment,
        employeeVersionId: f.version,
      },
    };
    await f.db`update allrice_jobs set payload=${f.db.json(payload)},attempt=1,max_attempts=3
      where id=${f.worker.jobId}`;
    await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    await f.db.begin((tx) => refreshTaskClock(tx, f.rootRunId));
    await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()+${leaseMs}*interval '1 millisecond'
      where id=${f.worker.jobId}`;
    return f;
  }
  const job = async (f: Fixture) =>
    (await f.db`select * from allrice_jobs where id=${f.worker.jobId}`)[0]!;
  const beat = (f: Fixture, signal?: AbortSignal) =>
    heartbeatJob(
      f.worker.workerId,
      f.worker.jobId,
      f.worker.leaseToken,
      30_000,
      { signal },
    );
  const event = (f: Fixture, label: string) =>
    appendJobEvent({ ...f.worker, type: 'step.started', payload: { label } });
  const fail = (f: Fixture) =>
    failJob({
      ...f.worker,
      code: 'TEST_FAILURE',
      message: 'synthetic',
      retryable: false,
    });
  const events = (f: Fixture) =>
    f.db`select sequence,event_type,payload from allrice_run_events where run_id=${f.rootRunId} order by sequence`;

  async function hold(f: Fixture, kind: 'root' | '703' | 'run') {
    let release!: (
      work?: (tx: postgres.TransactionSql) => Promise<unknown>,
    ) => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<
      ((tx: postgres.TransactionSql) => Promise<unknown>) | undefined
    >((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const done = database.db.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      if (kind === '703')
        await tx`select pg_advisory_xact_lock(hashtextextended(${f.rootRunId},703))`;
      else if (kind === 'root')
        await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
      else
        await tx`select id from allrice_runs where id=${f.rootRunId} for update`;
      ready(row!.pid);
      await (
        await gate
      )?.(tx);
    });
    const commit = async (
      work?: (tx: postgres.TransactionSql) => Promise<unknown>,
    ) => {
      release(work);
      await done;
      releases.delete(commit);
    };
    releases.add(commit);
    const pid = await Promise.race([
      locked,
      done.then(() => {
        throw Error('holder_ended_before_lock');
      }),
    ]);
    return {
      commit,
      async waiters(count = 1) {
        await expect
          .poll(
            async () => {
              const [row] = await database.db<
                { n: number }[]
              >`select count(*)::int n from pg_stat_activity
            where ${pid}=any(pg_blocking_pids(pid))`;
              return row!.n;
            },
            { timeout: 3_000, interval: 25 },
          )
          .toBeGreaterThanOrEqual(count);
      },
    };
  }

  for (const kind of ['root', '703'] as const) {
    it.each([
      {
        name: 'before expiry and before 5s',
        lease: 30_000,
        hold: 300,
        expired: false,
      },
      {
        name: 'after expiry but before 5s',
        lease: 1_200,
        hold: 1_600,
        expired: true,
      },
      {
        name: 'before expiry but after 5s',
        lease: 30_000,
        hold: 5_600,
        expired: false,
      },
      {
        name: 'after expiry and after 5s',
        lease: 3_500,
        hold: 5_600,
        expired: true,
      },
    ])(
      `${kind} release $name fences heartbeat, event and terminal writes`,
      async (timing) => {
        const f = await setup(timing.lease);
        const before = await job(f);
        const locked = await hold(f, kind);
        const heartbeat = track(beat(f));
        const writing = track(event(f, 'once'));
        await locked.waiters();
        await delay(timing.hold);
        await locked.commit();
        if (!timing.expired) {
          await expect(heartbeat).resolves.toEqual({
            active: true,
            canceled: false,
          });
          await writing;
          expect(
            (await events(f)).filter((e) => e.payload.label === 'once'),
          ).toHaveLength(1);
          expect((await job(f)).lease_expires_at.getTime()).toBeGreaterThan(
            before.lease_expires_at.getTime(),
          );
          if (timing.hold > 5_000)
            expect(
              records(f.worker.jobId).some((r) => r.outcome === 'retrying'),
            ).toBe(true);
          return;
        }
        await expect(heartbeat).rejects.toMatchObject({ code: 'lease_lost' });
        await expect(writing).rejects.toMatchObject({ code: 'lease_lost' });
        expect(await job(f)).toMatchObject({
          heartbeat_at: before.heartbeat_at,
          lease_expires_at: before.lease_expires_at,
        });
        await expect(
          completeJob({ ...f.worker, result: { late: true } }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        await expect(fail(f)).rejects.toMatchObject({ code: 'lease_lost' });
        expect(await events(f)).toHaveLength(0);
        await maintainQueue();
        const workerId = randomUUID();
        const claimed = await claimNextJob(workerId, 30_000);
        expect(claimed?.id).toBe(f.worker.jobId);
        const replacement = {
          workerId,
          jobId: claimed!.id,
          leaseToken: claimed!.lease!.token,
        };
        expect(replacement.leaseToken).not.toBe(f.worker.leaseToken);
        await expect(
          startClaimedJob(workerId, replacement.jobId, replacement.leaseToken),
        ).resolves.not.toBeNull();
        await expect(beat(f)).rejects.toMatchObject({ code: 'lease_lost' });
        await expect(event(f, 'stale')).rejects.toMatchObject({
          code: 'lease_lost',
        });
        await expect(fail(f)).rejects.toMatchObject({ code: 'lease_lost' });
        await expect(
          completeJob({ ...f.worker, result: {} }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        await appendJobEvent({
          ...replacement,
          type: 'step.started',
          payload: { label: 'replacement' },
        });
        await completeJob({
          ...replacement,
          result: { answer: 'replacement' },
        });
        expect(await job(f)).toMatchObject({ status: 'succeeded', attempt: 2 });
      },
      25_000,
    );
  }

  it.each(['event', 'complete', 'fail'] as const)(
    'post-admission run-row lock crossing lease expiry must roll back %s',
    async (operation) => {
      const f = await setup(1_200);
      const before = await job(f);
      const locked = await hold(f, 'run');
      const writing = track<unknown>(
        operation === 'event'
          ? event(f, 'expired-after-admission')
          : operation === 'complete'
            ? completeJob({ ...f.worker, result: { late: true } })
            : fail(f),
      );
      await locked.waiters();
      await delay(1_600);
      await locked.commit();
      const outcome = await Promise.allSettled([writing]);
      // Soft assertions retain the durable evidence even if the call wrongly succeeds.
      expect
        .soft(outcome[0])
        .toMatchObject({ status: 'rejected', reason: { code: 'lease_lost' } });
      expect.soft(await job(f)).toMatchObject({
        status: 'running',
        lease_expires_at: before.lease_expires_at,
      });
      expect.soft(await events(f)).toHaveLength(0);
    },
    15_000,
  );

  for (const retry of [false, true])
    it.each(['cancel', 'revocation', 'deadline'] as const)(
      `%s committed with 703 release is observed (retry=${retry}) and freezes one drain`,
      async (cause) => {
        const f = await setup();
        const locked = await hold(f, '703');
        const heartbeat = track(beat(f));
        await locked.waiters();
        if (retry) {
          await expect
            .poll(() => records(f.worker.jobId, 'job_heartbeat').length, {
              timeout: 7_000,
              interval: 25,
            })
            .toBe(1);
          await locked.waiters();
        }
        await locked.commit(async (tx) => {
          if (cause === 'revocation')
            await requestEmployeeAccessCancellationTransaction(
              tx,
              f.rootRunId,
              'employee_access_revoked',
              { actorId: null, requestId: null, actorLabel: 'synthetic' },
            );
          else if (cause === 'cancel')
            await tx`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='user_requested' where id=${f.worker.jobId}`;
          else
            await tx`update allrice_task_clocks set phase='active',active_ms=${defaultTaskRuntimeMs},changed_at=clock_timestamp() where run_id=${f.rootRunId}`;
        });
        const result = await heartbeat;
        expect(result).toMatchObject({
          active: false,
          canceled: cause !== 'deadline',
          draining: true,
        });
        const first = await job(f);
        expect(first.drain_reason).toBe(
          cause === 'deadline' ? 'timeout' : 'cancel',
        );
        expect(first.cancel_reason).toBe(
          cause === 'revocation'
            ? 'employee_access_revoked'
            : cause === 'deadline'
              ? 'job_timeout'
              : 'user_requested',
        );
        expect(result).toHaveProperty(
          'drainDeadlineAt',
          first.drain_deadline_at.toISOString(),
        );
        expect(first.lease_expires_at.getTime()).toBeLessThanOrEqual(
          first.drain_deadline_at.getTime(),
        );
        await beat(f);
        expect((await job(f)).drain_deadline_at).toEqual(
          first.drain_deadline_at,
        );
      },
      20_000,
    );

  // Force only the snapshot preflight to fall through; every authority decision
  // still uses assertAssistantAuthority and the original real locked transaction.
  const slowRuntime = () =>
    createAssistantRuntime({
      database: database.db,
      authorize: async (input) => {
        if (input.lock === false) throw Error('test_force_locked_fallback');
        await assertAssistantAuthority(input);
      },
    });
  const decision = async (promise: Promise<unknown>) => {
    try {
      return { value: JSON.parse(JSON.stringify(await promise)) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };

  it.each([
    'clear',
    'policy-deny',
    'member-disabled',
    'employee-disabled',
    'root-cancel',
    'child-cancel',
    'stored-deadline',
    'projected-deadline',
    'token',
    'worker',
    'generation',
    'fence',
    'revoked',
  ] as const)(
    'snapshot/locked authority decisions agree for %s',
    async (state) => {
      const f = await setup();
      let expected: object = { value: { cancelRequested: false } };
      if (state === 'policy-deny')
        await f.setControls({
          version: 2,
          enabled: true,
          mode: 'execute',
          rules: [{ action: 'assistant.delegate', effect: 'deny' }],
        });
      if (state === 'member-disabled')
        await f.db`update allrice_memberships set active=false where id=${f.membership}`;
      if (state === 'employee-disabled')
        await f.db`update allrice_employees set status='archived' where id=${f.employee}`;
      if (
        ['policy-deny', 'member-disabled', 'employee-disabled'].includes(state)
      )
        expected = { error: 'assistant_authority_denied' };
      if (state === 'root-cancel') {
        await f.runtime.cancelRoot(f.context, {
          runId: f.rootRunId,
          requestId: randomUUID(),
        });
        expected = { value: { cancelRequested: true } };
      }
      if (state === 'child-cancel') {
        const child = await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'helper',
          text: 'Read synthetic input',
          tools: ['web.fetch'],
        });
        await f.runtime.cancelChild(f.context, {
          runId: f.rootRunId,
          childRunId: child.instance.runId,
          requestId: randomUUID(),
        });
        const [row] =
          await f.db`select status,cancel_requested_at from allrice_assistant_instances where run_id=${child.instance.runId}`;
        expect(row!.status).toBe('cancel_requested');
        expect(row!.cancel_requested_at).toBeInstanceOf(Date);
      }
      if (state === 'stored-deadline') {
        await f.db`delete from allrice_task_clock_events where run_id=${f.rootRunId}`;
        await f.db`delete from allrice_task_clocks where run_id=${f.rootRunId}`;
        await f.db`update allrice_jobs set created_at=clock_timestamp()-interval '5 minutes',timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
        await f.db`update allrice_runtime_roots set deadline_at=clock_timestamp()-interval '1 second' where root_run_id=${f.rootRunId}`;
      }
      if (state === 'projected-deadline') {
        expect((await job(f)).timeout_at.getTime()).toBeGreaterThan(
          Date.now() + 60_000,
        );
        await f.db`update allrice_task_clocks set phase='active',active_ms=${defaultTaskRuntimeMs},changed_at=clock_timestamp() where run_id=${f.rootRunId}`;
      }
      if (state.includes('deadline'))
        expected = {
          value: {
            cancelRequested: true,
            stopReason: 'timeout',
            drainDeadlineAt: expect.any(String),
          },
        };
      if (state === 'token')
        await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.worker.jobId}`;
      if (state === 'worker')
        await f.db`update allrice_jobs set worker_id=${randomUUID()} where id=${f.worker.jobId}`;
      if (state === 'generation')
        await f.db`update allrice_assistant_roots set generation=generation+1 where root_run_id=${f.rootRunId}`;
      if (state === 'fence')
        await f.db`update allrice_assistant_roots set fence=fence+1 where root_run_id=${f.rootRunId}`;
      if (state === 'revoked')
        await f.db`update allrice_assistant_roots set revoked_at=clock_timestamp() where root_run_id=${f.rootRunId}`;
      if (['token', 'worker', 'generation', 'fence', 'revoked'].includes(state))
        expected = { error: 'lease_lost' };
      const fast = await decision(f.runtime.assertCurrentAuthority(f.base));
      const slow = await decision(slowRuntime().assertCurrentAuthority(f.base));
      expect(fast).toMatchObject(expected);
      expect(slow).toEqual(fast);
    },
  );

  it('the locked fallback refreshes the task clock exactly once', async () => {
    const f = await setup();
    await f.db`create table met210_clock_updates(run_id uuid)`;
    await f.db
      .unsafe(`create function met210_count_clock() returns trigger language plpgsql as $$
      begin insert into met210_clock_updates values(new.run_id); return new; end $$`);
    await f.db.unsafe(
      'create trigger met210_clock_count after update on allrice_task_clocks for each row execute function met210_count_clock()',
    );
    try {
      await expect(
        slowRuntime().assertCurrentAuthority(f.base),
      ).resolves.toMatchObject({ cancelRequested: false });
      const rows =
        await f.db`select * from met210_clock_updates where run_id=${f.rootRunId}`;
      expect(rows).toHaveLength(1);
    } finally {
      await f.db.unsafe(
        'drop trigger met210_clock_count on allrice_task_clocks',
      );
      await f.db.unsafe('drop function met210_count_clock()');
      await f.db`drop table met210_clock_updates`;
    }
  });

  it.each(['root', '703'] as const)(
    'a blocked %s does not delay snapshot polls or another Run',
    async (kind) => {
      const a = await setup();
      const b = await setup();
      const before =
        await a.db`select xmin::text from allrice_task_clocks where run_id=${a.rootRunId}`;
      const locked = await hold(a, kind);
      const blocked = track(event(a, 'blocked'));
      await locked.waiters();
      const timer = setTimeout(() => {
        void locked.commit();
      }, 2_500);
      try {
        const start = performance.now();
        for (let n = 0; n < 4; n++)
          await expect(
            a.runtime.assertCurrentAuthority(a.base),
          ).resolves.toMatchObject({ cancelRequested: false });
        await Promise.all([
          beat(b),
          event(b, 'free'),
          b.runtime.assertCurrentAuthority(b.base),
        ]);
        expect(performance.now() - start).toBeLessThan(1_000);
        expect(
          await a.db`select xmin::text from allrice_task_clocks where run_id=${a.rootRunId}`,
        ).toEqual(before);
      } finally {
        clearTimeout(timer);
        await locked.commit();
        await blocked;
      }
    },
    15_000,
  );

  it('concurrent native question/event retries are unique and preserve each producer order', async () => {
    const f = await setup();
    const locked = await hold(f, '703');
    const writers = [0, 1, 2].map((producer) =>
      track(
        (async () => {
          for (const [index, sourceEventType] of [
            'session/user-question',
            'session/user-question-answered',
          ].entries()) {
            await appendJobEvent({
              ...f.worker,
              type: 'harness.native',
              payload: {
                source: 'dsh',
                sourceEventType,
                nativePayload: { questionId: `question-${producer}` },
                producer,
                index,
              },
            });
          }
        })(),
      ),
    );
    await locked.waiters(3);
    await delay(5_700);
    await locked.commit();
    await Promise.all(writers);
    const written = await events(f);
    expect(written).toHaveLength(6);
    expect(written.map((row) => row.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      new Set(
        written.map((row) => `${row.payload.producer}:${row.payload.index}`),
      ).size,
    ).toBe(6);
    for (const producer of [0, 1, 2])
      expect(
        written
          .filter((row) => row.payload.producer === producer)
          .map((row) => row.payload.index),
      ).toEqual([0, 1]);
    const questions =
      await f.db`select pending from allrice_task_questions where run_id=${f.rootRunId}`;
    expect(questions).toHaveLength(3);
    expect(questions.every((row) => row.pending === false)).toBe(true);
    expect(
      records(f.worker.jobId, 'job_event').filter(
        (r) => r.outcome === 'retrying',
      ).length,
    ).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('a native receipt rolled back after question mutation leaves no partial question or event', async () => {
    const f = await setup();
    const locked = await hold(f, 'run');
    const writing = track(
      appendJobEvent({
        ...f.worker,
        type: 'harness.native',
        payload: {
          source: 'dsh',
          sourceEventType: 'session/user-question',
          nativePayload: { questionId: 'rollback-question' },
        },
      }),
    );
    await locked.waiters();
    await expect
      .poll(() => records(f.worker.jobId, 'job_event').length, {
        timeout: 7_000,
        interval: 25,
      })
      .toBe(1);
    expect(
      await f.db`select * from allrice_task_questions where run_id=${f.rootRunId}`,
    ).toHaveLength(0);
    expect(await events(f)).toHaveLength(0);
    await locked.commit();
    await writing;
    expect(
      await f.db`select * from allrice_task_questions where run_id=${f.rootRunId}`,
    ).toHaveLength(1);
    expect(await events(f)).toHaveLength(1);
  }, 20_000);

  it('usage rollback logs only metadata; concurrent/repeated settlements charge exactly once', async () => {
    const f = await setup();
    const callId = randomUUID();
    await f.runtime.prepareModelUsage({
      ...f.base,
      runId: f.rootRunId,
      callId,
      requestedOutputTokens: 100,
    });
    await f.runtime.dispatchModelUsage({
      ...f.base,
      runId: f.rootRunId,
      callId,
      inputTokens: 100,
      outputTokens: 100,
      requestDigest: 'sha256:' + 'a'.repeat(64),
    });
    const usage = {
      ...f.base,
      callId,
      amounts: {
        model_calls: 1,
        tool_calls: 0,
        input_tokens: 23,
        output_tokens: 11,
      },
    };
    const [scope] = await f.db`select current_schema() name`;
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.searchParams.set('options', `-csearch_path=${scope!.name},public`);
    const impatient = postgres(url.href, {
      max: 1,
      connection: { lock_timeout: 300 },
    });
    try {
      const [connection] = await impatient<
        { pid: number }[]
      >`select pg_backend_pid() pid`;
      const runtime = createAssistantRuntime({
        database: impatient,
        authorize: assertAssistantAuthority,
      });
      const locked = await hold(f, 'root');
      await expect(runtime.settleUsage(usage)).rejects.toMatchObject({
        code: '55P03',
      });
      await locked.commit();
      const [record] = records(f.worker.jobId, 'usage_settlement');
      expect(record).toMatchObject({
        site: 'usage_settlement',
        sqlState: '55P03',
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        backendPid: expect.any(Number),
        durationMs: expect.any(Number),
        firstStatementMs: expect.any(Number),
        attempt: 1,
        outcome: 'failed',
      });
      expect(Object.keys(record!).sort()).toEqual([
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
      ]);
      expect(record!.durationMs).toBeGreaterThanOrEqual(250);
      expect(record!.backendPid).toBe(connection!.pid);
      expect(Number(record!.firstStatementMs)).toBeLessThanOrEqual(
        Number(record!.durationMs),
      );
      const logged = JSON.stringify(record);
      for (const secret of [
        callId,
        f.worker.leaseToken,
        f.org,
        f.workspace,
        'requestDigest',
        'input_tokens',
        'select ',
        'params',
      ])
        expect(logged).not.toContain(secret);
      const before =
        await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`;
      await Promise.all([
        f.runtime.settleUsage(usage),
        f.runtime.settleUsage(usage),
        f.runtime.settleUsage(usage),
      ]);
      const once =
        await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`;
      await f.runtime.settleUsage(usage);
      expect(
        await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`,
      ).toEqual(once);
      const settled =
        await f.db`select metric,settled_amount from allrice_assistant_usage where call_id=${callId}`;
      expect(
        Object.fromEntries(
          settled.map((row) => [row.metric, Number(row.settled_amount)]),
        ),
      ).toMatchObject(usage.amounts);
      for (const metric of [
        'model_calls',
        'input_tokens',
        'output_tokens',
      ] as const) {
        expect(
          Number(once.find((r) => r.metric === metric)!.spent) -
            Number(before.find((r) => r.metric === metric)!.spent),
        ).toBe(usage.amounts[metric]);
      }
    } finally {
      await impatient.end({ timeout: 2 });
    }
  }, 20_000);

  it('an aborted heartbeat does not start a second transaction after 55P03', async () => {
    const f = await setup();
    const original = await job(f);
    const locked = await hold(f, '703');
    const abort = new AbortController();
    const heartbeat = track(beat(f, abort.signal));
    await locked.waiters();
    abort.abort();
    await expect(heartbeat).rejects.toMatchObject({ code: '55P03' });
    await locked.commit();
    expect(records(f.worker.jobId, 'job_heartbeat')).toMatchObject([
      { attempt: 1, outcome: 'aborted' },
    ]);
    expect(await job(f)).toMatchObject({
      lease_expires_at: original.lease_expires_at,
      heartbeat_at: original.heartbeat_at,
    });
  }, 15_000);

  it('abort during database lease revalidation must prevent the next retry', async () => {
    const f = await setup();
    const original = await job(f);
    const locked = await hold(f, '703');
    const abort = new AbortController();
    const heartbeat = track(beat(f, abort.signal));
    await locked.waiters();
    let ready!: (pid: number) => void;
    let release!: () => void;
    const readyGate = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Schema-local DDL lock queues behind attempt 1's AccessShareLock. It
    // acquires only when 55P03 rolls that attempt back, then blocks the fresh
    // SELECT used for retry eligibility. Neither the SQL nor driver is mocked.
    const blocker = f.db.begin(async (tx) => {
      await tx`lock table allrice_jobs in access exclusive mode`;
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      ready(row!.pid);
      await releaseGate;
    });
    const cleanup = async () => {
      release();
      await blocker;
    };
    releases.add(cleanup);
    const pid = await Promise.race([
      readyGate,
      blocker.then(() => {
        throw Error('table_holder_ended');
      }),
    ]);
    await expect
      .poll(
        async () => {
          const [row] =
            await f.db`select count(*)::int n from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`;
          return row!.n;
        },
        { timeout: 3_000, interval: 25 },
      )
      .toBe(1);
    abort.abort();
    await cleanup();
    releases.delete(cleanup);
    await locked.commit();
    const [result] = await Promise.allSettled([heartbeat]);
    expect.soft(result).toMatchObject({ status: 'rejected' });
    expect
      .soft(records(f.worker.jobId).some((row) => row.outcome === 'retrying'))
      .toBe(false);
    expect.soft(await job(f)).toMatchObject({
      lease_expires_at: original.lease_expires_at,
      heartbeat_at: original.heartbeat_at,
    });
  }, 15_000);

  it('a long valid lease still permits at most four lock-timeout attempts', async () => {
    const f = await setup(60_000);
    const original = await job(f);
    const locked = await hold(f, '703');
    const heartbeat = track(beat(f));
    await locked.waiters();
    await expect(heartbeat).rejects.toMatchObject({ code: '55P03' });
    await locked.commit();
    expect(
      records(f.worker.jobId, 'job_heartbeat').map((row) => [
        row.attempt,
        row.outcome,
      ]),
    ).toEqual([
      [1, 'retrying'],
      [2, 'retrying'],
      [3, 'retrying'],
      [4, 'exhausted'],
    ]);
    expect(await job(f)).toMatchObject({
      lease_expires_at: original.lease_expires_at,
      heartbeat_at: original.heartbeat_at,
    });
  }, 30_000);
});
