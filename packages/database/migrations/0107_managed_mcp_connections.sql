-- Managed connections reuse the existing connector, encrypted credential,
-- discovery lease, employee binding and operation ledger authority.
alter table allrice_mcp_binding_config
  add column managed_by uuid references allrice_users(id),
  add column auth_kind text not null default 'bearer' check(auth_kind in ('none','bearer')),
  add column client_kind text not null default 'sdk' check(client_kind in ('sdk','dsh')),
  add column oauth_envelope jsonb,
  add column oauth_stage text not null default 'none' check(oauth_stage in ('none','preparing','redirect','exchanging','connected','error')),
  add column oauth_state_hash text,
  add column oauth_expires_at timestamptz;
create unique index allrice_mcp_managed_endpoint on allrice_mcp_binding_config(organization_id,workspace_id,managed_by,endpoint)
  where managed_by is not null;

-- Shared applications can be disconnected by one member without revoking the
-- shared service credential. Keep tombstones so discovery cannot reconnect it.
create table allrice_mcp_member_connections (
  organization_id uuid not null,
  workspace_id uuid not null,
  binding_id uuid not null,
  user_id uuid not null references allrice_users(id),
  connected boolean not null default false,
  removed boolean not null default false,
  revision integer not null default 1 check(revision>0),
  disconnected_at timestamptz not null default clock_timestamp(),
  primary key(binding_id,user_id),
  foreign key(organization_id,workspace_id,binding_id)
    references allrice_connector_bindings(organization_id,workspace_id,id)
);

create table allrice_mcp_connection_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  binding_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  answered_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(run_id,binding_id),
  foreign key(organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,binding_id) references allrice_connector_bindings(organization_id,workspace_id,id)
);
