-- The existing cloud attempt journals the same finite ProjectService lifecycle.
-- No second product service table, grant, or user-visible identifier.
alter table allrice_cloud_execution_attempts
  add column if not exists service_ready boolean not null default false,
  add column if not exists service_events jsonb not null default '[]'::jsonb
    check (jsonb_typeof(service_events) = 'array');
