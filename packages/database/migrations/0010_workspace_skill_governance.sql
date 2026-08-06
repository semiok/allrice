alter table allrice_skill_installations
  alter column owner_id drop not null;

do $$
declare
  constraint_name text;
begin
  select c.conname into constraint_name
  from pg_constraint c
  where c.conrelid = 'allrice_skill_installations'::regclass
    and c.contype = 'u'
    and pg_get_constraintdef(c.oid) =
      'UNIQUE (organization_id, workspace_id, owner_id, catalog_skill_id)';
  if constraint_name is not null then
    execute format(
      'alter table allrice_skill_installations drop constraint %I',
      constraint_name
    );
  end if;
end;
$$;

create unique index allrice_skill_installations_personal_unique
  on allrice_skill_installations (
    organization_id, workspace_id, owner_id, catalog_skill_id
  ) where owner_id is not null;

create unique index allrice_skill_installations_workspace_unique
  on allrice_skill_installations (
    organization_id, workspace_id, catalog_skill_id
  ) where owner_id is null;

insert into allrice_runtime_metadata (key, value)
values (
  'skill-governance-schema',
  '{"version":"0010","issue":"MET-53","workspaceInstallations":true,"capabilityRule":"employee-intersection-skill"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
