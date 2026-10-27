import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
integration('retired provider data deletion', () => {
  it('deletes frozen accounting and catalog dependents, preserves subscription state and restores database guards', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = await createAssistantFixtureDatabase({
      throughMigration: '0223_agent_preferences.sql',
    });
    const db = f.db;
    try {
      const retired = await assistantFixture(db);
      const kept = await assistantFixture(db);
      const [catalog] =
        await db`select p.provider_key,p.auth_mode,c.id as connection_id,m.id as catalog_id,m.model
        from allrice_model_providers p join allrice_model_connections c on c.provider_id=p.id
        join allrice_model_catalog_entries m on m.provider_id=p.id where p.id='51000000-0000-4000-8000-000000000005'`;
      expect(catalog).toBeDefined();
      const settings = await db`select * from allrice_platform_model_settings`;
      const providers =
        await db`select * from allrice_model_providers where id<>'51000000-0000-4000-8000-000000000005' order by id`;
      const guards =
        () => db`select tgrelid::regclass::text as relation,tgname,tgenabled from pg_trigger
        where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace=current_schema()::regnamespace) order by 1,2`;
      const constraints =
        () => db`select conrelid::regclass::text as relation,conname,condeferrable,condeferred
        from pg_constraint where contype='f' and connamespace=current_schema()::regnamespace order by 1,2`;
      const beforeGuards = await guards(),
        beforeConstraints = await constraints();
      const scope = retired.task.scope;
      const digest = `sha256:${'a'.repeat(64)}`;
      await db`insert into allrice_assistant_price_snapshots(root_run_id,snapshot_digest,snapshot,currency)
        values(${retired.task.runId},${digest},${db.json({ price: { target: { provider: catalog!.provider_key, model: catalog!.model } } })},'USD')`;
      const callId = randomUUID();
      await retired.runtime.prepareModelUsage({
        ...retired.base,
        runId: retired.task.runId,
        callId,
        requestedOutputTokens: 1,
      });
      await retired.runtime.dispatchModelUsage({
        ...retired.base,
        runId: retired.task.runId,
        callId,
        inputTokens: 1,
        outputTokens: 1,
        requestDigest: digest,
      });
      await db`insert into allrice_assistant_cost_receipts(call_id,root_run_id,run_id,snapshot_digest,request_digest,receipt_digest,usage,usage_complete,cache_usage_known,cost_basis,cost_picounits)
        values(${callId},${retired.task.runId},${retired.task.runId},${digest},${digest},${digest},'{}',true,false,'conservative_upper_bound',1)`;
      const routeId = randomUUID();
      const [employee] =
        await db`select id from allrice_employees where organization_id=${scope.organizationId}`;
      await db`insert into allrice_route_decisions(id,organization_id,workspace_id,actor_id,employee_id,run_id,input_checksum,candidates,selected_kind,selected_candidate_id,harness,provider,model,generation,attempt,reason_codes,created_at,model_connection_id,model_catalog_entry_id)
        values(${routeId},${scope.organizationId},${scope.workspaceId},${retired.context.actor.id},${employee!.id},${retired.task.runId},${digest},'[]','direct','direct','dsh',${catalog!.provider_key},${catalog!.model},1,1,'[]',now(),${catalog!.connection_id},${catalog!.catalog_id})`;
      await db`insert into allrice_model_usage_ledger(id,organization_id,workspace_id,route_decision_id,connection_id,model_catalog_entry_id,status,input_tokens,cached_input_tokens,output_tokens,cost_cents)
        values(${randomUUID()},${scope.organizationId},${scope.workspaceId},${routeId},${catalog!.connection_id},${catalog!.catalog_id},'succeeded',1,0,1,1)`;
      const removedAudit = randomUUID(),
        keptAudit = randomUUID();
      await db`insert into allrice_audit_events(id,organization_id,workspace_id,action,resource_type,decision,reason) values
        (${removedAudit},${scope.organizationId},${scope.workspaceId},${`provider.${catalog!.provider_key}_credential.saved`},'provider_credential','recorded','synthetic'),
        (${keptAudit},${scope.organizationId},${scope.workspaceId},'unrelated','document','recorded',${`A document mentioning ${catalog!.provider_key}`})`;
      const migration = await readFile(
        new URL(
          '../migrations/0224_retired_provider_cleanup.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await db.begin(async (tx) => {
        await tx.unsafe(migration);
      });
      for (const table of [
        'allrice_assistant_price_snapshots',
        'allrice_assistant_cost_receipts',
        'allrice_model_usage_ledger',
        'allrice_route_decisions',
      ])
        expect(await db`select count(*)::int as n from ${db(table)}`).toEqual([
          { n: 0 },
        ]);
      expect(
        await db`select id from allrice_runs where id=${retired.task.runId}`,
      ).toHaveLength(0);
      expect(
        await db`select id from allrice_runs where id=${kept.task.runId}`,
      ).toHaveLength(1);
      expect(
        await db`select id from allrice_audit_events where id=${removedAudit}`,
      ).toHaveLength(0);
      expect(
        await db`select id from allrice_audit_events where id=${keptAudit}`,
      ).toHaveLength(1);
      expect(await db`select * from allrice_platform_model_settings`).toEqual(
        settings,
      );
      expect(
        await db`select * from allrice_model_providers order by id`,
      ).toEqual(providers);
      expect(await guards()).toEqual(beforeGuards);
      expect(await constraints()).toEqual(beforeConstraints);
      await db`insert into allrice_assistant_price_snapshots(root_run_id,snapshot_digest,snapshot,currency)
        values(${kept.task.runId},${digest},'{}','USD')`;
      await expect(
        db`delete from allrice_assistant_price_snapshots where root_run_id=${kept.task.runId}`,
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await f.close();
      vi.unstubAllEnvs();
    }
  }, 120000);
});
