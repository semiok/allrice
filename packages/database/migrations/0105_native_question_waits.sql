-- Additive, server-owned continuation checkpoints. No browser/model writes.
create table allrice_native_question_waits (
  run_id uuid not null references allrice_task_clocks(run_id),
  question_id text not null,
  checkpoint jsonb not null,
  config_checksum text not null,
  generation integer not null check(generation >= 0),
  state text not null check(state in ('parked','ready','continued')),
  created_at timestamptz not null default clock_timestamp(),
  continued_at timestamptz,
  primary key(run_id,question_id)
);
create unique index allrice_native_question_waits_open on allrice_native_question_waits(run_id) where state <> 'continued';

create table allrice_native_task_dispatches (
  run_id uuid not null references allrice_task_clocks(run_id),
  attempt integer not null check(attempt>0),
  state text not null check(state in ('started','parked','completed')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,attempt)
);
