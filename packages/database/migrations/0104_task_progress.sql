-- MET-153 PR-2. Honest dispatch counters and bounded no-progress state. Only
-- new clock-enrolled, server-verified subscription Runs can use this seam.
create table allrice_task_progress (
  run_id uuid primary key references allrice_task_clocks(run_id),
  state jsonb not null default '{"history":[],"reason":null}',
  pause_id uuid,
  canceled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create table allrice_task_calls (
  run_id uuid not null references allrice_task_clocks(run_id),
  native_session_id text not null,
  call_id text not null,
  kind text not null check(kind in ('model','tool')),
  name text,
  arguments_digest text,
  result_digest text,
  outcome text,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  primary key(run_id,native_session_id,call_id,kind)
);
create index allrice_task_calls_pending on allrice_task_calls(run_id) where finished_at is null;
create index allrice_task_operation_calls_native on allrice_task_operation_calls(run_id,native_call_id,agent_id);
create table allrice_task_progress_decisions (
  run_id uuid not null references allrice_task_clocks(run_id),
  pause_id uuid not null,
  decision text not null check(decision in ('continue','cancel')),
  actor_id uuid not null references allrice_users(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,pause_id)
);
