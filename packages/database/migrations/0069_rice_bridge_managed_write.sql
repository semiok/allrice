alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_protocol_version_check;
alter table allrice_bridge_devices
  add constraint allrice_bridge_devices_protocol_version_check
  check (protocol_version in (1, 2));

alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_capabilities_check;
alter table allrice_bridge_devices
  add constraint allrice_bridge_devices_capabilities_check
  check (capabilities <@ array[
    'local.fs.list', 'local.fs.search', 'local.fs.read',
    'local.fs.write', 'local.fs.mkdir',
    'local.git.status', 'local.git.diff'
  ]::text[]);

alter table allrice_bridge_commands
  drop constraint if exists allrice_bridge_commands_capability_check;
alter table allrice_bridge_commands
  add constraint allrice_bridge_commands_capability_check
  check (capability in (
    'local.fs.list', 'local.fs.search', 'local.fs.read',
    'local.fs.write', 'local.fs.mkdir',
    'local.git.status', 'local.git.diff'
  ));

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-schema',
  '{"version":"0069","issue":"MET-102","protocol":"2","mode":"local-managed-write"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
