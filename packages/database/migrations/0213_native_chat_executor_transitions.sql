-- Provisional 0213. Requires C's final reconciled 0212. No old origin/pin/Run
-- updates, no legacy/NULL adoption, and no automatic startup upgrade.
create table allrice_native_chat_executor_transitions (
  request_id uuid primary key,
  context_id uuid not null references allrice_chat_sessions,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  sequence bigint not null check(sequence>0),
  receipt jsonb not null check(jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=1048576),
  digest text not null unique check(digest ~ '^sha256:[a-f0-9]{64}$'),
  approval jsonb not null check(jsonb_typeof(approval)='object' and octet_length(approval::text)<=16384),
  transaction_id bigint not null default txid_current(),
  applied_at timestamptz not null default clock_timestamp(),
  unique(context_id,sequence),
  check((digest=allrice_native_control_document_digest(receipt-'digest') and receipt->>'digest'=digest) is true),
  check((receipt->>'requestId'=request_id::text and (receipt->>'sequence')::bigint=sequence
    and receipt->>'kind'='chat-executor-transition' and receipt->>'schemaVersion'='1'
    and receipt#>>'{scope,contextKind}'='chat' and receipt#>>'{scope,contextId}'=context_id::text
    and receipt#>>'{scope,organizationId}'=organization_id::text
    and receipt#>>'{scope,workspaceId}'=workspace_id::text and receipt#>>'{scope,ownerId}'=owner_id::text) is true),
  check((receipt->>'factsDigest'=allrice_native_control_document_digest(receipt->'facts')) is true),
  check((receipt->>'approvalDigest'=allrice_native_control_document_digest(approval)) is true)
);
create trigger native_chat_executor_transition_immutable before update or delete
 on allrice_native_chat_executor_transitions for each row execute function allrice_native_once_immutable();

create function allrice_native_chat_executor_facts(chat uuid, excluded_request uuid) returns jsonb
language plpgsql volatile set TimeZone='UTC' as $$
declare c allrice_chat_sessions%rowtype; result jsonb; previous jsonb;
begin
  select * into c from allrice_chat_sessions where id=chat;
  if not found then raise exception 'EXECUTOR_TRANSITION_CHAT_MISSING'; end if;
  select receipt into previous from allrice_native_chat_executor_transitions
    where context_id=chat and (excluded_request is null or request_id<>excluded_request) order by sequence desc limit 1;
  select jsonb_build_object('origin',c.native_root_origin,'archived',c.archived_at is not null,
    'sourceVersionId',c.employee_version_id,'assignmentId',c.employee_assignment_id,
    'previousDigest',previous->>'digest',
    'bindings',coalesce((select jsonb_agg(to_jsonb(b) order by native_session_id)
       from allrice_native_session_bindings b where context_kind='chat' and context_id=chat),'[]'::jsonb),
    'runtime',(select to_jsonb(r) from allrice_conversation_runtimes r where session_id=chat),
    'instances',coalesce((select jsonb_agg(to_jsonb(r) order by id) from allrice_dsh_runtime_instances r where session_id=chat),'[]'::jsonb),
    'closeObservations',coalesce((select jsonb_agg(to_jsonb(o) order by runtime_id,worker_boot_id,observation_kind)
      from allrice_dsh_runtime_close_observations o where (runtime_id,worker_boot_id) in
       (select runtime_id,worker_boot_id from allrice_dsh_runtime_close_observations where observation_kind='owned'
         and payload#>>'{context,kind}'='context' and payload#>>'{context,contextKind}'='chat'
         and payload#>>'{context,contextId}'=chat::text)),'[]'::jsonb)) into result;
  return result;
end $$;
create function allrice_native_chat_executor_idle(chat uuid) returns boolean language sql volatile as $$
 with roots as (select run_id from allrice_employee_runs where session_id=chat),
 subjects as (select run_id from roots union select run_id from allrice_runtime_run_links where root_run_id in(select run_id from roots)),
 busy as (
  select 1 from allrice_runs where id in(select run_id from subjects) and state not in ('succeeded','failed','canceled')
  union all select 1 from allrice_jobs where run_id in(select run_id from subjects) and status not in('succeeded','failed','dead_letter','canceled')
  union all select 1 from allrice_runtime_operations where root_run_id in(select run_id from subjects)
   and (coalesce(snapshot->>'status','') not in('succeeded','failed','canceled','partial') or lease_expires_at>clock_timestamp())
  union all select 1 from allrice_conversation_runtimes where session_id=chat and (state='running' or active_run_id is not null)
  union all select 1 from allrice_dsh_runtime_instances where session_id=chat and status='live'
  union all select 1 from allrice_assistant_model_admissions where root_run_id in(select run_id from subjects) and finished_at is null
  union all select 1 from allrice_assistant_instances where root_run_id in(select run_id from roots) and (status not in('completed','partial','failed','canceled') or stopped_at is null)
  union all select 1 from allrice_assistant_messages where root_run_id in(select run_id from roots) and status not in('adopted','canceled')
  union all select 1 from allrice_assistant_usage where root_run_id in(select run_id from roots) and metric='tool_calls' and amount>0 and settled_amount is null
  union all select 1 from allrice_native_question_waits where run_id in(select run_id from subjects) and state<>'continued'
  union all select 1 from allrice_native_task_dispatches where run_id in(select run_id from subjects) and state<>'completed'
  union all select 1 from allrice_task_calls where run_id in(select run_id from subjects) and finished_at is null
  union all select 1 from allrice_task_resource_waits where run_id in(select run_id from subjects) and (state not in('completed','failed','canceled') or finished_at is null)
  union all select 1 from allrice_cloud_execution_attempts a join allrice_runtime_operations o on o.id=a.operation_id where o.root_run_id in(select run_id from subjects) and a.cleanup_confirmed_at is null
  union all select 1 from allrice_automations where session_id=chat and status='enabled' and deleted_at is null
 ) select not exists(select 1 from busy)
$$;
create function allrice_native_chat_executor_guard() returns trigger language plpgsql as $$
declare c allrice_chat_sessions%rowtype; p jsonb; now_ms bigint;
begin
  select * into c from allrice_chat_sessions where id=new.context_id for update;
  select floor(extract(epoch from clock_timestamp())*1000)::bigint into now_ms;
  -- Explicit IS TRUE prevents missing/null JSON keys bypassing a boolean guard.
  if (c.id is not null and c.archived_at is null and c.organization_id=new.organization_id and c.workspace_id=new.workspace_id and c.owner_id=new.owner_id
    and c.native_root_origin is not null and c.native_root_origin->>'contextKind'='chat'
    and c.native_root_origin->>'distributionGeneration'='dsh-0.2.1-rc.2-687f282'
    and c.native_root_origin->>'profileId'='restricted'
    and not exists(select 1 from allrice_native_context_retirements where context_kind='chat' and context_id=new.context_id)
    and exists(select 1 from allrice_users where id=new.owner_id and status='active')
    and exists(select 1 from allrice_organizations where id=new.organization_id and archived_at is null)
    and exists(select 1 from allrice_workspaces where id=new.workspace_id and organization_id=new.organization_id and archived_at is null)
    and exists(select 1 from allrice_memberships where organization_id=new.organization_id and user_id=new.owner_id and active and (workspace_id is null or workspace_id=new.workspace_id))
    and exists(select 1 from allrice_employee_assignments where id=c.employee_assignment_id and organization_id=new.organization_id and workspace_id=new.workspace_id and user_id=new.owner_id and active)
    ) is not true then raise exception 'EXECUTOR_TRANSITION_SCOPE_DENIED'; end if;
  select receipt into p from allrice_native_chat_executor_transitions where context_id=new.context_id and request_id<>new.request_id order by sequence desc limit 1;
  if (new.receipt ?& array['originDigest','from','target','storageNamespace','previousDigest','facts','factsDigest','approvalDigest','historyEvidenceDigest','closeEvidenceDigest','appliedAt']
    and new.approval ?& array['kind','requestId','scope','from','target','storageNamespace','previousDigest','expectedFactsDigest','reviewedBy','reviewedAtMs','expiresAtMs','artifactProof','historyProof','closeProof']
    and new.receipt->>'originDigest'=allrice_native_control_document_digest(c.native_root_origin)
    and new.sequence=coalesce((p->>'sequence')::bigint,0)+1
    and new.receipt->>'previousDigest' is not distinct from p->>'digest'
    and (p is null or (new.receipt->'from'=p->'target' and new.receipt->>'storageNamespace'=p->>'storageNamespace'))
    and new.receipt->'from'<>new.receipt->'target'
    and new.receipt#>>'{from,generation}'='dsh-0.2.1-rc.2-687f282' and new.receipt#>>'{from,profileId}'='restricted'
    and new.receipt#>>'{target,generation}'='dsh-0.2.1-rc.2-687f282' and new.receipt#>>'{target,profileId}'='restricted'
    and new.receipt#>>'{from,artifactId}' ~ '^sha256:[a-f0-9]{64}$'
    and new.receipt#>>'{target,artifactId}' ~ '^sha256:[a-f0-9]{64}$'
    and jsonb_typeof(new.receipt#>'{facts,bindings}')='array' and jsonb_array_length(new.receipt#>'{facts,bindings}')>0
    and new.approval->>'kind'='reviewed-chat-executor-transition-v1'
    and new.approval->>'requestId'=new.request_id::text
    and new.approval->'scope'=new.receipt->'scope' and new.approval->'target'=new.receipt->'target' and new.approval->'from'=new.receipt->'from'
    and new.approval->>'storageNamespace'=new.receipt->>'storageNamespace'
    and new.approval->>'previousDigest' is not distinct from new.receipt->>'previousDigest'
    and new.approval->>'expectedFactsDigest'=new.receipt->>'factsDigest'
    and length(new.approval->>'reviewedBy')>0
    and now_ms between (new.approval->>'reviewedAtMs')::bigint and (new.approval->>'expiresAtMs')::bigint
    and (new.approval->>'expiresAtMs')::bigint-(new.approval->>'reviewedAtMs')::bigint between 0 and 900000
    and allrice_native_chat_executor_idle(new.context_id)
    and new.receipt->'facts'=allrice_native_chat_executor_facts(new.context_id,new.request_id)
    ) is not true then raise exception 'EXECUTOR_TRANSITION_FACTS_CHANGED'; end if;
  return new;
end $$;
create trigger native_chat_executor_guard before insert on allrice_native_chat_executor_transitions
 for each row execute function allrice_native_chat_executor_guard();
create constraint trigger native_chat_executor_commit_guard after insert on allrice_native_chat_executor_transitions
 deferrable initially deferred for each row execute function allrice_native_chat_executor_guard();

-- Preserve the old guard for every unchanged historical/new schema1 Run.
alter function allrice_employee_execution_binding_guard() rename to allrice_employee_execution_binding_guard_before_transition;
create function allrice_employee_execution_binding_guard() returns trigger language plpgsql as $$
declare origin jsonb; r jsonb; b jsonb;
begin
 if tg_op='UPDATE' then
  if new.native_execution_binding is distinct from old.native_execution_binding then raise exception 'employee execution binding is immutable'; end if;
  return new;
 end if;
 select native_root_origin into origin from allrice_chat_sessions where id=new.session_id and organization_id=new.organization_id and workspace_id=new.workspace_id and owner_id=new.owner_id;
 b:=new.native_execution_binding;
 select receipt into r from allrice_native_chat_executor_transitions where context_id=new.session_id order by sequence desc limit 1;
 if r is not null then
  if b is null or b->>'schemaVersion' is distinct from '2' or origin is null
    or b->>'kind' is distinct from 'current_employee_execution'
    or b#>>'{scope,organizationId}' is distinct from new.organization_id::text or b#>>'{scope,workspaceId}' is distinct from new.workspace_id::text
    or b#>>'{scope,ownerId}' is distinct from new.owner_id::text or b#>>'{scope,sessionId}' is distinct from new.session_id::text or b#>>'{scope,runId}' is distinct from new.run_id::text
    or b#>>'{source,employeeVersionId}' is distinct from new.employee_version_id::text
    or b->>'originDigest' is distinct from r->>'originDigest' or b->'execution' is distinct from r->'target'
    or b#>>'{transition,requestId}' is distinct from r->>'requestId' or b#>>'{transition,digest}' is distinct from r->>'digest'
    or b#>>'{transition,sequence}' is distinct from r->>'sequence' or b#>'{transition,scope}' is distinct from r->'scope'
    or b#>'{transition,target}' is distinct from r->'target' or b#>>'{transition,storageNamespace}' is distinct from r->>'storageNamespace'
    or b#>>'{transition,originDigest}' is distinct from r->>'originDigest'
    or b->>'digest' is distinct from allrice_native_control_document_digest(b-'digest')
    then raise exception 'approved executor transition binding required'; end if;
 elsif origin->>'schemaVersion'='2' then
  if b is null or b->>'schemaVersion' is distinct from '1' or b->>'kind' is distinct from 'current_employee_execution'
    or b#>>'{scope,organizationId}' is distinct from new.organization_id::text or b#>>'{scope,workspaceId}' is distinct from new.workspace_id::text
    or b#>>'{scope,ownerId}' is distinct from new.owner_id::text or b#>>'{scope,sessionId}' is distinct from new.session_id::text or b#>>'{scope,runId}' is distinct from new.run_id::text
    or b#>>'{source,employeeVersionId}' is distinct from new.employee_version_id::text
    or b#>>'{execution,artifactId}' is distinct from origin->>'artifactId' or b#>>'{execution,generation}' is distinct from origin->>'distributionGeneration'
    or b#>>'{execution,profileId}' is distinct from 'restricted' or b#>>'{sourcePolicy,family}' is distinct from origin#>>'{sourcePolicy,family}'
    then raise exception 'current employee execution binding required'; end if;
 elsif b is not null then raise exception 'historical employee execution cannot be rebound'; end if;
 return new;
end $$;
drop trigger employee_execution_binding_guard on allrice_employee_runs;
create trigger employee_execution_binding_guard before insert or update on allrice_employee_runs
 for each row execute function allrice_employee_execution_binding_guard();
