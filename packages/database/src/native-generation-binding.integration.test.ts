import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import {
  NativeJournalContractRowSchema,
  readNativeJournalContractHighWater,
  recordNativeJournalContract,
} from './native-journal-contract-store.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL('../migrations/0218_native_generation_binding.sql', import.meta.url),
  'utf8',
);
const rollback = Error('test transaction rollback');

suite('0218 native generation binding migration', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase({
      throughMigration: '0217_brand_content_feedback.sql',
    });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  it.each([
    'allrice_native_chat_executor_transitions',
    'allrice_native_control_cloud_absences',
    'allrice_native_control_upgrades',
    'allrice_native_control_upgrade_plans',
  ])(
    'refuses a nonempty retired ledger %s and rolls back all DDL',
    async (table) => {
      await expect(
        f.db.begin(async (tx) => {
          await tx.unsafe(
            `create table ${table}(fact text); insert into ${table} values ('historical fact')`,
          );
          await expect(
            tx.savepoint((sp) => sp.unsafe(migration)),
          ).rejects.toThrow('MET221_0218_LEDGER_NOT_EMPTY');
          expect(await tx.unsafe(`select fact from ${table}`)).toEqual([
            { fact: 'historical fact' },
          ]);
          expect(await readNativeJournalContractHighWater(tx)).toEqual({
            highWater: 1,
            recorded: false,
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );

  it('detects PL/pgSQL references that PostgreSQL does not track as dependencies', async () => {
    await expect(
      f.db.begin(async (tx) => {
        await tx.unsafe(`create function forgotten_reader() returns void language plpgsql as $$
        begin perform 1 from allrice_native_chat_executor_transitions; end $$`);
        await expect(
          tx.savepoint((sp) => sp.unsafe(migration)),
        ).rejects.toThrow('MET221_0218_DANGLING_REFERENCE');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it.each([false, true])(
    'migrates with empty retired ledgers present=%s and keeps an existing Worker value',
    async (present) => {
      await recordNativeJournalContract({ current: 1, readsFrom: 1 }, f.db);
      await expect(
        f.db.begin(async (tx) => {
          if (present)
            for (const table of [
              'allrice_native_chat_executor_transitions',
              'allrice_native_control_cloud_absences',
              'allrice_native_control_upgrades',
              'allrice_native_control_upgrade_plans',
            ])
              await tx.unsafe(`create table ${table}(fact text)`);
          await tx.unsafe(migration);
          expect(await readNativeJournalContractHighWater(tx)).toEqual({
            highWater: 1,
            recorded: true,
          });
          const [row] =
            await tx`select value from allrice_runtime_metadata where key='dsh-journal-contract'`;
          expect(row!.value).toEqual({ highWater: 1 });
          expect(
            await tx`select relname from pg_class where relnamespace=current_schema()::regnamespace and relname in ('allrice_native_chat_executor_transitions','allrice_native_control_cloud_absences','allrice_native_control_upgrades','allrice_native_control_upgrade_plans')`,
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      await f.db`delete from allrice_runtime_metadata where key='dsh-journal-contract'`;
    },
  );

  it('writes the schema-valid baseline and accepts the real Worker upsert without changing since', async () => {
    await f.db.begin((tx) => tx.unsafe(migration));
    const [row] =
      await f.db`select value from allrice_runtime_metadata where key='dsh-journal-contract'`;
    expect(NativeJournalContractRowSchema.parse(row!.value)).toEqual({
      highWater: 1,
      since: '0218',
    });
    expect(await readNativeJournalContractHighWater(f.db)).toEqual({
      highWater: 1,
      recorded: true,
    });
    expect(
      await recordNativeJournalContract({ current: 1, readsFrom: 1 }, f.db),
    ).toEqual(row!.value);
  });

  it.each([
    {},
    null,
    [],
    { highWater: null },
    { highWater: '1' },
    { highWater: 0 },
    { highWater: 1.5 },
    { highWater: 1_000_000_000 },
    { highWater: 1, unknown: true },
    { highWater: 1, since: null },
    { highWater: 1, since: '' },
    { highWater: 1, since: 'x'.repeat(41) },
    { highWater: 1, since: '😀'.repeat(21) },
    { highWater: 1 },
    { highWater: 1, since: '0218' },
    { highWater: 1, since: '😀'.repeat(20) },
    { highWater: 999_999_999, since: 'x'.repeat(40) },
  ])('SQL accepts exactly the exported row schema: %j', async (value) => {
    await expect(
      f.db.begin(async (tx) => {
        const write = tx.savepoint(
          (sp) =>
            sp`update allrice_runtime_metadata set value=${sp.json(value as never)} where key='dsh-journal-contract'`,
        );
        if (NativeJournalContractRowSchema.safeParse(value).success)
          await write;
        else
          await expect(write).rejects.toThrow(
            'DSH_NATIVE_JOURNAL_CONTRACT_REGRESSION',
          );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('rejects regression, deletion and renaming, while leaving other metadata alone', async () => {
    await recordNativeJournalContract({ current: 2, readsFrom: 1 }, f.db);
    await expect(
      f.db`update allrice_runtime_metadata set value='{"highWater":1}' where key='dsh-journal-contract'`,
    ).rejects.toThrow('REGRESSION');
    await expect(
      f.db`delete from allrice_runtime_metadata where key='dsh-journal-contract'`,
    ).rejects.toThrow('IMMUTABLE');
    await expect(
      f.db`update allrice_runtime_metadata set key='renamed' where key='dsh-journal-contract'`,
    ).rejects.toThrow('IMMUTABLE');
    await f.db`insert into allrice_runtime_metadata(key,value) values('unrelated','null')`;
    await f.db`update allrice_runtime_metadata set value='{"arbitrary":true}' where key='unrelated'`;
    await f.db`delete from allrice_runtime_metadata where key='unrelated'`;
    expect(await readNativeJournalContractHighWater(f.db)).toEqual({
      highWater: 2,
      recorded: true,
    });
  });
});
