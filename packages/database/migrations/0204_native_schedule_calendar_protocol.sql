-- Dormant rotating-at protocol. No producer, ownership handoff or business
-- dispatch is enabled here. Fixed once/every/daily/weekly guards are unchanged.
create function allrice_native_calendar_writer_valid(w jsonb) returns boolean language sql immutable as $$
select (jsonb_typeof(w)='object' and w=jsonb_build_object(
  'partitionId',w->'partitionId','ownerId',w->'ownerId','epoch',w->'epoch','tokenDigest',w->'tokenDigest')
  and w->>'partitionId'='allrice-recurring-v1' and jsonb_typeof(w->'ownerId')='string'
  and length(w->>'ownerId') between 1 and 512 and jsonb_typeof(w->'epoch')='number'
  and (w->>'epoch')::bigint between 1 and 9007199254740991
  and (w->>'tokenDigest') ~ '^sha256:[a-f0-9]{64}$') is true
$$;
create function allrice_native_calendar_control_valid(c jsonb) returns boolean language sql immutable as $$
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
create function allrice_native_calendar_revision_valid(v jsonb) returns boolean language sql immutable as $$
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

-- Discover only the old kind CHECK; preserve the original immutable Task-ID
-- trigger and every other existing constraint, including request_shape.
do $$
declare r record; kind_constraint_count integer:=0;
begin
  for r in select conname from pg_constraint where conrelid='allrice_native_recurring_controls'::regclass
    and contype='c' and position('''kind''' in pg_get_expr(conbin,conrelid))>0
    and position('''recurring''' in pg_get_expr(conbin,conrelid))>0 loop
    execute format('alter table allrice_native_recurring_controls drop constraint %I',r.conname);
    kind_constraint_count:=kind_constraint_count+1;
  end loop;
  if kind_constraint_count<>1 then raise exception 'expected exactly one fixed recurring kind CHECK'; end if;
end $$;
alter table allrice_native_recurring_controls add column calendar_last_write_id text;
alter table allrice_native_recurring_controls add constraint native_recurring_control_kind check ((
  (snapshot->'control'->>'kind'='recurring' and not (snapshot->'control' ? 'binding')
    and not (immutable_identity ? 'binding') and calendar_last_write_id is null)
  or (allrice_native_calendar_control_valid(snapshot->'control') and native_task_id is null
    and snapshot=jsonb_build_object('control',snapshot->'control','task',null)
    and immutable_identity=((snapshot->'control')-array['revision','sessionState','nativeTaskId'])
    and ((snapshot->'control'->>'sessionState'='reserved' and snapshot_version=0 and calendar_last_write_id is null)
      or (snapshot->'control'->>'sessionState' in ('initializing','ready') and calendar_last_write_id is not null)))
) is true);
alter table allrice_native_recurring_versions add constraint native_calendar_revision_kind check ((
  (configuration->>'kind' is distinct from 'calendar' and not (configuration ? 'binding'))
  or allrice_native_calendar_revision_valid(configuration)
) is true);

create table allrice_native_calendar_periods (
  period_id uuid primary key,
  partition_id text not null,
  control_id uuid not null,
  automation_id uuid not null,
  revision bigint not null check(revision between 1 and 9007199254740991),
  business_scheduled_for timestamptz not null,
  current_arm_id uuid not null,
  state text not null check(state in ('prepared','recovery_required','bound','received')),
  version bigint not null default 0 check(version between 0 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  unique(automation_id,revision,business_scheduled_for),
  unique(period_id,partition_id,control_id,automation_id,revision),
  foreign key(partition_id,control_id,automation_id)
    references allrice_native_recurring_controls(partition_id,control_id,automation_id),
  foreign key(automation_id,revision) references allrice_native_recurring_versions,
  check(date_trunc('milliseconds',business_scheduled_for)=business_scheduled_for)
);
-- PR2 must supply a proved business decision before introducing terminal states
-- and a successor P. This slice intentionally leaves every period outstanding.
create unique index native_calendar_one_open_period on allrice_native_calendar_periods(partition_id,control_id)
  where state in ('prepared','recovery_required','bound','received');
create table allrice_native_calendar_arms (
  arm_id uuid primary key,
  period_id uuid not null references allrice_native_calendar_periods,
  attempt bigint not null check(attempt between 1 and 9007199254740991),
  native_at timestamptz not null,
  reason text not null check(reason in ('business_target','future_recovery')),
  request_digest text not null check(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text not null check(status in ('prepared','creating','absent','bound','received')),
  native_task_id text unique check(length(native_task_id) between 1 and 512),
  task_snapshot jsonb,
  bind_write_id text,
  last_write_id text,
  create_writer jsonb,
  absence_proof jsonb,
  snapshot_version bigint not null default 0 check(snapshot_version between 0 and 9007199254740991),
  transition_writer jsonb not null check(allrice_native_calendar_writer_valid(transition_writer)),
  reference jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(period_id,attempt),
  unique(arm_id,period_id),
  check(date_trunc('milliseconds',native_at)=native_at),
  check((
    (status='prepared' and native_task_id is null and task_snapshot is null and bind_write_id is null
      and last_write_id is null and create_writer is null and absence_proof is null)
    or (status='creating' and native_task_id is null and task_snapshot is null and bind_write_id is null
      and last_write_id is null and allrice_native_calendar_writer_valid(create_writer) and absence_proof is null)
    or (status='absent' and native_task_id is null and task_snapshot is null and bind_write_id is null and last_write_id is null
      and jsonb_typeof(absence_proof)='object' and absence_proof->>'taskSetDigest' ~ '^sha256:[a-f0-9]{64}$' and (
        (absence_proof=jsonb_build_object('kind','never_started','taskSetDigest',absence_proof->'taskSetDigest') and create_writer is null)
        or (absence_proof=jsonb_build_object('kind','fenced_generation','taskSetDigest',absence_proof->'taskSetDigest',
          'closeProofDigest',absence_proof->'closeProofDigest','closedWriter',absence_proof->'closedWriter')
          and absence_proof->>'closeProofDigest' ~ '^sha256:[a-f0-9]{64}$'
          and allrice_native_calendar_writer_valid(create_writer) and absence_proof->'closedWriter'=create_writer)))
    or (status in ('bound','received') and native_task_id is not null and jsonb_typeof(task_snapshot)='object'
      and length(bind_write_id) between 1 and 512 and length(last_write_id) between 1 and 512
      and allrice_native_calendar_writer_valid(create_writer) and absence_proof is null)
  ) is true)
);
alter table allrice_native_calendar_periods add constraint native_calendar_current_arm
  foreign key(current_arm_id,period_id) references allrice_native_calendar_arms(arm_id,period_id)
  deferrable initially deferred;
create unique index native_calendar_one_prepared_arm on allrice_native_calendar_arms(period_id)
  where status in ('prepared','creating');
create unique index native_calendar_one_bound_task on allrice_native_calendar_arms(period_id)
  where native_task_id is not null;

create function allrice_native_calendar_period_json(p allrice_native_calendar_periods) returns jsonb language sql immutable as $$
select jsonb_build_object('periodId',p.period_id::text,'partitionId',p.partition_id,'controlId',p.control_id::text,
  'automationId',p.automation_id::text,'revision',p.revision,
  'businessScheduledFor',to_char(p.business_scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'currentArmId',p.current_arm_id::text,'state',p.state,'version',p.version)
$$;
create function allrice_native_calendar_arm_json(a allrice_native_calendar_arms) returns jsonb language sql immutable as $$
select jsonb_build_object('armId',a.arm_id::text,'periodId',a.period_id::text,'attempt',a.attempt,
  'nativeAt',to_char(a.native_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reason',a.reason,
  'requestDigest',a.request_digest,'status',a.status,'nativeTaskId',a.native_task_id,'taskSnapshot',a.task_snapshot,
  'bindWriteId',a.bind_write_id,'lastWriteId',a.last_write_id,'createWriter',a.create_writer,
  'absenceProof',a.absence_proof,'snapshotVersion',a.snapshot_version)
$$;
create function allrice_native_calendar_arm_insert_guard() returns trigger language plpgsql as $$
begin
  if new.status<>'prepared' or new.snapshot_version<>0 or not exists(
    select 1 from allrice_native_calendar_periods p where p.period_id=new.period_id and (
      (new.attempt=1 and p.current_arm_id=new.arm_id and p.state='prepared' and p.version=0
        and not exists(select 1 from allrice_native_calendar_arms a where a.period_id=p.period_id))
      or (new.attempt>1 and p.state='recovery_required' and exists(
        select 1 from allrice_native_calendar_arms previous where previous.arm_id=p.current_arm_id and previous.period_id=p.period_id
          and previous.attempt=new.attempt-1 and previous.status='absent' and previous.native_task_id is null and previous.absence_proof is not null)
        and not exists(select 1 from allrice_native_calendar_arms a where a.period_id=p.period_id and a.native_task_id is not null)))) then
    raise exception 'calendar arm insert requires exact unbound predecessor' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_calendar_arm_insert_guard before insert on allrice_native_calendar_arms
  for each row execute function allrice_native_calendar_arm_insert_guard();

create function allrice_native_calendar_period_guard() returns trigger language plpgsql as $$
begin
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
create trigger native_calendar_period_guard before update on allrice_native_calendar_periods
  for each row execute function allrice_native_calendar_period_guard();
create trigger native_calendar_period_no_delete before delete on allrice_native_calendar_periods
  for each row execute function allrice_native_once_immutable();
create function allrice_native_calendar_arm_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['status','native_task_id','task_snapshot','bind_write_id','last_write_id',
      'create_writer','absence_proof','snapshot_version','transition_writer']) is distinct from
    (to_jsonb(old)-array['status','native_task_id','task_snapshot','bind_write_id','last_write_id',
      'create_writer','absence_proof','snapshot_version','transition_writer'])
    or new.snapshot_version<>old.snapshot_version+1
    or (old.create_writer is not null and new.create_writer is distinct from old.create_writer)
    or (old.absence_proof is not null and new.absence_proof is distinct from old.absence_proof)
    or (old.native_task_id is not null and (new.native_task_id is distinct from old.native_task_id
      or new.bind_write_id is distinct from old.bind_write_id
      or new.task_snapshot->'record' is distinct from old.task_snapshot->'record'))
    or (old.status='prepared' and new.status not in ('creating','absent'))
    or (old.status='creating' and new.status not in ('bound','absent'))
    or (old.status='absent' and new.status<>'absent')
    or (old.status='bound' and new.status not in ('bound','received'))
    or (old.status='received' and (new.status<>'received' or new.task_snapshot is distinct from old.task_snapshot)) then
    raise exception 'calendar immutable arm or Task mapping' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_calendar_arm_guard before update on allrice_native_calendar_arms
  for each row execute function allrice_native_calendar_arm_guard();
create trigger native_calendar_arm_no_delete before delete on allrice_native_calendar_arms
  for each row execute function allrice_native_once_immutable();

create function allrice_native_calendar_task_valid(t jsonb,s text,a timestamptz,id text) returns boolean language sql immutable as $$
select (jsonb_typeof(t)='object' and jsonb_typeof(t->'record')='object'
  and t->>'sessionId'=s and jsonb_typeof(t->'record'->'id')='string' and t->'record'->>'id'=id
  and t->'record'->>'kind'='at' and t->'record'->>'title'='AllRice once control'
  and t->'record'->>'prompt'='Synthetic schedule control only. Never execute business work.'
  and jsonb_typeof(t->'record'->'scheduledAt')='string'
  and t->'record'->>'scheduledAt'=to_char(a at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  and ((t->>'status'='active' and not (t ? 'lastDelivery'))
    or (t->>'status'='inactive' and jsonb_typeof(t->'lastDelivery')='object'
      and t->'lastDelivery'->>'scheduledAt'=t->'record'->>'scheduledAt'
      and jsonb_typeof(t->'lastDelivery'->'deliveredAt')='string'
      and t->'lastDelivery'->>'deliveredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      and (t->'lastDelivery'->>'deliveredAt')::timestamptz is not null
      and jsonb_typeof(t->'lastDelivery'->'messageId')='string'
      and length(t->'lastDelivery'->>'messageId') between 1 and 512))
  and (not (t ? 'deliveryHistory') or (jsonb_typeof(t->'deliveryHistory')='object'
    and t->'deliveryHistory'->'earlierRecordsUnavailable'='false'::jsonb
    and (not (t->'deliveryHistory' ? 'earlierRecordsPruned') or t->'deliveryHistory'->'earlierRecordsPruned'='false'::jsonb)
    and jsonb_typeof(t->'deliveryHistory'->'records')='array' and (
      (t->>'status'='active' and jsonb_array_length(t->'deliveryHistory'->'records')=0)
      or (t->>'status'='inactive' and jsonb_array_length(t->'deliveryHistory'->'records')=1
        and ((t->'deliveryHistory'->'records'->0)-array['prompt'])=t->'lastDelivery'
        and (not (t->'deliveryHistory'->'records'->0 ? 'prompt') or
          t->'deliveryHistory'->'records'->0->>'prompt'='Synthetic schedule control only. Never execute business work.')))))) is true
$$;
create function allrice_native_calendar_period_proved(id uuid) returns boolean language sql as $$
select exists(select 1 from allrice_native_calendar_periods p
  join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id and c.automation_id=p.automation_id
  join allrice_native_recurring_versions v on v.automation_id=p.automation_id and v.revision=p.revision
  join allrice_native_calendar_arms a on a.arm_id=p.current_arm_id and a.period_id=p.period_id
  where p.period_id=id and allrice_native_calendar_control_valid(c.snapshot->'control')
    and allrice_native_calendar_revision_valid(v.configuration)
    and p.revision<=(c.snapshot->'control'->>'revision')::bigint
    and (a.reason<>'business_target' or a.native_at=p.business_scheduled_for)
    and ((p.state='prepared' and a.status in ('prepared','creating')) or (p.state='recovery_required' and a.status='absent')
      or (p.state='bound' and a.status='bound') or (p.state='received' and a.status='received'))
    and not exists(select 1 from allrice_native_calendar_arms other where other.period_id=p.period_id
      and other.arm_id<>a.arm_id and other.status<>'absent')
    and (a.native_task_id is null or (allrice_native_calendar_task_valid(a.task_snapshot,c.control_session_id,a.native_at,a.native_task_id)
      and a.task_snapshot->>'status'=case when a.status='received' then 'inactive' else 'active' end)))
$$;
create function allrice_native_calendar_consistency_fence() returns trigger language plpgsql as $$
begin
  if not allrice_native_calendar_period_proved(new.period_id) then
    raise exception 'calendar period/current arm COMMIT proof lost' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_period_consistency after insert or update on allrice_native_calendar_periods
  deferrable initially deferred for each row execute function allrice_native_calendar_consistency_fence();
create constraint trigger native_calendar_arm_consistency after insert or update on allrice_native_calendar_arms
  deferrable initially deferred for each row execute function allrice_native_calendar_consistency_fence();

alter table allrice_native_recurring_occurrences
  add column calendar_period_id uuid unique,
  add column calendar_arm_id uuid,
  add constraint native_calendar_occurrence_period foreign key(calendar_period_id,partition_id,control_id,automation_id,revision)
    references allrice_native_calendar_periods(period_id,partition_id,control_id,automation_id,revision),
  add constraint native_calendar_occurrence_arm foreign key(calendar_arm_id,calendar_period_id)
    references allrice_native_calendar_arms(arm_id,period_id),
  add constraint native_calendar_occurrence_kind check ((
    (calendar_period_id is null and calendar_arm_id is null and not (payload->'control' ? 'binding')
      and payload->'control'->>'kind' is distinct from 'calendar')
    or (calendar_period_id is not null and calendar_arm_id is not null
      and payload->'control'->>'kind'='calendar' and payload->'control'->>'binding'='rotating-at-v1')
  ) is true);
alter table allrice_native_recurring_controls add constraint native_calendar_control_journal
  foreign key(partition_id,calendar_last_write_id) references allrice_native_recurring_journal(partition_id,write_id)
  deferrable initially deferred;
alter table allrice_native_recurring_journal add constraint native_calendar_journal_kind check ((
  (mutation->>'kind'<>'calendar' and not (journal ? 'calendarLinks'))
  or (mutation->>'kind'='calendar' and after_snapshot->'control'->>'kind'='calendar'
    and after_snapshot->'control'->>'binding'='rotating-at-v1' and jsonb_typeof(journal->'calendarLinks')='array'
    and ((mutation->>'action'='put_task' and jsonb_array_length(journal->'calendarLinks')=1)
      or (mutation->>'action' in ('session_initializing','session_ready') and jsonb_array_length(journal->'calendarLinks')=0)))
) is true);

create function allrice_native_calendar_arm_commit_fence() returns trigger language plpgsql as $$
declare p allrice_native_calendar_periods; a allrice_native_calendar_arms;
begin
  select * into p from allrice_native_calendar_periods where period_id=new.period_id;
  select * into a from allrice_native_calendar_arms where arm_id=new.arm_id;
  if not exists(select 1 from allrice_native_once_partitions w
    where w.partition_id=p.partition_id and w.reference=new.reference and not w.closed
      and w.owner_id=new.transition_writer->>'ownerId' and w.epoch=(new.transition_writer->>'epoch')::bigint
      and w.token_digest=new.transition_writer->>'tokenDigest' and w.expires_at>clock_timestamp()
      and w.activation @> '{"enabled":true,"storageReady":true,"legacyClockExcluded":true,"controlArtifactApproved":true}'::jsonb) then
    raise exception 'calendar COMMIT writer fence lost' using errcode='P1920';
  end if;
  if a.status='creating' and a.create_writer<>a.transition_writer then
    raise exception 'calendar create writer mismatch' using errcode='23514';
  end if;
  if a.status='absent' and a.absence_proof->>'kind'='fenced_generation' and not exists(
    select 1 from allrice_native_once_close_proofs cp where cp.partition_id=p.partition_id
      and cp.epoch=(a.create_writer->>'epoch')::bigint
      and (a.transition_writer->>'epoch')::bigint>cp.epoch
      and cp.proof->>'kind' in ('public_host_backend_drained','verified_process_exit')
      and (cp.proof->>'epoch')::bigint=cp.epoch
      and cp.proof->>'partitionId'=p.partition_id and cp.proof->>'ownerId'=a.create_writer->>'ownerId'
      and cp.proof->>'tokenDigest'=a.create_writer->>'tokenDigest') then
    raise exception 'calendar absence lacks closed generation' using errcode='23514';
  end if;
  if a.native_task_id is not null and not exists(select 1 from allrice_native_recurring_journal j
    where j.partition_id=p.partition_id and j.control_id=p.control_id and j.write_id=a.last_write_id
      and j.mutation->>'kind'='calendar' and j.mutation->>'action'='put_task'
      and j.journal->'calendarLinks'->0->'arm'=allrice_native_calendar_arm_json(a)
      and j.journal->'calendarLinks'->0->'period'=allrice_native_calendar_period_json(p)
      and j.journal->'calendarLinks'->0->'arm'->>'armId'=a.arm_id::text
      and j.journal->'calendarLinks'->0->'arm'->>'periodId'=p.period_id::text
      and (j.journal->'calendarLinks'->0->'arm'->>'snapshotVersion')::bigint=a.snapshot_version
      and j.journal->'calendarLinks'->0->'arm'->'taskSnapshot'=a.task_snapshot
      and j.journal->'calendarLinks'->0->'arm'->>'nativeTaskId'=a.native_task_id
      and j.journal->'calendarLinks'->0->'arm'->>'requestDigest'=a.request_digest
      and j.journal->'calendarLinks'->0->'arm'->>'bindWriteId'=a.bind_write_id
      and (j.journal->'calendarLinks'->0->'period'->>'version')::bigint=p.version
      and j.journal->'calendarLinks'->0->'period'->>'currentArmId'=a.arm_id::text
      and exists(select 1 from allrice_native_recurring_journal b where b.partition_id=p.partition_id and b.write_id=a.bind_write_id
        and b.mutation->>'kind'='calendar' and b.mutation->>'action'='put_task'
        and b.journal->'writer'=a.create_writer
        and b.journal->'calendarLinks'->0->'arm'->>'armId'=a.arm_id::text
        and b.journal->'calendarLinks'->0->'arm'->>'nativeTaskId'=a.native_task_id
        and b.journal->'calendarLinks'->0->'arm'->>'bindWriteId'=b.write_id
        and b.journal->'calendarLinks'->0->'arm'->'taskSnapshot'->>'status'='active'
        and b.journal->'calendarLinks'->0->'arm'->'taskSnapshot'->'record'=a.task_snapshot->'record')) then
    raise exception 'calendar Task/arm/journal COMMIT proof lost' using errcode='23514';
  end if;
  if a.status='received' and not exists(select 1 from allrice_native_recurring_occurrences o
    where o.calendar_period_id=p.period_id and o.calendar_arm_id=a.arm_id
      and o.payload->>'nativeTaskId'=a.native_task_id and o.scheduled_at=a.native_at
      and o.payload->'receipt'=coalesce(a.task_snapshot->'deliveryHistory'->'records'->0,a.task_snapshot->'lastDelivery')) then
    raise exception 'calendar received Task lacks atomic occurrence' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_arm_commit_fence after insert or update on allrice_native_calendar_arms
  deferrable initially deferred for each row execute function allrice_native_calendar_arm_commit_fence();

create function allrice_native_calendar_parent_commit_fence() returns trigger language plpgsql as $$
begin
  if new.snapshot->'control'->>'kind'='calendar' and not exists(select 1 from allrice_native_once_partitions p
    where p.partition_id=new.partition_id and p.reference=new.snapshot->'control'->'reference') then
    raise exception 'calendar approved parent reference changed' using errcode='23514';
  end if;
  if new.snapshot->'control'->>'kind'='calendar' and not exists(select 1 from allrice_native_recurring_versions v
    where v.automation_id=new.automation_id and v.revision=(new.snapshot->'control'->>'revision')::bigint
      and allrice_native_calendar_revision_valid(v.configuration)) then
    raise exception 'calendar parent lacks exact immutable revision' using errcode='23514';
  end if;
  if new.snapshot->'control'->>'kind'='calendar' and new.calendar_last_write_id is not null and not exists(
    select 1 from allrice_native_recurring_journal j where j.partition_id=new.partition_id
      and j.control_id=new.control_id and j.write_id=new.calendar_last_write_id and j.after_snapshot=new.snapshot
      and j.mutation->>'kind'='calendar' and j.mutation->>'action' in ('session_initializing','session_ready')
      and (j.mutation->>'expectedControlVersion')::bigint=new.snapshot_version-1) then
    raise exception 'calendar parent/session journal COMMIT proof lost' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_parent_commit_fence after insert or update on allrice_native_recurring_controls
  deferrable initially deferred for each row execute function allrice_native_calendar_parent_commit_fence();

create function allrice_native_calendar_journal_commit_fence() returns trigger language plpgsql as $$
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
  elsif (c.calendar_last_write_id=new.write_id
    and (new.mutation->>'expectedControlVersion')::bigint=c.snapshot_version-1
    and jsonb_array_length(new.journal->'receiptLinks')=0) is not true then
    raise exception 'calendar journal exact session link lost' using errcode='23514';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_journal_commit_fence after insert on allrice_native_recurring_journal
  deferrable initially deferred for each row execute function allrice_native_calendar_journal_commit_fence();

-- The public Task document shares one ID namespace with fixed recurring rows.
-- Serializing its two SQL representations on the existing partition prevents a
-- Task ID being claimed concurrently in both tables. No fixed rule is widened.
create function allrice_native_calendar_task_namespace_guard() returns trigger language plpgsql as $$
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
      where p.partition_id=task_partition and a.native_task_id is not null) into task_count;
  if tg_op='INSERT' then task_count:=task_count+1;
  elsif old.native_task_id is null then task_count:=task_count+1;
  end if;
  if task_count>10000 then raise exception 'native Task document capacity exhausted' using errcode='23514'; end if;
  return new;
end $$;
create trigger native_calendar_arm_task_namespace before insert or update on allrice_native_calendar_arms
  for each row execute function allrice_native_calendar_task_namespace_guard();
create trigger native_calendar_fixed_task_namespace before insert or update on allrice_native_recurring_controls
  for each row execute function allrice_native_calendar_task_namespace_guard();

create function allrice_native_calendar_occurrence_commit_fence() returns trigger language plpgsql as $$
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
  if new.calendar_period_id is not null and new.outbox_state='enqueued' then
    raise exception 'calendar business handoff is disabled in protocol slice' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_occurrence_commit_fence after insert or update on allrice_native_recurring_occurrences
  deferrable initially deferred for each row execute function allrice_native_calendar_occurrence_commit_fence();
create function allrice_native_calendar_no_business_run() returns trigger language plpgsql as $$
begin
  if new.native_recurring_occurrence_id is not null and exists(select 1 from allrice_native_recurring_occurrences o
    where o.occurrence_id=new.native_recurring_occurrence_id and o.calendar_period_id is not null) then
    raise exception 'calendar business Run is disabled in protocol slice' using errcode='P1921';
  end if;
  return new;
end $$;
create constraint trigger native_calendar_no_business_run after insert or update on allrice_automation_runs
  deferrable initially deferred for each row execute function allrice_native_calendar_no_business_run();
