import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';

type Database = Awaited<
  ReturnType<typeof createAssistantFixtureDatabase>
>['db'];
type Assistant = Awaited<ReturnType<typeof assistantFixture>>;
const digest = `sha256:${'a'.repeat(64)}`;
const geminiProvider = '51000000-0000-4000-8000-000000000005';
const geminiConnection = '52000000-0000-4000-8000-000000000005';
const geminiCatalog = '53000000-0000-4000-8000-000000000005';
const codexConnection = '52000000-0000-4000-8000-000000000001';
const codexCatalog = '53000000-0000-4000-8000-000000000001';
const migration = await readFile(
  new URL('../migrations/0224_retired_provider_cleanup.sql', import.meta.url),
  'utf8',
);
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

async function scenario(run: (db: Database) => Promise<void>) {
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
  const f = await createAssistantFixtureDatabase({
    throughMigration: '0223_agent_preferences.sql',
  });
  try {
    await f.db`create table allrice_schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await f.db`insert into allrice_schema_migrations(name) values ('0073_gemini_model_provider.sql'),('0075_gemini_provider_compat.sql'),('0117_platform_model_settings.sql')`;
    await run(f.db);
  } finally {
    await f.close();
    vi.unstubAllEnvs();
  }
}
const apply = (db: Database) =>
  db.begin(async (tx) => {
    await tx.unsafe(migration);
  });
const rows = (db: Database, table: string) =>
  db`select to_jsonb(r) as row from ${db(table)} r order by to_jsonb(r)::text`;
async function guards(db: Database) {
  return {
    triggers:
      await db`select tgrelid::regclass::text as relation,tgname,tgenabled from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace=current_schema()::regnamespace) order by 1,2`,
    constraints:
      await db`select conrelid::regclass::text as relation,conname,condeferrable,condeferred,pg_get_constraintdef(oid) as definition from pg_constraint where connamespace=current_schema()::regnamespace order by 1,2`,
  };
}
async function accounting(
  f: Assistant,
  provider: string,
  connectionId: string,
  catalogId: string,
) {
  const db = f.db,
    scope = f.task.scope,
    routeId = randomUUID(),
    callId = randomUUID();
  const [employee] =
    await db`select id from allrice_employees where organization_id=${scope.organizationId}`;
  await db`insert into allrice_assistant_price_snapshots(root_run_id,snapshot_digest,snapshot,currency)
    values(${f.task.runId},${digest},${db.json({ price: { target: { provider, connectionId, catalogId, model: 'synthetic-only' } } })},'USD')`;
  await f.runtime.prepareModelUsage({
    ...f.base,
    runId: f.task.runId,
    callId,
    requestedOutputTokens: 1,
  });
  await f.runtime.dispatchModelUsage({
    ...f.base,
    runId: f.task.runId,
    callId,
    inputTokens: 1,
    outputTokens: 1,
    requestDigest: digest,
  });
  await db`insert into allrice_assistant_cost_receipts(call_id,root_run_id,run_id,snapshot_digest,request_digest,receipt_digest,usage,usage_complete,cache_usage_known,cost_basis,cost_picounits)
    values(${callId},${f.task.runId},${f.task.runId},${digest},${digest},${digest},'{}',true,false,'conservative_upper_bound',1)`;
  await db`insert into allrice_route_decisions(id,organization_id,workspace_id,actor_id,employee_id,run_id,input_checksum,candidates,selected_kind,selected_candidate_id,harness,provider,model,generation,attempt,reason_codes,created_at,model_connection_id,model_catalog_entry_id)
    values(${routeId},${scope.organizationId},${scope.workspaceId},${f.context.actor.id},${employee!.id},${f.task.runId},${digest},'[]','direct','direct','dsh',${provider},'synthetic-only',1,1,'[]',now(),${connectionId},${catalogId})`;
  await db`insert into allrice_model_usage_ledger(id,organization_id,workspace_id,route_decision_id,connection_id,model_catalog_entry_id,status,input_tokens,cached_input_tokens,output_tokens,cost_cents)
    values(${randomUUID()},${scope.organizationId},${scope.workspaceId},${routeId},${connectionId},${catalogId},'succeeded',1,0,1,${provider === 'openai-codex' ? null : 1})`;
  return { routeId, callId };
}
async function gateway(db: Database) {
  const providerId = randomUUID(),
    connectionId = randomUUID(),
    catalogId = randomUUID();
  await db`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode) values(${providerId},'openrouter','Compatible gateway','dsh','api_key')`;
  await db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference) values(${connectionId},${providerId},'platform','Gateway','deployment:openrouter')`;
  await db`insert into allrice_model_catalog_entries(id,provider_id,model,display_name,reasoning_efforts,default_reasoning_effort,input_modalities,output_modalities)
    values(${catalogId},${providerId},'gemini-2.5-pro','Gateway model','[]','none','["text"]','["text"]')`;
  return { providerId, connectionId, catalogId };
}
async function historicalRevision(
  db: Database,
  provider: string,
  credentialReference: string,
) {
  const employeeId = randomUUID(),
    revisionId = randomUUID();
  const model = { provider, credentialReference };
  await db`insert into allrice_platform_employees(id,employee_key,name,description)
    values(${employeeId},${`history-${employeeId}`},'History','Synthetic')`;
  // No published/draft pointer, assignment or test run references this revision.
  await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,runtime_profile,checksum)
    values(${revisionId},${employeeId},1,'published',${db.json({ modelPolicy: model })},${db.json(model)},${digest})`;
  return revisionId;
}

integration('retired provider data deletion', { timeout: 120000 }, () => {
  it('deletes only retired catalog and owned accounting; preserves gateway models, audit, receipts and actual subscription state', async () =>
    scenario(async (db) => {
      const retired = await assistantFixture(db),
        kept = await assistantFixture(db),
        subscribed = await assistantFixture(db);
      const other = await gateway(db);
      const removed = await accounting(
        retired,
        'gemini',
        geminiConnection,
        geminiCatalog,
      );
      const surviving = await accounting(
        kept,
        'openai-compatible',
        other.connectionId,
        other.catalogId,
      );
      const subscription = await accounting(
        subscribed,
        'openai-codex',
        codexConnection,
        codexCatalog,
      );
      await db`insert into allrice_route_subscription_snapshots(route_decision_id,snapshot,snapshot_digest)
      values(${subscription.routeId},${db.json({ version: 1, billingMode: 'subscription', harness: 'dsh', provider: 'openai-codex', authMode: 'chatgpt_subscription', baseUrl: null, connectionId: codexConnection, modelCatalogEntryId: codexCatalog })},${digest})`;
      await db`insert into allrice_subscription_usage_budget_reviews(route_decision_id,organization_id,workspace_id,reserved_tokens,ledger_snapshot,reason,approved_by,request_id)
      values(${subscription.routeId},${subscribed.task.scope.organizationId},${subscribed.task.scope.workspaceId},1234,'{"costCents":null}','Synthetic accepted unknown usage',${subscribed.context.actor.id},${randomUUID()})`;
      await db`insert into allrice_audit_events(id,organization_id,workspace_id,action,resource_type,decision,reason)
      values(${randomUUID()},${retired.task.scope.organizationId},${retired.task.scope.workspaceId},'provider.gemini_credential.saved','provider_credential','recorded','Historical audit must survive')`;
      const preservedTables = [
        'allrice_runs',
        'allrice_jobs',
        'allrice_employees',
        'allrice_employee_versions',
        'allrice_chat_sessions',
        'allrice_audit_events',
        'allrice_route_subscription_snapshots',
        'allrice_subscription_usage_budget_reviews',
        'allrice_platform_model_settings',
      ];
      const before = await Promise.all(preservedTables.map((t) => rows(db, t)));
      const beforeGuards = await guards(db);
      const receipts =
        await db`select * from allrice_assistant_cost_receipts where call_id<>${removed.callId} order by call_id`;
      const ledger =
        await db`select * from allrice_model_usage_ledger where route_decision_id<>${removed.routeId} order by id`;
      expect(receipts).toHaveLength(2);
      expect(ledger).toHaveLength(2);
      expect(
        before[preservedTables.indexOf('allrice_route_subscription_snapshots')],
      ).toHaveLength(1);
      expect(
        before[
          preservedTables.indexOf('allrice_subscription_usage_budget_reviews')
        ],
      ).toHaveLength(1);
      await apply(db);
      for (let i = 0; i < preservedTables.length; i++)
        expect(await rows(db, preservedTables[i]!)).toEqual(before[i]);
      expect(
        await db`select * from allrice_assistant_cost_receipts order by call_id`,
      ).toEqual(receipts);
      expect(
        await db`select * from allrice_model_usage_ledger order by id`,
      ).toEqual(ledger);
      expect(
        await db`select * from allrice_assistant_price_snapshots where root_run_id=${retired.task.runId}`,
      ).toHaveLength(0);
      expect(
        await db`select id from allrice_route_decisions where id=${removed.routeId}`,
      ).toHaveLength(0);
      expect(
        await db`select * from allrice_model_providers where id=${geminiProvider}`,
      ).toHaveLength(0);
      expect(
        await db`select * from allrice_model_connections where id=${geminiConnection}`,
      ).toHaveLength(0);
      expect(
        await db`select * from allrice_model_catalog_entries where id=${geminiCatalog}`,
      ).toHaveLength(0);
      expect(
        await db`select * from allrice_provider_release_controls where connection_id=${geminiConnection}`,
      ).toHaveLength(0);
      expect(
        await db`select model from allrice_model_catalog_entries where id=${other.catalogId}`,
      ).toEqual([{ model: 'gemini-2.5-pro' }]);
      expect(
        await db`select name from allrice_schema_migrations order by name`,
      ).toEqual([
        { name: '0075_gemini_provider_compat.sql' },
        { name: '0117_platform_model_settings.sql' },
      ]);
      const afterGuards = await guards(db);
      expect(afterGuards.triggers).toEqual(beforeGuards.triggers);
      const exceptAuth = (items: typeof beforeGuards.constraints) =>
        items.filter(
          (c) => c.conname !== 'allrice_model_providers_auth_mode_check',
        );
      expect(exceptAuth(afterGuards.constraints)).toEqual(
        exceptAuth(beforeGuards.constraints),
      );
      expect(
        afterGuards.constraints.find(
          (c) => c.conname === 'allrice_model_providers_auth_mode_check',
        )?.definition,
      ).not.toContain('gemini_oauth');
      await expect(
        db`update allrice_model_providers set auth_mode='gemini_oauth' where id=${other.providerId}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db`delete from allrice_assistant_cost_receipts where call_id=${surviving.callId}`,
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        db`delete from allrice_route_subscription_snapshots where route_decision_id=${subscription.routeId}`,
      ).rejects.toMatchObject({ code: '55000' });
    }));

  it('preserves a Codex Run whose business input and frozen preferences contain provider google', async () =>
    scenario(async (db) => {
      const f = await assistantFixture(db),
        scope = f.task.scope;
      const [assignment] =
        await db`select * from allrice_employee_assignments where organization_id=${scope.organizationId}`;
      const [version] =
        await db`select * from allrice_employee_versions where id=${assignment!.employee_version_id}`;
      const userMessage = randomUUID(),
        assistantMessage = randomUUID();
      await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values
      (${userMessage},${scope.organizationId},${scope.workspaceId},${f.task.chatSessionId},${f.context.actor.id},'user','{"text":"帮我比较 Google 搜索结果"}'),
      (${assistantMessage},${scope.organizationId},${scope.workspaceId},${f.task.chatSessionId},${f.context.actor.id},'assistant','{}')`;
      const execution = {
        schemaVersion: 2,
        employee: { definition: version!.manifest },
        modelSnapshot: {
          provider: 'codex',
          connectionId: codexConnection,
          modelCatalogEntryId: codexCatalog,
        },
        userProfile: {
          preferences: {
            search: { provider: 'google' },
            model: 'gemini-2.5-pro',
          },
        },
      };
      await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot)
      values(${f.task.runId},${scope.organizationId},${scope.workspaceId},${f.context.actor.id},${assignment!.id},${assignment!.employee_version_id},${f.task.chatSessionId},${userMessage},${assistantMessage},${db.json(version!.provider_snapshot)},'{}',${db.json(execution)})`;
      await db`update allrice_jobs set payload=jsonb_set(payload,'{input}','{"search":{"provider":"google"},"text":"gemini","connectionId":"52000000-0000-4000-8000-000000000005"}') where id=${f.worker.jobId}`;
      const tables = [
        'allrice_jobs',
        'allrice_runs',
        'allrice_employee_runs',
        'allrice_employee_versions',
        'allrice_chat_sessions',
      ];
      const before = await Promise.all(tables.map((t) => rows(db, t)));
      await apply(db);
      for (let i = 0; i < tables.length; i++)
        expect(await rows(db, tables[i]!)).toEqual(before[i]);
    }));

  it('aborts with the employee ID for a Gemini publication plus Codex draft and preserves its Codex test and audit', async () =>
    scenario(async (db) => {
      const employeeId = randomUUID(),
        published = randomUUID(),
        draft = randomUUID();
      const f = await assistantFixture(db);
      await db`insert into allrice_audit_events(id,organization_id,workspace_id,action,resource_type,resource_id,decision,reason)
        values(${randomUUID()},${f.task.scope.organizationId},${f.task.scope.workspaceId},'employee.published','platform_employee',${employeeId},'recorded','Mixed employee history')`;
      await db`insert into allrice_platform_employees(id,employee_key,name,description) values(${employeeId},${`mixed-${employeeId}`},'Mixed','Synthetic')`;
      await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,runtime_profile,checksum) values
      (${published},${employeeId},1,'published','{"modelPolicy":{"provider":"gemini"}}','{"provider":"gemini"}',${digest}),
      (${draft},${employeeId},2,'draft','{"modelPolicy":{"provider":"openai-codex"}}','{"provider":"openai-codex"}',${digest})`;
      await db`update allrice_platform_employees set current_published_revision_id=${published},current_draft_revision_id=${draft} where id=${employeeId}`;
      await db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,frozen_definition,frozen_runtime_profile)
      values(${randomUUID()},${employeeId},${draft},'Synthetic','succeeded','{}','{"modelPolicy":{"provider":"openai-codex"}}','{"provider":"openai-codex"}')`;
      const tables = [
        'allrice_platform_employees',
        'allrice_platform_employee_revisions',
        'allrice_platform_employee_test_runs',
        'allrice_audit_events',
        'allrice_model_providers',
        'allrice_schema_migrations',
      ];
      const before = await Promise.all(tables.map((t) => rows(db, t))),
        beforeGuards = await guards(db);
      await expect(apply(db)).rejects.toMatchObject({
        code: '23503',
        message: expect.stringContaining('MET226_SHARED_REFERENCE'),
        detail: expect.stringMatching(
          new RegExp(`(?=.*allrice_platform_employees)(?=.*${employeeId})`),
        ),
      });
      for (let i = 0; i < tables.length; i++)
        expect(await rows(db, tables[i]!)).toEqual(before[i]);
      expect(await guards(db)).toEqual(beforeGuards);
    }));

  it('aborts on an explicit shared JSON connection reference without rewriting platform settings', async () =>
    scenario(async (db) => {
      await db`update allrice_platform_model_settings set configuration=jsonb_set(configuration,'{connectionId}',${db.json(geminiConnection)})`;
      const settings = await rows(db, 'allrice_platform_model_settings');
      await expect(apply(db)).rejects.toMatchObject({
        code: '23503',
        detail: expect.stringContaining('allrice_platform_model_settings'),
      });
      expect(await rows(db, 'allrice_platform_model_settings')).toEqual(
        settings,
      );
      expect(
        await db`select id from allrice_model_providers where id=${geminiProvider}`,
      ).toHaveLength(1);
    }));

  it.each(['deployment:shared-gateway', 'deployment:gemini-default'])(
    'aborts with connection and unreferenced version IDs when providers share %s',
    async (credentialReference) =>
      scenario(async (db) => {
        const other = await gateway(db);
        await db`update allrice_model_connections set credential_reference=${credentialReference}
          where id in (${geminiConnection},${other.connectionId})`;
        const revisionId = await historicalRevision(
          db,
          'openai-compatible',
          credentialReference,
        );
        const f = await assistantFixture(db);
        const versionId = randomUUID();
        const provider = { provider: 'codex', credentialReference };
        await db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
          select ${versionId},organization_id,workspace_id,employee_id,2,name,model,system_prompt,capabilities,config_checksum,
            jsonb_set(manifest,'{provider}',${db.json(provider)}),${db.json(provider)}
          from allrice_employee_versions where organization_id=${f.task.scope.organizationId}`;
        const tables = [
          'allrice_model_connections',
          'allrice_model_providers',
          'allrice_model_catalog_entries',
          'allrice_platform_employee_revisions',
          'allrice_employee_versions',
          'allrice_schema_migrations',
        ];
        const before = await Promise.all(tables.map((t) => rows(db, t))),
          beforeGuards = await guards(db);
        const error = await apply(db).then(
          () => null,
          (error: unknown) => error,
        );
        expect(error).toMatchObject({
          code: '23503',
          message: expect.stringContaining('MET226_SHARED_REFERENCE'),
        });
        expect(JSON.parse((error as { detail: string }).detail)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table: 'allrice_model_connections',
              ids: { id: other.connectionId },
            }),
            expect.objectContaining({
              table: 'allrice_platform_employee_revisions',
              ids: { id: revisionId },
            }),
            expect.objectContaining({
              table: 'allrice_employee_versions',
              ids: { id: versionId },
            }),
          ]),
        );
        for (let i = 0; i < tables.length; i++)
          expect(await rows(db, tables[i]!)).toEqual(before[i]);
        expect(await guards(db)).toEqual(beforeGuards);
      }),
  );

  it('preserves non-Gemini connections and versions using the old credential name without a retired owner', async () =>
    scenario(async (db) => {
      const other = await gateway(db);
      await db`update allrice_model_connections set credential_reference='deployment:retired-only' where id=${geminiConnection}`;
      await db`update allrice_model_connections set credential_reference='deployment:gemini-default' where id=${other.connectionId}`;
      await historicalRevision(
        db,
        'openai-compatible',
        'deployment:gemini-default',
      );
      const revisions = await rows(db, 'allrice_platform_employee_revisions');
      const connections =
        await db`select * from allrice_model_connections where id<>${geminiConnection} order by id`;
      await apply(db);
      expect(await rows(db, 'allrice_platform_employee_revisions')).toEqual(
        revisions,
      );
      expect(
        await db`select * from allrice_model_connections order by id`,
      ).toEqual(connections);
      expect(
        await db`select id from allrice_model_providers where id=${geminiProvider}`,
      ).toHaveLength(0);
    }));

  it('aborts when a retired historical version shares credentials with a surviving version without a current connection', async () =>
    scenario(async (db) => {
      const credentialReference = 'deployment:historical-shared';
      await historicalRevision(db, 'gemini', credentialReference);
      const kept = await historicalRevision(
        db,
        'openai-compatible',
        credentialReference,
      );
      const before = await rows(db, 'allrice_platform_employee_revisions');
      await expect(apply(db)).rejects.toMatchObject({
        code: '23503',
        message: expect.stringContaining('MET226_SHARED_REFERENCE'),
        detail: expect.stringMatching(
          new RegExp(`(?=.*allrice_platform_employee_revisions)(?=.*${kept})`),
        ),
      });
      expect(await rows(db, 'allrice_platform_employee_revisions')).toEqual(
        before,
      );
      expect(
        await db`select id from allrice_model_providers where id=${geminiProvider}`,
      ).toHaveLength(1);
    }));

  it('removes gemini_oauth even under another provider key, only with its owned catalog and connection', async () =>
    scenario(async (db) => {
      const other = await gateway(db);
      await db`update allrice_model_providers set provider_key='zhipu',auth_mode='gemini_oauth' where id=${other.providerId}`;
      const kept =
        await db`select * from allrice_model_providers where id not in (${other.providerId},${geminiProvider}) order by id`;
      await apply(db);
      expect(
        await db`select * from allrice_model_providers order by id`,
      ).toEqual(kept);
      expect(
        await db`select * from allrice_model_connections where id=${other.connectionId}`,
      ).toHaveLength(0);
      expect(
        await db`select * from allrice_model_catalog_entries where id=${other.catalogId}`,
      ).toHaveLength(0);
    }));

  it('rolls back deleted data, registration and guard changes when a later statement fails', async () =>
    scenario(async (db) => {
      await db.unsafe(`create function met226_inject_failure() returns trigger language plpgsql as $$ begin
      if exists(select 1 from allrice_model_providers where id='${geminiProvider}') then raise exception 'TEST_DID_NOT_REACH_DELETION'; end if;
      raise exception 'MET226_TEST_FAILURE_AFTER_DELETE'; end $$;
      create trigger met226_inject_failure before delete on allrice_schema_migrations for each row execute function met226_inject_failure();`);
      const tables = [
        'allrice_model_providers',
        'allrice_model_connections',
        'allrice_model_catalog_entries',
        'allrice_provider_release_controls',
        'allrice_schema_migrations',
      ];
      const before = await Promise.all(tables.map((t) => rows(db, t))),
        beforeGuards = await guards(db);
      await expect(apply(db)).rejects.toMatchObject({
        message: 'MET226_TEST_FAILURE_AFTER_DELETE',
      });
      for (let i = 0; i < tables.length; i++)
        expect(await rows(db, tables[i]!)).toEqual(before[i]);
      expect(await guards(db)).toEqual(beforeGuards);
      expect(
        await db`select to_regclass('pg_temp.met226_rows')::text as helper`,
      ).toEqual([{ helper: null }]);
    }));

  it('preserves unrelated deferred constraint semantics for the next migration in the same transaction', async () =>
    scenario(async (db) => {
      await db`create table met226_next_parent(id integer primary key)`;
      await db`create table met226_next_child(id integer references met226_next_parent(id) deferrable initially deferred)`;
      await db.begin(async (tx) => {
        await tx.unsafe(migration);
        await tx`insert into met226_next_child values(1)`;
        await tx`insert into met226_next_parent values(1)`;
      });
      expect(await db`select * from met226_next_child`).toEqual([{ id: 1 }]);
    }));

  it('also bootstraps all migrations in one transaction on a new isolated schema', async () => {
    const f = await createAssistantFixtureDatabase({ ownSchemaOnly: true });
    try {
      expect(
        await f.db`select id from allrice_model_providers where provider_key in ('gemini','google') or auth_mode='gemini_oauth'`,
      ).toHaveLength(0);
      expect(
        await f.db`select to_regclass('pg_temp.met226_rows')::text as helper`,
      ).toEqual([{ helper: null }]);
    } finally {
      await f.close();
    }
  });
});
