-- Private case records bind existing employee Runs. There is no second executor.
create table allrice_platform_quality_deployments (
  workspace_id uuid primary key references allrice_workspaces(id),
  organization_id uuid not null references allrice_organizations(id),
  owner_id uuid not null references allrice_users(id),
  employee_id uuid not null references allrice_employees(id),
  assignment_id uuid not null unique references allrice_employee_assignments(id),
  employee_version_id uuid not null references allrice_employee_versions(id),
  employee_revision_id uuid not null references allrice_platform_employee_revisions(id)
);
create table allrice_platform_quality_checks (
  id uuid primary key,
  request_id uuid not null,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null unique references allrice_runs(id),
  job_id uuid not null unique references allrice_jobs(id),
  session_id uuid not null unique references allrice_chat_sessions(id),
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  frozen jsonb not null check (jsonb_typeof(frozen)='object'),
  report jsonb,
  created_at timestamptz not null default now(),
  unique(owner_id,request_id)
);
create index allrice_platform_quality_checks_owner_created on allrice_platform_quality_checks(owner_id,created_at desc);
