-- P16 extends the existing tenant connector binding; it is not a parallel
-- connector authority. Secrets are AEAD encrypted by a deployment-held key.
create table allrice_mcp_binding_config (
  binding_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  endpoint text not null,
  revision integer not null default 1 check (revision > 0),
  credential_envelope jsonb not null,
  discovery_state text not null default 'idle' check (discovery_state in ('idle','queued','running','ready','error')),
  discovery_code text,
  discovery_owner uuid,
  discovery_token_hash text,
  discovery_lease_expires_at timestamptz,
  checked_at timestamptz,
  foreign key (organization_id, workspace_id, binding_id)
    references allrice_connector_bindings(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, binding_id)
);
create table allrice_mcp_tool_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  binding_id uuid not null,
  tool_name text not null,
  digest text not null check (digest ~ '^sha256:[a-f0-9]{64}$'),
  definition jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, binding_id)
    references allrice_mcp_binding_config(organization_id, workspace_id, binding_id),
  unique (binding_id, tool_name, digest),
  unique (organization_id, workspace_id, binding_id, id)
);
create table allrice_mcp_tool_grants (
  organization_id uuid not null,
  workspace_id uuid not null,
  binding_id uuid not null,
  tool_name text not null,
  revision_id uuid not null,
  available boolean not null default true,
  allowed boolean not null default false,
  grant_revision integer not null default 1 check (grant_revision > 0),
  risk text not null default 'write' check (risk in ('read_only','write','external_send','high_risk_data')),
  granted_by uuid references allrice_users(id),
  updated_at timestamptz not null default now(),
  primary key (binding_id, tool_name),
  foreign key (organization_id, workspace_id, binding_id, revision_id)
    references allrice_mcp_tool_revisions(organization_id, workspace_id, binding_id, id)
);
create index allrice_mcp_discovery_pending on allrice_mcp_binding_config(discovery_state, discovery_lease_expires_at);
