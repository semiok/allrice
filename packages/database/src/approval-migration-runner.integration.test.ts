import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import postgres, { type Sql } from 'postgres';
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
  archivedMigrationNames,
  migrationsMatch,
} from './migration-compatibility.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '0252_approval_gateway_outbound_approvals.sql';

// Historical fixture, frozen at 6eab934e: the former module 0001 had no ledger.
// Product code and current store tests use only the global migration definition.
const legacyModuleSql = `
  CREATE TABLE allrice_outbound_approvals (
    request_id uuid PRIMARY KEY,
    scope_key text NOT NULL,
    idempotency_key text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (scope_key, idempotency_key),
    CHECK (record->'ref'->>'requestId' = request_id::text),
    CHECK (record->>'scopeKey' = scope_key),
    CHECK (record->>'idempotencyKey' = idempotency_key)
  )`;

suite('outbound approval migration through the global CLI (PostgreSQL)', () => {
  let admin: Sql | undefined;
  let db: Sql | undefined;
  let schema = '';
  let databaseUrl: URL;
  let scopedUrl = '';
  let temporary = '';
  let previousRelease = '';
  let currentGateRelease = '';
  let names: string[];

  const ledger = () =>
    db!<{ name: string; applied_at: Date }[]>`
      select name, applied_at from allrice_schema_migrations order by name
    `;
  const runMigrations = (release = repository) =>
    exec(
      process.execPath,
      ['--import', 'tsx', join(release, 'packages/database/src/migrate.ts')],
      {
        cwd: repository,
        env: { ...process.env, DATABASE_URL: scopedUrl },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

  // Use the real deploy/rollback compatibility function, with its database read
  // replaced by names just read from this isolated DB. No with-env/Dev access.
  async function checkDeployGate(release: string, applied: string[]) {
    const appliedFile = join(temporary, 'applied.txt');
    await writeFile(appliedFile, applied.join('\n') + '\n');
    return exec(
      '/bin/bash',
      [
        '-c',
        'source "$1"; PATH="$2"; dev_sql() { cat "$APPLIED_FIXTURE"; }; check_migrations_known "$3"',
        'approval-migration-test',
        join(repository, 'scripts/m1/deploy-dev'),
        `${dirname(process.execPath)}:/usr/bin:/bin`,
        release,
      ],
      {
        cwd: repository,
        env: { ...process.env, APPLIED_FIXTURE: appliedFile },
        timeout: 15_000,
      },
    );
  }

  beforeAll(async () => {
    const value = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!value) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
    databaseUrl = new URL(value);
    assertRuntimeFixtureDatabase(databaseUrl);
    admin = postgres(value, { max: 1, onnotice: () => {} });
    names = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(names).toContain(migrationName);
    temporary = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-approval-migration-')),
    );
    previousRelease = join(temporary, 'previous');
    currentGateRelease = join(temporary, 'current-gate');
    // The runner/client are unchanged by this PR. An actual pre-0252 migration
    // directory builds the old ledger; no synthetic applied rows are inserted.
    const previousDatabase = join(previousRelease, 'packages/database');
    await mkdir(join(previousDatabase, 'src/core'), { recursive: true });
    await mkdir(join(previousDatabase, 'migrations'));
    for (const name of names.filter((name) => name !== migrationName)) {
      await copyFile(
        new URL(name, migrationsDirectory),
        join(previousDatabase, 'migrations', name),
      );
    }
    for (const source of ['migrate.ts', 'core/client.ts']) {
      await copyFile(
        new URL(source, import.meta.url),
        join(previousDatabase, 'src', source),
      );
    }
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(previousDatabase, 'node_modules'),
      'dir',
    );
    for (const release of [previousRelease, currentGateRelease]) {
      await mkdir(join(release, 'packages/database/dist'), {
        recursive: true,
      });
      await writeFile(join(release, 'package.json'), '{"type":"module"}\n');
      // The compatibility module's archived-name contract is unchanged. Supply
      // its actual list in the built layout the deployment function imports.
      await writeFile(
        join(release, 'packages/database/dist/migration-compatibility.js'),
        `export const archivedMigrationNames = ${JSON.stringify(archivedMigrationNames)};\n`,
      );
    }
    await symlink(
      fileURLToPath(migrationsDirectory),
      join(currentGateRelease, 'packages/database/migrations'),
      'dir',
    );
  }, 30_000);

  beforeEach(async () => {
    schema = `approval_migrate_${randomUUID().replaceAll('-', '')}`;
    await admin!.unsafe(`create schema "${schema}"`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set('options', `-csearch_path=${schema},public`);
    scopedUrl = scoped.toString();
    db = postgres(scopedUrl, { max: 1, onnotice: () => {} });
  });

  afterEach(async () => {
    try {
      await db?.end({ timeout: 5 });
    } finally {
      db = undefined;
      if (schema)
        await admin!.unsafe(`drop schema if exists "${schema}" cascade`);
      schema = '';
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await admin?.end({ timeout: 5 });
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);

  it('automatically creates and records approvals, and a second CLI run changes nothing', async () => {
    const first = await runMigrations();
    expect(first.stdout).toContain(`applied migration ${migrationName}`);
    expect(await db!`select * from allrice_outbound_approvals`).toHaveLength(0);
    const applied = await ledger();
    expect(applied.map((row) => row.name)).toEqual(names);
    expect(
      migrationsMatch(
        names,
        applied.map((row) => row.name),
      ),
    ).toBe(true);
    const second = await runMigrations();
    expect(second.stdout).not.toContain('applied migration');
    expect(await ledger()).toEqual(applied);
    expect(
      await db!`select to_regclass('pg_temp.allrice_outbound_approvals_expected') as temporary`,
    ).toEqual([{ temporary: null }]);
  }, 180_000);

  it('adopts the exact formerly explicit module table without changing stored approvals', async () => {
    await runMigrations(previousRelease);
    await db!.unsafe(legacyModuleSql);
    const requestId = randomUUID();
    const record = {
      ref: { requestId, digest: 'sha256:retained-frozen-digest' },
      scopeKey: 'historical-person-workspace-employee',
      idempotencyKey: 'historical-delivery',
      frozen: { body: '保留冻结正文与附件字节', bytes: 'AAEC/w==' },
      intentAt: '2026-11-21T00:00:00.000Z',
      failure: { kind: 'receipt_integrity', at: '2026-11-21T00:00:01.000Z' },
    };
    await db!`
      insert into allrice_outbound_approvals
        (request_id, scope_key, idempotency_key, record, created_at)
      values (${requestId}, ${record.scopeKey}, ${record.idempotencyKey},
        ${db!.json(record)}, '2026-11-20T23:59:59Z')
    `;
    const before = await db!`select * from allrice_outbound_approvals`;
    await runMigrations();
    expect(await db!`select * from allrice_outbound_approvals`).toEqual(before);
    const applied = await ledger();
    expect(applied.map((row) => row.name)).toEqual(names);
    await runMigrations();
    expect(await ledger()).toEqual(applied);
    expect(await db!`select * from allrice_outbound_approvals`).toEqual(before);
  }, 180_000);

  it.each([
    ['a nullable scope', 'alter column scope_key drop not null'],
    ['a changed default', 'alter column created_at set default now()'],
    ['an extra column', 'add column incompatible text'],
  ])(
    'refuses %s without adding an applied migration',
    async (_label, change) => {
      await runMigrations(previousRelease);
      await db!.unsafe(legacyModuleSql);
      await db!.unsafe(`alter table allrice_outbound_approvals ${change}`);
      const before = await ledger();
      await expect(runMigrations()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('outbound approval schema mismatch'),
      });
      expect(await ledger()).toEqual(before);
    },
    180_000,
  );

  it.each(['check', 'unique', 'index'])(
    'refuses a changed %s guarantee',
    async (change) => {
      await runMigrations(previousRelease);
      await db!.unsafe(legacyModuleSql);
      if (change === 'index') {
        await db!.unsafe(
          'create unique index incompatible_approval_scope on allrice_outbound_approvals(scope_key)',
        );
      } else {
        const [constraint] = await db!<{ conname: string }[]>`
        select conname from pg_constraint
        where conrelid = ${`${schema}.allrice_outbound_approvals`}::regclass
          and contype = ${change === 'check' ? 'c' : 'u'}
        order by conname limit 1
      `;
        expect(constraint).toBeDefined();
        await db!`alter table allrice_outbound_approvals drop constraint ${db!(constraint!.conname)}`;
      }
      const before = await ledger();
      await expect(runMigrations()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('outbound approval schema mismatch'),
      });
      expect(await ledger()).toEqual(before);
    },
    180_000,
  );

  it.each(['INSERT', 'UPDATE'])(
    'refuses an existing %s rewrite rule without recording the migration',
    async (event) => {
      await runMigrations(previousRelease);
      await db!.unsafe(legacyModuleSql);
      await db!.unsafe(`
        create rule incompatible_approval_write as
        on ${event} to allrice_outbound_approvals do instead nothing
      `);
      const rewriteRules = () => db!<{ rulename: string }[]>`
        select rulename from pg_rewrite
        where ev_class = ${`${schema}.allrice_outbound_approvals`}::regclass
        order by rulename
      `;
      const rules = await rewriteRules();
      expect(rules).toEqual([{ rulename: 'incompatible_approval_write' }]);
      const before = await ledger();
      await expect(runMigrations()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('outbound approval schema mismatch'),
      });
      expect(await ledger()).toEqual(before);
      expect(await rewriteRules()).toEqual(rules);
    },
    180_000,
  );

  it('rolls back the new table if its ledger insertion fails', async () => {
    await runMigrations(previousRelease);
    const before = await ledger();
    await db!.unsafe(`
      create function reject_approval_migration() returns trigger language plpgsql as $$
      begin
        if new.name = '${migrationName}' then
          raise exception 'synthetic approval ledger failure';
        end if;
        return new;
      end;
      $$;
      create trigger reject_approval_migration before insert on allrice_schema_migrations
        for each row execute function reject_approval_migration();
    `);
    await expect(runMigrations()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('synthetic approval ledger failure'),
    });
    expect(await ledger()).toEqual(before);
    expect(
      await db!`select to_regclass(${`${schema}.allrice_outbound_approvals`}) as approvals`,
    ).toEqual([{ approvals: null }]);
  }, 180_000);

  it('lists the migration as pending and rejects an old release after it is applied', async () => {
    await runMigrations(previousRelease);
    const previous = (await ledger()).map((row) => row.name);
    expect(
      (await checkDeployGate(currentGateRelease, previous)).stdout.trim(),
    ).toBe(migrationName);
    await runMigrations();
    const applied = (await ledger()).map((row) => row.name);
    expect(migrationsMatch(previous, applied)).toBe(false);
    expect(migrationsMatch(names, applied)).toBe(true);
    expect(
      migrationsMatch(names, [...applied, '0001_outbound_approvals.sql']),
    ).toBe(false);
    await expect(
      checkDeployGate(previousRelease, applied),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(migrationName),
    });
    expect(
      (await checkDeployGate(currentGateRelease, applied)).stdout.trim(),
    ).toBe('');
  }, 180_000);
});
