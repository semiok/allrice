alter table allrice_bridge_devices
  drop constraint if exists allrice_bridge_devices_platform_check;
alter table allrice_bridge_devices
  add constraint allrice_bridge_devices_platform_check
  check (platform in ('macos-arm64', 'macos-x64'));

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-platforms',
  '{"version":"0070","platforms":["macos-arm64","macos-x64"]}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
