-- Freeze catalog display identity and a checksum covering the complete Agent
-- Skill revision. Catalog metadata may evolve; historical revisions may not.

alter table allrice_skill_versions
  add column agent_name text,
  add column agent_description text,
  add column agent_publisher text,
  add column agent_checksum text;

update allrice_skill_versions version
set agent_name = catalog.name,
    agent_description = catalog.description,
    agent_publisher = catalog.publisher,
    agent_checksum = 'sha256:' || encode(sha256(convert_to(
      jsonb_build_object(
        'artifactChecksum', object.checksum,
        'version', version.version,
        'name', catalog.name,
        'description', catalog.description,
        'publisher', catalog.publisher,
        'capabilities', version.capabilities,
        'source', version.source,
        'metadata', version.agent_metadata
      )::text,
      'UTF8'
    )), 'hex')
from allrice_catalog_skills catalog,
     allrice_storage_objects object
where catalog.id = version.catalog_skill_id
  and object.id = version.artifact_object_id;

create function allrice_fill_agent_skill_revision_identity()
returns trigger language plpgsql as $$
declare
  catalog_name text;
  catalog_description text;
  catalog_publisher text;
  artifact_checksum text;
begin
  select catalog.name, catalog.description, catalog.publisher
    into catalog_name, catalog_description, catalog_publisher
  from allrice_catalog_skills catalog
  where catalog.id = new.catalog_skill_id;

  select object.checksum into artifact_checksum
  from allrice_storage_objects object
  where object.id = new.artifact_object_id;

  new.agent_name := coalesce(new.agent_name, catalog_name);
  new.agent_description := coalesce(
    new.agent_description,
    catalog_description
  );
  new.agent_publisher := coalesce(new.agent_publisher, catalog_publisher);
  new.agent_checksum := coalesce(
    new.agent_checksum,
    'sha256:' || encode(sha256(convert_to(
      jsonb_build_object(
        'artifactChecksum', artifact_checksum,
        'version', new.version,
        'name', new.agent_name,
        'description', new.agent_description,
        'publisher', new.agent_publisher,
        'capabilities', new.capabilities,
        'source', new.source,
        'metadata', new.agent_metadata
      )::text,
      'UTF8'
    )), 'hex')
  );
  return new;
end;
$$;

create trigger allrice_agent_skill_revision_identity_fill
before insert on allrice_skill_versions
for each row execute function allrice_fill_agent_skill_revision_identity();

alter table allrice_skill_versions
  alter column agent_name set not null,
  alter column agent_description set not null,
  alter column agent_publisher set not null,
  alter column agent_checksum set not null,
  add check (agent_checksum ~ '^sha256:[a-f0-9]{64}$');

create or replace function allrice_reject_published_skill_mutation()
returns trigger language plpgsql as $$
begin
  if old.status = 'published' and (
    new.catalog_skill_id is distinct from old.catalog_skill_id or
    new.version is distinct from old.version or
    new.capabilities is distinct from old.capabilities or
    new.compatibility is distinct from old.compatibility or
    new.artifact_object_id is distinct from old.artifact_object_id or
    new.source is distinct from old.source or
    new.agent_metadata is distinct from old.agent_metadata or
    new.agent_name is distinct from old.agent_name or
    new.agent_description is distinct from old.agent_description or
    new.agent_publisher is distinct from old.agent_publisher or
    new.agent_checksum is distinct from old.agent_checksum or
    new.published_at is distinct from old.published_at
  ) then
    raise exception 'published skill versions are immutable';
  end if;
  return new;
end;
$$;

insert into allrice_runtime_metadata (key, value)
values (
  'agent-skill-revision-identity',
  '{"version":"0025","issue":"MET-68","catalogSnapshot":true,"completeChecksum":true}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
