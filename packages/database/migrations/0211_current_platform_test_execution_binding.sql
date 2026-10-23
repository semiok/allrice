-- New test identities only. Existing NULL/v1 tests keep their original target
-- and snapshots. No default, backfill, historical finalization or deletion.
alter table allrice_platform_employee_test_runs
  add column native_execution_binding jsonb;

create function allrice_platform_test_execution_binding_guard()
returns trigger language plpgsql as $$
declare origin jsonb; binding jsonb; organization_id uuid;
begin
  origin := new.native_root_origin;
  binding := new.native_execution_binding;
  if tg_op = 'UPDATE' then
    if binding is distinct from old.native_execution_binding then
      raise exception 'platform test execution binding is immutable';
    end if;
    if old.native_root_origin->>'schemaVersion' = '2' and (
      new.id is distinct from old.id or
      new.employee_id is distinct from old.employee_id or
      new.revision_id is distinct from old.revision_id or
      new.purpose is distinct from old.purpose or
      new.input is distinct from old.input or
      new.frozen_runtime_profile is distinct from old.frozen_runtime_profile or
      new.frozen_definition is distinct from old.frozen_definition or
      new.frozen_native_skills is distinct from old.frozen_native_skills or
      new.frozen_package_checksum is distinct from old.frozen_package_checksum
    ) then
      raise exception 'current platform test execution source is immutable';
    end if;
    return new;
  end if;
  if origin->>'schemaVersion' = '2' then
    select w.organization_id into organization_id from allrice_workspaces w
      where w.id::text = new.input->>'workspaceId';
    if binding is null or organization_id is null
      or new.input->>'ownerId' is null
      or origin->>'contextKind' is distinct from 'platform_employee_test'
      or origin->>'contextId' is distinct from new.id::text
      or origin->>'rootSeed' is distinct from new.id::text
      or origin#>>'{scope,organizationId}' is distinct from organization_id::text
      or origin#>>'{scope,workspaceId}' is distinct from new.input->>'workspaceId'
      or origin#>>'{scope,ownerId}' is distinct from new.input->>'ownerId'
      or origin#>>'{birthSource,platformEmployeeId}' is distinct from new.employee_id::text
      or origin#>>'{birthSource,platformRevisionId}' is distinct from new.revision_id::text
      or origin#>>'{birthSource,purpose}' is distinct from new.purpose
      or origin#>>'{birthSource,packageChecksum}' is distinct from new.frozen_package_checksum
      or binding->>'schemaVersion' is distinct from '1'
      or binding->>'kind' is distinct from 'current_platform_test_execution'
      or binding#>>'{scope,testId}' is distinct from new.id::text
      or binding#>>'{scope,organizationId}' is distinct from origin#>>'{scope,organizationId}'
      or binding#>>'{scope,workspaceId}' is distinct from origin#>>'{scope,workspaceId}'
      or binding#>>'{scope,ownerId}' is distinct from origin#>>'{scope,ownerId}'
      or binding->'source' is distinct from origin->'birthSource'
      or binding->'sourcePolicy' is distinct from origin->'sourcePolicy'
      or binding#>>'{execution,artifactId}' is distinct from origin->>'artifactId'
      or binding#>>'{execution,generation}' is distinct from origin->>'distributionGeneration'
      or binding#>>'{execution,profileId}' is distinct from origin->>'profileId'
      or origin->>'profileId' is distinct from 'restricted'
    then
      raise exception 'current platform test execution binding required';
    end if;
  elsif binding is not null then
    raise exception 'historical platform test execution cannot be rebound';
  end if;
  return new;
end;
$$;
create trigger platform_test_execution_binding_guard
  before insert or update on allrice_platform_employee_test_runs
  for each row execute function allrice_platform_test_execution_binding_guard();

-- The original 0188 native_root_origin_immutable trigger is retained.
-- TS independently validates original checksums and the complete source policy.
