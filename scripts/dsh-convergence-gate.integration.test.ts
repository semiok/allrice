import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { assertRuntimeFixtureDatabase } from '../packages/database/src/runtime-fixture-database.ts';
import { baseline } from './dsh-convergence-gate.baseline.ts';
import {
  checkBaseline,
  openDatabase,
  readNativeTables,
  runGate,
} from './dsh-convergence-gate.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const root = fileURLToPath(new URL('..', import.meta.url));

integration('DSH convergence after every migration (PostgreSQL)', () => {
  let admin: ReturnType<typeof openDatabase> | undefined;
  let sql: ReturnType<typeof openDatabase> | undefined;
  let schema = '';
  let scopedUrl = '';

  beforeAll(async () => {
    const value = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!value) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
    const url = new URL(value);
    assertRuntimeFixtureDatabase(url);
    admin = openDatabase(url.toString());
    schema = `dsh_convergence_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema "${schema}"`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    scopedUrl = url.toString();
    sql = openDatabase(scopedUrl);
    const migrations = new URL(
      '../packages/database/migrations/',
      import.meta.url,
    );
    const files = (await readdir(migrations))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    await sql.begin(async (transaction) => {
      await transaction.unsafe(
        'create table allrice_schema_migrations (name text primary key, applied_at timestamptz not null default now())',
      );
      for (const file of files) {
        await transaction.unsafe(
          await readFile(new URL(file, migrations), 'utf8'),
        );
        await transaction`insert into allrice_schema_migrations (name) values (${file})`;
      }
    });
    const tables = await readNativeTables(sql);
    console.log(
      `DSH convergence migrated=${files.length} tables=${tables.length}\n${tables.join('\n')}`,
    );
  }, 180_000);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      await sql?.end({ timeout: 5 });
    } finally {
      try {
        if (admin && schema)
          await admin.unsafe(`drop schema if exists "${schema}" cascade`);
      } finally {
        await admin?.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it('matches the live migrated catalog and passes the same CLI used by CI', async () => {
    expect(
      checkBaseline(
        { table: await readNativeTables(sql!) },
        baseline,
        baseline,
      ),
    ).toEqual([]);
    vi.stubEnv('DATABASE_URL', scopedUrl);
    expect(await runGate(root, ['--tables', '--base', 'HEAD'])).toBe(0);
  });

  it.each([
    'allrice_native_test_x',
    'allrice_assistant_test_x',
    'allrice_dsh_test_x',
  ])(
    'fails for an actual %s table and passes again after removal',
    async (name) => {
      vi.stubEnv('DATABASE_URL', scopedUrl);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await sql!.unsafe(`create table ${name} (id integer)`);
      try {
        expect(await runGate(root, ['--tables', '--base', 'HEAD'])).toBe(1);
        expect(errors).toHaveBeenCalledWith(
          expect.stringContaining(`${name}: 新增未登记`),
        );
      } finally {
        await sql!.unsafe(`drop table ${name}`);
      }
      expect(await runGate(root, ['--tables', '--base', 'HEAD'])).toBe(0);
    },
  );

  it('treats prefixes literally and does not expand exact reminder names to a brand prefix', async () => {
    const outsideScope = [
      'allricexnative_test_x',
      'allricexassistant_test_x',
      'allricexdsh_test_x',
      'allrice_brand_content_reminders_test_x',
      'allrice_brand_native_reminder_targets_test_x',
      'allrice_brand_other_test_x',
    ];
    for (const name of outsideScope)
      await sql!.unsafe(`create table ${name} (id integer)`);
    try {
      const tables = await readNativeTables(sql!);
      for (const name of outsideScope) expect(tables).not.toContain(name);
      expect(checkBaseline({ table: tables }, baseline, baseline)).toEqual([]);
    } finally {
      for (const name of outsideScope) await sql!.unsafe(`drop table ${name}`);
    }
  });
});
