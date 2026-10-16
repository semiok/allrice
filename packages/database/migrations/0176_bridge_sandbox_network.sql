-- Explicit device-owner grants, independent of folder/browser/runtime grants.
-- Device reports never create or modify these rows. Disabling/changing a grant
-- increments its version and fences every operation admitted against the old ref.
create table allrice_bridge_sandbox_network_grants (
  id uuid primary key,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null unique references allrice_bridge_devices(id),
  target_id uuid not null references allrice_execution_targets(id),
  version integer not null check (version > 0),
  profile jsonb not null check (jsonb_typeof(profile)='object'),
  enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id,workspace_id) references allrice_workspaces(organization_id,id)
);
