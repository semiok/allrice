import { createHash, randomUUID } from 'node:crypto';

import type postgres from 'postgres';

import {
  PlatformEmployeeDefinitionSchema,
  assembleEmployeeCapabilities,
  upgradeEmployeeSkillBindings,
  rapidEmployeeIterationEnabled,
  employeePublicationPolicy,
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
  DisablePlatformEmployeeInputSchema,
  PublishPlatformEmployeeInputSchema,
  RollbackPlatformEmployeeInputSchema,
  UpdatePlatformEmployeeInputSchema,
  UuidSchema,
  employeeModelPolicyProblem,
  employeeToolConfigurationErrors,
  type PlatformEmployeeDefinition,
  type PlatformEmployeeTestRunOutput,
  type RequestContext,
} from '@allrice/contracts';

import { employeeManifest } from './employee-config.ts';
import { frozenPackageSkills, validateSkillBundle } from '../skill-bundles.ts';
import { getDatabase } from '../core/client.ts';
import { platformSkillReplacements } from '../platform-content/replacements.ts';
import { listEmployeeToolAvailability } from '../employee-administration.ts';
import { enablePublishedDevelopmentCloud } from './development-cloud-grants.ts';
import { requireTenantAdministrationAuthority } from '../tenant-administration.ts';
import {
  buildEmployeeRuntimePackage,
  platformEmployeeTestCanFinalize,
  platformEmployeeTestExecutionTerminalState,
  platformEmployeeTestTimeoutAt,
  runtimePackageChecksum as checksum,
  runtimePackageSystemPrompt,
  validatePlatformEmployeeTestExecutionSnapshot,
} from '../platform-employees/runtime-package.ts';

export {
  buildEmployeeRuntimePackage,
  platformEmployeeTestCanFinalize,
  platformEmployeeTestExecutionTerminalState,
  platformEmployeeTestTimeoutAt,
  platformEmployeeTestTimeoutGraceMs,
  runtimePackageSystemPrompt,
  validatePlatformEmployeeTestExecutionSnapshot,
} from '../platform-employees/runtime-package.ts';

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
  requested_by_label: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  input: unknown;
  output: unknown | null;
  frozen_runtime_profile: unknown | null;
  frozen_definition: unknown | null;
  frozen_native_skills: unknown | null;
  frozen_package_checksum: string | null;
  created_at: Date;
  started_at: Date | null;
  timeout_at: Date | null;
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

async function recordPlatformEmployeeAuditInTransaction(
  transaction: postgres.Sql | postgres.TransactionSql,
  input: {
    employeeId: string;
    action: string;
    actorLabel: string;
    details?: Record<string, unknown>;
  },
) {
  await transaction`
    insert into allrice_platform_employee_audit_events (
      employee_id, action, actor_label, details
    ) values (
      ${UuidSchema.parse(input.employeeId)}, ${input.action},
      ${input.actorLabel}, ${transaction.json((input.details ?? {}) as never)}
    )
  `;
}

async function recordPlatformEmployeeAudit(input: {
  employeeId: string;
  action: string;
  actorLabel: string;
  details?: Record<string, unknown>;
}) {
  const sql = getDatabase();
  await recordPlatformEmployeeAuditInTransaction(sql, input);
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
      organizationSlug: string;
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
      organization.name as "organizationName", organization.slug as "organizationSlug", workspace.slug, workspace.name,
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

export async function listPlatformNativeSkills(
  sql: postgres.Sql | postgres.TransactionSql = getDatabase(),
) {
  const replacements = await platformSkillReplacements(sql);
  const replaced = new Set([...replacements.values()].flat());
  const skills = await sql<
    {
      id: string;
      name: string;
      description: string;
      checksum: string;
      requiredToolRefs: string[];
      enabled: boolean;
      source: 'allrice' | 'dsh-migrated';
      sourceRef: string;
      version: string;
      license: string;
      reviewStatus: 'draft' | 'reviewed' | 'rejected';
      reviewedByLabel: string | null;
      reviewedAt: Date | null;
      bundleChecksum: string | null;
      resourceCount: number;
      bundleDependencies: unknown[];
    }[]
  >`
    select id, name, description, checksum,
      required_tool_refs as "requiredToolRefs", enabled, source,
      source_ref as "sourceRef", version, license,
      review_status as "reviewStatus",
      reviewed_by_label as "reviewedByLabel", reviewed_at as "reviewedAt",
      bundle ->> 'checksum' as "bundleChecksum",
      coalesce(jsonb_array_length(bundle -> 'resources'), 0) as "resourceCount",
      coalesce(bundle -> 'dependencies', '[]'::jsonb) as "bundleDependencies"
    from allrice_platform_dsh_skills
    order by enabled desc, name, id
  `;
  return skills
    .filter((skill) => !replaced.has(skill.id))
    .map((skill) => ({
      ...skill,
      replaces: replacements.get(skill.id) ?? [],
    }));
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
    select id, employee_id, revision_id, requested_by_label, status, input,
      output, frozen_runtime_profile, frozen_definition,
      frozen_native_skills, frozen_package_checksum, created_at, started_at,
      timeout_at, completed_at
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
  const rows = await sql.begin(async (transaction) => {
    const revisions = await transaction<RevisionRow[]>`
      select id, employee_id, revision, status, definition, runtime_profile,
        checksum, created_at, published_at
      from allrice_platform_employee_revisions
      where id = ${compilation.revisionId} and employee_id = ${employeeId}
        and status = 'testing' and runtime_profile is not null
      for update
    `;
    const revision = revisions[0];
    if (!revision)
      throw new Error('platform_employee_test_revision_unavailable');
    const runtimeProfile = PlatformEmployeeRuntimeProfileSchema.parse(
      revision.runtime_profile,
    );
    const runtimePackage = runtimeProfile.runtimePackage;
    if (!runtimePackage) {
      throw new Error('platform_employee_test_runtime_package_missing');
    }
    const frozen = validatePlatformEmployeeTestExecutionSnapshot({
      runtimeProfile,
      definition: revision.definition,
      nativeSkills: runtimePackage.skills,
      packageChecksum: runtimePackage.checksum,
    });
    return transaction<TestRunRow[]>`
      insert into allrice_platform_employee_test_runs (
        employee_id, revision_id, requested_by_label, status, input,
        frozen_runtime_profile, frozen_definition, frozen_native_skills,
        frozen_package_checksum
      ) values (
        ${employeeId}, ${compilation.revisionId}, ${actorLabel}, 'queued',
        ${transaction.json(parsed)},
        ${transaction.json(frozen.runtimeProfile)},
        ${transaction.json(frozen.definition)},
        ${transaction.json(frozen.nativeSkills)},
        ${runtimePackage.checksum}
      )
      returning id, employee_id, revision_id, requested_by_label, status,
        input, output, frozen_runtime_profile, frozen_definition,
        frozen_native_skills, frozen_package_checksum, created_at, started_at,
        timeout_at, completed_at
    `;
  });
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

async function finalizePlatformEmployeeTestRunInTransaction(
  transaction: postgres.TransactionSql,
  input: {
    testRunId: string;
    output: PlatformEmployeeTestRunOutput;
    finalizedByLabel: string;
  },
) {
  const tests = await transaction<TestRunRow[]>`
    select id, employee_id, revision_id, requested_by_label, status, input,
      output, frozen_runtime_profile, frozen_definition,
      frozen_native_skills, frozen_package_checksum, created_at, started_at,
      timeout_at, completed_at
    from allrice_platform_employee_test_runs
    where id = ${input.testRunId}
    for update
  `;
  const existing = tests[0];
  if (!existing) throw new Error('platform_employee_test_not_found');
  if (!platformEmployeeTestCanFinalize(existing.status)) {
    return { row: existing, changed: false };
  }
  const executions = await transaction<
    {
      run_id: string;
      run_state: string;
      job_id: string;
      job_status: string;
      cancel_requested_at: Date | null;
    }[]
  >`
    select run.id as run_id, run.state as run_state, job.id as job_id,
      job.status as job_status, job.cancel_requested_at
    from allrice_runs run
    join allrice_jobs job on job.run_id = run.id
    where run.execution_spec ->> 'platformEmployeeTestRunId' = ${input.testRunId}
    for update of run, job
  `;
  const execution = executions[0];
  const terminal = platformEmployeeTestExecutionTerminalState({
    hasError: input.output.error !== null,
    cancelRequested:
      execution !== undefined &&
      (execution.cancel_requested_at !== null ||
        execution.job_status === 'canceled'),
    runState: execution?.run_state ?? null,
  });
  const normalizedOutput =
    terminal.runStatus === 'canceled'
      ? PlatformEmployeeTestRunOutputSchema.parse({
          ...input.output,
          answer: null,
          error: {
            code: terminal.errorCode,
            message: terminal.errorMessage,
          },
        })
      : input.output;
  const persistedOutput: unknown = JSON.parse(JSON.stringify(normalizedOutput));
  const rows = await transaction<TestRunRow[]>`
    update allrice_platform_employee_test_runs
    set status = ${terminal.testStatus},
      output = ${transaction.json(persistedOutput as never)},
      completed_at = now()
    where id = ${input.testRunId} and status = 'running'
    returning id, employee_id, revision_id, requested_by_label, status, input,
      output, frozen_runtime_profile, frozen_definition,
      frozen_native_skills, frozen_package_checksum, created_at, started_at,
      timeout_at, completed_at
  `;
  const row = rows[0];
  if (!row) {
    const replay = await transaction<TestRunRow[]>`
      select id, employee_id, revision_id, requested_by_label, status, input,
        output, frozen_runtime_profile, frozen_definition,
        frozen_native_skills, frozen_package_checksum, created_at, started_at,
        timeout_at, completed_at
      from allrice_platform_employee_test_runs
      where id = ${input.testRunId}
    `;
    if (!replay[0]) throw new Error('platform_employee_test_not_found');
    return { row: replay[0], changed: false };
  }
  const errorCode = normalizedOutput.error?.code ?? terminal.errorCode;
  const errorMessage = normalizedOutput.error?.message ?? terminal.errorMessage;
  if (execution) {
    if (terminal.runStatus !== 'succeeded') {
      await transaction`
        update allrice_managed_browser_tasks task
        set status = ${terminal.runStatus === 'canceled' ? 'canceled' : 'failed'},
          started_at = coalesce(task.started_at, now()),
          error_code = ${errorCode}, completed_at = now()
        where task.run_id = ${execution.run_id}
          and task.status in ('queued', 'running')
      `;
    }
    await transaction`
      update allrice_jobs
      set status = ${terminal.jobStatus}, worker_id = null,
        lease_token = null, claimed_at = null, heartbeat_at = null,
        lease_expires_at = null, last_error_code = ${errorCode},
        last_error_message = ${errorMessage}, completed_at = now(),
        updated_at = now()
      where id = ${execution.job_id}
    `;
    await transaction`
      update allrice_runs
      set state = ${terminal.runStatus},
        result = ${transaction.json({
          answer: normalizedOutput.answer,
          provider: normalizedOutput.provider,
          model: normalizedOutput.model,
          usage: normalizedOutput.usage,
          platformEmployeeTestRunId: input.testRunId,
        })},
        error_code = ${errorCode}, error_message = ${errorMessage},
        completed_at = now(), updated_at = now()
      where id = ${execution.run_id}
    `;
    await transaction`
      insert into allrice_run_events (
        organization_id, workspace_id, run_id, sequence, event_type, payload
      )
      select run.organization_id, run.workspace_id, run.id,
        coalesce((
          select max(event.sequence) + 1
          from allrice_run_events event
          where event.run_id = run.id
        ), 0),
        ${terminal.eventType},
        ${transaction.json({
          jobId: execution.job_id,
          code: errorCode,
          message: errorMessage,
          platformEmployeeTestRunId: input.testRunId,
        })}
      from allrice_runs run
      where run.id = ${execution.run_id}
        and not exists (
          select 1 from allrice_run_events event
          where event.run_id = run.id
            and event.event_type in (
              'run.succeeded', 'run.failed', 'run.canceled'
            )
        )
    `;
  }
  await recordPlatformEmployeeAuditInTransaction(transaction, {
    employeeId: row.employee_id,
    action:
      terminal.runStatus === 'succeeded'
        ? 'employee.test.succeeded'
        : terminal.runStatus === 'canceled'
          ? 'employee.test.canceled'
          : 'employee.test.failed',
    actorLabel: input.finalizedByLabel,
    details: {
      testRunId: row.id,
      revisionId: row.revision_id,
      requestedByLabel: row.requested_by_label,
      runId: execution?.run_id ?? null,
      jobId: execution?.job_id ?? null,
      errorCode,
    },
  });
  return { row, changed: true };
}

export async function claimNextPlatformEmployeeTestRun(workerIdInput: string) {
  const workerId = UuidSchema.parse(workerIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const staleTests = await transaction<{ id: string }[]>`
      select id from allrice_platform_employee_test_runs
      where status = 'running'
        and timeout_at is not null and timeout_at <= now()
      order by timeout_at, id
      for update skip locked
      limit 100
    `;
    for (const staleTest of staleTests) {
      await finalizePlatformEmployeeTestRunInTransaction(transaction, {
        testRunId: staleTest.id,
        finalizedByLabel: 'platform-test-timeout-sweeper',
        output: PlatformEmployeeTestRunOutputSchema.parse({
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
        }),
      });
    }
    const rows = await transaction<TestRunRow[]>`
      select id, employee_id, revision_id, requested_by_label, status, input,
        output, frozen_runtime_profile, frozen_definition,
        frozen_native_skills, frozen_package_checksum, created_at, started_at,
        timeout_at, completed_at
      from allrice_platform_employee_test_runs
      where status = 'queued'
        and frozen_runtime_profile is not null
        and frozen_definition is not null
        and frozen_native_skills is not null
        and frozen_package_checksum is not null
      order by created_at, id
      for update skip locked
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    let frozen: ReturnType<
      typeof validatePlatformEmployeeTestExecutionSnapshot
    >;
    try {
      frozen = validatePlatformEmployeeTestExecutionSnapshot({
        runtimeProfile: row.frozen_runtime_profile,
        definition: row.frozen_definition,
        nativeSkills: row.frozen_native_skills,
        packageChecksum: row.frozen_package_checksum,
      });
    } catch (error) {
      const startedAt = new Date();
      await transaction`
        update allrice_platform_employee_test_runs
        set status = 'running', worker_id = ${workerId},
          started_at = ${startedAt}, timeout_at = ${startedAt}
        where id = ${row.id} and status = 'queued'
      `;
      await finalizePlatformEmployeeTestRunInTransaction(transaction, {
        testRunId: row.id,
        finalizedByLabel: 'platform-test-snapshot-validator',
        output: PlatformEmployeeTestRunOutputSchema.parse({
          answer: null,
          provider: null,
          model: null,
          threadId: null,
          usage: null,
          events: [],
          error: {
            code: 'TEST_SNAPSHOT_INVALID',
            message:
              error instanceof Error
                ? `配置试用冻结快照校验失败：${error.message}`.slice(0, 2_000)
                : '配置试用冻结快照校验失败。',
          },
        }),
      });
      return null;
    }
    const { runtimeProfile, definition, nativeSkills } = frozen;
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
    const issuedAt = new Date();
    const expiresAt = platformEmployeeTestTimeoutAt(
      issuedAt,
      runtimeProfile.timeoutMs,
    );
    const claimed = await transaction`
      update allrice_platform_employee_test_runs
      set status = 'running', worker_id = ${workerId},
        started_at = ${issuedAt}, timeout_at = ${expiresAt}
      where id = ${row.id} and status = 'queued'
    `;
    if (claimed.count !== 1) return null;
    const memberships = [
      {
        id: previewContext.membership_id,
        userId: previewContext.owner_id,
        organizationId: previewContext.organization_id,
        workspaceId: previewContext.workspace_id,
        role: previewContext.role,
        active: true,
      },
    ];
    const grants = [
      {
        resourceType: 'job',
        action: 'job:execute',
        workspaceId: previewContext.workspace_id,
      },
      ...['storage_object', 'memory', 'chat_session'].map((resourceType) => ({
        resourceType,
        action: 'resource:read',
        workspaceId: previewContext.workspace_id,
      })),
    ];
    await transaction`
      select id from allrice_users
      where id = ${previewContext.owner_id}
      for update
    `;
    const policyVersions = await transaction<{ version: number }[]>`
      select coalesce(max(version), 0)::integer + 1 as version
      from allrice_policy_snapshots
      where organization_id = ${previewContext.organization_id}
        and subject_id = ${previewContext.owner_id}
    `;
    const policyVersion = policyVersions[0]?.version ?? 1;
    const policies = await transaction<{ id: string }[]>`
      insert into allrice_policy_snapshots (
        organization_id, subject_id, version, payload, issued_at, expires_at
      ) values (
        ${previewContext.organization_id}, ${previewContext.owner_id},
        ${policyVersion}, ${transaction.json({ memberships, grants })},
        ${issuedAt}, ${expiresAt}
      )
      returning id
    `;
    const policy = policies[0];
    if (!policy) throw new Error('platform_employee_preview_policy_failed');
    const runId = randomUUID();
    const jobId = randomUUID();
    const leaseToken = randomUUID();
    await transaction`
      insert into allrice_runs (
        id, organization_id, workspace_id, owner_id, state, visibility,
        policy_snapshot_id, execution_spec, input, started_at
      ) values (
        ${runId}, ${previewContext.organization_id},
        ${previewContext.workspace_id}, ${previewContext.owner_id},
        'running', 'private', ${policy.id},
        ${transaction.json({
          schemaVersion: 1,
          handler: 'platform_employee_preview',
          platformEmployeeTestRunId: row.id,
          employeeRevisionId: row.revision_id,
        })},
        ${transaction.json({ prompt: parsedInput.prompt })}, ${issuedAt}
      )
    `;
    await transaction`
      insert into allrice_jobs (
        id, organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, attempt, max_attempts, available_at, timeout_at,
        payload, worker_id, lease_token, claimed_at, heartbeat_at,
        lease_expires_at
      ) values (
        ${jobId}, ${previewContext.organization_id},
        ${previewContext.workspace_id}, ${previewContext.owner_id}, ${runId},
        'running', ${`platform-employee-preview:${row.id}`}, 1, 1,
        ${issuedAt}, ${expiresAt},
        ${transaction.json({
          schemaVersion: 1,
          type: 'platform_employee_preview',
          input: { testRunId: row.id },
        })},
        ${workerId}, ${leaseToken}, ${issuedAt}, ${issuedAt}, ${expiresAt}
      )
    `;
    await transaction`
      insert into allrice_run_events (
        organization_id, workspace_id, run_id, sequence, event_type, payload,
        occurred_at
      ) values
        (
          ${previewContext.organization_id}, ${previewContext.workspace_id},
          ${runId}, 0, 'run.created',
          ${transaction.json({
            jobId,
            status: 'running',
            source: 'platform_employee_preview',
            platformEmployeeTestRunId: row.id,
          })}, ${issuedAt}
        ),
        (
          ${previewContext.organization_id}, ${previewContext.workspace_id},
          ${runId}, 1, 'run.started',
          ${transaction.json({ jobId, workerId, attempt: 1 })}, ${issuedAt}
        )
    `;
    return {
      id: row.id,
      employeeId: row.employee_id,
      revisionId: row.revision_id,
      requestedByLabel: row.requested_by_label,
      input: parsedInput,
      runtimeProfile,
      definition,
      nativeSkills,
      previewExecution: {
        runId,
        jobId,
        jobAttempt: 1,
        leaseToken,
        policySnapshot: {
          id: policy.id,
          organizationId: previewContext.organization_id,
          subjectId: previewContext.owner_id,
          version: policyVersion,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          memberships,
          grants,
        },
        startedAt: issuedAt.toISOString(),
      },
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
  const sql = getDatabase();
  const result = await sql.begin((transaction) =>
    finalizePlatformEmployeeTestRunInTransaction(transaction, {
      testRunId,
      output,
      finalizedByLabel: 'platform-test-worker',
    }),
  );
  return testRunSnapshot(result.row);
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
      set active = false, is_default = false, updated_at = now()
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
        set status = 'archived', updated_at = now()
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
  const { definition: rawDefinition, expectedRevisionId } =
    UpdatePlatformEmployeeInputSchema.parse(input);
  const sql = getDatabase();
  const skills = rawDefinition.capabilities.nativeSkillIds.length
    ? await listPlatformNativeSkills(sql)
    : [];
  const definition = PlatformEmployeeDefinitionSchema.parse({
    ...assembleEmployeeCapabilities(rawDefinition, skills),
    // An explicit security edit must not be silently undone by a server save.
    // Interactive tool/Skill selection updates these fields together in the UI.
    securityPolicy: rawDefinition.securityPolicy,
  });
  await sql.begin(async (transaction) => {
    const employees = await transaction<
      { id: string; current_draft_revision_id: string | null }[]
    >`
      select id,current_draft_revision_id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    if (!employees[0]) throw new Error('platform_employee_not_found');
    if (
      expectedRevisionId !== undefined &&
      employees[0].current_draft_revision_id !== expectedRevisionId
    )
      throw new Error('platform_employee_publish_snapshot_changed');
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
  expectedRevisionId?: string,
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    // Match save/rollback/publish lock order and never recompile an immutable
    // published revision (rollback may legitimately point the draft at one).
    const [employee] = await transaction<
      { current_draft_revision_id: string | null }[]
    >`
      select current_draft_revision_id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    if (!employee?.current_draft_revision_id)
      throw new Error('platform_employee_draft_not_found');
    if (
      expectedRevisionId !== undefined &&
      employee.current_draft_revision_id !== expectedRevisionId
    )
      throw new Error('platform_employee_publish_snapshot_changed');
    const revisions = await transaction<RevisionRow[]>`
      select * from allrice_platform_employee_revisions
      where id = ${employee.current_draft_revision_id}
        and employee_id = ${employeeId}
      for update
    `;
    const revision = revisions[0];
    if (!revision) throw new Error('platform_employee_draft_not_found');
    if (revision.status === 'published' || revision.published_at !== null)
      throw new Error('platform_employee_published_revision_immutable');
    if (!['draft', 'testing'].includes(revision.status))
      throw new Error('platform_employee_draft_unavailable');
    const rawDefinition = PlatformEmployeeDefinitionSchema.parse(
      revision.definition,
    );
    const upgraded = upgradeEmployeeSkillBindings(
      rawDefinition,
      await listPlatformNativeSkills(transaction),
    );
    const definition = PlatformEmployeeDefinitionSchema.parse({
      ...upgraded,
      securityPolicy: rawDefinition.securityPolicy,
    });
    const errors: string[] = [];
    const warnings: string[] = [];
    const modelProblem = employeeModelPolicyProblem(definition.modelPolicy);
    if (modelProblem) errors.push(modelProblem);
    errors.push(...employeeToolConfigurationErrors(definition));
    const skills =
      definition.capabilities.nativeSkillIds.length === 0
        ? []
        : await transaction<
            {
              id: string;
              name: string;
              description: string;
              content: string;
              checksum: string;
              enabled: boolean;
              model_invocable: boolean;
              user_invocable: boolean;
              required_tool_refs: string[];
              source: 'allrice' | 'dsh-migrated';
              source_ref: string;
              version: string;
              license: string;
              review_status: 'draft' | 'reviewed' | 'rejected';
              reviewed_by_label: string | null;
              reviewed_at: Date | null;
              bundle: unknown;
            }[]
          >`
            select id, name, description, content, checksum, enabled,
              model_invocable, user_invocable, required_tool_refs, source,
              source_ref, version, license, review_status,
              reviewed_by_label, reviewed_at, bundle
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
    const unreviewedSkills = skills.filter(
      (skill) =>
        skill.review_status !== 'reviewed' ||
        !skill.reviewed_by_label ||
        !skill.reviewed_at,
    );
    if (unreviewedSkills.length > 0) {
      errors.push(
        `Skill 尚未完成平台审核：${unreviewedSkills.map((skill) => skill.name).join(', ')}`,
      );
    }
    const invalidSkillChecksums = skills.filter(
      (skill) =>
        `sha256:${createHash('sha256').update(skill.content).digest('hex')}` !==
        skill.checksum,
    );
    if (invalidSkillChecksums.length > 0) {
      errors.push(
        `Skill 内容校验失败：${invalidSkillChecksums.map((skill) => skill.name).join(', ')}`,
      );
    }
    const grantedTools = new Set(definition.capabilities.toolNames);
    for (const skill of skills)
      if (skill.bundle) {
        try {
          validateSkillBundle(skill.bundle, skill.content);
        } catch {
          errors.push(`Skill 资源包校验失败：${skill.name}`);
        }
      }
    const missingRequiredTools = skills.flatMap((skill) =>
      skill.required_tool_refs.filter((name) => !grantedTools.has(name)),
    );
    if (missingRequiredTools.length > 0) {
      errors.push(
        `Skill 缺少所需工具：${[...new Set(missingRequiredTools)].join(', ')}`,
      );
    }
    if (
      definition.securityPolicy.connectorIdentityModes.includes('service') &&
      ((!definition.capabilities.toolNames.includes('cloud.mcp.call') &&
        !['local.mcp.discover', 'local.mcp.call'].every((name) =>
          definition.capabilities.toolNames.includes(name),
        )) ||
        definition.securityPolicy.deniedCapabilities.includes('secret:use') ||
        (definition.capabilities.toolNames.includes('cloud.mcp.call') &&
          definition.securityPolicy.deniedCapabilities.includes(
            'network:outbound',
          )))
    ) {
      errors.push(
        'Service Connector 需要声明云端或本地 MCP 工具并许可相应能力；本地无需网络，租户连接仍须逐项绑定',
      );
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
    const runtimePackage =
      errors.length === 0
        ? buildEmployeeRuntimePackage({
            revision: revision.revision,
            definition,
            skills,
          })
        : null;
    const profile = runtimePackage
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
          systemPrompt: runtimePackageSystemPrompt({
            platformPolicy: definition.systemPrompt,
            runtimePackage,
          }),
          nativeSkillIds: skills.map((skill) => skill.id),
          nativeSkillChecksums: skills.map((skill) => skill.checksum),
          toolNames: definition.capabilities.toolNames,
          connectorRefs: definition.capabilities.connectorRefs,
          securityPolicy: definition.securityPolicy,
          runtimePackage,
        })
      : null;
    const report = { valid: errors.length === 0, errors, warnings };
    await transaction`
      update allrice_platform_employee_revisions
      set status = ${errors.length === 0 ? 'testing' : 'draft'},
        definition = ${transaction.json(definition)}, checksum = ${checksum(definition)},
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

function tenantManifest(
  definition: PlatformEmployeeDefinition,
  runtimePackage: ReturnType<typeof buildEmployeeRuntimePackage>,
) {
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
    connectorRefs: definition.capabilities.connectorRefs,
    systemPromptOverride: runtimePackageSystemPrompt({
      platformPolicy: definition.systemPrompt,
      runtimePackage,
    }),
    runtimePackage,
  });
}

export async function materializePlatformEmployeeRevision(
  transaction: postgres.TransactionSql,
  input: {
    employeeId: string;
    revision: RevisionRow;
    definition: PlatformEmployeeDefinition;
    workspaceIds: string[];
    actorLabel: string;
  },
) {
  const runtimeProfile = PlatformEmployeeRuntimeProfileSchema.parse(
    input.revision.runtime_profile,
  );
  if (!runtimeProfile.runtimePackage) {
    throw new Error('platform_employee_runtime_package_missing');
  }
  const manifest = tenantManifest(
    input.definition,
    runtimeProfile.runtimePackage,
  );
  const manifestChecksum = runtimeProfile.runtimePackage.checksum;
  const frozenSkills = frozenPackageSkills(runtimeProfile.runtimePackage);
  if (
    frozenSkills.length !==
      input.definition.capabilities.nativeSkillIds.length ||
    frozenSkills.some(
      (skill) =>
        !input.definition.capabilities.nativeSkillIds.includes(skill.id),
    )
  )
    throw Error('platform_employee_frozen_skill_mismatch');
  for (const workspaceId of [...input.workspaceIds].sort()) {
    const workspaces = await transaction<
      { id: string; organization_id: string }[]
    >`
      select id, organization_id from allrice_workspaces
      where id = ${workspaceId} and archived_at is null
    `;
    const workspace = workspaces[0];
    if (!workspace) throw new Error(`workspace_not_found:${workspaceId}`);
    await transaction`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${workspace.organization_id}:${workspace.id}`},0))`;
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
    if (
      rapidEmployeeIterationEnabled() &&
      input.definition.capabilities.toolNames.length
    ) {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`runtime-policy:${workspace.organization_id}:${workspace.id}`},0))`;
      const [previous] = await transaction<
        { version: number; controls: unknown }[]
      >`
        select version, controls from allrice_runtime_policy_controls
        where organization_id=${workspace.organization_id} and workspace_id=${workspace.id} for update`;
      const controls = employeePublicationPolicy(
        previous?.controls,
        input.definition.capabilities.toolNames,
        (previous?.version ?? 0) + 1,
      );
      const unchanged =
        previous &&
        checksum({ ...controls, version: previous.version }) ===
          checksum(previous.controls);
      if (!unchanged) {
        await transaction`
          insert into allrice_runtime_policy_controls (organization_id, workspace_id, version, controls)
          values (${workspace.organization_id},${workspace.id},${controls.version},${transaction.json(controls)})
          on conflict (organization_id,workspace_id) do update set version=excluded.version,controls=excluded.controls,updated_at=clock_timestamp()`;
        await recordPlatformEmployeeAuditInTransaction(transaction, {
          employeeId: input.employeeId,
          action: 'employee.capabilities.enabled',
          actorLabel: input.actorLabel,
          details: {
            workspaceId: workspace.id,
            revisionId: input.revision.id,
            previousControls: previous?.controls ?? null,
            controls,
          },
        });
      }
    }
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
        not exists (select 1 from allrice_employee_assignments existing_default
          where existing_default.organization_id=${workspace.organization_id} and existing_default.workspace_id=${workspace.id}
            and existing_default.user_id=member.user_id and existing_default.active and existing_default.is_default), true, ${actorId}
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
    if (
      rapidEmployeeIterationEnabled() &&
      input.definition.capabilities.toolNames.includes('cloud.process.execute')
    ) {
      const grants = await enablePublishedDevelopmentCloud(transaction, {
        organizationId: workspace.organization_id,
        workspaceId: workspace.id,
        employeeId: tenantEmployeeId,
      });
      if (grants.length)
        await recordPlatformEmployeeAuditInTransaction(transaction, {
          employeeId: input.employeeId,
          action: 'employee.cloud.enabled',
          actorLabel: input.actorLabel,
          details: {
            workspaceId: workspace.id,
            revisionId: input.revision.id,
            grants,
          },
        });
    }
    // Publishing a new tenant revision must be transparent to existing chats.
    // Runs that are already queued keep their immutable execution snapshot; the
    // next Run created for each Session uses the newly materialized version.
    await transaction`
      update allrice_chat_sessions session
      set employee_version_id = assignment.employee_version_id,
        updated_at = now()
      from allrice_employee_assignments assignment
      where assignment.id = session.employee_assignment_id
        and assignment.organization_id = ${workspace.organization_id}
        and assignment.workspace_id = ${workspace.id}
        and assignment.employee_id = ${tenantEmployeeId}
        and assignment.active
        and session.organization_id = assignment.organization_id
        and session.workspace_id = assignment.workspace_id
        and session.employee_version_id <> assignment.employee_version_id
    `;
    await transaction`
      delete from allrice_employee_dsh_skill_bindings
      where organization_id = ${workspace.organization_id}
        and workspace_id = ${workspace.id}
        and employee_id = ${tenantEmployeeId}
    `;
    for (const frozenSkill of frozenSkills) {
      const materialized = await transaction<{ id: string }[]>`
        insert into allrice_dsh_skills (
          organization_id, workspace_id, name, description, content,
          checksum, model_invocable, user_invocable, required_tool_refs,
          enabled, created_by, bundle
        )
        values (${workspace.organization_id}, ${workspace.id}, ${frozenSkill.name},
          ${frozenSkill.description}, ${frozenSkill.content}, ${frozenSkill.checksum},
          ${frozenSkill.invocation.modelInvocable}, ${frozenSkill.invocation.userInvocable},
          ${transaction.json(frozenSkill.requiredToolRefs)}, true, ${actorId},
          ${frozenSkill.bundle ? transaction.json(frozenSkill.bundle) : null})
        on conflict (organization_id, workspace_id, name)
        do update set description = excluded.description,
          content = excluded.content, checksum = excluded.checksum,
          model_invocable = excluded.model_invocable,
          user_invocable = excluded.user_invocable,
          required_tool_refs = excluded.required_tool_refs,
          enabled = excluded.enabled, bundle = excluded.bundle, updated_at = now()
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
        tenant_employee_id, tenant_employee_version_id, active, is_default,
        assigned_by_label
      ) values (
        ${input.employeeId}, ${input.revision.id}, ${workspace.organization_id},
        ${workspace.id}, ${tenantEmployeeId}, ${tenantVersionId}, true,
        not exists(select 1 from allrice_platform_employee_tenant_assignments current_default
          where current_default.organization_id=${workspace.organization_id} and current_default.workspace_id=${workspace.id}
            and current_default.active and current_default.is_default),
        ${input.actorLabel}
      )
      on conflict (employee_id, workspace_id) do update set
        revision_id = excluded.revision_id,
        tenant_employee_id = excluded.tenant_employee_id,
        tenant_employee_version_id = excluded.tenant_employee_version_id,
        is_default = (allrice_platform_employee_tenant_assignments.active and allrice_platform_employee_tenant_assignments.is_default) or excluded.is_default,
        active = true, assigned_by_label = excluded.assigned_by_label,
        assigned_at = now(), updated_at = now()
    `;
  }
}

export async function assignPublishedPlatformEmployeeToWorkspace(
  employeeKeyInput: string,
  workspaceIdInput: string,
  actorLabel = 'platform-admin',
) {
  const employeeKey = employeeKeyInput.trim();
  if (!employeeKey) throw new Error('platform_employee_key_required');
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const rows = await transaction<
      (RevisionRow & { platform_employee_id: string })[]
    >`
      select revision.*, employee.id as platform_employee_id
      from allrice_platform_employees employee
      join allrice_platform_employee_revisions revision
        on revision.id = employee.current_published_revision_id
      where employee.employee_key = ${employeeKey}
        and employee.status <> 'archived'
        and revision.status = 'published'
      for update of employee, revision
    `;
    const revision = rows[0];
    if (!revision?.runtime_profile) {
      throw new Error('platform_employee_published_revision_not_found');
    }
    const existing = await transaction<
      { revision_id: string; active: boolean }[]
    >`
      select revision_id, active
      from allrice_platform_employee_tenant_assignments
      where employee_id = ${revision.platform_employee_id}
        and workspace_id = ${workspaceId}
      for update
    `;
    if (existing[0]?.active && existing[0].revision_id === revision.id) {
      return {
        assigned: false as const,
        employeeId: revision.platform_employee_id,
        revisionId: revision.id,
        workspaceId,
      };
    }
    await materializePlatformEmployeeRevision(transaction, {
      employeeId: revision.platform_employee_id,
      revision,
      definition: PlatformEmployeeDefinitionSchema.parse(revision.definition),
      workspaceIds: [workspaceId],
      actorLabel,
    });
    await recordPlatformEmployeeAuditInTransaction(transaction, {
      employeeId: revision.platform_employee_id,
      action: 'employee.tenant_assigned',
      actorLabel,
      details: { revisionId: revision.id, workspaceId },
    });
    return {
      assigned: true as const,
      employeeId: revision.platform_employee_id,
      revisionId: revision.id,
      workspaceId,
    };
  });
  return result;
}

export async function publishPlatformEmployee(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
  administrationContext?: RequestContext,
) {
  const rapidIteration = rapidEmployeeIterationEnabled();
  const employeeId = UuidSchema.parse(employeeIdInput);
  const parsed = PublishPlatformEmployeeInputSchema.parse(input);
  const { workspaceIds } = parsed;
  const compilation = await compilePlatformEmployee(
    employeeId,
    actorLabel,
    parsed.expectedRevisionId,
  );
  if (!compilation.valid) {
    await recordPlatformEmployeeAudit({
      employeeId,
      action: 'employee.publish_rejected',
      actorLabel,
      details: {
        revisionId: compilation.revisionId,
        workspaceIds,
        errors: compilation.errors,
      },
    });
    return compilation;
  }
  if (rapidIteration) {
    const unavailable = listEmployeeToolAvailability().filter(
      (tool) =>
        compilation.runtimeProfile?.toolNames.includes(tool.canonicalName) &&
        !tool.released,
    );
    if (unavailable.length)
      return {
        ...compilation,
        valid: false,
        errors: unavailable.map(
          (tool) => `${tool.label}：执行服务当前已暂停，恢复后即可发布使用。`,
        ),
      };
  }
  const sql = getDatabase();
  const packageChecksum = compilation.runtimeProfile?.runtimePackage?.checksum;
  if (!packageChecksum)
    throw new Error('platform_employee_runtime_package_missing');
  if (
    parsed.expectedPackageChecksum !== undefined &&
    parsed.expectedPackageChecksum !== packageChecksum
  )
    throw new Error('platform_employee_publish_snapshot_changed');
  const successfulTests = await sql<{ id: string }[]>`
    select id from allrice_platform_employee_test_runs
    where employee_id = ${employeeId}
      and revision_id = ${compilation.revisionId}
      and frozen_package_checksum = ${packageChecksum}
      and status = 'succeeded'
      and completed_at >= clock_timestamp() - interval '24 hours'
    order by completed_at desc limit 1
  `;
  if (!rapidIteration && !successfulTests[0]) {
    const rejected = {
      ...compilation,
      valid: false,
      errors: [
        '发布前必须在 24 小时内成功试用一次当前确切运行包；Skill 或资源变更后需重新试用。',
      ],
    };
    await recordPlatformEmployeeAudit({
      employeeId,
      action: 'employee.publish_rejected',
      actorLabel,
      details: {
        revisionId: compilation.revisionId,
        workspaceIds,
        errors: rejected.errors,
      },
    });
    return rejected;
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
    const rejected = {
      ...compilation,
      valid: false,
      errors: ['发布目标包含不存在、已归档或越权的工作区。'],
    };
    await recordPlatformEmployeeAudit({
      employeeId,
      action: 'employee.publish_rejected',
      actorLabel,
      details: {
        revisionId: compilation.revisionId,
        workspaceIds: uniqueWorkspaceIds,
        errors: rejected.errors,
      },
    });
    return rejected;
  }
  if (!rapidIteration) {
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
        const rejected = {
          ...compilation,
          valid: false,
          errors: ['Codex 订阅 Provider 当前不可用或健康状态已过期。'],
        };
        await recordPlatformEmployeeAudit({
          employeeId,
          action: 'employee.publish_rejected',
          actorLabel,
          details: {
            revisionId: compilation.revisionId,
            workspaceIds: uniqueWorkspaceIds,
            errors: rejected.errors,
          },
        });
        return rejected;
      }
    } else {
      const rejected = {
        ...compilation,
        valid: false,
        errors: [
          `Provider ${compilation.runtimeProfile?.provider ?? 'unknown'} 尚未通过平台生产健康门禁。`,
        ],
      };
      await recordPlatformEmployeeAudit({
        employeeId,
        action: 'employee.publish_rejected',
        actorLabel,
        details: {
          revisionId: compilation.revisionId,
          workspaceIds: uniqueWorkspaceIds,
          errors: rejected.errors,
        },
      });
      return rejected;
    }
  }
  const published = await sql.begin(async (transaction) => {
    if (administrationContext)
      await requireTenantAdministrationAuthority(
        administrationContext,
        transaction,
      );
    const [employee] = await transaction<
      {
        current_draft_revision_id: string | null;
        current_published_revision_id: string | null;
      }[]
    >`
      select current_draft_revision_id,current_published_revision_id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    if (employee?.current_draft_revision_id !== compilation.revisionId)
      throw new Error('platform_employee_publish_snapshot_changed');
    if (
      parsed.expectedPublishedRevisionId !== undefined &&
      parsed.expectedPublishedRevisionId !==
        employee.current_published_revision_id
    )
      throw new Error('platform_employee_publish_snapshot_changed');
    const revisions = await transaction<RevisionRow[]>`
      select * from allrice_platform_employee_revisions
      where id = ${compilation.revisionId} and employee_id = ${employeeId}
        and status = 'testing' and published_at is null
      for update
    `;
    const revision = revisions[0];
    if (!revision?.runtime_profile)
      throw new Error('platform_employee_not_compiled');
    const definition = PlatformEmployeeDefinitionSchema.parse(
      revision.definition,
    );
    const profile = PlatformEmployeeRuntimeProfileSchema.parse(
      revision.runtime_profile,
    );
    if (
      profile.runtimePackage?.checksum !== packageChecksum ||
      checksum(profile) !== checksum(compilation.runtimeProfile)
    )
      throw new Error('platform_employee_publish_snapshot_changed');
    validatePlatformEmployeeTestExecutionSnapshot({
      runtimeProfile: profile,
      definition,
      nativeSkills: profile.runtimePackage.skills,
      packageChecksum,
    });
    // Recheck authority after obtaining the publication locks. The initial
    // UI-facing checks do not authorize a later transaction or another draft.
    const targets = await transaction<
      { id: string; organization_id: string }[]
    >`
      select workspace.id,workspace.organization_id from allrice_workspaces workspace
      join allrice_organizations organization on organization.id = workspace.organization_id
      where workspace.id in ${transaction(uniqueWorkspaceIds)}
        and workspace.archived_at is null and organization.archived_at is null
        and organization.slug <> 'allrice-platform'
      for share of workspace, organization
    `;
    if (targets.length !== uniqueWorkspaceIds.length)
      throw new Error('platform_employee_publish_workspace_unavailable');
    if (parsed.policyVersions) {
      if (Object.keys(parsed.policyVersions).length !== targets.length)
        throw new Error('platform_employee_publish_policy_changed');
      for (const target of [...targets].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        await transaction`select pg_advisory_xact_lock(hashtextextended(${`runtime-policy:${target.organization_id}:${target.id}`},0))`;
        const [policy] = await transaction<
          { version: number }[]
        >`select version from allrice_runtime_policy_controls where organization_id=${target.organization_id} and workspace_id=${target.id} for share`;
        if (parsed.policyVersions[target.id] !== (policy?.version ?? null))
          throw new Error('platform_employee_publish_policy_changed');
      }
    }
    let assertFreshPublication = async () => {};
    if (!rapidIteration) {
      const providers = await transaction<{ checked_at: Date }[]>`
      select checked_at from allrice_provider_status
      where provider = 'codex' and status = 'connected'
        and checked_at >= clock_timestamp() - interval '120 seconds'
      for share
    `;
      if (profile.provider !== 'openai-codex' || !providers[0])
        throw new Error('platform_employee_publish_provider_unavailable');
      const exactTests = await transaction<
        { id: string; completed_at: Date }[]
      >`
      select id, completed_at from allrice_platform_employee_test_runs
      where id = ${successfulTests[0]!.id} and employee_id = ${employeeId}
        and revision_id = ${revision.id} and frozen_package_checksum = ${packageChecksum}
        and status = 'succeeded'
        and completed_at >= clock_timestamp() - interval '24 hours'
      for share
    `;
      if (!exactTests[0])
        throw new Error('platform_employee_publish_test_unavailable');
      assertFreshPublication = async () => {
        // WHERE predicates can have been evaluated before a row-lock wait.
        // Read the DB wall clock after all locks, and again before committing.
        const [clock] = await transaction<
          { at: Date }[]
        >`select clock_timestamp() as at`;
        const at = clock!.at.getTime();
        if (providers[0]!.checked_at.getTime() < at - 120_000)
          throw new Error('platform_employee_publish_provider_unavailable');
        if (exactTests[0]!.completed_at.getTime() < at - 86_400_000)
          throw new Error('platform_employee_publish_test_unavailable');
      };
      await assertFreshPublication();
    }

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
    await recordPlatformEmployeeAuditInTransaction(transaction, {
      employeeId,
      action: 'employee.published',
      actorLabel,
      details: {
        revisionId: revision.id,
        workspaceIds: uniqueWorkspaceIds,
        testRunId: successfulTests[0]?.id ?? null,
        packageChecksum,
      },
    });
    await assertFreshPublication();
    const trialTargets = await transaction<
      { workspaceId: string; employeeId: string }[]
    >`
      select workspace_id as "workspaceId", tenant_employee_id as "employeeId"
      from allrice_platform_employee_tenant_assignments where employee_id=${employeeId}
        and revision_id=${revision.id} and active and workspace_id in ${transaction(uniqueWorkspaceIds)}`;
    return {
      valid: true,
      employeeId,
      revisionId: revision.id,
      workspaceIds: uniqueWorkspaceIds,
      trialTargets,
      runtimeProfile: PlatformEmployeeRuntimeProfileSchema.parse(
        revision.runtime_profile,
      ),
      errors: [],
      warnings: [],
    };
  });
  return published;
}

export async function rollbackPlatformEmployee(
  employeeIdInput: string,
  input: unknown,
  actorLabel = 'platform-admin',
  administrationContext?: RequestContext,
) {
  const employeeId = UuidSchema.parse(employeeIdInput);
  const {
    revisionId,
    reason,
    expectedPublishedRevisionId,
    expectedWorkspaceIds,
  } = RollbackPlatformEmployeeInputSchema.parse(input);
  const sql = getDatabase();
  const rolledBack = await sql.begin(async (transaction) => {
    if (administrationContext)
      await requireTenantAdministrationAuthority(
        administrationContext,
        transaction,
      );
    const employees = await transaction<
      { current_published_revision_id: string | null }[]
    >`
      select current_published_revision_id from allrice_platform_employees
      where id = ${employeeId} and status <> 'archived'
      for update
    `;
    const employee = employees[0];
    if (!employee) throw new Error('platform_employee_not_found');
    if (
      expectedPublishedRevisionId !== undefined &&
      expectedPublishedRevisionId !== employee.current_published_revision_id
    )
      throw new Error('platform_employee_publish_snapshot_changed');
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
      where employee_id = ${employeeId} and active
      order by active desc, updated_at desc, workspace_id
    `;
    const workspaceIds = [...new Set(targets.map((row) => row.workspace_id))];
    if (
      expectedWorkspaceIds &&
      JSON.stringify([...new Set(expectedWorkspaceIds)].sort()) !==
        JSON.stringify([...workspaceIds].sort())
    )
      throw new Error('platform_employee_publish_snapshot_changed');
    if (workspaceIds.length === 0)
      throw new Error('platform_employee_rollback_has_no_tenant_targets');
    const available = await transaction<
      { id: string }[]
    >`select w.id from allrice_workspaces w
      join allrice_organizations o on o.id=w.organization_id where w.id in ${transaction(workspaceIds)}
      and w.archived_at is null and o.archived_at is null and o.slug<>'allrice-platform' for share of w,o`;
    if (available.length !== workspaceIds.length)
      throw new Error('platform_employee_publish_workspace_unavailable');
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
    const result = {
      employeeId,
      revisionId: target.id,
      revision: target.revision,
      previousRevisionId: employee.current_published_revision_id,
      workspaceIds,
    };
    await recordPlatformEmployeeAuditInTransaction(transaction, {
      employeeId,
      action: 'employee.rolled_back',
      actorLabel,
      details: { reason, ...result },
    });
    return result;
  });
  return rolledBack;
}
