import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const migrations = new URL('../migrations/', import.meta.url);
// Unmodified deployed SQL from 7bdc0438; fixtures are never active migrations.
const archive = new URL(
  '../../../docs/architecture/allrice-2.0/archive/',
  import.meta.url,
);
const originals = [
  '0202_native_schedule_control_upgrade.sql',
  '0213_native_chat_executor_transitions.sql',
  '0214_native_control_cloud_absence.sql',
  '0215_terminal_native_test_retirements.sql',
  '0216_native_legacy_chat_adoption.sql',
];
const target = '0218_native_generation_binding.sql';
type Fixture = Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;

async function catalog(db: Fixture['db']) {
  const [schema] = await db`select current_schema() as name`;
  const functions =
    await db`select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
    p.prosrc,p.proconfig from pg_proc p where p.pronamespace=current_schema()::regnamespace
    order by p.proname,arguments`;
  const triggers =
    await db`select r.relname,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred,
    coalesce(c.conname,t.tgname) as name,
    replace(pg_get_triggerdef(t.oid,true),t.tgname,coalesce(c.conname,t.tgname)) as definition
    from pg_trigger t join pg_class r on r.oid=t.tgrelid
    left join pg_constraint c on c.oid=t.tgconstraint
    where r.relnamespace=current_schema()::regnamespace
    order by r.relname,name,definition`;
  const tables = await db`select relname,relkind from pg_class
    where relnamespace=current_schema()::regnamespace and relkind in ('r','p') order by relname`;
  const indexes = await db`select tablename,indexname,indexdef from pg_indexes
    where schemaname=current_schema() order by tablename,indexname`;
  // Only generated schema names and internal trigger OIDs differ between databases.
  return JSON.parse(
    JSON.stringify({ functions, triggers, tables, indexes }).replaceAll(
      schema!.name,
      'fixture_schema',
    ),
  );
}

suite('0218 converges the deployed and fresh migration histories', () => {
  let deployed: Fixture, fresh: Fixture;
  beforeAll(async () => {
    deployed = await createAssistantFixtureDatabase({
      throughMigration: '0201_workbench_file_policies.sql',
    });
    fresh = await createAssistantFixtureDatabase({
      throughMigration: '0217_brand_content_feedback.sql',
    });
  }, 120_000);
  afterAll(async () => {
    await deployed?.close();
    await fresh?.close();
  });
  it('removes the real historical FK/trigger chain and leaves identical functions, triggers, tables and indexes', async () => {
    const active = (await readdir(migrations)).filter((name) =>
      name.endsWith('.sql'),
    );
    const history = [...new Set([...active, ...originals])]
      .filter(
        (name) => name > '0201_workbench_file_policies.sql' && name <= target,
      )
      .sort();
    // Apply original 0202, then 0203..0212, original 0213..0216, 0217, 0218.
    await deployed.db.begin(async (tx) => {
      for (const name of history) {
        const file = originals.includes(name)
          ? new URL(`${name}.txt`, archive)
          : new URL(name, migrations);
        await tx.unsafe(await readFile(file, 'utf8'));
      }
    });
    await fresh.db.begin(async (tx) =>
      tx.unsafe(await readFile(new URL(target, migrations), 'utf8')),
    );
    const expected = await catalog(fresh.db);
    expect(expected.functions.length).toBeGreaterThan(0);
    expect(expected.triggers.length).toBeGreaterThan(0);
    expect(expected.tables.length).toBeGreaterThan(0);
    expect(expected.indexes.length).toBeGreaterThan(0);
    expect(await catalog(deployed.db)).toEqual(expected);
  }, 60_000);
});
