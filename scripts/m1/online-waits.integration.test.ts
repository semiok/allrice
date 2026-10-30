import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRuntimeFixtureDatabase,
  runFixture,
} from '../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../packages/database/src/run-authority.fixture.ts';
import { recordWorkerOperations } from '../../packages/database/src/operations-resources.ts';
import { recordTaskQuestion } from '../../packages/database/src/task-clock.ts';
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
  });
  afterAll(async () => {
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

  async function legacy() {
    const f = await runFixture(fixture.db);
    await clock(f);
    await notice(f, 'legacy-question', true);
    await report(f.worker.workerId);
    return f;
  }

  async function native() {
    const f = await createRunAuthorityFixture(fixture.db, { configure: false });
    await clock(f);
    const thread = `dsh-${f.session}`;
    await fixture.db`update allrice_conversation_runtimes set thread_id=${thread} where session_id=${f.session}`;
    // Synthetic projection rows only: no Host starts and no question is asked.
    await fixture.db`insert into allrice_native_questions(session_id,native_session_id,call_id,source_run_id,state,questions,sequence)
      values(${f.session},${thread},'native-call',${f.rootRunId},'open','[{"question":"DO_NOT_EXPORT_BODY"}]',1)`;
    await report(f.worker.workerId);
    return f;
  }

  it('counts one occupied Run/Job for multiple current questions; an accepted answer drops it once', async () => {
    const f = await legacy();
    await notice(f, 'program-question', true);
    expect(collect()).toMatchObject({
      online_runs: 1,
      occupied_slots: 1,
      total_slots: 4,
      occupancy_pct: 25,
      samples: [f.task.runId],
      unknown_reasons: [],
    });
    await notice(f, 'legacy-question', false);
    expect(collect().occupied_slots).toBe(1);
    await notice(f, 'program-question', false);
    // Reordered duplicate notices cannot reopen an already answered callback.
    await notice(f, 'program-question', true);
    expect(collect()).toMatchObject({
      online_runs: 0,
      occupied_slots: 0,
      occupancy_pct: 0,
    });
  });

  it('requires current foreground open identity; continued late-answer cards never stand in for a live wait', async () => {
    const f = await native();
    expect(collect()).toMatchObject({ online_runs: 1, occupied_slots: 1 });
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
    expect(collect().online_runs).toBe(0); // still doing useful concurrent work
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

  it('returns unknown when a foreground candidate lacks its clock or collection cannot read a source', async () => {
    const f = await native();
    await fixture.db`delete from allrice_task_clocks where run_id=${f.rootRunId}`;
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
});
