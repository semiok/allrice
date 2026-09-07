import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type * as DatabaseClient from './core/client.ts';
import { listModelPool } from './providers/model-pool.ts';
import { admitModelExecution } from './providers/model-governance.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let admin: ReturnType<typeof postgres>, database: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => database,
}));
const schema = `gemini_compat_test_${randomUUID().replaceAll('-', '')}`;
const providerId = '51000000-0000-4000-8000-000000000004';
const user = randomUUID();
let originalProviders: unknown;
let migration: string;
const context: RequestContext = {
  actor: { type: 'user', id: user },
  requestId: randomUUID(),
  sessionId: randomUUID(),
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};

suite('Gemini compatibility on real isolated PostgreSQL', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('ALLRICE_TEST_DATABASE_URL required');
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    if (url.pathname !== '/allrice_b1')
      throw Error('Only the disposable allrice_b1 database is permitted');
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.begin(async (t) => {
      await t`select pg_advisory_xact_lock(20260907,1)`;
      await t`create extension if not exists vector with schema public`;
      await t`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    database = postgres(url.toString(), { max: 2, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql') && !f.startsWith('0075'))
      .sort())
      await database.unsafe(await readFile(new URL(file, directory), 'utf8'));
    originalProviders =
      await database`select id,provider_key,auth_mode,enabled from allrice_model_providers order by id`;
    migration = await readFile(
      new URL('0075_gemini_provider_compat.sql', directory),
      'utf8',
    );
    await database.unsafe(migration);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'gemini-compat@example.test');
    await database`insert into allrice_users(id,email,display_name,password_hash) values (${user},'gemini-compat@example.test','Synthetic','not-login')`;
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.end();
    if (admin) {
      if (!/^gemini_compat_test_[a-f0-9]{32}$/.test(schema))
        throw Error('invalid synthetic schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
  it('does not change existing providers and seeds Gemini disabled on fresh DB', async () => {
    expect(
      await database`select id,provider_key,auth_mode,enabled from allrice_model_providers where provider_key <> 'gemini' order by id`,
    ).toEqual(originalProviders);
    expect(
      await database`select p.enabled,c.status,m.enabled as model_enabled from allrice_model_providers p join allrice_model_connections c on c.provider_id=p.id join allrice_model_catalog_entries m on m.provider_id=p.id where p.provider_key='gemini'`,
    ).toEqual([{ enabled: false, status: 'disabled', model_enabled: false }]);
  });
  it('preserves the repurposed legacy ID/auth and reads its catalog as unsupported', async () => {
    await database`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode,enabled) values (${providerId},'zhipu','Synthetic legacy','dsh','gemini_oauth',true)`;
    const before =
      await database`select * from allrice_model_providers where id=${providerId}`;
    await database.unsafe(migration);
    expect(
      await database`select * from allrice_model_providers where id=${providerId}`,
    ).toEqual(before);
    const pool = await listModelPool(context);
    expect(pool.providers.find((p) => p.key === 'zhipu')).toMatchObject({
      key: 'zhipu',
      runtimeSupported: false,
    });
    expect(pool.providers.find((p) => p.key === 'codex')).toMatchObject({
      runtimeSupported: true,
    });
  });
  it('does not auto-reset administrator changes on migration rerun', async () => {
    await database`update allrice_model_providers set enabled=true where provider_key='gemini'`;
    await database.unsafe(migration);
    expect(
      await database`select enabled from allrice_model_providers where provider_key='gemini'`,
    ).toEqual([{ enabled: true }]);
  });
  it('keeps an explicit release denial even if the catalog is enabled', async () => {
    expect(
      await database`select release_stage,production_approved from allrice_provider_release_controls where connection_id='52000000-0000-4000-8000-000000000005'`,
    ).toEqual([{ release_stage: 'disabled', production_approved: false }]);
    await expect(
      admitModelExecution({
        organizationId: context.organizationId,
        workspaceId: context.workspaceId!,
        userId: user,
        employeeId: randomUUID(),
        connectionId: '52000000-0000-4000-8000-000000000005',
        requestedTokens: 1,
        requestedRuntimeMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_RELEASED' });
    await database`update allrice_provider_release_controls set release_stage='canary',allowlisted_organization_ids=array[${context.organizationId}]::uuid[] where connection_id='52000000-0000-4000-8000-000000000005'`;
    await database.unsafe(migration);
    expect(
      await database`select release_stage,allowlisted_organization_ids from allrice_provider_release_controls where connection_id='52000000-0000-4000-8000-000000000005'`,
    ).toEqual([
      {
        release_stage: 'canary',
        allowlisted_organization_ids: [context.organizationId],
      },
    ]);
  });
});
