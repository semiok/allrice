-- MET-92: replace the tenant-facing SkillHub with a platform-managed DSH
-- native Skill registry. Skill bodies are frozen into each EmployeeRun so a
-- live or recovered DSH Session sees one immutable catalog.

create table allrice_dsh_skills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  name text not null check (name ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text not null,
  content text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  model_invocable boolean not null default true,
  user_invocable boolean not null default true,
  required_tool_refs jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, name),
  unique (organization_id, workspace_id, id),
  check (octet_length(content) <= 500000),
  check (jsonb_typeof(required_tool_refs) = 'array')
);

create table allrice_employee_dsh_skill_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  skill_id uuid not null,
  enabled boolean not null default true,
  bound_by uuid not null references allrice_users(id),
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, skill_id)
    references allrice_dsh_skills(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, employee_id, skill_id),
  unique (organization_id, workspace_id, id)
);

alter table allrice_employee_runs
  add column native_skills jsonb not null default '[]'::jsonb,
  add check (jsonb_typeof(native_skills) = 'array');

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
    new.native_skills is distinct from old.native_skills or
    new.prompt_snapshot is distinct from old.prompt_snapshot or
    new.execution_snapshot is distinct from old.execution_snapshot or
    new.created_at is distinct from old.created_at
  then
    raise exception 'employee run execution snapshots are immutable';
  end if;
  return new;
end;
$$;

-- Product reset authorized for MET-92: remove the old catalog, installation,
-- artifact and employee binding data. Historical migrations stay in place so
-- existing databases remain reproducible, but the legacy runtime is retired.
create temporary table allrice_retired_skill_objects on commit drop as
select artifact_object_id as id from allrice_skill_versions;

delete from allrice_employee_agent_skill_bindings;
delete from allrice_skill_runs;
delete from allrice_skill_installations;
drop trigger if exists allrice_skill_versions_no_delete
  on allrice_skill_versions;
delete from allrice_skill_versions;
delete from allrice_catalog_skills;
delete from allrice_storage_objects
where id in (select id from allrice_retired_skill_objects);

insert into allrice_runtime_metadata (key, value)
values (
  'dsh-native-skills',
  '{"version":"0046","issue":"MET-92","provider":"allrice","legacySkillHub":"retired","initialEmployee":"Rice"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
