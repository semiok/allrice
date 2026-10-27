-- Provisional 0216: explicit legacy first adoption on the existing U1 chain.
-- 0212 C, 0213 U1, 0215 non-chat reservation remain separate. No historical
-- origin, pin, Run, Native journal or stored-object UPDATE/DELETE occurs here.
do $$ declare k text; n integer;
begin
 select count(*),min(conname) into n,k from pg_constraint
 where conrelid='allrice_native_chat_executor_transitions'::regclass and contype='c'
   and pg_get_constraintdef(oid) like '%schemaVersion%';
 if n<>1 then raise exception 'ADOPTION_TRANSITION_SCHEMA_UNEXPECTED'; end if;
 execute format('alter table allrice_native_chat_executor_transitions drop constraint %I',k);
end $$;
alter table allrice_native_chat_executor_transitions add constraint native_chat_transition_version_scope
 check((receipt->>'requestId'=request_id::text and (receipt->>'sequence')::bigint=sequence
  and receipt->>'kind'='chat-executor-transition' and receipt->>'schemaVersion' in('1','2')
  and receipt#>>'{scope,contextKind}'='chat' and receipt#>>'{scope,contextId}'=context_id::text
  and receipt#>>'{scope,organizationId}'=organization_id::text
  and receipt#>>'{scope,workspaceId}'=workspace_id::text and receipt#>>'{scope,ownerId}'=owner_id::text) is true);

-- SQL guards use the same immutable first receipt. TS additionally validates the
-- complete digest chain and the original published source before any execution.
create function allrice_native_chat_effective_origin(chat uuid) returns jsonb language sql stable as $$
 select coalesce(c.native_root_origin,(select t.receipt#>'{adoption,effectiveOrigin}'
  from allrice_native_chat_executor_transitions t where t.context_id=c.id and t.sequence=1
   and t.receipt->>'schemaVersion'='2' and t.organization_id=c.organization_id
   and t.workspace_id=c.workspace_id and t.owner_id=c.owner_id))
 from allrice_chat_sessions c where c.id=chat
$$;
-- Source and business history hashes are an adoption-only CAS, to avoid changing
-- frozen U1 facts or making unrelated history updates alter an existing receipt.
create function allrice_native_chat_adoption_facts(chat uuid, excluded_request uuid) returns jsonb
 language sql volatile as $$
 select allrice_native_chat_executor_facts(chat,excluded_request) || jsonb_build_object(
 'legacySource',jsonb_build_object('employeeVersionId',v.id,'configChecksum',v.config_checksum,
   'manifestDigest',allrice_native_control_document_digest(v.manifest)),
 'employeeRunsDigest',allrice_native_control_document_digest(coalesce((select jsonb_agg(to_jsonb(e) order by e.run_id)
   from allrice_employee_runs e where e.session_id=c.id),'[]'::jsonb)),
 'messagesDigest',allrice_native_control_document_digest(coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
   from allrice_messages m where m.session_id=c.id),'[]'::jsonb)),
 'deliverablesDigest',allrice_native_control_document_digest(coalesce((select jsonb_agg(to_jsonb(d) order by d.id)
   from allrice_deliverable_versions d where d.series_id in (select series_id from allrice_deliverable_versions where session_id=c.id)
   and d.organization_id=c.organization_id and d.workspace_id=c.workspace_id and d.owner_id=c.owner_id),'[]'::jsonb)),
 'objects',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'checksum',o.checksum,'byteSize',o.size_bytes) order by o.id)
   from allrice_storage_objects o where o.id in (
    select object_id from allrice_deliverable_versions where series_id in(select series_id from allrice_deliverable_versions where session_id=c.id)
    union select a.object_id from allrice_message_attachments a join allrice_messages m on m.id=a.message_id where m.session_id=c.id)
   and o.organization_id=c.organization_id and o.workspace_id=c.workspace_id and o.owner_id=c.owner_id),'[]'::jsonb))
 from allrice_chat_sessions c join allrice_employee_versions v on v.id=c.employee_version_id
  and v.organization_id=c.organization_id and v.workspace_id=c.workspace_id
 where c.id=chat
$$;
create or replace function allrice_native_chat_executor_guard() returns trigger language plpgsql as $$
declare c allrice_chat_sessions%rowtype; p jsonb; now_ms bigint; origin jsonb; adopting boolean;
begin
  select * into c from allrice_chat_sessions where id=new.context_id for update;
  adopting := new.receipt->>'schemaVersion'='2';
  origin := case when adopting then new.receipt#>'{adoption,effectiveOrigin}' else allrice_native_chat_effective_origin(new.context_id) end;
  select floor(extract(epoch from clock_timestamp())*1000)::bigint into now_ms;
  -- Explicit IS TRUE prevents missing/null JSON keys bypassing a boolean guard.
  if (c.id is not null and c.archived_at is null and c.organization_id=new.organization_id and c.workspace_id=new.workspace_id and c.owner_id=new.owner_id
    and origin is not null and origin->>'contextKind'='chat'
    and origin->>'distributionGeneration'='dsh-0.2.1-rc.2-687f282'
    and origin->>'profileId'='restricted'
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
    and new.receipt->>'originDigest'=allrice_native_control_document_digest(origin)
    and new.sequence=coalesce((p->>'sequence')::bigint,0)+1
    and new.receipt->>'previousDigest' is not distinct from p->>'digest'
    and (p is null or (new.receipt->'from'=p->'target' and new.receipt->>'storageNamespace'=p->>'storageNamespace'))
    and new.receipt->'from'<>new.receipt->'target'
    and new.receipt#>>'{from,generation}'=case when adopting then 'dsh-0.1.5-rc.3-a4c74a9' else 'dsh-0.2.1-rc.2-687f282' end and new.receipt#>>'{from,profileId}'='restricted'
    and new.receipt#>>'{target,generation}'='dsh-0.2.1-rc.2-687f282' and new.receipt#>>'{target,profileId}'='restricted'
    and new.receipt#>>'{from,artifactId}' ~ '^sha256:[a-f0-9]{64}$'
    and new.receipt#>>'{target,artifactId}' ~ '^sha256:[a-f0-9]{64}$'
    and jsonb_typeof(new.receipt#>'{facts,bindings}')='array' and (case when adopting then jsonb_array_length(new.receipt#>'{facts,bindings}')=0 else jsonb_array_length(new.receipt#>'{facts,bindings}')>0 end)
    and new.approval->>'kind'=case when adopting then 'reviewed-chat-legacy-adoption-v1' else 'reviewed-chat-executor-transition-v1' end
    and new.approval->>'requestId'=new.request_id::text
    and new.approval->'scope'=new.receipt->'scope' and new.approval->'target'=new.receipt->'target' and new.approval->'from'=new.receipt->'from'
    and new.approval->>'storageNamespace'=new.receipt->>'storageNamespace'
    and new.approval->>'previousDigest' is not distinct from new.receipt->>'previousDigest'
    and new.approval->>'expectedFactsDigest'=new.receipt->>'factsDigest'
    and length(new.approval->>'reviewedBy')>0
    and now_ms between (new.approval->>'reviewedAtMs')::bigint and (new.approval->>'expiresAtMs')::bigint
    and (new.approval->>'expiresAtMs')::bigint-(new.approval->>'reviewedAtMs')::bigint between 0 and 900000
    and allrice_native_chat_executor_idle(new.context_id)
    and new.receipt->'facts'=case when adopting then allrice_native_chat_adoption_facts(new.context_id,new.request_id) else allrice_native_chat_executor_facts(new.context_id,new.request_id) end
    ) is not true then raise exception 'EXECUTOR_TRANSITION_FACTS_CHANGED'; end if;
  if adopting then
   if (c.native_root_origin is null and new.sequence=1 and p is null
    and new.receipt#>>'{adoption,kind}'='null-origin-legacy-v1'
    and new.receipt#>'{adoption,originalOrigin}'='null'::jsonb
    and new.receipt->>'previousDigest' is null
    and not exists(select 1 from allrice_native_session_bindings where context_kind='chat' and context_id=c.id)
    and new.receipt#>>'{adoption,sourceVersionId}'=c.employee_version_id::text
    and new.receipt#>>'{adoption,sourceManifestDigest}'=new.receipt#>>'{facts,legacySource,manifestDigest}'
    and origin->>'schemaVersion'='2' and origin->>'contextId'=c.id::text and origin->>'rootSeed'=c.id::text
    and origin#>>'{scope,organizationId}'=c.organization_id::text
    and origin#>>'{scope,workspaceId}'=c.workspace_id::text and origin#>>'{scope,ownerId}'=c.owner_id::text
    and origin#>>'{birthSource,employeeVersionId}'=c.employee_version_id::text
    and origin#>>'{birthSource,manifestDigest}'=new.receipt#>>'{facts,legacySource,manifestDigest}'
    and origin#>>'{birthSource,configChecksum}'=new.receipt#>>'{facts,legacySource,configChecksum}'
    and origin#>>'{sourcePolicy,family}'='allrice_declarative_employee_v1'
    and origin->>'artifactId'=new.receipt#>>'{target,artifactId}'
    and new.receipt#>>'{adoption,sourceNamespace}'<>new.receipt->>'storageNamespace'
    and new.approval->'adoption'=new.receipt->'adoption'
    and new.approval ?& array['conversionProof','byteFactsProof']
    and new.receipt#>>'{adoption,sourceByteFactsDigest}' ~ '^sha256:[a-f0-9]{64}$'
    and new.receipt#>>'{adoption,conversionEvidenceDigest}' ~ '^sha256:[a-f0-9]{64}$'
    and jsonb_typeof(new.receipt#>'{adoption,nativeSessionIds}')='array'
    and jsonb_array_length(new.receipt#>'{adoption,nativeSessionIds}')=1
    and new.receipt#>>'{adoption,nativeSessionIds,0}'='dsh-'||c.id::text
    ) is not true then raise exception 'EXECUTOR_ADOPTION_SCOPE_OR_SOURCE_CHANGED'; end if;
  elsif new.receipt ? 'adoption' then raise exception 'EXECUTOR_ADOPTION_ONLY_FIRST'; end if;
  return new;
end $$;

create or replace function allrice_employee_execution_binding_guard() returns trigger language plpgsql as $$
declare origin jsonb; r jsonb; b jsonb;
begin
 if tg_op='UPDATE' then
  if new.native_execution_binding is distinct from old.native_execution_binding then raise exception 'employee execution binding is immutable'; end if;
  return new;
 end if;
 select allrice_native_chat_effective_origin(id) into origin from allrice_chat_sessions where id=new.session_id and organization_id=new.organization_id and workspace_id=new.workspace_id and owner_id=new.owner_id;
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
