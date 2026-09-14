-- Additive two-phase model admission. Existing usage rows retain their meaning.
-- A prepared output hold is not permission to dispatch or proof of execution.
create table allrice_assistant_model_admissions (
  call_id uuid primary key,
  run_id uuid not null references allrice_assistant_instances(run_id),
  root_run_id uuid not null references allrice_assistant_roots(root_run_id),
  requested_output_tokens bigint not null check (requested_output_tokens > 0 and requested_output_tokens <= 9007199254740991),
  granted_output_tokens bigint not null check (granted_output_tokens > 0 and granted_output_tokens <= requested_output_tokens),
  input_tokens bigint check (input_tokens > 0 and input_tokens <= 9007199254740991),
  request_digest text check (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  prepared_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  check ((dispatched_at is null) = (input_tokens is null)),
  check ((dispatched_at is null) = (request_digest is null)),
  check (finished_at is null or dispatched_at is not null)
);
create index allrice_assistant_model_admissions_root on allrice_assistant_model_admissions(root_run_id, run_id);
