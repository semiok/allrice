-- Reuse native Ask User and its adopted-input proof. This receipt binds an
-- exact personal candidate, tests and the server-authored question, not a new
-- approval engine or another queue.
create table allrice_employee_method_activations (
  id uuid primary key,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  instance_id uuid not null references allrice_employee_instances(id),
  session_id uuid not null references allrice_chat_sessions(id),
  source_run_id uuid not null references allrice_employee_runs(run_id),
  source_job_id uuid not null references allrice_jobs(id),
  source_attempt integer not null,
  request_digest text not null,
  snapshot jsonb not null,
  snapshot_digest text not null,
  question jsonb not null,
  question_id text,
  question_turn_id text,
  question_generation integer,
  presented_at timestamptz,
  expires_at timestamptz not null default clock_timestamp() + interval '30 minutes',
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  answer_message_id uuid references allrice_messages(id),
  response jsonb,
  check ((presented_at is null) = (question_id is null)),
  check ((consumed_at is null) = (response is null)),
  unique(source_run_id, question_id)
);
create index allrice_employee_method_activations_owner_idx on
  allrice_employee_method_activations(organization_id,workspace_id,owner_id,instance_id,created_at desc);
