import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, getDatabase } from '../core/client.ts';
import { loadPlatformContentCatalog } from './catalog.ts';
import {
  buildPlatformContentCatalogMetadata,
  synchronizePlatformContent,
} from './sync.ts';

const runIntegration = process.env.ALLRICE_RUN_DB_INTEGRATION === '1';
const describeDatabase = runIntegration ? describe.sequential : describe.skip;
const migrationsDirectory = new URL('../../migrations/', import.meta.url);
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminSql: ReturnType<typeof postgres> | undefined;
let schemaName = '';

function databaseUrlWithSearchPath(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  return url.toString();
}

describeDatabase('platform content synchronization (PostgreSQL)', () => {
  beforeAll(async () => {
    const baseDatabaseUrl =
      process.env.ALLRICE_TEST_DATABASE_URL ??
      originalDatabaseUrl ??
      'postgres://allrice:allrice@localhost:5432/allrice_dev';
    const baseUrl = new URL(baseDatabaseUrl);
    baseUrl.search = '';
    schemaName = `platform_content_${randomUUID().replaceAll('-', '')}`;
    adminSql = postgres(baseUrl.toString(), { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`create schema "${schemaName}"`);

    const scopedDatabaseUrl = databaseUrlWithSearchPath(
      baseUrl.toString(),
      schemaName,
    );
    const migrationSql = postgres(scopedDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });
    try {
      const files = (await readdir(migrationsDirectory))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      await migrationSql.begin(async (transaction) => {
        for (const file of files) {
          await transaction.unsafe(
            await readFile(new URL(file, migrationsDirectory), 'utf8'),
          );
        }
      });
    } finally {
      await migrationSql.end({ timeout: 5 });
    }
    process.env.DATABASE_URL = scopedDatabaseUrl;
  }, 120_000);

  afterAll(async () => {
    await closeDatabase();
    if (adminSql && schemaName) {
      await adminSql.unsafe(`drop schema if exists "${schemaName}" cascade`);
      await adminSql.end({ timeout: 5 });
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 30_000);

  it('is idempotent, preserves unmanaged and employee data, and refreshes review evidence', async () => {
    const catalog = await loadPlatformContentCatalog();
    const sql = getDatabase();
    await synchronizePlatformContent(catalog);

    const employeeStateBefore = await sql<
      { revisions: string; assignments: string }[]
    >`
      select
        (select count(*)::text from allrice_platform_employee_revisions) as revisions,
        (select count(*)::text from allrice_platform_employee_tenant_assignments) as assignments
    `;
    const unmanagedId = randomUUID();
    await sql`
      insert into allrice_platform_dsh_skills (
        id, name, description, content, checksum, model_invocable,
        user_invocable, required_tool_refs, enabled, source, created_by_label,
        source_ref, version, license, review_status, reviewed_by_label,
        reviewed_at
      ) values (
        ${unmanagedId}, 'operator-managed', 'Operator managed', '# Operator\n',
        ${`sha256:${'f'.repeat(64)}`}, true, true, ${sql.json([])}, true,
        'allrice', 'integration-test',
        ${`https://example.test/operator-managed?content-sha256=${'f'.repeat(64)}`},
        '1.0.0', 'Apache-2.0', 'reviewed', 'integration-test', now()
      )
    `;

    const managed = catalog.skills[0]!;
    const oldReviewedAt = new Date('2000-01-01T00:00:00.000Z');
    await sql`
      update allrice_platform_dsh_skills
      set description = 'Previous reviewed description', content = '# Previous\n',
        checksum = ${`sha256:${'e'.repeat(64)}`}, version = '0.0.1',
        source_ref = 'https://example.test/previous',
        reviewed_at = ${oldReviewedAt}
      where id = ${managed.id}
    `;

    const repaired = await synchronizePlatformContent(catalog);
    expect(repaired.updated).toBe(1);
    const reviewedRows = await sql<
      { reviewed_at: Date; checksum: string; version: string }[]
    >`
      select reviewed_at, checksum, version
      from allrice_platform_dsh_skills where id = ${managed.id}
    `;
    expect(reviewedRows[0]?.reviewed_at.getTime()).toBeGreaterThan(
      oldReviewedAt.getTime(),
    );
    expect(reviewedRows[0]?.checksum).toBe(managed.checksum);
    expect(reviewedRows[0]?.version).toBe(managed.version);

    const replay = await synchronizePlatformContent(catalog);
    expect(replay.inserted).toBe(0);
    expect(replay.updated).toBe(0);
    expect(replay.unchanged).toBe(catalog.skills.length);

    const preservedRows = await sql<{ count: string }[]>`
      select count(*)::text as count
      from allrice_platform_dsh_skills where id = ${unmanagedId}
    `;
    expect(preservedRows[0]?.count).toBe('1');
    const employeeStateAfter = await sql<
      { revisions: string; assignments: string }[]
    >`
      select
        (select count(*)::text from allrice_platform_employee_revisions) as revisions,
        (select count(*)::text from allrice_platform_employee_tenant_assignments) as assignments
    `;
    expect(employeeStateAfter).toEqual(employeeStateBefore);

    const metadata = buildPlatformContentCatalogMetadata(catalog);
    const metadataRows = await sql<{ matches: boolean }[]>`
      select exists (
        select 1 from allrice_runtime_metadata
        where key = 'platform-content-catalog'
          and value = ${sql.json(metadata)}
      ) as matches
    `;
    expect(metadataRows[0]?.matches).toBe(true);

    await expect(
      synchronizePlatformContent({
        ...catalog,
        skills: [
          { ...catalog.skills[0]!, name: 'reused-identity' },
          ...catalog.skills.slice(1),
        ],
      }),
    ).rejects.toThrow(`platform_skill_identity_conflict:${managed.id}`);
    const metadataAfterRollback = await sql<{ matches: boolean }[]>`
      select exists (
        select 1 from allrice_runtime_metadata
        where key = 'platform-content-catalog'
          and value = ${sql.json(metadata)}
      ) as matches
    `;
    expect(metadataAfterRollback[0]?.matches).toBe(true);
  }, 60_000);
});
