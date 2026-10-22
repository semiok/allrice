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
  plan_digest text not null check(plan_digest ~ '^sha256:[a-f0-9]{64}$'),
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
  decision_digest text not null check(decision_digest ~ '^sha256:[a-f0-9]{64}$'),
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
  where p.period_id=id and allrice_native_calendar_control_valid(c.snapshot->'control')
    and allrice_native_calendar_revision_valid(v.configuration)
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
    if (a.revision=new.revision and a.native_recurring_revision=new.revision
      and (a.revision>p.revision or a.status<>'enabled' or a.deleted_at is not null)) is not true then
      raise exception 'calendar cancellation lacks current policy invalidation' using errcode='23514';
    end if;
  end if;
  if new.kind='authority' or new.outcome='authority_blocked' then
    if a.status='enabled' and a.deleted_at is null and a.revision=p.revision and exists(
      select 1 from allrice_users u join allrice_organizations o on o.id=a.organization_id and o.archived_at is null
      join allrice_workspaces w on w.id=a.workspace_id and w.organization_id=o.id and w.archived_at is null
      join allrice_employee_assignments x on x.id=a.employee_assignment_id and x.user_id=u.id and x.active
      join allrice_employees e on e.id=x.employee_id and e.status='active'
      join allrice_employee_instances i on i.id=(a.experience_binding->>'instanceId')::uuid and i.assignment_id=x.id
        and i.organization_id=a.organization_id and i.workspace_id=a.workspace_id and i.owner_id=a.owner_id and i.archived_at is null
      where u.id=a.owner_id and u.status='active' and u.archived_at is null
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
        'armId',a.arm_id::text,'nativeTaskId',a.native_task_id,'taskDigest',new.task_digest,'task',new.task_snapshot)) then
    raise exception 'calendar retirement lacks exact backend deletion' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_retirement_fence after insert on allrice_native_calendar_retirements
  deferrable initially deferred for each row execute function allrice_native_calendar_retirement_fence();
