alter table allrice_employee_assignments
  add column assigned_by uuid references allrice_users(id),
  add column assigned_at timestamptz;

update allrice_employee_assignments
set assigned_at = created_at
where assigned_at is null;

alter table allrice_employee_assignments
  alter column assigned_at set not null,
  alter column assigned_at set default now();

create table allrice_employee_user_profiles (
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  user_id uuid not null references allrice_users(id),
  profile jsonb not null default
    '{"schemaVersion":1,"displayName":null,"preferences":{}}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, workspace_id, employee_id, user_id),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id)
);

alter table allrice_employee_runs
  add column execution_snapshot jsonb;

update allrice_employee_runs er
set execution_snapshot = jsonb_build_object(
  'schemaVersion', 0,
  'legacy', true,
  'employeeAssignmentId', er.employee_assignment_id,
  'employeeVersionId', er.employee_version_id,
  'definitionChecksum', v.config_checksum,
  'definition', v.manifest,
  'providerSnapshot', er.provider_snapshot,
  'skillBindings', er.skill_bindings,
  'organizationId', er.organization_id,
  'workspaceId', er.workspace_id,
  'actorId', er.owner_id,
  'createdAt', er.created_at
)
from allrice_employee_versions v
where v.id = er.employee_version_id
  and er.execution_snapshot is null;

alter table allrice_employee_runs
  alter column execution_snapshot set not null;

create or replace function allrice_reject_employee_run_snapshot_mutation()
returns trigger language plpgsql as $$
begin
  if
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.owner_id is distinct from old.owner_id or
    new.employee_assignment_id is distinct from old.employee_assignment_id or
    new.employee_version_id is distinct from old.employee_version_id or
    new.session_id is distinct from old.session_id or
    new.user_message_id is distinct from old.user_message_id or
    new.assistant_message_id is distinct from old.assistant_message_id or
    new.provider_snapshot is distinct from old.provider_snapshot or
    new.skill_bindings is distinct from old.skill_bindings or
    new.prompt_snapshot is distinct from old.prompt_snapshot or
    new.execution_snapshot is distinct from old.execution_snapshot or
    new.created_at is distinct from old.created_at
  then
    raise exception 'employee run execution snapshots are immutable';
  end if;
  return new;
end;
$$;

-- Built-in professional templates remain available to administrators, but
-- ordinary users receive them only through an explicit administrator grant.
update allrice_employee_assignments a
set active = false, is_default = false, updated_at = now()
from allrice_employees e
where e.id = a.employee_id
  and e.organization_id = a.organization_id
  and e.workspace_id = a.workspace_id
  and e.employee_key like 'builtin-%';

update allrice_employee_assignments rice
set is_default = true, active = true, updated_at = now()
from allrice_employees e
where e.id = rice.employee_id
  and e.organization_id = rice.organization_id
  and e.workspace_id = rice.workspace_id
  and e.employee_key = 'default-assistant'
  and not exists (
    select 1 from allrice_employee_assignments current_default
    where current_default.organization_id = rice.organization_id
      and current_default.workspace_id = rice.workspace_id
      and current_default.user_id = rice.user_id
      and current_default.active
      and current_default.is_default
  );

create index allrice_employee_assignments_admin_scope
  on allrice_employee_assignments (
    organization_id, workspace_id, employee_id, active, user_id
  );

insert into allrice_runtime_metadata (key, value)
values (
  'employee-definition-schema',
  '{"version":"0014","definition":2,"executionSnapshot":1,"assignment":"admin-managed"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
