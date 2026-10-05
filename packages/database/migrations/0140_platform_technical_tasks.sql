-- The existing Run/Job queue owns execution and terminal state.
create table allrice_platform_technical_tasks (
  id uuid primary key,
  request_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  issue_id uuid references allrice_platform_technical_issues(id),
  run_id uuid not null unique references allrice_runs(id),
  job_id uuid not null unique references allrice_jobs(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  environment text not null check (environment in ('dev','prod','test','unknown')),
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  frozen_configuration jsonb not null check (jsonb_typeof(frozen_configuration)='object'),
  attempt_worker_id uuid,
  attempt_lease_digest text,
  observed_usage jsonb,
  usage_complete boolean not null default false,
  cache_usage_known boolean not null default false,
  usage_observed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id,request_id)
);
create index allrice_platform_technical_tasks_created on allrice_platform_technical_tasks(created_at desc,id);
-- Receipts reuse Run events. Uniqueness includes the real Job attempt.
create unique index allrice_platform_technical_tool_receipt_once
  on allrice_run_events(run_id,(payload->>'jobAttempt'),(payload->>'callId'))
  where event_type='tool.completed' and payload->>'source'='platform_technical_receipt';
