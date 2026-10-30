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
import { ExecutionContextSchema } from '@allrice/contracts';
import * as client from '../../packages/database/src/core/client.ts';
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

// Complete production SQL, collector, CLI and alert reducer, against our schema.
// Never load shared Dev configuration or credentials. Alerts remain in memory.
const collectPython = String.raw`
import copy, json, os, re, runpy, subprocess, sys, tempfile, urllib.parse
m = runpy.run_path(os.environ['ALLRICE_MONITOR_TEST_MODULE'])
schema = os.environ['ALLRICE_MONITOR_TEST_SCHEMA']
assert re.fullmatch(r'p25_[a-f0-9]{32}', schema)
with tempfile.TemporaryDirectory(prefix='monitor-sql-') as tmp:
    cfg = json.loads(json.dumps(m['M1']))
    cfg.update(stateDir=tmp+'/state', psql=os.environ['ALLRICE_MONITOR_TEST_PSQL'],
               databaseUrl=os.environ['ALLRICE_TEST_DATABASE_URL'],
               envFile=tmp+'/missing.env', webPlist=tmp+'/missing-web.plist',
               workerPlist=tmp+'/missing-worker.plist', telegramEnv=tmp+'/missing-telegram.env')
    r = m['Round'](cfg)
    original = r.psql
    r.psql = lambda sql, *args, **kw: original('set search_path to "' + schema + '";\n' + sql, *args, **kw)
    assert r.psql('show default_transaction_read_only', cfg['databaseUrl']) == 'on'
    mode = os.environ['ALLRICE_MONITOR_TEST_MODE']
    if mode == 'raw':
        out = m['biz'](r, m['SQL_ONLINE_WAITS'])
    elif mode == 'cli':
        url = urllib.parse.urlsplit(cfg['databaseUrl'])
        query = urllib.parse.parse_qsl(url.query)
        query.append(('options', '-c search_path='+schema))
        cfg['databaseUrl'] = urllib.parse.urlunsplit(url._replace(
            query=urllib.parse.urlencode(query, quote_via=urllib.parse.quote)))
        config = tmp+'/config.json'
        with open(config, 'w') as f: json.dump(cfg, f)
        command = [sys.executable, os.environ['ALLRICE_MONITOR_TEST_MODULE'],
                   'online-waits', '--config', config]
        out = dict(snapshot=json.loads(subprocess.check_output(command+['--json'], text=True)),
                   text=subprocess.check_output(command, text=True), files=os.listdir(cfg['stateDir']))
    elif mode == 'alerts':
        g = m['check_online_waits'].__globals__
        out = []
        for i, raw in enumerate(json.loads(os.environ['ALLRICE_MONITOR_TEST_INPUT'])):
            g['biz'] = lambda r, sql: copy.deepcopy(raw)
            r.now = i*300
            findings = m['check_online_waits'](r)
            events = m['evaluate'](r, findings)
            out.append(dict(severity=[f['severity'] for f in findings],
                events=[(e['event'],e['finding']['key']) for e in events],
                active=sorted(r.state['alerts'])))
        assert not os.listdir(cfg['stateDir'])
    else:
        out = m['online_wait_snapshot'](r)
    print(json.dumps(out))
`;

type Snapshot = {
  checked_at: string;
  online_runs: number | null;
  occupied_slots: number | null;
  total_slots: number | null;
  occupancy_pct: number | null;
  occupancy_lower_pct: number | null;
  samples: string[] | null;
  unclassified_runs: number;
  confirmed_online_runs: number | null;
  confirmed_occupied_slots: number | null;
  possible_online_runs: number | null;
  possible_occupied_slots: number | null;
  uncertain_reasons: string[] | null;
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
    await fixture.db`update allrice_jobs set status='succeeded'`;
    await fixture.db`delete from allrice_runtime_metadata where starts_with(key,'worker-operations:')`;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });

  const python = <T = Snapshot>(mode = 'snapshot', input: unknown = null): T =>
    JSON.parse(
      execFileSync('python3', ['-c', collectPython], {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          ALLRICE_MONITOR_TEST_MODULE: monitorPath,
          ALLRICE_MONITOR_TEST_SCHEMA: schema,
          ALLRICE_MONITOR_TEST_PSQL: psql,
          ALLRICE_MONITOR_TEST_MODE: mode,
          ALLRICE_MONITOR_TEST_INPUT: JSON.stringify(input),
        },
      }),
    );
  const collect = () => python();

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
      await fixture.db`select thread_generation from allrice_conversation_runtimes where session_id=${f.session}`;
    const runtimeId = randomUUID();
    const bootId = randomUUID();
    const owner = owned
      ? await reserveDshRuntimeOwner({
          version: 1,
          kind: 'owned',
          runtimeId,
          workerBootId: bootId,
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
      bootId,
      owner,
      generation: Number(cr!.thread_generation),
    };
  }

  type Context = Awaited<ReturnType<typeof context>>;
  function contract(f: Context, questions = ['legacy-question']) {
    return {
      version: 1,
      workerBootId: f.bootId,
      scope: 'default_harness_router',
      executions: [
        {
          runtimeId: f.runtimeId,
          rootSessionId: f.thread,
          runId: f.rootRunId,
          jobId: f.worker.jobId,
          attempt: 1,
          generation: f.generation,
          foreground: {
            version: 1,
            sampledAt: new Date().toISOString(),
            rootSessionId: f.thread,
            runId: f.rootRunId,
            complete: true,
            questions: questions.map((questionId) => ({
              questionId,
              runId: f.rootRunId,
              rootSessionId: f.thread,
              nativeSessionId: f.thread,
            })),
          },
        },
      ],
    };
  }

  // Fixed #675 v1 contract fixture. This branch intentionally does not include
  // its producer schema; the real writer above persists capacity, then this
  // explicit fixture supplies the wire JSON to the actual production consumer.
  async function writeOnline(f: Context, value: unknown) {
    await fixture.db`update allrice_runtime_metadata
      set value=jsonb_set(value,'{onlineQuestions}',${fixture.db.json(JSON.parse(JSON.stringify(value)))}),updated_at=clock_timestamp()
      where key=${'worker-operations:' + f.worker.workerId}`;
  }
  async function publish(f: Context, questions = ['legacy-question']) {
    await writeOnline(f, contract(f, questions));
  }
  const unknown = {
    online_runs: null,
    occupied_slots: null,
    confirmed_online_runs: 0,
    confirmed_occupied_slots: 0,
    possible_online_runs: 1,
    possible_occupied_slots: 1,
    unclassified_runs: 1,
  };

  it('counts one Run/Job for multiple foreground questions and drops only on a fresh complete empty sample', async () => {
    const f = await context();
    await notice(f, 'old-pending', true);
    await publish(f, ['legacy-question', 'program-question']);
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      total_slots: 4,
      occupancy_pct: 25,
      samples: [f.rootRunId],
      unknown_reasons: [],
    });
    await publish(f, ['program-question']);
    expect(collect().occupied_slots).toBe(1);
    await publish(f, []);
    // Program timeout may leave pending=true/resource clock waiting. Neither
    // that projection nor an old event can override the real empty foreground.
    const [q] =
      await fixture.db`select pending from allrice_task_questions where run_id=${f.rootRunId}`;
    expect(q!.pending).toBe(true);
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      occupancy_pct: 0,
      unknown_reasons: [],
    });
  });

  it('does not exclude foreground when a cloud tool and child model keep the real progress clock active', async () => {
    const f = await context();
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
      callId: 'cloud',
      kind: 'tool',
      name: 'cloud_mcp_call',
      argumentsDigest: `sha256:${'c'.repeat(64)}`,
    });
    await progress({
      action: 'start',
      nativeSessionId: `${f.thread}-child`,
      callId: 'child',
      kind: 'model',
    });
    const [c] =
      await fixture.db`select phase from allrice_task_clocks where run_id=${f.rootRunId}`;
    expect(c!.phase).toBe('active');
    await publish(f);
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      unknown_reasons: [],
    });
  });

  it('requires current complete coverage even for resource waits, old Hosts and independent adapters', async () => {
    const f = await context();
    expect(collect()).toMatchObject(unknown);
    await writeOnline(f, { ...contract(f), executions: [] });
    expect(collect()).toMatchObject(unknown);
    const extra = await runFixture(fixture.db);
    await report(extra.worker.workerId);
    await fixture.db`update allrice_jobs set payload='{"type":"allrice.experience.consolidate"}' where id=${extra.worker.jobId}`;
    await publish(f, []);
    expect(collect()).toMatchObject({ ...unknown, total_slots: 8 });
    await fixture.db`update allrice_jobs set payload='{"type":"allrice.platform.technical"}' where id=${extra.worker.jobId}`;
    expect(collect()).toMatchObject(unknown);
  });

  it('keeps null, partial, duplicate and malformed foreground unknown instead of deriving from old question tables', async () => {
    const f = await context();
    const base = contract(f);
    const e = base.executions[0]!;
    const fg = e.foreground;
    const variants = [
      null,
      {},
      { ...base, version: 2 },
      { ...base, scope: 'all_adapters' },
      { ...base, executions: {} },
      { ...base, executions: [e, e] },
      ...[
        null,
        {},
        { ...fg, complete: false },
        { ...fg, complete: 'true' },
        { ...fg, version: 2 },
        { ...fg, questions: null },
        { ...fg, questions: [fg.questions[0], fg.questions[0]] },
        ...['runId', 'rootSessionId', 'nativeSessionId', 'questionId'].map(
          (key) => ({
            ...fg,
            questions: [
              {
                ...fg.questions[0],
                [key]: key === 'questionId' ? '' : 'foreign',
              },
            ],
          }),
        ),
      ].map((foreground) => ({ ...base, executions: [{ ...e, foreground }] })),
    ];
    for (const value of variants) {
      await writeOnline(f, value);
      expect(collect(), JSON.stringify(value)).toMatchObject(unknown);
    }
    await publish(f);
    await fixture.db`delete from allrice_task_clock_events where run_id=${f.rootRunId}`;
    await fixture.db`delete from allrice_task_clocks where run_id=${f.rootRunId}`;
    await fixture.db`alter table allrice_native_questions rename to unused_native_questions`;
    try {
      expect(collect()).toMatchObject({
        online_runs: 1,
        occupied_slots: 1,
        unknown_reasons: [],
      });
    } finally {
      await fixture.db`alter table unused_native_questions rename to allrice_native_questions`;
    }
  });

  it('expires foreground independently of refreshed Worker metadata and accepts the next successful complete sample', async () => {
    const f = await context();
    const base = contract(f);
    const e = base.executions[0]!;
    for (const sampledAt of [
      new Date(Date.now() - 91000).toISOString(),
      new Date(Date.now() + 60000).toISOString(),
      'invalid',
      'now',
      '2026-02-30T00:00:00Z',
    ]) {
      await writeOnline(f, {
        ...base,
        executions: [{ ...e, foreground: { ...e.foreground, sampledAt } }],
      });
      expect(collect()).toMatchObject({ ...unknown, total_slots: 4 });
      await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp() where key=${'worker-operations:' + f.worker.workerId}`;
      expect(collect()).toMatchObject(unknown);
    }
    await publish(f, []);
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      unknown_reasons: [],
    });
    await fixture.db`update allrice_runtime_metadata set value=value-'onlineQuestions' where key=${'worker-operations:' + f.worker.workerId}`;
    expect(collect()).toMatchObject({ ...unknown, total_slots: 4 });
    await publish(f);
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      unknown_reasons: [],
    });
  });

  it('rejects old boot, runtime, root, Run, Job, attempt and generation identities', async () => {
    const f = await context();
    const base = contract(f);
    const e = base.executions[0]!;
    const variants = [
      { ...base, workerBootId: randomUUID() },
      ...[
        'runtimeId',
        'rootSessionId',
        'runId',
        'jobId',
        'attempt',
        'generation',
      ].map((key) => ({
        ...base,
        executions: [
          {
            ...e,
            [key]: ['attempt', 'generation'].includes(key) ? 99 : randomUUID(),
          },
        ],
      })),
      ...['runId', 'rootSessionId'].map((key) => ({
        ...base,
        executions: [
          { ...e, foreground: { ...e.foreground, [key]: randomUUID() } },
        ],
      })),
    ];
    for (const value of variants) {
      await writeOnline(f, value);
      expect(collect(), JSON.stringify(value)).toMatchObject(unknown);
    }
    await publish(f);
    await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
    expect(collect()).toMatchObject(unknown);
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
    expect(collect()).toMatchObject(unknown);
    const nextRun = randomUUID();
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      select ${nextRun},organization_id,workspace_id,owner_id,'running','{}','{}' from allrice_runs where id=${f.rootRunId}`;
    await fixture.db`update allrice_conversation_runtimes set thread_generation=${f.generation},active_run_id=${nextRun} where session_id=${f.session}`;
    expect(collect()).toMatchObject(unknown);
    await fixture.db`update allrice_conversation_runtimes set active_run_id=${f.rootRunId},worker_id=${randomUUID()} where session_id=${f.session}`;
    expect(collect()).toMatchObject(unknown);
  });

  it('requires owned live physical inventory and only trusts exact current physical closure', async () => {
    const f = await context();
    await publish(f);
    await fixture.db`update allrice_dsh_runtime_instances set last_seen_at=clock_timestamp()-interval '16 seconds' where id=${f.runtimeId}`;
    expect(collect()).toMatchObject(unknown);
    await fixture.db`update allrice_dsh_runtime_instances set last_seen_at=clock_timestamp(),status='offline' where id=${f.runtimeId}`;
    expect(collect()).toMatchObject(unknown);
    await fixture.db`update allrice_dsh_runtime_instances set status='live' where id=${f.runtimeId}`;
    const owner = f.owner!;
    await recordDshRuntimeCloseObservation(owner, {
      version: 1,
      runtimeId: f.runtimeId,
      workerBootId: f.bootId,
      ownerDigest: owner.ownerDigest,
      kind: 'close_started',
      observedAt: new Date().toISOString(),
    });
    expect(collect().online_runs).toBe(1);
    await recordDshRuntimeCloseObservation(owner, {
      version: 1,
      runtimeId: f.runtimeId,
      workerBootId: f.bootId,
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
    await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
    expect(collect()).toMatchObject(unknown);
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    await fixture.db`delete from allrice_dsh_runtime_instances where id=${f.runtimeId}`;
    expect(collect()).toMatchObject(unknown);
  });

  it('keeps missing owner or unreadable physical sources unknown and recovers after observation is restored', async () => {
    const f = await context(false);
    await publish(f, []);
    expect(collect()).toMatchObject(unknown);
    await fixture.db`alter table allrice_dsh_runtime_close_observations rename to hidden_close_observations`;
    try {
      expect(collect()).toMatchObject({
        online_runs: null,
        occupied_slots: null,
        total_slots: null,
      });
    } finally {
      await fixture.db`alter table hidden_close_observations rename to allrice_dsh_runtime_close_observations`;
    }
    expect(collect()).toMatchObject({ ...unknown, total_slots: 4 });
  });

  it('excludes terminal Runs, expired leases and parked Jobs while unsampled occupied Jobs remain unknown', async () => {
    const f = await runFixture(fixture.db);
    await clock(f);
    await report(f.worker.workerId);
    expect(collect()).toMatchObject(unknown);
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
    expect(collect().occupied_slots).toBe(0);
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '10 minutes' where id=${f.worker.jobId}`;
    await fixture.db`update allrice_runs set state='succeeded' where id=${f.task.runId}`;
    expect(collect().occupied_slots).toBe(0);
    await fixture.db`update allrice_runs set state='waiting_approval' where id=${f.task.runId}`;
    await fixture.db`update allrice_jobs set status='waiting_approval',worker_id=null,lease_token=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null where id=${f.worker.jobId}`;
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      total_slots: 4,
    });
  });

  it('adds per-Worker capacities and ignores repeated global pressure and stale idle reports', async () => {
    const a = await context();
    const b = await context();
    await report(b.worker.workerId, 6);
    await publish(a);
    await publish(b);
    const old = randomUUID();
    await report(old, 32);
    await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp()-interval '91 seconds' where key=${'worker-operations:' + old}`;
    expect(collect()).toMatchObject({
      online_runs: 2,
      occupied_slots: 2,
      total_slots: 10,
      occupancy_pct: 20,
      unknown_reasons: [],
    });
    expect(
      collect()
        .capacity_workers.map((w) => w.worker_id)
        .sort(),
    ).toEqual([a.worker.workerId, b.worker.workerId].sort());
  });

  it('expires capacity independently of a foreground sample and cannot infer the denominator from Jobs', async () => {
    const f = await context();
    await publish(f);
    const key = 'worker-operations:' + f.worker.workerId;
    await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp()-interval '91 seconds' where key=${key}`;
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      total_slots: null,
      occupancy_pct: null,
    });
    await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp()+interval '1 minute' where key=${key}`;
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
      await fixture.db`update allrice_runtime_metadata set value=${fixture.db.json(value)},updated_at=clock_timestamp() where key=${key}`;
      expect(collect()).toMatchObject({
        total_slots: null,
        occupancy_pct: null,
      });
    }
    await report(f.worker.workerId);
    await publish(f);
    const extra = await runFixture(fixture.db);
    expect(collect().total_slots).toBeNull();
    await report(extra.worker.workerId);
    expect(collect()).toMatchObject({
      online_runs: null,
      total_slots: 8,
      occupancy_lower_pct: 12.5,
    });
    await fixture.db`insert into allrice_runtime_metadata(key,value) values('worker-operations:malformed','{}')`;
    expect(collect().total_slots).toBeNull();
  });

  it('exposes a real confirmed lower bound when one occupied Job has no router sample', async () => {
    const samples: string[] = [];
    for (let i = 0; i < 4; i++) {
      const f = await context();
      await report(f.worker.workerId, 1);
      await publish(f);
      samples.push(f.rootRunId);
    }
    const unseen = await runFixture(fixture.db);
    await report(unseen.worker.workerId, 1);
    const row = collect();
    expect(row).toMatchObject({
      online_runs: null,
      occupied_slots: null,
      confirmed_online_runs: 4,
      confirmed_occupied_slots: 4,
      possible_online_runs: 5,
      possible_occupied_slots: 5,
      total_slots: 5,
      occupancy_pct: null,
      occupancy_lower_pct: 80,
    });
    expect(row.samples).toHaveLength(3);
    expect(row.samples!.every((id) => samples.includes(id))).toBe(true);
  });

  it('uses actual SQL states for high alert dedup, unknown retention and complete-snapshot recovery', async () => {
    const f = await context();
    await report(f.worker.workerId, 1);
    await publish(f);
    const high = python('raw');
    await writeOnline(f, { ...contract(f), executions: [] });
    const missing = python('raw');
    await publish(f, []);
    const empty = python('raw');
    const results = python<
      { severity: string[]; events: string[][]; active: string[] }[]
    >('alerts', [high, high, missing, high, empty]);
    expect(results.map((x) => x.events)).toEqual([
      [['opened', 'business.online_waits']],
      [],
      [['opened', 'business.online_waits_data']],
      [['recovered', 'business.online_waits_data']],
      [['recovered', 'business.online_waits']],
    ]);
    expect(results[2]).toMatchObject({
      severity: ['unknown', 'warning'],
      active: ['business.online_waits', 'business.online_waits_data'],
    });
  });

  it('runs the production read-only CLI without exporting bodies or writing alert/incident state', async () => {
    const f = await context();
    const online = contract(f);
    const e = online.executions[0]!;
    await writeOnline(f, {
      ...online,
      executions: [
        {
          ...e,
          foreground: {
            ...e.foreground,
            body: 'DO_NOT_EXPORT_BODY',
            answer: 'DO_NOT_EXPORT_ANSWER',
          },
        },
      ],
    });
    const result = python<{
      snapshot: Snapshot;
      text: string;
      files: string[];
    }>('cli');
    expect(result.snapshot).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      total_slots: 4,
      occupancy_pct: 25,
    });
    expect(result.text).toContain('Run 1个，占Worker执行位 1/4，占比25.0%');
    expect(result.files).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT');
  });
});
