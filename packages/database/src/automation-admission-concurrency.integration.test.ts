import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import {
  claimNextJob,
  failClaimedJobStart,
  startClaimedJob,
} from './execution/queue.ts';
import { lockNativeOnceJobAdmission } from './native-schedule-once-authority.ts';
import {
  nativeOnceDigest,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import {
  createRecurringTask,
  dispatchNextNativeRecurringOccurrence,
  initializeNativeRecurringPartition,
  lockNativeRecurringAdmissions,
} from './native-schedule-recurring-product.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import type {
  NativeRecurringMutation,
  NativeRecurringSnapshot,
  NativeRecurringTask,
} from './native-schedule-recurring-state.ts';
import { createChatSession } from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

function signal<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A setup failure may reject before the other backend reaches its barrier.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function backendPid(tx: TransactionSql) {
  const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
  return row!.pid;
}

async function blockedBy(
  observer: TransactionSql,
  waitingPid: number,
  blockerPid: number,
) {
  expect(waitingPid).not.toBe(blockerPid);
  await expect
    .poll(
      async () => {
        const [row] = await observer<{ blocked: boolean }[]>`
          select ${blockerPid}::integer=any(pg_blocking_pids(${waitingPid}::integer)) blocked`;
        return row!.blocked;
      },
      { timeout: 2000, interval: 10 },
    )
    .toBe(true);
}

async function completeBoth(work: readonly Promise<unknown>[]) {
  // Await both commits/rollbacks before closing or reusing the isolated schema.
  const results = await Promise.allSettled(work);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
}

suite('automation admission and page polling — isolated PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
  let root: string;
  let store: ReturnType<typeof createNativeRecurringSqlStore>;
  let writer: NativeOnceWriter;

  beforeAll(async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
    // The existing fixture requires the dedicated ALLRICE_TEST_DATABASE_URL,
    // rejects ambient DATABASE_URL, and owns a fresh fully migrated p25 schema.
    f = await createP27CodexWorkerFixture({
      allowCiDatabase: true,
      personalProfile: 'writable',
    });
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-admission-locks-')),
    );
    const reference = {
      artifactId: `sha256:${'b'.repeat(64)}`,
      profileId: 'allrice-recurring-control-v1',
      storageId: 'synthetic-sql-only',
      stateRoot: root,
    };
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_REFERENCE', JSON.stringify(reference));
    const { activation } = await initializeNativeRecurringPartition(reference);
    store = createNativeRecurringSqlStore({
      db: f.db,
      partitionId: 'allrice-recurring-v1',
      ownerId: randomUUID(),
      reference,
      ttlMs: 300_000,
      readiness: () => activation,
      decodeTask: (value) => structuredClone(value) as NativeRecurringTask,
      lockAdmission: lockNativeRecurringAdmissions,
      proveClosed: async () => null,
    });
    const grant = await store.acquireWriter();
    expect(grant).not.toBeNull();
    writer = grant!.writer;
  }, 120_000);

  afterAll(async () => {
    try {
      await f?.close();
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 30_000);

  async function mutate(mutation: NativeRecurringMutation) {
    expect(await store.renewWriter(writer)).not.toBeNull();
    expect(
      await store.commitMutation(writer, {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      }),
    ).toBe('committed');
  }

  async function scheduledRun(
    conversationMode: 'reuse' | 'new_each_run' = 'reuse',
  ) {
    const session = await createChatSession(f.context, {
      workspaceId: f.workspaceId,
      employeeAssignmentId: f.assignmentId,
      title: 'Admission lock regression',
    });
    const task = await createRecurringTask(f.context, session.id, {
      clientRequestId: randomUUID(),
      name: 'Admission lock regression',
      prompt: 'Synthetic SQL receipt only; never execute business work.',
      rule: { kind: 'every', seconds: 60 },
      conversationMode,
    });
    const [saved] = await f.db<{ snapshot: NativeRecurringSnapshot }[]>`
      select snapshot from allrice_native_recurring_controls where automation_id=${task.id}`;
    const control = saved!.snapshot.control;
    await mutate({
      kind: 'session_initializing',
      controlId: control.controlId,
    });
    await mutate({ kind: 'session_ready', controlId: control.controlId });
    const native: NativeRecurringTask = {
      sessionId: control.controlSessionId,
      status: 'active',
      record: {
        id: randomUUID(),
        kind: 'every',
        everySeconds: 60,
        title: 'AllRice once control',
        prompt: 'Synthetic schedule control only. Never execute business work.',
        scheduledAt: new Date(Date.now() - 180_000).toISOString(),
      },
    };
    await mutate({
      kind: 'put_task',
      controlId: control.controlId,
      task: native,
    });
    await mutate({
      kind: 'confirm_command',
      controlId: control.controlId,
      commandId: control.command.id,
      nativeTaskId: native.record.id,
    });
    // Synthetic native receipt through the production SQL store and dispatcher;
    // no Host timer, Worker handler, model or external service runs in this suite.
    const delivery = {
      scheduledAt: native.record.scheduledAt,
      deliveredAt: new Date().toISOString(),
      messageId: randomUUID(),
    };
    native.lastDelivery = delivery;
    native.deliveryHistory = {
      records: [{ ...delivery, prompt: native.record.prompt }],
      earlierRecordsUnavailable: false,
    };
    native.record.scheduledAt = new Date(
      Date.parse(delivery.scheduledAt) + 60_000,
    ).toISOString();
    await mutate({
      kind: 'put_task',
      controlId: control.controlId,
      task: native,
    });
    expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
      true,
    );
    const [row] = await f.db<
      {
        run_id: string;
        job_id: string;
        target_session_id: string;
        proof: boolean;
        conversation_snapshot: unknown;
      }[]
    >`
      select ar.run_id,j.id job_id,ar.session_id target_session_id,ar.conversation_snapshot,
        allrice_automation_conversation_handoff_proved(ar.id) proof
      from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id
      where ar.automation_id=${task.id}`;
    expect(row).toMatchObject({
      proof: true,
      conversation_snapshot: {
        mode: conversationMode,
        sourceSessionId: session.id,
        targetSessionId: row!.target_session_id,
        trigger: { kind: 'scheduled', nativeKind: 'recurring' },
      },
    });
    if (conversationMode === 'reuse')
      expect(row!.target_session_id).toBe(session.id);
    else expect(row!.target_session_id).not.toBe(session.id);
    return row!;
  }

  it.each(['reuse', 'new_each_run'] as const)(
    '%s page polling releases its Run SHARE while admission advances the same Run',
    async (conversationMode) => {
      const run = await scheduledRun(conversationMode);
      const pageLocked = signal<number>(),
        admissionLocked = signal<number>();
      // Pin the observed page Run -> identity order before invoking the unchanged
      // production query. This avoids depending on the local PostgreSQL join plan.
      const pageDb = new Proxy(f.db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return (work: (tx: TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) => {
              await tx`set local lock_timeout='5s'`;
              await tx`set local statement_timeout='10s'`;
              const pid = await backendPid(tx);
              await tx`select id from allrice_runs where id=${run.run_id} for share`;
              pageLocked.resolve(pid);
              await blockedBy(tx, await admissionLocked.promise, pid);
              return work(tx);
            });
        },
      });
      const page = listCloudRuntimeOperations(
        f.context,
        run.run_id,
        pageDb,
      ).catch((error: unknown) => {
        pageLocked.reject(error);
        throw error;
      });
      const admission = f.db
        .begin(async (tx) => {
          await pageLocked.promise;
          expect(await lockNativeOnceJobAdmission(tx, run.job_id)).toEqual({
            scheduled: true,
            runId: run.run_id,
            allowed: true,
          });
          admissionLocked.resolve(await backendPid(tx));
          // The queue's next non-key Run update must wait for the page, without
          // making that page wait on an incompatible admission identity lock.
          const updated = await tx`
          update allrice_runs set state='running',started_at=clock_timestamp()
          where id=${run.run_id} and state='queued' returning id`;
          expect(updated).toHaveLength(1);
        })
        .catch((error: unknown) => {
          admissionLocked.reject(error);
          throw error;
        });
      await completeBoth([page, admission]);
      expect(await page).toEqual([]);
      const [stored] =
        await f.db`select state from allrice_runs where id=${run.run_id}`;
      expect(stored?.state).toBe('running');
    },
    15_000,
  );

  it.each(['user', 'membership'] as const)(
    '%s revocation waits for admitted work and denies the next admission',
    async (kind) => {
      const run = await scheduledRun();
      const admissionLocked = signal<number>(),
        revokerStarted = signal<number>();
      const admission = f.db
        .begin(async (tx) => {
          expect(await lockNativeOnceJobAdmission(tx, run.job_id)).toEqual({
            scheduled: true,
            runId: run.run_id,
            allowed: true,
          });
          const pid = await backendPid(tx);
          admissionLocked.resolve(pid);
          await blockedBy(tx, await revokerStarted.promise, pid);
        })
        .catch((error: unknown) => {
          admissionLocked.reject(error);
          throw error;
        });
      const revocation = f.db
        .begin(async (tx) => {
          await tx`set local lock_timeout='5s'`;
          await tx`set local statement_timeout='10s'`;
          await admissionLocked.promise;
          revokerStarted.resolve(await backendPid(tx));
          const updated =
            kind === 'user'
              ? await tx`update allrice_users set status='disabled' where id=${f.ownerId} returning id`
              : await tx`update allrice_memberships set active=false
                  where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId} returning id`;
          expect(updated).toHaveLength(1);
        })
        .catch((error: unknown) => {
          revokerStarted.reject(error);
          throw error;
        });
      try {
        await completeBoth([admission, revocation]);
        expect(
          await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, run.job_id)),
        ).toEqual({ scheduled: true, runId: run.run_id, allowed: false });
        await expect(
          listCloudRuntimeOperations(f.context, run.run_id, f.db),
        ).rejects.toMatchObject({ code: 'run_not_owned' });
      } finally {
        if (kind === 'user')
          await f.db`update allrice_users set status='active' where id=${f.ownerId}`;
        else
          await f.db`update allrice_memberships set active=true
            where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
      }
    },
    15_000,
  );

  it('admission waiting behind user revocation rereads the committed authority', async () => {
    const run = await scheduledRun();
    const revocationLocked = signal<number>(),
      admissionStarted = signal<number>();
    const revocation = f.db
      .begin(async (tx) => {
        await tx`set local lock_timeout='5s'`;
        await tx`set local statement_timeout='10s'`;
        const updated = await tx`
          update allrice_users set status='disabled' where id=${f.ownerId} returning id`;
        expect(updated).toHaveLength(1);
        const pid = await backendPid(tx);
        revocationLocked.resolve(pid);
        await blockedBy(tx, await admissionStarted.promise, pid);
      })
      .catch((error: unknown) => {
        revocationLocked.reject(error);
        throw error;
      });
    const admission = f.db
      .begin(async (tx) => {
        await revocationLocked.promise;
        admissionStarted.resolve(await backendPid(tx));
        return lockNativeOnceJobAdmission(tx, run.job_id);
      })
      .catch((error: unknown) => {
        admissionStarted.reject(error);
        throw error;
      });
    try {
      await completeBoth([revocation, admission]);
      expect(await admission).toEqual({
        scheduled: true,
        runId: run.run_id,
        allowed: false,
      });
    } finally {
      await f.db`update allrice_users set status='active' where id=${f.ownerId}`;
    }
  }, 15_000);

  async function claimedScheduledRun() {
    // Earlier lock-only cases intentionally never run a queue consumer. Remove
    // those fixture candidates before claiming this case's real scheduled Job.
    await f.db`update allrice_jobs set status='canceled' where status='queued'`;
    const run = await scheduledRun();
    const workerId = randomUUID();
    const job = await claimNextJob(workerId, 30_000);
    expect(job?.id).toBe(run.job_id);
    expect(job?.lease?.token).toBeTypeOf('string');
    return {
      run,
      job: job!,
      worker: { workerId, jobId: job!.id, leaseToken: job!.lease!.token },
    };
  }

  async function startDeadlock(runId: string, always: boolean) {
    // These identifiers and the UUID literal are generated by this fixture.
    // A sequence survives transaction rollback and counts real start retries.
    const suffix = runId.replaceAll('-', '');
    const sequence = `admission_start_attempts_${suffix}`;
    const fault = `admission_start_fault_${suffix}`;
    await f.db.unsafe(`create sequence "${sequence}"`);
    await f.db.unsafe(`
      create function "${fault}"() returns trigger language plpgsql as $$
      declare attempt_count bigint;
      begin
        if new.id='${runId}'::uuid and new.state='running' then
          attempt_count := nextval('${f.schema}.${sequence}'::regclass);
          if attempt_count=1 or ${always} then
            raise exception 'synthetic admission deadlock' using errcode='40P01';
          end if;
        end if;
        return new;
      end
      $$;
      create trigger "${fault}" before update of state on allrice_runs
        for each row execute function "${fault}"();
    `);
    return async () => {
      const [row] = await f.db<{ attempts: number }[]>`
        select last_value::integer attempts from ${f.db(sequence)}`;
      return row!.attempts;
    };
  }

  it('real scheduled start retries a rolled-back 40P01 with the same claim and one start receipt', async () => {
    const { run, job, worker } = await claimedScheduledRun();
    const attempts = await startDeadlock(run.run_id, false);
    const execution = await startClaimedJob(
      worker.workerId,
      worker.jobId,
      worker.leaseToken,
    );
    expect(await attempts()).toBe(2);
    expect(execution?.job).toMatchObject({
      id: job.id,
      attempt: job.attempt,
      status: 'running',
      lease: { token: worker.leaseToken },
    });
    const [persisted] = await f.db`
      select status,attempt,lease_token from allrice_jobs where id=${job.id}`;
    expect(persisted).toMatchObject({
      status: 'running',
      attempt: job.attempt,
      lease_token: worker.leaseToken,
    });
    const events = await f.db`
      select payload from allrice_run_events where run_id=${run.run_id} and event_type='run.started'`;
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      jobId: job.id,
      workerId: worker.workerId,
      attempt: job.attempt,
    });
    const audits = await f.db`
      select decision from allrice_audit_events
      where resource_type='job' and resource_id=${job.id} and action='job.execute'`;
    expect(audits).toEqual([expect.objectContaining({ decision: 'allowed' })]);
  }, 15_000);

  it('real scheduled start preserves 40P01 after five rollbacks and settles the original claimed Job', async () => {
    const { run, job, worker } = await claimedScheduledRun();
    const attempts = await startDeadlock(run.run_id, true);
    await expect(
      startClaimedJob(worker.workerId, worker.jobId, worker.leaseToken),
    ).rejects.toMatchObject({ code: '40P01' });
    expect(await attempts()).toBe(5);
    const [before] = await f.db`
      select status,attempt,lease_token from allrice_jobs where id=${job.id}`;
    expect(before).toMatchObject({
      status: 'claimed',
      attempt: job.attempt,
      lease_token: worker.leaseToken,
    });
    expect(
      await f.db`select id from allrice_run_events where run_id=${run.run_id} and event_type='run.started'`,
    ).toHaveLength(0);
    expect(
      await f.db`select id from allrice_audit_events
        where resource_type='job' and resource_id=${job.id} and action='job.execute'`,
    ).toHaveLength(0);
    await failClaimedJobStart(worker);
    const [after] = await f.db`
      select status,attempt,lease_token,last_error_code from allrice_jobs where id=${job.id}`;
    expect(after).toMatchObject({
      status: 'failed',
      attempt: job.attempt,
      lease_token: null,
      last_error_code: 'JOB_START_DEADLOCK',
    });
    const [storedRun] = await f.db`
      select state,started_at,error_code from allrice_runs where id=${run.run_id}`;
    expect(storedRun).toMatchObject({
      state: 'failed',
      started_at: null,
      error_code: 'JOB_START_DEADLOCK',
    });
    const failed = await f.db`
      select payload from allrice_run_events where run_id=${run.run_id} and event_type='run.failed'`;
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      code: 'JOB_START_DEADLOCK',
      sqlState: '40P01',
      phase: 'admission',
      attempt: job.attempt,
      transactionAttempts: 5,
    });
    expect(await attempts()).toBe(5);
  }, 15_000);
});
