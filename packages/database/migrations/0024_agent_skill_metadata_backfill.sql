-- Existing audited SkillHub entries predate Agent Skill routing metadata. Give
-- them deterministic metadata without changing their artifact or revision ID.

alter table allrice_skill_versions
  disable trigger allrice_skill_versions_immutable;

update allrice_skill_versions version
set agent_metadata = jsonb_build_object(
  'applicableScenarios', jsonb_build_array(catalog.description),
  'inputSchema', '{"type":"object","required":["request"]}'::jsonb,
  'outputSchema', '{"type":"object","required":["result"]}'::jsonb,
  'requiredToolRefs', case
    when version.capabilities ? 'network:outbound'
      then '["codex-hosted-search"]'::jsonb
    else '[]'::jsonb
  end,
  'riskLevel', case
    when version.capabilities ? 'secret:use' then 'high'
    when version.capabilities ? 'network:outbound'
      or version.capabilities ? 'storage:write' then 'medium'
    else 'low'
  end
)
from allrice_catalog_skills catalog
where catalog.id = version.catalog_skill_id
  and version.agent_metadata =
    '{"applicableScenarios":[],"inputSchema":{},"outputSchema":{},"requiredToolRefs":[],"riskLevel":"low"}'::jsonb;

alter table allrice_skill_versions
  enable trigger allrice_skill_versions_immutable;

insert into allrice_runtime_metadata (key, value)
values (
  'agent-skill-metadata-backfill',
  '{"version":"0024","issue":"MET-68","strategy":"catalog-description-and-capabilities"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
