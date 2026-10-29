/** Real runner + PostgreSQL: shutdown cannot leave a heartbeat retry renewing
 * a job after its handler and runner have returned. No native/model process. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { runClaimedJob } from '../../src/job-runner.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
suite('MET-210 runner closes heartbeat retries', () => {
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    database = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.close();
  });
  it.each(['attempt', 'revalidation'] as const)(
    'returns during %s and never retries the blocked heartbeat afterwards',
    async (phase) => {
      const f = await createRunAuthorityFixture(database.db);
      const [employee] =
        await f.db`select * from allrice_employee_runs where run_id=${f.rootRunId}`;
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
      await f.db`update allrice_jobs set status='claimed',attempt=1,payload=${f.db.json(payload)},
      lease_expires_at=clock_timestamp()+interval '30 seconds' where id=${f.worker.jobId}`;
      const entered = gate(),
        leave = gate(),
        locked = gate(),
        unlock = gate(),
        tableLocked = gate(),
        tableUnlock = gate();
      let stopping = false;
      let handlerCalls = 0;
      let holder: Promise<unknown> | undefined;
      let tableHolder: Promise<unknown> | undefined;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const running = runClaimedJob(
        {
          ...f.worker,
          leaseMs: 30_000,
          heartbeatMs: 100,
          executionRoot: join(database.storageRoot, randomUUID()),
          stopping: () => stopping,
          onAbortReady: () => {},
        },
        async () => {
          handlerCalls++;
          entered.release();
          await leave.promise;
          return { answer: 'synthetic' };
        },
      );
      void running.catch(() => {});
      try {
        await Promise.race([
          entered.promise,
          running.then(() => {
            throw Error('handler_not_entered');
          }),
        ]);
        let pid = 0;
        holder = f.db.begin(async (tx) => {
          const [row] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() pid`;
          pid = row!.pid;
          await tx`select pg_advisory_xact_lock(hashtextextended(${f.rootRunId},703))`;
          locked.release();
          await unlock.promise;
        });
        await locked.promise;
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
        const [before] =
          await f.db`select heartbeat_at,lease_expires_at from allrice_jobs where id=${f.worker.jobId}`;
        if (phase === 'revalidation') {
          let tablePid = 0;
          tableHolder = f.db.begin(async (tx) => {
            await tx`lock table allrice_jobs in access exclusive mode`;
            const [row] = await tx<
              { pid: number }[]
            >`select pg_backend_pid() pid`;
            tablePid = row!.pid;
            tableLocked.release();
            await tableUnlock.promise;
          });
          await tableLocked.promise;
          await expect
            .poll(
              async () => {
                const [row] =
                  await f.db`select count(*)::int n from pg_stat_activity where ${tablePid}=any(pg_blocking_pids(pid))`;
                return row!.n;
              },
              { timeout: 3_000, interval: 25 },
            )
            .toBe(1);
        }
        stopping = true;
        leave.release();
        await running;
        // The runner may return by its 5 s heartbeat join before the blocked
        // attempt or lease read ends. Wait for the retry loop's own decision
        // instead of for time, with both competing locks STILL held. (During
        // revalidation the lease read always ends here by its own timeout:
        // the table lock outlives it.)
        const records = () =>
          [...warn.mock.calls, ...error.mock.calls]
            .filter(
              ([tag]) =>
                tag === '[MET-210] Worker lease transaction rolled back',
            )
            .map(([, data]) => data as Record<string, unknown>);
        const heartbeat = () =>
          records().filter((r) => r.site === 'job_heartbeat');
        await expect
          .poll(() => heartbeat().length, { timeout: 15_000, interval: 25 })
          .toBe(1);
        expect(heartbeat()).toMatchObject([
          {
            jobId: f.worker.jobId,
            attempt: 1,
            outcome: 'aborted',
          },
        ]);
        // Decided with the runner gone: no new attempt queues on 703.
        const [activity] =
          await f.db`select count(*)::int n from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`;
        expect(activity!.n).toBe(0);
        tableUnlock.release();
        await tableHolder;
        unlock.release();
        await holder;
        // A lease read cut off by its own timeout is diagnostics only; it
        // never turns into a retry.
        expect(
          records().every(
            (r) =>
              r.site === 'job_heartbeat' ||
              (r.site === 'lease_read' && r.outcome === 'failed'),
          ),
        ).toBe(true);
        expect(records().some((r) => r.outcome === 'retrying')).toBe(false);
        const [after] =
          await f.db`select status,heartbeat_at,lease_expires_at from allrice_jobs where id=${f.worker.jobId}`;
        expect(after).toMatchObject({ ...before, status: 'running' });
        expect(handlerCalls).toBe(1);
      } finally {
        stopping = true;
        leave.release();
        tableUnlock.release();
        unlock.release();
        await tableHolder;
        await holder;
        await running;
        warn.mockRestore();
        error.mockRestore();
      }
    },
    30_000,
  );
});
