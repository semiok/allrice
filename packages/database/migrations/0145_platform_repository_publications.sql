-- Private candidate publication facts; the existing Job is the only task state machine.
create table allrice_platform_repository_publications (
  id uuid primary key,
  owner_id uuid not null references allrice_users(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  source_task_id uuid not null references allrice_platform_repair_tasks(id),
  base_sha text not null check (base_sha ~ '^[a-f0-9]{40}$'),
  after_checksum text not null check (after_checksum ~ '^sha256:[a-f0-9]{64}$'),
  source jsonb not null,
  source_digest text not null,
  revision integer not null default 0 check (revision >= 0),
  metadata jsonb,
  steps jsonb not null default '{}'::jsonb,
  remote jsonb,
  ci jsonb,
  ci_evidence jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (owner_id, base_sha, after_checksum)
);
create table allrice_platform_repository_actions (
  id uuid primary key,
  publication_id uuid not null references allrice_platform_repository_publications(id),
  owner_id uuid not null references allrice_users(id),
  request_id uuid not null,
  request jsonb not null,
  input_digest text not null,
  login_session_id uuid not null references allrice_sessions(id),
  login_authenticated_at timestamptz not null,
  credential_revision integer not null check (credential_revision > 0),
  mode text not null check (mode in ('publish','inspect')),
  timeout_ms integer not null check (timeout_ms in (30000,120000)),
  run_id uuid not null unique references allrice_runs(id),
  job_id uuid not null unique references allrice_jobs(id),
  receipt jsonb,
  observation jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (owner_id, request_id)
);
create index allrice_platform_repository_owner_created on allrice_platform_repository_publications(owner_id, created_at desc, id);
create index allrice_platform_repository_action_publication on allrice_platform_repository_actions(publication_id, created_at desc, id);
