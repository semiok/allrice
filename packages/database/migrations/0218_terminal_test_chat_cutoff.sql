-- Explicit historical QA execution cutoff. No historical state is repaired,
-- settled or reclassified. 0199 chat v1 and 0215 non-chat semantics stay intact.
-- Reuse the immutable retirement table and the existing admission mutex.
create function allrice_terminal_native_chat_facts(chat uuid, org uuid, workspace uuid, owner uuid)
returns jsonb language plpgsql set timezone='UTC' as $$
#variable_conflict use_variable
declare c allrice_chat_sessions%rowtype; subjects uuid[]; run_rows jsonb; job_rows jsonb;
  history jsonb:='{}'; observations jsonb; consumers jsonb; rel text; predicate text; fp jsonb;
begin
  if chat='68e76b6b-2e75-45b7-b628-951945b12044' then raise exception 'NATIVE_TERMINAL_PROTECTED_CONTEXT'; end if;
  select * into c from allrice_chat_sessions s where s.id=chat and s.organization_id=org and s.workspace_id=workspace and s.owner_id=owner;
  if not found then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
  if c.native_root_origin is not null or exists(select 1 from allrice_native_session_bindings b where b.context_kind='chat' and b.context_id=chat)
    or exists(select 1 from allrice_native_chat_executor_transitions t where t.context_id=chat)
    then raise exception 'NATIVE_CHAT_CUTOFF_IMPLICIT_ONLY'; end if;
  with recursive graph(id) as (
    select e.run_id from allrice_employee_runs e where e.session_id=chat
    union select l.run_id from allrice_runtime_run_links l join graph g on l.root_run_id=g.id
  ) select coalesce(array_agg(id order by id),'{}'::uuid[]) into subjects from graph;
  if cardinality(subjects)=0 or exists(select 1 from unnest(subjects) s(id) left join allrice_runs r on r.id=s.id
    where r.id is null or r.organization_id<>org or r.workspace_id<>workspace or r.owner_id<>owner
      or r.state not in ('succeeded','failed','canceled') or r.completed_at is null)
    or exists(select 1 from allrice_employee_runs e where e.run_id=any(subjects) and
      (e.session_id<>chat or e.organization_id<>org or e.workspace_id<>workspace or e.owner_id<>owner))
    then raise exception 'NATIVE_CHAT_CUTOFF_RUN_SCOPE_OR_STATE'; end if;
  if exists(select 1 from allrice_jobs j where j.run_id=any(subjects) and
       (j.status not in ('succeeded','failed','dead_letter','canceled') or j.completed_at is null or j.lease_expires_at>clock_timestamp()
        or j.organization_id<>org or j.workspace_id<>workspace or j.owner_id<>owner))
    or exists(select 1 from allrice_runtime_operations o where o.root_run_id=any(subjects) and o.lease_expires_at>clock_timestamp())
    or exists(select 1 from allrice_assistant_model_admissions a where a.root_run_id=any(subjects) and a.finished_at is null)
    or exists(select 1 from allrice_dsh_runtime_instances r where r.session_id=chat and r.status='live')
    or exists(select 1 from allrice_cloud_execution_attempts a join allrice_runtime_operations o on o.id=a.operation_id
      where o.root_run_id=any(subjects) and a.cleanup_confirmed_at is null)
    or exists(select 1 from allrice_automations a where a.session_id=chat and a.status='enabled' and a.deleted_at is null)
    or exists(select 1 from allrice_conversation_runtimes r where r.session_id=chat and
      (r.organization_id<>org or r.workspace_id<>workspace or r.owner_id<>owner or
       (r.active_run_id is not null and not r.active_run_id=any(subjects))))
    then raise exception 'NATIVE_CHAT_CUTOFF_LIVE_AUTHORITY'; end if;

  -- Complete row fingerprints use PostgreSQL text before JS can lose numeric
  -- or timestamp precision. No pending checkpoint or runtime field is changed.
  foreach rel in array array[
    'allrice_runs','allrice_jobs','allrice_employee_runs','allrice_run_events',
    'allrice_runtime_roots','allrice_runtime_run_links','allrice_runtime_budgets','allrice_runtime_operations',
    'allrice_assistant_roots','allrice_assistant_instances','allrice_assistant_messages','allrice_assistant_model_admissions','allrice_assistant_usage',
    'allrice_task_clocks','allrice_task_clock_events','allrice_task_questions','allrice_task_calls','allrice_task_resource_waits',
    'allrice_native_question_waits','allrice_native_task_dispatches','allrice_route_decisions','allrice_model_usage_ledger',
    'allrice_conversation_runtimes','allrice_conversation_followups','allrice_conversation_commands','allrice_dsh_runtime_instances',
    'allrice_messages','allrice_deliverable_versions','allrice_file_references','allrice_workbench_artifacts','allrice_storage_objects'
  ] loop
    predicate:=case
      when rel='allrice_runs' then 't.id=any($1)'
      when rel='allrice_employee_runs' then 't.run_id=any($1) or t.session_id=$2'
      when rel='allrice_runtime_run_links' then 't.root_run_id=any($1) or t.run_id=any($1)'
      when rel in ('allrice_runtime_roots','allrice_runtime_budgets','allrice_runtime_operations','allrice_assistant_roots',
        'allrice_assistant_instances','allrice_assistant_messages','allrice_assistant_model_admissions','allrice_assistant_usage') then 't.root_run_id=any($1)'
      when rel in ('allrice_conversation_runtimes','allrice_conversation_followups','allrice_conversation_commands','allrice_dsh_runtime_instances',
        'allrice_messages','allrice_deliverable_versions','allrice_file_references') then 't.session_id=$2'
      when rel='allrice_workbench_artifacts' then 't.version_id in(select id from allrice_deliverable_versions where session_id=$2)'
      when rel='allrice_storage_objects' then 't.id in(select object_id from allrice_deliverable_versions where session_id=$2 union select object_id from allrice_file_references where session_id=$2)'
      when rel='allrice_model_usage_ledger' then 't.route_decision_id in(select id from allrice_route_decisions where run_id=any($1))'
      else 't.run_id=any($1)' end;
    execute format('select jsonb_build_object(''count'',count(*),''digest'',md5(coalesce(string_agg(to_jsonb(t)::text,'','' order by to_jsonb(t)::text),''''))) from %I t where %s',rel,predicate)
      into fp using subjects,chat;
    history:=history||jsonb_build_object(rel,fp);
  end loop;
  with articles as(select * from allrice_brand_content_articles where session_id=chat), refs as(
    select 'article' kind,to_jsonb(a) value from articles a
    union all select 'bundle',to_jsonb(b) from allrice_brand_content_bundles b where b.article_id in(select id from articles)
    union all select 'review',to_jsonb(r) from allrice_brand_content_reviews r where r.article_id in(select id from articles)
    union all select 'plan',to_jsonb(p) from allrice_brand_content_plans p where p.article_id in(select id from articles)
    union all select 'reminder',to_jsonb(r) from allrice_brand_content_reminders r where r.session_id=chat
    union all select 'workflow_start',to_jsonb(s) from allrice_brand_content_workflow_starts s where s.session_id=chat
    union all select 'content_context',to_jsonb(cc) from allrice_employee_content_contexts cc where cc.session_id=chat
    union all select 'method_test',to_jsonb(t) from allrice_employee_method_tests t where t.source_session_id=chat
    union all select 'method_activation',to_jsonb(a) from allrice_employee_method_activations a where a.session_id=chat
    union all select 'skill_import',to_jsonb(i) from allrice_personal_skill_imports i where i.session_id=chat
    union all select 'skill_operation',to_jsonb(o) from allrice_personal_skill_version_operations o where o.session_id=chat
    union all select 'company_input',to_jsonb(a) from allrice_company_run_assets a where a.run_id=any(subjects)
    union all select 'company_derivation',to_jsonb(d) from allrice_company_asset_derivations d where d.run_id=any(subjects)
      or d.deliverable_version_id in(select id from allrice_deliverable_versions where session_id=chat)
    union all select 'knowledge',to_jsonb(k) from allrice_knowledge_revisions k where k.file_object_id in
      (select object_id from allrice_deliverable_versions where session_id=chat union select object_id from allrice_file_references where session_id=chat)
  ) select jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(kind||':'||value::text,',' order by kind,value::text),''))) into fp from refs;
  history:=history||jsonb_build_object('independentBusinessReferences',fp);
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'state',r.state) order by r.id),'[]') into run_rows from allrice_runs r where r.id=any(subjects);
  select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'run_id',j.run_id,'status',j.status) order by j.id),'[]') into job_rows from allrice_jobs j where j.run_id=any(subjects);
  select coalesce(jsonb_agg(jsonb_build_object('runtimeId',o.runtime_id,'workerBootId',o.worker_boot_id,'kind',o.observation_kind,
    'ownerDigest',o.owner_digest,'payloadDigest',o.payload_digest,'payload',o.payload) order by o.runtime_id,o.worker_boot_id,o.observation_kind),'[]') into observations
    from allrice_dsh_runtime_close_observations o where (o.runtime_id,o.worker_boot_id) in
      (select p.runtime_id,p.worker_boot_id from allrice_dsh_runtime_close_observations p where p.observation_kind='owned'
        and p.payload#>>'{context,contextKind}'='chat' and p.payload#>>'{context,contextId}'=chat::text);
  if exists(select 1 from allrice_dsh_runtime_close_observations p where p.observation_kind='owned'
    and p.payload#>>'{context,contextKind}'='chat' and p.payload#>>'{context,contextId}'=chat::text
    and (p.payload#>>'{context,kind}' is distinct from 'context'
      or p.payload#>>'{context,organizationId}' is distinct from org::text or p.payload#>>'{context,workspaceId}' is distinct from workspace::text
      or p.payload#>>'{context,ownerId}' is distinct from owner::text or not allrice_terminal_native_owner_confirmed(p.runtime_id,p.worker_boot_id)))
    then raise exception 'NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED'; end if;
  select coalesce(jsonb_agg(value order by kind,value::text),'[]') into consumers from (
    select 'question' kind,jsonb_build_object('kind','question','row',to_jsonb(w)) value from allrice_native_question_waits w where w.run_id=any(subjects)
    union all select 'dispatch',jsonb_build_object('kind','dispatch','row',to_jsonb(d)) from allrice_native_task_dispatches d where d.run_id=any(subjects)
    union all select 'operation',jsonb_build_object('kind','operation','row',to_jsonb(o)) from allrice_runtime_operations o where o.root_run_id=any(subjects)
    union all select 'assistant',jsonb_build_object('kind','assistant','row',to_jsonb(a)) from allrice_assistant_instances a where a.root_run_id=any(subjects)
    union all select 'task_call',jsonb_build_object('kind','task_call','row',to_jsonb(t)) from allrice_task_calls t where t.run_id=any(subjects) and t.finished_at is null
  ) all_consumers;
  return jsonb_build_object('scope',jsonb_build_object('contextKind','chat','contextId',chat,'organizationId',org,'workspaceId',workspace,'ownerId',owner),
    'source',to_jsonb(c)-'archived_at','origin',null,'bindings','[]'::jsonb,'runIds',to_jsonb(subjects),
    'missingRunIds','[]'::jsonb,'missingJobIds','[]'::jsonb,'runs',run_rows,'jobs',job_rows,'closeRows',observations,
    'consumers',consumers,'occurrence',null,'preserved',history);
end $$;

-- A historical Run/Job identity remains reserved even if another writer tries
-- to remove or transplant its old employee-run relation after retirement.
create function allrice_terminal_native_chat_available(sid uuid) returns void language plpgsql as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('native-terminal-context:chat:'||sid::text,0));
  -- A stale REPEATABLE READ transaction cannot see a newly inserted cutoff.
  -- Lock its source row too: cutoff always writes a new source MVCC version,
  -- even when already archived. PostgreSQL must then reject the old snapshot.
  -- NOWAIT avoids a source -> Run / Run -> source wait cycle with old writers.
  if current_setting('transaction_isolation') in ('repeatable read','serializable') then
    perform 1 from allrice_chat_sessions where id=sid for share nowait;
  end if;
  if exists(select 1 from allrice_native_context_retirements r where r.context_kind='chat' and r.context_id=sid
    and r.preservation_snapshot->>'kind'='development-test-chat-terminal-cutoff-v2') then raise exception 'NATIVE_CONTEXT_EXECUTION_RETIRED'; end if;
end $$;

create function allrice_terminal_native_chat_run_available(rid uuid) returns void language plpgsql as $$
declare target uuid;
begin
  -- Resolve the original relation before looking for a retirement row: that
  -- row may legitimately be invisible to an older repeatable-read snapshot.
  for target in select e.session_id from allrice_employee_runs e where e.run_id=rid
      or e.run_id in(select l.root_run_id from allrice_runtime_run_links l where l.run_id=rid)
    union select r.context_id from allrice_native_context_retirements r
    where r.context_kind='chat' and r.preservation_snapshot->>'kind'='development-test-chat-terminal-cutoff-v2'
      and (r.preservation_snapshot#>'{facts,runIds}' @> jsonb_build_array(rid::text)
        or exists(select 1 from allrice_employee_runs e where e.run_id=rid and e.session_id=r.context_id))
    order by 1 loop
    perform allrice_terminal_native_chat_available(target);
  end loop;
end $$;

create function allrice_terminal_native_chat_write_fence() returns trigger language plpgsql as $$
declare v jsonb; rid uuid; sid uuid; r record;
begin
  for v in select value from jsonb_array_elements(case when tg_op='INSERT' then jsonb_build_array(to_jsonb(new))
    when tg_op='DELETE' then jsonb_build_array(to_jsonb(old)) else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end) loop
    if tg_table_name in ('allrice_employee_runs','allrice_conversation_runtimes','allrice_conversation_followups','allrice_conversation_commands','allrice_dsh_runtime_instances',
      'allrice_chat_sessions','allrice_native_session_bindings','allrice_native_chat_executor_transitions') then
      sid:=case when tg_table_name='allrice_chat_sessions' then (v->>'id')::uuid
        when tg_table_name='allrice_native_chat_executor_transitions' then (v->>'context_id')::uuid
        when tg_table_name='allrice_native_session_bindings' then case when v->>'context_kind'='chat' then (v->>'context_id')::uuid end
        else (v->>'session_id')::uuid end;
      if sid is not null then
        perform allrice_terminal_native_chat_available(sid);
      end if;
    end if;
    for rid in select distinct value::uuid from jsonb_array_elements_text(jsonb_build_array(
      case when tg_table_name='allrice_runs' then v->>'id' end,v->>'run_id',v->>'root_run_id',v->>'parent_run_id',v->>'active_run_id')) where value is not null loop
      perform allrice_terminal_native_chat_run_available(rid);
    end loop;
    if tg_table_name='allrice_jobs' then
      for r in select x.context_id from allrice_native_context_retirements x where x.context_kind='chat'
        and x.preservation_snapshot->>'kind'='development-test-chat-terminal-cutoff-v2'
        and exists(select 1 from jsonb_array_elements(x.preservation_snapshot#>'{facts,jobs}') j where j->>'id'=v->>'id')
      loop perform allrice_terminal_native_test_available('chat',r.context_id); end loop;
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if; return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['allrice_runs','allrice_jobs','allrice_employee_runs','allrice_run_events','allrice_runtime_roots','allrice_runtime_run_links',
    'allrice_runtime_operations','allrice_assistant_roots','allrice_assistant_instances','allrice_assistant_messages','allrice_assistant_model_admissions',
    'allrice_task_clocks','allrice_task_clock_events','allrice_task_questions','allrice_task_calls','allrice_task_resource_waits',
    'allrice_native_question_waits','allrice_native_task_dispatches','allrice_conversation_runtimes','allrice_conversation_followups',
    'allrice_conversation_commands','allrice_dsh_runtime_instances','allrice_chat_sessions','allrice_native_session_bindings','allrice_native_chat_executor_transitions'] loop
    execute format('create trigger terminal_chat_cutoff_fence before insert or update or delete on %I for each row execute function allrice_terminal_native_chat_write_fence()',t);
  end loop;
end $$;

create function allrice_terminal_native_chat_retirement_guard() returns trigger language plpgsql as $$
declare actual jsonb; saved jsonb; proof jsonb; e jsonb; sid uuid; rid uuid; art text;
begin
  if new.context_kind<>'chat' or new.preservation_snapshot->>'kind' is distinct from 'development-test-chat-terminal-cutoff-v2' then return new; end if;
  sid:=new.context_id;saved:=new.preservation_snapshot->'facts';proof:=new.preservation_snapshot->'physicalProof';e:=new.preservation_snapshot->'legacyExecutor';
  if not pg_try_advisory_xact_lock(hashtextextended('native-terminal-context:chat:'||sid::text,0)) then raise exception 'NATIVE_TERMINAL_CUTOFF_BUSY'; end if;
  if exists(select 1 from allrice_dsh_runtime_instances where status='live') then raise exception 'NATIVE_TERMINAL_REGISTERED_RUNTIME_LIVE'; end if;
  -- Root -> clock -> Run/Job -> source. Never wait behind a writer that might
  -- already hold a row while trying to acquire the shared admission mutex.
  for rid in select value::uuid from jsonb_array_elements_text(saved->'runIds') order by value loop
    perform 1 from allrice_runtime_roots where root_run_id=rid for update nowait;
    perform 1 from allrice_task_clocks where run_id=rid for update nowait;
    perform 1 from allrice_runs where id=rid for no key update nowait;
    perform 1 from allrice_jobs where run_id=rid order by id for update nowait;
  end loop;
  perform 1 from allrice_chat_sessions where id=sid and archived_at is not null for update nowait;
  if not found then raise exception 'NATIVE_CHAT_CUTOFF_ARCHIVE_REQUIRED'; end if;
  -- Also stamp direct SQL inserts through this guard. Do not optimize this
  -- into an archived_at IS NULL update: the MVCC version fences old snapshots.
  update allrice_chat_sessions set archived_at=archived_at where id=sid;
  actual:=allrice_terminal_native_chat_facts(sid,new.organization_id,new.workspace_id,new.owner_id);
  if saved is distinct from actual or new.origin_snapshot is not null or new.binding_snapshot<>'[]'::jsonb
    or e->'scope' is distinct from actual->'scope'
    or (e->>'artifactId' ~ '^sha256:[a-f0-9]{64}$') is not true
    or right(e->>'storageNamespace',length('/'||new.organization_id||'/'||new.workspace_id||'/'||new.owner_id||'/'||sid||'/sessions'))
      is distinct from '/'||new.organization_id||'/'||new.workspace_id||'/'||new.owner_id||'/'||sid||'/sessions'
    then raise exception 'NATIVE_CHAT_CUTOFF_FACTS_CHANGED'; end if;
  if (proof ?& array['kind','requestId','planDigest','scopeDigest','workerBootId','workerBootStartedAt','observedAt','expiresAt',
      'processInventoryDigest','writerInventoryDigest','nativeProcesses','writers','artifactRoots','writerScopes','storageNamespaces','sourceSha','sourceTree','operatorSha256','reviewSha256']
    and proof->>'kind'='terminal-native-physical-absence-v1' and proof->>'requestId'=new.request_id::text and proof->>'planDigest'=new.plan_digest
    and proof->'nativeProcesses'='[]'::jsonb and proof->'writers'='[]'::jsonb
    and proof->'storageNamespaces' @> jsonb_build_array(e->>'storageNamespace')
    and exists(select 1 from jsonb_array_elements(proof->'artifactRoots') r where r->>'artifactId'=e->>'artifactId')
    and exists(select 1 from jsonb_array_elements(proof->'writerScopes') w where w->>'artifactId'=e->>'artifactId'
      and starts_with(e->>'storageNamespace',(w->>'root')||'/'))
    and (proof->>'observedAt')::timestamptz<=clock_timestamp() and (proof->>'expiresAt')::timestamptz>clock_timestamp()
    and (proof->>'expiresAt')::timestamptz<=(proof->>'observedAt')::timestamptz+interval '120 seconds'
    and (actual#>>'{source,created_at}')::timestamptz<(proof->>'workerBootStartedAt')::timestamptz
    and (proof->>'workerBootStartedAt')::timestamptz<=(proof->>'observedAt')::timestamptz) is not true
    then raise exception 'NATIVE_TERMINAL_RETIREMENT_PROOF_INVALID'; end if;
  for art in select value->>'artifactId' from jsonb_array_elements(proof->'artifactRoots') order by value->>'artifactId' loop
    if not pg_try_advisory_xact_lock(hashtextextended('native-terminal-artifact:'||art,0)) then raise exception 'NATIVE_TERMINAL_CUTOFF_BUSY'; end if;
    if exists(select 1 from allrice_dsh_runtime_close_observations p where p.observation_kind='owned' and p.payload->>'artifactId'=art
      and not allrice_terminal_native_owner_confirmed(p.runtime_id,p.worker_boot_id)) then raise exception 'NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED'; end if;
  end loop;
  return new;
end $$;

create function allrice_terminal_native_chat_owner_fence() returns trigger language plpgsql as $$
declare p jsonb; sid uuid;
begin
  p:=case when new.observation_kind='owned' then new.payload else
    (select o.payload from allrice_dsh_runtime_close_observations o where o.runtime_id=new.runtime_id and o.worker_boot_id=new.worker_boot_id and o.observation_kind='owned') end;
  if p#>>'{context,contextKind}'='chat' then
    sid:=(p#>>'{context,contextId}')::uuid;
    perform allrice_terminal_native_chat_available(sid);
  end if;
  return new;
end $$;
create trigger terminal_chat_cutoff_owner before insert on allrice_dsh_runtime_close_observations
  for each row execute function allrice_terminal_native_chat_owner_fence();
create trigger terminal_chat_cutoff_guard before insert on allrice_native_context_retirements
  for each row execute function allrice_terminal_native_chat_retirement_guard();
create function allrice_terminal_native_chat_commit() returns trigger language plpgsql as $$
begin
  -- A v1 fingerprint has no kind. An early return avoids evaluating a
  -- volatile v2 facts call under SQL's NULL AND expression semantics.
  if new.context_kind<>'chat' or new.preservation_snapshot->>'kind' is distinct from 'development-test-chat-terminal-cutoff-v2' then return new; end if;
  if (
    new.preservation_snapshot->'facts' is distinct from allrice_terminal_native_chat_facts(new.context_id,new.organization_id,new.workspace_id,new.owner_id)
    or (new.preservation_snapshot#>>'{physicalProof,expiresAt}')::timestamptz<=clock_timestamp())
    then raise exception 'NATIVE_TERMINAL_RETIREMENT_COMMIT_CHANGED'; end if;
  return new;
end $$;
create constraint trigger terminal_chat_cutoff_commit after insert on allrice_native_context_retirements
  deferrable initially deferred for each row execute function allrice_terminal_native_chat_commit();

-- The terminal engine already uses this source lock; add the explicit v2 chat
-- branch while retaining the original three non-chat cases verbatim.
create or replace function allrice_terminal_native_test_lock(k text,id uuid) returns void language plpgsql as $$
begin
  if k='chat' then perform 1 from allrice_chat_sessions t where t.id=$2 for update nowait;
  elsif k='platform_employee_test' then perform 1 from allrice_platform_employee_test_runs t where t.id=$2 for update nowait;
  elsif k='experience_consolidation' then perform 1 from allrice_automation_runs a where a.id=$2 and a.experience_occurrence is not null for update nowait;
  elsif k='platform_technical' then perform 1 from allrice_platform_technical_tasks t where t.id=$2 for update nowait;
  else raise exception 'NATIVE_TERMINAL_KIND_UNSUPPORTED'; end if;
  if not found then raise exception 'NATIVE_TERMINAL_SOURCE_NOT_FOUND'; end if;
end $$;
