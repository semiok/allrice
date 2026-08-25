-- Keep conversations available while Web and Worker roll from the legacy
-- insert shape to the complete EmployeeExecutionSnapshot shape. New runtimes
-- always provide execution_snapshot explicitly; an older runtime receives a
-- frozen schemaVersion 0 snapshot instead of failing the insert.
create function allrice_fill_legacy_employee_execution_snapshot()
returns trigger language plpgsql as $$
declare
  employee_definition jsonb;
  employee_checksum text;
  employee_revision integer;
  employee_key text;
  assignment_user_id uuid;
  assignment_assigned_by uuid;
  assignment_assigned_at timestamptz;
begin
  if new.execution_snapshot is null then
    select v.manifest, v.config_checksum, v.version, e.employee_key
      into employee_definition, employee_checksum, employee_revision, employee_key
    from allrice_employee_versions v
    join allrice_employees e on e.id = v.employee_id
    where v.id = new.employee_version_id
      and v.organization_id = new.organization_id
      and v.workspace_id = new.workspace_id;

    select a.user_id, a.assigned_by, a.assigned_at
      into assignment_user_id, assignment_assigned_by, assignment_assigned_at
    from allrice_employee_assignments a
    where a.id = new.employee_assignment_id
      and a.organization_id = new.organization_id
      and a.workspace_id = new.workspace_id;

    new.execution_snapshot = jsonb_build_object(
      'schemaVersion', 0,
      'legacy', true,
      'employee', jsonb_build_object(
        'key', employee_key,
        'versionId', new.employee_version_id,
        'revision', employee_revision,
        'definitionChecksum', employee_checksum,
        'definition', employee_definition
      ),
      'assignment', jsonb_build_object(
        'id', new.employee_assignment_id,
        'userId', assignment_user_id,
        'assignedBy', assignment_assigned_by,
        'assignedAt', assignment_assigned_at
      ),
      'providerSnapshot', new.provider_snapshot,
      'skillBindings', new.skill_bindings,
      'promptSnapshot', new.prompt_snapshot,
      'tenantContext', jsonb_build_object(
        'organizationId', new.organization_id,
        'workspaceId', new.workspace_id,
        'actorId', new.owner_id
      ),
      'createdAt', coalesce(new.created_at, now())
    );
  end if;
  return new;
end;
$$;

create trigger allrice_employee_runs_snapshot_rollout
before insert on allrice_employee_runs
for each row execute function allrice_fill_legacy_employee_execution_snapshot();

insert into allrice_runtime_metadata (key, value)
values (
  'employee-definition-schema',
  '{"version":"0015","definition":2,"executionSnapshot":1,"assignment":"admin-managed","rollingCompatibility":true}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
