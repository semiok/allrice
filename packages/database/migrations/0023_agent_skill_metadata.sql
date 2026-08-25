-- Agent Skill is backed by the existing immutable SkillHub SkillVersion, but
-- it also carries model-facing routing metadata required by EmployeeHub.

alter table allrice_skill_versions
  add column agent_metadata jsonb not null default
    '{"applicableScenarios":[],"inputSchema":{},"outputSchema":{},"requiredToolRefs":[],"riskLevel":"low"}'::jsonb,
  add check (jsonb_typeof(agent_metadata) = 'object');

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
    new.published_at is distinct from old.published_at
  ) then
    raise exception 'published skill versions are immutable';
  end if;
  return new;
end;
$$;

insert into allrice_runtime_metadata (key, value)
values (
  'agent-skill-metadata-schema',
  '{"version":"0023","issue":"MET-68","skillHubAuthority":true,"immutable":true}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
