-- Recurring plans use the existing native writer/workspace fence and ordinary
-- Run/Job queue. Once-v1 rows and their immutable one-receipt mapping stay intact.
alter table allrice_automations drop constraint allrice_automations_clock_owner_check;
alter table allrice_automations add constraint allrice_automations_clock_owner_check
  check(clock_owner in ('legacy','native_once','native_recurring'));
alter table allrice_automations
  add column native_recurring_request_id uuid,
  add column native_recurring_request_digest text,
  add column native_recurring_revision bigint,
  add column native_recurring_resume_after timestamptz;
alter table allrice_automations drop constraint native_once_request_shape;
alter table allrice_automations add constraint native_once_request_shape check ((
  (clock_owner='legacy' and native_once_request_id is null and native_once_request_digest is null and native_once_cancelled_at is null)
  or (clock_owner='native_once' and trigger_type='schedule' and schedule->>'frequency'='once'
    and conversation_mode='reuse' and employee_assignment_id is not null and session_id is not null
    and native_once_request_id is not null and native_once_request_digest ~ '^sha256:[a-f0-9]{64}$')
  or (clock_owner='native_recurring' and native_once_request_id is null and native_once_request_digest is null and native_once_cancelled_at is null)) is true);
alter table allrice_automations add constraint native_recurring_request_shape check ((
  (clock_owner<>'native_recurring' and native_recurring_request_id is null and native_recurring_request_digest is null
    and native_recurring_revision is null and native_recurring_resume_after is null)
  or (clock_owner='native_recurring' and trigger_type='schedule' and schedule->>'frequency'='native_recurring'
    and conversation_mode='reuse' and employee_assignment_id is not null and session_id is not null
    and native_recurring_request_id is not null and native_recurring_request_digest ~ '^sha256:[a-f0-9]{64}$'
    and native_recurring_revision between 1 and revision)) is true);
create unique index native_recurring_request on allrice_automations(organization_id,owner_id,native_recurring_request_id)
  where clock_owner='native_recurring';

create table allrice_native_recurring_versions (
  automation_id uuid not null references allrice_automations,
  revision bigint not null check(revision between 1 and 9007199254740991),
  configuration jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(automation_id,revision),
  check(((configuration->>'revision')::bigint=revision) is true),
  check(octet_length(configuration::text)<=196608)
);
create trigger native_recurring_versions_immutable before update or delete on allrice_native_recurring_versions
  for each row execute function allrice_native_once_immutable();

create table allrice_native_recurring_controls (
  partition_id text not null references allrice_native_once_partitions,
  control_id uuid not null,
  automation_id uuid not null unique references allrice_automations,
  control_session_id text not null unique,
  native_task_id text unique,
  immutable_identity jsonb not null,
  snapshot jsonb not null,
  snapshot_version bigint not null default 0 check(snapshot_version>=0),
  primary key(partition_id,control_id),
  unique(partition_id,control_id,automation_id),
  check((snapshot->'control'->>'kind'='recurring') is true),
  check((snapshot->'control'->>'partitionId'=partition_id) is true),
  check((snapshot->'control'->>'controlId'=control_id::text) is true),
  check((snapshot->'control'->>'automationId'=automation_id::text) is true),
  check((snapshot->'control'->>'controlSessionId'=control_session_id) is true),
  check((snapshot->'control'->>'nativeTaskId') is not distinct from native_task_id),
  check(octet_length(snapshot::text)<=196608)
);
create function allrice_native_recurring_control_guard() returns trigger language plpgsql as $$
begin
  if new.partition_id<>old.partition_id or new.control_id<>old.control_id
    or new.automation_id<>old.automation_id or new.control_session_id<>old.control_session_id
    or new.immutable_identity<>old.immutable_identity
    or (old.native_task_id is not null and new.native_task_id is distinct from old.native_task_id)
    or (old.snapshot->'control'->>'taskDeleted'='true' and new.snapshot->'control'->>'taskDeleted' is distinct from 'true')
    or new.snapshot_version<>old.snapshot_version+1 then
    raise exception 'native recurring immutable control mapping' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_recurring_control_guard before update on allrice_native_recurring_controls
  for each row execute function allrice_native_recurring_control_guard();
create trigger native_recurring_control_no_delete before delete on allrice_native_recurring_controls
  for each row execute function allrice_native_once_immutable();

create table allrice_native_recurring_occurrences (
  occurrence_id uuid primary key,
  partition_id text not null,
  control_id uuid not null,
  automation_id uuid not null,
  revision bigint not null,
  scheduled_at timestamptz not null,
  occurrence_key text not null unique,
  client_message_id uuid not null unique,
  payload_digest text not null check(payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null,
  outbox_state text not null check(outbox_state in ('pending','blocked','enqueued')),
  outbox_reason text,
  outbox_owner_id text,
  outbox_epoch bigint not null default 0 check(outbox_epoch>=0),
  outbox_token_digest text,
  outbox_expires_at timestamptz,
  business_binding jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(automation_id,revision,scheduled_at),
  unique(partition_id,control_id,occurrence_id),
  foreign key(partition_id,control_id,automation_id)
    references allrice_native_recurring_controls(partition_id,control_id,automation_id),
  foreign key(automation_id,revision) references allrice_native_recurring_versions,
  check((payload->'control'->>'partitionId'=partition_id) is true),
  check((payload->'control'->>'controlId'=control_id::text) is true),
  check((payload->'control'->>'automationId'=automation_id::text) is true),
  check(((payload->'revision'->>'revision')::bigint=revision) is true),
  check(((payload->'receipt'->>'scheduledAt')::timestamptz=scheduled_at) is true),
  check((outbox_state='pending' and outbox_reason is null and business_binding is null)
    or (outbox_state='blocked' and outbox_reason is not null and business_binding is null)
    or (outbox_state='enqueued' and outbox_reason is null and business_binding is not null)),
  check((outbox_owner_id is null and outbox_token_digest is null and outbox_expires_at is null)
    or (outbox_owner_id is not null and outbox_epoch>0 and outbox_token_digest is not null and outbox_expires_at is not null))
);
-- The generic immutable-payload guard compares column names, not an old table.
create trigger native_recurring_occurrence_guard before update on allrice_native_recurring_occurrences
  for each row execute function allrice_native_once_occurrence_guard();
create trigger native_recurring_occurrence_no_delete before delete on allrice_native_recurring_occurrences
  for each row execute function allrice_native_once_immutable();
create index native_recurring_pending_dispatch on allrice_native_recurring_occurrences(created_at,occurrence_id)
  where outbox_state='pending';

create table allrice_native_recurring_journal (
  partition_id text not null,
  write_id text not null,
  control_id uuid not null,
  writer_owner_id text not null,
  writer_epoch bigint not null,
  writer_token_digest text not null,
  reference jsonb not null,
  write_digest text not null,
  mutation jsonb not null,
  journal jsonb not null,
  after_snapshot jsonb not null,
  after_digest text not null,
  committed_at timestamptz not null default clock_timestamp(),
  primary key(partition_id,write_id),
  foreign key(partition_id,control_id) references allrice_native_recurring_controls,
  check((journal->'write'->'mutation'=mutation) is true),
  check((jsonb_typeof(journal->'receiptLinks')='array') is true)
);
create trigger native_recurring_journal_immutable before update or delete on allrice_native_recurring_journal
  for each row execute function allrice_native_once_immutable();
create constraint trigger native_recurring_commit_fence after insert on allrice_native_recurring_journal
  deferrable initially deferred for each row execute function allrice_native_once_commit_fence();

create table allrice_native_recurring_operations (
  organization_id uuid not null,
  owner_id uuid not null,
  operation_id uuid not null,
  automation_id uuid not null references allrice_automations,
  request jsonb not null,
  request_digest text not null check(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text not null check(status in ('pending','applied','rejected')),
  error_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,owner_id,operation_id),
  check((request->>'operationId'=operation_id::text) is true)
);
create function allrice_native_recurring_operation_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['status','error_message','updated_at'])<>(to_jsonb(old)-array['status','error_message','updated_at'])
    or (old.status<>'pending' and new.status<>old.status)
    or (old.status<>'pending' and new.error_message is distinct from old.error_message) then
    raise exception 'native recurring operation cannot be rewritten' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_recurring_operation_guard before update on allrice_native_recurring_operations
  for each row execute function allrice_native_recurring_operation_guard();
create trigger native_recurring_operation_no_delete before delete on allrice_native_recurring_operations
  for each row execute function allrice_native_once_immutable();

alter table allrice_automation_runs add column native_recurring_occurrence_id uuid
  unique references allrice_native_recurring_occurrences(occurrence_id);
alter table allrice_automation_runs add constraint single_native_occurrence
  check(native_once_occurrence_id is null or native_recurring_occurrence_id is null);
create function allrice_native_recurring_dispatch_commit_fence() returns trigger language plpgsql as $$
begin
  if old.outbox_state='pending' and new.outbox_state='enqueued' then
    if new.outbox_owner_id is null or new.outbox_epoch<1 or new.outbox_token_digest is null
      or new.outbox_expires_at<=clock_timestamp()
      or not exists(select 1 from allrice_native_recurring_occurrences o
        join allrice_automation_runs ar on ar.native_recurring_occurrence_id=o.occurrence_id and ar.automation_id=o.automation_id
        join allrice_jobs j on j.run_id=ar.run_id
        join allrice_employee_runs er on er.run_id=j.run_id and er.session_id=ar.session_id
        where o.occurrence_id=new.occurrence_id and o.outbox_state='enqueued'
          and o.outbox_owner_id=new.outbox_owner_id and o.outbox_epoch=new.outbox_epoch
          and o.outbox_token_digest=new.outbox_token_digest and o.business_binding=new.business_binding
          and j.id::text=new.business_binding->>'jobId' and j.run_id::text=new.business_binding->>'runId'
          and j.organization_id::text=new.business_binding->>'organizationId'
          and j.workspace_id::text=new.business_binding->>'workspaceId' and j.owner_id::text=new.business_binding->>'ownerId'
          and er.session_id::text=new.business_binding->>'sessionId'
          and er.user_message_id::text=new.business_binding->>'userMessageId'
          and er.assistant_message_id::text=new.business_binding->>'assistantMessageId') then
      raise exception 'native recurring COMMIT dispatch fence lost' using errcode='P1921';
    end if;
  end if;
  return new;
end $$;
create constraint trigger native_recurring_dispatch_commit_fence after update on allrice_native_recurring_occurrences
  deferrable initially deferred for each row execute function allrice_native_recurring_dispatch_commit_fence();
