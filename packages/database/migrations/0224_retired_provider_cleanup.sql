-- MET-226, user decision 2026-10-27: no Gemini bills need preservation.
-- Delete retired provider records and their dependent test data; do not rewrite
-- any surviving Codex configuration or frozen identity. Rehearsal A is required.
-- Temporary helpers/row identities exist only inside this migration transaction.
create temporary table met226_rows (
  relation oid not null, tuple tid not null, primary key (relation, tuple)
) on commit drop;

create function pg_temp.met226_retired(value jsonb) returns boolean
language sql immutable as $$
  select coalesce(value @? 'strict $.** ? (@.type() == "object" && (
    @.provider == "gemini" || @.provider == "google" || @.route == "gemini" ||
    @.authMode == "gemini_oauth" || @.model == "3.8flash" ||
    @.model like_regex "^gemini([:/-]|$)" flag "i" ||
    @.credentialReference like_regex "^deployment:gemini" ||
    @.fallbackModels[*] like_regex "^gemini[:/]"
  ))', false)
$$;

-- Seed only routing/configuration fields, never chat text, arbitrary tool output,
-- document bodies, names or descriptions that happen to mention the provider.
do $$ declare item record; predicate text; begin
  for item in
    select c.oid, a.attname, a.atttypid
    from pg_class c join pg_attribute a on a.attrelid=c.oid
    where c.relnamespace=current_schema()::regnamespace and c.relkind='r'
      and c.relname like 'allrice_%' and a.attnum>0 and not a.attisdropped
      and (
        a.attname in ('provider_key','provider','provider_route','auth_mode','model','credential_reference')
        or (c.relname='allrice_audit_events' and a.attname='action')
        or (c.relname, a.attname) in (
          ('allrice_employee_versions','manifest'),
          ('allrice_employee_versions','provider_snapshot'),
          ('allrice_employee_runs','provider_snapshot'),
          ('allrice_employee_runs','execution_snapshot'),
          ('allrice_skill_runs','provider_snapshot'),
          ('allrice_session_model_snapshots','snapshot'),
          ('allrice_platform_employee_revisions','definition'),
          ('allrice_platform_employee_revisions','runtime_profile'),
          ('allrice_platform_employee_test_runs','frozen_definition'),
          ('allrice_platform_employee_test_runs','frozen_runtime_profile'),
          ('allrice_employee_method_tests','model_snapshot'),
          ('allrice_assistant_price_snapshots','snapshot'),
          ('allrice_route_subscription_snapshots','snapshot'),
          ('allrice_runs','execution_spec'),
          ('allrice_jobs','payload')
        )
      )
  loop
    predicate := case
      when item.atttypid='jsonb'::regtype then format('pg_temp.met226_retired(%I)',item.attname)
      when item.attname in ('provider_key','provider','provider_route') then format('%I in (''gemini'',''google'')',item.attname)
      when item.attname='auth_mode' then format('%I=''gemini_oauth''',item.attname)
      when item.attname='model' then format('(%I ~* ''^gemini([:/-]|$)'' or %I=''3.8flash'')',item.attname,item.attname)
      when item.attname='credential_reference' then format('%I like ''deployment:gemini%%''',item.attname)
      when item.attname='action' then format('%I like ''provider.gemini_credential.%%''',item.attname)
    end;
    execute format('insert into met226_rows select %s,ctid from %s where %s on conflict do nothing',item.oid,item.oid::regclass,predicate);
  end loop;
end $$;

-- All relational dependents must go too (including composite/self references).
-- Also retire owning Runs whose frozen provider or price is being removed,
-- and policies whose explicit JSON fallback points at the deleted catalog.
do $$ declare fk record; join_keys text; added bigint; total bigint; begin
  loop
    total := 0;
    insert into met226_rows
      select r.tableoid,r.ctid from allrice_runs r where r.id in (
        select e.run_id from allrice_employee_runs e join met226_rows d on d.relation=e.tableoid and d.tuple=e.ctid
        union select s.run_id from allrice_skill_runs s join met226_rows d on d.relation=s.tableoid and d.tuple=s.ctid
        union select a.root_run_id from allrice_assistant_price_snapshots a join met226_rows d on d.relation=a.tableoid and d.tuple=a.ctid
        union select l.run_id from allrice_runtime_run_links l join met226_rows x on x.relation=l.tableoid and x.tuple=l.ctid
        union select j.run_id from allrice_jobs j join met226_rows x on x.relation=j.tableoid and x.tuple=j.ctid
        union select d.run_id from allrice_route_decisions d join met226_rows x on x.relation=d.tableoid and x.tuple=d.ctid
      ) on conflict do nothing;
    get diagnostics added=row_count; total := total+added;
    insert into met226_rows
      select p.tableoid,p.ctid from allrice_employee_model_policies p
      where exists (
        select 1 from jsonb_array_elements(p.fallback_targets) f
        where f->>'connectionId' in (
          select c.id::text from allrice_model_connections c join met226_rows d on d.relation=c.tableoid and d.tuple=c.ctid
        ) or f->>'modelCatalogEntryId' in (
          select m.id::text from allrice_model_catalog_entries m join met226_rows d on d.relation=m.tableoid and d.tuple=m.ctid
        )
      ) on conflict do nothing;
    get diagnostics added=row_count; total := total+added;
    for fk in select * from pg_constraint where contype='f'
      and connamespace=current_schema()::regnamespace
      and confrelid in (select relation from met226_rows)
    loop
      select string_agg(format('child.%I=parent.%I',ca.attname,pa.attname),' and ' order by k.n)
      into join_keys from unnest(fk.conkey,fk.confkey) with ordinality k(child_key,parent_key,n)
      join pg_attribute ca on ca.attrelid=fk.conrelid and ca.attnum=k.child_key
      join pg_attribute pa on pa.attrelid=fk.confrelid and pa.attnum=k.parent_key;
      execute format('insert into met226_rows select %s,child.ctid from %s child join %s parent on %s join met226_rows d on d.relation=%s and d.tuple=parent.ctid on conflict do nothing',
        fk.conrelid,fk.conrelid::regclass,fk.confrelid::regclass,join_keys,fk.confrelid);
      get diagnostics added=row_count; total := total+added;
    end loop;
    exit when total=0;
  end loop;
end $$;

-- Immutable evidence guards and immediate FKs otherwise prevent deleting the
-- retired graph (including cycles). Save and restore their exact configuration;
-- constraints remain enforced, with deferred checks completed before restoration.
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
end $$;
set constraints all immediate;
do $$ declare item record; begin
  for item in select * from met226_foreign_keys loop
    execute format('alter table %s alter constraint %I %s',item.conrelid::regclass,item.conname,
      case when not item.condeferrable then 'not deferrable' when item.condeferred then 'deferrable initially deferred' else 'deferrable initially immediate' end);
  end loop;
  for item in select * from met226_triggers loop
    execute format('alter table %s enable %s trigger %I',item.tgrelid::regclass,
      case item.tgenabled when 'A' then 'always' when 'R' then 'replica' else '' end,item.tgname);
  end loop;
end $$;

-- The superseded draft is no longer an accepted migration-name exception.
-- Keep the applied 0075 and 0117 history intact.
do $$ begin
  if to_regclass(format('%I.allrice_schema_migrations',current_schema())) is not null then
    delete from allrice_schema_migrations where name='0073_gemini_model_provider.sql';
  end if;
end $$;
alter table allrice_model_providers drop constraint allrice_model_providers_auth_mode_check;
alter table allrice_model_providers add constraint allrice_model_providers_auth_mode_check
  check (auth_mode in ('chatgpt_subscription','oauth','api_key','none'));
drop function pg_temp.met226_retired(jsonb);
