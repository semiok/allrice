-- Additive, old-worker compatible. Legacy devices never advertise these actions.
alter table allrice_bridge_devices drop constraint if exists allrice_bridge_devices_capabilities_allowed_check;
alter table allrice_bridge_devices add constraint allrice_bridge_devices_capabilities_allowed_check check (capabilities <@ array[
  'local.fs.list','local.fs.search','local.fs.read','local.fs.write','local.fs.mkdir','local.git.status','local.git.diff',
  'local.file.inspect','local.file.import','local.file.save','local.file.open','local.file.reveal','local.file.select'
]::text[]);
alter table allrice_bridge_commands drop constraint if exists allrice_bridge_commands_capability_check;
alter table allrice_bridge_commands add constraint allrice_bridge_commands_capability_check check (capability in (
  'local.fs.list','local.fs.search','local.fs.read','local.fs.write','local.fs.mkdir','local.git.status','local.git.diff',
  'local.file.inspect','local.file.import','local.file.save','local.file.open','local.file.reveal','local.file.select'
));
alter table allrice_bridge_commands drop constraint if exists allrice_bridge_commands_status_check;
alter table allrice_bridge_commands add constraint allrice_bridge_commands_status_check check (status in (
  'queued','claimed','running','succeeded','failed','expired','canceled','unknown'
));
alter table allrice_bridge_commands add column if not exists folder_grant_version integer;
alter table allrice_bridge_commands add column if not exists session_id uuid;
alter table allrice_bridge_commands add column if not exists cancel_requested_at timestamptz;
alter table allrice_bridge_commands add column if not exists request_digest text;
