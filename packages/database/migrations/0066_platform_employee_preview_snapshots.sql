-- MET-98 P1-3: freeze platform preview execution inputs and use a per-run
-- deadline instead of a fixed worker timeout.

alter table allrice_platform_employee_test_runs
  add column frozen_runtime_profile jsonb,
  add column frozen_definition jsonb,
  add column frozen_native_skills jsonb,
  add column frozen_package_checksum text,
  add column timeout_at timestamptz;

-- Preserve already queued/running previews across the rollout. Historical
-- terminal rows may legitimately remain without a snapshot.
update allrice_platform_employee_test_runs test
set frozen_runtime_profile = revision.runtime_profile,
  frozen_definition = revision.definition,
  frozen_native_skills = coalesce(
    revision.runtime_profile #> '{runtimePackage,skills}',
    '[]'::jsonb
  ),
  frozen_package_checksum =
    revision.runtime_profile #>> '{runtimePackage,checksum}'
from allrice_platform_employee_revisions revision
where revision.id = test.revision_id
  and revision.employee_id = test.employee_id
  and revision.runtime_profile is not null
  and test.status in ('queued', 'running');

-- Any legacy active row that cannot be frozen must fail closed rather than
-- execute a mutable revision.
update allrice_platform_employee_test_runs
set status = 'failed', completed_at = now(),
  output = jsonb_build_object(
    'answer', null,
    'provider', null,
    'model', null,
    'threadId', null,
    'usage', null,
    'events', jsonb_build_array(),
    'error', jsonb_build_object(
      'code', 'TEST_SNAPSHOT_MISSING',
      'message', '配置试用缺少冻结执行快照，已安全终止。'
    )
  )
where status in ('queued', 'running')
  and (
    frozen_runtime_profile is null
    or frozen_definition is null
    or frozen_native_skills is null
    or frozen_package_checksum is null
  );

update allrice_platform_employee_test_runs
set started_at = coalesce(started_at, now()),
  timeout_at = coalesce(started_at, now())
  + (
      greatest(
        coalesce((frozen_runtime_profile ->> 'timeoutMs')::integer, 840000),
        1000
      ) + 60000
    ) * interval '1 millisecond'
where status = 'running' and timeout_at is null;

alter table allrice_platform_employee_test_runs
  add constraint allrice_platform_employee_test_snapshot_active_check check (
    status not in ('queued', 'running')
    or (
      frozen_runtime_profile is not null
      and jsonb_typeof(frozen_runtime_profile) = 'object'
      and frozen_definition is not null
      and jsonb_typeof(frozen_definition) = 'object'
      and frozen_native_skills is not null
      and jsonb_typeof(frozen_native_skills) = 'array'
      and frozen_package_checksum is not null
      and frozen_package_checksum ~ '^sha256:[a-f0-9]{64}$'
    )
  ),
  add constraint allrice_platform_employee_test_timeout_check check (
    timeout_at is null or started_at is not null
  );

create index allrice_platform_employee_test_runs_timeout_idx
  on allrice_platform_employee_test_runs (timeout_at, id)
  where status = 'running';

update allrice_runtime_metadata
set value = '{
  "version":"0066",
  "issue":"MET-98",
  "harness":"dsh",
  "isolation":"tenant-read-only-preview",
  "executionSnapshot":"frozen",
  "timeout":"per-run-deadline"
}'::jsonb,
  updated_at = now()
where key = 'platform-employee-test-runtime';
