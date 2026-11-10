-- Ordinary fixed schedules pause through the public native delete, and resume
-- through public create. The business/control/Session identity never changes.
-- Old native IDs remain reserved by their immutable journal, not current binding.
create or replace function allrice_native_recurring_control_guard() returns trigger language plpgsql as $$
declare rebind boolean;
begin
  rebind := old.native_task_id is not null and new.native_task_id is null
    and old.snapshot->'control'->>'kind'='recurring'
    and not (old.snapshot->'control'->'dispatch' ? 'consumer')
    and old.snapshot->'control'->>'taskDeleted'='true'
    and old.snapshot->'control'->'command'->>'kind'='delete'
    and old.snapshot->'control'->'command'->>'status'='confirmed'
    and old.snapshot->'task'='null'::jsonb and new.snapshot->'task'='null'::jsonb
    and new.snapshot->'control'->>'taskDeleted'='false'
    and new.snapshot->'control'->'appliedRevision'='null'::jsonb
    and new.snapshot->'control'->'appliedRule'='null'::jsonb
    and new.snapshot->'control'->'command'->>'kind'='create'
    and new.snapshot->'control'->'command'->>'status'='pending'
    and ((new.snapshot->'control')-array['nativeTaskId','taskDeleted','appliedRevision','appliedRule','command'])
      = ((old.snapshot->'control')-array['nativeTaskId','taskDeleted','appliedRevision','appliedRule','command'])
    and exists(select 1 from allrice_native_recurring_journal j
      where j.partition_id=old.partition_id and j.control_id=old.control_id
        and j.mutation->>'kind'='delete_task'
        and j.mutation->>'nativeTaskId'=old.native_task_id
        and j.after_snapshot->'control'->>'taskDeleted'='true'
        and j.after_snapshot->'task'='null'::jsonb)
    and exists(select 1 from allrice_native_recurring_operations o
      join allrice_automations p on p.id=o.automation_id
      where o.automation_id=old.automation_id and o.status='pending'
        and o.operation_id::text=new.snapshot->'control'->'command'->>'id'
        and o.request->>'action'='resume'
        and o.organization_id=p.organization_id and o.owner_id=p.owner_id
        and (o.request->>'expectedRevision')::bigint=p.revision-1
        and p.status='enabled' and p.deleted_at is null
        and p.native_recurring_resume_after is not null);
  if new.partition_id<>old.partition_id or new.control_id<>old.control_id
    or new.automation_id<>old.automation_id or new.control_session_id<>old.control_session_id
    or new.immutable_identity<>old.immutable_identity
    or ((old.native_task_id is not null and new.native_task_id is distinct from old.native_task_id)
      and rebind is not true)
    or ((old.snapshot->'control'->>'taskDeleted'='true' and new.snapshot->'control'->>'taskDeleted' is distinct from 'true')
      and rebind is not true)
    or new.snapshot_version<>old.snapshot_version+1 then
    raise exception 'native recurring immutable control mapping' using errcode='23514';
  end if;
  return new;
end $$;

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
  if exists(select 1 from allrice_native_recurring_journal j where j.partition_id=task_partition
      and j.mutation->>'kind'='put_task' and j.mutation->'task'->'record'->>'id'=new.native_task_id)
    or (tg_table_name='allrice_native_calendar_arms' and exists(select 1 from allrice_native_recurring_controls c
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

-- A stopped ordinary monthly Task may commit its in-flight native receipt
-- without projecting user history. Keep the exact arm, journal and live writer
-- fences; other calendar consumers still require the atomic occurrence.
create or replace function allrice_native_calendar_arm_commit_fence() returns trigger language plpgsql as $$
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
      and o.payload->'receipt'=coalesce(a.task_snapshot->'deliveryHistory'->'records'->0,a.task_snapshot->'lastDelivery'))
    and not exists(select 1 from allrice_native_recurring_journal j
      join allrice_native_recurring_controls c on c.control_id=j.control_id and c.partition_id=j.partition_id
      where j.partition_id=p.partition_id and j.control_id=p.control_id and j.write_id=a.last_write_id
        and c.snapshot->'control'->'dispatch'->>'consumer'='ordinary-monthly-v1'
        and j.after_snapshot->'control'->'dispatch'->>'consumer'='ordinary-monthly-v1'
        and j.journal->'receiptLinks'='[]'::jsonb
        and j.journal->'unprojectedReceipt'->>'reason' in ('paused_or_deleted','before_resume_watermark')
        and j.journal->'unprojectedReceipt'->'receipt'=
          coalesce(a.task_snapshot->'deliveryHistory'->'records'->0,a.task_snapshot->'lastDelivery')) then
    raise exception 'calendar received Task lacks atomic receipt proof' using errcode='23514';
  end if;
  return new;
end $$;

-- Repair the old logical-pause contract for every ordinary fixed control. Only
-- queue a command: the live writer must perform and journal the public deletion.
-- Do not edit native snapshots, receipts, old operations or user history here.
update allrice_native_recurring_controls c set
  snapshot=jsonb_set(c.snapshot,'{control,command}',
    (c.snapshot->'control'->'command') || '{"kind":"delete","status":"pending"}'::jsonb),
  snapshot_version=c.snapshot_version+1
from allrice_automations p
where p.id=c.automation_id and p.status='paused'
  and c.snapshot->'control'->>'kind'='recurring'
  and not (c.snapshot->'control'->'dispatch' ? 'consumer')
  and c.snapshot->'control'->>'taskDeleted'='false'
  and c.snapshot->'control'->'command'->>'kind'<>'delete';
