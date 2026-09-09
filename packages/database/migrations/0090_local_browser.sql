-- P22: reuse the P21 workspace, control fence, operation ledger and approval
-- model. Device browser permission is independent from local file permission.
-- Additive and disabled by default; no existing cloud grant is widened.
alter table allrice_browser_control_grants
  add column transport text not null default 'cloud'
    check (transport in ('cloud', 'local'));
alter table allrice_browser_workspaces
  add column transport text not null default 'cloud'
    check (transport in ('cloud', 'local')),
  alter column task_id drop not null,
  add constraint allrice_browser_workspace_transport_task check (
    (transport = 'cloud' and task_id is not null)
    or (transport = 'local' and task_id is null)
  );

alter table allrice_bridge_devices
  add constraint allrice_bridge_devices_owner_scope_key
  unique (organization_id, workspace_id, id, owner_id);

create table allrice_local_browser_grants (
  grant_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  device_id uuid not null,
  logical_profile_id uuid not null unique,
  logical_profile_revision integer not null default 1
    check (logical_profile_revision > 0),
  persist_login boolean not null default false,
  cleanup_requested_at timestamptz,
  cleanup_confirmed_at timestamptz,
  cleanup_error_code text check (cleanup_error_code in (
    'LOCAL_BROWSER_UNAVAILABLE', 'LOCAL_BROWSER_DISABLED',
    'LOCAL_BROWSER_LEASE_LOST', 'LOCAL_BROWSER_CONTROL_CHANGED',
    'LOCAL_BROWSER_POLICY_DENIED', 'LOCAL_BROWSER_STALE_OBSERVATION',
    'LOCAL_BROWSER_INPUT_INVALID', 'LOCAL_BROWSER_OUTPUT_LIMIT',
    'LOCAL_BROWSER_IO_UNKNOWN', 'LOCAL_BROWSER_PROFILE_UNSAFE',
    'LOCAL_BROWSER_CLEANUP_PENDING'
  )),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, grant_id)
    references allrice_browser_control_grants(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, device_id, owner_id)
    references allrice_bridge_devices(organization_id, workspace_id, id, owner_id),
  unique (organization_id, workspace_id, grant_id),
  check (cleanup_confirmed_at is null or cleanup_requested_at is not null)
);

-- A controller gets one short server lease. Keeping the exact lease token after
-- expiry permits authenticated stop/outcome reconciliation, never a new START.
-- Lost claim responses can be recovered only by the same controller instance.
create table allrice_local_browser_workspaces (
  browser_workspace_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  device_id uuid not null,
  grant_id uuid not null,
  request_digest text not null check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  controller_id uuid,
  controller_lease_token uuid,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, browser_workspace_id)
    references allrice_browser_workspaces(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, grant_id)
    references allrice_local_browser_grants(organization_id, workspace_id, grant_id),
  foreign key (organization_id, workspace_id, device_id, owner_id)
    references allrice_bridge_devices(organization_id, workspace_id, id, owner_id),
  check ((controller_id is null and controller_lease_token is null
      and lease_expires_at is null and claimed_at is null)
    or (controller_id is not null and controller_lease_token is not null
      and lease_expires_at is not null and claimed_at is not null))
);
-- One physical profile cannot be driven by concurrent Run controllers. Unknown
-- close does not release it. A fresh grant uses a fresh logical profile ID.
create unique index allrice_local_browser_profile_busy
  on allrice_local_browser_workspaces(grant_id) where released_at is null;
create index allrice_local_browser_device_pending
  on allrice_local_browser_workspaces(device_id, created_at)
  where released_at is null;

create table allrice_local_browser_captures (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  browser_workspace_id uuid not null,
  fence integer not null check (fence > 0),
  observation_id uuid,
  operation_id uuid,
  kind text not null check (kind in ('screenshot', 'download')),
  object_id uuid not null references allrice_storage_objects(id),
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, browser_workspace_id)
    references allrice_browser_workspaces(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, operation_id)
    references allrice_runtime_operations(organization_id, workspace_id, id),
  check ((kind = 'screenshot' and observation_id is not null)
    or (kind = 'download' and operation_id is not null)),
  unique (browser_workspace_id, observation_id, kind),
  unique (browser_workspace_id, operation_id, kind)
);

create table allrice_local_browser_operation_io (
  operation_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  browser_workspace_id uuid not null,
  input_consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, operation_id)
    references allrice_runtime_operations(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, browser_workspace_id)
    references allrice_browser_workspaces(organization_id, workspace_id, id)
);

create function allrice_local_browser_identity_immutable()
returns trigger language plpgsql as $$
begin
  if old.organization_id is distinct from new.organization_id
    or old.workspace_id is distinct from new.workspace_id
    or old.owner_id is distinct from new.owner_id
    or old.device_id is distinct from new.device_id
    or old.grant_id is distinct from new.grant_id then
    raise exception 'local browser identity is immutable';
  end if;
  if tg_table_name = 'allrice_local_browser_grants' and
    (to_jsonb(old) - array['cleanup_requested_at','cleanup_confirmed_at','cleanup_error_code'])
      is distinct from
    (to_jsonb(new) - array['cleanup_requested_at','cleanup_confirmed_at','cleanup_error_code']) then
    raise exception 'local browser profile binding is immutable';
  end if;
  if tg_table_name = 'allrice_local_browser_workspaces' and
    ((to_jsonb(old)->'browser_workspace_id') is distinct from (to_jsonb(new)->'browser_workspace_id')
    or ((to_jsonb(old)->>'controller_lease_token') is not null and
      ((to_jsonb(old)->'controller_lease_token') is distinct from (to_jsonb(new)->'controller_lease_token')
      or (to_jsonb(old)->'controller_id') is distinct from (to_jsonb(new)->'controller_id')
      or (to_jsonb(old)->'claimed_at') is distinct from (to_jsonb(new)->'claimed_at')))) then
    raise exception 'local browser controller identity is immutable';
  end if;
  return new;
end; $$;
create trigger allrice_local_browser_grant_identity
  before update on allrice_local_browser_grants for each row
  execute function allrice_local_browser_identity_immutable();
create trigger allrice_local_browser_workspace_identity
  before update on allrice_local_browser_workspaces for each row
  execute function allrice_local_browser_identity_immutable();
