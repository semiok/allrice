-- Computers are private to an employee in an organization. Internal workspace
-- IDs bind execution evidence and must not define who can replace a computer.
drop index if exists allrice_bridge_devices_one_active_per_workspace;

with stale_devices as (
  select id, organization_id, workspace_id, owner_id
  from (
    select id, organization_id, workspace_id, owner_id,
      row_number() over (
        partition by organization_id, owner_id
        order by last_seen_at desc nulls last, created_at desc, id desc
      ) as active_position
    from allrice_bridge_devices
    where revoked_at is null
  ) ranked
  where active_position > 1
)
insert into allrice_audit_events (
  organization_id, workspace_id, actor_id, action, resource_type,
  resource_id, decision, reason, metadata
)
select organization_id, workspace_id, owner_id, 'bridge.device.revoke',
  'bridge_device', id, 'recorded', 'replaced_by_employee_device_policy',
  '{"migration":"0180"}'::jsonb
from stale_devices;

with stale_devices as (
  select id
  from (
    select id,
      row_number() over (
        partition by organization_id, owner_id
        order by last_seen_at desc nulls last, created_at desc, id desc
      ) as active_position
    from allrice_bridge_devices
    where revoked_at is null
  ) ranked
  where active_position > 1
)
update allrice_bridge_folder_grants grant_record
set revoked_at = now()
from stale_devices
where grant_record.device_id = stale_devices.id
  and grant_record.revoked_at is null;

with stale_devices as (
  select id
  from (
    select id,
      row_number() over (
        partition by organization_id, owner_id
        order by last_seen_at desc nulls last, created_at desc, id desc
      ) as active_position
    from allrice_bridge_devices
    where revoked_at is null
  ) ranked
  where active_position > 1
)
update allrice_bridge_commands command_record
set status = 'canceled', completed_at = now(), updated_at = now(),
  error_code = 'device_replaced'
from stale_devices
where command_record.device_id = stale_devices.id
  and command_record.status in ('queued', 'claimed', 'running');

with stale_devices as (
  select id
  from (
    select id,
      row_number() over (
        partition by organization_id, owner_id
        order by last_seen_at desc nulls last, created_at desc, id desc
      ) as active_position
    from allrice_bridge_devices
    where revoked_at is null
  ) ranked
  where active_position > 1
)
update allrice_bridge_workspace_selection_requests selection_request
set status = 'canceled', completed_at = now(), updated_at = now(),
  error_code = 'device_replaced'
from stale_devices
where selection_request.device_id = stale_devices.id
  and selection_request.status in ('queued', 'claimed');

with stale_devices as (
  select id
  from (
    select id,
      row_number() over (
        partition by organization_id, owner_id
        order by last_seen_at desc nulls last, created_at desc, id desc
      ) as active_position
    from allrice_bridge_devices
    where revoked_at is null
  ) ranked
  where active_position > 1
)
update allrice_execution_targets target
set state = 'revoked', last_heartbeat_at = null,
  unavailable_reason = 'bridge_replaced', updated_at = now()
from stale_devices
where target.target_key = 'bridge.' || stale_devices.id::text;

with stale_devices as (
  select id
  from (
    select id,
      row_number() over (
        partition by organization_id, owner_id
        order by last_seen_at desc nulls last, created_at desc, id desc
      ) as active_position
    from allrice_bridge_devices
    where revoked_at is null
  ) ranked
  where active_position > 1
)
update allrice_bridge_devices device
set revoked_at = now(), updated_at = now()
from stale_devices
where device.id = stale_devices.id;

create unique index if not exists allrice_bridge_devices_one_active_per_employee
  on allrice_bridge_devices (organization_id, owner_id)
  where revoked_at is null;

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-active-device-policy',
  '{"version":"0180","scope":"organization-employee","activeDevices":1,"replacement":"automatic-revoke"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();

-- These legacy personal labels became the company's internal default scope.
-- Remove the obsolete name without deleting company conversations or files.
with legacy as (
  select w.id,w.organization_id,w.name from allrice_workspaces w
  join allrice_organizations o on o.id=w.organization_id and o.default_workspace_id=w.id
  where o.managed_employee_roster and w.name in ('Snow Workspace','Drink Workspace')
), renamed as (
  update allrice_workspaces w set name='默认工作区' from legacy l where w.id=l.id
  returning w.id,w.organization_id,l.name as previous_name
)
insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
select organization_id,id,null,'organization.legacy_scope.cleaned','workspace',id,'recorded',
  'organization_default_scope',jsonb_build_object('migration','0180','previousName',previous_name) from renamed;

-- Expired one-time codes and transport leases carry no execution evidence.
delete from allrice_bridge_pairing_codes where used_at is not null or expires_at<=now();
delete from allrice_bridge_connections where expires_at<=now();
