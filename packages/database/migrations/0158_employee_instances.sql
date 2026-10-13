-- Assignment remains the authorization relation. Many personal instances may
-- reuse it; publication must never overwrite their identity or personal data.
create table allrice_employee_version_sources (
  employee_version_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  employee_id uuid not null,
  platform_employee_id uuid not null,
  platform_revision_id uuid not null,
  foreign key (organization_id, workspace_id, employee_id, employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, employee_id, id),
  foreign key (platform_employee_id, platform_revision_id)
    references allrice_platform_employee_revisions(employee_id, id)
);
-- Only current deployment mappings are provable; do not infer older sources
-- from a matching name/key, or rewrite historical frozen execution JSON.
insert into allrice_employee_version_sources
  (employee_version_id, organization_id, workspace_id, employee_id,
   platform_employee_id, platform_revision_id)
select d.tenant_employee_version_id, d.organization_id, d.workspace_id,
  d.tenant_employee_id, d.employee_id, d.revision_id
from allrice_platform_employee_tenant_assignments d
join allrice_employee_versions v on v.id=d.tenant_employee_version_id
  and v.employee_id=d.tenant_employee_id and v.organization_id=d.organization_id
  and v.workspace_id=d.workspace_id
join allrice_platform_employee_revisions r on r.id=d.revision_id
  and r.employee_id=d.employee_id
where v.config_checksum=r.runtime_profile->'runtimePackage'->>'checksum';

alter table allrice_employee_assignments add unique
  (organization_id, workspace_id, user_id, id);

create table allrice_employee_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  assignment_id uuid not null,
  kind text not null check (kind in ('general','custom')),
  creation_version_id uuid not null,
  revision integer not null default 1 check (revision>0),
  profile jsonb not null default '{}' check (jsonb_typeof(profile)='object'),
  creation_request_id uuid,
  creation_input jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, owner_id, assignment_id)
    references allrice_employee_assignments(organization_id, workspace_id, user_id, id),
  foreign key (organization_id, workspace_id, creation_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, owner_id, id),
  unique (organization_id, workspace_id, owner_id, assignment_id, id),
  unique (organization_id, workspace_id, owner_id, creation_request_id),
  check ((kind='general' and id=assignment_id and creation_request_id is null and creation_input is null)
    or (kind='custom' and creation_request_id is not null and creation_input is not null))
);
create unique index allrice_employee_instances_general
  on allrice_employee_instances(assignment_id) where kind='general';
create index allrice_employee_instances_owner
  on allrice_employee_instances(organization_id,workspace_id,owner_id);

create table allrice_employee_instance_revisions (
  instance_id uuid not null references allrice_employee_instances(id),
  revision integer not null check (revision>0),
  profile jsonb not null check (jsonb_typeof(profile)='object'),
  request_id uuid,
  request_input jsonb,
  response jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(instance_id, revision),
  unique(instance_id, request_id)
);

insert into allrice_employee_instances
  (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
select id,organization_id,workspace_id,user_id,id,'general',employee_version_id
from allrice_employee_assignments;
insert into allrice_employee_instance_revisions(instance_id,revision,profile)
select id,revision,profile from allrice_employee_instances;

alter table allrice_chat_sessions add column employee_instance_id uuid;
alter table allrice_chat_sessions add foreign key
  (organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id)
  references allrice_employee_instances
    (organization_id,workspace_id,owner_id,assignment_id,id);
-- Existing Sessions resolve null to their own assignment's general instance.
-- Their ownership/assignment and historical Runs are not rewritten.
