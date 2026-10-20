import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { employeeManifest } from '../employees/employee-config.ts';
import { readPlatformModelSettings } from './platform-model-settings.ts';
import {
  freezeExperienceModelSnapshot,
  freezeSessionModelSnapshot,
} from './model-pool.ts';

type Sql = ReturnType<typeof client.getDatabase> | TransactionSql;
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

// Real PostgreSQL checks use only the owned disposable fixture.
// The owned fixture seeds a Session identity only; no Run, Job, occurrence,
// provider authorization, model request, tool call or live state is created.
integration('model freeze full SQL chain: isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let schema: string;

  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    const [scope] = await fixture.db<{ schema: string }[]>`
      select current_schema() as schema`;
    if (!scope || !/^p25_[a-f0-9]{32}$/.test(scope.schema)) {
      throw Error('owned_fixture_schema_required');
    }
    schema = scope.schema;
    const relations = await fixture.db<{ schema: string }[]>`
      select n.nspname as schema from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where c.oid in (
        to_regclass('allrice_chat_sessions'),
        to_regclass('allrice_employee_model_policies'),
        to_regclass('allrice_session_model_snapshots'),
        to_regclass('allrice_platform_model_settings'),
        to_regclass('allrice_codex_subscriptions'),
        to_regclass('allrice_model_connections'),
        to_regclass('allrice_model_providers'),
        to_regclass('allrice_model_catalog_entries'))`;
    expect(relations).toHaveLength(8);
    expect(relations.every((row) => row.schema === schema)).toBe(true);
    await fixture.db.begin(async (tx) => {
      await tx`select set_config('search_path', ${schema}, true)`;
      await tx`update allrice_codex_subscriptions set enabled=false`;
      await tx`update allrice_codex_subscriptions set enabled=true where slot=1`;
    });
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  async function seedScope() {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const employeeId = randomUUID();
    const employeeVersionId = randomUUID();
    const assignmentId = randomUUID();
    const sessionId = randomUUID();
    const manifest = employeeManifest({
      key: 'model-freeze-tx-fixture',
      name: 'Model freeze fixture',
      description: 'Synthetic SQL fixture only',
      toolNames: [],
    });
    await fixture.db`insert into allrice_users(id,email,display_name,password_hash)
      values(${ownerId},${`${ownerId}@example.test`},'Model freeze fixture','not-login')`;
    await fixture.db`insert into allrice_organizations(id,slug,name)
      values(${organizationId},${`model-freeze-${organizationId}`},'Model freeze fixture')`;
    await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${workspaceId},${organizationId},'model-freeze','Model freeze fixture')`;
    await fixture.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
      values(${randomUUID()},${organizationId},${workspaceId},${ownerId},'member')`;
    await fixture.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
      values(${employeeId},${organizationId},${workspaceId},'model-freeze-tx-fixture','Model freeze fixture')`;
    await fixture.db`insert into allrice_employee_versions(
      id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,
      capabilities,config_checksum,manifest,provider_snapshot)
      values(${employeeVersionId},${organizationId},${workspaceId},${employeeId},1,
        'Model freeze fixture',${manifest.provider.model},${manifest.systemPrompt},
        ${fixture.db.json(manifest.capabilities)},${`sha256:${'a'.repeat(64)}`},
        ${fixture.db.json(manifest)},${fixture.db.json(manifest.provider)})`;
    await fixture.db`insert into allrice_employee_assignments(
      id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
      values(${assignmentId},${organizationId},${workspaceId},${employeeId},${employeeVersionId},${ownerId})`;
    await fixture.db`insert into allrice_chat_sessions(
      id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${sessionId},${organizationId},${workspaceId},${ownerId},
        'Model freeze fixture',${assignmentId},${employeeVersionId})`;
    return {
      organizationId,
      workspaceId,
      sessionId,
      employeeVersionId,
      employeeId,
      ownerId,
    };
  }

  async function counts(
    scope: Awaited<ReturnType<typeof seedScope>>,
    sql: Sql,
  ) {
    const [row] = await sql<{ policies: number; cache: number }[]>`select
      (select count(*)::int from allrice_employee_model_policies
        where employee_id=${scope.employeeId} and organization_id=${scope.organizationId}
          and workspace_id=${scope.workspaceId}) as policies,
      (select count(*)::int from allrice_session_model_snapshots
        where session_id=${scope.sessionId} and organization_id=${scope.organizationId}
          and workspace_id=${scope.workspaceId}) as cache`;
    if (!row) throw Error('fixture_counts_missing');
    return row;
  }

  function forbidPool() {
    return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
      throw Error('unexpected_global_database');
    });
  }

  it('keeps Session settings, policy and cache changes inside one rollback', async () => {
    const scope = await seedScope();
    const before = await readPlatformModelSettings(fixture.db);
    const configuration = {
      ...before.configuration,
      timeoutMs: before.configuration.timeoutMs === 600_000 ? 300_000 : 600_000,
    };
    expect(await counts(scope, fixture.db)).toEqual({ policies: 0, cache: 0 });
    const rollback = Error('intentional_session_freeze_rollback');
    const pool = forbidPool();
    await expect(
      fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        const [inside] = await tx<{ pid: number }[]>`
          select pg_backend_pid() as pid`;
        await tx`update allrice_platform_model_settings
          set configuration=${tx.json(configuration)}, revision=revision+1 where singleton`;
        const snapshot = await freezeSessionModelSnapshot(scope, tx);
        expect(snapshot).toMatchObject({
          sessionId: scope.sessionId,
          employeeId: scope.employeeId,
          policyRevision: before.revision + 1,
          model: configuration.workModel,
          runLimits: { timeoutMs: configuration.timeoutMs },
          platformSettings: { configuration },
        });
        expect(await counts(scope, tx)).toEqual({ policies: 1, cache: 1 });
        const [observer] = await fixture.db<{ pid: number }[]>`
          select pg_backend_pid() as pid`;
        if (!inside || !observer) throw Error('backend_pid_missing');
        expect(observer.pid).not.toBe(inside.pid);
        expect(await counts(scope, fixture.db)).toEqual({
          policies: 0,
          cache: 0,
        });
        expect(await readPlatformModelSettings(fixture.db)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await counts(scope, fixture.db)).toEqual({ policies: 0, cache: 0 });
    expect(await readPlatformModelSettings(fixture.db)).toEqual(before);
    expect(pool).not.toHaveBeenCalled();
  }, 15_000);

  it('rolls policy creation back when the transaction disables all subscriptions', async () => {
    const scope = await seedScope();
    const pool = forbidPool();
    await expect(
      fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        await tx`update allrice_codex_subscriptions set enabled=false`;
        await freezeSessionModelSnapshot(scope, tx);
      }),
    ).rejects.toMatchObject({ code: 'disabled' });
    expect(await counts(scope, fixture.db)).toEqual({ policies: 0, cache: 0 });
    const slots = await fixture.db<{ slot: number }[]>`
      select slot from allrice_codex_subscriptions where enabled`;
    expect(slots).toEqual([{ slot: 1 }]);
    expect(pool).not.toHaveBeenCalled();
  }, 15_000);

  it('uses the same real transaction for Experience without creating a Session cache', async () => {
    const scope = await seedScope();
    const before = await readPlatformModelSettings(fixture.db);
    const configuration = { ...before.configuration, timeoutMs: 600_000 };
    const occurrenceId = randomUUID();
    const rollback = Error('intentional_experience_freeze_rollback');
    const pool = forbidPool();
    await expect(
      fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        await tx`update allrice_platform_model_settings
          set configuration=${tx.json(configuration)}, revision=revision+1 where singleton`;
        const snapshot = await freezeExperienceModelSnapshot(
          {
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
            employeeId: scope.employeeId,
            ownerId: scope.ownerId,
            occurrenceId,
          },
          tx,
        );
        expect(snapshot).toMatchObject({
          schemaVersion: 2,
          sessionId: null,
          occurrenceId,
          policyRevision: before.revision + 1,
          runLimits: {
            timeoutMs: 300_000,
            maxInputTokens: 24_000,
            maxOutputTokens: 4_000,
            maxTotalTokens: 28_000,
          },
        });
        expect(await counts(scope, tx)).toEqual({ policies: 1, cache: 0 });
        expect(await counts(scope, fixture.db)).toEqual({
          policies: 0,
          cache: 0,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await counts(scope, fixture.db)).toEqual({ policies: 0, cache: 0 });
    expect(await readPlatformModelSettings(fixture.db)).toEqual(before);
    expect(pool).not.toHaveBeenCalled();
  }, 15_000);
});
