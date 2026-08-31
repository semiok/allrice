create table allrice_bridge_workspace_selection_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null references allrice_bridge_devices(id),
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'succeeded', 'failed', 'canceled'
  )),
  lease_token uuid,
  selected_grant_id uuid references allrice_bridge_folder_grants(id),
  error_code text,
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id)
);

create unique index allrice_bridge_workspace_selection_active
  on allrice_bridge_workspace_selection_requests (device_id)
  where status in ('queued', 'claimed');

create index allrice_bridge_workspace_selection_queue
  on allrice_bridge_workspace_selection_requests (device_id, status, requested_at)
  where status in ('queued', 'claimed');

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-workspace-selection',
  '{"version":"0042","issue":"MET-89","mode":"native-macos-picker"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
