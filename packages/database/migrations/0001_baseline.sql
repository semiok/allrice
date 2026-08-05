create extension if not exists vector;

create table if not exists allrice_runtime_metadata (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into allrice_runtime_metadata (key, value)
values ('baseline', '{"version":"0.1.0","owner":"M5"}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
