-- MET-93: platform AI employee production backend. Platform definitions are
-- global authoring records; tenant employee/version rows remain runtime copies.

create table allrice_platform_dsh_skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text not null,
  content text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  model_invocable boolean not null default true,
  user_invocable boolean not null default true,
  required_tool_refs jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  source text not null default 'allrice'
    check (source in ('allrice', 'dsh-migrated')),
  created_by_label text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(content) <= 500000),
  check (jsonb_typeof(required_tool_refs) = 'array')
);

insert into allrice_platform_dsh_skills (
  name, description, content, checksum, model_invocable, user_invocable,
  required_tool_refs, enabled, source, created_by_label
)
select distinct on (name)
  name, description, content, checksum, model_invocable, user_invocable,
  required_tool_refs, enabled, 'allrice', 'MET-93 migration'
from allrice_dsh_skills
order by name, updated_at desc, id;

create table allrice_platform_employees (
  id uuid primary key default gen_random_uuid(),
  employee_key text not null unique
    check (employee_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  description text not null,
  status text not null default 'draft'
    check (status in ('draft', 'testing', 'published', 'disabled', 'archived')),
  current_draft_revision_id uuid,
  current_published_revision_id uuid,
  created_by_label text not null default 'system',
  updated_by_label text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table allrice_platform_employee_revisions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  revision integer not null check (revision > 0),
  status text not null default 'draft'
    check (status in ('draft', 'testing', 'published', 'disabled')),
  definition jsonb not null,
  runtime_profile jsonb,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  validation_report jsonb not null default '{"valid":false,"errors":[]}'::jsonb,
  created_by_label text not null default 'system',
  published_by_label text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (employee_id, revision),
  unique (employee_id, id),
  check (jsonb_typeof(definition) = 'object'),
  check (runtime_profile is null or jsonb_typeof(runtime_profile) = 'object'),
  check (jsonb_typeof(validation_report) = 'object')
);

alter table allrice_platform_employees
  add foreign key (id, current_draft_revision_id)
    references allrice_platform_employee_revisions(employee_id, id),
  add foreign key (id, current_published_revision_id)
    references allrice_platform_employee_revisions(employee_id, id);

create table allrice_platform_employee_tenant_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  revision_id uuid not null,
  organization_id uuid not null,
  workspace_id uuid not null,
  tenant_employee_id uuid,
  tenant_employee_version_id uuid,
  active boolean not null default true,
  assigned_by_label text not null default 'system',
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (employee_id, revision_id)
    references allrice_platform_employee_revisions(employee_id, id),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, tenant_employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, tenant_employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id),
  unique (employee_id, workspace_id)
);

create table allrice_platform_employee_test_runs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  revision_id uuid not null,
  requested_by_label text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  input jsonb not null,
  output jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (employee_id, revision_id)
    references allrice_platform_employee_revisions(employee_id, id),
  check (jsonb_typeof(input) = 'object'),
  check (output is null or jsonb_typeof(output) = 'object')
);

with definition as (
  select jsonb_build_object(
    'schemaVersion', 1,
    'key', 'rice',
    'name', 'Rice',
    'description', 'AllRice 默认通用 AI 员工，负责理解目标、推进工作并交付可继续协作的结果。',
    'appearance', jsonb_build_object('avatarType', 'initials', 'avatarValue', 'R'),
    'identity', jsonb_build_object(
      'role', '通用工作伙伴',
      'mission', '理解目标、推进任务，并交付可继续协作的结果。',
      'workStyle', '先理解目标，再结构化推进；结论优先，明确说明假设、结果和下一步。',
      'behaviorRules', jsonb_build_array(
        '先理解目标、约束和授权范围，再开始执行。',
        '缺少关键信息时明确说明，不编造数据或执行结果。',
        '优先交付可编辑、可复用、可继续协作的结果。'
      ),
      'safetyBoundaries', jsonb_build_array(
        '只能使用当前租户、工作区、用户和员工获授权的数据。',
        '不得读取、输出或持久化凭证和其他租户信息。',
        '有外部副作用或不可逆影响的动作必须遵循审批策略。'
      ),
      'expressionStyle', 'structured',
      'outputLanguage', 'zh-CN'
    ),
    'systemPrompt', 'You are Rice, the default AI employee in AllRice. Understand the desired outcome and constraints, use only authorized tenant-scoped context and tools, deliver reusable results, and never claim an action or lookup succeeded when it did not.',
    'modelPolicy', jsonb_build_object(
      'provider', 'openai-codex',
      'model', 'gpt-5.6-luna',
      'reasoningEffort', 'xhigh',
      'timeoutMs', 300000,
      'fallbackModels', jsonb_build_array(),
      'credentialReference', 'deployment:codex-default',
      'baseUrl', null
    ),
    'capabilities', jsonb_build_object(
      'nativeSkillIds', jsonb_build_array(),
      'workflowRevisionIds', jsonb_build_array(),
      'knowledgeRevisionIds', jsonb_build_array(),
      'toolNames', jsonb_build_array(
        'workspace.file.list', 'workspace.file.read',
        'workspace.memory.search', 'workspace.session.search',
        'web.search', 'web.fetch',
        'local.fs.list', 'local.fs.search', 'local.fs.read',
        'local.git.status', 'local.git.diff', 'automation.create'
      ),
      'connectorRefs', jsonb_build_array()
    ),
    'securityPolicy', jsonb_build_object(
      'dataScopes', jsonb_build_array('workspace', 'employee', 'user'),
      'approvalPolicy', 'confirm_side_effects',
      'bridgeAccess', 'read_only',
      'connectorIdentityModes', jsonb_build_array('user'),
      'deniedCapabilities', jsonb_build_array('secret:use')
    )
  ) as value
), employee as (
  insert into allrice_platform_employees (
    employee_key, name, description, status, created_by_label, updated_by_label
  )
  select 'rice', 'Rice', value ->> 'description', 'published',
    'MET-93 migration', 'MET-93 migration'
  from definition
  returning id
), revision as (
  insert into allrice_platform_employee_revisions (
    employee_id, revision, status, definition, runtime_profile, checksum,
    validation_report, created_by_label, published_by_label, published_at
  )
  select employee.id, 1, 'published', definition.value,
    jsonb_build_object(
      'schemaVersion', 1, 'harness', 'dsh', 'employeeKey', 'rice',
      'provider', 'openai-codex', 'model', 'gpt-5.6-luna',
      'reasoningEffort', 'xhigh', 'timeoutMs', 300000,
      'credentialReference', 'deployment:codex-default',
      'systemPrompt', definition.value ->> 'systemPrompt',
      'nativeSkillIds', jsonb_build_array(),
      'nativeSkillChecksums', jsonb_build_array(),
      'toolNames', definition.value #> '{capabilities,toolNames}',
      'connectorRefs', jsonb_build_array(),
      'securityPolicy', definition.value -> 'securityPolicy'
    ),
    'sha256:aad7ef063229704973b32d6a4de82084213dc2634a75c3805cb1092d32d7c5b7',
    '{"valid":true,"errors":[],"warnings":[]}'::jsonb,
    'MET-93 migration', 'MET-93 migration', now()
  from employee cross join definition
  returning id, employee_id
)
update allrice_platform_employees employee
set current_draft_revision_id = revision.id,
    current_published_revision_id = revision.id
from revision
where employee.id = revision.employee_id;

-- Data-modifying CTE statements share one snapshot, so the update above is a
-- no-op on PostgreSQL even though the revision is returned. Bind the seeded
-- revision in a following statement, where the inserted employee is visible.
update allrice_platform_employees employee
set current_draft_revision_id = revision.id,
    current_published_revision_id = revision.id
from allrice_platform_employee_revisions revision
where revision.employee_id = employee.id
  and employee.employee_key = 'rice'
  and revision.revision = 1;

insert into allrice_runtime_metadata (key, value)
values (
  'platform-employee-production',
  '{"version":"0048","issue":"MET-93","authority":"allrice-control-plane","harness":"dsh","initialEmployee":"Rice"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
