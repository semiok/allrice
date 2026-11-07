import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createPsqlTestFixture,
  PsqlTestDeadlineError,
  PSQL_TEST_STATEMENT_MS,
} from './psql-test.fixture.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createNativeScheduleControlSqlStore } from './native-schedule-control-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
} from './native-schedule-once-state.ts';

const run =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const recoverSql = fileURLToPath(
  new URL('../../../scripts/m1/schedule-recover.sql', import.meta.url),
);
const ready = {
  enabled: true,
  storageReady: true,
  legacyClockExcluded: true,
  controlArtifactApproved: true,
};
type Target = {
  partitionId: string;
  ownerId: string;
  epoch: number;
  tokenDigest: string;
};

/** MET-210 #3: a Worker died holding its partition (no close proof, lease expired) and
 * every later Worker stayed cold. scripts/m1/schedule-recover registers the verified
 * exit with this SQL, through psql exactly as here; the store's own takeover must then
 * accept it. */
run('schedule-recover.sql on an orphaned schedule partition', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let db: Sql;
  let schema: string;
  let task: ReturnType<typeof createPsqlTestFixture>;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    const [scope] = await fixture.db<
      { schema: string }[]
    >`select current_schema() schema`;
    schema = scope!.schema;
  }, 120_000);
  afterAll(async () => {
    if (fixture) await fixture.close();
  }, 30_000);

  beforeEach(({ signal }) => {
    task = createPsqlTestFixture(
      process.env.ALLRICE_TEST_DATABASE_URL!,
      schema,
      signal,
    );
    db = task.db;
  });
  afterEach(async () => {
    if (task) await task.close();
  });

  const worker = (partitionId: string, reference: NativeOnceReference) =>
    createNativeScheduleControlSqlStore({
      db,
      partitionId,
      reference,
      ownerId: randomUUID(),
      ttlMs: 300_000,
      readiness: () => ready,
      loadControls: async () => [],
      proveClosed: async () => null,
    });
  async function orphan() {
    const partitionId = `recover-${randomUUID()}`;
    const reference = {
      artifactId: nativeOnceDigest(partitionId),
      profileId: 'allrice-once-control-v1',
      storageId: `storage-${partitionId}`,
      stateRoot: `/synthetic/${partitionId}`,
    };
    await task.step(
      'orphan.insert',
      () => db`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values(${partitionId},${db.json(reference)},${db.json(ready)})`,
    );
    expect(
      (
        await task.step('orphan.acquire', () =>
          worker(partitionId, reference).acquireWriter(),
        )
      )?.writer.epoch,
    ).toBe(1);
    // It died here: no release, and its lease ran out.
    await task.step(
      'orphan.expire',
      () =>
        db`update allrice_native_once_partitions set expires_at=clock_timestamp()-interval '1 hour' where partition_id=${partitionId}`,
    );
    const [row] = await task.step(
      'orphan.read',
      () =>
        db<
          { owner_id: string; token_digest: string }[]
        >`select owner_id,token_digest from allrice_native_once_partitions where partition_id=${partitionId}`,
    );
    const target: Target = {
      partitionId,
      ownerId: row!.owner_id,
      epoch: 1,
      tokenDigest: row!.token_digest,
    };
    return { partitionId, reference, target };
  }
  const evidence = { basis: 'worker_stopped', workerProcessesLeft: 0 };
  function recoverArguments(targets: unknown, given: object = evidence) {
    return [
      '-1',
      '-f',
      recoverSql,
      '-v',
      `targets=${JSON.stringify(targets)}`,
      '-v',
      `evidence=${JSON.stringify(given)}`,
    ];
  }
  async function recover(targets: unknown, given: object = evidence) {
    const result = await task.psql('recover', recoverArguments(targets, given));
    if (result.status === 0) return;
    const primary = result.stderr.match(/ERROR:\s*([^\r\n]*)/)?.[1] ?? '';
    // Preserve the existing SQL rejection assertions without printing owner,
    // token, evidence, SQL text or a path that could match them on a timeout.
    if (primary.startsWith('schedule-recover: targets or evidence missing'))
      throw new Error('schedule-recover: targets or evidence missing');
    if (
      primary.startsWith('schedule-recover: partition ') &&
      primary.includes(' is not as read ')
    )
      throw new Error('schedule-recover: partition is not as read');
    throw new Error('psql_sql_rejected');
  }
  async function tables() {
    const out: Record<string, string> = {};
    for (const { name } of await task.step(
      'tables.list',
      () => db<
        { name: string }[]
      >`select table_name name from information_schema.tables
      where table_schema=current_schema() and table_type='BASE TABLE'`,
    )) {
      const [row] = await task.step(`tables.digest.${name}`, () =>
        db.unsafe<{ digest: string }[]>(
          `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) digest from "${name}" t`,
        ),
      );
      out[name] = row!.digest;
    }
    return out;
  }
  async function state(partitionId: string) {
    const [row] = await task.step(
      'state.read',
      () => db<
        { closed: boolean; close_proof: unknown; proofs: number }[]
      >`select closed,close_proof,(select count(*)::int from allrice_native_once_close_proofs f where f.partition_id=p.partition_id) proofs
      from allrice_native_once_partitions p where partition_id=${partitionId}`,
    );
    return row!;
  }

  it('closes it with a verified exit proof that the next Worker accepts', async () => {
    const o = await orphan();
    const next = worker(o.partitionId, o.reference);
    expect(
      await task.step('next.acquire.before', () => next.acquireWriter()),
    ).toBeNull(); // the incident: cold, no error
    const before = await tables();
    await recover([o.target]);
    const changed = Object.entries(await tables())
      .filter(([name, digest]) => before[name] !== digest)
      .map(([name]) => name);
    // Only the proof: no control, occurrence, journal, automation or job row moves.
    expect(changed.sort()).toEqual([
      'allrice_native_once_close_proofs',
      'allrice_native_once_partitions',
    ]);
    const after = await state(o.partitionId);
    expect(after).toMatchObject({ closed: true, proofs: 1 });
    expect(after.close_proof).toMatchObject({
      kind: 'verified_process_exit',
      partitionId: o.partitionId,
      ownerId: o.target.ownerId,
      epoch: 1,
      tokenDigest: o.target.tokenDigest,
      evidence: { ...evidence, verifiedBy: expect.any(String) },
    });
    expect(
      (await task.step('next.acquire.after', () => next.acquireWriter()))
        ?.writer.epoch,
    ).toBe(2);
  });

  const changed: [string, (t: Target) => Target | Target[]][] = [
    ['another owner', (t) => ({ ...t, ownerId: randomUUID() })],
    ['another epoch', (t) => ({ ...t, epoch: 2 })],
    ['another token', (t) => ({ ...t, tokenDigest: nativeOnceDigest('x') })],
    ['the same partition twice', (t) => [t, t]],
    [
      'an unknown partition after a good one',
      (t) => [t, { ...t, partitionId: `missing-${randomUUID()}` }],
    ],
  ];
  it.each(changed)('writes nothing for %s', async (_, edit) => {
    const o = await orphan();
    await expect(recover([edit(o.target)].flat())).rejects.toThrow(
      /schedule-recover/,
    );
    expect(await state(o.partitionId)).toMatchObject({
      closed: false,
      close_proof: null,
      proofs: 0,
    });
  });

  it('writes nothing while the lease is live, for a closed partition or without evidence', async () => {
    const live = await orphan();
    await task.step(
      'live.extend',
      () =>
        db`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '1 minute' where partition_id=${live.partitionId}`,
    );
    await expect(recover([live.target])).rejects.toThrow(/not as read/);
    expect(await state(live.partitionId)).toMatchObject({
      closed: false,
      proofs: 0,
    });
    const done = await orphan();
    await recover([done.target]);
    const proof = (await state(done.partitionId)).close_proof;
    await expect(recover([done.target])).rejects.toThrow(/not as read/);
    expect(await state(done.partitionId)).toMatchObject({
      close_proof: proof,
      proofs: 1,
    });
    const bare = await orphan();
    await expect(recover([bare.target], {})).rejects.toThrow(
      /evidence missing/,
    );
    await expect(recover([])).rejects.toThrow(/targets or evidence missing/);
    expect(await state(bare.partitionId)).toMatchObject({
      closed: false,
      proofs: 0,
    });
  });

  it('uses one effective startup configuration for schema and statement timeout', async () => {
    const result = await task.psql('settings', [
      '-c',
      `select json_build_object(
      'schema', current_schema(), 'path', current_setting('search_path'),
      'timeout', current_setting('statement_timeout'), 'app', current_setting('application_name'))`,
    ]);
    expect(result.status).toBe(0);
    const settings = JSON.parse(result.stdout.trim());
    expect(settings).toMatchObject({
      schema,
      timeout: `${PSQL_TEST_STATEMENT_MS / 1000}s`,
      app: task.applications[1],
    });
    expect(settings.path.split(',').map((name: string) => name.trim())).toEqual(
      [schema, 'public'],
    );
    expect(new URL(task.url).searchParams.get('connect_timeout')).toBe('1');
  });

  async function observeWait(
    application: string,
    wait: 'Lock' | 'PgSleep',
    blocker?: number,
  ) {
    return task.step(`observe.${wait}`, async () => {
      const deadline = performance.now() + 1_800;
      do {
        const [row] = await db<
          {
            pid: number;
            wait_event_type: string | null;
            wait_event: string | null;
            blockers: number[];
          }[]
        >`
          select pid, wait_event_type, wait_event, pg_blocking_pids(pid) blockers
          from pg_stat_activity where datname=current_database() and application_name=${application}`;
        if (
          row &&
          (wait === 'Lock'
            ? row.wait_event_type === 'Lock' && row.blockers.includes(blocker!)
            : row.wait_event === 'PgSleep')
        )
          return row.pid;
        await delay(10);
      } while (performance.now() < deadline);
      throw new Error('postgres_wait_not_observed');
    });
  }

  it('captures the real blocker before abort and leaves recovery uncommitted', async (context) => {
    const o = await orphan();
    let unlock!: () => void;
    let locked!: (pid: number) => void;
    let lockFailed!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<number>((resolve, reject) => {
      locked = resolve;
      lockFailed = reject;
    });
    const holding = fixture.db.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      await tx`select partition_id from allrice_native_once_partitions where partition_id=${o.partitionId} for update`;
      locked(row!.pid);
      await gate;
    });
    void holding.catch(lockFailed);
    let waiting: ReturnType<typeof createPsqlTestFixture> | undefined;
    const abort = new AbortController();
    try {
      const blocker = await ready;
      waiting = createPsqlTestFixture(
        process.env.ALLRICE_TEST_DATABASE_URL!,
        schema,
        context.signal,
      );
      const outcome = waiting
        .psql('recover', recoverArguments([o.target]), { signal: abort.signal })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await observeWait(waiting.applications[1]!, 'Lock', blocker);
      abort.abort();
      expect((await outcome).error).toMatchObject({ reason: 'aborted' });
      expect(waiting.snapshot?.activity).toContainEqual(
        expect.objectContaining({
          application_name: waiting.applications[1],
          wait_event_type: 'Lock',
          blockers: expect.arrayContaining([blocker]),
        }),
      );
      expect(waiting.snapshot?.locks).toContainEqual(
        expect.objectContaining({ pid: blocker, granted: true }),
      );
      expect(waiting.cleanupConfirmed).toBe(true);
    } finally {
      abort.abort();
      try {
        await waiting?.close();
      } finally {
        unlock();
        await holding;
      }
    }
    expect(await state(o.partitionId)).toMatchObject({
      closed: false,
      close_proof: null,
      proofs: 0,
    });
    const [left] = await db<
      { n: number }[]
    >`select count(*)::int n from pg_stat_activity
      where datname=current_database() and application_name=any(${waiting!.applications}::text[])`;
    expect(left!.n).toBe(0);
  });

  it('cancels an ordinary postgres transaction without leaving its write or connection', async (context) => {
    const o = await orphan();
    const [before] = await db<
      { expires_at: Date }[]
    >`select expires_at from allrice_native_once_partitions where partition_id=${o.partitionId}`;
    const abort = new AbortController();
    const waiting = createPsqlTestFixture(
      process.env.ALLRICE_TEST_DATABASE_URL!,
      schema,
      AbortSignal.any([context.signal, abort.signal]),
    );
    try {
      const outcome = waiting
        .step('ordinary.transaction', () =>
          waiting.db.begin(async (tx) => {
            await tx`set local statement_timeout = 0`;
            await tx`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '1 hour' where partition_id=${o.partitionId}`;
            await tx`select pg_sleep(10)`;
          }),
        )
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await observeWait(waiting.applications[0]!, 'PgSleep');
      abort.abort();
      expect((await outcome).error).toBeInstanceOf(PsqlTestDeadlineError);
      expect((await outcome).error).toMatchObject({ reason: 'aborted' });
      expect(waiting.cleanupConfirmed).toBe(true);
    } finally {
      abort.abort();
      await waiting.close();
    }
    const [after] = await db<
      { expires_at: Date }[]
    >`select expires_at from allrice_native_once_partitions where partition_id=${o.partitionId}`;
    expect(after!.expires_at).toEqual(before!.expires_at);
    const [left] = await db<
      { n: number }[]
    >`select count(*)::int n from pg_stat_activity
      where datname=current_database() and application_name=any(${waiting.applications}::text[])`;
    expect(left!.n).toBe(0);
  });
});
