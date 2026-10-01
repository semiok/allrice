-- Independent fixed-runtime authority; never a business-folder grant.
create table allrice_bridge_managed_runtime_grants (
  id uuid primary key,
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null unique references allrice_bridge_devices(id),
  profile_version integer not null check (profile_version=1),
  root_fingerprint text not null check (root_fingerprint ~ '^[a-f0-9]{64}$'),
  runtime_generation integer not null default 1 check (runtime_generation>0),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table allrice_bridge_managed_python_profiles (
  device_id uuid primary key references allrice_bridge_devices(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  profile jsonb not null,
  reported_at timestamptz not null default clock_timestamp()
);
-- Immutable original Tool Broker delegation precedes operation admission. The
-- ledger remains the only execution/status lifecycle; this row records origin.
create table allrice_local_python_delegations (
  operation_id uuid primary key,
  run_id uuid not null references allrice_runs(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  owner_id uuid not null references allrice_users(id),
  device_id uuid not null references allrice_bridge_devices(id),
  call_id text not null check (length(call_id) between 1 and 255),
  tool_name text not null check (tool_name in ('workspace.export.create','python.execute')),
  purpose text not null check (purpose in ('office','python_charts')),
  original_arguments jsonb not null,
  request_digest text not null check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(run_id,call_id),
  check ((purpose='office' and tool_name='workspace.export.create') or (purpose='python_charts' and tool_name='python.execute'))
);
create function allrice_local_python_origin_immutable() returns trigger language plpgsql as $$
begin
  if new is distinct from old then raise exception 'immutable managed Python origin'; end if;
  return new;
end $$;
create trigger allrice_local_python_origin_immutable before update on allrice_local_python_delegations
  for each row execute function allrice_local_python_origin_immutable();
create function allrice_bridge_revoke_managed_runtime() returns trigger language plpgsql as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update allrice_bridge_managed_runtime_grants set revoked_at=new.revoked_at,runtime_generation=runtime_generation+1
      where device_id=new.id and revoked_at is null;
  end if;
  return new;
end $$;
create trigger allrice_bridge_revoke_managed_runtime after update of revoked_at on allrice_bridge_devices
  for each row execute function allrice_bridge_revoke_managed_runtime();

-- Legacy client capability sets remain valid; only a new client opts into Python claims.
alter table allrice_bridge_devices drop constraint if exists allrice_bridge_devices_capabilities_allowed_check;
alter table allrice_bridge_devices add constraint allrice_bridge_devices_capabilities_allowed_check check (capabilities <@ array[
  'local.fs.list','local.fs.search','local.fs.read','local.fs.write','local.fs.mkdir','local.git.status','local.git.diff',
  'local.file.inspect','local.file.import','local.file.save','local.file.open','local.file.reveal','local.file.select','local.python.execute'
]::text[]);
