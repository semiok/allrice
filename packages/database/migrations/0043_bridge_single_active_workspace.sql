with ranked as (
  select id, row_number() over (
    partition by device_id order by created_at desc, id desc
  ) as position
  from allrice_bridge_folder_grants
  where revoked_at is null
)
update allrice_bridge_folder_grants grant_row
set revoked_at = now()
from ranked
where grant_row.id = ranked.id and ranked.position > 1;

create unique index allrice_bridge_folder_grants_one_active
  on allrice_bridge_folder_grants (device_id)
  where revoked_at is null;

insert into allrice_runtime_metadata (key, value)
values (
  'rice-bridge-active-workspace',
  '{"version":"0043","issue":"MET-89","mode":"single-active-grant"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
