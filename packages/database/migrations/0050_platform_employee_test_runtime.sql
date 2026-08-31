-- MET-93 Phase B: durable, worker-owned isolated DSH employee test runs.

alter table allrice_platform_employee_test_runs
  add column started_at timestamptz,
  add column worker_id uuid;

create index allrice_platform_employee_test_runs_queue_idx
  on allrice_platform_employee_test_runs (status, created_at, id);

insert into allrice_runtime_metadata (key, value)
values (
  'platform-employee-test-runtime',
  '{"version":"0050","issue":"MET-93","harness":"dsh","isolation":"no-tenant-data-no-tools"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
