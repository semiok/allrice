-- Continuing previews keep the existing physical operation and evidence. This
-- lease is independent of the originating model Job, not a new agent/runtime.
create table allrice_project_services (
  id uuid primary key references allrice_runtime_operations(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null references allrice_runs(id),
  session_id uuid not null references allrice_chat_sessions(id),
  backend text not null check (backend in ('local','cloud')),
  device_id uuid references allrice_bridge_devices(id),
  project_ref jsonb not null,
  source_digest text not null check (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  configuration jsonb not null,
  expires_at timestamptz not null,
  hard_deadline_at timestamptz not null,
  heartbeat_at timestamptz,
  stop_requested boolean not null default false,
  pending_update jsonb,
  update_count integer not null default 0 check (update_count between 0 and 8),
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at <= hard_deadline_at),
  check ((backend='local')=(device_id is not null))
);
create index allrice_project_services_owner on allrice_project_services(organization_id,workspace_id,owner_id,session_id);
create table allrice_project_service_controls (
  service_id uuid not null references allrice_project_services(id),
  request_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(service_id,request_id)
);
-- Preview credentials are scoped to the real user session and one service.
-- They never carry a main-site/Bridge credential into project JavaScript.
create table allrice_project_preview_access (
  id uuid primary key,
  service_id uuid not null references allrice_project_services(id),
  user_session_id uuid not null references allrice_sessions(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
