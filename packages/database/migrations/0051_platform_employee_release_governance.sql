-- MET-93 Phase C: employee release audit and lifecycle governance.

create table allrice_platform_employee_audit_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  action text not null,
  actor_label text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(details) = 'object')
);

create index allrice_platform_employee_audit_events_lookup_idx
  on allrice_platform_employee_audit_events (employee_id, created_at desc, id desc);

insert into allrice_runtime_metadata (key, value)
values (
  'platform-employee-release-governance',
  '{"version":"0051","issue":"MET-93","requiresSuccessfulTest":true,"supportsDisable":true}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
