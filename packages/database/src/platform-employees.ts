import { createHash } from 'node:crypto';

import type postgres from 'postgres';

import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeAuditEventSchema,
  PlatformEmployeeRevisionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS,
  PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
  PlatformEmployeeSummarySchema,
  PlatformEmployeeTestRunOutputSchema,
  PlatformEmployeeTestRunSchema,
  ArchivePlatformEmployeeInputSchema,
  CreatePlatformEmployeeInputSchema,
  CreatePlatformEmployeeTestRunInputSchema,
  DshNativeSkillSnapshotSchema,
  DisablePlatformEmployeeInputSchema,
  PublishPlatformEmployeeInputSchema,
  RollbackPlatformEmployeeInputSchema,
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
  'wechat.article.search',
  'wechat.article.read',
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

interface AuditRow {
  id: string;
  employee_id: string;
  action: string;
  actor_label: string;
  details: Record<string, unknown>;
  created_at: Date;
}

function checksum(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function recordPlatformEmployeeAudit(input: {
  employeeId: string;
  action: string;
  actorLabel: string;
  details?: Record<string, unknown>;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_platform_employee_audit_events (
      employee_id, action, actor_label, details
    ) values (
      ${UuidSchema.parse(input.employeeId)}, ${input.action},
      ${input.actorLabel}, ${sql.json((input.details ?? {}) as never)}
    )
  `;
}

export async function listPlatformEmployeeAuditEvents(
  employeeIdInput: string,
  limitInput = 50,
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const limit = Math.min(Math.max(Math.trunc(limitInput), 1), 200);
  const sql = getDatabase();
  const rows = await sql<AuditRow[]>`
    select id, employee_id, action, actor_label, details, created_at
    from allrice_platform_employee_audit_events
    where employee_id = ${employeeId}
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map((row) =>
    PlatformEmployeeAuditEventSchema.parse({
      id: row.id,
      employeeId: row.employee_id,
      action: row.action,
      actorLabel: row.actor_label,
      details: row.details,
      createdAt: row.created_at.toISOString(),
    }),
  );
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

export async function createPlatformEmployeeDraft(
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const parsed = CreatePlatformEmployeeInputSchema.parse(input);
  const sql = getDatabase();
  const employeeId = await sql.begin(async (transaction) => {
    const sourceRows = parsed.sourceEmployeeId
      ? await transaction<{ definition: unknown }[]>`
          select revision.definition
          from allrice_platform_employees employee
          join allrice_platform_employee_revisions revision
            on revision.id = coalesce(
              employee.current_draft_revision_id,
              employee.current_published_revision_id
            )
          where employee.id = ${parsed.sourceEmployeeId}
            and employee.status <> 'archived'
        `
      : await transaction<{ definition: unknown }[]>`
          select revision.definition
          from allrice_platform_employees employee
          join allrice_platform_employee_revisions revision
            on revision.id = coalesce(
              employee.current_draft_revision_id,
              employee.current_published_revision_id
            )
          where employee.employee_key = 'rice'
            and employee.status <> 'archived'
        `;
    const source = sourceRows[0];
    if (!source) throw new Error('platform_employee_clone_source_not_found');
    const definition = PlatformEmployeeDefinitionSchema.parse({
      ...PlatformEmployeeDefinitionSchema.parse(source.definition),
      key: parsed.key,
      name: parsed.name,
      description: `${parsed.name} 的平台管理员草稿。`,
    });
    const employees = await transaction<{ id: string }[]>`
      insert into allrice_platform_employees (
        employee_key, name, description, status,
        created_by_label, updated_by_label
      ) values (
        ${definition.key}, ${definition.name}, ${definition.description},
        'draft', ${actorLabel}, ${actorLabel}
      ) returning id
    `;
    const createdEmployeeId = employees[0]?.id;
    if (!createdEmployeeId) throw new Error('platform_employee_create_failed');
    const revisions = await transaction<{ id: string }[]>`
      insert into allrice_platform_employee_revisions (
        employee_id, revision, status, definition, checksum,
        validation_report, created_by_label
      ) values (
        ${createdEmployeeId}, 1, 'draft', ${transaction.json(definition)},
        ${checksum(definition)},
        ${transaction.json({ valid: false, errors: [], warnings: [] })},
        ${actorLabel}
      ) returning id
    `;
    const revisionId = revisions[0]?.id;
    if (!revisionId) throw new Error('platform_employee_revision_failed');
    await transaction`
      update allrice_platform_employees
      set current_draft_revision_id = ${revisionId}
      where id = ${createdEmployeeId}
    `;
    return createdEmployeeId;
  });
  await recordPlatformEmployeeAudit({
    employeeId,
    action: 'employee.created',
    actorLabel,
    details: {
      sourceEmployeeId: parsed.sourceEmployeeId ?? 'rice',
      key: parsed.key,
      name: parsed.name,
    },
  });
  return getPlatformEmployee(employeeId);
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
      bridgeOnline: boolean;
      bridgeName: string | null;
      bridgeWorkspaceLabel: string | null;
      bridgeLastSeenAt: Date | null;
    }[]
  >`
    select workspace.id, workspace.organization_id as "organizationId",
      organization.name as "organizationName", workspace.slug, workspace.name,
      false as assigned,
      coalesce(bridge.last_seen_at >= now() - interval '45 seconds', false)
        as "bridgeOnline",
      bridge.name as "bridgeName",
      bridge.workspace_label as "bridgeWorkspaceLabel",
      bridge.last_seen_at as "bridgeLastSeenAt"
    from allrice_workspaces workspace
    join allrice_organizations organization on organization.id = workspace.organization_id
    left join lateral (
      select device.name, device.last_seen_at, folder.label as workspace_label
      from allrice_bridge_devices device
      left join lateral (
        select folder_grant.label
        from allrice_bridge_folder_grants folder_grant
        where folder_grant.device_id = device.id
          and folder_grant.revoked_at is null
        order by folder_grant.created_at desc, folder_grant.id desc
        limit 1
      ) folder on true
      where device.organization_id = workspace.organization_id
        and device.workspace_id = workspace.id
        and device.revoked_at is null
      order by device.last_seen_at desc nulls last, device.created_at desc
      limit 1
    ) bridge on true
    where workspace.archived_at is null and organization.archived_at is null
      and organization.slug <> 'allrice-platform'
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
  if (!parsed.workspaceId) {
    return {
      queued: false as const,
      valid: false,
      errors: ['请选择一个租户工作区作为预览环境。'],
      warnings: [] as string[],
      runtimeProfile: null,
      revisionId: null,
      testRun: null,
    };
  }
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
  await recordPlatformEmployeeAudit({
    employeeId,
    action: 'employee.test.queued',
    actorLabel,
    details: {
      testRunId: row.id,
      revisionId: compilation.revisionId,
      workspaceId: parsed.workspaceId,
    },
  });
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
            message: '配置试用 Worker 超时，任务已终止。',
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
    const parsedInput = CreatePlatformEmployeeTestRunInputSchema.parse(
      row.input,
    );
    if (!parsedInput.workspaceId) {
      throw new Error('platform_employee_preview_workspace_required');
    }
    const previewRows = await transaction<
      {
        workspace_id: string;
        workspace_name: string;
        organization_id: string;
        membership_id: string;
        owner_id: string;
        role: 'admin' | 'member' | 'viewer';
      }[]
    >`
      select workspace.id as workspace_id, workspace.name as workspace_name,
        workspace.organization_id, membership.id as membership_id,
        membership.user_id as owner_id, membership.role
      from allrice_workspaces workspace
      join allrice_organizations organization
        on organization.id = workspace.organization_id
      join allrice_memberships membership
        on membership.organization_id = workspace.organization_id
        and (membership.workspace_id is null or membership.workspace_id = workspace.id)
        and membership.active
      join allrice_users actor
        on actor.id = membership.user_id and actor.status = 'active'
      left join allrice_bridge_devices bridge
        on bridge.organization_id = workspace.organization_id
        and bridge.workspace_id = workspace.id
        and bridge.owner_id = membership.user_id
        and bridge.revoked_at is null
        and bridge.last_seen_at > now() - interval '45 seconds'
      where workspace.id = ${parsedInput.workspaceId}
        and workspace.archived_at is null
        and organization.archived_at is null
        and organization.slug <> 'allrice-platform'
      order by (bridge.id is not null) desc,
        case membership.role when 'admin' then 0 when 'member' then 1 else 2 end,
        membership.created_at, membership.id
      limit 1
    `;
    const previewContext = previewRows[0];
    if (!previewContext) {
      throw new Error('platform_employee_preview_workspace_unavailable');
    }
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
      input: parsedInput,
      runtimeProfile,
      definition,
      nativeSkills,
      previewContext: {
        workspaceId: previewContext.workspace_id,
        workspaceName: previewContext.workspace_name,
        organizationId: previewContext.organization_id,
        membershipId: previewContext.membership_id,
        ownerId: previewContext.owner_id,
        role: previewContext.role,
      },
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
  await recordPlatformEmployeeAudit({
    employeeId: row.employee_id,
    action:
      status === 'succeeded'
        ? 'employee.test.succeeded'
        : 'employee.test.failed',
    actorLabel: 'platform-test-worker',
    details: { testRunId, revisionId: row.revision_id },
  });
  return testRunSnapshot(row);
}

export async function disablePlatformEmployee(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const { reason } = DisablePlatformEmployeeInputSchema.parse(input);
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const employees = await transaction<{ id: string }[]>`
      select id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    if (!employees[0]) throw new Error('platform_employee_not_found');
    const assignments = await transaction<
      {
        organization_id: string;
        workspace_id: string;
        tenant_employee_id: string | null;
      }[]
    >`
      update allrice_platform_employee_tenant_assignments
      set active = false, updated_at = now()
      where employee_id = ${employeeId} and active
      returning organization_id, workspace_id, tenant_employee_id
    `;
    for (const assignment of assignments) {
      if (!assignment.tenant_employee_id) continue;
      await transaction`
        update allrice_employee_assignments
        set active = false, updated_at = now()
        where organization_id = ${assignment.organization_id}
          and workspace_id = ${assignment.workspace_id}
          and employee_id = ${assignment.tenant_employee_id}
      `;
      await transaction`
        update allrice_employees
        set status = 'disabled', updated_at = now()
        where organization_id = ${assignment.organization_id}
          and workspace_id = ${assignment.workspace_id}
          and id = ${assignment.tenant_employee_id}
      `;
    }
    await transaction`
      update allrice_platform_employees
      set status = 'disabled', updated_by_label = ${actorLabel},
        updated_at = now()
      where id = ${employeeId}
    `;
    return { disabledWorkspaceCount: assignments.length };
  });
  await recordPlatformEmployeeAudit({
    employeeId,
    action: 'employee.disabled',
    actorLabel,
    details: { reason, ...result },
  });
  return { employeeId, ...result };
}

export async function archivePlatformEmployee(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const { reason } = ArchivePlatformEmployeeInputSchema.parse(input);
  const employee = await getPlatformEmployee(employeeId);
  if (!employee) throw new Error('platform_employee_not_found');
  if (employee.employeeKey === 'rice')
    throw new Error('platform_employee_rice_cannot_be_archived');
  await disablePlatformEmployee(employeeId, { reason }, actorLabel);
  const sql = getDatabase();
  await sql`
    update allrice_platform_employees
    set status = 'archived', updated_by_label = ${actorLabel}, updated_at = now()
    where id = ${employeeId}
  `;
  await recordPlatformEmployeeAudit({
    employeeId,
    action: 'employee.archived',
    actorLabel,
    details: { reason },
  });
  return { employeeId, archived: true };
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
    if (definition.securityPolicy.approvalPolicy === 'autonomous') {
      errors.push('平台当前不允许 AI 员工使用 autonomous 审批策略');
    }
    if (definition.securityPolicy.connectorIdentityModes.includes('service')) {
      errors.push('平台当前未开放 Service Connector 身份给 AI 员工');
    }
    if (definition.capabilities.workflowRevisionIds.length > 0) {
      errors.push(
        '平台 Workflow 发布目录尚未启用，不能引用租户 Workflow revision',
      );
    }
    if (definition.capabilities.knowledgeRevisionIds.length > 0) {
      errors.push(
        '平台 Knowledge 发布目录尚未启用，不能引用租户 Knowledge revision',
      );
    }
    if (definition.capabilities.connectorRefs.length > 0) {
      errors.push('Connector 必须在租户发布时绑定，草稿不能引用租户 Connector');
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
            distributionGeneration: PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
            approvedPluginIds: [...PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS],
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

async function materializePlatformEmployeeRevision(
  transaction: postgres.TransactionSql,
  input: {
    employeeId: string;
    revision: RevisionRow;
    definition: PlatformEmployeeDefinition;
    workspaceIds: string[];
    actorLabel: string;
  },
) {
  const manifest = tenantManifest(input.definition);
  const manifestChecksum = employeeManifestChecksum(manifest);
  for (const workspaceId of input.workspaceIds) {
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
      input.definition.key === 'rice'
        ? 'default-assistant'
        : input.definition.key;
    const employees = await transaction<{ id: string }[]>`
      insert into allrice_employees (
        organization_id, workspace_id, employee_key, name, status
      ) values (
        ${workspace.organization_id}, ${workspace.id}, ${tenantKey},
        ${input.definition.name}, 'active'
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
        ${input.definition.key === 'rice'}, true, ${actorId}
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
    for (const platformSkillId of input.definition.capabilities
      .nativeSkillIds) {
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
        ${input.employeeId}, ${input.revision.id}, ${workspace.organization_id},
        ${workspace.id}, ${tenantEmployeeId}, ${tenantVersionId}, true,
        ${input.actorLabel}
      )
      on conflict (employee_id, workspace_id) do update set
        revision_id = excluded.revision_id,
        tenant_employee_id = excluded.tenant_employee_id,
        tenant_employee_version_id = excluded.tenant_employee_version_id,
        active = true, assigned_by_label = excluded.assigned_by_label,
        assigned_at = now(), updated_at = now()
    `;
  }
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
  const successfulTests = await sql<{ id: string }[]>`
    select id from allrice_platform_employee_test_runs
    where employee_id = ${employeeId}
      and revision_id = ${compilation.revisionId}
      and status = 'succeeded'
      and completed_at >= now() - interval '24 hours'
    order by completed_at desc limit 1
  `;
  if (!successfulTests[0]) {
    return {
      ...compilation,
      valid: false,
      errors: ['发布前必须在 24 小时内成功试用一次当前配置。'],
    };
  }
  const uniqueWorkspaceIds = [...new Set(workspaceIds)];
  const activeWorkspaces = await sql<{ id: string }[]>`
    select workspace.id
    from allrice_workspaces workspace
    join allrice_organizations organization
      on organization.id = workspace.organization_id
    where workspace.id in ${sql(uniqueWorkspaceIds)}
      and workspace.archived_at is null
      and organization.archived_at is null
      and organization.slug <> 'allrice-platform'
  `;
  if (activeWorkspaces.length !== uniqueWorkspaceIds.length) {
    return {
      ...compilation,
      valid: false,
      errors: ['发布目标包含不存在、已归档或越权的工作区。'],
    };
  }
  if (compilation.runtimeProfile?.provider === 'openai-codex') {
    const statuses = await sql<{ status: string; checked_at: Date | null }[]>`
      select status, checked_at from allrice_provider_status
      where provider = 'codex'
    `;
    const provider = statuses[0];
    if (
      provider?.status !== 'connected' ||
      !provider.checked_at ||
      provider.checked_at.getTime() < Date.now() - 120_000
    ) {
      return {
        ...compilation,
        valid: false,
        errors: ['Codex 订阅 Provider 当前不可用或健康状态已过期。'],
      };
    }
  } else {
    return {
      ...compilation,
      valid: false,
      errors: [
        `Provider ${compilation.runtimeProfile?.provider ?? 'unknown'} 尚未通过平台生产健康门禁。`,
      ],
    };
  }
  const published = await sql.begin(async (transaction) => {
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
    await materializePlatformEmployeeRevision(transaction, {
      employeeId,
      revision,
      definition,
      workspaceIds: uniqueWorkspaceIds,
      actorLabel,
    });
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
      workspaceIds: uniqueWorkspaceIds,
      runtimeProfile: PlatformEmployeeRuntimeProfileSchema.parse(
        revision.runtime_profile,
      ),
      errors: [],
      warnings: [],
    };
  });
  await recordPlatformEmployeeAudit({
    employeeId,
    action: 'employee.published',
    actorLabel,
    details: {
      revisionId: published.revisionId,
      workspaceIds: published.workspaceIds,
      testRunId: successfulTests[0].id,
    },
  });
  return published;
}

export async function rollbackPlatformEmployee(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const { revisionId, reason } =
    RollbackPlatformEmployeeInputSchema.parse(input);
  const sql = getDatabase();
  const rolledBack = await sql.begin(async (transaction) => {
    const employees = await transaction<
      { current_published_revision_id: string | null }[]
    >`
      select current_published_revision_id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    const employee = employees[0];
    if (!employee) throw new Error('platform_employee_not_found');
    const revisions = revisionId
      ? await transaction<RevisionRow[]>`
          select * from allrice_platform_employee_revisions
          where employee_id = ${employeeId} and id = ${revisionId}
            and status = 'published'
        `
      : await transaction<RevisionRow[]>`
          select * from allrice_platform_employee_revisions
          where employee_id = ${employeeId} and status = 'published'
            and id <> ${employee.current_published_revision_id}
          order by revision desc limit 1
        `;
    const target = revisions[0];
    if (!target?.runtime_profile)
      throw new Error('platform_employee_rollback_revision_not_found');
    const definition = PlatformEmployeeDefinitionSchema.parse(
      target.definition,
    );
    const targets = await transaction<{ workspace_id: string }[]>`
      select workspace_id
      from allrice_platform_employee_tenant_assignments
      where employee_id = ${employeeId}
      order by active desc, updated_at desc, workspace_id
    `;
    const workspaceIds = [...new Set(targets.map((row) => row.workspace_id))];
    if (workspaceIds.length === 0)
      throw new Error('platform_employee_rollback_has_no_tenant_targets');
    await materializePlatformEmployeeRevision(transaction, {
      employeeId,
      revision: target,
      definition,
      workspaceIds,
      actorLabel,
    });
    await transaction`
      update allrice_platform_employees
      set status = 'published', current_draft_revision_id = ${target.id},
        current_published_revision_id = ${target.id},
        updated_by_label = ${actorLabel}, updated_at = now()
      where id = ${employeeId}
    `;
    return {
      employeeId,
      revisionId: target.id,
      revision: target.revision,
      previousRevisionId: employee.current_published_revision_id,
      workspaceIds,
    };
  });
  await recordPlatformEmployeeAudit({
    employeeId,
    action: 'employee.rolled_back',
    actorLabel,
    details: { reason, ...rolledBack },
  });
  return rolledBack;
}
