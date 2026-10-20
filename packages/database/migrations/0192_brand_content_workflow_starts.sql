create table allrice_brand_content_workflow_starts (
  id uuid primary key,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  instance_id uuid not null references allrice_employee_instances(id),
  brand_id uuid not null references allrice_brand_content_brands(id),
  request_id uuid not null,
  request_digest text not null check (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  request jsonb not null,
  invocation jsonb not null,
  session_id uuid not null,
  run_id uuid references allrice_runs(id),
  created_at timestamptz not null default now(),
  unique (organization_id,workspace_id,owner_id,instance_id,request_id)
);
create index allrice_brand_content_workflow_starts_session
  on allrice_brand_content_workflow_starts(session_id,request_id);
