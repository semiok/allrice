create table allrice_catalog_skills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  description text not null,
  publisher text not null,
  created_by uuid not null references allrice_users(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, slug),
  unique (organization_id, workspace_id, id)
);

create table allrice_skill_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  catalog_skill_id uuid not null,
  version text not null check (version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  status text not null default 'published'
    check (status in ('draft', 'published', 'deprecated', 'revoked')),
  capabilities jsonb not null,
  compatibility jsonb not null default '{"api":"v1"}',
  artifact_object_id uuid not null,
  source jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, catalog_skill_id)
    references allrice_catalog_skills(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, artifact_object_id)
    references allrice_storage_objects(organization_id, workspace_id, id),
  unique (catalog_skill_id, version),
  unique (organization_id, workspace_id, id),
  check (status <> 'published' or published_at is not null)
);

create table allrice_skill_installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  catalog_skill_id uuid not null,
  pinned_version_id uuid not null,
  enabled boolean not null default true,
  favorite boolean not null default false,
  granted_capabilities jsonb not null,
  timeout_ms integer not null default 300000
    check (timeout_ms between 1000 and 3600000),
  budget_cents integer not null default 0 check (budget_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, catalog_skill_id)
    references allrice_catalog_skills(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, pinned_version_id)
    references allrice_skill_versions(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, owner_id, catalog_skill_id),
  unique (organization_id, workspace_id, id)
);

create table allrice_skill_runs (
  run_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  installation_id uuid not null,
  skill_version_id uuid not null,
  provider text not null check (provider = 'codex'),
  provider_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, installation_id)
    references allrice_skill_installations(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, skill_version_id)
    references allrice_skill_versions(organization_id, workspace_id, id)
);

create table allrice_provider_status (
  provider text primary key check (provider = 'codex'),
  auth_mode text not null check (auth_mode = 'chatgpt_subscription'),
  status text not null check (status in ('connected', 'disconnected', 'error', 'unknown')),
  cli_version text,
  detail_code text,
  checked_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create function allrice_reject_published_skill_mutation()
returns trigger language plpgsql as $$
begin
  if old.status = 'published' and (
    new.catalog_skill_id is distinct from old.catalog_skill_id or
    new.version is distinct from old.version or
    new.capabilities is distinct from old.capabilities or
    new.compatibility is distinct from old.compatibility or
    new.artifact_object_id is distinct from old.artifact_object_id or
    new.source is distinct from old.source or
    new.published_at is distinct from old.published_at
  ) then
    raise exception 'published skill versions are immutable';
  end if;
  return new;
end;
$$;

create trigger allrice_skill_versions_immutable
before update on allrice_skill_versions
for each row execute function allrice_reject_published_skill_mutation();

create function allrice_reject_published_skill_delete()
returns trigger language plpgsql as $$
begin
  if old.status = 'published' then
    raise exception 'published skill versions cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger allrice_skill_versions_no_delete
before delete on allrice_skill_versions
for each row execute function allrice_reject_published_skill_delete();

create function allrice_reject_immutable_object_mutation()
returns trigger language plpgsql as $$
begin
  if old.immutable and old.state = 'ready' and (
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.owner_id is distinct from old.owner_id or
    new.object_key is distinct from old.object_key or
    new.category is distinct from old.category or
    new.media_type is distinct from old.media_type or
    new.size_bytes is distinct from old.size_bytes or
    new.checksum is distinct from old.checksum or
    new.state is distinct from old.state or
    new.immutable is distinct from old.immutable or
    new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception 'ready immutable storage objects cannot be mutated';
  end if;
  return new;
end;
$$;

create trigger allrice_storage_objects_immutable
before update on allrice_storage_objects
for each row execute function allrice_reject_immutable_object_mutation();

create index allrice_catalog_skills_workspace
  on allrice_catalog_skills (organization_id, workspace_id, name);
create index allrice_skill_installations_owner
  on allrice_skill_installations (organization_id, workspace_id, owner_id)
  where enabled;

insert into allrice_provider_status (
  provider, auth_mode, status, detail_code, checked_at
) values (
  'codex', 'chatgpt_subscription', 'unknown', 'worker_not_checked', now()
) on conflict (provider) do nothing;

insert into allrice_runtime_metadata (key, value)
values (
  'skillhub-schema',
  '{"version":"0006","artifactFormat":"application/vnd.allrice.skill+json;v=1","provider":"codex","authMode":"chatgpt_subscription"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
