create table allrice_bridge_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  name text not null check (char_length(name) between 1 and 120),
  platform text not null check (platform = 'macos-arm64'),
  protocol_version integer not null check (protocol_version = 1),
  capabilities text[] not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  check (cardinality(capabilities) between 1 and 16),
  check (capabilities <@ array[
    'local.fs.list', 'local.fs.search', 'local.fs.read',
    'local.git.status', 'local.git.diff'
  ]::text[])
);

create table allrice_bridge_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  device_name text not null check (char_length(device_name) between 1 and 120),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references allrice_bridge_devices(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  check (expires_at > created_at)
);

create table allrice_bridge_folder_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null references allrice_bridge_devices(id),
  label text not null check (char_length(label) between 1 and 120),
  root_fingerprint text not null check (root_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (device_id, root_fingerprint)
);

create table allrice_bridge_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null references allrice_bridge_devices(id),
  folder_grant_id uuid not null references allrice_bridge_folder_grants(id),
  capability text not null check (capability in (
    'local.fs.list', 'local.fs.search', 'local.fs.read',
    'local.git.status', 'local.git.diff'
  )),
  arguments jsonb not null default '{}',
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'running', 'succeeded', 'failed',
    'expired', 'canceled'
  )),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 255),
  lease_token uuid,
  claimed_at timestamptz,
  timeout_at timestamptz not null,
  completed_at timestamptz,
  result jsonb,
  summary text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, idempotency_key)
);

create index allrice_bridge_devices_owner_active
  on allrice_bridge_devices (organization_id, workspace_id, owner_id, last_seen_at desc)
  where revoked_at is null;
create index allrice_bridge_pairing_active
  on allrice_bridge_pairing_codes (code_hash, expires_at)
  where used_at is null;
create index allrice_bridge_grants_device_active
  on allrice_bridge_folder_grants (device_id, created_at)
  where revoked_at is null;
create index allrice_bridge_commands_device_queue
  on allrice_bridge_commands (device_id, status, created_at)
  where status in ('queued', 'claimed', 'running');

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-schema',
  '{"version":"0041","issue":"MET-89","protocol":"1","mode":"local-read-only"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
