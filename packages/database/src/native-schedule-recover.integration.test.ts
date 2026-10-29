import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  let url: string;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    db = fixture.db;
    const [scope] = await db<
      { schema: string }[]
    >`select current_schema() schema`;
    const u = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    u.searchParams.set('options', `-csearch_path=${scope!.schema},public`);
    url = u.toString();
  }, 120_000);
  afterAll(async () => {
    if (fixture) await fixture.close();
  }, 30_000);

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
    await db`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values(${partitionId},${db.json(reference)},${db.json(ready)})`;
    expect(
      (await worker(partitionId, reference).acquireWriter())?.writer.epoch,
    ).toBe(1);
    // It died here: no release, and its lease ran out.
    await db`update allrice_native_once_partitions set expires_at=clock_timestamp()-interval '1 hour' where partition_id=${partitionId}`;
    const [row] = await db<
      { owner_id: string; token_digest: string }[]
    >`select owner_id,token_digest from allrice_native_once_partitions where partition_id=${partitionId}`;
    const target: Target = {
      partitionId,
      ownerId: row!.owner_id,
      epoch: 1,
      tokenDigest: row!.token_digest,
    };
    return { partitionId, reference, target };
  }
  const evidence = { basis: 'worker_stopped', workerProcessesLeft: 0 };
  function recover(targets: unknown, given: object = evidence) {
    const run = spawnSync(
      process.env.ALLRICE_TEST_PSQL ?? 'psql',
      [
        url,
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-1',
        '-f',
        recoverSql,
        '-v',
        `targets=${JSON.stringify(targets)}`,
        '-v',
        `evidence=${JSON.stringify(given)}`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PGOPTIONS: '-c statement_timeout=15000' },
      },
    );
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(run.stderr);
  }
  async function tables() {
    const out: Record<string, string> = {};
    for (const { name } of await db<
      { name: string }[]
    >`select table_name name from information_schema.tables
      where table_schema=current_schema() and table_type='BASE TABLE'`) {
      const [row] = await db.unsafe<{ digest: string }[]>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) digest from "${name}" t`,
      );
      out[name] = row!.digest;
    }
    return out;
  }
  async function state(partitionId: string) {
    const [row] = await db<
      { closed: boolean; close_proof: unknown; proofs: number }[]
    >`select closed,close_proof,(select count(*)::int from allrice_native_once_close_proofs f where f.partition_id=p.partition_id) proofs
      from allrice_native_once_partitions p where partition_id=${partitionId}`;
    return row!;
  }

  it('closes it with a verified exit proof that the next Worker accepts', async () => {
    const o = await orphan();
    const next = worker(o.partitionId, o.reference);
    expect(await next.acquireWriter()).toBeNull(); // the incident: cold, no error
    const before = await tables();
    recover([o.target]);
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
    expect((await next.acquireWriter())?.writer.epoch).toBe(2);
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
    expect(() => recover([edit(o.target)].flat())).toThrow(/schedule-recover/);
    expect(await state(o.partitionId)).toMatchObject({
      closed: false,
      close_proof: null,
      proofs: 0,
    });
  });

  it('writes nothing while the lease is live, for a closed partition or without evidence', async () => {
    const live = await orphan();
    await db`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '1 minute' where partition_id=${live.partitionId}`;
    expect(() => recover([live.target])).toThrow(/not as read/);
    expect(await state(live.partitionId)).toMatchObject({
      closed: false,
      proofs: 0,
    });
    const done = await orphan();
    recover([done.target]);
    const proof = (await state(done.partitionId)).close_proof;
    expect(() => recover([done.target])).toThrow(/not as read/);
    expect(await state(done.partitionId)).toMatchObject({
      close_proof: proof,
      proofs: 1,
    });
    const bare = await orphan();
    expect(() => recover([bare.target], {})).toThrow(/evidence missing/);
    expect(() => recover([])).toThrow(/targets or evidence missing/);
    expect(await state(bare.partitionId)).toMatchObject({
      closed: false,
      proofs: 0,
    });
  });
});
