alter table allrice_employee_method_tests
  drop constraint allrice_employee_method_tests_case_id_check,
  drop constraint allrice_employee_method_tests_environment_check,
  add constraint allrice_method_test_case_environment check (
    (case_id = 'cny-total-v1' and environment = 'isolated-text-v1') or
    (case_id = 'cny-file-flow-v1' and environment = 'isolated-file-flow-v1')
  );

-- Only associates the fixed test stages with the existing cloud ledger. The
-- executor, attempt, physical stop and artifacts remain owned by that ledger.
create table allrice_employee_method_file_steps (
  test_id uuid not null references allrice_employee_method_tests(test_id),
  stage text not null check (stage in ('normalize','summarize')),
  operation_id uuid not null unique,
  payload jsonb not null,
  payload_digest text not null,
  execution_started_at timestamptz,
  output_object_id uuid references allrice_storage_objects(id),
  output_version_id uuid references allrice_deliverable_versions(id),
  verdict jsonb,
  created_at timestamptz not null default now(),
  primary key (test_id,stage),
  check ((output_object_id is null) = (output_version_id is null))
);
