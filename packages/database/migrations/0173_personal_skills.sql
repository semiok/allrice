-- Personal imports are separate from platform-reviewed Skills. Immutable
-- source versions survive uninstall; only explicit owner bindings enable use.
create table allrice_personal_skill_installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  owner_id uuid not null references allrice_users(id),
  name text not null check (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(name)<=64),
  state text not null check (state in ('installed','uninstalled')),
  revision integer not null default 1 check (revision>0),
  current_version_id uuid not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(organization_id,owner_id,id),
  unique(organization_id,owner_id,name)
);

create table allrice_personal_skill_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  owner_id uuid not null,
  installation_id uuid not null,
  version integer not null check(version>0),
  source jsonb not null check(jsonb_typeof(source)='object'),
  original_text text not null check(octet_length(original_text)<=262144),
  definition jsonb not null check(jsonb_typeof(definition)='object'),
  definition_checksum text not null check(definition_checksum ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,owner_id,installation_id)
    references allrice_personal_skill_installations(organization_id,owner_id,id),
  unique(organization_id,owner_id,installation_id,id),
  unique(installation_id,version),
  unique(installation_id,definition_checksum)
);
alter table allrice_personal_skill_installations add foreign key
  (organization_id,owner_id,id,current_version_id)
  references allrice_personal_skill_versions(organization_id,owner_id,installation_id,id)
  deferrable initially deferred;

create table allrice_personal_skill_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  installation_id uuid not null,
  enabled boolean not null,
  epoch integer not null default 1 check(epoch>0),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  foreign key(organization_id,owner_id,installation_id)
    references allrice_personal_skill_installations(organization_id,owner_id,id),
  unique(instance_id,installation_id)
);
create index allrice_personal_skill_bindings_owner
  on allrice_personal_skill_bindings(organization_id,owner_id,instance_id);

create table allrice_personal_skill_receipts (
  organization_id uuid not null references allrice_organizations(id),
  owner_id uuid not null references allrice_users(id),
  request_id uuid not null,
  request_input jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,owner_id,request_id)
);

create function allrice_personal_skill_version_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'personal Skill source versions are immutable';
end $$;
create trigger allrice_personal_skill_version_immutable before update or delete
  on allrice_personal_skill_versions for each row
  execute function allrice_personal_skill_version_immutable();
