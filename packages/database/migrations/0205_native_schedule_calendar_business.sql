-- Business P and its decision are independent of the immutable native Task
-- journal. Web writes an accepted plan; only a real live writer materializes it.
-- PR504 had no enabled producer. Never reinterpret a persisted old receipt.
do $$ begin
  if exists(select 1 from allrice_native_recurring_controls where snapshot->'control'->>'kind'='calendar')
    or exists(select 1 from allrice_native_calendar_periods)
    or exists(select 1 from allrice_native_recurring_occurrences where calendar_period_id is not null) then
    raise exception 'calendar runtime upgrade requires verified zero existing calendar production rows' using errcode='23514';
  end if;
end $$;
create table allrice_native_calendar_plans (
  period_id uuid primary key,
  partition_id text not null check(partition_id='allrice-recurring-v1'),
  control_id uuid not null,
  automation_id uuid not null,
  revision bigint not null check(revision between 1 and 9007199254740991),
  business_scheduled_for timestamptz not null,
  initial_arm_id uuid not null unique,
  plan jsonb not null,
  plan_digest text not null check(plan_digest=allrice_native_control_document_digest(plan)),
  closed_decision_id uuid,
  created_at timestamptz not null,
  unique(automation_id,revision,business_scheduled_for),
  unique(period_id,partition_id,control_id,automation_id,revision),
  foreign key(partition_id,control_id,automation_id)
    references allrice_native_recurring_controls(partition_id,control_id,automation_id),
  foreign key(automation_id,revision) references allrice_native_recurring_versions,
  check((plan=jsonb_build_object('periodId',period_id::text,'controlId',control_id::text,
    'automationId',automation_id::text,'revision',revision,
    'businessScheduledFor',to_char(business_scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'initialArmId',initial_arm_id::text,'revisionDigest',plan->>'revisionDigest',
    'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'cause',plan->'cause')
    and plan->>'revisionDigest' ~ '^sha256:[a-f0-9]{64}$'
    and date_trunc('milliseconds',created_at)=created_at
    and date_trunc('milliseconds',business_scheduled_for)=business_scheduled_for
    and (plan->'cause'='{"kind":"handoff"}'::jsonb
      or (plan->'cause'=jsonb_build_object('kind','policy','policyRevision',plan->'cause'->'policyRevision')
        and jsonb_typeof(plan->'cause'->'policyRevision')='number'
        and (plan->'cause'->>'policyRevision')::bigint between 1 and 9007199254740991)
      or (plan->'cause'=jsonb_build_object('kind','successor','predecessorPeriodId',plan->'cause'->>'predecessorPeriodId')
        and (plan->'cause'->>'predecessorPeriodId')::uuid<>period_id))) is true)
);
create unique index native_calendar_one_open_plan on allrice_native_calendar_plans(partition_id,control_id)
  where closed_decision_id is null;

create table allrice_native_calendar_decisions (
  decision_id uuid primary key,
  period_id uuid not null unique references allrice_native_calendar_plans,
  kind text not null check(kind in ('receipt','policy','authority')),
  outcome text not null check(outcome in ('queued','empty','budget','already_claimed','canceled','authority_blocked')),
  revision bigint not null check(revision between 1 and 9007199254740991),
  occurrence_id uuid unique references allrice_native_recurring_occurrences,
  automation_run_id uuid references allrice_automation_runs,
  successor_period_id uuid unique references allrice_native_calendar_plans deferrable initially deferred,
  decision jsonb not null,
  decision_digest text not null check(decision_digest=allrice_native_control_document_digest(decision)),
  decided_at timestamptz not null,
  unique(decision_id,period_id),
  check((decision=jsonb_build_object('decisionId',decision_id::text,'periodId',period_id::text,
    'kind',kind,'outcome',outcome,'revision',revision,
    'decidedAt',to_char(decided_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'receiptOccurrenceId',occurrence_id::text,'automationRunId',automation_run_id::text,
    'successorPeriodId',successor_period_id::text,'lease',decision->'lease','budget',decision->'budget')
    and date_trunc('milliseconds',decided_at)=decided_at
    and ((kind='receipt')=(occurrence_id is not null))
    and ((kind='receipt')=(decision->'lease'<>'null'::jsonb))
    and ((outcome in ('queued','empty','budget','already_claimed'))=(successor_period_id is not null))
    and ((outcome in ('queued','empty','already_claimed'))=(automation_run_id is not null))
    and ((outcome='budget')=(decision->'budget'<>'null'::jsonb))
    and (outcome not in ('queued','empty','budget','already_claimed') or kind='receipt')
    and (kind<>'policy' or outcome='canceled') and (kind<>'authority' or outcome='authority_blocked')
    and (kind<>'receipt' or outcome<>'canceled')
    and (successor_period_id is null or successor_period_id<>period_id)
    and (kind<>'receipt' or (
      decision->'lease'=jsonb_build_object('ownerId',decision->'lease'->>'ownerId',
        'epoch',decision->'lease'->'epoch','tokenDigest',decision->'lease'->>'tokenDigest')
      and (decision->'lease'->>'ownerId')::uuid is not null
      and jsonb_typeof(decision->'lease'->'epoch')='number'
      and (decision->'lease'->>'epoch')::bigint between 1 and 9007199254740991
      and decision->'lease'->>'tokenDigest' ~ '^sha256:[a-f0-9]{64}$'))
    and (outcome<>'budget' or (
      decision->'budget'=jsonb_build_object('globalCount',decision->'budget'->'globalCount',
        'organizationCount',decision->'budget'->'organizationCount','instanceCount',decision->'budget'->'instanceCount')
      and (decision->'budget'->>'globalCount')::bigint>=0
      and (decision->'budget'->>'organizationCount')::bigint>=0
      and (decision->'budget'->>'instanceCount')::bigint>=0
      and ((decision->'budget'->>'globalCount')::bigint>=64
        or (decision->'budget'->>'organizationCount')::bigint>=8
        or (decision->'budget'->>'instanceCount')::bigint>=1)))) is true)
);
alter table allrice_native_calendar_plans add constraint native_calendar_plan_closed_decision
  foreign key(closed_decision_id,period_id) references allrice_native_calendar_decisions(decision_id,period_id)
  deferrable initially deferred;
create trigger native_calendar_decision_immutable before update or delete on allrice_native_calendar_decisions
  for each row execute function allrice_native_once_immutable();
create function allrice_native_calendar_plan_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-'closed_decision_id') is distinct from (to_jsonb(old)-'closed_decision_id')
    or old.closed_decision_id is not null or new.closed_decision_id is null then
    raise exception 'calendar accepted plan is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_calendar_plan_guard before update on allrice_native_calendar_plans
  for each row execute function allrice_native_calendar_plan_guard();
create trigger native_calendar_plan_no_delete before delete on allrice_native_calendar_plans
  for each row execute function allrice_native_once_immutable();

alter table allrice_native_calendar_periods add column plan_id uuid,
  add column business_decision_id uuid,
  add constraint native_calendar_period_plan foreign key(plan_id,partition_id,control_id,automation_id,revision)
    references allrice_native_calendar_plans(period_id,partition_id,control_id,automation_id,revision),
  add constraint native_calendar_period_plan_identity check(plan_id is null or plan_id=period_id),
  add constraint native_calendar_period_business_decision foreign key(business_decision_id,period_id)
    references allrice_native_calendar_decisions(decision_id,period_id) deferrable initially deferred;
drop index native_calendar_one_open_period;
create unique index native_calendar_one_open_period on allrice_native_calendar_periods(partition_id,control_id)
  where business_decision_id is null;

-- The business link has its own immutable decision. It never changes native
-- JSON/version, so receipt ACK readback remains exact after completion/cancel.
create or replace function allrice_native_calendar_period_guard() returns trigger language plpgsql as $$
begin
  if new.business_decision_id is distinct from old.business_decision_id then
    if old.business_decision_id is not null or new.business_decision_id is null
      or (to_jsonb(new)-'business_decision_id') is distinct from (to_jsonb(old)-'business_decision_id') then
      raise exception 'calendar immutable business decision link' using errcode='23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new)-array['current_arm_id','state','version']) is distinct from
      (to_jsonb(old)-array['current_arm_id','state','version']) or new.version<>old.version+1
    or (old.state='received' and new.state<>'received')
    or (old.state='bound' and new.state not in ('bound','received'))
    or (old.state in ('bound','received') and new.current_arm_id<>old.current_arm_id)
    or (new.current_arm_id<>old.current_arm_id and (old.state<>'recovery_required' or not exists(
      select 1 from allrice_native_calendar_arms a where a.arm_id=old.current_arm_id and a.period_id=old.period_id
        and a.status='absent' and a.absence_proof is not null and a.native_task_id is null))) then
    raise exception 'calendar immutable period or CAS transition' using errcode='23514';
  end if;
  return new;
end $$;
create function allrice_native_calendar_decision_link() returns trigger language plpgsql as $$
begin
  update allrice_native_calendar_plans set closed_decision_id=new.decision_id
    where period_id=new.period_id and closed_decision_id is null;
  if not found then raise exception 'calendar plan already decided' using errcode='23514'; end if;
  update allrice_native_calendar_periods set business_decision_id=new.decision_id
    where period_id=new.period_id and business_decision_id is null;
  return new;
end $$;
create trigger native_calendar_decision_link after insert on allrice_native_calendar_decisions
  for each row execute function allrice_native_calendar_decision_link();

create function allrice_native_calendar_plan_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_plans p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_automations a on a.id=p.automation_id and a.clock_owner='native_recurring'
  where p.period_id=$1 and allrice_native_calendar_control_valid(c.snapshot->'control')
    and allrice_native_calendar_revision_valid(v.configuration)
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
create function allrice_native_calendar_plan_fence() returns trigger language plpgsql as $$
begin
  if not allrice_native_calendar_plan_proved(new.period_id) then
    raise exception 'calendar business plan lacks original scoped authority/decision' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_plan_fence after insert or update on allrice_native_calendar_plans
  deferrable initially deferred for each row execute function allrice_native_calendar_plan_fence();

create function allrice_native_calendar_decision_fence() returns trigger language plpgsql as $$
declare p allrice_native_calendar_plans; a allrice_automations;
  global_count bigint; org_count bigint; instance_count bigint;
begin
  select * into p from allrice_native_calendar_plans where period_id=new.period_id;
  select * into a from allrice_automations where id=p.automation_id;
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
create constraint trigger native_calendar_decision_fence after insert on allrice_native_calendar_decisions
  deferrable initially deferred for each row execute function allrice_native_calendar_decision_fence();

-- One unresolved public create per Session, including canceled older P. A new
-- period may be planned while this slot drains, but may not issue create.
create function allrice_native_calendar_create_slot() returns trigger language plpgsql as $$
declare partition_key text; parent_key uuid;
begin
  if new.status<>'creating' then return new; end if;
  select partition_id,control_id into partition_key,parent_key from allrice_native_calendar_periods where period_id=new.period_id;
  perform 1 from allrice_native_recurring_controls where partition_id=partition_key and control_id=parent_key for update;
  if exists(select 1 from allrice_native_calendar_arms a join allrice_native_calendar_periods p on p.period_id=a.period_id
    where p.partition_id=partition_key and p.control_id=parent_key and a.arm_id<>new.arm_id and a.status='creating') then
    raise exception 'calendar Session already has an unresolved create' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_calendar_create_slot before insert or update on allrice_native_calendar_arms
  for each row execute function allrice_native_calendar_create_slot();
create function allrice_native_calendar_arm_time_fence() returns trigger language plpgsql as $$
begin
  if new.reason='future_recovery' and not exists(select 1 from allrice_native_calendar_periods p
    where p.period_id=new.period_id and new.native_at>=p.business_scheduled_for) then
    raise exception 'calendar recovery cannot deliver before its business P' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_arm_time_fence after insert or update on allrice_native_calendar_arms
  deferrable initially deferred for each row execute function allrice_native_calendar_arm_time_fence();

-- Retirement keeps all original Task/history rows. Only the exact backend
-- deletion journal removes a Task from the current native KV document.
create table allrice_native_calendar_retirement_intents (
  retirement_id uuid primary key,
  arm_id uuid not null unique references allrice_native_calendar_arms,
  decision_id uuid not null references allrice_native_calendar_decisions,
  native_task_id text not null unique,
  record_digest text not null check(record_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create trigger native_calendar_retirement_intent_immutable before update or delete on allrice_native_calendar_retirement_intents
  for each row execute function allrice_native_once_immutable();
create table allrice_native_calendar_retirements (
  retirement_id uuid primary key references allrice_native_calendar_retirement_intents,
  arm_id uuid not null unique references allrice_native_calendar_arms,
  partition_id text not null,
  control_id uuid not null,
  native_task_id text not null unique,
  task_snapshot jsonb not null,
  task_digest text not null check(task_digest ~ '^sha256:[a-f0-9]{64}$'),
  write_id text not null,
  foreign key(partition_id,write_id) references allrice_native_recurring_journal deferrable initially deferred,
  foreign key(partition_id,control_id) references allrice_native_recurring_controls,
  created_at timestamptz not null default clock_timestamp()
);
create trigger native_calendar_retirement_immutable before update or delete on allrice_native_calendar_retirements
  for each row execute function allrice_native_once_immutable();
create function allrice_native_calendar_retirement_fence() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from allrice_native_calendar_retirement_intents i
    join allrice_native_calendar_arms a on a.arm_id=i.arm_id
    join allrice_native_calendar_periods p on p.period_id=a.period_id and p.business_decision_id=i.decision_id
    join allrice_native_recurring_journal j on j.partition_id=p.partition_id and j.control_id=p.control_id and j.write_id=new.write_id
    where i.retirement_id=new.retirement_id and i.arm_id=new.arm_id and i.native_task_id=new.native_task_id
      and p.partition_id=new.partition_id and p.control_id=new.control_id and a.native_task_id=new.native_task_id
      and a.task_snapshot=new.task_snapshot and j.mutation=jsonb_build_object('kind','calendar','action','retire_task',
        'controlId',p.control_id::text,'periodId',p.period_id::text,'armId',a.arm_id::text,
        'retirementId',i.retirement_id::text,'nativeTaskId',a.native_task_id,'taskDigest',new.task_digest,
        'expectedArmVersion',a.snapshot_version)
      and j.journal->'retirement'=jsonb_build_object('retirementId',i.retirement_id::text,
        'armId',a.arm_id::text,'nativeTaskId',a.native_task_id,'taskDigest',new.task_digest,'task',new.task_snapshot)
      and new.task_digest=allrice_native_control_document_digest(new.task_snapshot)
      and i.record_digest=allrice_native_control_document_digest(a.task_snapshot->'record')) then
    raise exception 'calendar retirement lacks exact backend deletion' using errcode='23514';
  end if;
  return new;
end $$;

-- Preserve both original branches verbatim and add only the exact experience
-- consumer with its original calendar schedule and original Run/Session model.
alter table allrice_automations drop constraint native_recurring_request_shape;
alter table allrice_automations add constraint native_recurring_request_shape check ((
  (clock_owner<>'native_recurring' and native_recurring_request_id is null and native_recurring_request_digest is null
    and native_recurring_revision is null and native_recurring_resume_after is null)
  or (clock_owner='native_recurring' and trigger_type='schedule' and employee_assignment_id is not null
    and native_recurring_request_id is not null and native_recurring_request_digest ~ '^sha256:[a-f0-9]{64}$'
    and native_recurring_revision between 1 and revision and (
      (quality_binding is null and schedule->>'frequency'='native_recurring' and conversation_mode='reuse' and session_id is not null)
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

create function allrice_experience_calendar_clock_proved(automation uuid) returns boolean language sql as $$
select exists(select 1 from allrice_automations a
  join allrice_native_recurring_controls c on c.automation_id=a.id and c.snapshot->'control'->>'kind'='calendar'
  join allrice_native_once_partitions partition on partition.partition_id=c.partition_id
    and partition.reference=c.snapshot->'control'->'reference'
  join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=a.native_recurring_revision
  left join allrice_settings company on company.scope_type='organization' and company.scope_id=a.organization_id and company.key='employee_experience_policy'
  left join allrice_settings defaults on defaults.scope_type='system' and defaults.scope_id is null and defaults.key='employee_experience_policy'
  where a.id=automation and a.clock_owner='native_recurring' and a.native_recurring_request_id=a.id
    and a.native_recurring_request_digest=v.configuration->>'reservationDigest'
    and allrice_native_calendar_control_valid(c.snapshot->'control') and allrice_native_calendar_revision_valid(v.configuration)
    and c.native_task_id is null and c.immutable_identity->'dispatch'->>'consumer'='experience-consolidation-v1'
    and a.organization_id::text=c.immutable_identity->>'organizationId'
    and a.workspace_id::text=c.immutable_identity->>'workspaceId' and a.owner_id::text=c.immutable_identity->>'ownerId'
    and a.employee_assignment_id::text=c.immutable_identity->'dispatch'->>'employeeAssignmentId'
    and a.experience_binding->>'instanceId'=c.immutable_identity->'dispatch'->>'employeeInstanceId'
    and a.experience_binding->>'policyDigest'=v.configuration->>'policyDigest'
    and v.configuration->>'policyDigest'=allrice_native_control_document_digest(coalesce(company.value,defaults.value))
    and (v.configuration->>'policyRevision')::bigint=(coalesce(company.value,defaults.value)->>'revision')::bigint
    and (v.configuration->>'ruleRevision')::bigint=a.revision and a.schedule=v.configuration->'schedule'
    and ((a.status='enabled' and a.deleted_at is null and exists(select 1 from allrice_native_calendar_plans p
      where p.automation_id=a.id and p.revision=a.native_recurring_revision and p.closed_decision_id is null
        and p.business_scheduled_for=a.next_run_at and allrice_native_calendar_plan_proved(p.period_id)))
      or ((a.status<>'enabled' or a.deleted_at is not null) and a.next_run_at is null
        and not exists(select 1 from allrice_native_calendar_plans p where p.automation_id=a.id and p.closed_decision_id is null))))
$$;
create function allrice_experience_calendar_clock_fence() returns trigger language plpgsql as $$
begin
  if new.clock_owner='native_recurring' and new.experience_binding is not null
    and not allrice_experience_calendar_clock_proved(new.id) then
    raise exception 'experience native clock lacks exact scoped plan/policy proof' using errcode='P1921';
  end if;
  if tg_op='UPDATE' and old.clock_owner='native_recurring' and old.experience_binding is not null
    and (new.clock_owner<>'native_recurring' or new.experience_binding is null) then
    raise exception 'experience native clock cannot silently fall back to legacy' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger experience_calendar_clock_fence after insert or update on allrice_automations
  deferrable initially deferred for each row execute function allrice_experience_calendar_clock_fence();

create function allrice_experience_calendar_handoff_proved(occurrence uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_recurring_occurrences o
  join allrice_native_calendar_periods p on p.period_id=o.calendar_period_id and p.plan_id=p.period_id
  join allrice_native_calendar_arms arm on arm.arm_id=o.calendar_arm_id and arm.period_id=p.period_id
  join allrice_native_calendar_decisions d on d.period_id=p.period_id and d.decision_id=p.business_decision_id and d.occurrence_id=o.occurrence_id
  join allrice_native_recurring_controls c on c.control_id=p.control_id and c.partition_id=p.partition_id and c.automation_id=p.automation_id
  join allrice_automations a on a.id=p.automation_id and a.clock_owner='native_recurring'
  join allrice_automation_runs r on r.id=d.automation_run_id and r.automation_id=p.automation_id
  where o.occurrence_id=occurrence and o.payload->'control'=c.immutable_identity
    and c.immutable_identity->'dispatch'->>'consumer'='experience-consolidation-v1'
    and o.outbox_state='enqueued' and d.kind='receipt' and d.outcome in ('queued','empty','already_claimed')
    and r.organization_id=a.organization_id and r.workspace_id=a.workspace_id and r.scheduled_for=p.business_scheduled_for
    and r.experience_occurrence->>'id'=r.id::text and r.experience_occurrence->>'ownerId'=a.owner_id::text
    and r.experience_occurrence->>'instanceId'=c.immutable_identity->'dispatch'->>'employeeInstanceId'
    and r.experience_occurrence->>'assignmentId'=c.immutable_identity->'dispatch'->>'employeeAssignmentId'
    and (d.outcome='already_claimed' or r.native_recurring_occurrence_id=o.occurrence_id)
    and o.business_binding=jsonb_build_object('consumer','experience-consolidation-v1','periodId',p.period_id::text,
      'decisionId',d.decision_id::text,'automationRunId',r.id::text,'payloadDigest',o.payload_digest,'outcome',d.outcome,'origin',r.experience_occurrence))
$$;

create function allrice_native_calendar_utf16_length(value text) returns bigint language sql immutable strict as $$
select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)
  from unnest(string_to_array(value,null)) c
$$;

-- Replace the dormant hard refusal with an exact original-business proof.
create or replace function allrice_native_calendar_no_business_run() returns trigger language plpgsql as $$
begin
  if new.native_recurring_occurrence_id is not null and exists(select 1 from allrice_native_recurring_occurrences o
    where o.occurrence_id=new.native_recurring_occurrence_id and o.calendar_period_id is not null) then
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
    and not allrice_experience_calendar_handoff_proved(new.occurrence_id) then
    raise exception 'calendar business handoff lacks exact original experience proof' using errcode='P1921';
  end if;
  return new;
end $$;

-- SQL format dispatch leaves the fixed/chat/quality function unchanged.
drop trigger native_recurring_dispatch_commit_fence on allrice_native_recurring_occurrences;
create constraint trigger native_recurring_dispatch_commit_fence after update on allrice_native_recurring_occurrences
  deferrable initially deferred for each row when (new.calendar_period_id is null)
  execute function allrice_native_recurring_dispatch_commit_fence();
create function allrice_experience_calendar_dispatch_fence() returns trigger language plpgsql as $$
begin
  if new.outbox_state='enqueued' and (new.outbox_owner_id is null or new.outbox_epoch<1
    or new.outbox_token_digest is null or new.outbox_expires_at<=clock_timestamp()
    or not allrice_experience_calendar_handoff_proved(new.occurrence_id)) then
    raise exception 'experience calendar dispatch COMMIT proof lost' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger experience_calendar_dispatch_fence after update on allrice_native_recurring_occurrences
  deferrable initially deferred for each row when (new.calendar_period_id is not null)
  execute function allrice_experience_calendar_dispatch_fence();

create function allrice_native_calendar_period_plan_fence() returns trigger language plpgsql as $$
begin
  if exists(select 1 from allrice_automations a where a.id=new.automation_id and a.clock_owner='native_recurring'
    and a.experience_binding is not null) and not exists(select 1 from allrice_native_calendar_plans p
      where p.period_id=new.plan_id and p.period_id=new.period_id and p.partition_id=new.partition_id and p.control_id=new.control_id
        and p.automation_id=new.automation_id and p.revision=new.revision and p.business_scheduled_for=new.business_scheduled_for
        and p.closed_decision_id is not distinct from new.business_decision_id) then
    raise exception 'calendar native period lacks exact business plan' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_period_plan_fence after insert or update on allrice_native_calendar_periods
  deferrable initially deferred for each row execute function allrice_native_calendar_period_plan_fence();
create constraint trigger native_calendar_retirement_fence after insert on allrice_native_calendar_retirements
  deferrable initially deferred for each row execute function allrice_native_calendar_retirement_fence();

create function allrice_native_calendar_retired_arm_guard() returns trigger language plpgsql as $$
begin
  if exists(select 1 from allrice_native_calendar_retirements d where d.arm_id=old.arm_id) then
    raise exception 'calendar retired Task archive is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_calendar_retired_arm_guard before update on allrice_native_calendar_arms
  for each row execute function allrice_native_calendar_retired_arm_guard();

alter table allrice_native_recurring_journal drop constraint native_calendar_journal_kind;
alter table allrice_native_recurring_journal add constraint native_calendar_journal_kind check ((
  (mutation->>'kind'<>'calendar' and not (journal ? 'calendarLinks'))
  or (mutation->>'kind'='calendar' and after_snapshot->'control'->>'kind'='calendar'
    and after_snapshot->'control'->>'binding'='rotating-at-v1' and jsonb_typeof(journal->'calendarLinks')='array'
    and ((mutation->>'action'='put_task' and jsonb_array_length(journal->'calendarLinks')=1
      and not (journal ? 'retirement') and not (journal ? 'revisionLink'))
      or (mutation->>'action' in ('session_initializing','session_ready') and jsonb_array_length(journal->'calendarLinks')=0
        and not (journal ? 'retirement') and not (journal ? 'revisionLink'))
      or (mutation->>'action'='apply_revision' and jsonb_array_length(journal->'calendarLinks')=0
        and jsonb_typeof(journal->'revisionLink')='object' and not (journal ? 'retirement'))
      or (mutation->>'action'='retire_task' and jsonb_array_length(journal->'calendarLinks')=0
        and jsonb_typeof(journal->'retirement')='object' and not (journal ? 'revisionLink'))))
) is true);

create or replace function allrice_native_calendar_parent_commit_fence() returns trigger language plpgsql as $$
begin
  if new.snapshot->'control'->>'kind'<>'calendar' then return new; end if;
  if not exists(select 1 from allrice_native_once_partitions p
    where p.partition_id=new.partition_id and p.reference=new.snapshot->'control'->'reference') then
    raise exception 'calendar approved parent reference changed' using errcode='23514';
  end if;
  if not exists(select 1 from allrice_native_recurring_versions v
    where v.automation_id=new.automation_id and v.revision=(new.snapshot->'control'->>'revision')::bigint
      and allrice_native_calendar_revision_valid(v.configuration)) then
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

create or replace function allrice_native_calendar_journal_commit_fence() returns trigger language plpgsql as $$
declare c allrice_native_recurring_controls; p allrice_native_calendar_periods; a allrice_native_calendar_arms;
begin
  if new.mutation->>'kind'<>'calendar' then return new; end if;
  select * into c from allrice_native_recurring_controls where partition_id=new.partition_id and control_id=new.control_id;
  if (new.journal->'write'=jsonb_build_object('writeId',new.write_id,'digest',new.write_digest,'mutation',new.mutation)
    and new.journal->'reference'=new.reference and new.journal->'writer'=jsonb_build_object(
      'partitionId',new.partition_id,'ownerId',new.writer_owner_id,'epoch',new.writer_epoch,'tokenDigest',new.writer_token_digest)
    and new.journal->'identity'=c.immutable_identity and new.after_snapshot=c.snapshot
    and new.journal->>'afterDigest'=new.after_digest and new.journal->>'beforeDigest' ~ '^sha256:[a-f0-9]{64}$'
    and new.after_digest ~ '^sha256:[a-f0-9]{64}$') is not true then
    raise exception 'calendar journal identity proof lost' using errcode='23514';
  end if;
  if new.mutation->>'action'='put_task' then
    select * into p from allrice_native_calendar_periods where period_id=(new.mutation->>'periodId')::uuid;
    select * into a from allrice_native_calendar_arms where arm_id=(new.mutation->>'armId')::uuid and period_id=p.period_id;
    if (p.control_id=new.control_id and p.partition_id=new.partition_id and a.arm_id=p.current_arm_id
      and new.journal->'calendarLinks'->0->'period'=allrice_native_calendar_period_json(p)
      and new.journal->'calendarLinks'->0->'arm'=allrice_native_calendar_arm_json(a)
      and new.mutation->'task'=a.task_snapshot and new.mutation->>'requestDigest'=a.request_digest
      and (new.mutation->>'expectedPeriodVersion')::bigint=p.version-1
      and (new.mutation->>'expectedArmVersion')::bigint=a.snapshot_version-1 and a.last_write_id=new.write_id
      and jsonb_array_length(new.journal->'receiptLinks') between 0 and 1) is not true then
      raise exception 'calendar journal exact Task link lost' using errcode='23514';
    end if;
  elsif new.mutation->>'action'='retire_task' then
    if not exists(select 1 from allrice_native_calendar_retirements d
      join allrice_native_calendar_retirement_intents i on i.retirement_id=d.retirement_id
      join allrice_native_calendar_arms arm on arm.arm_id=d.arm_id and arm.native_task_id=d.native_task_id
      join allrice_native_calendar_periods period on period.period_id=arm.period_id and period.business_decision_id=i.decision_id
      where d.partition_id=new.partition_id and d.control_id=new.control_id and d.write_id=new.write_id
        and d.retirement_id=(new.mutation->>'retirementId')::uuid
        and arm.snapshot_version=(new.mutation->>'expectedArmVersion')::bigint
        and arm.task_snapshot=d.task_snapshot and d.task_digest=new.mutation->>'taskDigest') then
      raise exception 'calendar journal exact retirement link lost' using errcode='23514';
    end if;
  else
    if (c.calendar_last_write_id=new.write_id
      and (new.mutation->>'expectedControlVersion')::bigint=c.snapshot_version-1
      and jsonb_array_length(new.journal->'receiptLinks')=0) is not true then
      raise exception 'calendar journal exact control link lost' using errcode='23514';
    end if;
    if new.mutation->>'action'='apply_revision' and not exists(
      select 1 from allrice_native_calendar_plans plan
      join allrice_native_recurring_versions v on v.automation_id=plan.automation_id and v.revision=plan.revision
      where plan.period_id=(new.mutation->>'planId')::uuid and plan.control_id=c.control_id
        and plan.revision=(new.mutation->>'revision')::bigint and plan.plan_digest=new.mutation->>'planDigest'
        and plan.closed_decision_id is null and plan.revision=(c.snapshot->'control'->>'revision')::bigint
        and new.journal->'revisionLink'=jsonb_build_object('plan',plan.plan,'planDigest',plan.plan_digest,'revision',v.configuration)
        and allrice_native_calendar_plan_proved(plan.period_id)) then
      raise exception 'calendar apply revision lacks exact accepted plan' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

-- IDs stay reserved forever; only current, not archived, Tasks consume native
-- document capacity. Keep the original fixed count and all collision checks.
create or replace function allrice_native_calendar_task_namespace_guard() returns trigger language plpgsql as $$
declare task_partition text; task_count bigint;
begin
  if new.native_task_id is null then return new; end if;
  if tg_op='UPDATE' and new.native_task_id is not distinct from old.native_task_id then return new; end if;
  if tg_table_name='allrice_native_calendar_arms' then
    select p.partition_id into task_partition from allrice_native_calendar_periods p where p.period_id=new.period_id;
  else task_partition:=new.partition_id;
  end if;
  perform 1 from allrice_native_once_partitions where partition_id=task_partition for update;
  if (tg_table_name='allrice_native_calendar_arms' and exists(select 1 from allrice_native_recurring_controls c
      where c.partition_id=task_partition and c.native_task_id=new.native_task_id))
    or (tg_table_name='allrice_native_recurring_controls' and exists(select 1 from allrice_native_calendar_arms a
      join allrice_native_calendar_periods p on p.period_id=a.period_id
      where p.partition_id=task_partition and a.native_task_id=new.native_task_id)) then
    raise exception 'calendar/fixed native Task ID alias' using errcode='23514';
  end if;
  select (select count(*) from allrice_native_recurring_controls c where c.partition_id=task_partition
      and c.native_task_id is not null and c.snapshot->'control'->>'taskDeleted'='false') +
    (select count(*) from allrice_native_calendar_arms a join allrice_native_calendar_periods p on p.period_id=a.period_id
      where p.partition_id=task_partition and a.native_task_id is not null
        and not exists(select 1 from allrice_native_calendar_retirements d where d.arm_id=a.arm_id)) into task_count;
  if tg_op='INSERT' then task_count:=task_count+1;
  elsif old.native_task_id is null then task_count:=task_count+1;
  end if;
  if task_count>10000 then raise exception 'native Task document capacity exhausted' using errcode='23514'; end if;
  return new;
end $$;
