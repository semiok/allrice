-- Keep the original result and frozen binding. A user-authorized retry is a
-- separate attempt, never an update or automatic replay of the failed Run.
alter table allrice_employee_method_tests
  add column retry_of_test_id uuid references allrice_employee_method_tests(test_id),
  add constraint allrice_method_test_retry_not_self
    check (retry_of_test_id is null or retry_of_test_id <> test_id);

-- The original migration used a generated name (truncated by PostgreSQL).
-- Identify that exact unique key, and fail migration if it is not present.
do $$
declare binding_constraint text;
begin
  select conname into strict binding_constraint
  from pg_constraint
  where conrelid = 'allrice_employee_method_tests'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) =
      'UNIQUE (organization_id, workspace_id, owner_id, instance_id, binding_digest)';
  execute format('alter table allrice_employee_method_tests drop constraint %I', binding_constraint);
end $$;

create unique index allrice_method_test_root_binding_idx
  on allrice_employee_method_tests(organization_id,workspace_id,owner_id,instance_id,binding_digest)
  where retry_of_test_id is null;
create unique index allrice_method_test_retry_parent_idx
  on allrice_employee_method_tests(retry_of_test_id)
  where retry_of_test_id is not null;
