import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { closeDatabase } from './core/client.ts';
import { cancelRun, failClaimedJobStart } from './execution/queue.ts';
import type { EventRow, JobRow, RunRow } from './queue/row-mappers.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('claimed start failure — isolated PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;

  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
    const [scope] = await database.db<
      { schema: string }[]
    >`select current_schema() as schema`;
    expect(scope!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.searchParams.set('options', `-csearch_path=${scope!.schema},public`);
    vi.stubEnv('DATABASE_URL', url.href);
  }, 120000);

  afterAll(async () => {
    try {
      await closeDatabase();
    } finally {
      try {
        await database?.close();
      } finally {
        vi.unstubAllEnvs();
      }
    }
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
    const policy = resolveTaskRuntimePolicy([
      { scope: 'user', scopeId: f.context.actor.id, timeoutMs: 600000 },
    ]);
    // The synthetic assistant fixture begins running. Rewind only its own
    // Job/Run to the claimed state left by a rolled-back admission transaction.
    await database.db.begin(async (tx) => {
      await tx`update allrice_jobs set status='claimed',attempt=2 where id=${f.worker.jobId}`;
      await tx`update allrice_runs set state='queued',started_at=null where id=${f.task.runId}`;
      await tx`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
        values(${f.task.runId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${tx.json({ ...policy })})`;
    });

    const snapshot = async () => {
      const [jobs, runs, roots, clocks, events, clockEvents] =
        await Promise.all([
          database.db<
            JobRow[]
          >`select * from allrice_jobs where id=${f.worker.jobId}`,
          database.db<
            RunRow[]
          >`select * from allrice_runs where id=${f.task.runId}`,
          database.db`select * from allrice_runtime_roots where root_run_id=${f.task.runId}`,
          database.db`select * from allrice_task_clocks where run_id=${f.task.runId}`,
          database.db<
            EventRow[]
          >`select * from allrice_run_events where run_id=${f.task.runId} order by sequence`,
          database.db`select * from allrice_task_clock_events where run_id=${f.task.runId} order by id`,
        ]);
      return {
        job: jobs[0]!,
        run: runs[0]!,
        root: roots[0]!,
        clock: clocks[0]!,
        events: [...events],
        clockEvents: [...clockEvents],
      };
    };
    const fail = () => failClaimedJobStart(f.worker);
    const cancel = () =>
      cancelRun(f.context, f.context.workspaceId!, f.task.runId, {
        reason: 'user_requested',
      });
    const timeout = async () => {
      const [clock] = await database.db<
        { expired_at: Date }[]
      >`select clock_timestamp()-interval '1 second' as expired_at`;
      // A queued task does not consume active-time budget. Expire its frozen
      // authorization deadline so refreshTaskClock preserves the real timeout.
      await database.db`update allrice_jobs set created_at=clock_timestamp()-interval '1 minute' where id=${f.worker.jobId}`;
      await database.db`update allrice_task_clocks set policy=${database.db.json(
        {
          ...policy,
          authorizationExpiresAt: clock!.expired_at.toISOString(),
        },
      )} where run_id=${f.task.runId}`;
    };
    return { f, snapshot, fail, cancel, timeout };
  }

  it('fails the current claim exactly once without starting or retrying the Run', async () => {
    const s = await setup();
    const before = await s.snapshot();
    expect(before.events).toHaveLength(0);

    await s.fail();

    const after = await s.snapshot();
    expect(after.job).toMatchObject({
      status: 'failed',
      attempt: 2,
      max_attempts: before.job.max_attempts,
      worker_id: null,
      lease_token: null,
      claimed_at: null,
      heartbeat_at: null,
      lease_expires_at: null,
      completed_at: expect.any(Date),
      last_error_code: 'JOB_START_DEADLOCK',
    });
    expect(after.run).toMatchObject({
      state: 'failed',
      started_at: null,
      completed_at: expect.any(Date),
      error_code: 'JOB_START_DEADLOCK',
    });
    expect(after.clock).toMatchObject({
      phase: 'terminal',
      started_at: null,
      completed_at: expect.any(Date),
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      event_type: 'run.failed',
      payload: {
        code: 'JOB_START_DEADLOCK',
        sqlState: '40P01',
        phase: 'admission',
        attempt: 2,
      },
    });
    await expect(s.fail()).rejects.toThrow('lease_lost');
    expect(await s.snapshot()).toEqual(after);
  });

  it('preserves requested cancellation instead of reporting an admission failure', async () => {
    const s = await setup();
    await s.cancel();
    expect((await s.snapshot()).job.status).toBe('claimed');

    await s.fail();

    const after = await s.snapshot();
    expect(after.job).toMatchObject({
      status: 'canceled',
      last_error_code: null,
      lease_token: null,
      drain_deadline_at: null,
    });
    expect(after.run).toMatchObject({
      state: 'canceled',
      error_code: null,
      started_at: null,
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      event_type: 'run.canceled',
      payload: { reason: 'user_requested' },
    });
  });

  it('preserves an expired task deadline instead of reporting an admission failure', async () => {
    const s = await setup();
    await s.timeout();

    await s.fail();

    const after = await s.snapshot();
    expect(after.job).toMatchObject({
      status: 'failed',
      last_error_code: 'JOB_TIMEOUT',
      lease_token: null,
      drain_deadline_at: null,
    });
    expect(after.run).toMatchObject({
      state: 'failed',
      error_code: 'JOB_TIMEOUT',
      started_at: null,
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      event_type: 'run.failed',
      payload: { code: 'JOB_TIMEOUT' },
    });
  });

  it.each([
    'replaced token',
    'replaced worker',
    'expired lease',
    'running Job',
    'queued Job',
  ] as const)(
    'rejects a %s without changing any persisted state',
    async (case_) => {
      const s = await setup();
      if (case_ === 'replaced token')
        await database.db`update allrice_jobs set lease_token=${randomUUID()} where id=${s.f.worker.jobId}`;
      else if (case_ === 'replaced worker')
        await database.db`update allrice_jobs set worker_id=${randomUUID()} where id=${s.f.worker.jobId}`;
      else if (case_ === 'expired lease')
        await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
      else if (case_ === 'running Job') {
        await database.db`update allrice_jobs set status='running' where id=${s.f.worker.jobId}`;
        await database.db`update allrice_runs set state='running',started_at=clock_timestamp() where id=${s.f.task.runId}`;
        await database.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type)
        values(${s.f.task.scope.organizationId},${s.f.task.scope.workspaceId},${s.f.task.runId},0,'run.started')`;
      } else
        await database.db`update allrice_jobs set status='queued',worker_id=null,lease_token=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null where id=${s.f.worker.jobId}`;
      const before = await s.snapshot();

      await expect(s.fail()).rejects.toThrow('lease_lost');

      // This also verifies that the earlier clock/root refresh is rolled back.
      expect(await s.snapshot()).toEqual(before);
    },
  );

  it('rolls back all terminal writes when the original lease expires during the transition', async () => {
    const s = await setup();
    // A sequence increment survives rollback and proves the terminal UPDATE
    // reached this trigger, rather than merely rejecting an already old lease.
    await database.db`create sequence start_failure_terminal_writes`;
    await database.db.unsafe(`
      create function expire_start_failure_lease() returns trigger language plpgsql as $$
      begin
        perform nextval('start_failure_terminal_writes');
        perform pg_sleep(greatest(0, extract(epoch from (old.lease_expires_at-clock_timestamp()))) + 0.05);
        return new;
      end;
      $$
    `);
    await database.db.unsafe(`
      create trigger expire_start_failure_lease before update on allrice_jobs
      for each row when (old.status='claimed' and new.status='failed')
      execute function expire_start_failure_lease()
    `);
    try {
      await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '2 seconds' where id=${s.f.worker.jobId}`;
      const before = await s.snapshot();

      await expect(s.fail()).rejects.toThrow('lease_lost');

      expect(await s.snapshot()).toEqual(before);
      const [trigger] =
        await database.db`select last_value,is_called from start_failure_terminal_writes`;
      expect(trigger!.is_called).toBe(true);
      expect(Number(trigger!.last_value)).toBe(1);
      const [clock] = await database.db<
        { expired: boolean }[]
      >`select clock_timestamp() > ${before.job.lease_expires_at!} as expired`;
      expect(clock!.expired).toBe(true);
    } finally {
      await database.db`drop trigger expire_start_failure_lease on allrice_jobs`;
      await database.db`drop function expire_start_failure_lease()`;
      await database.db`drop sequence start_failure_terminal_writes`;
    }
  }, 15000);
});
