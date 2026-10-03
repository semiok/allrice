-- MET166 PR3a: a task's current source version. All bytes and version identity
-- stay in the existing private StorageObject / DeliverableVersion system.
create table allrice_project_workspace_heads (
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  root_run_id uuid not null,
  project_id uuid not null,
  head_artifact_id uuid not null references allrice_deliverable_versions(id),
  head_checksum text not null check(head_checksum ~ '^sha256:[a-f0-9]{64}$'),
  revision integer not null default 0 check(revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (root_run_id,project_id),
  foreign key(organization_id,workspace_id,root_run_id)
    references allrice_runtime_roots(organization_id,workspace_id,root_run_id)
);
