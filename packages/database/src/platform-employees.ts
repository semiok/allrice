import { createHash } from 'node:crypto';

import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRevisionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  PlatformEmployeeSummarySchema,
  PlatformEmployeeTestRunOutputSchema,
  PlatformEmployeeTestRunSchema,
  CreatePlatformEmployeeTestRunInputSchema,
  DshNativeSkillSnapshotSchema,
  PublishPlatformEmployeeInputSchema,
  UpdatePlatformEmployeeInputSchema,
  UuidSchema,
  type PlatformEmployeeDefinition,
  type PlatformEmployeeTestRunOutput,
} from '@allrice/contracts';

import {
  employeeManifest,
  employeeManifestChecksum,
} from './employee-config.ts';
import { getDatabase } from './index.ts';

const allowedToolNames = new Set([
  'workspace.file.list',
  'workspace.file.read',
  'workspace.memory.search',
  'workspace.session.search',
  'web.search',
  'web.fetch',
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.git.status',
  'local.git.diff',
  'automation.create',
]);

interface RevisionRow {
  id: string;
  employee_id: string;
  revision: number;
  status: 'draft' | 'testing' | 'published' | 'disabled';
  definition: unknown;
  runtime_profile: unknown | null;
  checksum: string;
  created_at: Date;
  published_at: Date | null;
}

interface EmployeeRow {
  id: string;
  employee_key: string;
  name: string;
  description: string;
  status: 'draft' | 'testing' | 'published' | 'disabled' | 'archived';
  current_draft_revision_id: string | null;
  current_published_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
  assigned_workspace_ids: string[];
}

interface TestRunRow {
  id: string;
  employee_id: string;
  revision_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  input: unknown;
  output: unknown | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function checksum(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function revisionSnapshot(row: RevisionRow | undefined) {
  if (!row) return null;
  return PlatformEmployeeRevisionSchema.parse({
    id: row.id,
    employeeId: row.employee_id,
    revision: row.revision,
    status: row.status,
    definition: row.definition,
    runtimeProfile: row.runtime_profile,
    checksum: row.checksum,
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
  });
}

async function hydrateEmployees(rows: EmployeeRow[]) {
  const sql = getDatabase();
  const revisionIds = rows.flatMap((row) =>
    [row.current_draft_revision_id, row.current_published_revision_id].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const revisions =
    revisionIds.length === 0
      ? []
      : await sql<RevisionRow[]>`
          select id, employee_id, revision, status, definition,
            runtime_profile, checksum, created_at, published_at
          from allrice_platform_employee_revisions
          where id in ${sql(revisionIds)}
        `;
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  return rows.map((row) =>
    PlatformEmployeeSummarySchema.parse({
      id: row.id,
      employeeKey: row.employee_key,
      name: row.name,
      description: row.description,
      status: row.status,
      currentDraft: revisionSnapshot(
        row.current_draft_revision_id
          ? byId.get(row.current_draft_revision_id)
          : undefined,
      ),
      currentPublished: revisionSnapshot(
        row.current_published_revision_id
          ? byId.get(row.current_published_revision_id)
          : undefined,
      ),
      assignedWorkspaceIds: row.assigned_workspace_ids,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }),
  );
}

export async function listPlatformEmployees() {
  const sql = getDatabase();
  const rows = await sql<EmployeeRow[]>`
    select employee.*,
      coalesce((
        select array_agg(assignment.workspace_id order by assignment.workspace_id)
        from allrice_platform_employee_tenant_assignments assignment
        where assignment.employee_id = employee.id and assignment.active
      ), array[]::uuid[]) as assigned_workspace_ids
    from allrice_platform_employees employee
    where employee.status <> 'archived'
    order by (employee.employee_key = 'rice') desc, employee.name, employee.id
  `;
  return hydrateEmployees(rows);
}

export async function getPlatformEmployee(employeeIdInput: string) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const sql = getDatabase();
  const rows = await sql<EmployeeRow[]>`
    select employee.*,
      coalesce((
        select array_agg(assignment.workspace_id order by assignment.workspace_id)
        from allrice_platform_employee_tenant_assignments assignment
        where assignment.employee_id = employee.id and assignment.active
      ), array[]::uuid[]) as assigned_workspace_ids
    from allrice_platform_employees employee
    where employee.id = ${employeeId}
  `;
  return (await hydrateEmployees(rows))[0] ?? null;
}

export async function listPlatformEmployeeWorkspaces() {
  const sql = getDatabase();
  return sql<
    {
      id: string;
      organizationId: string;
      organizationName: string;
      slug: string;
      name: string;
      assigned: boolean;
    }[]
  >`
    select workspace.id, workspace.organization_id as "organizationId",
      organization.name as "organizationName", workspace.slug, workspace.name,
      false as assigned
    from allrice_workspaces workspace
    join allrice_organizations organization on organization.id = workspace.organization_id
    where workspace.archived_at is null and organization.archived_at is null
    order by organization.name, workspace.name, workspace.id
  `;
}

export async function listPlatformNativeSkills() {
  const sql = getDatabase();
  return sql<
    {
      id: string;
      name: string;
      description: string;
      checksum: string;
      requiredToolRefs: string[];
      enabled: boolean;
      source: 'allrice' | 'dsh-migrated';
    }[]
  >`
    select id, name, description, checksum,
      required_tool_refs as "requiredToolRefs", enabled, source
    from allrice_platform_dsh_skills
    order by enabled desc, name, id
  `;
}

function testRunSnapshot(row: TestRunRow) {
  return PlatformEmployeeTestRunSchema.parse({
    id: row.id,
    employeeId: row.employee_id,
    revisionId: row.revision_id,
    status: row.status,
    input: row.input,
    output: row.output,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

export async function listPlatformEmployeeTestRuns(
  employeeIdInput: string,
  limitInput = 10,
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const limit = Math.min(Math.max(Math.trunc(limitInput), 1), 50);
  const sql = getDatabase();
  const rows = await sql<TestRunRow[]>`
    select id, employee_id, revision_id, status, input, output,
      created_at, started_at, completed_at
    from allrice_platform_employee_test_runs
    where employee_id = ${employeeId}
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map(testRunSnapshot);
}

export async function queuePlatformEmployeeTestRun(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const parsed = CreatePlatformEmployeeTestRunInputSchema.parse(input);
  const compilation = await compilePlatformEmployee(employeeId, actorLabel);
  if (!compilation.valid || !compilation.runtimeProfile) {
    return { queued: false as const, ...compilation, testRun: null };
  }
  const sql = getDatabase();
  const rows = await sql<TestRunRow[]>`
    insert into allrice_platform_employee_test_runs (
      employee_id, revision_id, requested_by_label, status, input
    ) values (
      ${employeeId}, ${compilation.revisionId}, ${actorLabel}, 'queued',
      ${sql.json(parsed)}
    )
    returning id, employee_id, revision_id, status, input, output,
      created_at, started_at, completed_at
  `;
  const row = rows[0];
  if (!row) throw new Error('platform_employee_test_queue_failed');
  return {
    queued: true as const,
    valid: true,
    errors: [] as string[],
    warnings: compilation.warnings,
    testRun: testRunSnapshot(row),
  };
}

export async function claimNextPlatformEmployeeTestRun(workerIdInput: string) {
  const workerId = UuidSchema.parse(workerIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await transaction`
      update allrice_platform_employee_test_runs
      set status = 'failed', completed_at = now(),
        output = ${transaction.json({
          answer: null,
          provider: null,
          model: null,
          threadId: null,
          usage: null,
          events: [],
          error: {
            code: 'TEST_WORKER_TIMEOUT',
            message: '隔离测试 Worker 超时，任务已终止。',
          },
        })}
      where status = 'running'
        and started_at < now() - interval '15 minutes'
    `;
    const rows = await transaction<
      (TestRunRow & { runtime_profile: unknown; definition: unknown })[]
    >`
      select test.id, test.employee_id, test.revision_id, test.status,
        test.input, test.output, test.created_at, test.started_at,
        test.completed_at, revision.runtime_profile, revision.definition
      from allrice_platform_employee_test_runs test
      join allrice_platform_employee_revisions revision
        on revision.id = test.revision_id
      where test.status = 'queued' and revision.status = 'testing'
        and revision.runtime_profile is not null
      order by test.created_at, test.id
      for update of test skip locked
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    await transaction`
      update allrice_platform_employee_test_runs
      set status = 'running', worker_id = ${workerId}, started_at = now()
      where id = ${row.id}
    `;
    const runtimeProfile = PlatformEmployeeRuntimeProfileSchema.parse(
      row.runtime_profile,
    );
    const definition = PlatformEmployeeDefinitionSchema.parse(row.definition);
    const skillRows =
      runtimeProfile.nativeSkillIds.length === 0
        ? []
        : await transaction<
            {
              id: string;
              name: string;
              description: string;
              content: string;
              checksum: string;
              model_invocable: boolean;
              user_invocable: boolean;
              required_tool_refs: string[];
            }[]
          >`
            select id, name, description, content, checksum, model_invocable,
              user_invocable, required_tool_refs
            from allrice_platform_dsh_skills
            where id in ${transaction(runtimeProfile.nativeSkillIds)} and enabled
          `;
    const nativeSkills = skillRows.map((skill) =>
      DshNativeSkillSnapshotSchema.parse({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        checksum: skill.checksum,
        invocation: {
          modelInvocable: skill.model_invocable,
          userInvocable: skill.user_invocable,
        },
        requiredToolRefs: skill.required_tool_refs,
      }),
    );
    return {
      id: row.id,
      employeeId: row.employee_id,
      revisionId: row.revision_id,
      input: CreatePlatformEmployeeTestRunInputSchema.parse(row.input),
      runtimeProfile,
      definition,
      nativeSkills,
    };
  });
}

export async function completePlatformEmployeeTestRun(
  testRunIdInput: string,
  outputInput: PlatformEmployeeTestRunOutput,
) {
  const testRunId = UuidSchema.parse(testRunIdInput);
  const output = PlatformEmployeeTestRunOutputSchema.parse(outputInput);
  const persistedOutput: unknown = JSON.parse(JSON.stringify(output));
  const status = output.error ? 'failed' : 'succeeded';
  const sql = getDatabase();
  const rows = await sql<TestRunRow[]>`
    update allrice_platform_employee_test_runs
    set status = ${status}, output = ${sql.json(persistedOutput as never)},
      completed_at = now()
    where id = ${testRunId} and status = 'running'
    returning id, employee_id, revision_id, status, input, output,
      created_at, started_at, completed_at
  `;
  const row = rows[0];
  if (!row) throw new Error('platform_employee_test_not_running');
  return testRunSnapshot(row);
}

export async function savePlatformEmployeeDraft(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const { definition } = UpdatePlatformEmployeeInputSchema.parse(input);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const employees = await transaction<{ id: string }[]>`
      select id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    if (!employees[0]) throw new Error('platform_employee_not_found');
    const nextRows = await transaction<{ revision: number }[]>`
      select coalesce(max(revision), 0)::integer + 1 as revision
      from allrice_platform_employee_revisions
      where employee_id = ${employeeId}
    `;
    const inserted = await transaction<{ id: string }[]>`
      insert into allrice_platform_employee_revisions (
        employee_id, revision, status, definition, runtime_profile,
        checksum, validation_report, created_by_label
      ) values (
        ${employeeId}, ${nextRows[0]?.revision ?? 1}, 'draft',
        ${transaction.json(definition)}, null, ${checksum(definition)},
        ${transaction.json({ valid: false, errors: [], warnings: [] })},
        ${actorLabel}
      ) returning id
    `;
    const revisionId = inserted[0]?.id;
    if (!revisionId) throw new Error('platform_employee_revision_failed');
    await transaction`
      update allrice_platform_employees
      set employee_key = ${definition.key}, name = ${definition.name},
        description = ${definition.description}, status = 'draft',
        current_draft_revision_id = ${revisionId},
        updated_by_label = ${actorLabel}, updated_at = now()
      where id = ${employeeId}
    `;
  });
  return getPlatformEmployee(employeeId);
}

export async function compilePlatformEmployee(
  employeeIdInput: string,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const revisions = await transaction<RevisionRow[]>`
      select revision.*
      from allrice_platform_employees employee
      join allrice_platform_employee_revisions revision
        on revision.id = employee.current_draft_revision_id
      where employee.id = ${employeeId}
      for update of revision
    `;
    const revision = revisions[0];
    if (!revision) throw new Error('platform_employee_draft_not_found');
    const definition = PlatformEmployeeDefinitionSchema.parse(
      revision.definition,
    );
    const errors: string[] = [];
    const warnings: string[] = [];
    const unknownTools = definition.capabilities.toolNames.filter(
      (name) => !allowedToolNames.has(name),
    );
    if (unknownTools.length > 0) {
      errors.push(`未注册工具：${unknownTools.join(', ')}`);
    }
    const skills =
      definition.capabilities.nativeSkillIds.length === 0
        ? []
        : await transaction<
            {
              id: string;
              checksum: string;
              enabled: boolean;
              required_tool_refs: string[];
            }[]
          >`
            select id, checksum, enabled, required_tool_refs
            from allrice_platform_dsh_skills
            where id in ${transaction(definition.capabilities.nativeSkillIds)}
          `;
    const foundSkillIds = new Set(skills.map((skill) => skill.id));
    const missingSkills = definition.capabilities.nativeSkillIds.filter(
      (id) => !foundSkillIds.has(id),
    );
    if (missingSkills.length > 0) {
      errors.push(`Skill 不存在：${missingSkills.join(', ')}`);
    }
    const disabledSkills = skills.filter((skill) => !skill.enabled);
    if (disabledSkills.length > 0) {
      errors.push(
        `Skill 已停用：${disabledSkills.map((skill) => skill.id).join(', ')}`,
      );
    }
    const grantedTools = new Set(definition.capabilities.toolNames);
    const missingRequiredTools = skills.flatMap((skill) =>
      skill.required_tool_refs.filter((name) => !grantedTools.has(name)),
    );
    if (missingRequiredTools.length > 0) {
      errors.push(
        `Skill 缺少所需工具：${[...new Set(missingRequiredTools)].join(', ')}`,
      );
    }
    if (
      definition.securityPolicy.bridgeAccess === 'none' &&
      definition.capabilities.toolNames.some((name) =>
        name.startsWith('local.'),
      )
    ) {
      errors.push('Bridge 已禁用，但员工仍配置了 local.* 工具');
    }
    if (definition.modelPolicy.provider !== 'openai-codex') {
      warnings.push('非 Codex Provider 需要平台凭证和可用性检查后才能发布。');
    }
    if (
      definition.modelPolicy.provider === 'openai-compatible' &&
      !definition.modelPolicy.baseUrl
    ) {
      errors.push('OpenAI Compatible Provider 必须配置 Base URL。');
    }
    const profile =
      errors.length === 0
        ? PlatformEmployeeRuntimeProfileSchema.parse({
            schemaVersion: 1,
            harness: 'dsh',
            employeeKey: definition.key,
            provider: definition.modelPolicy.provider,
            model: definition.modelPolicy.model,
            reasoningEffort: definition.modelPolicy.reasoningEffort,
            timeoutMs: definition.modelPolicy.timeoutMs,
            credentialReference: definition.modelPolicy.credentialReference,
            baseUrl: definition.modelPolicy.baseUrl,
            systemPrompt: definition.systemPrompt,
            nativeSkillIds: skills.map((skill) => skill.id),
            nativeSkillChecksums: skills.map((skill) => skill.checksum),
            toolNames: definition.capabilities.toolNames,
            connectorRefs: definition.capabilities.connectorRefs,
            securityPolicy: definition.securityPolicy,
          })
        : null;
    const report = { valid: errors.length === 0, errors, warnings };
    await transaction`
      update allrice_platform_employee_revisions
      set status = ${errors.length === 0 ? 'testing' : 'draft'},
        runtime_profile = ${profile ? transaction.json(profile) : null},
        validation_report = ${transaction.json(report)}
      where id = ${revision.id}
    `;
    await transaction`
      update allrice_platform_employees
      set status = ${errors.length === 0 ? 'testing' : 'draft'},
        updated_by_label = ${actorLabel}, updated_at = now()
      where id = ${employeeId}
    `;
    return { revisionId: revision.id, runtimeProfile: profile, ...report };
  });
}

function tenantManifest(definition: PlatformEmployeeDefinition) {
  return employeeManifest({
    key: definition.key === 'rice' ? 'default-assistant' : definition.key,
    name: definition.name,
    description: definition.description,
    role: definition.identity.role,
    appearance: definition.appearance,
    behaviorRules: definition.identity.behaviorRules,
    safetyBoundaries: definition.identity.safetyBoundaries,
    identity: {
      role: definition.identity.role,
      mission: definition.identity.mission,
      workStyle: definition.identity.workStyle,
      behaviorRules: definition.identity.behaviorRules,
      safetyBoundaries: definition.identity.safetyBoundaries,
    },
    partnerProfile: {
      role: definition.identity.role,
      mission: definition.identity.mission,
      communicationStyle: definition.identity.expressionStyle,
      outputLanguage: definition.identity.outputLanguage,
      proactivePolicy: 'suggest',
      approvalPolicy: definition.securityPolicy.approvalPolicy,
    },
    runtimePolicy: {
      harness: 'dsh',
      provider: definition.modelPolicy.provider,
      model: definition.modelPolicy.model,
      reasoningEffort: definition.modelPolicy.reasoningEffort,
      timeoutMs: definition.modelPolicy.timeoutMs,
      fallbackModels: definition.modelPolicy.fallbackModels,
      credentialReference: definition.modelPolicy.credentialReference,
      baseUrl: definition.modelPolicy.baseUrl,
    },
    securityPolicy: {
      dataScopes: definition.securityPolicy.dataScopes,
      connectorIdentityModes: definition.securityPolicy.connectorIdentityModes,
      approvalPolicy: definition.securityPolicy.approvalPolicy,
      deniedCapabilities: definition.securityPolicy.deniedCapabilities,
    },
    toolNames: definition.capabilities.toolNames,
  });
}

export async function publishPlatformEmployee(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const { workspaceIds } = PublishPlatformEmployeeInputSchema.parse(input);
  const compilation = await compilePlatformEmployee(employeeId, actorLabel);
  if (!compilation.valid) return compilation;
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const revisions = await transaction<RevisionRow[]>`
      select revision.*
      from allrice_platform_employees employee
      join allrice_platform_employee_revisions revision
        on revision.id = employee.current_draft_revision_id
      where employee.id = ${employeeId} and revision.status = 'testing'
      for update of employee, revision
    `;
    const revision = revisions[0];
    if (!revision?.runtime_profile)
      throw new Error('platform_employee_not_compiled');
    const definition = PlatformEmployeeDefinitionSchema.parse(
      revision.definition,
    );
    const manifest = tenantManifest(definition);
    const manifestChecksum = employeeManifestChecksum(manifest);
    for (const workspaceId of workspaceIds) {
      const workspaces = await transaction<
        { id: string; organization_id: string }[]
      >`
        select id, organization_id from allrice_workspaces
        where id = ${workspaceId} and archived_at is null
      `;
      const workspace = workspaces[0];
      if (!workspace) throw new Error(`workspace_not_found:${workspaceId}`);
      const actors = await transaction<{ id: string }[]>`
        select membership.user_id as id
        from allrice_memberships membership
        join allrice_users actor on actor.id = membership.user_id
        where membership.organization_id = ${workspace.organization_id}
          and (membership.workspace_id is null or membership.workspace_id = ${workspace.id})
          and membership.active and actor.status = 'active'
        order by case membership.role when 'admin' then 0 when 'member' then 1 else 2 end,
          membership.created_at, membership.id
        limit 1
      `;
      const actorId = actors[0]?.id;
      if (!actorId)
        throw new Error(`workspace_has_no_active_member:${workspaceId}`);
      const tenantKey =
        definition.key === 'rice' ? 'default-assistant' : definition.key;
      const employees = await transaction<{ id: string }[]>`
        insert into allrice_employees (
          organization_id, workspace_id, employee_key, name, status
        ) values (
          ${workspace.organization_id}, ${workspace.id}, ${tenantKey},
          ${definition.name}, 'active'
        )
        on conflict (organization_id, workspace_id, employee_key)
        do update set name = excluded.name, status = 'active', updated_at = now()
        returning id
      `;
      const tenantEmployeeId = employees[0]?.id;
      if (!tenantEmployeeId)
        throw new Error('tenant_employee_materialize_failed');
      const nextVersions = await transaction<{ version: number }[]>`
        select coalesce(max(version), 0)::integer + 1 as version
        from allrice_employee_versions where employee_id = ${tenantEmployeeId}
      `;
      const versions = await transaction<{ id: string }[]>`
        insert into allrice_employee_versions (
          organization_id, workspace_id, employee_id, version, name,
          description, model, system_prompt, capabilities, manifest,
          provider_snapshot, skill_version_ids, config_checksum
        ) values (
          ${workspace.organization_id}, ${workspace.id}, ${tenantEmployeeId},
          ${nextVersions[0]?.version ?? 1}, ${manifest.name},
          ${manifest.description}, ${manifest.provider.model},
          ${manifest.systemPrompt}, ${transaction.json(manifest.capabilities)},
          ${transaction.json(manifest)}, ${transaction.json(manifest.provider)},
          ${transaction.json([])}, ${manifestChecksum}
        ) returning id
      `;
      const tenantVersionId = versions[0]?.id;
      if (!tenantVersionId) throw new Error('tenant_employee_version_failed');
      await transaction`
        update allrice_employee_assignments
        set employee_version_id = ${tenantVersionId}, active = true, updated_at = now()
        where organization_id = ${workspace.organization_id}
          and workspace_id = ${workspace.id}
          and employee_id = ${tenantEmployeeId}
      `;
      await transaction`
        insert into allrice_employee_assignments (
          organization_id, workspace_id, employee_id, employee_version_id,
          user_id, is_default, active, assigned_by
        )
        select ${workspace.organization_id}, ${workspace.id}, ${tenantEmployeeId},
          ${tenantVersionId}, member.user_id,
          ${definition.key === 'rice'}, true, ${actorId}
        from (
          select distinct membership.user_id
          from allrice_memberships membership
          join allrice_users member_user on member_user.id = membership.user_id
          where membership.organization_id = ${workspace.organization_id}
            and (membership.workspace_id is null or membership.workspace_id = ${workspace.id})
            and membership.active and member_user.status = 'active'
        ) member
        on conflict (organization_id, workspace_id, user_id, employee_id)
        do update set employee_version_id = excluded.employee_version_id,
          active = true, assigned_by = excluded.assigned_by,
          assigned_at = now(), updated_at = now()
      `;
      await transaction`
        delete from allrice_employee_dsh_skill_bindings
        where organization_id = ${workspace.organization_id}
          and workspace_id = ${workspace.id}
          and employee_id = ${tenantEmployeeId}
      `;
      for (const platformSkillId of definition.capabilities.nativeSkillIds) {
        const materialized = await transaction<{ id: string }[]>`
          insert into allrice_dsh_skills (
            organization_id, workspace_id, name, description, content,
            checksum, model_invocable, user_invocable, required_tool_refs,
            enabled, created_by
          )
          select ${workspace.organization_id}, ${workspace.id}, name,
            description, content, checksum, model_invocable, user_invocable,
            required_tool_refs, enabled, ${actorId}
          from allrice_platform_dsh_skills where id = ${platformSkillId}
          on conflict (organization_id, workspace_id, name)
          do update set description = excluded.description,
            content = excluded.content, checksum = excluded.checksum,
            model_invocable = excluded.model_invocable,
            user_invocable = excluded.user_invocable,
            required_tool_refs = excluded.required_tool_refs,
            enabled = excluded.enabled, updated_at = now()
          returning id
        `;
        const skillId = materialized[0]?.id;
        if (!skillId) throw new Error('tenant_skill_materialize_failed');
        await transaction`
          insert into allrice_employee_dsh_skill_bindings (
            organization_id, workspace_id, employee_id, skill_id, bound_by
          ) values (
            ${workspace.organization_id}, ${workspace.id}, ${tenantEmployeeId},
            ${skillId}, ${actorId}
          )
        `;
      }
      await transaction`
        insert into allrice_platform_employee_tenant_assignments (
          employee_id, revision_id, organization_id, workspace_id,
          tenant_employee_id, tenant_employee_version_id, active,
          assigned_by_label
        ) values (
          ${employeeId}, ${revision.id}, ${workspace.organization_id},
          ${workspace.id}, ${tenantEmployeeId}, ${tenantVersionId}, true,
          ${actorLabel}
        )
        on conflict (employee_id, workspace_id) do update set
          revision_id = excluded.revision_id,
          tenant_employee_id = excluded.tenant_employee_id,
          tenant_employee_version_id = excluded.tenant_employee_version_id,
          active = true, assigned_by_label = excluded.assigned_by_label,
          assigned_at = now(), updated_at = now()
      `;
    }
    await transaction`
      update allrice_platform_employee_revisions
      set status = 'published', published_by_label = ${actorLabel},
        published_at = now()
      where id = ${revision.id}
    `;
    await transaction`
      update allrice_platform_employees
      set status = 'published', current_published_revision_id = ${revision.id},
        updated_by_label = ${actorLabel}, updated_at = now()
      where id = ${employeeId}
    `;
    return {
      valid: true,
      employeeId,
      revisionId: revision.id,
      workspaceIds,
      runtimeProfile: PlatformEmployeeRuntimeProfileSchema.parse(
        revision.runtime_profile,
      ),
      errors: [],
      warnings: [],
    };
  });
}
