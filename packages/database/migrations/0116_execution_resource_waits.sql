-- Physical execution waiting is distinct from a model/tool usage reservation.
-- Existing audit events retain transitions; this small projection also lets the
-- authoritative task clock distinguish resource waiting from active execution.
create table allrice_task_resource_waits (
  id uuid primary key,
  run_id uuid not null references allrice_runs(id),
  job_id uuid not null references allrice_jobs(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  worker_id uuid not null,
  lease_token uuid not null,
  call_id text not null,
  operation_id uuid,
  state text not null check (state in ('waiting','executing','completed','failed','canceled','unknown')),
  reason text not null check (reason in ('sandbox_capacity','memory_pressure','fair_queue','none')),
  queued_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  backend_id text,
  capacity integer,
  container_id text,
  error_code text
);
create index allrice_task_resource_waits_live on allrice_task_resource_waits(state,queued_at) where finished_at is null;
create index allrice_task_resource_waits_run on allrice_task_resource_waits(run_id,call_id);
create index allrice_execution_diagnostics_run on allrice_audit_events(resource_id,occurred_at)
  where action='execution.diagnostic';
