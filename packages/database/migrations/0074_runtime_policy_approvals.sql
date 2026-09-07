-- Additive B1/P04. No policy is enabled or seeded; old approval kinds are unchanged.
-- Old clients reselect a revoked folder using ON CONFLICT and the same ID.
-- A DB-managed generation makes that a new authorization without breaking their wire schema.
alter table allrice_bridge_folder_grants
  add column runtime_generation integer not null default 1 check (runtime_generation > 0);
create function allrice_bridge_grant_runtime_generation() returns trigger language plpgsql as $$
begin
  if new.revoked_at is distinct from old.revoked_at
    or new.root_fingerprint is distinct from old.root_fingerprint
    or new.device_id is distinct from old.device_id
    or new.organization_id is distinct from old.organization_id
    or new.workspace_id is distinct from old.workspace_id
    or new.owner_id is distinct from old.owner_id then
    new.runtime_generation := old.runtime_generation + 1;
  else
    new.runtime_generation := old.runtime_generation;
  end if;
  return new;
end;
$$;
create trigger allrice_bridge_grant_runtime_generation
  before update on allrice_bridge_folder_grants for each row
  execute function allrice_bridge_grant_runtime_generation();

create table allrice_runtime_policy_controls (
  organization_id uuid not null,
  workspace_id uuid not null,
  version integer not null check (version > 0),
  controls jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, workspace_id),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id)
);

alter table allrice_approval_requests
  add column runtime_request jsonb,
  add column runtime_response jsonb,
  add column runtime_binding_digest text,
  add column runtime_control_version integer,
  add column runtime_expires_at timestamptz,
  add column runtime_consumed_at timestamptz,
  add column runtime_revoked_at timestamptz;

alter table allrice_approval_requests add constraint allrice_runtime_approval_shape check (
  (resource_type = 'runtime_operation' and runtime_request is not null
    and runtime_binding_digest is not null and runtime_control_version is not null
    and runtime_expires_at is not null
    and runtime_binding_digest ~ '^sha256:[a-f0-9]{64}$'
    and runtime_control_version > 0 and runtime_expires_at > requested_at)
  or
  (resource_type <> 'runtime_operation' and runtime_request is null
    and runtime_response is null and runtime_binding_digest is null
    and runtime_control_version is null and runtime_expires_at is null
    and runtime_consumed_at is null and runtime_revoked_at is null)
);

create unique index allrice_runtime_approval_exact
  on allrice_approval_requests (organization_id, workspace_id, resource_id, runtime_binding_digest)
  where resource_type = 'runtime_operation';

insert into allrice_runtime_metadata (key, value)
values ('runtime-policy-schema', '{"version":"0074","issue":"MET-113","enabledByDefault":false}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
