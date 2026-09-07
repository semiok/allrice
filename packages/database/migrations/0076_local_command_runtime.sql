-- P05: explicit opt-in profile, independent of legacy Bridge capabilities.
alter table allrice_bridge_devices add constraint allrice_bridge_devices_scope_key
  unique (organization_id, workspace_id, id);
create table allrice_bridge_runtime_profiles (
  device_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  profile jsonb not null,
  reported_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, device_id)
    references allrice_bridge_devices(organization_id, workspace_id, id)
);

-- Output is bounded evidence for one immutable operation attempt, not state authority.
create table allrice_runtime_operation_output (
  operation_id uuid not null references allrice_runtime_operations(id),
  sequence integer not null check (sequence between 0 and 255),
  stream text not null check (stream in ('stdout','stderr')),
  content text not null check (octet_length(content) <= 65536),
  created_at timestamptz not null default now(),
  primary key (operation_id, sequence)
);
