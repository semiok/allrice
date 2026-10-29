-- MET-210 PR2b. Snapshot + stop all old writers before this transaction.
-- 0229 is the rollback floor: the old executor must never run after these drops.
-- Ownership is explicit. Ordinary parent-session files retain their original
-- identities/provenance; other references never expand the deletion set.
create temporary table met210_retired_relations(name regclass primary key) on commit drop;
insert into met210_retired_relations values
  ('allrice_development_deliveries'), ('allrice_development_reviews'),
  ('allrice_development_verifiers'), ('allrice_development_merge_sources'),
  ('allrice_development_merges'), ('allrice_development_proposals'),
  ('allrice_development_assignments'), ('allrice_development_heads'),
  ('allrice_assistant_cost_receipts'), ('allrice_assistant_model_admissions'),
  ('allrice_assistant_price_snapshots'), ('allrice_assistant_artifacts'),
  ('allrice_assistant_usage'), ('allrice_assistant_results'),
  ('allrice_assistant_messages'), ('allrice_assistant_instances'), ('allrice_assistant_roots');
create temporary table met210_children on commit drop as
  select run_id,root_run_id,native_session_id from allrice_assistant_instances
  where parent_run_id is not null;
create temporary table met210_versions(id uuid primary key) on commit drop;
insert into met210_versions
  select a.artifact_id from allrice_assistant_artifacts a join met210_children c using(run_id)
  union select a.version_id from allrice_workbench_artifacts a join met210_children c using(run_id)
  union select artifact_id from allrice_development_proposals
  union select result_artifact_id from allrice_development_merges
  union select artifact_id from allrice_development_deliveries;
create temporary table met210_objects on commit drop as
  select v.object_id id from allrice_deliverable_versions v join met210_versions x using(id);

-- No pending old controller/child side effect can survive the schema cutover.
do $$ declare blockers jsonb; begin
  select jsonb_agg(jsonb_build_object('jobId',j.id,'runId',j.run_id,'status',j.status)) into blockers
  from allrice_jobs j where j.status not in ('succeeded','failed','dead_letter','canceled')
    and (exists(select 1 from allrice_assistant_roots a where a.worker_job_id=j.id)
      or exists(select 1 from met210_children c where c.run_id=j.run_id)
      or j.payload#>'{input,assistantConfiguration,allowAssistants}'='true'::jsonb
      or exists(select 1 from allrice_runs r where r.id=j.run_id and r.input#>'{assistantConfiguration,allowAssistants}'='true'::jsonb));
  if blockers is not null then
    raise exception using errcode='55000',message='MET210_OLD_WRITERS_ACTIVE',detail=blockers::text,
      hint='Stop/drain the old Worker and Hosts before retrying. No data was changed.';
  end if;
  select jsonb_agg(jsonb_build_object('runId',s.run_id,'rootRunId',s.root_run_id,
    'jobId',s.worker_job_id,'status',s.status,'stoppedAt',s.stopped_at)
    order by s.root_run_id,s.run_id) into blockers
  from (
    select a.run_id,a.root_run_id,r.worker_job_id,a.status,a.stopped_at
    from allrice_assistant_instances a join allrice_assistant_roots r using(root_run_id)
    where a.stopped_at is null or a.status not in ('completed','partial','failed','canceled','unknown')
    union all
    select r.root_run_id,r.root_run_id,r.worker_job_id,null,null
    from allrice_assistant_roots r where not exists(
      select 1 from allrice_assistant_instances a where a.run_id=r.root_run_id)
  ) s;
  if blockers is not null then
    raise exception using errcode='55000',message='MET210_OLD_STOP_UNCONFIRMED',detail=blockers::text,
      hint='Confirm every old root/child execution stopped before retrying. A terminal result is not a stop receipt; this migration never fabricates one.';
  end if;
  select jsonb_agg(jsonb_build_object('operationId',o.id,'runId',o.run_id,'status',o.snapshot->>'status')) into blockers
  from allrice_runtime_operations o join met210_children c
    on o.initial_snapshot->>'agentInstanceId'=c.run_id::text
  where o.snapshot->>'status' not in ('succeeded','failed','partial','canceled');
  if blockers is not null then
    raise exception using errcode='55000',message='MET210_CHILD_OPERATIONS_ACTIVE',detail=blockers::text,
      hint='Resolve physical execution with the old writer before retrying. Do not force a terminal receipt.';
  end if;
end $$;

-- Old report publication used the generic exporter to attach files to the
-- ordinary parent's chat. Keep that existing history, not the old executor.
-- Match actual source/parent/owner relationships, never a fixed list of IDs.
-- Parent versions and Run-link ancestors are required provenance FK closure.
create temporary table met210_preserved_versions on commit drop as
with recursive kept as (
  select v.id,v.object_id,v.parent_version_id
  from met210_objects o join allrice_deliverable_versions v on v.object_id=o.id
  join allrice_storage_objects s on s.id=v.object_id and s.owner_id=v.owner_id
  join allrice_workbench_artifacts a on a.version_id=v.id
  left join allrice_assistant_instances i on i.run_id=a.run_id
  join allrice_employee_runs e on e.run_id=coalesce(i.root_run_id,a.run_id)
  join allrice_file_references f on f.object_id=v.object_id and f.session_id=e.session_id
  where v.session_id=e.session_id and f.owner_id=v.owner_id and a.owner_id=v.owner_id
    and e.owner_id=v.owner_id and not exists(select 1 from met210_children c where c.run_id=e.run_id)
  union
  select v.id,v.object_id,v.parent_version_id
  from allrice_deliverable_versions v join kept k on v.id=k.parent_version_id
) select * from kept;
create temporary table met210_preserved_runs on commit drop as
with recursive kept(run_id) as (
  select a.run_id from allrice_workbench_artifacts a join met210_preserved_versions v on v.id=a.version_id
  union
  select l.parent_run_id from allrice_runtime_run_links l join kept k using(run_id)
  where l.parent_run_id is not null
) select run_id from kept;
-- Keeping provenance cannot carry a runnable old child through the cutover.
-- Do not rewrite its outcome or retire its Job on its behalf.
do $$ declare blockers jsonb; begin
  select jsonb_agg(jsonb_build_object('runId',r.id,'state',r.state,'jobId',j.id,'jobStatus',j.status)) into blockers
  from met210_preserved_runs k join met210_children c using(run_id)
  join allrice_runs r on r.id=k.run_id left join allrice_jobs j on j.run_id=r.id
  where r.state not in ('succeeded','failed','canceled')
    or (j.id is not null and (j.status not in ('succeeded','failed','dead_letter','canceled')
      or j.worker_id is not null or j.lease_token is not null or j.lease_expires_at is not null));
  if blockers is not null then
    raise exception using errcode='55000',message='MET210_PRESERVED_SOURCE_ACTIVE',detail=blockers::text,
      hint='Preserved file provenance must already be stopped history. Resolve the old execution; no new identity or Job is created here.';
  end if;
end $$;
delete from met210_versions where id in(select id from met210_preserved_versions);
delete from met210_objects where id in(select object_id from met210_preserved_versions);
create temporary table met210_deleted_children on commit drop as
  select * from met210_children where run_id not in(select run_id from met210_preserved_runs);

create temporary table met210_rows(relation oid,tuple tid,primary key(relation,tuple)) on commit drop;
insert into met210_rows select r.tableoid,r.ctid from allrice_runs r join met210_deleted_children c on c.run_id=r.id;
insert into met210_rows select r.tableoid,r.ctid from allrice_runtime_run_links r join met210_deleted_children c using(run_id);
insert into met210_rows select r.tableoid,r.ctid from allrice_task_operation_calls r join met210_children c on c.run_id=r.agent_id;
insert into met210_rows select r.tableoid,r.ctid from allrice_run_events r join met210_children c using(run_id);
insert into met210_rows select r.tableoid,r.ctid from allrice_workbench_artifacts r join met210_versions v on v.id=r.version_id;
insert into met210_rows select r.tableoid,r.ctid from allrice_deliverable_versions r join met210_versions v using(id);
insert into met210_rows select r.tableoid,r.ctid from allrice_storage_access_grants r join met210_objects o on o.id=r.object_id;
insert into met210_rows select r.tableoid,r.ctid from allrice_storage_objects r join met210_objects o using(id);

-- Check every real FK, including composite keys, before disabling the one
-- immutable artifact DELETE guard. A retained review, merge, feedback, ordinary
-- version or Run is a blocker, never permission to recursively remove it.
create temporary table met210_blockers(relation regclass,identity jsonb,reference text) on commit drop;
create function pg_temp.met210_identity(relation oid,value jsonb) returns jsonb language sql stable as $$
  select jsonb_object_agg(a.attname,value->a.attname)
  from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
  where c.conrelid=relation and c.contype='p'
$$;
do $$ declare fk record;join_keys text;blockers jsonb;begin
  for fk in select * from pg_constraint where contype='f'
    and connamespace=current_schema()::regnamespace
    and confrelid in(select relation from met210_rows)
    and conrelid not in(select name::oid from met210_retired_relations)
  loop
    select string_agg(format('child.%I=parent.%I',ca.attname,pa.attname),' and ' order by k.n)
      into join_keys from unnest(fk.conkey,fk.confkey) with ordinality k(child_key,parent_key,n)
      join pg_attribute ca on ca.attrelid=fk.conrelid and ca.attnum=k.child_key
      join pg_attribute pa on pa.attrelid=fk.confrelid and pa.attnum=k.parent_key;
    execute format('insert into met210_blockers select %s,pg_temp.met210_identity(child.tableoid,to_jsonb(child)),%L from %s child join %s parent on %s join met210_rows d on d.relation=parent.tableoid and d.tuple=parent.ctid where not exists(select 1 from met210_rows x where x.relation=child.tableoid and x.tuple=child.ctid)',
      fk.conrelid,fk.conname,fk.conrelid::regclass,fk.confrelid::regclass,join_keys);
  end loop;
  select jsonb_agg(jsonb_build_object('table',relation::text,'ids',identity,'reference',reference)
    order by relation::text,identity::text,reference) into blockers from met210_blockers;
  if blockers is not null then
    raise exception using errcode='23503',message='MET210_SHARED_REFERENCE',detail=blockers::text,
      hint='No data was changed. Review these retained references separately; this migration never cascades ordinary history.';
  end if;
end $$;

-- Attachments already have FKs above. Ordinary final text and file citations do
-- not: preserve their exact managed object identities as well. Match the file
-- endpoint used by artifact-download-link.ts. Normalize explicit URL tokens
-- against its root base: HTTP(S)/protocol-relative origins, dot segments,
-- escaped separators, /download and queries. Never infer from UUIDs/names.
-- Only ordinary message/result fields are read, not old delegation logs.
create function pg_temp.met210_file_ids(value text) returns table(object_id uuid)
language plpgsql immutable strict as $body$
declare token text; path text; authority text; segment text; parts text[]; normalized text[]; match text[]; n integer;
begin
  -- IPv6 authority brackets belong to the URL; other brackets still delimit
  -- Markdown tokens. Keep the existing exact endpoint check below.
  for token in select found.parts[1]
    from regexp_matches(regexp_replace(value,$slash$\\+/$slash$,'/','g'),
      $url$(?:^|[[:space:]<(="'\[]|\]:)((?:[hH][tT][tT][pP][sS]?:)?//\[[0-9A-Fa-f:.]+\](?::[0-9]+)?/[^[:space:]<>"'\[\]()]*|[^[:space:]<>"'\[\]()]+)$url$,'g') found(parts)
  loop
    path:=regexp_replace(token,'^https?:','', 'i');
    if path like '//%' then
      authority:=substring(path from '^//([^/?#]*)');
      if authority='' or authority like '%@%' then continue; end if;
      path:=regexp_replace(path,'^//[^/?#]*','');
    elsif path like 'sandbox:/%' then path:=substring(path from 9);
    elsif path ~ '^[^/?#]*:' then continue;
    end if;
    path:=regexp_replace(path,'[?#].*$','');
    -- WHATWG URL dot segments also recognize percent-encoded dots. Other
    -- percent encodings are not decoded by the renderer's pathname matcher.
    parts:=string_to_array(regexp_replace(path,'^/',''),'/');
    normalized:='{}';
    for n in 1..coalesce(array_length(parts,1),0) loop
      segment:=regexp_replace(parts[n],'%2e','.', 'gi');
      if segment='..' then normalized:=normalized[1:greatest(cardinality(normalized)-1,0)];
      elsif segment<>'.' then normalized:=array_append(normalized,parts[n]);
      end if;
      if segment in ('.','..') and n=cardinality(parts) then normalized:=array_append(normalized,''); end if;
    end loop;
    match:=regexp_match('/'||array_to_string(normalized,'/'),
      '^/api/v1/files/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(/download)?$');
    if match is not null then object_id:=match[1]::uuid; return next; end if;
  end loop;
end;
$body$;
do $$ declare blockers jsonb; begin
  with retained as (
    select 'allrice_messages'::text relation,m.id message_id,null::uuid run_id,
      m.content body,m.content->>'text' text
    from allrice_messages m where m.role in ('user','assistant')
      and not exists(select 1 from allrice_employee_runs e join met210_children c using(run_id)
        where m.id in(e.user_message_id,e.assistant_message_id))
    union all
    select 'allrice_runs',null,r.id,r.result,r.result->>'answer' from allrice_runs r
      where not exists(select 1 from met210_children c where c.run_id=r.id)
  ), file_references as (
    select distinct r.relation,r.message_id,r.run_id,f.object_id from retained r
      cross join lateral pg_temp.met210_file_ids(r.text) f
    union
    select r.relation,r.message_id,r.run_id,o.id from retained r
      cross join lateral jsonb_array_elements(case when jsonb_typeof(r.body->'citations')='array'
        then r.body->'citations' else '[]'::jsonb end) citation
      join met210_objects o on citation->>'type'='file' and citation->>'id'=o.id::text
  )
  select jsonb_agg(jsonb_build_object('table',r.relation,'messageId',r.message_id,
    'runId',r.run_id,'objectId',r.object_id) order by r.relation,r.message_id,r.run_id,r.object_id)
    into blockers from file_references r join met210_objects o on o.id=r.object_id;
  if blockers is not null then
    raise exception using errcode='23503',message='MET210_SHARED_FILE_REFERENCE',detail=blockers::text,
      hint='No data was changed. Retained ordinary messages/results reference these exact old objects; do not expand the deletion set.';
  end if;
end $$;

-- Explicit FK order. Shared functions from 0097 and 0146/0147 remain installed.
drop table allrice_development_deliveries;
drop table allrice_development_reviews;
drop table allrice_development_verifiers;
drop table allrice_development_merge_sources;
drop table allrice_development_merges;
drop table allrice_development_proposals;
drop table allrice_development_assignments;
drop table allrice_development_heads;
drop function allrice_guard_development_assignment();
drop function allrice_guard_development_head();
drop table allrice_assistant_cost_receipts;
drop table allrice_assistant_model_admissions;
drop table allrice_assistant_price_snapshots;
drop table allrice_assistant_artifacts;
drop table allrice_assistant_usage;
drop table allrice_assistant_results;
drop table allrice_assistant_messages;
drop table allrice_assistant_instances;
drop table allrice_assistant_roots;

-- Only the remaining unshared child artifacts are retired data.
-- This is the migration's bounded DELETE, not a test bypass. Restore the guard
-- before proceeding; all constraints remain enabled throughout.
alter table allrice_workbench_artifacts disable trigger allrice_workbench_artifact_immutable;
delete from allrice_workbench_artifacts where version_id in(select id from met210_versions);
alter table allrice_workbench_artifacts enable trigger allrice_workbench_artifact_immutable;
delete from allrice_deliverable_versions where id in(select id from met210_versions);
delete from allrice_storage_access_grants where object_id in(select id from met210_objects);
delete from allrice_storage_objects where id in(select id from met210_objects);
delete from allrice_task_operation_calls where agent_id in(select run_id from met210_children);
delete from allrice_task_calls t using met210_children c
  where t.run_id=c.root_run_id and t.native_session_id=c.native_session_id;
delete from allrice_run_events where run_id in(select run_id from met210_children);
delete from allrice_runtime_run_links where run_id in(select run_id from met210_deleted_children);
delete from allrice_runs where id in(select run_id from met210_deleted_children);

-- Remove the retired preference, preserving each cloud/computer value. Never
-- translate it to nativePreferences, a new opt-in, a depth or a capability grant.
update allrice_member_work_automation set settings=settings-'assistants'
  where settings ? 'assistants';
-- Existing operation confirmation choices remain exact; only the obsolete key
-- is removed from their frozen snapshot. No policy decision or receipt changes.
alter table allrice_runtime_operations disable trigger allrice_operation_member_automation_immutable;
update allrice_runtime_operations set member_automation=member_automation#-'{settings,assistants}'
  where member_automation->'settings' ? 'assistants';
alter table allrice_runtime_operations enable trigger allrice_operation_member_automation_immutable;
update allrice_runs set input=input-'assistantConfiguration' where input ? 'assistantConfiguration';
update allrice_jobs set payload=payload#-'{input,assistantConfiguration}' where payload->'input' ? 'assistantConfiguration';

-- Remove the obsolete installable entry; frozen bundles referenced by ordinary
-- historical employee versions remain historical content, never a live tool.
update allrice_platform_dsh_skills set enabled=false,updated_at=clock_timestamp()
where id='d78b3556-821a-5550-bf13-d9dd84b9bbe0' and source='allrice' and enabled;
