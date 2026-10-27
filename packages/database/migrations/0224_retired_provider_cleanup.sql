-- MET-226, user decision 2026-10-27: retire Gemini data, not shared history.
-- Only the explicit model/authentication paths below are inspected. Inbound
-- references from surviving rows abort the transaction; they never extend the
-- deletion set. Rehearsal A must use a current Dev copy, with writers stopped.
set local lock_timeout = '15s';

create temporary table met226_rows (
  relation oid not null, tuple tid not null, primary key (relation, tuple)
) on commit drop;
create temporary table met226_providers on commit drop as
select id from allrice_model_providers
where provider_key in ('gemini','google') or auth_mode='gemini_oauth';
create temporary table met226_connections on commit drop as
select id, credential_reference from allrice_model_connections
where provider_id in (select id from met226_providers);
create temporary table met226_catalog on commit drop as
select id from allrice_model_catalog_entries
where provider_id in (select id from met226_providers);

-- A single, already selected model configuration object, never arbitrary JSON.
-- Model names are deliberately irrelevant: gateways may offer gemini-* models.
create function pg_temp.met226_target(value jsonb) returns boolean
language sql stable as $$
  select coalesce(
    value->>'provider' in ('gemini','google') or
    value->>'route' in ('gemini','google') or
    value->>'authMode'='gemini_oauth' or
    value->>'providerId' in (select id::text from met226_providers) or
    value->>'connectionId' in (select id::text from met226_connections) or
    value->>'modelCatalogEntryId' in (select id::text from met226_catalog) or
    value->>'catalogId' in (select id::text from met226_catalog), false)
$$;

-- Credential references can be shared across providers, including the old
-- deployment:gemini-default name. They can block deletion, never select it.
create temporary table met226_credentials (reference text primary key) on commit drop;
create function pg_temp.met226_reference(value jsonb) returns boolean
language sql stable as $$
  select pg_temp.met226_target(value) or coalesce(
    value->>'credentialReference' in (select reference from met226_credentials), false)
$$;
create function pg_temp.met226_model(value jsonb) returns boolean
language sql stable as $$
  select pg_temp.met226_reference(value)
    or pg_temp.met226_reference(value #> '{platformSettings,configuration}')
    or exists (
      select 1 from (
        select jsonb_path_query(value,'strict $.fallbackTargets[*]',silent => true) as target
        union all
        select jsonb_path_query(value,'strict $.resolvedFallbacks[*]',silent => true)
      ) f where pg_temp.met226_reference(f.target)
    )
    -- These are qualified routing strings, not unqualified model names.
    or coalesce(value @? 'strict $.fallbackModels[*] ? (@ like_regex "^(gemini|google)[:/]")',false)
$$;

-- Each rule names its table and field. "removable" is limited to provider-owned
-- rows or a row whose own primary model is retired. A Codex definition with a
-- retired fallback, shared settings, sessions and Run identities must survive.
create temporary table met226_rules (relation regclass, predicate text, removable boolean) on commit drop;
insert into met226_rules values
  ('allrice_model_providers', 'id in (select id from met226_providers)', true),
  ('allrice_model_connections', 'id in (select id from met226_connections)', true),
  ('allrice_model_catalog_entries', 'id in (select id from met226_catalog)', true),
  ('allrice_provider_release_controls', 'connection_id in (select id from met226_connections)', true),
  ('allrice_provider_circuit_breakers', 'connection_id in (select id from met226_connections)', true),
  ('allrice_provider_authorization_flows', 'provider_id in (select id from met226_providers) or connection_id in (select id from met226_connections)', true),
  ('allrice_provider_grants', 'provider_id in (select id from met226_providers) or connection_id in (select id from met226_connections) or auth_mode=''gemini_oauth''', true),
  ('allrice_credential_bindings', 'provider in (''gemini'',''google'')', true),
  ('allrice_model_resource_limits', 'scope_type=''provider'' and scope_id in (select id from met226_connections)', true),
  ('allrice_employee_versions', 'pg_temp.met226_target(provider_snapshot) or pg_temp.met226_target(manifest->''provider'')', true),
  ('allrice_platform_employee_revisions', 'pg_temp.met226_target(definition->''modelPolicy'') or pg_temp.met226_target(runtime_profile)', true),
  ('allrice_platform_employee_test_runs', 'pg_temp.met226_target(frozen_definition->''modelPolicy'') or pg_temp.met226_target(frozen_runtime_profile)', true),
  ('allrice_assistant_price_snapshots', 'pg_temp.met226_target(snapshot #> ''{price,target}'')', true),
  ('allrice_route_decisions', 'provider in (''gemini'',''google'') or model_connection_id in (select id from met226_connections) or model_catalog_entry_id in (select id from met226_catalog)', true),
  ('allrice_model_connections', 'credential_reference in (select reference from met226_credentials)', false),
  ('allrice_employee_versions', 'pg_temp.met226_reference(provider_snapshot) or pg_temp.met226_reference(manifest->''provider'')', false),
  ('allrice_assistant_price_snapshots', 'pg_temp.met226_reference(snapshot #> ''{price,target}'')', false),
  ('allrice_employee_versions', 'pg_temp.met226_model(manifest->''runtimePolicy'')', false),
  ('allrice_platform_employee_revisions', 'pg_temp.met226_model(definition->''modelPolicy'') or pg_temp.met226_model(runtime_profile)', false),
  ('allrice_platform_employee_test_runs', 'pg_temp.met226_model(frozen_definition->''modelPolicy'') or pg_temp.met226_model(frozen_runtime_profile)', false),
  ('allrice_platform_model_settings', 'pg_temp.met226_reference(configuration)', false),
  ('allrice_employee_model_policies', 'connection_id in (select id from met226_connections) or model_catalog_entry_id in (select id from met226_catalog) or exists (select 1 from jsonb_array_elements(fallback_targets) f where pg_temp.met226_reference(f))', false),
  ('allrice_session_model_snapshots', 'connection_id in (select id from met226_connections) or model_catalog_entry_id in (select id from met226_catalog) or pg_temp.met226_model(snapshot)', false),
  ('allrice_employee_runs', 'pg_temp.met226_reference(provider_snapshot) or pg_temp.met226_reference(execution_snapshot->''providerSnapshot'') or pg_temp.met226_reference(execution_snapshot #> ''{definition,provider}'') or pg_temp.met226_model(execution_snapshot #> ''{definition,runtimePolicy}'') or pg_temp.met226_reference(execution_snapshot #> ''{employee,definition,provider}'') or pg_temp.met226_model(execution_snapshot #> ''{employee,definition,runtimePolicy}'') or pg_temp.met226_model(execution_snapshot->''runtimePolicy'') or pg_temp.met226_model(execution_snapshot->''modelSnapshot'')', false),
  ('allrice_skill_runs', 'pg_temp.met226_reference(provider_snapshot)', false),
  ('allrice_employee_method_tests', 'pg_temp.met226_model(model_snapshot)', false),
  ('allrice_route_subscription_snapshots', 'pg_temp.met226_model(snapshot)', false),
  ('allrice_runs', 'pg_temp.met226_reference(execution_spec)', false),
  ('allrice_runs', 'execution_spec->>''employeeVersionId'' in (select v.id::text from allrice_employee_versions v join met226_rows d on d.relation=v.tableoid and d.tuple=v.ctid) or execution_spec->>''platformEmployeeTestRunId'' in (select t.id::text from allrice_platform_employee_test_runs t join met226_rows d on d.relation=t.tableoid and d.tuple=t.ctid)', false),
  -- JobPayloadSchema has only schemaVersion/type/input; input is business data.
  -- There is no routing field in jobs.payload, so it is not inspected at all.
  ('allrice_dsh_runtime_instances', 'provider_route in (''gemini'',''google'')', false),
  ('allrice_route_decisions', 'exists (select 1 from jsonb_array_elements(candidates) c where pg_temp.met226_reference(c))', false);

do $$ declare item record; begin
  for item in select * from met226_rules where removable loop
    execute format('insert into met226_rows select tableoid,ctid from %s where %s on conflict do nothing',item.relation,item.predicate);
  end loop;
end $$;

-- Only these two accounting tables are exclusively owned by a selected record.
-- Do not promote a price/route to its owning Run, employee, session or audit.
insert into met226_rows
select r.tableoid,r.ctid from allrice_assistant_cost_receipts r
join allrice_assistant_price_snapshots p on p.root_run_id=r.root_run_id and p.snapshot_digest=r.snapshot_digest
join met226_rows d on d.relation=p.tableoid and d.tuple=p.ctid;
insert into met226_rows
select l.tableoid,l.ctid from allrice_model_usage_ledger l
join allrice_route_decisions r on r.id=l.route_decision_id
join met226_rows d on d.relation=r.tableoid and d.tuple=r.ctid;

-- Collect references only after ownership has determined the deletion set.
-- Historical versions may carry credentials without a current connection.
insert into met226_credentials
select credential_reference from met226_connections where credential_reference is not null
union
select c.value->>'credentialReference' from (
  select v.tableoid as relation,v.ctid as tuple,c.value
  from allrice_employee_versions v
  cross join lateral (values (v.provider_snapshot),(v.manifest->'provider')) c(value)
  union all
  select v.tableoid,v.ctid,c.value from allrice_platform_employee_revisions v
  cross join lateral (values (v.definition->'modelPolicy'),(v.runtime_profile)) c(value)
  union all
  select v.tableoid,v.ctid,c.value from allrice_platform_employee_test_runs v
  cross join lateral (values (v.frozen_definition->'modelPolicy'),(v.frozen_runtime_profile)) c(value)
  union all
  select p.tableoid,p.ctid,p.snapshot #> '{price,target}' from allrice_assistant_price_snapshots p
) c join met226_rows d on d.relation=c.relation and d.tuple=c.tuple
where c.value->>'credentialReference' is not null;

create temporary table met226_blockers (relation regclass, identity jsonb, reference text) on commit drop;
create function pg_temp.met226_identity(relation oid, value jsonb) returns jsonb
language sql stable as $$
  select jsonb_object_agg(a.attname,value->a.attname)
  from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
  where c.conrelid=relation and c.contype='p'
$$;

do $$ declare item record; fk record; join_keys text; failures jsonb; begin
  for item in select * from met226_rules where not removable loop
    execute format('insert into met226_blockers select %s,pg_temp.met226_identity(r.tableoid,to_jsonb(r)),%L from %s r where (%s) and not exists (select 1 from met226_rows d where d.relation=r.tableoid and d.tuple=r.ctid)',
      item.relation::oid,'model/auth configuration',item.relation,item.predicate);
  end loop;
  -- All inbound FKs are checked, including composite keys, before disabling any
  -- guards. A reference is not ownership. Report primary keys, never row bodies.
  for fk in select * from pg_constraint where contype='f'
    and connamespace=current_schema()::regnamespace
    and confrelid in (select relation from met226_rows)
  loop
    select string_agg(format('child.%I=parent.%I',ca.attname,pa.attname),' and ' order by k.n)
    into join_keys from unnest(fk.conkey,fk.confkey) with ordinality k(child_key,parent_key,n)
    join pg_attribute ca on ca.attrelid=fk.conrelid and ca.attnum=k.child_key
    join pg_attribute pa on pa.attrelid=fk.confrelid and pa.attnum=k.parent_key;
    execute format('insert into met226_blockers select %s,pg_temp.met226_identity(child.tableoid,to_jsonb(child)),%L from %s child join %s parent on %s join met226_rows d on d.relation=parent.tableoid and d.tuple=parent.ctid where not exists (select 1 from met226_rows x where x.relation=child.tableoid and x.tuple=child.ctid)',
      fk.conrelid,fk.conname,fk.conrelid::regclass,fk.confrelid::regclass,join_keys);
  end loop;
  select jsonb_agg(jsonb_build_object('table',relation::text,'ids',identity,'reference',reference) order by relation::text,identity::text,reference)
  into failures from met226_blockers;
  if failures is not null then
    raise exception using errcode='23503', message='MET226_SHARED_REFERENCE: surviving records reference retired Gemini data',
      detail=failures::text, hint='No records were changed. Resolve shared references in a separately reviewed change; this migration never rewrites or cascades them.';
  end if;
end $$;

-- This deletion set uses NO ACTION FKs. No generic cascade template: surviving
-- children have already been rejected above. Save and restore exact guards.
create temporary table met226_foreign_keys on commit drop as
select conrelid,conname,condeferrable,condeferred from pg_constraint
where contype='f' and connamespace=current_schema()::regnamespace
  and (conrelid in (select relation from met226_rows) or confrelid in (select relation from met226_rows));
create temporary table met226_triggers on commit drop as
select tgrelid,tgname,tgenabled from pg_trigger
where not tgisinternal and tgenabled<>'D' and tgrelid in (select relation from met226_rows);

do $$ declare item record; begin
  for item in select * from met226_foreign_keys loop
    execute format('alter table %s alter constraint %I deferrable initially deferred',item.conrelid::regclass,item.conname);
  end loop;
  for item in select * from met226_triggers loop
    execute format('alter table %s disable trigger %I',item.tgrelid::regclass,item.tgname);
  end loop;
  for item in select distinct relation from met226_rows loop
    execute format('delete from %s r using met226_rows d where d.relation=%s and d.tuple=r.ctid',item.relation::regclass,item.relation);
  end loop;
  -- Do not change unrelated deferred FKs/commit-fence triggers in this transaction.
  for item in select * from met226_foreign_keys loop
    execute format('set constraints %I.%I immediate',current_schema(),item.conname);
  end loop;
  for item in select * from met226_foreign_keys loop
    execute format('alter table %s alter constraint %I %s',item.conrelid::regclass,item.conname,
      case when not item.condeferrable then 'not deferrable' when item.condeferred then 'deferrable initially deferred' else 'deferrable initially immediate' end);
    if item.condeferrable and item.condeferred then
      execute format('set constraints %I.%I deferred',current_schema(),item.conname);
    end if;
  end loop;
  for item in select * from met226_triggers loop
    execute format('alter table %s enable %s trigger %I',item.tgrelid::regclass,
      case item.tgenabled when 'A' then 'always' when 'R' then 'replica' else '' end,item.tgname);
  end loop;
end $$;

-- Keep the archived name accepted by the pre-migration deployment gate.
-- Remove only its obsolete registration; 0075/0117 history remains intact.
do $$ begin
  if to_regclass(format('%I.allrice_schema_migrations',current_schema())) is not null then
    delete from allrice_schema_migrations where name='0073_gemini_model_provider.sql';
  end if;
end $$;
alter table allrice_model_providers drop constraint allrice_model_providers_auth_mode_check;
alter table allrice_model_providers add constraint allrice_model_providers_auth_mode_check
  check (auth_mode in ('chatgpt_subscription','oauth','api_key','none'));
drop function pg_temp.met226_identity(oid,jsonb);
drop function pg_temp.met226_model(jsonb);
drop function pg_temp.met226_reference(jsonb);
drop function pg_temp.met226_target(jsonb);
