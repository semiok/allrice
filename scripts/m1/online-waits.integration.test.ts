import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ExecutionContextSchema, HarnessEventSchema } from '@allrice/contracts';
import * as client from '../../packages/database/src/core/client.ts';
import { appendJobEvent } from '../../packages/database/src/execution/queue.ts';
import { normalizeHarnessRunEvent } from '../../apps/worker/src/harness/runtime-contract.ts';
import {
  createRuntimeFixtureDatabase,
  runFixture,
} from '../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../packages/database/src/run-authority.fixture.ts';
import { bindNativeQuestionFixture } from '../../packages/database/src/native-question-binding.fixture.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
} from '../../packages/database/src/providers/dsh-runtime-close-observations.ts';
import { replaceWorkerDshRuntimeInventory } from '../../packages/database/src/providers/dsh-runtime-registry.ts';
import { recordWorkerOperations } from '../../packages/database/src/operations-resources.ts';
import { recordTaskQuestion } from '../../packages/database/src/task-clock.ts';
import { createTaskProgressRuntime } from '../../packages/database/src/task-progress.ts';
import { resolveTaskRuntimePolicy } from '../../packages/database/src/task-runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const monitorPath = fileURLToPath(new URL('./monitor', import.meta.url));

// Invoke the actual standard-library monitor and psql against only our schema.
// Its database user, URL and binary are supplied by m5-test/CI, never Dev config.
const collectPython = String.raw`
import json, os, re, runpy, tempfile
m = runpy.run_path(os.environ['ALLRICE_MONITOR_TEST_MODULE'])
schema = os.environ['ALLRICE_MONITOR_TEST_SCHEMA']
assert re.fullmatch(r'p25_[a-f0-9]{32}', schema)
with tempfile.TemporaryDirectory(prefix='monitor-sql-') as tmp:
    cfg = json.loads(json.dumps(m['M1']))
    cfg.update(stateDir=tmp, psql=os.environ['ALLRICE_MONITOR_TEST_PSQL'],
               databaseUrl=os.environ['ALLRICE_TEST_DATABASE_URL'])
    r = m['Round'](cfg)
    original = r.psql
    r.psql = lambda sql, *args, **kw: original('set search_path to "' + schema + '";\n' + sql, *args, **kw)
    assert r.psql('show default_transaction_read_only', cfg['databaseUrl']) == 'on'
    print(json.dumps(m['online_wait_snapshot'](r)))
`;

type Snapshot = {
  checked_at: string;
  online_runs: number | null;
  occupied_slots: number | null;
  total_slots: number | null;
  occupancy_pct: number | null;
  samples: string[] | null;
  unclassified_runs?: number;
  confirmed_online_runs: number | null;
  confirmed_occupied_slots: number | null;
  possible_online_runs: number | null;
  possible_occupied_slots: number | null;
  uncertain_reasons?: string[];
  unknown_reasons: string[];
  capacity_workers: {
    worker_id: string;
    concurrency: number;
    observed_at: string;
  }[];
};

suite('MET-222 online human waits through real monitor SQL', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let schema: string;
  let psql: string;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const [row] = await fixture.db`select current_schema() name`;
    schema = row!.name;
    psql = execFileSync('/usr/bin/which', ['psql'], {
      encoding: 'utf8',
    }).trim();
  }, 120000);
  beforeEach(async () => {
    // Every relation below belongs to this random schema. Retire prior leases,
    // leaving their old questions to prove that history cannot inflate counts.
    await fixture.db`update allrice_jobs set status='succeeded'`;
    await fixture.db`delete from allrice_runtime_metadata where starts_with(key,'worker-operations:')`;
    await fixture.db`delete from allrice_settings where scope_type='system' and scope_id is null and key='native_question_mode'`;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });

  const collect = (): Snapshot =>
    JSON.parse(
      execFileSync('python3', ['-c', collectPython], {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          ALLRICE_MONITOR_TEST_MODULE: monitorPath,
          ALLRICE_MONITOR_TEST_SCHEMA: schema,
          ALLRICE_MONITOR_TEST_PSQL: psql,
        },
      }),
    );

  async function report(workerId: string, concurrency = 4) {
    await recordWorkerOperations(
      {
        workerId,
        hostname: 'same-physical-host',
        platform: 'darwin',
        capacity: {
          mode: 'configured',
          concurrency,
          cpus: 10,
          memoryBytes: 16 * 1024 ** 3,
        },
        availableMemoryBytes: 8 * 1024 ** 3,
        rssBytes: 256 * 1024 ** 2,
        sandbox: null,
        sandboxStatus: 'disabled',
        // This is global pressure, repeated by each Worker. It is not slots.
        pressure: {
          jobs: { queued: 5, active: 29, longest_wait_ms: 500 },
          resources: { waiting: 9, executing: 3 },
          blocked: [],
        },
      },
      fixture.db,
    );
  }

  async function clock(f: Awaited<ReturnType<typeof runFixture>>) {
    await fixture.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy,phase)
      values(${f.task.runId},${f.task.scope.organizationId},${f.task.scope.workspaceId},
        ${fixture.db.json({ ...resolveTaskRuntimePolicy([]) })},'waiting')`;
  }

  async function notice(
    f: Awaited<ReturnType<typeof runFixture>>,
    questionId: string,
    pending: boolean,
  ) {
    await fixture.db.begin((tx) =>
      recordTaskQuestion(tx, f.task.runId, {
        source: 'dsh',
        sourceEventType: pending
          ? 'session/user-question'
          : 'session/user-question-answered',
        nativePayload: { questionId },
      }),
    );
  }

  async function context(owned = true) {
    const f = await createRunAuthorityFixture(fixture.db, { configure: false });
    await clock(f);
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    const thread = `dsh-${f.session}`;
    await bindNativeQuestionFixture(fixture.db, f.rootRunId, thread);
    const [cr] =
      await fixture.db`select cr.thread_generation,e.assistant_message_id from allrice_conversation_runtimes cr
        join allrice_employee_runs e on e.session_id=cr.session_id where e.run_id=${f.rootRunId}`;
    const runtimeId = randomUUID();
    const owner = owned
      ? await reserveDshRuntimeOwner({
          version: 1,
          kind: 'owned',
          runtimeId,
          workerBootId: randomUUID(),
          workerId: f.worker.workerId,
          serviceManifestDigest: `sha256:${'a'.repeat(64)}`,
          artifactId: `sha256:${'b'.repeat(64)}`,
          profileId: 'restricted',
          context: {
            kind: 'context',
            contextKind: 'chat',
            contextId: f.session,
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
          },
          observedAt: new Date().toISOString(),
        })
      : null;
    await replaceWorkerDshRuntimeInventory({
      workerId: f.worker.workerId,
      runtimes: [
        {
          id: runtimeId,
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: f.session,
          threadId: thread,
          providerRoute: 'synthetic',
          model: 'never-called',
          reasoningEffort: 'low',
          profileFingerprint: 'a'.repeat(64),
          nativeTools: [],
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
        },
      ],
    });
    await report(f.worker.workerId);
    return {
      ...f,
      thread,
      runtimeId,
      owner,
      messageId: cr!.assistant_message_id,
      threadGeneration: Number(cr!.thread_generation),
    };
  }

  type Context = Awaited<ReturnType<typeof context>>;
  let order = 0;
  // Contract inputs traverse the real Harness schema, normalizer and leased
  // Worker append transaction. Host publication/finally is covered by #675.
  async function send(
    f: Context,
    sourceEventType: string,
    sourcePayload: Record<string, unknown>,
    envelope = {},
  ) {
    const event = HarnessEventSchema.parse({
      schemaVersion: 1,
      harness: 'dsh',
      type: 'native.event',
      presentation: 'context',
      status: 'info',
      label: '前台观察',
      generation: f.threadGeneration,
      attempt: 1,
      order: ++order,
      threadId: f.thread,
      turnId: 'synthetic-turn',
      sessionId: f.session,
      messageId: f.messageId,
      sourceEventId: randomUUID(),
      sourceEventType,
      sourcePayload,
      sourceOccurredAt: new Date().toISOString(),
      ...envelope,
    });
    expect(
      await appendJobEvent({ ...f.worker, ...normalizeHarnessRunEvent(event) }),
    ).toBeTruthy();
  }
  async function observe(
    f: Context,
    questionId: string,
    phase: 'opened' | 'ended',
    metadata = {},
    envelope = {},
  ) {
    await send(
      f,
      `allrice/user-question-${phase}`,
      {
        version: 1,
        questionId,
        runId: f.rootRunId,
        nativeSessionId: f.thread,
        rootSessionId: f.thread,
        timed: false,
        runtimeId: f.runtimeId,
        jobId: f.worker.jobId,
        ...metadata,
      },
      envelope,
    );
  }

  async function legacy() {
    const f = await context();
    await notice(f, 'legacy-question', true);
    await observe(f, 'legacy-question', 'opened');
    return f;
  }

  async function native(owned = true) {
    const f = await context(owned);
    await fixture.db`insert into allrice_settings(scope_type,key,value) values('system','native_question_mode','"timed"'::jsonb)`;
    await send(f, 'session/user-questions', {
      sessionId: f.thread,
      sequence: 1,
      questions: {
        active: [
          {
            callId: 'native-call',
            state: 'open',
            questions: [
              {
                id: 'q',
                question: 'DO_NOT_EXPORT_BODY',
                options: [{ label: '继续' }],
              },
            ],
          },
        ],
        settled: [],
      },
    });
    return f;
  }

  it('counts one occupied Run/Job for multiple current questions; an accepted answer drops it once', async () => {
    const f = await legacy();
    await notice(f, 'program-question', true);
    await observe(f, 'program-question', 'opened');
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      total_slots: 4,
      occupancy_pct: 25,
      samples: [f.task.runId],
      unknown_reasons: [],
    });
    await notice(f, 'legacy-question', false);
    await observe(f, 'legacy-question', 'ended');
    expect(collect().occupied_slots).toBe(1);
    await notice(f, 'program-question', false);
    await observe(f, 'program-question', 'ended');
    // Reordered duplicate notices cannot reopen an already answered callback.
    await notice(f, 'program-question', true);
    await observe(f, 'program-question', 'opened');
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      occupancy_pct: 0,
    });
  });

  it('requires current foreground open identity; continued late-answer cards never stand in for a live wait', async () => {
    const f = await native();
    expect(collect()).toMatchObject({ online_runs: 1, occupied_slots: 1 });
    await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
    expect(collect()).toMatchObject({
      online_runs: null,
      confirmed_online_runs: 0,
      unclassified_runs: 1,
      uncertain_reasons: ['missing_or_invalid_observation'],
    });
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    // Coexisting legacy/program projection is not a second slot.
    await notice(f, 'program-question', true);
    expect(collect().occupied_slots).toBe(1);
    await notice(f, 'program-question', false);
    await fixture.db`update allrice_task_clocks set phase='waiting' where run_id=${f.rootRunId}`;
    for (const state of ['continued', 'settled']) {
      await fixture.db`update allrice_native_questions set state=${state} where source_run_id=${f.rootRunId}`;
      for (const phase of ['active', 'waiting']) {
        await fixture.db`update allrice_task_clocks set phase=${phase} where run_id=${f.rootRunId}`;
        expect(collect()).toMatchObject({ online_runs: 0, occupied_slots: 0 });
      }
    }
    await fixture.db`update allrice_native_questions set state='open' where source_run_id=${f.rootRunId}`;
    expect(collect().online_runs).toBe(1);
    await fixture.db`update allrice_task_clocks set phase='active' where run_id=${f.rootRunId}`;
    expect(collect().online_runs).toBe(1); // a foreground question remains while other work runs
    await fixture.db`update allrice_task_clocks set phase='waiting' where run_id=${f.rootRunId}`;
    await fixture.db`update allrice_native_questions set native_present=false where source_run_id=${f.rootRunId}`;
    expect(collect().online_runs).toBe(0);
    await fixture.db`update allrice_native_questions set native_present=true,closed_at=clock_timestamp() where source_run_id=${f.rootRunId}`;
    expect(collect().online_runs).toBe(0);
    await fixture.db`update allrice_native_questions set closed_at=null,native_session_id='old-session' where source_run_id=${f.rootRunId}`;
    expect(collect().online_runs).toBe(0);
    expect(JSON.stringify(collect())).not.toContain('DO_NOT_EXPORT_BODY');
  });

  it('excludes resource/device clocks alone, terminal Runs, expired leases and parked Jobs', async () => {
    const f = await runFixture(fixture.db);
    await clock(f); // waiting alone is also used by device/resource waits
    await report(f.worker.workerId);
    expect(collect()).toMatchObject({ online_runs: 0, occupied_slots: 0 });
    await notice(f, 'legacy-question', true);
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
    expect(collect().occupied_slots).toBe(0);
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '10 minutes' where id=${f.worker.jobId}`;
    await fixture.db`update allrice_runs set state='succeeded' where id=${f.task.runId}`;
    expect(collect().occupied_slots).toBe(0);
    await fixture.db`update allrice_runs set state='waiting_approval' where id=${f.task.runId}`;
    await fixture.db`update allrice_jobs set status='waiting_approval',worker_id=null,lease_token=null,
      claimed_at=null,heartbeat_at=null,lease_expires_at=null where id=${f.worker.jobId}`;
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      total_slots: 4,
    });
  });

  it('adds real per-Worker capacities, ignoring repeated global pressure and stale restart reports', async () => {
    const a = await legacy();
    const b = await legacy();
    await report(b.worker.workerId, 6);
    const old = randomUUID();
    await report(old, 32);
    await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp()-interval '91 seconds' where key=${'worker-operations:' + old}`;
    const row = collect();
    expect(row).toMatchObject({
      online_runs: 2,
      occupied_slots: 2,
      total_slots: 10,
      occupancy_pct: 20,
      unknown_reasons: [],
    });
    expect(row.capacity_workers.map((w) => w.worker_id).sort()).toEqual(
      [a.worker.workerId, b.worker.workerId].sort(),
    );
    expect(Number.isNaN(Date.parse(row.checked_at))).toBe(false);
    expect(
      row.capacity_workers.every((w) =>
        Number.isFinite(Date.parse(w.observed_at)),
      ),
    ).toBe(true);
  });

  it('keeps capacity unknown for missing/stale/illegal reports and an unreported occupied Worker', async () => {
    const f = await legacy();
    const key = 'worker-operations:' + f.worker.workerId;
    await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp()-interval '91 seconds' where key=${key}`;
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      total_slots: null,
      occupancy_pct: null,
    });
    await fixture.db`delete from allrice_runtime_metadata where key=${key}`;
    expect(collect().total_slots).toBeNull();
    for (const value of [
      {},
      {
        workerId: f.worker.workerId,
        capacity: { mode: 'configured', concurrency: 0 },
      },
      {
        workerId: randomUUID(),
        capacity: { mode: 'configured', concurrency: 4 },
      },
    ]) {
      await fixture.db`insert into allrice_runtime_metadata(key,value) values(${key},${fixture.db.json(value)})
        on conflict(key) do update set value=excluded.value,updated_at=clock_timestamp()`;
      expect(collect()).toMatchObject({
        total_slots: null,
        occupancy_pct: null,
      });
    }
    await report(f.worker.workerId);
    const unreported = await runFixture(fixture.db);
    expect(collect()).toMatchObject({ total_slots: null, occupancy_pct: null });
    await report(unreported.worker.workerId);
    expect(collect()).toMatchObject({
      total_slots: 8,
      occupancy_pct: 12.5,
      unknown_reasons: [],
    });
    // A fresh malformed additional report must not silently disappear from the denominator.
    await fixture.db`insert into allrice_runtime_metadata(key,value) values('worker-operations:malformed','{}')`;
    expect(collect().total_slots).toBeNull();
  });

  it('returns unknown for a missing physical owner or an unreadable source; clock is not proof', async () => {
    await native(false);
    expect(collect()).toMatchObject({
      online_runs: null,
      occupied_slots: null,
      total_slots: 4,
      occupancy_pct: null,
      unclassified_runs: 1,
    });
    await fixture.db`alter table allrice_native_questions rename to hidden_native_questions`;
    try {
      const row = collect();
      expect(row).toMatchObject({
        online_runs: null,
        occupied_slots: null,
        total_slots: null,
        occupancy_pct: null,
      });
      expect(row.unknown_reasons.join(' ')).toContain('采集失败');
    } finally {
      await fixture.db`alter table hidden_native_questions rename to allrice_native_questions`;
    }
  });

  it('counts a normal legacy foreground with active progress and drops only on matching ended', async () => {
    const f = await legacy();
    const [policy] =
      await fixture.db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
    const executionContext = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: f.rootRunId,
      jobId: f.worker.jobId,
      worker: { type: 'worker', id: f.worker.workerId },
      delegatedBy: f.context.actor,
      organizationId: f.org,
      workspaceId: f.workspace,
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: f.policy,
        organizationId: f.org,
        subjectId: f.user,
        version: 1,
        issuedAt: policy!.issued_at.toISOString(),
        expiresAt: policy!.expires_at.toISOString(),
        ...policy!.payload,
      },
    });
    const progress = createTaskProgressRuntime(
      { context: executionContext, worker: f.worker, sessionId: f.session },
      fixture.db,
    );
    await progress({
      action: 'start',
      nativeSessionId: f.thread,
      callId: 'login-cloud-call',
      kind: 'tool',
      name: 'cloud_mcp_call',
      argumentsDigest: `sha256:${'c'.repeat(64)}`,
    });
    await progress({
      action: 'start',
      nativeSessionId: `${f.thread}-child`,
      callId: 'child-model',
      kind: 'model',
    });
    const [c] =
      await fixture.db`select phase from allrice_task_clocks where run_id=${f.rootRunId}`;
    expect(c!.phase).toBe('active');
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      occupancy_pct: 25,
      unknown_reasons: [],
    });
    await notice(f, 'legacy-question', false);
    expect(collect()).toMatchObject({
      online_runs: null,
      uncertain_reasons: ['question_projection_conflict'],
    });
    await observe(f, 'legacy-question', 'ended');
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      occupancy_pct: 0,
      unknown_reasons: [],
    });
  });

  it('does not turn an elapsed timed deadline into closure; ended prevents stale program pending from inflating resource waits', async () => {
    const f = await context();
    await notice(f, 'program-question', true);
    const timed = {
      timed: true,
      deadlineAt: new Date(Date.now() - 60000).toISOString(),
      releaseLimited: true,
    };
    await observe(f, 'program-question', 'opened', timed);
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      unknown_reasons: [],
    });
    await observe(f, 'program-question', 'ended', timed);
    const [q] =
      await fixture.db`select pending from allrice_task_questions where run_id=${f.rootRunId}`;
    expect(q!.pending).toBe(true); // actual askTimed timeout leaves this older projection
    await fixture.db`update allrice_task_clocks set phase='waiting' where run_id=${f.rootRunId}`;
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      occupancy_pct: 0,
      unknown_reasons: [],
    });
  });

  it('does not inherit old attempt, generation, current Run or Worker observations', async () => {
    const f = await legacy();
    await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
    expect(collect()).toMatchObject({ online_runs: 0, unclassified_runs: 0 });
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
    expect(collect()).toMatchObject({ online_runs: 0, unclassified_runs: 0 });
    const currentRun = randomUUID();
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      select ${currentRun},organization_id,workspace_id,owner_id,'running','{}','{}' from allrice_runs where id=${f.rootRunId}`;
    await fixture.db`update allrice_conversation_runtimes set thread_generation=${f.threadGeneration},active_run_id=${currentRun} where session_id=${f.session}`;
    expect(collect().online_runs).toBe(0);
    await fixture.db`update allrice_conversation_runtimes set active_run_id=${f.rootRunId},worker_id=${randomUUID()} where session_id=${f.session}`;
    expect(collect().online_runs).toBe(0);
  });

  it('requires exact live inventory and lets physical closure override a still-fresh inventory', async () => {
    const f = await legacy();
    await fixture.db`update allrice_dsh_runtime_instances set last_seen_at=clock_timestamp()-interval '16 seconds' where id=${f.runtimeId}`;
    expect(collect()).toMatchObject({
      online_runs: null,
      confirmed_online_runs: 0,
      possible_online_runs: 1,
      uncertain_reasons: ['runtime_evidence_missing_or_stale'],
    });
    await fixture.db`update allrice_dsh_runtime_instances set last_seen_at=clock_timestamp() where id=${f.runtimeId}`;
    const owner = f.owner!;
    await recordDshRuntimeCloseObservation(owner, {
      version: 1,
      runtimeId: f.runtimeId,
      workerBootId: owner.owner.workerBootId,
      ownerDigest: owner.ownerDigest,
      kind: 'close_started',
      observedAt: new Date().toISOString(),
    });
    expect(collect()).toMatchObject({ online_runs: 1, unknown_reasons: [] });
    await recordDshRuntimeCloseObservation(owner, {
      version: 1,
      runtimeId: f.runtimeId,
      workerBootId: owner.owner.workerBootId,
      ownerDigest: owner.ownerDigest,
      kind: 'process_closed',
      observedAt: new Date().toISOString(),
      fact: {
        source: 'child_close',
        stdioClosed: true,
        exitCode: 0,
        signal: null,
        terminationAttempted: null,
      },
    });
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      unknown_reasons: [],
    });
  });

  it('keeps uncovered legacy pending and invalid observation versions unknown; unknown ended is not authoritative', async () => {
    const f = await context();
    await notice(f, 'legacy-question', true);
    expect(collect()).toMatchObject({
      online_runs: null,
      occupied_slots: null,
      confirmed_occupied_slots: 0,
      possible_occupied_slots: 1,
      uncertain_reasons: ['missing_or_invalid_observation'],
    });
    await observe(f, 'legacy-question', 'ended', { version: 2 });
    expect(collect()).toMatchObject({
      online_runs: null,
      possible_online_runs: 1,
    });
  });

  it('distinguishes native continued late answers from a current callback and never reopens an ended request', async () => {
    const f = await native();
    const questionId = `${f.thread}:native-call`;
    await observe(f, questionId, 'opened', { timed: true });
    expect(collect().online_runs).toBe(1);
    await send(f, 'session/user-questions', {
      sessionId: f.thread,
      sequence: 2,
      questions: {
        active: [
          {
            callId: 'native-call',
            state: 'continued',
            questions: [
              {
                id: 'q',
                question: 'DO_NOT_EXPORT_BODY',
                options: [{ label: '继续' }],
              },
            ],
          },
        ],
        settled: [],
      },
    });
    expect(collect()).toMatchObject({
      online_runs: null,
      confirmed_online_runs: 0,
      uncertain_reasons: ['question_projection_conflict'],
    });
    await observe(f, questionId, 'ended', { timed: true });
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      unknown_reasons: [],
    });
    await fixture.db`update allrice_native_questions set state='settled' where source_run_id=${f.rootRunId}`;
    await observe(f, questionId, 'opened', { timed: true });
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      unknown_reasons: [],
    });
  });

  it('uses trusted foreground observations even when the older pending projection and clock are absent', async () => {
    const f = await context();
    await observe(f, 'foreground-only', 'opened');
    await fixture.db`delete from allrice_task_clock_events where run_id=${f.rootRunId}`;
    await fixture.db`delete from allrice_task_clocks where run_id=${f.rootRunId}`;
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      unknown_reasons: [],
    });
    await observe(f, 'foreground-only', 'ended');
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      unknown_reasons: [],
    });
  });
});
