-- v1 remains readable. v2 adds an immutable personal Skill overlay without
-- changing the published employee package or its checksum.
alter table allrice_platform_employee_test_runs
  drop constraint allrice_experience_test_identity;
alter table allrice_platform_employee_test_runs
  add constraint allrice_experience_test_identity check (
    (purpose='experience_validation' and experience_binding is not null
      and jsonb_typeof(experience_binding)='object'
      and experience_binding->>'schemaVersion' in ('1','2'))
    or (purpose<>'experience_validation' and experience_binding is null
      and experience_run_id is null and experience_route_id is null and experience_assertion is null)
  );
