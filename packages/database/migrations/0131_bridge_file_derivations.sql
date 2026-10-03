-- A fixed byte codec uses the existing RuntimeOperation and private attachment
-- stream. Legacy command queues remain unable to execute this capability.
alter table allrice_bridge_devices drop constraint allrice_bridge_devices_capabilities_allowed_check;
alter table allrice_bridge_devices add constraint allrice_bridge_devices_capabilities_allowed_check check (capabilities <@ array[
  'local.fs.list','local.fs.search','local.fs.read','local.fs.write','local.fs.mkdir','local.git.status','local.git.diff',
  'local.file.inspect','local.file.import','local.file.save','local.file.open','local.file.reveal','local.file.select',
  'local.file.derive','local.python.execute','local.pdf.read'
]::text[]);
