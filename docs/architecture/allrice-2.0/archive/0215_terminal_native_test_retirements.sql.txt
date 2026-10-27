-- Terminal discard of exactly reviewed development-test execution contexts.
-- Original origins, bindings, Runs, results and unknown history are not changed.
-- 0199/chat lifecycle remains intact. Physical absence is independently observed
-- by the private reviewed operator, never inferred from this SQL snapshot.
create function allrice_terminal_native_test_lock(k text, id uuid) returns void
language plpgsql as $$
begin
  if k='platform_employee_test' then
    perform 1 from allrice_platform_employee_test_runs t where t.id=$2 for update nowait;
  elsif k='experience_consolidation' then
    perform 1 from allrice_automation_runs a where a.id=$2 and a.experience_occurrence is not null for update nowait;
  elsif k='platform_technical' then
    perform 1 from allrice_platform_technical_tasks t where t.id=$2 for update nowait;
  else raise exception 'NATIVE_TERMINAL_KIND_UNSUPPORTED'; end if;
  if not found then raise exception 'NATIVE_TERMINAL_SOURCE_NOT_FOUND'; end if;
end $$;

create function allrice_terminal_native_test_roots(k text, id uuid) returns uuid[]
language sql stable as $$
  select coalesce(array_agg(distinct run_id order by run_id),'{}'::uuid[]) from (
    select r.id run_id from allrice_runs r where $1='platform_employee_test'
      and r.execution_spec->>'platformEmployeeTestRunId'=$2::text
    union select t.run_id from allrice_platform_technical_tasks t where $1='platform_technical' and t.id=$2
    union select a.run_id from allrice_automation_runs a where $1='experience_consolidation' and a.id=$2 and a.run_id is not null
    union select b.first_run_id from allrice_native_session_bindings b where b.context_kind=$1 and b.context_id=$2
    union select t.experience_run_id from allrice_platform_employee_test_runs t where $1='platform_employee_test' and t.id=$2 and t.experience_run_id is not null
    union select m.run_id from allrice_employee_method_tests m where $1='platform_employee_test' and m.test_id=$2 and m.run_id is not null
  ) roots
$$;

-- Exact existing C close meanings. This observes recorded facts; it cannot
-- turn an old missing observation into closure or grant a new owner identity.
create function allrice_terminal_native_owner_confirmed(rid uuid, boot uuid) returns boolean
language sql stable as $$
 select exists(select 1 from allrice_dsh_runtime_close_observations c
 where c.runtime_id=rid and c.worker_boot_id=boot and c.observation_kind='process_closed' and (
  (c.payload#>>'{fact,source}'='never_spawned' and c.payload#>'{fact,spawnAttempted}'='false'::jsonb
   and c.payload#>>'{fact,reason}'='admission_closed_before_spawn'
   and not exists(select 1 from allrice_dsh_runtime_close_observations x where x.runtime_id=rid and x.worker_boot_id=boot and x.observation_kind in ('close_started','close_request')))
  or (c.payload#>>'{fact,source}'='child_close' and c.payload#>'{fact,stdioClosed}'='true'::jsonb
   and c.payload#>'{fact,exitCode}'='0'::jsonb and c.payload#>'{fact,signal}'='null'::jsonb
   and c.payload#>'{fact,terminationAttempted}'='null'::jsonb
   and exists(select 1 from allrice_dsh_runtime_close_observations x where x.runtime_id=rid and x.worker_boot_id=boot and x.observation_kind='close_started')
   and exists(select 1 from allrice_dsh_runtime_close_observations q where q.runtime_id=rid and q.worker_boot_id=boot
    and q.observation_kind='close_request' and q.payload->'acknowledged'='true'::jsonb
    and q.payload#>'{wrapper,version}'='1'::jsonb and q.payload#>'{wrapper,sdkShutdown}'='true'::jsonb
    and q.payload#>'{wrapper,rootDisposed}'='true'::jsonb and q.payload#>'{wrapper,priorFramesFlushed}'='true'::jsonb))))
$$;

create function allrice_terminal_native_test_facts(k text, id uuid, org uuid, workspace uuid, owner uuid)
returns jsonb language plpgsql set timezone='UTC' as $$
#variable_conflict use_variable
declare source jsonb; origin jsonb; pins jsonb; roots uuid[]; subjects uuid[];
  runs jsonb; jobs jsonb; observations jsonb; consumers jsonb; preserved jsonb;
  scope_proven boolean:=false; occurrence jsonb; adoption jsonb; validation jsonb; policy jsonb;
begin
  if id='68e76b6b-2e75-45b7-b628-951945b12044'::uuid then raise exception 'NATIVE_TERMINAL_PROTECTED_CONTEXT'; end if;
  if k='platform_employee_test' then
    select to_jsonb(t) into source from allrice_platform_employee_test_runs t where t.id=$2;
    if source is null or source->>'status' not in ('succeeded','failed') or source->>'completed_at' is null then
      raise exception 'NATIVE_TERMINAL_SOURCE_NOT_TERMINAL'; end if;
    if source#>>'{native_root_origin,schemaVersion}'='2' then
      scope_proven:=source#>'{native_root_origin,scope}'=jsonb_build_object('organizationId',org,'workspaceId',workspace,'ownerId',owner);
      if scope_proven is not true then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
    end if;
    if source->>'purpose'='method_candidate' then
      if not exists(select 1 from allrice_employee_method_tests m where m.test_id=$2
        and m.organization_id=org and m.workspace_id=workspace and m.owner_id=owner) then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
      scope_proven:=true;
    elsif source->>'purpose'='experience_validation' then
      if (source#>>'{experience_binding,organizationId}'=org::text
        and source#>>'{experience_binding,workspaceId}'=workspace::text and source#>>'{experience_binding,ownerId}'=owner::text) is not true then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
      scope_proven:=true;
    end if;
  elsif k='platform_technical' then
    select to_jsonb(t) into source from allrice_platform_technical_tasks t where t.id=$2
      and t.organization_id=org and t.workspace_id=workspace and t.owner_id=owner;
    if source is null then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
    if source->>'environment' not in ('dev','test') then raise exception 'NATIVE_TERMINAL_NOT_DEVELOPMENT'; end if;
    scope_proven:=true;
  elsif k='experience_consolidation' then
    select to_jsonb(r) into source from allrice_automation_runs r join allrice_automations a on a.id=r.automation_id
      where r.id=$2 and r.organization_id=org and r.workspace_id=workspace and a.owner_id=owner
        and r.experience_occurrence->>'ownerId'=owner::text;
    if source is null then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
    if source->>'status' not in ('succeeded','failed','canceled') or source->>'completed_at' is null then
      raise exception 'NATIVE_TERMINAL_SOURCE_NOT_TERMINAL'; end if;
    scope_proven:=true;
    adoption:=source->'experience_adoption_plan'; validation:=source->'experience_validation_plan';
    -- A completed historical plan is retained, never treated as ongoing solely
    -- because it once participated. Pending or future-eligible work must stop.
    if adoption->>'status'='awaiting_validation' or exists(select 1 from allrice_platform_employee_test_runs t
      where t.experience_binding->>'occurrenceId'=$2::text and (t.status in ('queued','running') or t.completed_at is null)) then
      raise exception 'NATIVE_TERMINAL_CONSUMER_BUSY'; end if;
    select coalesce(o.value,s.value) into policy from (select 1) seed
      left join allrice_settings o on o.scope_type='organization' and o.scope_id=org and o.key='employee_experience_policy'
      left join allrice_settings s on s.scope_type='system' and s.scope_id is null and s.key='employee_experience_policy';
    if source->>'status'='succeeded' and source->>'experience_receipt' is not null
      and policy->>'frequency'<>'off' and (
        (policy->>'adoptionMode'='supported_private' and (adoption='null'::jsonb or adoption->>'status'='awaiting_validation'))
        or (policy->>'validationMode'='supported_cases' and (validation='null'::jsonb or exists (
          select 1 from jsonb_array_elements(case when jsonb_typeof(validation)='array' then validation else '[]'::jsonb end) p
          where p->>'reason'='尚无完整规则及技能联合覆盖，仍待验证。' and p->>'draftIndex' ~ '^[0-7]$' and not (p ? 'testId')
            and not exists(select 1 from allrice_platform_employee_test_runs t where t.purpose='experience_validation'
              and t.experience_binding->>'occurrenceId'=id::text and t.experience_binding->>'draftIndex'=p->>'draftIndex')
            and not exists(select 1 from allrice_experience_coverage_reassessments r where r.occurrence_id=id
              and r.draft_index::text=p->>'draftIndex' and r.recognizer_version='attendance-complete-clauses-v2')))))
    then raise exception 'NATIVE_TERMINAL_CONSUMER_ELIGIBLE'; end if;
    if source->>'native_recurring_occurrence_id' is not null then
      select to_jsonb(o) into occurrence from allrice_native_recurring_occurrences o
        where o.occurrence_id=(source->>'native_recurring_occurrence_id')::uuid;
      if occurrence is null or occurrence->>'outbox_state'<>'enqueued'
        or (occurrence->>'outbox_expires_at')::timestamptz>clock_timestamp() then raise exception 'NATIVE_TERMINAL_CONSUMER_BUSY'; end if;
    elsif source->>'native_once_occurrence_id' is not null then
      select to_jsonb(o) into occurrence from allrice_native_once_occurrences o
        where o.occurrence_id=source->>'native_once_occurrence_id';
      if occurrence is null or occurrence->>'outbox_state'<>'enqueued'
        or (occurrence->>'outbox_expires_at')::timestamptz>clock_timestamp() then raise exception 'NATIVE_TERMINAL_CONSUMER_BUSY'; end if;
    end if;
  else raise exception 'NATIVE_TERMINAL_KIND_UNSUPPORTED'; end if;
  origin:=source->'native_root_origin';
  if origin<>'null'::jsonb and (origin->>'contextKind'<>k or origin->>'contextId'<>id::text) then raise exception 'NATIVE_TERMINAL_ORIGIN_CONFLICT'; end if;
  if source::text ilike '%68e76b6b-2e75-45b7-b628-951945b12044%' then raise exception 'NATIVE_TERMINAL_PROTECTED_CONTEXT'; end if;
  select coalesce(jsonb_agg((to_jsonb(b)-'bound_at') || jsonb_build_object('bound_at_micros',
    (extract(epoch from b.bound_at)*1000000)::bigint::text) order by b.native_session_id),'[]'::jsonb) into pins
    from allrice_native_session_bindings b where b.context_kind=k and b.context_id=id;
  if pins::text ilike '%68e76b6b-2e75-45b7-b628-951945b12044%' then raise exception 'NATIVE_TERMINAL_PROTECTED_CONTEXT'; end if;
  if exists(select 1 from allrice_native_session_bindings b where b.context_kind=k and b.context_id=id
    and (b.organization_id<>org or b.workspace_id<>workspace or b.owner_id<>owner)) then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
  -- Missing history stays missing/unknown. A currently existing conflicting
  -- Job is never reclassified into this scope or covered by another owner.
  if exists(select 1 from allrice_native_session_bindings b join allrice_jobs j on j.id=b.first_job_id
    where b.context_kind=k and b.context_id=id and (j.run_id<>b.first_run_id
      or j.organization_id<>org or j.workspace_id<>workspace or j.owner_id<>owner)) then raise exception 'NATIVE_TERMINAL_BINDING_SCOPE_CONFLICT'; end if;
  if jsonb_array_length(pins)>0 then scope_proven:=true; end if;
  roots:=allrice_terminal_native_test_roots(k,id);
  select coalesce(array_agg(distinct run_id order by run_id),'{}'::uuid[]) into subjects from (
    select unnest(roots) run_id union select l.run_id from allrice_runtime_run_links l where l.root_run_id=any(roots)
  ) s;
  if exists(select 1 from allrice_runs r where r.id=any(subjects) and
    (r.organization_id<>org or r.workspace_id<>workspace or r.owner_id<>owner)) then raise exception 'NATIVE_TERMINAL_SCOPE_CONFLICT'; end if;
  if exists(select 1 from allrice_employee_runs e where e.run_id=any(subjects)) then raise exception 'NATIVE_TERMINAL_BUSINESS_RUN_CONFLICT'; end if;
  if cardinality(subjects)>0 then scope_proven:=true; end if;
  if scope_proven is not true then raise exception 'NATIVE_TERMINAL_SCOPE_UNPROVEN'; end if;

  if exists(select 1 from allrice_runs r where r.id=any(subjects) and (r.state not in ('succeeded','failed','canceled') or r.completed_at is null))
    or exists(select 1 from allrice_jobs j where j.run_id=any(subjects) and
      (j.status not in ('succeeded','failed','dead_letter','canceled') or j.completed_at is null or j.lease_expires_at>clock_timestamp()))
    or exists(select 1 from allrice_runtime_operations o where o.root_run_id=any(subjects) and
      (coalesce(o.snapshot->>'status','') not in ('succeeded','failed','canceled','partial') or o.lease_expires_at>clock_timestamp()))
    or exists(select 1 from allrice_assistant_model_admissions a where a.root_run_id=any(subjects) and a.finished_at is null)
    or exists(select 1 from allrice_assistant_instances a where a.root_run_id=any(subjects) and (a.status not in ('completed','partial','failed','canceled') or a.stopped_at is null))
    or exists(select 1 from allrice_assistant_messages m where m.root_run_id=any(subjects) and m.status not in ('adopted','canceled'))
    or exists(select 1 from allrice_task_resource_waits w where w.run_id=any(subjects) and (w.state not in ('completed','failed','canceled') or w.finished_at is null))
    or exists(select 1 from allrice_assistant_usage u where u.root_run_id=any(subjects) and u.metric='tool_calls' and u.amount>0 and u.settled_amount is null)
    or exists(select 1 from allrice_task_calls c where c.run_id=any(subjects) and c.finished_at is null)
    or exists(select 1 from allrice_native_question_waits q where q.run_id=any(subjects) and q.state<>'continued')
    or exists(select 1 from allrice_native_task_dispatches d where d.run_id=any(subjects) and d.state<>'completed')
    or exists(select 1 from allrice_cloud_execution_attempts a join allrice_runtime_operations o on o.id=a.operation_id
      where o.root_run_id=any(subjects) and a.cleanup_confirmed_at is null)
    or exists(select 1 from allrice_employee_runs e where e.run_id=any(subjects) and e.session_id='68e76b6b-2e75-45b7-b628-951945b12044')
  then raise exception 'NATIVE_TERMINAL_CONTEXT_BUSY'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) into runs from allrice_runs r where r.id=any(subjects);
  select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]'::jsonb) into jobs from allrice_jobs j where j.run_id=any(subjects);
  select coalesce(jsonb_agg(jsonb_build_object('runtimeId',o.runtime_id,'workerBootId',o.worker_boot_id,
    'kind',o.observation_kind,'ownerDigest',o.owner_digest,'payloadDigest',o.payload_digest,'payload',o.payload)
    order by o.runtime_id,o.worker_boot_id,o.observation_kind),'[]'::jsonb) into observations
    from allrice_dsh_runtime_close_observations o where (o.runtime_id,o.worker_boot_id) in
      (select p.runtime_id,p.worker_boot_id from allrice_dsh_runtime_close_observations p where p.observation_kind='owned'
        and p.payload#>>'{context,contextKind}'=k and p.payload#>>'{context,contextId}'=id::text);
  if exists(select 1 from allrice_dsh_runtime_close_observations p where p.observation_kind='owned'
    and p.payload#>>'{context,contextKind}'=k and p.payload#>>'{context,contextId}'=id::text
    and (p.payload#>>'{context,organizationId}' is distinct from org::text or p.payload#>>'{context,workspaceId}' is distinct from workspace::text
      or p.payload#>>'{context,ownerId}' is distinct from owner::text or not allrice_terminal_native_owner_confirmed(p.runtime_id,p.worker_boot_id)))
  then raise exception 'NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED'; end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) into consumers from allrice_platform_employee_test_runs t
    where k='experience_consolidation' and t.experience_binding->>'occurrenceId'=id::text;
  if k='platform_employee_test' then
    select coalesce(jsonb_agg(to_jsonb(m) order by m.test_id),'[]'::jsonb) into consumers from allrice_employee_method_tests m where m.test_id=id;
  end if;
  select jsonb_build_object(
    'events',(select jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(to_jsonb(e)::text,',' order by e.run_id,e.sequence),''))) from allrice_run_events e where e.run_id=any(subjects)),
    'versions',(select jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(to_jsonb(v)::text,',' order by v.id),''))) from allrice_deliverable_versions v where k='platform_employee_test' and v.platform_test_run_id=id),
    'objects',(select jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(to_jsonb(o)::text,',' order by o.id),''))) from allrice_storage_objects o where o.id in
      (select v.object_id from allrice_deliverable_versions v where k='platform_employee_test' and v.platform_test_run_id=id))
  ) into preserved;
  return jsonb_build_object('scope',jsonb_build_object('contextKind',k,'contextId',id,'organizationId',org,'workspaceId',workspace,'ownerId',owner),
    'source',source,'origin',origin,'bindings',pins,'runIds',to_jsonb(subjects),'runs',runs,'jobs',jobs,
    'closeRows',observations,'consumers',consumers,'occurrence',occurrence,'preserved',preserved,
    'missingRunIds',(select coalesce(jsonb_agg(s.id order by s.id),'[]') from unnest(subjects) s(id) where not exists(select 1 from allrice_runs r where r.id=s.id)),
    'missingJobIds',(select coalesce(jsonb_agg(distinct b.first_job_id order by b.first_job_id),'[]') from allrice_native_session_bindings b where b.context_kind=k and b.context_id=id and not exists(select 1 from allrice_jobs j where j.id=b.first_job_id)));
end $$;

-- Shared admission locks serialize all old/new writers with the exclusive
-- terminal cutoff. Retirement never waits on a row held by a writer: existing
-- platform finalizers lock test -> Run, queue paths may hold Run -> Job. Trying
-- every cutoff lock avoids imposing a conflicting order on those old paths.
create function allrice_terminal_native_test_available(k text, id uuid) returns void
language plpgsql as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('native-terminal-context:'||k||':'||id::text,0));
  if exists(select 1 from allrice_native_context_retirements r where r.context_kind=k and r.context_id=id) then
    raise exception 'NATIVE_CONTEXT_EXECUTION_RETIRED'; end if;
end $$;

create function allrice_terminal_native_source_fence() returns trigger language plpgsql as $$
declare k text:=tg_argv[0]; target uuid;
begin
  -- Check the original ID too: changing a source primary key cannot detach its
  -- immutable cutoff. No source row is archived, rewritten or deleted here.
  for target in select distinct v from unnest(case when tg_op='DELETE' then array[old.id] else array[old.id,new.id] end) v order by v loop
    perform allrice_terminal_native_test_available(k,target);
  end loop;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger terminal_native_test_source before update or delete on allrice_platform_employee_test_runs
  for each row execute function allrice_terminal_native_source_fence('platform_employee_test');
create trigger terminal_native_technical_source before update or delete on allrice_platform_technical_tasks
  for each row execute function allrice_terminal_native_source_fence('platform_technical');
create trigger terminal_native_experience_source before update or delete on allrice_automation_runs
  for each row execute function allrice_terminal_native_source_fence('experience_consolidation');

create function allrice_terminal_native_admission_fence() returns trigger language plpgsql as $$
declare k text; target uuid; p jsonb; artifact text;
begin
  if tg_table_name='allrice_native_session_bindings' then k:=new.context_kind;target:=new.context_id;artifact:=new.artifact_id;
  else
    p:=case when new.observation_kind='owned' then new.payload else
      (select o.payload from allrice_dsh_runtime_close_observations o where o.runtime_id=new.runtime_id
        and o.worker_boot_id=new.worker_boot_id and o.observation_kind='owned') end;
    k:=p#>>'{context,contextKind}'; target:=(p#>>'{context,contextId}')::uuid; artifact:=p->>'artifactId';
  end if;
  if artifact is not null and (tg_table_name='allrice_dsh_runtime_close_observations' or k<>'chat') then
    perform pg_advisory_xact_lock_shared(hashtextextended('native-terminal-artifact:'||artifact,0));
  end if;
  if k in ('platform_employee_test','platform_technical','experience_consolidation') then
    perform allrice_terminal_native_test_available(k,target);
  end if;
  return new;
end $$;
create trigger terminal_native_binding_fence before insert on allrice_native_session_bindings
  for each row execute function allrice_terminal_native_admission_fence();
create trigger terminal_native_owner_fence before insert on allrice_dsh_runtime_close_observations
  for each row execute function allrice_terminal_native_admission_fence();

create function allrice_terminal_native_retirement_guard() returns trigger language plpgsql as $$
declare actual jsonb; proof jsonb; artifact text; subjects uuid[]; required_artifacts jsonb;
begin
  if new.context_kind='chat' then return new; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('native-terminal-context:'||new.context_kind||':'||new.context_id::text,0)) then raise exception 'NATIVE_TERMINAL_CUTOFF_BUSY'; end if;
  if exists(select 1 from allrice_dsh_runtime_instances where status='live') then raise exception 'NATIVE_TERMINAL_REGISTERED_RUNTIME_LIVE'; end if;
  select array_agg(run_id order by run_id) into subjects from (
    select unnest(allrice_terminal_native_test_roots(new.context_kind,new.context_id)) run_id
    union select l.run_id from allrice_runtime_run_links l where l.root_run_id=any(allrice_terminal_native_test_roots(new.context_kind,new.context_id))
  ) s;
  perform 1 from allrice_runs r where r.id=any(subjects) order by r.id for no key update nowait;
  perform 1 from allrice_jobs j where j.run_id=any(subjects) order by j.id for update nowait;
  for artifact in select x->>'artifactId' from jsonb_array_elements(new.preservation_snapshot#>'{physicalProof,artifactRoots}') x order by x->>'artifactId' loop
    if not pg_try_advisory_xact_lock(hashtextextended('native-terminal-artifact:'||artifact,0)) then raise exception 'NATIVE_TERMINAL_CUTOFF_BUSY'; end if;
  end loop;
  perform allrice_terminal_native_test_lock(new.context_kind,new.context_id);
  actual:=allrice_terminal_native_test_facts(new.context_kind,new.context_id,new.organization_id,new.workspace_id,new.owner_id);
  proof:=new.preservation_snapshot->'physicalProof';
  if (jsonb_typeof(proof)='object' and jsonb_typeof(proof->'artifactRoots')='array' and jsonb_typeof(proof->'writerScopes')='array') is not true then raise exception 'NATIVE_TERMINAL_RETIREMENT_PROOF_INVALID'; end if;
  select coalesce(jsonb_agg(a order by a),'[]'::jsonb) into required_artifacts from (
    select distinct a from (
      select actual#>>'{origin,artifactId}' a
      union select b->>'artifact_id' from jsonb_array_elements(actual->'bindings') b
      union select c#>>'{payload,artifactId}' from jsonb_array_elements(actual->'closeRows') c where c->>'kind'='owned'
    ) all_ids where a is not null
  ) ids;
  if required_artifacts is distinct from (select coalesce(jsonb_agg(x->>'artifactId' order by x->>'artifactId'),'[]'::jsonb) from jsonb_array_elements(proof->'artifactRoots') x)
    or exists(select 1 from allrice_dsh_runtime_close_observations p where p.observation_kind='owned'
      and required_artifacts @> jsonb_build_array(p.payload->>'artifactId')
      and not allrice_terminal_native_owner_confirmed(p.runtime_id,p.worker_boot_id)) then
    raise exception 'NATIVE_TERMINAL_REGISTERED_OWNER_OR_ARTIFACT_UNCONFIRMED'; end if;

  if (new.preservation_snapshot->>'kind'='development-terminal-test-retirement-v1'
    and new.preservation_snapshot->'facts'=actual
    and new.origin_snapshot is not distinct from nullif(actual->'origin','null'::jsonb)
    and new.binding_snapshot=actual->'bindings'
    and proof ?& array['kind','planDigest','requestId','nativeProcesses','writers','observedAt','expiresAt','processInventoryDigest','writerInventoryDigest','artifactRoots','writerScopes','storageNamespaces','scopeDigest','workerBootId','workerBootStartedAt','sourceSha','sourceTree','operatorSha256','reviewSha256']
    and proof->>'kind'='terminal-native-physical-absence-v1'
    and (proof->>'workerBootStartedAt')::timestamptz<=(proof->>'observedAt')::timestamptz
    and (actual#>>'{source,created_at}')::timestamptz<(proof->>'workerBootStartedAt')::timestamptz
    and not exists(select 1 from jsonb_array_elements(actual->'bindings') b where (b->>'bound_at_micros')::bigint >= (extract(epoch from (proof->>'workerBootStartedAt')::timestamptz)*1000000)::bigint)
    and proof->>'planDigest'=new.plan_digest and proof->>'requestId'=new.request_id::text
    and not exists(select 1 from jsonb_array_elements(actual->'bindings') b where not exists(
      select 1 from jsonb_array_elements(proof->'writerScopes') w where w->>'artifactId'=b->>'artifact_id'
        and (b->>'storage_namespace'=w->>'root' or starts_with(b->>'storage_namespace',(w->>'root')||'/'))))
    and proof->'nativeProcesses'='[]'::jsonb and proof->'writers'='[]'::jsonb
    and (proof->>'expiresAt')::timestamptz>clock_timestamp()
    and (proof->>'observedAt')::timestamptz<=clock_timestamp()
    and (proof->>'expiresAt')::timestamptz<=(proof->>'observedAt')::timestamptz+interval '120 seconds') is not true
  then raise exception 'NATIVE_TERMINAL_RETIREMENT_PROOF_INVALID'; end if;
  return new;
end $$;
create trigger terminal_native_retirement_guard before insert on allrice_native_context_retirements
  for each row execute function allrice_terminal_native_retirement_guard();

create function allrice_terminal_native_run_contexts(rid uuid, spec jsonb default '{}'::jsonb)
returns table(kind text, context_id uuid) language sql stable as $$
  select 'platform_employee_test', (spec->>'platformEmployeeTestRunId')::uuid
    where spec->>'platformEmployeeTestRunId' ~ '^[a-fA-F0-9-]{36}$'
  union select 'platform_technical',t.id from allrice_platform_technical_tasks t where t.run_id=rid
  union select 'experience_consolidation',a.id from allrice_automation_runs a where a.run_id=rid and a.experience_occurrence is not null
  union select b.context_kind,b.context_id from allrice_native_session_bindings b where b.first_run_id=rid and b.context_kind<>'chat'
  union select r.context_kind,r.context_id from allrice_native_context_retirements r
    where r.context_kind<>'chat' and r.preservation_snapshot#>'{facts,runIds}' @> jsonb_build_array(rid::text)
$$;

create function allrice_terminal_native_queue_fence() returns trigger language plpgsql as $$
declare rid uuid; ids uuid[]; c record;
begin
  if tg_table_name='allrice_jobs' then
    -- The original immutable pin reserves an absent historical Job ID too.
    -- A new Job on another Run may not alias that discarded identity later.
    for c in select distinct b.context_kind kind,b.context_id from allrice_native_session_bindings b
      where b.context_kind<>'chat' and b.first_job_id=any(case when tg_op='INSERT' then array[new.id] when tg_op='DELETE' then array[old.id] else array[old.id,new.id] end)
      order by b.context_kind,b.context_id loop
      perform allrice_terminal_native_test_available(c.kind,c.context_id);
    end loop;
  end if;
  if tg_table_name='allrice_runs' then
    ids:=case when tg_op='INSERT' then array[new.id] when tg_op='DELETE' then array[old.id] else array[old.id,new.id] end;
  elsif tg_table_name in ('allrice_runtime_operations','allrice_assistant_model_admissions','allrice_assistant_instances','allrice_assistant_messages') then
    ids:=case when tg_op='INSERT' then array[new.root_run_id] when tg_op='DELETE' then array[old.root_run_id] else array[old.root_run_id,new.root_run_id] end;
  elsif tg_table_name='allrice_runtime_run_links' then
    ids:=case when tg_op='INSERT' then array[new.root_run_id] when tg_op='DELETE' then array[old.root_run_id] else array[old.root_run_id,new.root_run_id] end;
  else
    ids:=case when tg_op='INSERT' then array[new.run_id] when tg_op='DELETE' then array[old.run_id] else array[old.run_id,new.run_id] end;
  end if;
  for c in select distinct x.kind,x.context_id from unnest(ids) i(rid)
    left join allrice_runs r on r.id=i.rid
    cross join lateral allrice_terminal_native_run_contexts(i.rid,coalesce(r.execution_spec,'{}'::jsonb)) x
    order by x.kind,x.context_id loop
    perform allrice_terminal_native_test_available(c.kind,c.context_id);
  end loop;
  -- BEFORE INSERT cannot query the new Run yet.
  if tg_table_name='allrice_runs' and tg_op<>'DELETE' then
    for c in select * from allrice_terminal_native_run_contexts(new.id,new.execution_spec) order by kind,context_id loop
      perform allrice_terminal_native_test_available(c.kind,c.context_id);
    end loop;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger terminal_native_run_fence before insert or update or delete on allrice_runs
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_job_fence before insert or update or delete on allrice_jobs
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_event_fence before insert or update or delete on allrice_run_events
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_child_fence before insert or update or delete on allrice_runtime_run_links
  for each row execute function allrice_terminal_native_queue_fence();

-- Only executable consumer state, never immutable usage/financial history.
create trigger terminal_native_operation_fence before insert or update or delete on allrice_runtime_operations
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_model_admission_fence before insert or update or delete on allrice_assistant_model_admissions
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_assistant_fence before insert or update or delete on allrice_assistant_instances
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_assistant_message_fence before insert or update or delete on allrice_assistant_messages
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_wait_fence before insert or update or delete on allrice_task_resource_waits
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_task_call_fence before insert or update or delete on allrice_task_calls
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_question_fence before insert or update or delete on allrice_native_question_waits
  for each row execute function allrice_terminal_native_queue_fence();
create trigger terminal_native_dispatch_fence before insert or update or delete on allrice_native_task_dispatches
  for each row execute function allrice_terminal_native_queue_fence();

create function allrice_terminal_native_consumer_fence() returns trigger language plpgsql as $$
declare target uuid; r record;
begin
  if tg_table_name='allrice_platform_employee_test_runs' then
    target:=(new.experience_binding->>'occurrenceId')::uuid;
    if target is not null then perform allrice_terminal_native_test_available('experience_consolidation',target); end if;
  else
    for r in select a.id from allrice_automation_runs a
      where (tg_table_name='allrice_native_recurring_occurrences' and a.native_recurring_occurrence_id::text=new.occurrence_id::text)
        or (tg_table_name='allrice_native_once_occurrences' and a.native_once_occurrence_id=new.occurrence_id::text)
      order by a.id loop
      perform allrice_terminal_native_test_available('experience_consolidation',r.id);
    end loop;
  end if;
  return new;
end $$;
create trigger terminal_native_validation_consumer before insert or update on allrice_platform_employee_test_runs
  for each row execute function allrice_terminal_native_consumer_fence();
create trigger terminal_native_recurring_consumer before update on allrice_native_recurring_occurrences
  for each row execute function allrice_terminal_native_consumer_fence();
create trigger terminal_native_once_consumer before update on allrice_native_once_occurrences
  for each row execute function allrice_terminal_native_consumer_fence();

create function allrice_terminal_native_retirement_commit() returns trigger language plpgsql as $$
begin
  if new.context_kind<>'chat' and (
    new.preservation_snapshot->'facts' is distinct from allrice_terminal_native_test_facts(
      new.context_kind,new.context_id,new.organization_id,new.workspace_id,new.owner_id)
    or (new.preservation_snapshot#>>'{physicalProof,expiresAt}')::timestamptz<=clock_timestamp()) then
    raise exception 'NATIVE_TERMINAL_RETIREMENT_COMMIT_CHANGED';
  end if;
  return new;
end $$;
create constraint trigger terminal_native_retirement_commit after insert on allrice_native_context_retirements
  deferrable initially deferred for each row execute function allrice_terminal_native_retirement_commit();

-- Registry heartbeats cannot resurrect any native thread inside the cutoff.
create function allrice_terminal_native_registry_fence() returns trigger language plpgsql as $$
declare c record;
begin
  for c in select distinct b.context_kind,b.context_id from allrice_native_session_bindings b
    where b.native_session_id=new.thread_id and b.context_kind<>'chat' order by b.context_kind,b.context_id loop
    perform allrice_terminal_native_test_available(c.context_kind,c.context_id);
  end loop;
  return new;
end $$;
create trigger terminal_native_registry_fence before insert or update on allrice_dsh_runtime_instances
  for each row execute function allrice_terminal_native_registry_fence();

create function allrice_terminal_native_method_fence() returns trigger language plpgsql as $$
begin
  perform allrice_terminal_native_test_available('platform_employee_test',case when tg_op='DELETE' then old.test_id else new.test_id end);
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger terminal_native_method_binding_fence before insert or update or delete on allrice_employee_method_tests
  for each row execute function allrice_terminal_native_method_fence();
create trigger terminal_native_method_file_fence before insert or update or delete on allrice_employee_method_file_steps
  for each row execute function allrice_terminal_native_method_fence();
