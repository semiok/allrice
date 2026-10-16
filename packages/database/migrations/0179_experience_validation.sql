-- Reuse the isolated test lifecycle. No scene, chat identity or effective memory
-- is invented for a scheduled private draft validation.
alter table allrice_platform_employee_test_runs
  drop constraint allrice_platform_employee_test_runs_purpose_check;
alter table allrice_platform_employee_test_runs
  add constraint allrice_platform_employee_test_runs_purpose_check
    check (purpose in ('platform_preview','method_candidate','experience_validation')),
  add column experience_binding jsonb,
  add column experience_run_id uuid unique references allrice_runs(id),
  add column experience_route_id uuid unique references allrice_route_decisions(id),
  add column experience_assertion jsonb,
  add constraint allrice_experience_test_identity check (
    (purpose='experience_validation' and experience_binding is not null
      and jsonb_typeof(experience_binding)='object'
      and experience_binding->>'schemaVersion'='1')
    or (purpose<>'experience_validation' and experience_binding is null
      and experience_run_id is null and experience_route_id is null and experience_assertion is null)
  );
create unique index allrice_experience_test_once on allrice_platform_employee_test_runs
  ((experience_binding->>'occurrenceId'),(experience_binding->>'draftIndex'))
  where purpose='experience_validation';
alter table allrice_automation_runs add column experience_validation_plan jsonb;
create function allrice_experience_validation_immutable() returns trigger language plpgsql as $$
begin
  if old.experience_binding is not null and (
    new.experience_binding is distinct from old.experience_binding or new.id<>old.id or
    new.purpose<>old.purpose or new.employee_id<>old.employee_id or new.revision_id<>old.revision_id or
    new.requested_by_label<>old.requested_by_label or new.input is distinct from old.input or
    new.frozen_runtime_profile is distinct from old.frozen_runtime_profile or
    new.frozen_definition is distinct from old.frozen_definition or
    new.frozen_native_skills is distinct from old.frozen_native_skills or
    new.frozen_package_checksum is distinct from old.frozen_package_checksum or
    (old.experience_run_id is not null and new.experience_run_id is distinct from old.experience_run_id) or
    (old.experience_route_id is not null and new.experience_route_id is distinct from old.experience_route_id) or
    (old.experience_assertion is not null and new.experience_assertion is distinct from old.experience_assertion)
  ) then raise exception 'experience validation identity and result are immutable'; end if;
  return new;
end $$;
create trigger allrice_experience_validation_guard before update on allrice_platform_employee_test_runs
  for each row execute function allrice_experience_validation_immutable();

create function allrice_experience_validation_plan_immutable() returns trigger language plpgsql as $$
begin
  if old.experience_validation_plan is not null and new.experience_validation_plan is distinct from old.experience_validation_plan then
    raise exception 'experience validation reservation is immutable';
  end if;
  return new;
end $$;
create trigger allrice_experience_validation_plan_guard before update on allrice_automation_runs
  for each row execute function allrice_experience_validation_plan_immutable();
