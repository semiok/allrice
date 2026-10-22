-- Ordinary monthly is a separate calendar consumer. Fixed rules and the
-- experience consumer keep their original exact schemas and business proof.
-- 0206 owns manual_request_id and scheduled-period uniqueness; no manual
-- request can satisfy a scheduled P here.
do $$ begin
  if not exists(select 1 from information_schema.columns where table_schema=current_schema()
    and table_name='allrice_automation_runs' and column_name='manual_request_id') then
    raise exception 'ordinary monthly requires the 0206 manual/scheduled identity migration' using errcode='23514';
  end if;
end $$;

-- Reuse the existing immutable automation/revision row and FK. No prompt is
-- copied into native Task metadata; a 40000 UTF-16-unit prompt remains whole.
alter table allrice_native_recurring_versions add column business_content jsonb,
  add column business_content_digest text;
alter table allrice_native_recurring_versions add constraint native_monthly_business_content check ((
  (configuration->>'consumer' is distinct from 'ordinary-monthly-v1'
    and business_content is null and business_content_digest is null)
  or (configuration->>'consumer'='ordinary-monthly-v1' and configuration->>'kind'='calendar'
    and business_content=jsonb_build_object('name',business_content->'name','prompt',business_content->'prompt')
    and jsonb_typeof(business_content->'name')='string' and length(btrim(business_content->>'name'))>0
    and allrice_native_calendar_utf16_length(business_content->>'name') between 1 and 160
    and jsonb_typeof(business_content->'prompt')='string' and length(btrim(business_content->>'prompt'))>0
    and allrice_native_calendar_utf16_length(business_content->>'prompt') between 1 and 40000
    and business_content_digest=configuration->>'contentDigest'
    and business_content_digest=allrice_native_control_document_digest(business_content)
    and octet_length(allrice_native_control_canonical(configuration))<=65536)
) is true);

create function allrice_ordinary_monthly_rule_valid(r jsonb) returns boolean language sql stable as $$
select (r=jsonb_build_object('kind','monthly','monthDay',r->'monthDay','time',r->'time','timezone',r->'timezone')
  and jsonb_typeof(r->'monthDay')='number' and (r->>'monthDay')::numeric between 1 and 31
  and (r->>'monthDay')::numeric=trunc((r->>'monthDay')::numeric)
  and jsonb_typeof(r->'time')='string' and r->>'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
  and jsonb_typeof(r->'timezone')='string' and length(r->>'timezone') between 1 and 64
  and exists(select 1 from pg_timezone_names z where lower(z.name)=lower(r->>'timezone'))) is true
$$;
create function allrice_ordinary_monthly_revision_valid(v jsonb) returns boolean language sql stable as $$
select (v=jsonb_build_object('kind','calendar','binding','rotating-at-v1','consumer','ordinary-monthly-v1',
    'revision',v->'revision','contentDigest',v->'contentDigest','rule',v->'rule',
    'reservationDigest',v->'reservationDigest','acceptedAt',v->'acceptedAt')
  and jsonb_typeof(v->'revision')='number' and (v->>'revision')::numeric between 1 and 9007199254740991
  and (v->>'revision')::numeric=trunc((v->>'revision')::numeric)
  and v->>'contentDigest' ~ '^sha256:[a-f0-9]{64}$' and v->>'reservationDigest' ~ '^sha256:[a-f0-9]{64}$'
  and jsonb_typeof(v->'acceptedAt')='string'
  and v->>'acceptedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  and v->>'acceptedAt'=to_char((v->>'acceptedAt')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  and allrice_ordinary_monthly_rule_valid(v->'rule')) is true
$$;

-- Mirror the original business calendar algorithm, including the earlier
-- autumn overlap and forward spring gap. Native createAt still owns wakes.
create function allrice_ordinary_monthly_target(r jsonb, month_start date) returns timestamptz language plpgsql stable strict as $$
declare wall timestamp; guess timestamptz; first_try timestamptz; second_try timestamptz; third_try timestamptz;
  tz text:=r->>'timezone'; last_day integer;
begin
  if not allrice_ordinary_monthly_rule_valid(r) then raise exception 'invalid ordinary monthly rule' using errcode='23514'; end if;
  month_start:=date_trunc('month',month_start)::date;
  last_day:=extract(day from (month_start+interval '1 month - 1 day'))::integer;
  wall:=month_start+make_interval(days=>least((r->>'monthDay')::integer,last_day)-1,
    hours=>substring(r->>'time',1,2)::integer,mins=>substring(r->>'time',4,2)::integer);
  guess:=wall at time zone 'UTC';
  first_try:=guess-((guess at time zone tz)-(guess at time zone 'UTC'));
  second_try:=guess-((first_try at time zone tz)-(first_try at time zone 'UTC'));
  third_try:=guess-((second_try at time zone tz)-(second_try at time zone 'UTC'));
  return (case when third_try=second_try then second_try else greatest(first_try,second_try) end)
    +make_interval(secs=>substring(r->>'time',7,2)::integer);
end $$;
create function allrice_ordinary_monthly_next(r jsonb, after_at timestamptz) returns timestamptz language plpgsql stable strict as $$
declare m date; result timestamptz;
begin
  if not allrice_ordinary_monthly_rule_valid(r) then raise exception 'invalid ordinary monthly rule' using errcode='23514'; end if;
  m:=date_trunc('month',(after_at-make_interval(secs=>substring(r->>'time',7,2)::integer)) at time zone (r->>'timezone'))::date;
  result:=allrice_ordinary_monthly_target(r,m);
  if result>after_at then return result; end if;
  result:=allrice_ordinary_monthly_target(r,(m+interval '1 month')::date);
  if result>after_at then return result; end if;
  raise exception 'ordinary monthly target bound exceeded' using errcode='23514';
end $$;
create function allrice_ordinary_monthly_latest(r jsonb, at_time timestamptz) returns timestamptz language plpgsql stable strict as $$
declare target timestamptz; latest timestamptz;
begin
  target:=allrice_ordinary_monthly_next(r,at_time-interval '1536 hours');
  for i in 1..4 loop
    if target>at_time then
      if latest is not null then return latest; end if;
      exit;
    end if;
    latest:=target;
    target:=allrice_ordinary_monthly_next(r,target);
  end loop;
  raise exception 'ordinary monthly latest target bound exceeded' using errcode='23514';
end $$;

create function allrice_ordinary_monthly_scope_proved(automation uuid) returns boolean language sql as $$
select exists(select 1 from allrice_automations a
  join allrice_native_recurring_controls c on c.automation_id=a.id
  join allrice_native_once_partitions partition on partition.partition_id=c.partition_id
    and partition.reference=c.immutable_identity->'reference'
  where a.id=$1 and a.clock_owner='native_recurring' and a.trigger_type='schedule'
    and a.quality_binding is null and a.experience_binding is null and a.conversation_mode='reuse'
    and a.schedule->>'frequency'='native_recurring' and a.schedule->'rule'->>'kind'='monthly'
    and c.partition_id='allrice-recurring-v1' and c.native_task_id is null
    and c.immutable_identity->>'kind'='calendar' and c.immutable_identity->>'binding'='rotating-at-v1'
    and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1'
    and a.organization_id::text=c.immutable_identity->>'organizationId'
    and a.workspace_id::text=c.immutable_identity->>'workspaceId' and a.owner_id::text=c.immutable_identity->>'ownerId'
    and a.employee_assignment_id::text=c.immutable_identity->'dispatch'->>'employeeAssignmentId'
    and a.session_id::text=c.immutable_identity->'dispatch'->>'businessSessionId')
$$;
create function allrice_ordinary_monthly_authorized(automation uuid) returns boolean language sql as $$
select exists(select 1 from allrice_automations a
  join allrice_native_recurring_controls c on c.automation_id=a.id
  join allrice_users u on u.id=a.owner_id and u.status='active'
  join allrice_organizations org on org.id=a.organization_id and org.archived_at is null
  join allrice_workspaces w on w.id=a.workspace_id and w.organization_id=org.id and w.archived_at is null
  join allrice_employee_assignments x on x.id=a.employee_assignment_id and x.organization_id=org.id
    and x.workspace_id=w.id and x.user_id=u.id and x.active
  join allrice_employees e on e.id=x.employee_id and e.organization_id=x.organization_id and e.workspace_id=x.workspace_id
    and e.status='active' and e.employee_key not like 'platform-%'
  join allrice_employee_instances i on i.id=(c.immutable_identity->'dispatch'->>'employeeInstanceId')::uuid
    and i.assignment_id=x.id and i.organization_id=org.id and i.workspace_id=w.id and i.owner_id=u.id and i.archived_at is null
  join allrice_chat_sessions s on s.id=a.session_id and s.employee_assignment_id=x.id
    and coalesce(s.employee_instance_id,s.employee_assignment_id)=i.id
    and s.organization_id=org.id and s.workspace_id=w.id and s.owner_id=u.id and s.archived_at is null
  left join allrice_member_work_automation work on work.organization_id=org.id and work.workspace_id=w.id and work.user_id=u.id
  where a.id=$1 and allrice_ordinary_monthly_scope_proved(a.id)
    and coalesce(work.settings->'cloud','true'::jsonb)='true'::jsonb
    and exists(select 1 from allrice_memberships m where m.user_id=u.id and m.organization_id=org.id and m.active
      and m.role in ('admin','member') and (m.workspace_id is null or m.workspace_id=w.id))
    and not exists(select 1 from allrice_platform_employee_tenant_assignments t where t.organization_id=x.organization_id
      and t.workspace_id=x.workspace_id and t.tenant_employee_id=x.employee_id and not t.active))
$$;
create function allrice_ordinary_monthly_version_proved(automation uuid, version bigint) returns boolean language sql as $$
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
      join allrice_native_recurring_versions old on old.automation_id=v.automation_id and old.revision=v.revision-1
      where op.automation_id=v.automation_id and op.organization_id=a.organization_id and op.owner_id=a.owner_id
        and op.status in ('pending','applied') and (op.request->>'expectedRevision')::bigint=v.revision-1
        and op.request->>'action' in ('update','pause','resume','delete')
        and op.created_at<=(v.configuration->>'acceptedAt')::timestamptz
        and ((op.request->>'action'='update' and op.request->'rule'=v.configuration->'rule'
          and v.business_content=jsonb_build_object('name',op.request->'name','prompt',op.request->'prompt'))
          or (op.request->>'action'<>'update' and v.business_content=old.business_content
            and v.configuration->'rule'=old.configuration->'rule')))))
$$;

-- One accepted create intent. Resuming or editing uses an immutable operation
-- and a new revision even when its next business P has the same wall time.
create unique index native_monthly_one_request_plan on allrice_native_calendar_plans(automation_id)
  where plan->'cause'->>'kind'='request';
create function allrice_ordinary_monthly_plan_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_plans p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_automations a on a.id=p.automation_id
  where p.period_id=$1 and allrice_ordinary_monthly_version_proved(a.id,p.revision)
    and p.plan->>'revisionDigest'=allrice_native_control_document_digest(v.configuration)
    and allrice_ordinary_monthly_next(v.configuration->'rule',p.business_scheduled_for-interval '1 millisecond')=p.business_scheduled_for
    and ((p.closed_decision_id is null and a.native_recurring_revision=p.revision and a.revision=p.revision
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
create function allrice_ordinary_monthly_clock_proved(automation uuid) returns boolean language sql as $$
select exists(select 1 from allrice_automations a
  join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=a.native_recurring_revision
  where a.id=$1 and allrice_ordinary_monthly_version_proved(a.id,v.revision) and a.revision=v.revision
    and v.business_content=jsonb_build_object('name',a.name,'prompt',a.prompt)
    and a.schedule=jsonb_build_object('frequency','native_recurring','rule',v.configuration->'rule')
    and ((a.status='enabled' and a.deleted_at is null and exists(select 1 from allrice_native_calendar_plans p
      where p.automation_id=a.id and p.revision=v.revision and p.closed_decision_id is null
        and p.business_scheduled_for=a.next_run_at and allrice_ordinary_monthly_plan_proved(p.period_id)))
      or ((a.status<>'enabled' or a.deleted_at is not null) and a.next_run_at is null
        and not exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id and p.closed_decision_id is null))))
$$;
create function allrice_ordinary_monthly_clock_fence() returns trigger language plpgsql as $$
begin
  if ((new.clock_owner='native_recurring' and new.schedule->>'frequency'='native_recurring'
      and new.schedule->'rule'->>'kind'='monthly') or exists(select 1 from allrice_native_recurring_controls c
      where c.automation_id=new.id and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1'))
    and not allrice_ordinary_monthly_clock_proved(new.id) then
    raise exception 'ordinary monthly lacks exact scoped immutable version/plan' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger ordinary_monthly_clock_fence after insert or update on allrice_automations
  deferrable initially deferred for each row execute function allrice_ordinary_monthly_clock_fence();

create function allrice_ordinary_monthly_version_fence() returns trigger language plpgsql as $$
begin
  if new.configuration->>'consumer'='ordinary-monthly-v1'
    and allrice_ordinary_monthly_version_proved(new.automation_id,new.revision) is not true then
    raise exception 'ordinary monthly content/revision lacks exact immutable accepted intent' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger ordinary_monthly_version_fence after insert on allrice_native_recurring_versions
  deferrable initially deferred for each row execute function allrice_ordinary_monthly_version_fence();

create function allrice_ordinary_monthly_message(v jsonb, business_p timestamptz) returns text language sql immutable as $$
select case when allrice_native_calendar_utf16_length(message)<=40000 then message else v->>'prompt' end from (
  select '这项周期任务本期已经到期，请现在执行原始要求中的工作。'||chr(10)||
    '本轮只执行工作，不要再次创建或修改周期任务。'||chr(10)||
    '本期计划时间：'||to_char(business_p at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||chr(10)||
    '原始要求：'||chr(10)||(v->>'prompt') message
) s
$$;
-- Historical proof deliberately does not require today's policy/revision or
-- queued status. An exact already queued Run survives later edits and remains
-- subject to the original claim/admission and execution gates.
create function allrice_ordinary_monthly_handoff_proved(occurrence uuid) returns boolean language sql as $$
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
    and ar.scheduled_for=p.business_scheduled_for and ar.experience_occurrence is null and ar.session_id=a.session_id
    and er.execution_snapshot->'instance'->>'id'=c.immutable_identity->'dispatch'->>'employeeInstanceId'
    and m.client_message_id=o.client_message_id and m.content->>'text'=allrice_ordinary_monthly_message(v.business_content,p.business_scheduled_for)
    and er.prompt_snapshot->>'userRequest'=m.content->>'text'
    and o.business_binding=jsonb_build_object('consumer','ordinary-monthly-v1','periodId',p.period_id::text,
      'decisionId',d.decision_id::text,'automationRunId',ar.id::text,'contentDigest',v.business_content_digest,
      'runId',r.id::text,'jobId',j.id::text,'organizationId',a.organization_id::text,'workspaceId',a.workspace_id::text,
      'ownerId',a.owner_id::text,'sessionId',a.session_id::text,'employeeAssignmentId',a.employee_assignment_id::text,
      'employeeInstanceId',c.immutable_identity->'dispatch'->>'employeeInstanceId','clientMessageId',o.client_message_id::text,
      'payloadDigest',o.payload_digest,'snapshotDigest',allrice_native_control_document_digest(er.execution_snapshot),
      'userMessageId',er.user_message_id::text,'assistantMessageId',er.assistant_message_id::text,'employeeVersionId',er.employee_version_id::text))
$$;

create function allrice_ordinary_monthly_decision_proved(id uuid) returns boolean language plpgsql as $$
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
        and (op.request->>'expectedRevision')::bigint=p.revision and d.revision=p.revision+1
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

-- Original experience validators are retained as explicit strict branches.
create function allrice_experience_calendar_control_valid(c jsonb) returns boolean language sql immutable as $$
select (jsonb_typeof(c)='object' and c=jsonb_build_object(
  'kind',c->'kind','binding',c->'binding','partitionId',c->'partitionId','controlId',c->'controlId',
  'organizationId',c->'organizationId','workspaceId',c->'workspaceId','ownerId',c->'ownerId',
  'automationId',c->'automationId','revision',c->'revision','controlSessionId',c->'controlSessionId',
  'sessionState',c->'sessionState','nativeTaskId',c->'nativeTaskId','dispatch',c->'dispatch','reference',c->'reference')
  and c->>'kind'='calendar' and c->>'binding'='rotating-at-v1'
  and c->>'partitionId'='allrice-recurring-v1'
  and jsonb_typeof(c->'controlId')='string' and (c->>'controlId')::uuid is not null
  and jsonb_typeof(c->'organizationId')='string' and (c->>'organizationId')::uuid is not null
  and jsonb_typeof(c->'workspaceId')='string' and (c->>'workspaceId')::uuid is not null
  and jsonb_typeof(c->'ownerId')='string' and (c->>'ownerId')::uuid is not null
  and jsonb_typeof(c->'automationId')='string' and (c->>'automationId')::uuid is not null
  and jsonb_typeof(c->'revision')='number' and (c->>'revision')::bigint between 1 and 9007199254740991
  and jsonb_typeof(c->'controlSessionId')='string' and length(c->>'controlSessionId') between 1 and 512
  and c->>'sessionState' in ('reserved','initializing','ready') and c->'nativeTaskId'='null'::jsonb
  and c->'reference'=jsonb_build_object('artifactId',c->'reference'->'artifactId',
    'profileId','allrice-recurring-control-v1','storageId',c->'reference'->'storageId','stateRoot',c->'reference'->'stateRoot')
  and jsonb_typeof(c->'reference'->'artifactId')='string' and length(c->'reference'->>'artifactId') between 1 and 512
  and jsonb_typeof(c->'reference'->'storageId')='string' and length(c->'reference'->>'storageId') between 1 and 512
  and jsonb_typeof(c->'reference'->'stateRoot')='string' and length(c->'reference'->>'stateRoot') between 1 and 512
  and c->'dispatch'=jsonb_build_object('consumer','experience-consolidation-v1',
    'employeeAssignmentId',c->'dispatch'->'employeeAssignmentId','employeeInstanceId',c->'dispatch'->'employeeInstanceId')
  and jsonb_typeof(c->'dispatch'->'employeeAssignmentId')='string'
  and (c->'dispatch'->>'employeeAssignmentId')::uuid is not null
  and jsonb_typeof(c->'dispatch'->'employeeInstanceId')='string'
  and (c->'dispatch'->>'employeeInstanceId')::uuid is not null) is true
$$;

create function allrice_experience_calendar_revision_valid(v jsonb) returns boolean language sql immutable as $$
select (jsonb_typeof(v)='object' and v=jsonb_build_object(
  'kind',v->'kind','binding',v->'binding','consumer',v->'consumer','revision',v->'revision',
  'schedule',v->'schedule','ruleRevision',v->'ruleRevision','policyRevision',v->'policyRevision',
  'policyDigest',v->'policyDigest','reservationDigest',v->'reservationDigest','acceptedAt',v->'acceptedAt')
  and v->>'kind'='calendar' and v->>'binding'='rotating-at-v1' and v->>'consumer'='experience-consolidation-v1'
  and jsonb_typeof(v->'revision')='number' and (v->>'revision')::bigint between 1 and 9007199254740991
  and jsonb_typeof(v->'ruleRevision')='number' and (v->>'ruleRevision')::bigint between 1 and 9007199254740991
  and jsonb_typeof(v->'policyRevision')='number' and (v->>'policyRevision')::bigint between 1 and 9007199254740991
  and v->>'policyDigest' ~ '^sha256:[a-f0-9]{64}$' and v->>'reservationDigest' ~ '^sha256:[a-f0-9]{64}$'
  and jsonb_typeof(v->'acceptedAt')='string'
  and v->>'acceptedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  and (v->>'acceptedAt')::timestamptz is not null
  and jsonb_typeof(v->'schedule')='object' and v->'schedule'->>'frequency' in ('daily','weekly','monthly')
  and not exists(select 1 from jsonb_object_keys(v->'schedule') k where k not in ('frequency','runAt','time','weekday','monthDay','timezone'))
  and v->'schedule'->>'time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  and jsonb_typeof(v->'schedule'->'timezone')='string' and length(v->'schedule'->>'timezone') between 1 and 64
  and (not (v->'schedule' ? 'runAt') or (jsonb_typeof(v->'schedule'->'runAt')='string'
    and (v->'schedule'->>'runAt')::timestamptz is not null))
  and (not (v->'schedule' ? 'weekday') or (jsonb_typeof(v->'schedule'->'weekday')='number'
    and (v->'schedule'->>'weekday')::integer between 0 and 6))
  and (not (v->'schedule' ? 'monthDay') or (jsonb_typeof(v->'schedule'->'monthDay')='number'
    and (v->'schedule'->>'monthDay')::integer between 1 and 31))
  and (v->'schedule'->>'frequency'<>'weekly' or (jsonb_typeof(v->'schedule'->'weekday')='number'
    and (v->'schedule'->>'weekday')::integer between 0 and 6))
  and (v->'schedule'->>'frequency'<>'monthly' or (jsonb_typeof(v->'schedule'->'monthDay')='number'
    and (v->'schedule'->>'monthDay')::integer between 1 and 31))) is true
$$;

create function allrice_ordinary_monthly_control_valid(c jsonb) returns boolean language sql immutable as $$
select (jsonb_typeof(c)='object' and c=jsonb_build_object(
  'kind',c->'kind','binding',c->'binding','partitionId',c->'partitionId','controlId',c->'controlId',
  'organizationId',c->'organizationId','workspaceId',c->'workspaceId','ownerId',c->'ownerId',
  'automationId',c->'automationId','revision',c->'revision','controlSessionId',c->'controlSessionId',
  'sessionState',c->'sessionState','nativeTaskId',c->'nativeTaskId','dispatch',c->'dispatch','reference',c->'reference')
  and c->>'kind'='calendar' and c->>'binding'='rotating-at-v1'
  and c->>'partitionId'='allrice-recurring-v1'
  and jsonb_typeof(c->'controlId')='string' and (c->>'controlId')::uuid is not null
  and jsonb_typeof(c->'organizationId')='string' and (c->>'organizationId')::uuid is not null
  and jsonb_typeof(c->'workspaceId')='string' and (c->>'workspaceId')::uuid is not null
  and jsonb_typeof(c->'ownerId')='string' and (c->>'ownerId')::uuid is not null
  and jsonb_typeof(c->'automationId')='string' and (c->>'automationId')::uuid is not null
  and jsonb_typeof(c->'revision')='number' and (c->>'revision')::bigint between 1 and 9007199254740991
  and jsonb_typeof(c->'controlSessionId')='string' and length(c->>'controlSessionId') between 1 and 512
  and c->>'sessionState' in ('reserved','initializing','ready') and c->'nativeTaskId'='null'::jsonb
  and c->'reference'=jsonb_build_object('artifactId',c->'reference'->'artifactId',
    'profileId','allrice-recurring-control-v1','storageId',c->'reference'->'storageId','stateRoot',c->'reference'->'stateRoot')
  and jsonb_typeof(c->'reference'->'artifactId')='string' and length(c->'reference'->>'artifactId') between 1 and 512
  and jsonb_typeof(c->'reference'->'storageId')='string' and length(c->'reference'->>'storageId') between 1 and 512
  and jsonb_typeof(c->'reference'->'stateRoot')='string' and length(c->'reference'->>'stateRoot') between 1 and 512
  and c->'dispatch'=jsonb_build_object('consumer','ordinary-monthly-v1',
    'employeeAssignmentId',c->'dispatch'->'employeeAssignmentId','employeeInstanceId',c->'dispatch'->'employeeInstanceId',
    'businessSessionId',c->'dispatch'->'businessSessionId')
  and jsonb_typeof(c->'dispatch'->'businessSessionId')='string'
  and (c->'dispatch'->>'businessSessionId')::uuid is not null
  and (c->>'revision')::numeric=trunc((c->>'revision')::numeric)
  and jsonb_typeof(c->'dispatch'->'employeeAssignmentId')='string'
  and (c->'dispatch'->>'employeeAssignmentId')::uuid is not null
  and jsonb_typeof(c->'dispatch'->'employeeInstanceId')='string'
  and (c->'dispatch'->>'employeeInstanceId')::uuid is not null) is true
$$;

create function allrice_experience_calendar_plan_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_plans p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_automations a on a.id=p.automation_id and a.clock_owner='native_recurring'
  where p.period_id=$1 and p.plan->'cause'->>'kind' in ('handoff','policy','successor')
    and allrice_experience_calendar_control_valid(c.snapshot->'control')
    and allrice_experience_calendar_revision_valid(v.configuration)
    and p.plan->>'revisionDigest'=allrice_native_control_document_digest(v.configuration)
    and c.native_task_id is null and c.snapshot->'control'->'dispatch'->>'consumer'='experience-consolidation-v1'
    and a.organization_id::text=c.immutable_identity->>'organizationId'
    and a.workspace_id::text=c.immutable_identity->>'workspaceId'
    and a.owner_id::text=c.immutable_identity->>'ownerId'
    and a.employee_assignment_id::text=c.immutable_identity->'dispatch'->>'employeeAssignmentId'
    and a.experience_binding->>'instanceId'=c.immutable_identity->'dispatch'->>'employeeInstanceId'
    and ((p.closed_decision_id is null and a.native_recurring_revision=p.revision
      and a.status='enabled' and a.deleted_at is null and a.next_run_at=p.business_scheduled_for
      and a.schedule=v.configuration->'schedule'
      and a.experience_binding->>'policyDigest'=v.configuration->>'policyDigest')
      or exists(select 1 from allrice_native_calendar_decisions d where d.decision_id=p.closed_decision_id and d.period_id=p.period_id))
    and (p.plan->'cause'->>'kind'<>'successor' or exists(
      select 1 from allrice_native_calendar_decisions d join allrice_native_calendar_plans previous on previous.period_id=d.period_id
      where d.period_id=(p.plan->'cause'->>'predecessorPeriodId')::uuid and d.successor_period_id=p.period_id
        and previous.control_id=p.control_id and previous.automation_id=p.automation_id and previous.revision=p.revision
        and p.created_at=d.decided_at and p.business_scheduled_for>d.decided_at
        and p.business_scheduled_for>previous.business_scheduled_for)))
$$;

-- Strict explicit union; unknown consumers are rejected. Fixed validators are
-- never routed through this calendar rule/dispatch schema.
create or replace function allrice_native_calendar_control_valid(c jsonb) returns boolean language sql immutable as $$
select case c->'dispatch'->>'consumer'
  when 'experience-consolidation-v1' then allrice_experience_calendar_control_valid(c)
  when 'ordinary-monthly-v1' then allrice_ordinary_monthly_control_valid(c)
  else false end
$$;
create or replace function allrice_native_calendar_revision_valid(v jsonb) returns boolean language sql stable as $$
select case v->>'consumer'
  when 'experience-consolidation-v1' then allrice_experience_calendar_revision_valid(v)
  when 'ordinary-monthly-v1' then allrice_ordinary_monthly_revision_valid(v)
  else false end
$$;
create or replace function allrice_native_calendar_plan_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_plans p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  where p.period_id=$1 and case c.immutable_identity->'dispatch'->>'consumer'
    when 'experience-consolidation-v1' then allrice_experience_calendar_plan_proved(p.period_id)
    when 'ordinary-monthly-v1' then allrice_ordinary_monthly_plan_proved(p.period_id)
    else false end)
$$;
create function allrice_native_calendar_business_handoff_proved(occurrence uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_recurring_occurrences o where o.occurrence_id=$1
  and case o.payload->'control'->'dispatch'->>'consumer'
    when 'experience-consolidation-v1' then allrice_experience_calendar_handoff_proved(o.occurrence_id)
    when 'ordinary-monthly-v1' then allrice_ordinary_monthly_handoff_proved(o.occurrence_id)
    else false end)
$$;

-- Keep existing native journal/provenance/COMMIT fences; add explicit consumer proof.
create or replace function allrice_native_calendar_parent_commit_fence() returns trigger language plpgsql as $$
begin
  if new.snapshot->'control'->>'kind'<>'calendar' then return new; end if;
  if not exists(select 1 from allrice_native_once_partitions p
    where p.partition_id=new.partition_id and p.reference=new.snapshot->'control'->'reference') then
    raise exception 'calendar approved parent reference changed' using errcode='23514';
  end if;
  if not exists(select 1 from allrice_native_recurring_versions v
    where v.automation_id=new.automation_id and v.revision=(new.snapshot->'control'->>'revision')::bigint
      and allrice_native_calendar_revision_valid(v.configuration)
      and v.configuration->>'consumer'=new.snapshot->'control'->'dispatch'->>'consumer') then
    raise exception 'calendar parent lacks exact immutable revision' using errcode='23514';
  end if;
  if new.calendar_last_write_id is not null and not exists(
    select 1 from allrice_native_recurring_journal j where j.partition_id=new.partition_id
      and j.control_id=new.control_id and j.write_id=new.calendar_last_write_id and j.after_snapshot=new.snapshot
      and j.mutation->>'kind'='calendar' and j.mutation->>'action' in ('session_initializing','session_ready','apply_revision')
      and (j.mutation->>'expectedControlVersion')::bigint=new.snapshot_version-1) then
    raise exception 'calendar parent control journal COMMIT proof lost' using errcode='23514';
  end if;
  return new;
end $$;

create or replace function allrice_native_calendar_period_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_periods p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_native_calendar_arms a on a.arm_id=p.current_arm_id and a.period_id=p.period_id
  where p.period_id=id and allrice_native_calendar_control_valid(c.snapshot->'control')
    and allrice_native_calendar_revision_valid(v.configuration)
    and v.configuration->>'consumer'=c.immutable_identity->'dispatch'->>'consumer'
    and p.revision<=(c.snapshot->'control'->>'revision')::bigint
    and (a.reason<>'business_target' or a.native_at=p.business_scheduled_for)
    and ((p.state='prepared' and a.status in ('prepared','creating')) or (p.state='recovery_required' and a.status='absent')
      or (p.state='bound' and a.status='bound') or (p.state='received' and a.status='received'))
    and not exists(select 1 from allrice_native_calendar_arms other where other.period_id=p.period_id
      and other.arm_id<>a.arm_id and other.status<>'absent')
    and (a.native_task_id is null or (allrice_native_calendar_task_valid(a.task_snapshot,c.control_session_id,a.native_at,a.native_task_id)
      and a.task_snapshot->>'status'=case when a.status='received' then 'inactive' else 'active' end)))
$$;

create or replace function allrice_native_calendar_decision_fence() returns trigger language plpgsql as $$
declare p allrice_native_calendar_plans; a allrice_automations;
  global_count bigint; org_count bigint; instance_count bigint;
begin
  select * into p from allrice_native_calendar_plans where period_id=new.period_id;
  select * into a from allrice_automations where id=p.automation_id;
  if exists(select 1 from allrice_native_recurring_controls c where c.partition_id=p.partition_id
    and c.control_id=p.control_id and c.automation_id=p.automation_id
    and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1') then
    if allrice_ordinary_monthly_decision_proved(new.decision_id) is not true then
      raise exception 'ordinary monthly decision lacks exact original business/lease/operation proof' using errcode='P1921';
    end if;
    return new;
  end if;
  if new.kind='operation' or new.outcome='coalesced' then
    raise exception 'experience calendar decision cannot use ordinary monthly outcomes' using errcode='23514';
  end if;
  if not exists(select 1 from allrice_native_calendar_plans q
    join allrice_native_recurring_controls c on c.partition_id=q.partition_id and c.control_id=q.control_id
    where q.period_id=new.period_id and q.closed_decision_id=new.decision_id
      and c.automation_id=a.id and c.immutable_identity->'dispatch'->>'consumer'='experience-consolidation-v1'
      and c.immutable_identity->>'organizationId'=a.organization_id::text
      and c.immutable_identity->>'workspaceId'=a.workspace_id::text
      and c.immutable_identity->>'ownerId'=a.owner_id::text) then
    raise exception 'calendar decision lacks immutable original scope' using errcode='23514';
  end if;
  if new.kind='receipt' then
    if not exists(select 1 from allrice_native_recurring_occurrences o
      join allrice_native_calendar_periods np on np.period_id=o.calendar_period_id and np.plan_id=p.period_id
      join allrice_native_calendar_arms arm on arm.arm_id=o.calendar_arm_id and arm.period_id=np.period_id
      where o.occurrence_id=new.occurrence_id and o.automation_id=p.automation_id and o.revision=p.revision
        and new.revision=p.revision and np.business_scheduled_for=p.business_scheduled_for
        and np.business_decision_id=new.decision_id and np.state='received' and arm.status='received'
        and o.scheduled_at=arm.native_at and o.payload->>'nativeTaskId'=arm.native_task_id
        and o.payload->>'businessScheduledFor'=p.plan->>'businessScheduledFor'
        and o.outbox_owner_id::text=new.decision->'lease'->>'ownerId'
        and o.outbox_epoch=(new.decision->'lease'->>'epoch')::bigint
        and o.outbox_token_digest=new.decision->'lease'->>'tokenDigest'
        and o.outbox_expires_at>clock_timestamp()) then
      raise exception 'calendar decision receipt COMMIT lease lost' using errcode='P1921';
    end if;
    if new.outcome in ('queued','empty','already_claimed') and not exists(
      select 1 from allrice_automation_runs r where r.id=new.automation_run_id
        and r.automation_id=a.id and r.organization_id=a.organization_id and r.workspace_id=a.workspace_id
        and r.scheduled_for=p.business_scheduled_for and r.experience_occurrence is not null
        and r.experience_occurrence->>'ownerId'=a.owner_id::text
        and r.experience_occurrence->>'instanceId'=a.experience_binding->>'instanceId'
        and r.experience_occurrence->>'assignmentId'=a.employee_assignment_id::text
        and (new.outcome='already_claimed' or r.native_recurring_occurrence_id=new.occurrence_id)
        and (new.outcome<>'empty' or (r.status='succeeded' and r.run_id is null
          and jsonb_array_length(r.experience_occurrence->'sources')=0 and r.error_code='EXPERIENCE_NO_NEW_EVIDENCE'))
        and (new.outcome<>'queued' or (r.status='queued' and jsonb_array_length(r.experience_occurrence->'sources')>0))) then
      raise exception 'calendar decision lacks exact original experience Run' using errcode='23514';
    end if;
    if new.outcome in ('queued','empty','already_claimed')
      and not allrice_experience_calendar_handoff_proved(new.occurrence_id) then
      raise exception 'calendar decision lacks terminal outbox business binding' using errcode='23514';
    end if;
    if new.outcome in ('budget','authority_blocked') and not exists(select 1 from allrice_native_recurring_occurrences o
      where o.occurrence_id=new.occurrence_id and o.outbox_state='blocked' and o.business_binding is null
        and (new.outcome<>'budget' or o.outbox_reason='EXPERIENCE_DAILY_BUDGET')) then
      raise exception 'calendar blocked decision lacks terminal outbox' using errcode='23514';
    end if;
    if new.outcome='budget' then
      select count(*),count(*) filter(where organization_id=a.organization_id),
        count(*) filter(where experience_occurrence->>'instanceId'=a.experience_binding->>'instanceId')
        into global_count,org_count,instance_count from allrice_automation_runs
        where experience_occurrence is not null and jsonb_array_length(experience_occurrence->'sources')>0
          and created_at>clock_timestamp()-interval '24 hours';
      if (new.decision->'budget'=jsonb_build_object('globalCount',global_count,'organizationCount',org_count,'instanceCount',instance_count)
        and (global_count>=64 or org_count>=8 or instance_count>=1)) is not true then
        raise exception 'calendar budget decision lacks original budget proof' using errcode='23514';
      end if;
    end if;
  elsif new.kind='policy' then
    if (a.revision=new.revision and a.native_recurring_revision=new.revision and a.revision>p.revision
      and exists(select 1 from allrice_native_recurring_versions current_version
        join allrice_native_recurring_versions previous_version on previous_version.automation_id=current_version.automation_id
          and previous_version.revision=p.revision
        where current_version.automation_id=a.id and current_version.revision=new.revision
          and (current_version.configuration->>'policyRevision')::bigint>
            (previous_version.configuration->>'policyRevision')::bigint)) is not true then
      raise exception 'calendar cancellation lacks current policy invalidation' using errcode='23514';
    end if;
  end if;
  if new.successor_period_id is not null and not exists(select 1 from allrice_native_calendar_plans successor
    where successor.period_id=new.successor_period_id and successor.partition_id=p.partition_id
      and successor.control_id=p.control_id and successor.automation_id=p.automation_id and successor.revision=p.revision
      and successor.plan->'cause'=jsonb_build_object('kind','successor','predecessorPeriodId',p.period_id::text)
      and successor.created_at=new.decided_at and successor.business_scheduled_for>new.decided_at
      and successor.business_scheduled_for>p.business_scheduled_for) then
    raise exception 'calendar decision lacks exact same-parent successor plan' using errcode='23514';
  end if;
  if new.kind='authority' or new.outcome='authority_blocked' then
    -- status is deliberately absent: this decision's own pause write is not
    -- independent evidence that the original authority was revoked.
    if a.deleted_at is null and a.revision=p.revision and exists(
      select 1 from allrice_users u join allrice_organizations o on o.id=a.organization_id and o.archived_at is null
      join allrice_workspaces w on w.id=a.workspace_id and w.organization_id=o.id and w.archived_at is null
      join allrice_employee_assignments x on x.id=a.employee_assignment_id and x.user_id=u.id and x.active
      join allrice_employees e on e.id=x.employee_id and e.status='active'
      join allrice_employee_instances i on i.id=(a.experience_binding->>'instanceId')::uuid and i.assignment_id=x.id
        and i.organization_id=a.organization_id and i.workspace_id=a.workspace_id and i.owner_id=a.owner_id and i.archived_at is null
      where u.id=a.owner_id and u.status='active'
        and exists(select 1 from allrice_memberships m where m.user_id=u.id and m.organization_id=o.id
          and m.active and m.role in ('member','admin') and (m.workspace_id is null or m.workspace_id=w.id))
        and not exists(select 1 from allrice_platform_employee_tenant_assignments t where t.organization_id=x.organization_id
          and t.workspace_id=x.workspace_id and t.tenant_employee_id=x.employee_id and not t.active)) then
      raise exception 'calendar authority cancellation lacks actual revocation' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

create or replace function allrice_native_calendar_no_business_run() returns trigger language plpgsql as $$
begin
  if new.native_recurring_occurrence_id is not null and exists(select 1 from allrice_native_recurring_occurrences o
    where o.occurrence_id=new.native_recurring_occurrence_id and o.calendar_period_id is not null) then
    if exists(select 1 from allrice_native_recurring_occurrences o
      where o.occurrence_id=new.native_recurring_occurrence_id and o.payload->'control'->'dispatch'->>'consumer'='ordinary-monthly-v1') then
      if allrice_ordinary_monthly_handoff_proved(new.native_recurring_occurrence_id) is not true then
        raise exception 'ordinary monthly Run lacks exact frozen original chat handoff' using errcode='P1921';
      end if;
      if tg_op='INSERT' and (new.status<>'queued' or not allrice_ordinary_monthly_authorized(new.automation_id)
        or not exists(select 1 from allrice_native_recurring_occurrences o
          where o.occurrence_id=new.native_recurring_occurrence_id and o.outbox_owner_id is not null
            and o.outbox_epoch>0 and o.outbox_token_digest is not null and o.outbox_expires_at>clock_timestamp())) then
        raise exception 'ordinary monthly Run birth COMMIT authority/lease lost' using errcode='P1921';
      end if;
      return new;
    end if;
    if not allrice_experience_calendar_handoff_proved(new.native_recurring_occurrence_id) then
      raise exception 'calendar business Run lacks original experience handoff' using errcode='P1921';
    end if;
    if tg_op='INSERT' and not exists(select 1 from allrice_native_recurring_occurrences o
      where o.occurrence_id=new.native_recurring_occurrence_id and o.outbox_owner_id is not null and o.outbox_epoch>0
        and o.outbox_token_digest is not null and o.outbox_expires_at>clock_timestamp()) then
      raise exception 'calendar business Run COMMIT lease expired' using errcode='P1921';
    end if;
    if tg_op='INSERT' then
      if not exists(select 1 from allrice_native_recurring_occurrences o
        join allrice_automations a on a.id=o.automation_id
        left join allrice_settings company on company.scope_type='organization' and company.scope_id=a.organization_id and company.key='employee_experience_policy'
        left join allrice_settings defaults on defaults.scope_type='system' and defaults.scope_id is null and defaults.key='employee_experience_policy'
        where o.occurrence_id=new.native_recurring_occurrence_id and new.experience_occurrence->'policy'=coalesce(company.value,defaults.value)
          and new.experience_occurrence->>'policyDigest'=o.payload->'revision'->>'policyDigest'
          and new.experience_occurrence->>'policyDigest'=allrice_native_control_document_digest(new.experience_occurrence->'policy')
          and jsonb_array_length(new.experience_occurrence->'sources') between 0 and 16
          and (new.native_root_origin is null or (new.native_root_origin->>'contextKind'='experience_consolidation'
            and new.native_root_origin->>'contextId'=new.id::text
            and new.native_root_origin->'frozenIdentity'->>'kind'='internal_recipe'
            and new.native_root_origin->'frozenIdentity'->>'checksum' ~ '^sha256:[a-f0-9]{64}$'
            and new.native_root_origin->>'rootSeed'='experience-'||new.id::text))) then
        raise exception 'calendar experience birth lacks frozen original policy/origin' using errcode='23514';
      end if;
      if (select count(*)<>count(distinct source->>'id') or coalesce(sum(allrice_native_calendar_utf16_length(source->>'excerpt')),0)>32000
        from jsonb_array_elements(new.experience_occurrence->'sources') source)
        or exists(select 1 from jsonb_array_elements(new.experience_occurrence->'sources') source where not exists(
          select 1 from allrice_experience_reviews e join allrice_memories m on m.id=e.memory_id and m.owner_id=e.owner_id
          join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id
          where e.memory_id::text=source->>'id' and e.run_id::text=source->>'runId'
            and e.session_id::text=source->>'sessionId' and e.message_id::text=source->>'messageId'
            and e.organization_id=new.organization_id and e.workspace_id=new.workspace_id
            and e.owner_id::text=new.experience_occurrence->>'ownerId' and e.instance_id::text=new.experience_occurrence->>'instanceId'
            and e.origin_kind='incremental' and e.status='pending' and e.consolidation_occurrence_id=new.id
            and e.source_excerpt=source->>'excerpt' and e.source_digest=source->>'sourceDigest' and e.evidence=source->'evidence'
            and m.lifecycle_state='candidate' and m.archived_at is null and s.archived_at is null)) then
        raise exception 'calendar experience birth lacks exact original incremental source pins' using errcode='23514';
      end if;
    end if;
  end if;
  return new;
end $$;

create or replace function allrice_native_calendar_occurrence_commit_fence() returns trigger language plpgsql as $$
begin
  if new.calendar_period_id is not null and not exists(select 1 from allrice_native_calendar_periods p
    join allrice_native_calendar_arms a on a.arm_id=new.calendar_arm_id and a.period_id=p.period_id
    join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id
    join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
    where p.period_id=new.calendar_period_id and p.state='received' and a.status='received'
      and new.scheduled_at=a.native_at and new.payload=jsonb_build_object('control',c.immutable_identity,
        'revision',v.configuration,'calendar',jsonb_build_object(
          'period',jsonb_build_object('periodId',p.period_id::text,'partitionId',p.partition_id,'controlId',p.control_id::text,
            'automationId',p.automation_id::text,'revision',p.revision,
            'businessScheduledFor',to_char(p.business_scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          'arm',jsonb_build_object('armId',a.arm_id::text,'periodId',p.period_id::text,'attempt',a.attempt,
            'nativeAt',to_char(a.native_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'reason',a.reason,'requestDigest',a.request_digest)),
        'businessScheduledFor',to_char(p.business_scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'nativeTaskId',a.native_task_id,'receipt',coalesce(a.task_snapshot->'deliveryHistory'->'records'->0,a.task_snapshot->'lastDelivery'))
      and exists(select 1 from allrice_native_recurring_journal j
        cross join lateral jsonb_array_elements(j.journal->'receiptLinks') l
        where j.partition_id=p.partition_id and j.control_id=p.control_id and j.mutation->>'kind'='calendar'
          and j.mutation->>'armId'=a.arm_id::text and j.mutation->>'periodId'=p.period_id::text
          and l->>'id'=new.occurrence_id::text and l->>'key'=new.occurrence_key and l->>'payloadDigest'=new.payload_digest)) then
    raise exception 'calendar occurrence/native provenance COMMIT proof lost' using errcode='23514';
  end if;
  if new.calendar_period_id is not null and new.outbox_state='enqueued'
    and not allrice_native_calendar_business_handoff_proved(new.occurrence_id) then
    raise exception 'calendar business handoff lacks exact explicit consumer proof' using errcode='P1921';
  end if;
  return new;
end $$;

create or replace function allrice_experience_calendar_dispatch_fence() returns trigger language plpgsql as $$
begin
  if new.outbox_state='enqueued' and (new.outbox_owner_id is null or new.outbox_epoch<1
    or new.outbox_token_digest is null or new.outbox_expires_at<=clock_timestamp()
    or not allrice_native_calendar_business_handoff_proved(new.occurrence_id)) then
    raise exception 'calendar explicit consumer dispatch COMMIT proof lost' using errcode='P1921';
  end if;
  return new;
end $$;

create or replace function allrice_native_calendar_period_plan_fence() returns trigger language plpgsql as $$
begin
  if exists(select 1 from allrice_automations a where a.id=new.automation_id and a.clock_owner='native_recurring'
    and (a.experience_binding is not null or exists(select 1 from allrice_native_recurring_controls c
      where c.automation_id=a.id and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1'))) and not exists(select 1 from allrice_native_calendar_plans p
      where p.period_id=new.plan_id and p.period_id=new.period_id and p.partition_id=new.partition_id and p.control_id=new.control_id
        and p.automation_id=new.automation_id and p.revision=new.revision and p.business_scheduled_for=new.business_scheduled_for
        and p.closed_decision_id is not distinct from new.business_decision_id) then
    raise exception 'calendar native period lacks exact business plan' using errcode='23514';
  end if;
  return new;
end $$;

-- Replace only the document/kind/outcome CHECKs. All original identity, FK,
-- immutable, journal, and writer lease constraints remain attached.
create function allrice_native_calendar_business_cause_valid(c jsonb) returns boolean language sql immutable as $$
select (c='{"kind":"handoff"}'::jsonb
  or (c=jsonb_build_object('kind','policy','policyRevision',c->'policyRevision')
    and jsonb_typeof(c->'policyRevision')='number' and (c->>'policyRevision')::numeric between 1 and 9007199254740991
    and (c->>'policyRevision')::numeric=trunc((c->>'policyRevision')::numeric))
  or (c=jsonb_build_object('kind','request','requestId',c->'requestId')
    and jsonb_typeof(c->'requestId')='string' and (c->>'requestId')::uuid is not null)
  or (c=jsonb_build_object('kind','operation','operationId',c->'operationId')
    and jsonb_typeof(c->'operationId')='string' and (c->>'operationId')::uuid is not null)
  or (c=jsonb_build_object('kind',c->>'kind','predecessorPeriodId',c->'predecessorPeriodId')
    and c->>'kind' in ('successor','coalesced') and jsonb_typeof(c->'predecessorPeriodId')='string'
    and (c->>'predecessorPeriodId')::uuid is not null)) is true
$$;
do $$
declare r record; count_plans integer:=0; count_decisions integer:=0;
begin
  for r in select conname from pg_constraint where conrelid='allrice_native_calendar_plans'::regclass and contype='c'
    and position('''cause''' in pg_get_expr(conbin,conrelid))>0 loop
    execute format('alter table allrice_native_calendar_plans drop constraint %I',r.conname);
    count_plans:=count_plans+1;
  end loop;
  for r in select conname from pg_constraint where conrelid='allrice_native_calendar_decisions'::regclass and contype='c'
    and (conname in ('allrice_native_calendar_decisions_kind_check','allrice_native_calendar_decisions_outcome_check')
      or position('''lease''' in pg_get_expr(conbin,conrelid))>0) loop
    execute format('alter table allrice_native_calendar_decisions drop constraint %I',r.conname);
    count_decisions:=count_decisions+1;
  end loop;
  if count_plans<>1 or count_decisions<>3 then
    raise exception 'expected exact calendar business document CHECKs' using errcode='23514';
  end if;
end $$;
alter table allrice_native_calendar_plans add constraint native_calendar_business_plan_document check ((
  plan=jsonb_build_object('periodId',period_id::text,'controlId',control_id::text,'automationId',automation_id::text,
    'revision',revision,'businessScheduledFor',to_char(business_scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'initialArmId',initial_arm_id::text,'revisionDigest',plan->>'revisionDigest',
    'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'cause',plan->'cause')
  and plan->>'revisionDigest' ~ '^sha256:[a-f0-9]{64}$' and date_trunc('milliseconds',created_at)=created_at
  and date_trunc('milliseconds',business_scheduled_for)=business_scheduled_for
  and allrice_native_calendar_business_cause_valid(plan->'cause')
  and (not (plan->'cause' ? 'predecessorPeriodId') or (plan->'cause'->>'predecessorPeriodId')::uuid<>period_id)
) is true);
create unique index native_monthly_one_operation_plan on allrice_native_calendar_plans(automation_id,((plan->'cause'->>'operationId')::uuid))
  where plan->'cause'->>'kind'='operation';
alter table allrice_native_calendar_decisions add constraint native_calendar_business_kind
  check(kind in ('receipt','policy','authority','operation')),
  add constraint native_calendar_business_outcome check(outcome in ('queued','empty','budget','already_claimed','coalesced','canceled','authority_blocked')),
  add constraint native_calendar_business_decision_document check ((
    decision=(jsonb_build_object('decisionId',decision_id::text,'periodId',period_id::text,'kind',kind,'outcome',outcome,
      'revision',revision,'decidedAt',to_char(decided_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'receiptOccurrenceId',occurrence_id::text,'automationRunId',automation_run_id::text,
      'successorPeriodId',successor_period_id::text,'lease',decision->'lease','budget',decision->'budget')
      ||case when kind='operation' then jsonb_build_object('operationId',decision->'operationId') else '{}'::jsonb end)
    and date_trunc('milliseconds',decided_at)=decided_at
    and ((kind='receipt')=(occurrence_id is not null)) and ((kind='receipt')=(decision->'lease'<>'null'::jsonb))
    and ((outcome in ('queued','empty','budget','already_claimed','coalesced'))=(successor_period_id is not null))
    and ((outcome in ('queued','empty','already_claimed'))=(automation_run_id is not null))
    and ((outcome='budget')=(decision->'budget'<>'null'::jsonb))
    and (outcome not in ('queued','empty','budget','already_claimed','coalesced') or kind='receipt')
    and (kind not in ('policy','operation') or outcome='canceled') and (kind<>'authority' or outcome='authority_blocked')
    and (kind<>'receipt' or outcome<>'canceled') and (successor_period_id is null or successor_period_id<>period_id)
    and (kind<>'operation' or (jsonb_typeof(decision->'operationId')='string' and (decision->>'operationId')::uuid is not null))
    and (kind<>'receipt' or (decision->'lease'=jsonb_build_object('ownerId',decision->'lease'->>'ownerId',
      'epoch',decision->'lease'->'epoch','tokenDigest',decision->'lease'->>'tokenDigest')
      and (decision->'lease'->>'ownerId')::uuid is not null and jsonb_typeof(decision->'lease'->'epoch')='number'
      and (decision->'lease'->>'epoch')::numeric between 1 and 9007199254740991
      and (decision->'lease'->>'epoch')::numeric=trunc((decision->'lease'->>'epoch')::numeric)
      and decision->'lease'->>'tokenDigest' ~ '^sha256:[a-f0-9]{64}$'))
    and (outcome<>'budget' or (decision->'budget'=jsonb_build_object('globalCount',decision->'budget'->'globalCount',
      'organizationCount',decision->'budget'->'organizationCount','instanceCount',decision->'budget'->'instanceCount')
      and (decision->'budget'->>'globalCount')::bigint>=0 and (decision->'budget'->>'organizationCount')::bigint>=0
      and (decision->'budget'->>'instanceCount')::bigint>=0 and ((decision->'budget'->>'globalCount')::bigint>=64
        or (decision->'budget'->>'organizationCount')::bigint>=8 or (decision->'budget'->>'instanceCount')::bigint>=1)))
  ) is true);

create function allrice_ordinary_monthly_operation_fence() returns trigger language plpgsql as $$
declare a allrice_automations; v allrice_native_recurring_versions; action text; target_revision bigint;
begin
  if not exists(select 1 from allrice_native_recurring_controls c where c.automation_id=new.automation_id
    and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1') then return new; end if;
  select * into a from allrice_automations where id=new.automation_id;
  action:=new.request->>'action';
  target_revision:=(new.request->>'expectedRevision')::bigint+1;
  if new.organization_id<>a.organization_id or new.owner_id<>a.owner_id
    or new.request_digest<>allrice_native_control_document_digest(jsonb_build_object('sessionId',a.session_id::text,
      'taskId',a.id::text,'input',new.request))
    or (new.status='rejected') is distinct from (new.error_message is not null)
    or action is null or action not in ('update','pause','resume','delete')
    or new.request<>(jsonb_build_object('operationId',new.operation_id::text,'expectedRevision',new.request->'expectedRevision','action',action)
      ||case when action='update' then jsonb_build_object('name',new.request->'name','prompt',new.request->'prompt','rule',new.request->'rule') else '{}'::jsonb end)
    or jsonb_typeof(new.request->'expectedRevision') is distinct from 'number'
    or (new.request->>'expectedRevision')::numeric not between 1 and 9007199254740990
    or (new.request->>'expectedRevision')::numeric<>trunc((new.request->>'expectedRevision')::numeric) then
    raise exception 'ordinary monthly operation lacks exact scoped request' using errcode='23514';
  end if;
  if new.status='rejected' then return new; end if;
  select * into v from allrice_native_recurring_versions where automation_id=a.id and revision=target_revision;
  if allrice_ordinary_monthly_version_proved(a.id,target_revision) is not true or a.native_recurring_revision<target_revision
    or exists(select 1 from allrice_native_recurring_operations other where other.automation_id=a.id
      and other.operation_id<>new.operation_id and other.status in ('pending','applied')
      and other.request->'expectedRevision'=new.request->'expectedRevision') then
    raise exception 'ordinary monthly operation lacks its unique accepted revision' using errcode='23514';
  end if;
  if new.status='pending' then return new; end if;
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
        and p.plan->'cause'=jsonb_build_object('kind','operation','operationId',new.operation_id::text)) then
      raise exception 'ordinary monthly operation lacks an actual bound successor Task' using errcode='23514';
    end if;
  elsif action='resume' or (action='update' and a.native_recurring_revision=target_revision and a.status='enabled')
    or exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id and p.revision<target_revision and p.closed_decision_id is null) then
    raise exception 'ordinary monthly paused operation leaves active or missing intent' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger ordinary_monthly_operation_fence after insert or update on allrice_native_recurring_operations
  deferrable initially deferred for each row execute function allrice_ordinary_monthly_operation_fence();
