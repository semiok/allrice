-- Business conversation policy only. Native clocks, immutable control/Task
-- documents, journals, manual/native indexes and old NULL history stay intact.
alter table allrice_automations add column native_create_conversation_mode text
  check(native_create_conversation_mode in ('reuse','new_each_run'));
alter table allrice_native_recurring_operations add column native_revision_before bigint
  check(native_revision_before between 1 and 9007199254740991);
alter table allrice_automation_runs add column conversation_snapshot jsonb;

create function allrice_automation_conversation_snapshot_valid(s jsonb) returns boolean language sql immutable as $$
select (s=jsonb_build_object('version',1,'automationId',s->'automationId','businessRevision',s->'businessRevision',
  'mode',s->'mode','sourceSessionId',s->'sourceSessionId','targetSessionId',s->'targetSessionId',
  'employeeAssignmentId',s->'employeeAssignmentId','employeeInstanceId',s->'employeeInstanceId','trigger',s->'trigger','digest',s->'digest')
  and s->>'mode' in ('reuse','new_each_run') and jsonb_typeof(s->'businessRevision')='number'
  and (s->>'businessRevision')::numeric between 1 and 9007199254740991
  and (s->>'businessRevision')::numeric=trunc((s->>'businessRevision')::numeric)
  and jsonb_typeof(s->'automationId')='string' and (s->>'automationId')::uuid is not null
  and jsonb_typeof(s->'sourceSessionId')='string' and (s->>'sourceSessionId')::uuid is not null
  and jsonb_typeof(s->'targetSessionId')='string' and (s->>'targetSessionId')::uuid is not null
  and jsonb_typeof(s->'employeeAssignmentId')='string' and (s->>'employeeAssignmentId')::uuid is not null
  and jsonb_typeof(s->'employeeInstanceId')='string' and (s->>'employeeInstanceId')::uuid is not null
  and s->>'digest'=allrice_native_control_document_digest(s-'digest')
  and ((s->'trigger'=jsonb_build_object('kind','manual','requestId',s->'trigger'->'requestId')
      and jsonb_typeof(s->'trigger'->'requestId')='string' and (s->'trigger'->>'requestId')::uuid is not null)
    or (s->'trigger'=jsonb_build_object('kind','scheduled','scheduledFor',s->'trigger'->'scheduledFor',
        'nativeKind',s->'trigger'->'nativeKind','occurrenceId',s->'trigger'->'occurrenceId')
      and s->'trigger'->>'nativeKind' in ('once','recurring')
      and jsonb_typeof(s->'trigger'->'occurrenceId')='string' and (s->'trigger'->>'occurrenceId')::uuid is not null
      and s->'trigger'->>'scheduledFor'=to_char((s->'trigger'->>'scheduledFor')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
  and ((s->>'mode'='reuse' and s->'targetSessionId'=s->'sourceSessionId')
    or (s->>'mode'='new_each_run' and s->'targetSessionId'<>s->'sourceSessionId'))) is true
$$;
alter table allrice_automation_runs add constraint automation_conversation_snapshot_shape
  check(conversation_snapshot is null or allrice_automation_conversation_snapshot_valid(conversation_snapshot));

-- Same canonical array/UUID derivation as employeeChatUuid, using business P,
-- never a monthly arm or recovery attempt. The source is not a caller target.
create function allrice_automation_conversation_target(organization uuid, workspace uuid, owner uuid,
  automation uuid, trigger_identity jsonb) returns uuid language sql immutable as $$
select (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
from (select encode(sha256(convert_to(allrice_native_control_canonical(jsonb_build_array('automation-conversation-v1',
  organization::text,workspace::text,owner::text,automation::text,trigger_identity->>'kind',
  case when trigger_identity->>'kind'='manual' then trigger_identity->>'requestId' else trigger_identity->>'scheduledFor' end)),'UTF8')),'hex') h) digest
$$;

create function allrice_automation_conversation_immutable() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.conversation_snapshot is not null then raise exception 'automation conversation history is immutable' using errcode='23514'; end if;
    return old;
  end if;
  if new.conversation_snapshot is distinct from old.conversation_snapshot
    or (old.conversation_snapshot is not null and
      (new.id,new.organization_id,new.workspace_id,new.automation_id,new.scheduled_for,new.session_id,
       new.native_once_occurrence_id,new.native_recurring_occurrence_id,new.manual_request_id,new.created_at)
      is distinct from
      (old.id,old.organization_id,old.workspace_id,old.automation_id,old.scheduled_for,old.session_id,
       old.native_once_occurrence_id,old.native_recurring_occurrence_id,old.manual_request_id,old.created_at))
    or (old.conversation_snapshot is not null and old.run_id is not null and new.run_id is distinct from old.run_id) then
    raise exception 'automation conversation identity cannot be rewritten or backfilled' using errcode='23514';
  end if;
  return new;
end $$;
create trigger automation_conversation_immutable before update or delete on allrice_automation_runs
  for each row execute function allrice_automation_conversation_immutable();

-- Native ordinary rows always retain their non-NULL management source. The
-- privileged quality/experience branches remain separate and unchanged.
alter table allrice_automations drop constraint native_once_request_shape;
alter table allrice_automations add constraint native_once_request_shape check ((
  (clock_owner='legacy' and native_once_request_id is null and native_once_request_digest is null and native_once_cancelled_at is null)
  or (clock_owner='native_once' and trigger_type='schedule' and schedule->>'frequency'='once'
    and (conversation_mode='reuse' or (conversation_mode='new_each_run' and brand_content_binding is null and quality_binding is null and experience_binding is null))
    and employee_assignment_id is not null and session_id is not null
    and native_once_request_id is not null and native_once_request_digest ~ '^sha256:[a-f0-9]{64}$')
  or (clock_owner='native_recurring' and native_once_request_id is null and native_once_request_digest is null and native_once_cancelled_at is null)) is true);

create function allrice_automation_conversation_policy_guard() returns trigger language plpgsql as $$
declare op allrice_native_recurring_operations; ordinary boolean;
begin
  ordinary:=new.clock_owner in ('native_once','native_recurring') and new.session_id is not null
    and new.brand_content_binding is null and new.quality_binding is null and new.experience_binding is null;
  if new.native_create_conversation_mode is not null and not ordinary then
    raise exception 'conversation create input is ordinary-only' using errcode='23514';
  end if;
  if tg_op='INSERT' then
    if ordinary and new.conversation_mode<>coalesce(new.native_create_conversation_mode,'reuse') then
      raise exception 'conversation create input differs from saved choice' using errcode='23514';
    end if;
    return new;
  end if;
  if old.clock_owner not in ('native_once','native_recurring') or old.session_id is null
    or old.brand_content_binding is not null or old.quality_binding is not null or old.experience_binding is not null then return new; end if;
  if (new.organization_id,new.workspace_id,new.owner_id,new.employee_assignment_id,new.session_id,new.clock_owner,new.native_create_conversation_mode)
    is distinct from (old.organization_id,old.workspace_id,old.owner_id,old.employee_assignment_id,old.session_id,old.clock_owner,old.native_create_conversation_mode) then
    raise exception 'automation conversation source/create identity is immutable' using errcode='23514';
  end if;
  if old.clock_owner='native_once' then
    if new.conversation_mode is distinct from old.conversation_mode then
      raise exception 'once conversation mode is creation-only' using errcode='23514';
    end if;
    return new;
  end if;
  if old.schedule->'rule'->>'kind'='monthly' and new.native_recurring_revision is distinct from old.native_recurring_revision
    and not exists(select 1 from allrice_native_recurring_operations o where o.automation_id=old.id
      and o.organization_id=old.organization_id and o.owner_id=old.owner_id and o.status in ('pending','applied')
      and o.request->>'action' in ('update','pause','resume','delete')
      and (o.request->>'expectedRevision')::bigint=old.revision
      and coalesce(o.native_revision_before,(o.request->>'expectedRevision')::bigint)=old.native_recurring_revision
      and new.revision=old.revision+1 and new.native_recurring_revision=new.revision) then
    raise exception 'monthly native revision lacks its exact prior business/native operation' using errcode='23514';
  end if;
  select * into op from allrice_native_recurring_operations o where o.automation_id=old.id
    and o.organization_id=old.organization_id and o.owner_id=old.owner_id and o.status in ('pending','applied')
    and (o.request->>'expectedRevision')::bigint=old.revision and o.request->>'action'='conversation'
    and o.native_revision_before=old.native_recurring_revision;
  if op.operation_id is not null then
    if new.revision<>old.revision+1 or new.conversation_mode is distinct from op.request->>'conversationMode'
      or (to_jsonb(new)-array['revision','conversation_mode','updated_at'])
        is distinct from (to_jsonb(old)-array['revision','conversation_mode','updated_at']) then
      raise exception 'conversation-only operation attempted to move clock/content' using errcode='23514';
    end if;
  elsif old.schedule->'rule'->>'kind'='monthly' and new.native_recurring_revision=old.native_recurring_revision
    and new.revision is distinct from old.revision then
    raise exception 'monthly business revision gap lacks policy-only operation' using errcode='23514';
  elsif new.conversation_mode is distinct from old.conversation_mode and not exists(
    select 1 from allrice_native_recurring_operations o where o.automation_id=old.id and o.organization_id=old.organization_id
      and o.owner_id=old.owner_id and o.status in ('pending','applied') and o.request->>'action'='update'
      and (o.request->>'expectedRevision')::bigint=old.revision and o.request->>'conversationMode'=new.conversation_mode
      and new.revision=old.revision+1 and new.native_recurring_revision=new.revision
      and o.native_revision_before=old.native_recurring_revision) then
    raise exception 'conversation edit lacks exact accepted business operation' using errcode='23514';
  end if;
  return new;
end $$;
create trigger automation_conversation_policy_guard before insert or update on allrice_automations
  for each row execute function allrice_automation_conversation_policy_guard();

-- Existing immutable operation ledger is also the policy-only revision proof.
create unique index native_recurring_accepted_business_revision
  on allrice_native_recurring_operations(automation_id,((request->>'expectedRevision')::bigint))
  where status in ('pending','applied');
create function allrice_automation_conversation_operation_fence() returns trigger language plpgsql as $$
declare a allrice_automations; saved allrice_native_recurring_operations;
begin
  if new.request->>'action'<>'conversation' then return new; end if;
  select * into a from allrice_automations where id=new.automation_id;
  select * into saved from allrice_native_recurring_operations where organization_id=new.organization_id
    and owner_id=new.owner_id and operation_id=new.operation_id;
  if a.clock_owner<>'native_recurring' or a.session_id is null or a.brand_content_binding is not null
    or a.quality_binding is not null or a.experience_binding is not null
    or new.organization_id<>a.organization_id or new.owner_id<>a.owner_id
    or (new.status='rejected') is distinct from (new.error_message is not null)
    or new.request<>jsonb_build_object('operationId',new.operation_id::text,'action','conversation',
      'expectedRevision',new.request->'expectedRevision','conversationMode',new.request->'conversationMode')
    or jsonb_typeof(new.request->'expectedRevision') is distinct from 'number'
    or (new.request->>'expectedRevision')::numeric not between 1 and 9007199254740990
    or (new.request->>'expectedRevision')::numeric<>trunc((new.request->>'expectedRevision')::numeric)
    or coalesce(new.request->>'conversationMode','') not in ('reuse','new_each_run')
    or new.request_digest<>allrice_native_control_document_digest(jsonb_build_object('sessionId',a.session_id::text,
      'taskId',a.id::text,'input',new.request)) then
    raise exception 'conversation operation lacks exact scoped request' using errcode='23514';
  end if;
  if saved.status='rejected' then return new; end if;
  if saved.status<>'applied' or saved.error_message is not null or new.native_revision_before is null
    or a.revision<(new.request->>'expectedRevision')::bigint+1
    or (a.revision=(new.request->>'expectedRevision')::bigint+1 and
      (a.conversation_mode<>new.request->>'conversationMode' or a.native_recurring_revision<>new.native_revision_before)) then
    raise exception 'conversation operation lacks exact applied business revision' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger automation_conversation_operation_fence after insert or update on allrice_native_recurring_operations
  deferrable initially deferred for each row execute function allrice_automation_conversation_operation_fence();

create function allrice_automation_conversation_operation_birth_guard() returns trigger language plpgsql as $$
begin
  if new.request->>'action'<>'conversation' then return new; end if;
  if (tg_op='INSERT' and new.status='applied') or (tg_op='UPDATE' and old.status='pending' and new.status='applied'
    and not exists(select 1 from allrice_automations a where a.id=new.automation_id and a.organization_id=new.organization_id
      and a.owner_id=new.owner_id and a.revision=(new.request->>'expectedRevision')::bigint+1
      and a.native_recurring_revision=new.native_revision_before and a.conversation_mode=new.request->>'conversationMode'
      and new.native_revision_before< a.revision)) then
    raise exception 'conversation operation cannot forge historical applied birth' using errcode='23514';
  end if;
  return new;
end $$;
create trigger automation_conversation_operation_birth_guard before insert or update on allrice_native_recurring_operations
  for each row execute function allrice_automation_conversation_operation_birth_guard();

create function allrice_ordinary_monthly_business_revision_proved(automation uuid, native_version bigint)
returns boolean language sql as $$
with recursive revisions(revision) as (
  select $2
  union all
  select r.revision+1 from revisions r join allrice_native_recurring_operations op on op.automation_id=$1
    and (op.request->>'expectedRevision')::bigint=r.revision and op.request->>'action'='conversation'
    and op.status='applied' and op.native_revision_before=$2
  join allrice_automations a on a.id=op.automation_id and a.organization_id=op.organization_id and a.owner_id=op.owner_id
  where r.revision<a.revision)
select exists(select 1 from allrice_automations a join revisions r on r.revision=a.revision
  where a.id=$1 and a.native_recurring_revision=$2)
$$;

-- Shared frozen target proof. Current authorization is intentionally separate
-- from historical identity; later mode edits/archive do not rewrite old Runs.
-- Scheduled identity only; current authority and the full queue/decision
-- handoff remain in their existing proofs. Monthly native A may exceed P after
-- exact absence/recovery. Never equate its receipt timestamp with business P.
create function allrice_automation_conversation_scheduled_target_proved(automation uuid,
  once_occurrence text, recurring_occurrence uuid, business_p timestamptz) returns boolean language sql as $$
select (num_nonnulls($2,$3)=1 and (
  exists(select 1 from allrice_native_once_occurrences o where o.occurrence_id=$2
    and o.automation_id=$1 and o.scheduled_at::timestamptz=$4)
  or exists(select 1 from allrice_native_recurring_occurrences o
    join allrice_native_recurring_controls c on c.partition_id=o.partition_id and c.control_id=o.control_id
      and c.automation_id=o.automation_id
    where o.occurrence_id=$3 and o.automation_id=$1 and (
      (o.calendar_period_id is null and o.calendar_arm_id is null
        and c.immutable_identity->'dispatch'->>'consumer' is null and o.scheduled_at=$4)
      or (o.calendar_period_id is not null
        and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1'
        and exists(select 1 from allrice_native_calendar_periods np
          join allrice_native_calendar_plans p on p.period_id=np.plan_id and p.period_id=np.period_id
          join allrice_native_calendar_arms arm on arm.arm_id=o.calendar_arm_id and arm.period_id=np.period_id
          where np.period_id=o.calendar_period_id
            and (np.partition_id,np.control_id,np.automation_id,np.revision)=(o.partition_id,o.control_id,o.automation_id,o.revision)
            and (p.partition_id,p.control_id,p.automation_id,p.revision)=(np.partition_id,np.control_id,np.automation_id,np.revision)
            and p.business_scheduled_for=np.business_scheduled_for and p.business_scheduled_for=$4
            and np.state='received' and arm.status='received' and np.current_arm_id=arm.arm_id
            and o.scheduled_at=arm.native_at and o.payload->>'nativeTaskId'=arm.native_task_id
            and o.payload->'receipt'=coalesce(arm.task_snapshot->'deliveryHistory'->'records'->0,arm.task_snapshot->'lastDelivery'))))))) is true
$$;

create function allrice_automation_conversation_handoff_proved(automation_run uuid) returns boolean language plpgsql volatile as $$
begin
  return (
select exists(select 1 from allrice_automation_runs ar
  join allrice_automations a on a.id=ar.automation_id and a.organization_id=ar.organization_id and a.workspace_id=ar.workspace_id
  join allrice_chat_sessions source on source.id=a.session_id and source.organization_id=a.organization_id
    and source.workspace_id=a.workspace_id and source.owner_id=a.owner_id and source.employee_assignment_id=a.employee_assignment_id
  join allrice_chat_sessions target on target.id=ar.session_id and target.organization_id=a.organization_id
    and target.workspace_id=a.workspace_id and target.owner_id=a.owner_id and target.employee_assignment_id=a.employee_assignment_id
    and coalesce(target.employee_instance_id,target.employee_assignment_id)=coalesce(source.employee_instance_id,source.employee_assignment_id)
  join allrice_runs r on r.id=ar.run_id and r.organization_id=ar.organization_id and r.workspace_id=ar.workspace_id and r.owner_id=a.owner_id
  join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
  join allrice_employee_runs er on er.run_id=r.id and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id
    and er.owner_id=r.owner_id and er.session_id=target.id and er.employee_assignment_id=a.employee_assignment_id
  join allrice_messages m on m.id=er.user_message_id and m.session_id=target.id and m.organization_id=a.organization_id
    and m.workspace_id=a.workspace_id and m.owner_id=a.owner_id and m.role='user'
  join allrice_messages reply on reply.id=er.assistant_message_id and reply.session_id=target.id
    and reply.organization_id=a.organization_id and reply.workspace_id=a.workspace_id and reply.owner_id=a.owner_id and reply.role='assistant'
  left join allrice_native_once_occurrences once on once.occurrence_id=ar.native_once_occurrence_id
  left join allrice_native_once_controls oc on oc.partition_id=once.partition_id and oc.control_id=once.control_id
  left join allrice_native_recurring_occurrences recurring on recurring.occurrence_id=ar.native_recurring_occurrence_id
  left join allrice_native_recurring_controls rc on rc.partition_id=recurring.partition_id and rc.control_id=recurring.control_id
  where ar.id=$1 and allrice_automation_conversation_snapshot_valid(ar.conversation_snapshot)
    and a.clock_owner in ('native_once','native_recurring') and a.trigger_type='schedule'
    and a.brand_content_binding is null and a.quality_binding is null and a.experience_binding is null
    and ar.folder_event_id is null and ar.quality_occurrence is null and ar.experience_occurrence is null
    and ar.conversation_snapshot->>'automationId'=a.id::text
    and ar.conversation_snapshot->>'sourceSessionId'=source.id::text and ar.conversation_snapshot->>'targetSessionId'=target.id::text
    and ar.conversation_snapshot->>'employeeAssignmentId'=a.employee_assignment_id::text
    and ar.conversation_snapshot->>'employeeInstanceId'=coalesce(source.employee_instance_id,source.employee_assignment_id)::text
    and er.execution_snapshot->'instance'->>'id'=ar.conversation_snapshot->>'employeeInstanceId'
    and er.prompt_snapshot->>'userRequest'=m.content->>'text' and j.payload->>'type'='allrice.employee.run'
    and j.idempotency_key='employee-message:'||m.client_message_id::text
    and (ar.conversation_snapshot->>'mode'<>'new_each_run' or (target.visibility='private' and target.id=
      allrice_automation_conversation_target(a.organization_id,a.workspace_id,a.owner_id,a.id,ar.conversation_snapshot->'trigger')))
    and ((ar.manual_request_id is not null and ar.native_once_occurrence_id is null and ar.native_recurring_occurrence_id is null
      and ar.manual_source='user' and ar.manual_revision=(ar.conversation_snapshot->>'businessRevision')::bigint
      and m.client_message_id=ar.id and ar.conversation_snapshot->'trigger'=jsonb_build_object('kind','manual','requestId',ar.manual_request_id::text))
      or (ar.manual_request_id is null and num_nonnulls(ar.native_once_occurrence_id,ar.native_recurring_occurrence_id)=1
        and ar.conversation_snapshot->'trigger'=jsonb_build_object('kind','scheduled',
          'scheduledFor',to_char(ar.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'nativeKind',case when ar.native_once_occurrence_id is not null then 'once' else 'recurring' end,
          'occurrenceId',coalesce(ar.native_once_occurrence_id,ar.native_recurring_occurrence_id::text))
        and coalesce(once.outbox_state,recurring.outbox_state)='enqueued'
        and coalesce(once.payload_digest,recurring.payload_digest)=allrice_native_control_document_digest(coalesce(once.payload,recurring.payload))
        and coalesce(once.automation_id,recurring.automation_id)=a.id
        and allrice_automation_conversation_scheduled_target_proved(a.id,ar.native_once_occurrence_id,ar.native_recurring_occurrence_id,ar.scheduled_for)
        and coalesce(oc.immutable_control,rc.immutable_identity)->'dispatch'->>'businessSessionId'=source.id::text
        and coalesce(oc.immutable_control,rc.immutable_identity)->'dispatch'->>'employeeAssignmentId'=a.employee_assignment_id::text
        and coalesce(oc.immutable_control,rc.immutable_identity)->'dispatch'->>'employeeInstanceId'=ar.conversation_snapshot->>'employeeInstanceId'
        and coalesce(once.business_binding,recurring.business_binding) @> jsonb_build_object(
          'runId',r.id::text,'jobId',j.id::text,'organizationId',a.organization_id::text,'workspaceId',a.workspace_id::text,'ownerId',a.owner_id::text,
          'sessionId',target.id::text,'employeeAssignmentId',a.employee_assignment_id::text,'employeeInstanceId',ar.conversation_snapshot->>'employeeInstanceId',
          'userMessageId',er.user_message_id::text,'assistantMessageId',er.assistant_message_id::text,'employeeVersionId',er.employee_version_id::text,
          'clientMessageId',m.client_message_id::text,'payloadDigest',coalesce(once.payload_digest,recurring.payload_digest),
          'snapshotDigest',allrice_native_control_document_digest(er.execution_snapshot),'conversation',ar.conversation_snapshot)
        and m.client_message_id::text=case when ar.native_once_occurrence_id is not null then oc.client_message_id else recurring.client_message_id::text end)))
  );
end;
$$;

create function allrice_automation_conversation_birth_fence() returns trigger language plpgsql as $$
declare ar allrice_automation_runs; a allrice_automations;
begin
  select * into ar from allrice_automation_runs where id=new.id;
  select * into a from allrice_automations where id=ar.automation_id;
  if ar.conversation_snapshot is null then
    -- Scope by the native ordinary parent, not optional child pointers. Old
    -- NULL history is untouched: this fence runs only for a new AR INSERT.
    if a.clock_owner in ('native_once','native_recurring') and a.trigger_type='schedule' and a.session_id is not null
      and a.brand_content_binding is null and a.quality_binding is null and a.experience_binding is null then
      raise exception 'new ordinary business Run cannot downgrade to legacy NULL conversation' using errcode='23514';
    end if;
    return new;
  end if;
  if allrice_automation_conversation_handoff_proved(ar.id) is not true
    or a.conversation_mode is distinct from ar.conversation_snapshot->>'mode'
    or a.revision is distinct from (ar.conversation_snapshot->>'businessRevision')::bigint
    or a.deleted_at is not null or a.native_once_cancelled_at is not null
    or not exists(select 1 from allrice_chat_sessions source join allrice_chat_sessions target on target.id=ar.session_id
      where source.id=a.session_id and source.archived_at is null and target.archived_at is null) then
    raise exception 'automation conversation birth lacks exact current frozen target proof' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger automation_conversation_birth_fence after insert on allrice_automation_runs
  deferrable initially deferred for each row execute function allrice_automation_conversation_birth_fence();


-- Explicit ordinary proof extensions; native/experience validators are untouched.

alter table allrice_automations drop constraint native_recurring_request_shape;
alter table allrice_automations add constraint native_recurring_request_shape check ((
  (clock_owner<>'native_recurring' and native_recurring_request_id is null and native_recurring_request_digest is null
    and native_recurring_revision is null and native_recurring_resume_after is null)
  or (clock_owner='native_recurring' and trigger_type='schedule' and employee_assignment_id is not null
    and native_recurring_request_id is not null and native_recurring_request_digest ~ '^sha256:[a-f0-9]{64}$'
    and native_recurring_revision between 1 and revision and (
      (quality_binding is null and schedule->>'frequency'='native_recurring' and (conversation_mode='reuse' or (conversation_mode='new_each_run' and brand_content_binding is null and experience_binding is null)) and session_id is not null)
      or (quality_binding='{"version":1,"caseId":"project.static.v1","variant":"correct"}'::jsonb
        and schedule->>'frequency'='daily' and schedule->>'timezone'='Asia/Shanghai'
        and conversation_mode='new_each_run' and session_id is null and native_recurring_request_id=id)
      or (quality_binding is null and experience_binding is not null
        and experience_binding=jsonb_build_object('schemaVersion',1,'instanceId',experience_binding->>'instanceId',
          'policyDigest',experience_binding->>'policyDigest')
        and (experience_binding->>'instanceId')::uuid is not null
        and experience_binding->>'policyDigest' ~ '^sha256:[a-f0-9]{64}$'
        and schedule->>'frequency' in ('daily','weekly','monthly') and conversation_mode='new_each_run'
        and session_id is null and native_recurring_request_id=id)
    ))) is true);

create or replace function allrice_ordinary_monthly_scope_proved(automation uuid) returns boolean language sql as $$
select exists(select 1 from allrice_automations a
  join allrice_native_recurring_controls c on c.automation_id=a.id
  join allrice_native_once_partitions partition on partition.partition_id=c.partition_id
    and partition.reference=c.immutable_identity->'reference'
  where a.id=$1 and a.clock_owner='native_recurring' and a.trigger_type='schedule'
    and a.quality_binding is null and a.experience_binding is null and a.conversation_mode in ('reuse','new_each_run')
    and a.schedule->>'frequency'='native_recurring' and a.schedule->'rule'->>'kind'='monthly'
    and c.partition_id='allrice-recurring-v1' and c.native_task_id is null
    and c.immutable_identity->>'kind'='calendar' and c.immutable_identity->>'binding'='rotating-at-v1'
    and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1'
    and a.organization_id::text=c.immutable_identity->>'organizationId'
    and a.workspace_id::text=c.immutable_identity->>'workspaceId' and a.owner_id::text=c.immutable_identity->>'ownerId'
    and a.employee_assignment_id::text=c.immutable_identity->'dispatch'->>'employeeAssignmentId'
    and a.session_id::text=c.immutable_identity->'dispatch'->>'businessSessionId')
$$;

create or replace function allrice_ordinary_monthly_version_proved(automation uuid, version bigint) returns boolean language sql as $$
select exists(select 1 from allrice_native_recurring_versions v
  join allrice_automations a on a.id=v.automation_id
  join allrice_native_recurring_controls c on c.automation_id=a.id
  where v.automation_id=$1 and v.revision=$2 and allrice_ordinary_monthly_scope_proved(a.id)
    and allrice_ordinary_monthly_revision_valid(v.configuration)
    and v.business_content_digest=v.configuration->>'contentDigest'
    and v.business_content_digest=allrice_native_control_document_digest(v.business_content)
    and v.configuration->>'reservationDigest'=allrice_native_control_document_digest(
      (v.configuration-'reservationDigest')||jsonb_build_object('organizationId',a.organization_id::text,
        'workspaceId',a.workspace_id::text,'ownerId',a.owner_id::text,'automationId',a.id::text,
        'employeeAssignmentId',a.employee_assignment_id::text,
        'employeeInstanceId',c.immutable_identity->'dispatch'->>'employeeInstanceId','businessSessionId',a.session_id::text))
    and ((v.revision=1 and exists(select 1 from allrice_native_calendar_plans birth
      where birth.automation_id=a.id and birth.control_id=c.control_id and birth.partition_id=c.partition_id and birth.revision=1
        and birth.plan->'cause'=jsonb_build_object('kind','request','requestId',a.native_recurring_request_id::text)
        and birth.created_at=(v.configuration->>'acceptedAt')::timestamptz))
      or exists(select 1 from allrice_native_recurring_operations op
      join allrice_native_recurring_versions old on old.automation_id=v.automation_id and old.revision=coalesce(op.native_revision_before,v.revision-1)
      where op.automation_id=v.automation_id and op.organization_id=a.organization_id and op.owner_id=a.owner_id
        and op.status in ('pending','applied') and (op.request->>'expectedRevision')::bigint=v.revision-1
        and op.request->>'action' in ('update','pause','resume','delete')
        and op.created_at<=(v.configuration->>'acceptedAt')::timestamptz
        and ((op.request->>'action'='update' and op.request->'rule'=v.configuration->'rule'
          and v.business_content=jsonb_build_object('name',op.request->'name','prompt',op.request->'prompt'))
          or (op.request->>'action'<>'update' and v.business_content=old.business_content
            and v.configuration->'rule'=old.configuration->'rule')))))
$$;

create or replace function allrice_ordinary_monthly_plan_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_plans p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_automations a on a.id=p.automation_id
  where p.period_id=$1 and allrice_ordinary_monthly_version_proved(a.id,p.revision)
    and p.plan->>'revisionDigest'=allrice_native_control_document_digest(v.configuration)
    and allrice_ordinary_monthly_next(v.configuration->'rule',p.business_scheduled_for-interval '1 millisecond')=p.business_scheduled_for
    and ((p.closed_decision_id is null and a.native_recurring_revision=p.revision and allrice_ordinary_monthly_business_revision_proved(a.id,p.revision)
      and a.status='enabled' and a.deleted_at is null and a.next_run_at=p.business_scheduled_for
      and a.schedule=jsonb_build_object('frequency','native_recurring','rule',v.configuration->'rule')
      and v.business_content=jsonb_build_object('name',a.name,'prompt',a.prompt))
      or exists(select 1 from allrice_native_calendar_decisions d where d.decision_id=p.closed_decision_id and d.period_id=p.period_id))
    and (
      (p.plan->'cause'=jsonb_build_object('kind','request','requestId',a.native_recurring_request_id::text)
        and p.revision=1 and p.created_at=(v.configuration->>'acceptedAt')::timestamptz
        and p.business_scheduled_for=allrice_ordinary_monthly_next(v.configuration->'rule',p.created_at))
      or (p.plan->'cause'->>'kind'='operation' and exists(select 1 from allrice_native_recurring_operations op
        where op.automation_id=a.id and op.organization_id=a.organization_id and op.owner_id=a.owner_id
          and op.operation_id=(p.plan->'cause'->>'operationId')::uuid and op.status in ('pending','applied')
          and op.request->>'action' in ('update','resume') and (op.request->>'expectedRevision')::bigint=p.revision-1
          and p.created_at=(v.configuration->>'acceptedAt')::timestamptz and p.created_at>=op.created_at
          and p.business_scheduled_for=allrice_ordinary_monthly_next(v.configuration->'rule',p.created_at)))
      or (p.plan->'cause'->>'kind' in ('successor','coalesced') and exists(
        select 1 from allrice_native_calendar_decisions d join allrice_native_calendar_plans previous on previous.period_id=d.period_id
        where d.period_id=(p.plan->'cause'->>'predecessorPeriodId')::uuid and d.successor_period_id=p.period_id
          and previous.partition_id=p.partition_id and previous.control_id=p.control_id
          and previous.automation_id=p.automation_id and previous.revision=p.revision
          and d.kind='receipt' and d.revision=p.revision and p.created_at=d.decided_at
          and p.business_scheduled_for>previous.business_scheduled_for
          and ((p.plan->'cause'->>'kind'='successor' and d.outcome in ('queued','already_claimed')
            and p.business_scheduled_for=allrice_ordinary_monthly_next(v.configuration->'rule',d.decided_at))
            or (p.plan->'cause'->>'kind'='coalesced' and d.outcome='coalesced'
              and p.business_scheduled_for=allrice_ordinary_monthly_latest(v.configuration->'rule',d.decided_at)))))
    ))
$$;

create or replace function allrice_ordinary_monthly_clock_proved(automation uuid) returns boolean language sql as $$
select exists(select 1 from allrice_automations a
  join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=a.native_recurring_revision
  where a.id=$1 and allrice_ordinary_monthly_version_proved(a.id,v.revision) and allrice_ordinary_monthly_business_revision_proved(a.id,v.revision)
    and v.business_content=jsonb_build_object('name',a.name,'prompt',a.prompt)
    and a.schedule=jsonb_build_object('frequency','native_recurring','rule',v.configuration->'rule')
    and ((a.status='enabled' and a.deleted_at is null and exists(select 1 from allrice_native_calendar_plans p
      where p.automation_id=a.id and p.revision=v.revision and p.closed_decision_id is null
        and p.business_scheduled_for=a.next_run_at and allrice_ordinary_monthly_plan_proved(p.period_id)))
      or ((a.status<>'enabled' or a.deleted_at is not null) and a.next_run_at is null
        and not exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id and p.closed_decision_id is null))))
$$;

create or replace function allrice_ordinary_monthly_handoff_proved(occurrence uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_recurring_occurrences o
  join allrice_native_calendar_periods np on np.period_id=o.calendar_period_id and np.plan_id=np.period_id
  join allrice_native_calendar_plans p on p.period_id=np.period_id and p.closed_decision_id=np.business_decision_id
  join allrice_native_calendar_arms arm on arm.arm_id=o.calendar_arm_id and arm.period_id=np.period_id
  join allrice_native_calendar_decisions d on d.decision_id=p.closed_decision_id and d.period_id=p.period_id and d.occurrence_id=o.occurrence_id
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_automations a on a.id=p.automation_id
  join allrice_automation_runs ar on ar.id=d.automation_run_id and ar.automation_id=a.id
    and ar.native_recurring_occurrence_id=o.occurrence_id and ar.folder_event_id is null and ar.manual_request_id is null
  join allrice_runs r on r.id=ar.run_id and r.organization_id=ar.organization_id and r.workspace_id=ar.workspace_id and r.owner_id=a.owner_id
  join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
  join allrice_employee_runs er on er.run_id=r.id and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id
    and er.owner_id=r.owner_id and er.session_id=ar.session_id and er.employee_assignment_id=a.employee_assignment_id
  join allrice_messages m on m.id=er.user_message_id and m.session_id=er.session_id
    and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id and m.owner_id=er.owner_id and m.role='user'
  join allrice_messages reply on reply.id=er.assistant_message_id and reply.session_id=er.session_id
    and reply.organization_id=er.organization_id and reply.workspace_id=er.workspace_id and reply.owner_id=er.owner_id and reply.role='assistant'
  where o.occurrence_id=$1 and allrice_ordinary_monthly_scope_proved(a.id)
    and allrice_ordinary_monthly_version_proved(a.id,p.revision)
    and o.payload->'control'=c.immutable_identity and o.payload->'revision'=v.configuration
    and o.payload_digest=allrice_native_control_document_digest(o.payload)
    and np.state='received' and arm.status='received' and np.current_arm_id=arm.arm_id
    and o.revision=p.revision and o.automation_id=a.id and o.scheduled_at=arm.native_at
    and o.outbox_state='enqueued' and d.kind='receipt' and d.outcome='queued' and d.revision=p.revision
    and ar.organization_id=a.organization_id and ar.workspace_id=a.workspace_id
    and ar.scheduled_for=p.business_scheduled_for and ar.experience_occurrence is null and ((ar.conversation_snapshot is null and ar.session_id=a.session_id)
      or (ar.conversation_snapshot is not null and allrice_automation_conversation_handoff_proved(ar.id)))
    and er.execution_snapshot->'instance'->>'id'=c.immutable_identity->'dispatch'->>'employeeInstanceId'
    and m.client_message_id=o.client_message_id and m.content->>'text'=allrice_ordinary_monthly_message(v.business_content,p.business_scheduled_for)
    and er.prompt_snapshot->>'userRequest'=m.content->>'text'
    and o.business_binding=jsonb_build_object('consumer','ordinary-monthly-v1','periodId',p.period_id::text,
      'decisionId',d.decision_id::text,'automationRunId',ar.id::text,'contentDigest',v.business_content_digest,
      'runId',r.id::text,'jobId',j.id::text,'organizationId',a.organization_id::text,'workspaceId',a.workspace_id::text,
      'ownerId',a.owner_id::text,'sessionId',ar.session_id::text,'employeeAssignmentId',a.employee_assignment_id::text,
      'employeeInstanceId',c.immutable_identity->'dispatch'->>'employeeInstanceId','clientMessageId',o.client_message_id::text,
      'payloadDigest',o.payload_digest,'snapshotDigest',allrice_native_control_document_digest(er.execution_snapshot),
      'userMessageId',er.user_message_id::text,'assistantMessageId',er.assistant_message_id::text,'employeeVersionId',er.employee_version_id::text)
      ||case when ar.conversation_snapshot is null then '{}'::jsonb else jsonb_build_object('conversation',ar.conversation_snapshot) end)
$$;

create or replace function allrice_ordinary_monthly_decision_proved(id uuid) returns boolean language plpgsql as $$
declare d allrice_native_calendar_decisions; p allrice_native_calendar_plans; a allrice_automations; v allrice_native_recurring_versions;
begin
  select * into d from allrice_native_calendar_decisions where decision_id=$1;
  select * into p from allrice_native_calendar_plans where period_id=d.period_id;
  select owner_automation.* into a from allrice_automations owner_automation where owner_automation.id=p.automation_id;
  select * into v from allrice_native_recurring_versions where automation_id=p.automation_id and revision=p.revision;
  if d.decision_id is null or p.closed_decision_id is distinct from d.decision_id
    or not allrice_ordinary_monthly_version_proved(a.id,p.revision) or d.decided_at<p.created_at then return false; end if;
  if d.kind='operation' then
    return exists(select 1 from allrice_native_recurring_operations op
      join allrice_native_recurring_versions current_version on current_version.automation_id=a.id and current_version.revision=d.revision
      where op.operation_id=(d.decision->>'operationId')::uuid and op.automation_id=a.id
        and op.organization_id=a.organization_id and op.owner_id=a.owner_id and op.status in ('pending','applied')
        and op.request->>'action' in ('pause','resume','update','delete')
        and coalesce(op.native_revision_before,(op.request->>'expectedRevision')::bigint)=p.revision
        and d.revision=(op.request->>'expectedRevision')::bigint+1
        and a.native_recurring_revision=d.revision and a.revision=d.revision and d.outcome='canceled'
        and d.decided_at=(current_version.configuration->>'acceptedAt')::timestamptz and d.decided_at>=op.created_at
        and allrice_ordinary_monthly_version_proved(a.id,d.revision)
        and (op.request->>'action'<>'pause' or a.status='paused')
        and (op.request->>'action'<>'resume' or (a.status='enabled' and a.deleted_at is null))
        and (op.request->>'action'<>'delete' or (a.status='paused' and a.deleted_at=d.decided_at)));
  end if;
  if d.revision<>p.revision then return false; end if;
  if d.kind='receipt' then
    if not exists(select 1 from allrice_native_recurring_occurrences o
      join allrice_native_calendar_periods np on np.period_id=o.calendar_period_id and np.plan_id=p.period_id
      join allrice_native_calendar_arms arm on arm.arm_id=o.calendar_arm_id and arm.period_id=np.period_id
      where o.occurrence_id=d.occurrence_id and o.partition_id=p.partition_id and o.control_id=p.control_id
        and o.automation_id=p.automation_id and o.revision=p.revision and np.state='received' and arm.status='received'
        and np.business_decision_id=d.decision_id and np.business_scheduled_for=p.business_scheduled_for
        and o.payload->'revision'=v.configuration and o.scheduled_at=arm.native_at and o.payload->>'nativeTaskId'=arm.native_task_id
        and o.payload->>'businessScheduledFor'=p.plan->>'businessScheduledFor'
        and o.outbox_owner_id=d.decision->'lease'->>'ownerId' and o.outbox_epoch=(d.decision->'lease'->>'epoch')::bigint
        and o.outbox_token_digest=d.decision->'lease'->>'tokenDigest' and o.outbox_expires_at>clock_timestamp()) then return false; end if;
  elsif d.kind<>'authority' then return false;
  end if;
  if d.kind='authority' or d.outcome='authority_blocked' then
    return d.outcome='authority_blocked' and (
      not allrice_ordinary_monthly_authorized(a.id) or a.deleted_at is not null or a.native_recurring_revision<>p.revision
      or a.native_recurring_resume_after>=p.business_scheduled_for)
      and (d.kind<>'receipt' or exists(select 1 from allrice_native_recurring_occurrences o
        where o.occurrence_id=d.occurrence_id and o.outbox_state='blocked' and o.business_binding is null));
  end if;
  if d.kind<>'receipt' or d.outcome not in ('queued','already_claimed','coalesced')
    or not allrice_ordinary_monthly_authorized(a.id) or a.status<>'enabled' or a.deleted_at is not null
    or a.native_recurring_revision<>p.revision or (a.native_recurring_resume_after is not null
      and a.native_recurring_resume_after>=p.business_scheduled_for) then return false; end if;
  if not exists(select 1 from allrice_native_calendar_plans successor where successor.period_id=d.successor_period_id
    and successor.partition_id=p.partition_id and successor.control_id=p.control_id and successor.automation_id=p.automation_id
    and successor.revision=p.revision and successor.created_at=d.decided_at and successor.business_scheduled_for>p.business_scheduled_for
    and successor.plan->'cause'=jsonb_build_object('kind',case when d.outcome='coalesced' then 'coalesced' else 'successor' end,
      'predecessorPeriodId',p.period_id::text) and allrice_ordinary_monthly_plan_proved(successor.period_id)) then return false; end if;
  if d.outcome='queued' then
    return allrice_ordinary_monthly_handoff_proved(d.occurrence_id) and exists(select 1 from allrice_automation_runs ar
      where ar.id=d.automation_run_id and ar.status='queued' and ar.folder_event_id is null and ar.manual_request_id is null);
  elsif d.outcome='already_claimed' then
    return exists(select 1 from allrice_automation_runs ar join allrice_native_recurring_occurrences o on o.occurrence_id=d.occurrence_id
      where ar.id=d.automation_run_id and ar.automation_id=a.id and ar.scheduled_for=p.business_scheduled_for
        and ar.folder_event_id is null and ar.manual_request_id is null and ar.native_recurring_occurrence_id<>d.occurrence_id
        and allrice_ordinary_monthly_handoff_proved(ar.native_recurring_occurrence_id)
        and o.outbox_state='blocked' and o.business_binding is null and o.outbox_reason='ORDINARY_MONTHLY_ALREADY_CLAIMED');
  else
    return p.business_scheduled_for<allrice_ordinary_monthly_latest(v.configuration->'rule',d.decided_at)
      and not exists(select 1 from allrice_automation_runs ar where ar.automation_id=a.id
        and ar.scheduled_for=p.business_scheduled_for and ar.folder_event_id is null and ar.manual_request_id is null)
      and exists(select 1 from allrice_native_recurring_occurrences o where o.occurrence_id=d.occurrence_id
        and o.outbox_state='blocked' and o.business_binding is null and o.outbox_reason='ORDINARY_MONTHLY_COALESCED');
  end if;
end $$;

create or replace function allrice_ordinary_monthly_operation_fence() returns trigger language plpgsql as $$
declare a allrice_automations; v allrice_native_recurring_versions; action text; target_revision bigint;
  version_proved boolean; duplicate_accepted boolean;
begin
  if not exists(select 1 from allrice_native_recurring_controls c where c.automation_id=new.automation_id
    and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1') then return new; end if;
  select * into a from allrice_automations where id=new.automation_id;
  action:=new.request->>'action';
  if action='conversation' then return new; end if;
  target_revision:=(new.request->>'expectedRevision')::bigint+1;
  if new.organization_id<>a.organization_id or new.owner_id<>a.owner_id
    or new.request_digest<>allrice_native_control_document_digest(jsonb_build_object('sessionId',a.session_id::text,
      'taskId',a.id::text,'input',new.request))
    or (new.status='rejected') is distinct from (new.error_message is not null)
    or action is null or action not in ('update','pause','resume','delete')
    or new.request<>(jsonb_build_object('operationId',new.operation_id::text,'expectedRevision',new.request->'expectedRevision','action',action)
      ||case when action='update' then jsonb_build_object('name',new.request->'name','prompt',new.request->'prompt','rule',new.request->'rule')
        ||case when new.request?'conversationMode' then jsonb_build_object('conversationMode',new.request->'conversationMode') else '{}'::jsonb end
        else '{}'::jsonb end)
    or jsonb_typeof(new.request->'expectedRevision') is distinct from 'number'
    or (new.request->>'expectedRevision')::numeric not between 1 and 9007199254740990
    or (new.request->>'expectedRevision')::numeric<>trunc((new.request->>'expectedRevision')::numeric) then
    raise exception 'ordinary monthly operation lacks exact scoped request' using errcode='23514';
  end if;
  if new.status='rejected' then return new; end if;
  select * into v from allrice_native_recurring_versions where automation_id=a.id and revision=target_revision;
  version_proved:=allrice_ordinary_monthly_version_proved(a.id,target_revision);
  duplicate_accepted:=exists(select 1 from allrice_native_recurring_operations other where other.automation_id=a.id
      and other.operation_id<>new.operation_id and other.status in ('pending','applied')
      and other.request->'expectedRevision'=new.request->'expectedRevision');
  if version_proved is not true or a.native_recurring_revision<target_revision or duplicate_accepted then
    raise exception 'ordinary monthly operation lacks its unique accepted revision' using errcode='23514',
      detail=jsonb_build_object('versionProved',version_proved,'currentRevision',a.native_recurring_revision,
        'targetRevision',target_revision,'duplicateAccepted',duplicate_accepted)::text;
  end if;
  if new.status='pending' then return new; end if;
  if allrice_ordinary_monthly_operation_authority_terminal_proved(a.id,new.operation_id) then return new; end if;
  if action='delete' then
    if a.deleted_at is null or exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id and p.closed_decision_id is null)
      or exists(select 1 from allrice_native_calendar_periods p join allrice_native_calendar_arms arm on arm.period_id=p.period_id
        where p.automation_id=a.id and (arm.status='creating' or (arm.native_task_id is not null
          and not exists(select 1 from allrice_native_calendar_retirements r where r.arm_id=arm.arm_id)))) then
      raise exception 'ordinary monthly delete lacks resolved public native retirement' using errcode='23514';
    end if;
  elsif action in ('resume','update') and exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id
    and p.plan->'cause'=jsonb_build_object('kind','operation','operationId',new.operation_id::text)) then
    if not exists(select 1 from allrice_native_calendar_plans p join allrice_native_calendar_periods np on np.plan_id=p.period_id
      join allrice_native_calendar_arms arm on arm.arm_id=np.current_arm_id and arm.period_id=np.period_id
      where p.automation_id=a.id and p.revision=target_revision and arm.native_task_id is not null and arm.status in ('bound','received')
        and (p.closed_decision_id is null or exists(select 1 from allrice_native_calendar_decisions d
          where d.decision_id=p.closed_decision_id and d.kind='receipt' and d.outcome in ('queued','already_claimed','coalesced')))
        and p.plan->'cause'=jsonb_build_object('kind','operation','operationId',new.operation_id::text)) then
      raise exception 'ordinary monthly operation lacks an actual bound successor Task' using errcode='23514';
    end if;
  elsif action='resume' or (action='update' and a.native_recurring_revision=target_revision and a.status='enabled')
    or exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id and p.revision<target_revision and p.closed_decision_id is null) then
    raise exception 'ordinary monthly paused operation leaves active or missing intent' using errcode='23514';
  end if;
  return new;
end $$;

create or replace function allrice_automation_manual_commit_fence() returns trigger language plpgsql as $$
begin
  if new.manual_request_id is null then return new; end if;
  if exists(select 1 from allrice_automation_runs ar where ar.id=new.id and ar.conversation_snapshot is not null) then
    if allrice_automation_conversation_handoff_proved(new.id) is not true then
      raise exception 'manual automation lacks exact frozen conversation binding' using errcode='23514';
    end if;
    return new; -- The separate INSERT birth fence checks the current setting/revision.
  end if;
  if not exists (
    select 1 from allrice_automation_runs ar
    join allrice_automations a on a.id=ar.automation_id and a.organization_id=ar.organization_id and a.workspace_id=ar.workspace_id
    join allrice_chat_sessions s on s.id=ar.session_id and s.organization_id=a.organization_id and s.workspace_id=a.workspace_id and s.owner_id=a.owner_id
    join allrice_runs r on r.id=ar.run_id and r.organization_id=a.organization_id and r.workspace_id=a.workspace_id and r.owner_id=a.owner_id
    join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    join allrice_employee_runs er on er.run_id=r.id and er.session_id=s.id and er.employee_assignment_id=a.employee_assignment_id
    join allrice_messages m on m.id=er.user_message_id and m.session_id=s.id and m.organization_id=a.organization_id and m.workspace_id=a.workspace_id and m.owner_id=a.owner_id
    where ar.id=new.id and ar.manual_source='user' and ar.manual_revision=a.revision
      and a.clock_owner in ('native_once','native_recurring') and a.trigger_type='schedule'
      and a.brand_content_binding is null and a.quality_binding is null and a.experience_binding is null
      and a.conversation_mode='reuse' and a.session_id=s.id and a.deleted_at is null
      and a.native_once_cancelled_at is null and s.archived_at is null
      and m.role='user' and m.client_message_id=ar.id
      and j.idempotency_key='employee-message:'||ar.id::text
      and j.payload->>'type'='allrice.employee.run'
  ) then
    raise exception 'manual automation business binding not committed' using errcode='23514';
  end if;
  return new;
end $$;
