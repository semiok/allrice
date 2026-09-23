-- MET-153: allow an explicit unlimited task policy; retain old API/model limits.
-- Existing Runs/snapshots are not rewritten. This migration must precede new code.
alter table allrice_model_resource_limits
  drop constraint allrice_model_resource_limits_max_runtime_ms_check;
alter table allrice_model_resource_limits
  add constraint allrice_model_resource_limits_max_runtime_ms_check
  check (max_runtime_ms = 0 or max_runtime_ms between 1000 and 86400000);

-- Only new server-verified subscription Runs enroll in this clock. There is no
-- migration/backfill that grants old Runs fresh execution time.
create table allrice_task_clocks (
  run_id uuid primary key references allrice_runs(id),
  organization_id uuid not null,
  workspace_id uuid not null,
  policy jsonb not null,
  active_ms double precision not null default 0 check(active_ms >= 0),
  waiting_ms double precision not null default 0 check(waiting_ms >= 0),
  phase text not null default 'queued' check(phase in ('queued','active','waiting','terminal')),
  changed_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key(organization_id,workspace_id,run_id)
    references allrice_runs(organization_id,workspace_id,id)
);

-- Append-only transitions are evidence, not provider usage. Intervals close on
-- every actual state change, so a device reconnect cannot erase old waiting.
create table allrice_task_clock_events (
  id bigserial primary key,
  run_id uuid not null references allrice_task_clocks(run_id),
  phase text not null,
  occurred_at timestamptz not null,
  active_ms double precision not null,
  waiting_ms double precision not null
);
create index allrice_task_clock_events_run on allrice_task_clock_events(run_id,id);

-- Native Ask User is not an action approval. Track its blocking lifetime only;
-- no answer here grants any execution permission.
create table allrice_task_questions (
  run_id uuid not null references allrice_task_clocks(run_id),
  question_id text not null check(length(question_id) between 1 and 240),
  pending boolean not null,
  primary key(run_id,question_id)
);

-- A blocked proposal does not suspend other concurrent calls by its assistant.
create table allrice_task_operation_calls (
  operation_id uuid primary key references allrice_runtime_operations(id),
  run_id uuid not null references allrice_task_clocks(run_id),
  agent_id uuid not null references allrice_runs(id),
  native_call_id text not null check(length(native_call_id) between 1 and 240)
);
