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
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import {
  RuntimeOperationSnapshotSchema,
  type RuntimeUsageObservation,
} from '@allrice/contracts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
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
type Fixture = Awaited<ReturnType<typeof createRunAuthorityFixture>>;

suite('MET-210 supplemental lease boundaries', () => {
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  const releases = new Set<() => Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.catch(() => {});
    return promise;
  };
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    database = await createRuntimeFixtureDatabase();
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
    const f = await createRunAuthorityFixture(database.db, {
      configure: false,
    });
    await f.ledger.createRoot({
      task: f.task,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      budgets: (
        ['model_calls', 'tool_calls', 'input_tokens', 'output_tokens'] as const
      ).map((metric) => ({
        metric,
        unit: metric.endsWith('tokens') ? 'tokens' : 'calls',
        currency: null,
        capacity: 100000,
        source: {
          kind: 'worker' as const,
          sourceId: 'ordinary-lease-regression',
        },
      })),
    });
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
        // The suite shares one schema: earlier cases may leave live Jobs that
        // maintenance or the unscoped claim below could pick up instead.
        await f.db`update allrice_jobs set status='canceled'
          where id<>${f.worker.jobId} and status in ('queued','claimed','running','retry_wait')`;
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

  it.each([
    'clear',
    'root-cancel',
    'stored-deadline',
    'projected-deadline',
    'token',
    'worker',
  ] as const)(
    'the ordinary heartbeat enforces %s using its current queue lease',
    async (state) => {
      const f = await setup();
      if (state === 'root-cancel')
        await f.db.begin((tx) =>
          requestEmployeeAccessCancellationTransaction(
            tx,
            f.rootRunId,
            'employee_access_revoked',
            { actorId: null, requestId: null, actorLabel: 'lease-regression' },
          ),
        );
      if (state === 'stored-deadline') {
        await f.db`delete from allrice_task_clock_events where run_id=${f.rootRunId}`;
        await f.db`delete from allrice_task_clocks where run_id=${f.rootRunId}`;
        await f.db`update allrice_jobs set created_at=clock_timestamp()-interval '5 minutes',timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
        await f.db`update allrice_runtime_roots set deadline_at=clock_timestamp()-interval '1 second' where root_run_id=${f.rootRunId}`;
      }
      if (state === 'projected-deadline')
        await f.db`update allrice_task_clocks set phase='active',active_ms=${defaultTaskRuntimeMs},changed_at=clock_timestamp() where run_id=${f.rootRunId}`;
      if (state === 'token')
        await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.worker.jobId}`;
      if (state === 'worker')
        await f.db`update allrice_jobs set worker_id=${randomUUID()} where id=${f.worker.jobId}`;
      if (state === 'token' || state === 'worker')
        await expect(beat(f)).rejects.toMatchObject({ code: 'lease_lost' });
      else if (state === 'clear')
        await expect(beat(f)).resolves.toEqual({
          active: true,
          canceled: false,
        });
      else {
        await expect(beat(f)).resolves.toMatchObject({
          active: false,
          canceled: state === 'root-cancel',
          draining: true,
          drainDeadlineAt: expect.any(String),
        });
        expect((await job(f)).drain_reason).toBe(
          state === 'root-cancel' ? 'cancel' : 'timeout',
        );
      }
    },
  );

  it('an ordinary heartbeat refreshes the task clock exactly once', async () => {
    const f = await setup();
    await f.db`create table met210_clock_updates(run_id uuid)`;
    await f.db
      .unsafe(`create function met210_count_clock() returns trigger language plpgsql as $$
      begin insert into met210_clock_updates values(new.run_id); return new; end $$`);
    await f.db.unsafe(
      'create trigger met210_clock_count after update on allrice_task_clocks for each row execute function met210_count_clock()',
    );
    try {
      await expect(beat(f)).resolves.toEqual({ active: true, canceled: false });
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
    'a blocked %s does not delay another ordinary Run',
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
        await Promise.all([beat(b), event(b, 'free')]);
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

  it('ordinary operation usage rolls back under a root lock and duplicate measured receipts charge exactly once', async () => {
    const f = await setup(),
      targetId = randomUUID();
    const digest = 'sha256:' + 'a'.repeat(64);
    await f.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
      values(${targetId},${f.org},${f.workspace},'lease-regression','cloud_sandbox','Synthetic ledger target','online','[]')`;
    const snapshot = RuntimeOperationSnapshotSchema.parse({
      contractVersion: 1,
      binding: {
        task: f.task,
        attempt: {
          operationId: randomUUID(),
          attemptId: randomUUID(),
          attemptNumber: 1,
          generation: 0,
          fence: 1,
        },
        requestedBy: { type: 'user', id: f.user },
        policy: { snapshotId: randomUUID(), digest },
        execution: {
          targetId,
          targetKind: 'cloud_sandbox',
          deviceId: null,
          grantId: randomUUID(),
          grantVersion: 1,
          scopeDigest: digest,
          workCopy: { id: randomUUID(), kind: 'cloud_copy' },
        },
        action: 'cloud.synthetic.test',
        inputDigest: digest,
        dataScope: [],
        baseline: [],
        command: null,
      },
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: randomUUID(),
      status: 'planned',
      result: null,
    });
    const amounts = {
      model_calls: 1,
      tool_calls: 0,
      input_tokens: 23,
      output_tokens: 11,
    };
    const metrics = [
      'model_calls',
      'tool_calls',
      'input_tokens',
      'output_tokens',
    ] as const;
    const reservations = metrics.map((metric) => ({
      metric,
      accountingId: randomUUID(),
      amount: 100,
    }));
    await f.ledger.createOperation({ snapshot, reservations });
    const operationId = snapshot.binding.attempt.operationId;
    const lease = await f.ledger.dispatch({
      scope: f.task.scope,
      operationId,
      leaseOwner: randomUUID(),
      leaseMs: 60000,
    });
    await f.ledger.recordReceipt({
      scope: f.task.scope,
      operationId,
      leaseToken: lease.leaseToken,
      receiptId: randomUUID(),
      attempt: snapshot.binding.attempt,
      signal: {
        type: 'operation.outcome',
        result: {
          status: 'succeeded',
          effects: 'none',
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest,
          },
        },
      },
    });
    const now = new Date().toISOString();
    const receipts = reservations.map((reservation) => ({
      scope: f.task.scope,
      operationId,
      leaseToken: lease.leaseToken,
      observation: {
        contractVersion: 1,
        observationId: randomUUID(),
        accountingId: reservation.accountingId,
        task: f.task,
        source: { kind: 'worker', sourceId: 'ordinary-lease-regression' },
        accountingBoundary: {
          kind: 'operation',
          attempt: snapshot.binding.attempt,
        },
        aggregation: 'self_only',
        metric: reservation.metric,
        unit: reservation.metric.endsWith('tokens') ? 'tokens' : 'calls',
        currency: null,
        mode: 'cumulative',
        quality: 'measured',
        amount: amounts[reservation.metric],
        state: 'settled',
        window: { id: randomUUID(), startedAt: now, endedAt: now },
        observedAt: now,
      } as RuntimeUsageObservation,
    }));
    const budgets = () =>
      f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`;
    const before = await budgets();
    const [scope] = await f.db`select current_schema() name`;
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.searchParams.set('options', `-csearch_path=${scope!.name}`);
    const impatient = postgres(url.href, {
      max: 1,
      connection: { lock_timeout: 300 },
    });
    try {
      const ledger = createRuntimeOperationLedger({
        database: impatient,
        admission: async () => {},
      });
      const locked = await hold(f, 'root');
      try {
        await expect(ledger.settleUsage(receipts[0]!)).rejects.toMatchObject({
          code: '55P03',
        });
      } finally {
        await locked.commit();
      }
      expect(await budgets()).toEqual(before);
      expect(
        await f.db`select metric from allrice_runtime_reservations where operation_id=${operationId} and observation_id is not null`,
      ).toHaveLength(0);
      await Promise.all(
        receipts.flatMap((receipt) => [
          f.ledger.settleUsage(receipt),
          f.ledger.settleUsage(receipt),
          f.ledger.settleUsage(receipt),
        ]),
      );
      const once = await budgets();
      await Promise.all(
        receipts.map((receipt) => f.ledger.settleUsage(receipt)),
      );
      expect(await budgets()).toEqual(once);
      const settled =
        await f.db`select metric,settled_amount from allrice_runtime_reservations where operation_id=${operationId}`;
      expect(
        Object.fromEntries(
          settled.map((row) => [row.metric, Number(row.settled_amount)]),
        ),
      ).toEqual(amounts);
      for (const metric of metrics) {
        expect(
          Number(once.find((row) => row.metric === metric)!.spent) -
            Number(before.find((row) => row.metric === metric)!.spent),
        ).toBe(amounts[metric]);
        expect(
          Number(once.find((row) => row.metric === metric)!.reserved),
        ).toBe(0);
      }
      await expect(
        f.ledger.settleUsage({
          ...receipts[0]!,
          observation: { ...receipts[0]!.observation, amount: 2 },
        }),
      ).rejects.toThrow('receipt_conflict');
      expect(await budgets()).toEqual(once);
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
