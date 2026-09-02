alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_capabilities_check;
alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_capabilities_check1;
alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_capabilities_cardinality_check;
alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_capabilities_allowed_check;

alter table allrice_bridge_devices
  add constraint allrice_bridge_devices_capabilities_cardinality_check
  check (cardinality(capabilities) between 1 and 16);
alter table allrice_bridge_devices
  add constraint allrice_bridge_devices_capabilities_allowed_check
  check (capabilities <@ array[
    'local.fs.list', 'local.fs.search', 'local.fs.read',
    'local.fs.write', 'local.fs.mkdir',
    'local.git.status', 'local.git.diff'
  ]::text[]);

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-capability-constraints',
  '{"version":"0071","protocol":2,"cardinality":"1..16","managedWrite":true}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
