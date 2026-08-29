-- Keep the platform Skill catalog readable for Chinese-speaking administrators.
-- Canonical SKILL.md frontmatter carries the complete trigger description;
-- these shorter descriptions are the summaries shown in the employee console.

update allrice_platform_dsh_skills
set description = case name
      when 'web-research' then
        '使用获准的网页搜索研究最新公开信息，核验重要事实，并提供附有来源的综合结论。'
      when 'workspace-briefing' then
        '检查当前已授权的本地工作区，根据其中的文件和 Git 状态生成有依据的工作简报。'
    end,
    updated_at = now()
where name in ('web-research', 'workspace-briefing');

update allrice_dsh_skills
set description = platform.description,
    updated_at = now()
from allrice_platform_dsh_skills platform
where allrice_dsh_skills.name = platform.name
  and platform.name in ('web-research', 'workspace-briefing');

insert into allrice_runtime_metadata (key, value)
values (
  'foundational-skill-localization',
  '{"version":"0054","issue":"MET-92","locale":"zh-CN","skills":["web-research","workspace-briefing"]}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
