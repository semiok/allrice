import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, getDatabase } from './core/client.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import { verifyDatabase } from './verify-database.ts';

const describeDatabase =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const migrationsDirectory = new URL('../migrations/', import.meta.url);
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminSql: ReturnType<typeof postgres> | undefined;
let schemaName = '';

// `db:prepare` ends with these checks before every deploy, so they must pass on the
// data a company produces in normal use and still stop a broken database.
describeDatabase('db:verify on a prepared database (PostgreSQL)', () => {
  beforeAll(async () => {
    const baseUrl = new URL(
      process.env.ALLRICE_TEST_DATABASE_URL ??
        originalDatabaseUrl ??
        'postgres://allrice:allrice@localhost:5432/allrice_dev',
    );
    baseUrl.search = '';
    schemaName = `verify_${randomUUID().replaceAll('-', '')}`;
    adminSql = postgres(baseUrl.toString(), { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`create schema "${schemaName}"`);
    const scopedUrl = new URL(baseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName},public`);
    const migrationSql = postgres(scopedUrl.toString(), {
      max: 1,
      onnotice: () => {},
    });
    try {
      const files = (await readdir(migrationsDirectory))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      // As src/migrate.ts does: each migration is recorded, which db:verify compares.
      await migrationSql.begin(async (transaction) => {
        await transaction.unsafe(`
          create table allrice_schema_migrations (
            name text primary key,
            applied_at timestamptz not null default now()
          )`);
        for (const file of files) {
          await transaction.unsafe(
            await readFile(new URL(file, migrationsDirectory), 'utf8'),
          );
          await transaction`insert into allrice_schema_migrations (name) values (${file})`;
        }
      });
    } finally {
      await migrationSql.end({ timeout: 5 });
    }
    process.env.DATABASE_URL = scopedUrl.toString();
    await synchronizePlatformContent(await loadPlatformContentCatalog());
  }, 180_000);

  afterAll(async () => {
    await closeDatabase();
    if (adminSql && schemaName) {
      await adminSql.unsafe(`drop schema if exists "${schemaName}" cascade`);
      await adminSql.end({ timeout: 5 });
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 30_000);

  it('passes once a company has an employee besides Rice, as after assigning a platform employee', async () => {
    const sql = getDatabase();
    await expect(verifyDatabase(sql)).resolves.toMatch(/database verified/);
    const [organization] = await sql<{ id: string }[]>`
      insert into allrice_organizations (slug, name)
      values (${`verify-${randomUUID().slice(0, 8)}`}, 'Verify Co') returning id`;
    const [workspace] = await sql<{ id: string }[]>`
      insert into allrice_workspaces (organization_id, slug, name)
      values (${organization!.id}, 'main', 'Main') returning id`;
    await sql`
      insert into allrice_employees (organization_id, workspace_id, employee_key, name)
      values (${organization!.id}, ${workspace!.id}, 'office-assistant', 'Office 文档助手')`;
    await expect(verifyDatabase(sql)).resolves.toMatch(/database verified/);
  });

  it('still fails when the employee baseline metadata is wrong', async () => {
    const sql = getDatabase();
    await sql`
      update allrice_runtime_metadata
      set value = jsonb_set(value, '{version}', '"0047"')
      where key = 'employee-catalog-baseline'`;
    await expect(verifyDatabase(sql)).rejects.toThrow(
      'Rice-only employee baseline is missing or invalid',
    );
  });
});
