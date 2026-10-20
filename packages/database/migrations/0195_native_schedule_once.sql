-- Native once keeps the existing business Run/Job queue and automation history.
-- Clock activation and the exact native artifact are supplied by the Worker.
alter table allrice_automations
  add column clock_owner text not null default 'legacy' check(clock_owner in ('legacy','native_once')),
  add column native_once_request_id uuid,
  add column native_once_request_digest text,
  add column native_once_cancelled_at timestamptz,
  add constraint native_once_request_shape check ((
    (clock_owner='legacy' and native_once_request_id is null and native_once_request_digest is null and native_once_cancelled_at is null)
    or (clock_owner='native_once' and trigger_type='schedule' and schedule->>'frequency'='once'
      and conversation_mode='reuse' and employee_assignment_id is not null and session_id is not null
      and native_once_request_id is not null and native_once_request_digest ~ '^sha256:[a-f0-9]{64}$')) is true);
create unique index native_once_request on allrice_automations(organization_id,owner_id,native_once_request_id)
  where clock_owner='native_once';
create table allrice_native_once_partitions (
  partition_id text primary key,
  reference jsonb not null check (jsonb_typeof(reference)='object'),
  activation jsonb not null default '{}'::jsonb,
  workspace_snapshot jsonb check (workspace_snapshot is null or ((
    jsonb_typeof(workspace_snapshot)='object'
    and workspace_snapshot->>'unitVersion'='2'
    and jsonb_typeof(workspace_snapshot->'revision')='number'
    and (workspace_snapshot->>'revision')::numeric between 0 and 9007199254740991
    and octet_length(workspace_snapshot::text)<=2097152) is true)),
  owner_id text,
  epoch bigint not null default 0 check (epoch between 0 and 9007199254740991),
  token_digest text check (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  expires_at timestamptz,
  closed boolean not null default true,
  close_proof jsonb not null default '{"kind":"never_acquired"}'::jsonb,
  check ((epoch=0 and owner_id is null and token_digest is null and expires_at is null and closed)
    or (epoch>0 and owner_id is not null and token_digest is not null and expires_at is not null)),
  check (closed or close_proof='null'::jsonb)
);

create table allrice_native_once_close_proofs (
  partition_id text not null references allrice_native_once_partitions,
  epoch bigint not null,
  proof_id text not null,
  proof jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(partition_id,epoch),
  unique(proof_id)
);

-- immutable_control retains the original frozen tenant/revision/dispatch map.
-- The complete task is in snapshot and every successful version is journaled.
create table allrice_native_once_controls (
  partition_id text not null references allrice_native_once_partitions,
  control_id text not null,
  automation_id uuid not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  control_session_id text not null unique,
  native_task_id text unique,
  occurrence_id text not null unique,
  client_message_id text not null unique,
  immutable_control jsonb not null,
  snapshot jsonb not null,
  snapshot_version bigint not null default 0 check(snapshot_version>=0),
  primary key(partition_id,control_id),
  unique(automation_id,revision),
  foreign key(automation_id) references allrice_automations(id),
  unique(partition_id,control_id,automation_id,revision),
  check((snapshot->'control'->>'partitionId'=partition_id) is true),
  check((snapshot->'control'->>'controlId'=control_id) is true),
  check(((snapshot->'control'->>'automationId')::uuid=automation_id) is true),
  check(((snapshot->'control'->>'revision')::bigint=revision) is true),
  check((snapshot->'control'->>'controlSessionId'=control_session_id) is true),
  check((snapshot->'control'->>'nativeTaskId') is not distinct from native_task_id),
  check((snapshot->'control'->'dispatch'->>'occurrenceId'=occurrence_id) is true),
  check((snapshot->'control'->'dispatch'->>'clientMessageId'=client_message_id) is true),
  check(((snapshot->'control')-array['sessionState','nativeTaskId','taskDeleted','command']
      = immutable_control-array['sessionState','nativeTaskId','taskDeleted','command']) is true)
);

create table allrice_native_once_occurrences (
  occurrence_id text primary key,
  partition_id text not null,
  control_id text not null,
  automation_id uuid not null,
  revision bigint not null,
  scheduled_at text not null,
  occurrence_key text not null unique,
  payload_digest text not null check(payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null,
  outbox_state text not null check(outbox_state in ('pending','blocked','enqueued')),
  outbox_reason text,
  -- Separate consumer ownership; never a Host writer or business Job lease.
  outbox_owner_id text,
  outbox_epoch bigint not null default 0 check(outbox_epoch>=0),
  outbox_token_digest text,
  outbox_expires_at timestamptz,
  business_binding jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(automation_id,revision,scheduled_at),
  unique(partition_id,control_id,occurrence_id),
  foreign key(partition_id,control_id,automation_id,revision)
    references allrice_native_once_controls(partition_id,control_id,automation_id,revision),
  check((payload->'control'->>'partitionId'=partition_id) is true),
  check((payload->'control'->>'controlId'=control_id) is true),
  check(((payload->'control'->>'automationId')::uuid=automation_id) is true),
  check(((payload->'control'->>'revision')::bigint=revision) is true),
  check((payload->'control'->'dispatch'->>'occurrenceId'=occurrence_id) is true),
  check((payload->'receipt'->>'scheduledAt'=scheduled_at) is true),
  check((outbox_state='pending' and outbox_reason is null and business_binding is null)
    or (outbox_state='blocked' and outbox_reason is not null and business_binding is null)
    or (outbox_state='enqueued' and outbox_reason is null and business_binding is not null)),
  check((outbox_owner_id is null and outbox_token_digest is null and outbox_expires_at is null)
    or (outbox_owner_id is not null and outbox_epoch>0 and outbox_token_digest is not null and outbox_expires_at is not null))
);

create table allrice_native_once_journal (
  partition_id text not null,
  write_id text not null,
  entry_kind text not null default 'control' check(entry_kind in ('control','workspace')),
  control_id text,
  writer_owner_id text not null,
  writer_epoch bigint not null,
  writer_token_digest text not null,
  reference jsonb not null,
  write_digest text not null,
  mutation jsonb not null,
  journal jsonb not null,
  after_snapshot jsonb not null,
  after_digest text not null,
  occurrence_id text,
  committed_at timestamptz not null default clock_timestamp(),
  primary key(partition_id,write_id),
  check(((entry_kind='control' and control_id is not null)
    or (entry_kind='workspace' and control_id is null and occurrence_id is null
      and jsonb_typeof(after_snapshot)='object' and after_snapshot->'unitVersion'='2'::jsonb
      and jsonb_typeof(journal)='object' and journal->>'kind'='workspace'
      and journal->'unitVersion'='2'::jsonb
      and journal->'write'->'mutation'=mutation
      and ((mutation->>'kind' in ('put_record','delete_record') and mutation->>'table'='workspaces')
        or mutation->>'kind'='set_global')
      and octet_length(after_snapshot::text)<=2097152
      and octet_length(journal::text)<=4194304)) is true),
  foreign key(partition_id) references allrice_native_once_partitions,
  foreign key(partition_id,control_id)
    references allrice_native_once_controls(partition_id,control_id),
  foreign key(partition_id,control_id,occurrence_id)
    references allrice_native_once_occurrences(partition_id,control_id,occurrence_id)
);

create function allrice_native_once_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'native once immutable history' using errcode='23514';
end $$;
create trigger native_once_journal_immutable before update or delete on allrice_native_once_journal
  for each row execute function allrice_native_once_immutable();
create trigger native_once_close_proof_immutable before update or delete on allrice_native_once_close_proofs
  for each row execute function allrice_native_once_immutable();

create function allrice_native_once_partition_guard() returns trigger language plpgsql as $$
begin
  if new.partition_id<>old.partition_id or new.reference<>old.reference then
    raise exception 'native once reference is immutable' using errcode='23514';
  end if;
  if new.epoch=old.epoch then
    if new.owner_id is distinct from old.owner_id or new.token_digest is distinct from old.token_digest
      or (old.closed and not new.closed) or (old.closed and new.close_proof<>old.close_proof) then
      raise exception 'native once epoch fence' using errcode='23514';
    end if;
  elsif new.epoch<>old.epoch+1 or not old.closed or new.closed
    or new.owner_id is null or new.token_digest is null then
    raise exception 'native once acquire requires explicit close' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_once_partition_guard before update on allrice_native_once_partitions
  for each row execute function allrice_native_once_partition_guard();

create function allrice_native_once_control_guard() returns trigger language plpgsql as $$
begin
  if new.partition_id<>old.partition_id or new.control_id<>old.control_id
    or new.automation_id<>old.automation_id or new.revision<>old.revision
    or new.control_session_id<>old.control_session_id or new.occurrence_id<>old.occurrence_id
    or new.client_message_id<>old.client_message_id or new.immutable_control<>old.immutable_control
    or (old.native_task_id is not null and new.native_task_id is distinct from old.native_task_id)
    or (old.snapshot->'control'->>'taskDeleted'='true' and new.snapshot->'control'->>'taskDeleted' is distinct from 'true')
    or new.snapshot_version<>old.snapshot_version+1 then
    raise exception 'native once immutable revision/task mapping' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_once_control_guard before update on allrice_native_once_controls
  for each row execute function allrice_native_once_control_guard();

create function allrice_native_once_occurrence_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['outbox_state','outbox_reason','outbox_owner_id','outbox_epoch','outbox_token_digest','outbox_expires_at','business_binding'])
    <> (to_jsonb(old)-array['outbox_state','outbox_reason','outbox_owner_id','outbox_epoch','outbox_token_digest','outbox_expires_at','business_binding'])
    or (old.outbox_state in ('blocked','enqueued') and new.outbox_state<>old.outbox_state)
    or (old.business_binding is not null and new.business_binding is distinct from old.business_binding)
    or new.outbox_epoch<old.outbox_epoch then
    raise exception 'native once immutable occurrence/outbox cannot rewind' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_once_occurrence_guard before update on allrice_native_once_occurrences
  for each row execute function allrice_native_once_occurrence_guard();
create trigger native_once_occurrence_no_delete before delete on allrice_native_once_occurrences
  for each row execute function allrice_native_once_immutable();
create trigger native_once_control_no_delete before delete on allrice_native_once_controls
  for each row execute function allrice_native_once_immutable();

-- Check again while COMMIT processes deferred events, after any earlier write
-- or lock wait. The partition UPDATE lock remains held until COMMIT/ROLLBACK.
-- Historical readback/replay does not insert a journal and grants no new work.
create function allrice_native_once_commit_fence() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from allrice_native_once_partitions p
    where p.partition_id=new.partition_id and p.owner_id=new.writer_owner_id
      and p.epoch=new.writer_epoch and p.token_digest=new.writer_token_digest
      and not p.closed and p.expires_at>clock_timestamp() and p.reference=new.reference
      and p.activation @> '{"enabled":true,"storageReady":true,"legacyClockExcluded":true,"controlArtifactApproved":true}'::jsonb) then
    raise exception 'native once COMMIT writer fence lost' using errcode='P1920';
  end if;
  return new;
end $$;
create constraint trigger native_once_commit_fence after insert on allrice_native_once_journal
  deferrable initially deferred for each row execute function allrice_native_once_commit_fence();

-- The business side is associated exactly once, never with a second queue.
alter table allrice_automation_runs add column native_once_occurrence_id text
  unique references allrice_native_once_occurrences(occurrence_id);
create index native_once_pending_dispatch on allrice_native_once_occurrences(created_at,occurrence_id)
  where outbox_state='pending';

-- The dispatcher lease is independent from the native Host lease. Check its
-- actual DB wall-clock at COMMIT, not only before creating the ordinary Run.
-- Any loss rolls back messages, queue rows and the receipt binding together.
create function allrice_native_once_dispatch_commit_fence() returns trigger language plpgsql as $$
begin
  if old.outbox_state='pending' and new.outbox_state='enqueued' then
    if new.outbox_owner_id is null or new.outbox_epoch<1 or new.outbox_token_digest is null
      or new.outbox_expires_at<=clock_timestamp()
      or not exists(select 1 from allrice_native_once_occurrences o
        join allrice_automation_runs ar on ar.native_once_occurrence_id=o.occurrence_id and ar.automation_id=o.automation_id
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
      raise exception 'native once COMMIT dispatch fence lost' using errcode='P1921';
    end if;
  end if;
  return new;
end $$;
create constraint trigger native_once_dispatch_commit_fence after update on allrice_native_once_occurrences
  deferrable initially deferred for each row execute function allrice_native_once_dispatch_commit_fence();
