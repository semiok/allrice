-- MET-68: first-class Agent Skill, Workflow and Knowledge definitions.
-- The three capability families intentionally use independent tables and
-- foreign keys. They share lifecycle conventions, not a generic JSON bucket.

create table allrice_employee_agent_skill_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  installation_id uuid not null,
  skill_version_id uuid not null,
  granted_capabilities jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  bound_by uuid not null references allrice_users(id),
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, installation_id)
    references allrice_skill_installations(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, skill_version_id)
    references allrice_skill_versions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, employee_id, skill_version_id),
  unique (organization_id, workspace_id, id),
  check (jsonb_typeof(granted_capabilities) = 'array')
);

create function allrice_validate_employee_agent_skill_binding()
returns trigger language plpgsql as $$
declare
  pinned_version_id uuid;
begin
  select i.pinned_version_id into pinned_version_id
  from allrice_skill_installations i
  where i.organization_id = new.organization_id
    and i.workspace_id = new.workspace_id
    and i.id = new.installation_id;
  if pinned_version_id is distinct from new.skill_version_id then
    raise exception 'agent skill binding must use the installation pinned version';
  end if;
  return new;
end;
$$;

create trigger allrice_employee_agent_skill_binding_valid
before insert or update on allrice_employee_agent_skill_bindings
for each row execute function allrice_validate_employee_agent_skill_binding();

create table allrice_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  description text not null,
  status text not null default 'active'
    check (status in ('active', 'archived')),
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, slug),
  unique (organization_id, workspace_id, id)
);

create table allrice_workflow_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  workflow_id uuid not null,
  revision integer not null check (revision > 0),
  name text not null,
  description text not null,
  status text not null default 'published'
    check (status in ('draft', 'published', 'deprecated', 'revoked')),
  definition jsonb not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  created_by uuid not null references allrice_users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, workflow_id)
    references allrice_workflows(organization_id, workspace_id, id),
  unique (workflow_id, revision),
  unique (organization_id, workspace_id, id),
  check (status <> 'published' or published_at is not null),
  check (jsonb_typeof(definition) = 'object')
);

create table allrice_employee_workflow_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  workflow_revision_id uuid not null,
  enabled boolean not null default true,
  bound_by uuid not null references allrice_users(id),
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, workflow_revision_id)
    references allrice_workflow_revisions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, employee_id, workflow_revision_id),
  unique (organization_id, workspace_id, id)
);

create table allrice_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  description text not null,
  status text not null default 'active'
    check (status in ('active', 'archived')),
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, slug),
  unique (organization_id, workspace_id, id)
);

create table allrice_knowledge_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  knowledge_source_id uuid not null,
  revision integer not null check (revision > 0),
  name text not null,
  description text not null,
  status text not null default 'published'
    check (status in ('draft', 'published', 'deprecated', 'revoked')),
  definition jsonb not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  created_by uuid not null references allrice_users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, knowledge_source_id)
    references allrice_knowledge_sources(organization_id, workspace_id, id),
  unique (knowledge_source_id, revision),
  unique (organization_id, workspace_id, id),
  check (status <> 'published' or published_at is not null),
  check (jsonb_typeof(definition) = 'object')
);

create table allrice_knowledge_acl_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  knowledge_revision_id uuid not null,
  principal_type text not null
    check (principal_type in ('organization', 'workspace', 'employee', 'user')),
  principal_id uuid not null,
  permission text not null check (permission in ('read', 'admin')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, knowledge_revision_id)
    references allrice_knowledge_revisions(organization_id, workspace_id, id),
  unique (knowledge_revision_id, principal_type, principal_id, permission)
);

create table allrice_employee_knowledge_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  knowledge_revision_id uuid not null,
  enabled boolean not null default true,
  bound_by uuid not null references allrice_users(id),
  bound_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, knowledge_revision_id)
    references allrice_knowledge_revisions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, employee_id, knowledge_revision_id),
  unique (organization_id, workspace_id, id)
);

create function allrice_reject_published_workflow_revision_mutation()
returns trigger language plpgsql as $$
begin
  if old.status = 'published' and (
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.workflow_id is distinct from old.workflow_id or
    new.revision is distinct from old.revision or
    new.name is distinct from old.name or
    new.description is distinct from old.description or
    new.definition is distinct from old.definition or
    new.checksum is distinct from old.checksum or
    new.created_by is distinct from old.created_by or
    new.published_at is distinct from old.published_at or
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'published workflow revisions are immutable';
  end if;
  return new;
end;
$$;

create trigger allrice_workflow_revisions_immutable
before update on allrice_workflow_revisions
for each row execute function allrice_reject_published_workflow_revision_mutation();

create function allrice_reject_published_knowledge_revision_mutation()
returns trigger language plpgsql as $$
begin
  if old.status = 'published' and (
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.knowledge_source_id is distinct from old.knowledge_source_id or
    new.revision is distinct from old.revision or
    new.name is distinct from old.name or
    new.description is distinct from old.description or
    new.definition is distinct from old.definition or
    new.checksum is distinct from old.checksum or
    new.created_by is distinct from old.created_by or
    new.published_at is distinct from old.published_at or
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'published knowledge revisions are immutable';
  end if;
  return new;
end;
$$;

create trigger allrice_knowledge_revisions_immutable
before update on allrice_knowledge_revisions
for each row execute function allrice_reject_published_knowledge_revision_mutation();

create function allrice_reject_published_capability_revision_delete()
returns trigger language plpgsql as $$
begin
  if old.status = 'published' then
    raise exception 'published capability revisions cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger allrice_workflow_revisions_no_delete
before delete on allrice_workflow_revisions
for each row execute function allrice_reject_published_capability_revision_delete();

create trigger allrice_knowledge_revisions_no_delete
before delete on allrice_knowledge_revisions
for each row execute function allrice_reject_published_capability_revision_delete();

-- Preserve current SkillHub behaviour while moving future resolution to the
-- explicit employee binding table.
insert into allrice_employee_agent_skill_bindings (
  organization_id, workspace_id, employee_id, installation_id,
  skill_version_id, granted_capabilities, bound_by
)
select
  e.organization_id, e.workspace_id, e.id, i.id, sv.id,
  i.granted_capabilities, actor.user_id
from allrice_employees e
join lateral (
  select v.manifest
  from allrice_employee_versions v
  where v.employee_id = e.id
  order by v.version desc
  limit 1
) current_version on true
join lateral jsonb_array_elements_text(
  coalesce(current_version.manifest -> 'skillVersionIds', '[]'::jsonb)
) selected(skill_version_id) on true
join allrice_skill_versions sv
  on selected.skill_version_id ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 and sv.id = selected.skill_version_id::uuid
 and sv.organization_id = e.organization_id
 and sv.workspace_id = e.workspace_id
join allrice_skill_installations i
  on i.pinned_version_id = sv.id
 and i.organization_id = sv.organization_id
 and i.workspace_id = sv.workspace_id
 and i.owner_id is null
join lateral (
  select coalesce(a.assigned_by, a.user_id) as user_id
  from allrice_employee_assignments a
  where a.organization_id = e.organization_id
    and a.workspace_id = e.workspace_id
    and a.employee_id = e.id
  order by a.active desc, a.assigned_at, a.id
  limit 1
) actor on true
on conflict (organization_id, workspace_id, employee_id, skill_version_id)
do nothing;

create index allrice_employee_agent_skill_bindings_active
  on allrice_employee_agent_skill_bindings (
    organization_id, workspace_id, employee_id, skill_version_id
  ) where enabled;
create index allrice_employee_workflow_bindings_active
  on allrice_employee_workflow_bindings (
    organization_id, workspace_id, employee_id, workflow_revision_id
  ) where enabled;
create index allrice_employee_knowledge_bindings_active
  on allrice_employee_knowledge_bindings (
    organization_id, workspace_id, employee_id, knowledge_revision_id
  ) where enabled;
create index allrice_knowledge_acl_principal
  on allrice_knowledge_acl_entries (
    organization_id, workspace_id, principal_type, principal_id
  );

insert into allrice_runtime_metadata (key, value)
values (
  'agent-capability-schema',
  '{"version":"0020","issue":"MET-68","snapshot":2,"families":["agent_skill","workflow","knowledge"],"binding":"employee-admin","acl":"tenant-intersection"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
