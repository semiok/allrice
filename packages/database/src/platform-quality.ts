import type postgres from 'postgres';
import { z } from 'zod';
import {
  PlatformEmployeeDefinitionSchema,
  ProjectSnapshotSchema,
  BrowserVerificationOutcomeSchema,
  RuntimeOperationSnapshotSchema,
  UuidSchema,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requirePlatformAdmin, isPlatformAdmin } from './platform-authority.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { materializePlatformEmployeeRevision } from './employees/platform-employees.ts';
import { synchronizeTenantEmployeeAccess } from './tenant-employee-access.ts';
import { createChatSession } from './workspace/service.ts';
import { prepareEmployeeRunBinding } from './employees/employeehub.ts';
import {
  CreateQualityCheckSchema,
  QualityCheckSchema,
  QualityCheckReportSchema,
  QualityScheduleOriginSchema,
  type QualityScheduleOrigin,
} from './platform-quality-contracts.ts';
import {
  admitScheduledQualityOccurrence,
  bindScheduledQualityOccurrence,
  qualityOccurrenceRequestId,
} from './platform-quality-automation.ts';
import {
  qualityFixture,
  qualityDigest,
  qualityCaseSpec,
} from './platform-quality-case.ts';
import { technicalEnvironment } from './platform-technical.ts';
import { QueueError } from './execution/queue.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import {
  projectSourceArchive,
  projectExecutionReport,
} from './project-delivery.ts';
import type { JobRow } from './queue/row-mappers.ts';
export type { QualityCheckReport } from './platform-quality-contracts.ts';

type Tx = postgres.TransactionSql;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const QualityFrozenSchema = CreateQualityCheckSchema.extend({
  releaseSha: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.enum(['dev', 'prod', 'test', 'unknown']),
  fixtureDigest: digest,
  assertionDigest: digest,
  runnerDigest: digest,
  fingerprint: digest,
  employeeVersionId: UuidSchema,
  employeeRevisionId: UuidSchema,
  assignmentId: UuidSchema,
  userMessageId: UuidSchema,
  assistantMessageId: UuidSchema,
  timeoutMs: z.number().int().min(1000).max(300000),
  loginSessionId: UuidSchema.optional(),
  loginAuthenticatedAt: z.string().datetime({ offset: true }).optional(),
  scheduleOrigin: QualityScheduleOriginSchema.optional(),
})
  .strict()
  .refine(
    (f) =>
      !f.scheduleOrigin ||
      (f.caseId === 'project.static.v1' &&
        f.variant === 'correct' &&
        f.requestId ===
          qualityOccurrenceRequestId(f.scheduleOrigin.occurrenceId)),
  )
  .refine(
    (f) =>
      f.caseId !== 'project.live.v1' ||
      (!f.scheduleOrigin &&
        !!f.loginSessionId &&
        !!f.loginAuthenticatedAt &&
        f.variant === 'correct'),
  );
export const QualityBindingSchema = z
  .object({
    id: UuidSchema,
    inputDigest: digest,
    frozen: QualityFrozenSchema,
  })
  .strict();
export type QualityBinding = z.infer<typeof QualityBindingSchema>;
export type QualityLease = {
  workerId: string;
  jobId: string;
  leaseToken: string;
  attempt: number;
};
function denied(): never {
  throw new DataAccessError('authorization_denied');
}
function frozenValid(raw: unknown) {
  const f = QualityFrozenSchema.safeParse(raw);
  if (!f.success) return false;
  const spec = qualityCaseSpec(f.data.caseId, f.data.variant);
  return (
    f.data.fixtureDigest === qualityDigest(spec.files) &&
    f.data.assertionDigest === qualityDigest(spec.assertion) &&
    f.data.runnerDigest === qualityDigest(spec.runnerVersion) &&
    f.data.fingerprint === fingerprint(f.data)
  );
}
function fingerprint(
  f: Omit<z.infer<typeof QualityFrozenSchema>, 'fingerprint'>,
) {
  return qualityDigest([
    f.releaseSha,
    f.environment,
    f.caseId,
    f.variant,
    f.fixtureDigest,
    f.assertionDigest,
    f.runnerDigest,
    f.employeeVersionId,
    f.employeeRevisionId,
    f.timeoutMs,
    ...(f.caseId === 'project.live.v1' ? [f.loginSessionId] : []),
    ...(f.scheduleOrigin ? [qualityDigest(f.scheduleOrigin)] : []),
  ]);
}

/** A real published deployment, owner-only, in the existing private workspace.
 * Existing pauses and personal exclusions are never restored by retries. */
export async function ensureQualityEmployee(context: RequestContext) {
  return getDatabase().begin(async (tx) => {
    const owner = await requirePlatformAdmin(context, tx);
    const { context: internal } = await resolvePlatformPreviewContext(
      tx,
      { environment: 'platform', workspaceId: null, ownerId: owner },
      owner,
      true,
    );
    const { organization_id: organizationId, workspace_id: workspaceId } =
      internal;
    type Revision = Parameters<
      typeof materializePlatformEmployeeRevision
    >[1]['revision'];
    const [revision] = await tx<
      (Revision & { platform_employee_id: string })[]
    >`select r.*,e.id platform_employee_id
      from allrice_platform_employees e join allrice_platform_employee_revisions r on r.id=e.current_published_revision_id
      where e.employee_key='rice' and e.status='published' and r.status='published' for share of e,r`;
    if (!revision?.runtime_profile) throw new DataAccessError('not_found');
    const definition = PlatformEmployeeDefinitionSchema.parse(
      revision.definition,
    );
    if (
      !['workspace.project', 'browser.workspace'].every((t) =>
        definition.capabilities.toolNames.includes(t),
      )
    )
      throw new DataAccessError('grant_invalid');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-deployments:${organizationId}:${workspaceId}`},0))`;
    const [deployment] =
      await tx`select d.*,e.status employee_status from allrice_platform_employee_tenant_assignments d
      join allrice_employees e on e.id=d.tenant_employee_id where d.employee_id=${revision.platform_employee_id} and d.workspace_id=${workspaceId} for update of d`;
    if (
      deployment &&
      (!deployment.active ||
        deployment.employee_status !== 'active' ||
        deployment.inherit_by_default)
    )
      denied();
    const [choice] = deployment
      ? await tx`select active,selection_mode from allrice_employee_assignments
      where employee_id=${deployment.tenant_employee_id} and workspace_id=${workspaceId} and user_id=${owner}`
      : [];
    if (choice && (choice.selection_mode === 'exclude' || !choice.active))
      denied();
    if (deployment && deployment.revision_id !== revision.id) {
      const busy =
        await tx`select q.id from allrice_platform_quality_checks q join allrice_jobs j on j.id=q.job_id
        where q.workspace_id=${workspaceId} and j.status in ('queued','claimed','running','waiting_approval') limit 1`;
      if (busy.length) throw new QueueError('conflict');
    }
    if (!deployment || deployment.revision_id !== revision.id) {
      await materializePlatformEmployeeRevision(tx, {
        employeeId: revision.platform_employee_id,
        revision,
        definition,
        workspaceIds: [workspaceId],
        actorLabel: owner,
        inheritByDefault: false,
        preserveCurrentPolicy: true,
      });
    }
    const [d] =
      await tx`select tenant_employee_id,tenant_employee_version_id from allrice_platform_employee_tenant_assignments
      where employee_id=${revision.platform_employee_id} and workspace_id=${workspaceId} and active`;
    if (!d) denied();
    await tx`insert into allrice_employee_assignments(organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default,active,assigned_by,selection_mode)
      values(${organizationId},${workspaceId},${d.tenant_employee_id},${d.tenant_employee_version_id},${owner},false,true,${owner},'include')
      on conflict(organization_id,workspace_id,user_id,employee_id) do update set selection_mode='include'
      where allrice_employee_assignments.active and allrice_employee_assignments.selection_mode<>'exclude'`;
    await synchronizeTenantEmployeeAccess(tx, { organizationId, workspaceId });
    const [a] =
      await tx`select id,employee_id,employee_version_id from allrice_employee_assignments where organization_id=${organizationId}
      and workspace_id=${workspaceId} and user_id=${owner} and employee_id=${d.tenant_employee_id} and active`;
    if (!a) denied();
    await tx`insert into allrice_platform_quality_deployments(workspace_id,organization_id,owner_id,employee_id,assignment_id,employee_version_id,employee_revision_id)
      values(${workspaceId},${organizationId},${owner},${a.employee_id},${a.id},${a.employee_version_id},${revision.id})
      on conflict(workspace_id) do update set employee_version_id=excluded.employee_version_id,employee_revision_id=excluded.employee_revision_id
      where allrice_platform_quality_deployments.owner_id=excluded.owner_id and allrice_platform_quality_deployments.assignment_id=excluded.assignment_id`;
    return {
      internal,
      revisionId: revision.id,
      assignmentId: a.id as string,
      versionId: a.employee_version_id as string,
    };
  });
}

async function qualitySchemaAvailable(tx: Tx) {
  // Historical checkpoints have no QA reservation. Never borrow new tables
  // from a later schema on search_path, or swallow a broken applied migration.
  const [schema] = await tx`select
    to_regclass(format('%I.allrice_platform_quality_deployments',current_schema())) is not null deployments,
    to_regclass(format('%I.allrice_platform_quality_checks',current_schema())) is not null checks,
    to_regclass(format('%I.allrice_schema_migrations',current_schema())) is not null migrations`;
  if (schema?.deployments && schema.checks) return true;
  if (schema?.deployments || schema?.checks)
    throw new QueueError('policy_denied');
  if (schema?.migrations) {
    const applied = await tx`select 1 from allrice_schema_migrations
      where name='0141_platform_quality_checks.sql'`;
    if (applied.length) throw new QueueError('policy_denied');
  }
  return false;
}
function hasQualityMarker(job: JobRow) {
  const input = (job.payload as { input?: Record<string, unknown> }).input;
  return Boolean(
    input &&
    (Object.hasOwn(input, 'qualityRequestId') ||
      Object.hasOwn(input, 'qualityInputDigest')),
  );
}
/** Queue admission rejects public chat/Run requests using this reserved identity. */
export async function admitQualityEnqueue(
  tx: Tx,
  context: RequestContext,
  assignmentId: string,
  binding?: QualityBinding,
) {
  if (!(await qualitySchemaAvailable(tx))) {
    if (binding) denied();
    return;
  }
  const [d] =
    await tx`select * from allrice_platform_quality_deployments where assignment_id=${assignmentId}`;
  if (!d) {
    if (binding) denied();
    return;
  }
  const b = binding && QualityBindingSchema.parse(binding);
  if (
    !b ||
    !frozenValid(b.frozen) ||
    d.owner_id !== context.actor.id ||
    d.workspace_id !== context.workspaceId ||
    d.organization_id !== context.organizationId ||
    d.employee_version_id !== b.frozen.employeeVersionId ||
    d.employee_revision_id !== b.frozen.employeeRevisionId ||
    d.assignment_id !== b.frozen.assignmentId
  )
    denied();
  await requirePlatformAdmin(context, tx);
  await resolvePlatformPreviewContext(
    tx,
    {
      environment: 'platform',
      workspaceId: context.workspaceId,
      ownerId: context.actor.id,
    },
    context.actor.id,
  );
  if (b.frozen.scheduleOrigin) {
    if (
      b.frozen.caseId !== 'project.static.v1' ||
      b.frozen.variant !== 'correct' ||
      b.frozen.requestId !==
        qualityOccurrenceRequestId(b.frozen.scheduleOrigin.occurrenceId)
    )
      denied();
    await admitScheduledQualityOccurrence(tx, context, b.frozen.scheduleOrigin);
  }
}
/** Duplicate queue admissions must not alias manual and scheduled requests. */
export async function assertExistingPlatformQualityBinding(
  tx: Tx,
  context: RequestContext,
  runId: string,
  raw: QualityBinding,
) {
  const b = QualityBindingSchema.parse(raw);
  const [q] =
    await tx`select * from allrice_platform_quality_checks where run_id=${runId} and owner_id=${context.actor.id}`;
  if (
    !q ||
    q.id !== b.id ||
    q.input_digest !== b.inputDigest ||
    !frozenValid(q.frozen) ||
    q.frozen.fingerprint !== b.frozen.fingerprint ||
    (q.automation_run_id ?? null) !==
      (b.frozen.scheduleOrigin?.occurrenceId ?? null)
  )
    throw new QueueError('conflict');
}
export async function bindPlatformQualityCheck(
  tx: Tx,
  context: RequestContext,
  runId: string,
  jobId: string,
  sessionId: string,
  raw: QualityBinding,
) {
  const b = QualityBindingSchema.parse(raw);
  await admitQualityEnqueue(tx, context, b.frozen.assignmentId, b);
  const request = CreateQualityCheckSchema.parse({
    requestId: b.frozen.requestId,
    caseId: b.frozen.caseId,
    variant: b.frozen.variant,
  });
  if (b.inputDigest !== qualityDigest(request)) denied();
  await tx`insert into allrice_platform_quality_checks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen,automation_run_id)
    values(${b.id},${request.requestId},${context.organizationId},${context.workspaceId},${context.actor.id},${runId},${jobId},${sessionId},${b.inputDigest},${tx.json(JSON.parse(JSON.stringify(b.frozen)))},${b.frozen.scheduleOrigin?.occurrenceId ?? null})`;
  if (b.frozen.scheduleOrigin)
    await bindScheduledQualityOccurrence(
      tx,
      context,
      b.frozen.scheduleOrigin,
      runId,
      sessionId,
    );
}

/** Additional restrictions only: employee/session/membership/target guards remain. */
export async function isPlatformQualityJobAuthorized(tx: Tx, job: JobRow) {
  if ((job.payload as { type?: unknown })?.type !== 'allrice.employee.run')
    return true;
  if (!(await qualitySchemaAvailable(tx))) return !hasQualityMarker(job);
  // Detect reservation independently of the current identity/authority join.
  // Renaming, archiving or revocation must not turn a reserved assignment into
  // an ordinary chat identity when a caller omits the marker.
  const [reserved] =
    await tx`select d.assignment_id from allrice_employee_runs e
    join allrice_platform_quality_deployments d on d.assignment_id=e.employee_assignment_id
    where e.run_id=${job.run_id}`;
  if (!reserved) return !hasQualityMarker(job);
  const [row] =
    await tx`select q.*,d.assignment_id,d.owner_id deployment_owner,e.employee_assignment_id,e.employee_version_id,
    e.session_id employee_session,r.input run_input,a.active assignment_active,emp.status employee_status,
    e.execution_snapshot,s.archived_at session_archived,o.archived_at organization_archived,w.archived_at workspace_archived,
    pa.active deployment_active,a.selection_mode,d.employee_version_id current_employee_version,
    exists(select 1 from allrice_memberships m where m.user_id=e.owner_id and m.organization_id=e.organization_id and m.active and (m.workspace_id is null or m.workspace_id=e.workspace_id)) member_active
    from allrice_employee_runs e join allrice_runs r on r.id=e.run_id
    join allrice_platform_quality_deployments d on d.assignment_id=e.employee_assignment_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.user_id=e.owner_id
    join allrice_employees emp on emp.id=a.employee_id
    join allrice_platform_employee_tenant_assignments pa on pa.tenant_employee_id=a.employee_id and pa.workspace_id=e.workspace_id
    join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id
    join allrice_organizations o on o.id=e.organization_id and o.slug='allrice-platform'
    join allrice_workspaces w on w.id=e.workspace_id and w.organization_id=e.organization_id
    and w.slug='employee-tests-'||e.owner_id::text
    left join allrice_platform_quality_checks q on q.run_id=r.id where r.id=${job.run_id}`;
  if (!row) return false;
  if (
    !row.id ||
    !frozenValid(row.frozen) ||
    row.job_id !== job.id ||
    row.run_id !== job.run_id ||
    row.owner_id !== job.owner_id ||
    row.deployment_owner !== job.owner_id ||
    row.organization_id !== job.organization_id ||
    row.workspace_id !== job.workspace_id ||
    row.employee_session !== row.session_id ||
    row.employee_version_id !== row.frozen.employeeVersionId ||
    row.employee_assignment_id !== row.frozen.assignmentId ||
    job.max_attempts !== 1 ||
    !row.assignment_active ||
    row.employee_status !== 'active' ||
    !row.deployment_active ||
    !row.member_active ||
    row.selection_mode === 'exclude' ||
    row.current_employee_version !== row.frozen.employeeVersionId ||
    row.session_archived ||
    row.organization_archived ||
    row.workspace_archived ||
    !row.execution_snapshot?.taskRuntimePolicy ||
    row.execution_snapshot.taskRuntimePolicy.timeoutMs !==
      row.frozen.timeoutMs ||
    new Date(row.created_at).getTime() + row.frozen.timeoutMs <= Date.now()
  )
    return false;
  const input = (job.payload as { input?: Record<string, unknown> }).input;
  if (
    !input ||
    input.qualityRequestId !== row.request_id ||
    input.qualityInputDigest !== row.input_digest ||
    input.employeeAssignmentId !== row.employee_assignment_id ||
    input.employeeVersionId !== row.employee_version_id ||
    input.sessionId !== row.session_id ||
    input.userMessageId !== row.frozen.userMessageId ||
    input.assistantMessageId !== row.frozen.assistantMessageId ||
    qualityDigest(input) !== qualityDigest(row.run_input)
  )
    return false;
  if (row.frozen.loginSessionId) {
    const [login] =
      await tx`select id from allrice_sessions where id=${row.frozen.loginSessionId} and user_id=${row.owner_id} and revoked_at is null and expires_at>clock_timestamp()`;
    if (!login) return false;
  }
  const origin = row.frozen.scheduleOrigin as QualityScheduleOrigin | undefined;
  if (origin) {
    const [occurrence] =
      await tx`select r.*,a.owner_id from allrice_automation_runs r
      join allrice_automations a on a.id=r.automation_id where r.id=${origin.occurrenceId}`;
    // A configuration pause/edit stops new dispatches, not an already bound Run.
    if (
      !occurrence ||
      row.automation_run_id !== origin.occurrenceId ||
      occurrence.automation_id !== origin.automationId ||
      occurrence.owner_id !== origin.ownerId ||
      occurrence.organization_id !== job.organization_id ||
      occurrence.workspace_id !== job.workspace_id ||
      occurrence.run_id !== job.run_id ||
      occurrence.session_id !== row.session_id ||
      qualityDigest(occurrence.quality_occurrence) !== qualityDigest(origin)
    )
      return false;
  } else if (row.automation_run_id) return false;
  return isPlatformAdmin({ actor: { type: 'user', id: job.owner_id } }, tx);
}

/** The service lease may outlive a successful Job, but never the platform
 * authority or its reserved private deployment. Do not use the active-Job
 * guard here: that would incorrectly end every legitimate continued preview.
 * Reservation detection is independent of the authority joins so revocation
 * cannot turn a QA service into an ordinary employee service. */
export async function isPlatformQualityServiceAuthorized(
  tx: Tx,
  service: {
    run_id: string;
    owner_id: string;
    organization_id: string;
    workspace_id: string;
  },
) {
  const [run] =
    await tx`select input from allrice_runs where id=${service.run_id}`;
  const input = run?.input;
  const marked =
    input &&
    typeof input === 'object' &&
    ('qualityRequestId' in input || 'qualityInputDigest' in input);
  if (!(await qualitySchemaAvailable(tx))) return !marked;
  const [reserved] =
    await tx`select d.assignment_id from allrice_employee_runs e
    join allrice_platform_quality_deployments d on d.assignment_id=e.employee_assignment_id
    where e.run_id=${service.run_id}`;
  if (!reserved) return !marked;
  const [q] =
    await tx`select q.*,e.employee_version_id,e.employee_assignment_id,
    d.employee_version_id current_version,d.owner_id deployment_owner,
    a.active assignment_active,a.selection_mode,emp.status employee_status,
    pa.active deployment_active,s.archived_at session_archived,
    o.archived_at organization_archived,w.archived_at workspace_archived
    from allrice_platform_quality_checks q
    join allrice_employee_runs e on e.run_id=q.run_id and e.owner_id=q.owner_id
      and e.organization_id=q.organization_id and e.workspace_id=q.workspace_id and e.session_id=q.session_id
    join allrice_platform_quality_deployments d on d.assignment_id=e.employee_assignment_id
      and d.organization_id=q.organization_id and d.workspace_id=q.workspace_id
    join allrice_employee_assignments a on a.id=d.assignment_id and a.user_id=q.owner_id
      and a.organization_id=q.organization_id and a.workspace_id=q.workspace_id
    join allrice_employees emp on emp.id=a.employee_id and emp.id=d.employee_id
      and emp.organization_id=q.organization_id and emp.workspace_id=q.workspace_id
    join allrice_platform_employee_tenant_assignments pa on pa.tenant_employee_id=emp.id and pa.workspace_id=q.workspace_id
    join allrice_chat_sessions s on s.id=q.session_id and s.owner_id=q.owner_id
    join allrice_organizations o on o.id=q.organization_id and o.slug='allrice-platform'
    join allrice_workspaces w on w.id=q.workspace_id and w.organization_id=q.organization_id
      and w.slug='employee-tests-'||q.owner_id::text
    where q.run_id=${service.run_id}`;
  if (
    !q ||
    !marked ||
    !frozenValid(q.frozen) ||
    q.owner_id !== service.owner_id ||
    q.deployment_owner !== service.owner_id ||
    q.organization_id !== service.organization_id ||
    q.workspace_id !== service.workspace_id ||
    q.employee_assignment_id !== q.frozen.assignmentId ||
    q.employee_version_id !== q.frozen.employeeVersionId ||
    q.current_version !== q.frozen.employeeVersionId ||
    !q.assignment_active ||
    q.selection_mode === 'exclude' ||
    q.employee_status !== 'active' ||
    !q.deployment_active ||
    q.session_archived ||
    q.organization_archived ||
    q.workspace_archived ||
    input.qualityRequestId !== q.request_id ||
    input.qualityInputDigest !== q.input_digest
  )
    return false;
  if (q.frozen.loginSessionId) {
    const [login] =
      await tx`select id from allrice_sessions where id=${q.frozen.loginSessionId} and user_id=${q.owner_id} and revoked_at is null and expires_at>clock_timestamp()`;
    if (!login) return false;
  }
  return isPlatformAdmin({ actor: { type: 'user', id: service.owner_id } }, tx);
}

export async function getPlatformQualityExecution(lease: QualityLease) {
  return getDatabase().begin(async (tx) => {
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${UuidSchema.parse(lease.jobId)} for update`;
    if (
      !job ||
      job.status !== 'running' ||
      job.worker_id !== lease.workerId ||
      job.lease_token !== lease.leaseToken ||
      job.attempt !== lease.attempt ||
      !job.lease_expires_at ||
      job.lease_expires_at <= new Date() ||
      job.timeout_at <= new Date() ||
      job.cancel_requested_at ||
      !(await isPlatformQualityJobAuthorized(tx, job))
    )
      denied();
    const [row] =
      await tx`select * from allrice_platform_quality_checks where job_id=${job.id}`;
    if (!row) denied();
    return {
      id: row.id as string,
      runId: job.run_id,
      sessionId: row.session_id as string,
      ownerId: job.owner_id,
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      frozen: QualityFrozenSchema.parse(row.frozen),
    };
  });
}
/** Used inside existing publication transactions without opening a second
 * transaction or reversing the root -> Job -> session lock order. */
export async function assertPlatformQualityLease(tx: Tx, lease: QualityLease) {
  const [job] = await tx<
    JobRow[]
  >`select * from allrice_jobs where id=${lease.jobId} for share`;
  if (
    !job ||
    job.status !== 'running' ||
    job.worker_id !== lease.workerId ||
    job.lease_token !== lease.leaseToken ||
    job.attempt !== lease.attempt ||
    !job.lease_expires_at ||
    job.lease_expires_at <= new Date() ||
    job.timeout_at <= new Date() ||
    job.cancel_requested_at ||
    !(await isPlatformQualityJobAuthorized(tx, job))
  )
    denied();
}
export async function recordPlatformQualityReport(
  lease: QualityLease,
  raw: unknown,
  storage: StoragePort,
) {
  const report = QualityCheckReportSchema.parse(raw);
  const check = await getPlatformQualityExecution(lease);
  if (
    (check.frozen.caseId === 'project.live.v1') !== !!report.live &&
    ['passed', 'assertion_failed'].includes(report.verdict)
  )
    denied();
  const principal = {
    actor: { type: 'user' as const, id: check.ownerId },
    organizationId: check.organizationId,
    workspaceId: check.workspaceId,
  };
  if (['passed', 'assertion_failed'].includes(report.verdict)) {
    const source = await getWorkbenchArtifact(
      principal,
      check.sessionId,
      report.project!.snapshot.id,
    );
    if (source.object.checksum !== report.project!.snapshot.checksum) denied();
    const snapshot = ProjectSnapshotSchema.parse(
      JSON.parse(
        (await readArtifactBytes(storage, source.object, 2_000_000)).toString(
          'utf8',
        ),
      ),
    );
    if (
      snapshot.projectId !== report.project!.projectId ||
      qualityDigest(
        snapshot.files.map((f) => ({
          path: f.path,
          text: Buffer.from(f.contentBase64, 'base64').toString('utf8'),
        })),
      ) !==
        (report.live
          ? qualityDigest(
              qualityCaseSpec(
                check.frozen.caseId,
                check.frozen.variant,
              ).files.map((f) =>
                f.path === 'main.js'
                  ? { ...f, text: f.text.replace('source:42', 'source:43') }
                  : f,
              ),
            )
          : check.frozen.fixtureDigest)
    )
      denied();
    for (const a of report.artifacts.filter((a) =>
      ['source', 'page'].includes(a.kind),
    )) {
      const current = await getWorkbenchArtifact(
          principal,
          check.sessionId,
          a.versionId,
        ),
        bytes = await readArtifactBytes(storage, current.object, 2_000_000);
      if (
        current.object.checksum !== a.checksum ||
        (a.kind === 'page'
          ? bytes.toString('utf8') !== qualityFixture(check.frozen.variant).html
          : !bytes.equals(Buffer.from(projectSourceArchive(snapshot))))
      )
        denied();
    }
  }
  await getDatabase().begin(async (tx) => {
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${lease.jobId} for update`;
    if (
      !job ||
      job.status !== 'running' ||
      job.lease_token !== lease.leaseToken ||
      job.worker_id !== lease.workerId ||
      job.attempt !== lease.attempt ||
      !job.lease_expires_at ||
      job.lease_expires_at <= new Date() ||
      job.timeout_at <= new Date() ||
      job.cancel_requested_at ||
      !(await isPlatformQualityJobAuthorized(tx, job))
    )
      denied();
    for (const artifact of report.artifacts) {
      const [found] =
        await tx`select v.id from allrice_deliverable_versions v join allrice_storage_objects o on o.id=v.object_id
        join allrice_workbench_artifacts a on a.version_id=v.id and a.run_id=${check.runId}
        where v.id=${artifact.versionId} and v.id=${artifact.artifactId} and v.session_id=${check.sessionId} and v.organization_id=${check.organizationId} and v.workspace_id=${check.workspaceId}
          and v.owner_id=${check.ownerId} and o.id=${artifact.objectId} and o.checksum=${artifact.checksum} and o.size_bytes=${artifact.sizeBytes} and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())`;
      if (!found) denied();
    }
    if (report.live) {
      const live = report.live;
      const [service] =
        await tx`select s.*,o.snapshot from allrice_project_services s join allrice_runtime_operations o on o.id=s.id
        where s.id=${live.service.serviceId} and s.run_id=${check.runId} and s.owner_id=${check.ownerId}
          and s.organization_id=${check.organizationId} and s.workspace_id=${check.workspaceId}`;
      const [update] =
        await tx`select payload,result from allrice_project_service_controls where service_id=${live.service.serviceId} and request_id=${live.updateId}`;
      const [receipt] =
        await tx`select payload from allrice_run_events where run_id=${check.runId} and event_type='tool.completed'
        and payload->>'source'='platform_quality_live' and payload->>'toolCallId'=${live.toolCallId}
        and payload->>'jobAttempt'=${String(lease.attempt)} order by sequence desc limit 1`;
      const [browser] =
        await tx`select * from allrice_managed_browser_tasks where id=${live.browserTaskId}
        and organization_id=${check.organizationId} and workspace_id=${check.workspaceId} and run_id=${check.runId}
        and job_id=${lease.jobId} and job_attempt=${lease.attempt} and tool_call_id=${live.toolCallId} and status='succeeded'`;
      if (
        !service ||
        !browser ||
        !update?.result?.applied ||
        !receipt ||
        live.checkId !== check.id ||
        live.runId !== check.runId ||
        live.jobId !== lease.jobId ||
        live.jobAttempt !== lease.attempt ||
        qualityDigest(receipt.payload.evidence) !== qualityDigest(live) ||
        service.snapshot.status !== 'running' ||
        service.snapshot.cancelRequestId ||
        service.stop_requested ||
        service.source_digest !== live.sourceDigest ||
        service.pending_update ||
        qualityDigest(service.project_ref) !==
          qualityDigest(live.updatedProject) ||
        qualityDigest(update.payload.expectedProject) !==
          qualityDigest(live.originalProject) ||
        qualityDigest(update.payload.project) !==
          qualityDigest(live.updatedProject) ||
        update.result.sourceDigest !== live.sourceDigest ||
        !(await isPlatformQualityServiceAuthorized(tx, {
          run_id: check.runId,
          owner_id: check.ownerId,
          organization_id: check.organizationId,
          workspace_id: check.workspaceId,
        }))
      )
        denied();
      for (const [kind, checksum] of [
        ['content', live.snapshotChecksum],
        ['screenshot', live.screenshotChecksum],
      ] as const) {
        const [capture] =
          await tx`select o.id from allrice_managed_browser_evidence_artifacts a
          join allrice_storage_objects o on o.id=a.object_id and o.state='ready' and o.deleted_at is null
          where a.task_id=${live.browserTaskId} and a.kind=${kind} and o.checksum=${checksum}`;
        if (
          !capture ||
          !report.artifacts.some(
            (a) =>
              a.checksum === checksum &&
              a.kind === (kind === 'content' ? 'report' : 'screenshot'),
          )
        )
          denied();
      }
    } else if (['passed', 'assertion_failed'].includes(report.verdict)) {
      const [operation] =
        await tx`select snapshot from allrice_runtime_operations where id=${report.build!.operationId} and run_id=${check.runId}
        and organization_id=${check.organizationId} and workspace_id=${check.workspaceId}`;
      const physical = RuntimeOperationSnapshotSchema.safeParse(
        operation?.snapshot,
      );
      if (
        !physical.success ||
        physical.data.status !== 'succeeded' ||
        physical.data.binding.requestedBy.id !== check.ownerId ||
        physical.data.binding.execution.targetId !== report.build!.targetId
      )
        denied();
      const build = (
        await projectExecutionReport(
          {
            organizationId: check.organizationId,
            workspaceId: check.workspaceId,
            runId: check.runId,
            policySnapshot: { subjectId: check.ownerId },
          },
          report.project!,
          tx,
        )
      ).executions.find((e) => e.operationId === report.build!.operationId);
      if (
        !build ||
        build.status !== 'succeeded' ||
        build.location !== report.build!.location ||
        qualityDigest(build.project) !== qualityDigest(report.project) ||
        build.command.executable !== '/usr/local/bin/node' ||
        qualityDigest(build.command.args) !== qualityDigest(['build.mjs']) ||
        build.command.path !== '.' ||
        build.result?.exitCode !== 0 ||
        build.result.stopped !== true
      )
        denied();
      const [pageOrigin] =
        await tx`select provenance from allrice_workbench_artifacts where version_id=${report.artifacts.find((a) => a.kind === 'page')!.versionId} and run_id=${check.runId}`;
      if (pageOrigin?.provenance?.operationId !== report.build!.operationId)
        denied();
      const [browser] =
        await tx`select * from allrice_static_browser_verifications where id=${report.browser!.verificationId} and run_id=${check.runId}
        and job_id=${lease.jobId} and session_id=${check.sessionId} and owner_id=${check.ownerId} and organization_id=${check.organizationId} and workspace_id=${check.workspaceId}
        and state='completed' and job_attempt=${lease.attempt} and job_lease_token=${lease.leaseToken}`;
      const actual = BrowserVerificationOutcomeSchema.safeParse(
        browser?.outcome,
      );
      const page = report.artifacts.find((a) => a.kind === 'page'),
        screenshot = report.artifacts.find((a) => a.kind === 'screenshot');
      if (
        !actual.success ||
        qualityDigest(actual.data) !== qualityDigest(report.browser) ||
        qualityDigest(actual.data.plan) !== check.frozen.assertionDigest ||
        actual.data.report.target.versionId !== page?.versionId ||
        actual.data.report.target.checksum !== page.checksum ||
        browser?.screenshot_version_id !== screenshot?.versionId ||
        actual.data.screenshotChecksum !== screenshot?.checksum ||
        !report.artifacts.some(
          (a) =>
            a.versionId === browser?.report_version_id && a.kind === 'report',
        )
      )
        denied();
    }
    await tx`update allrice_platform_quality_checks set report=${tx.json(JSON.parse(JSON.stringify(report)))} where id=${check.id}`;
  });
}

export function mapPlatformQualityCheck(row: Record<string, unknown>) {
  const f = QualityFrozenSchema.parse(row.frozen);
  return QualityCheckSchema.parse({
    id: row.id,
    requestId: row.request_id,
    runId: row.run_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    caseId: f.caseId,
    variant: f.variant,
    status: row.status === 'claimed' ? 'queued' : row.status,
    environment: f.environment,
    releaseSha: f.releaseSha,
    fixtureDigest: f.fixtureDigest,
    assertionDigest: f.assertionDigest,
    runnerDigest: f.runnerDigest,
    fingerprint: f.fingerprint,
    employeeVersionId: f.employeeVersionId,
    employeeRevisionId: f.employeeRevisionId,
    modelUsed: false,
    accepted:
      row.status === 'succeeded' &&
      (row.report as { verdict?: unknown } | null)?.verdict === 'passed',
    createdAt: (row.created_at as Date).toISOString(),
    report: row.report ?? null,
  });
}
export async function listPlatformQualityChecks(context: RequestContext) {
  const owner = await requirePlatformAdmin(context);
  const rows =
    await getDatabase()`select q.*,j.status from allrice_platform_quality_checks q join allrice_jobs j on j.id=q.job_id
    where q.owner_id=${owner} order by q.created_at desc,q.id desc limit 20`;
  return rows.map(mapPlatformQualityCheck);
}
export async function getPlatformQualityCheck(
  context: RequestContext,
  id: string,
) {
  const owner = await requirePlatformAdmin(context);
  const [row] =
    await getDatabase()`select q.*,j.status from allrice_platform_quality_checks q join allrice_jobs j on j.id=q.job_id
    where q.id=${UuidSchema.parse(id)} and q.owner_id=${owner}`;
  if (!row) throw new DataAccessError('not_found');
  return mapPlatformQualityCheck(row);
}
/** Resolve the private service from persisted QA ownership. Neither an HTTP
 * caller nor a company context may supply a service/organization/workspace. */
export async function platformQualityServiceContext(
  context: RequestContext,
  id: string,
) {
  const check = await getPlatformQualityCheck(context, id);
  if (check.caseId !== 'project.live.v1')
    throw new DataAccessError('not_found');
  const services =
    await getDatabase()`select s.id,s.organization_id,s.workspace_id from allrice_project_services s
    join allrice_platform_quality_checks q on q.run_id=s.run_id and q.owner_id=s.owner_id
      and q.organization_id=s.organization_id and q.workspace_id=s.workspace_id
    where q.id=${check.id} and q.owner_id=${context.actor.id} order by s.id limit 2`;
  if (services.length !== 1) throw new DataAccessError('not_found');
  const service = services[0]!;
  return {
    serviceId: service.id as string,
    context: {
      ...context,
      organizationId: service.organization_id as string,
      workspaceId: service.workspace_id as string,
    },
  };
}
export async function createPlatformQualityCheck(
  context: RequestContext,
  raw: unknown,
  options: { scheduleOrigin?: QualityScheduleOrigin } = {},
) {
  const request = CreateQualityCheckSchema.parse(raw),
    owner = await requirePlatformAdmin(context),
    db = getDatabase();
  const origin =
    options.scheduleOrigin &&
    QualityScheduleOriginSchema.parse(options.scheduleOrigin);
  if (
    origin &&
    (request.caseId !== 'project.static.v1' ||
      request.variant !== 'correct' ||
      request.requestId !== qualityOccurrenceRequestId(origin.occurrenceId) ||
      origin.ownerId !== owner)
  )
    denied();
  const [existing] =
    await db`select * from allrice_platform_quality_checks where owner_id=${owner} and request_id=${request.requestId}`;
  if (existing) {
    if (
      existing.input_digest !== qualityDigest(request) ||
      (existing.automation_run_id ?? null) !== (origin?.occurrenceId ?? null) ||
      qualityDigest(existing.frozen.scheduleOrigin ?? null) !==
        qualityDigest(origin ?? null)
    )
      throw new QueueError('conflict');
    return getPlatformQualityCheck(context, existing.id);
  }
  if (request.caseId === 'project.live.v1') {
    if (request.variant !== 'correct' || !context.sessionId) denied();
    const [login] =
      await db`select id from allrice_sessions where id=${context.sessionId} and user_id=${owner} and revoked_at is null and expires_at>clock_timestamp()`;
    if (!login) denied();
  }
  const employee = await ensureQualityEmployee(context);
  const internalContext: RequestContext = {
    ...context,
    organizationId: employee.internal.organization_id,
    workspaceId: employee.internal.workspace_id,
    memberships: [
      {
        id: employee.internal.membership_id,
        organizationId: employee.internal.organization_id,
        workspaceId: employee.internal.workspace_id,
        userId: owner,
        active: true,
        role: employee.internal.role,
      },
    ],
  };
  const { cloudStableId } = await import('./cloud-execution.ts');
  const sessionId = cloudStableId(
      `quality-session:${owner}:${request.requestId}`,
    ),
    userMessageId = cloudStableId(`quality-user:${owner}:${request.requestId}`),
    assistantMessageId = cloudStableId(
      `quality-assistant:${owner}:${request.requestId}`,
    );
  await createChatSession(
    internalContext,
    {
      employeeAssignmentId: employee.assignmentId,
      title: '平台固定场景质检',
      workspaceId: internalContext.workspaceId,
    },
    { sessionId },
  );
  const text = `固定合成场景 ${request.caseId}；样例以本请求的冻结记录为准。无模型调用；仅执行受控项目与浏览器验证。${request.caseId === 'project.live.v1' ? ' 在云端执行。' : ''}`;
  await db.begin(async (tx) => {
    for (const [id, role, status, content] of [
      [userMessageId, 'user', 'completed', { text, citations: [] }],
      [assistantMessageId, 'assistant', 'pending', { text: '', citations: [] }],
    ] as const)
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,visibility,client_message_id,status)
        values(${id},${internalContext.organizationId},${internalContext.workspaceId},${sessionId},${owner},${role},${tx.json(content)},'private',${role === 'user' ? request.requestId : null},${status}) on conflict(id) do nothing`;
  });
  const binding = await prepareEmployeeRunBinding({
    context: internalContext,
    workspaceId: internalContext.workspaceId!,
    assignmentId: employee.assignmentId,
    employeeVersionId: employee.versionId,
    sessionId,
    userMessageId,
    assistantMessageId,
    promptSnapshot: {
      systemPrompt: '',
      conversation: [],
      memories: [],
      userRequest: text,
      imageAttachments: [],
      sessionReferences: [],
    },
  });
  binding.executionSnapshot.taskRuntimePolicy = resolveTaskRuntimePolicy([
    ...(binding.executionSnapshot.taskRuntimePolicy?.sources ?? []),
    {
      scope: 'platform_quality',
      scopeId: internalContext.workspaceId!,
      timeoutMs: 300000,
    },
  ]);
  const timeoutMs = binding.executionSnapshot.taskRuntimePolicy.timeoutMs;
  const frozenBase = {
    ...request,
    releaseSha: process.env.ALLRICE_RELEASE_SHA!,
    environment: technicalEnvironment(),
    fixtureDigest: qualityDigest(
      qualityCaseSpec(request.caseId, request.variant).files,
    ),
    assertionDigest: qualityDigest(
      qualityCaseSpec(request.caseId, request.variant).assertion,
    ),
    runnerDigest: qualityDigest(
      qualityCaseSpec(request.caseId, request.variant).runnerVersion,
    ),
    ...(request.caseId === 'project.live.v1'
      ? {
          loginSessionId: context.sessionId!,
          loginAuthenticatedAt: context.authenticatedAt,
        }
      : {}),
    employeeVersionId: employee.versionId,
    employeeRevisionId: employee.revisionId,
    assignmentId: employee.assignmentId,
    userMessageId,
    assistantMessageId,
    timeoutMs,
    ...(origin ? { scheduleOrigin: origin } : {}),
  };
  const frozen = QualityFrozenSchema.parse({
    ...frozenBase,
    fingerprint: fingerprint(frozenBase),
  });
  const qaBinding = QualityBindingSchema.parse({
    id: cloudStableId(`quality-check:${owner}:${request.requestId}`),
    inputDigest: qualityDigest(request),
    frozen,
  });
  const { enqueueRun } = await import('./execution/queue.ts');
  await enqueueRun(
    internalContext,
    {
      type: 'allrice.employee.run',
      workspaceId: internalContext.workspaceId,
      idempotencyKey: `platform-quality:${owner}:${request.requestId}`,
      input: {
        employeeAssignmentId: employee.assignmentId,
        employeeVersionId: employee.versionId,
        sessionId,
        userMessageId,
        assistantMessageId,
        qualityRequestId: request.requestId,
        qualityInputDigest: qaBinding.inputDigest,
      },
      maxAttempts: 1,
      timeoutMs,
    },
    {
      employeeBinding: binding,
      qualityBinding: qaBinding,
      conversationDelivery: {
        sessionId,
        userMessageId,
        assistantMessageId,
        clientUserMessageId: request.requestId,
        message: text,
        requestedMode: 'follow_up',
        hasAttachments: false,
      },
    },
  );
  const [record] =
    await db`select automation_run_id from allrice_platform_quality_checks where id=${qaBinding.id}`;
  if (
    !record ||
    (record.automation_run_id ?? null) !== (origin?.occurrenceId ?? null)
  )
    throw new QueueError('conflict');
  return getPlatformQualityCheck(context, qaBinding.id);
}
export async function cancelPlatformQualityCheck(
  context: RequestContext,
  id: string,
) {
  const q = await getPlatformQualityCheck(context, id),
    owner = await requirePlatformAdmin(context);
  if (!['queued', 'running'].includes(q.status)) return q;
  const [row] =
    await getDatabase()`select organization_id,workspace_id from allrice_platform_quality_checks where id=${q.id} and owner_id=${owner}`;
  if (!row) throw new DataAccessError('not_found');
  const { context: internal } = await getDatabase().begin((tx) =>
    resolvePlatformPreviewContext(
      tx,
      {
        environment: 'platform',
        workspaceId: row.workspace_id,
        ownerId: owner,
      },
      owner,
    ),
  );
  const { cancelRun } = await import('./execution/queue.ts');
  await cancelRun(
    {
      ...context,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      memberships: [
        {
          id: internal.membership_id,
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          userId: owner,
          active: true,
          role: internal.role,
        },
      ],
    },
    row.workspace_id,
    q.runId,
    { reason: 'platform_quality_user_requested' },
  );
  return getPlatformQualityCheck(context, id);
}

/** Current platform authority and the existing immutable, owner/session-bound file gate. */
export async function getPlatformQualityArtifact(
  context: RequestContext,
  id: string,
  artifactId: string,
) {
  const check = await getPlatformQualityCheck(context, id);
  if (!check.report?.artifacts.some((a) => a.artifactId === artifactId))
    throw new DataAccessError('not_found');
  const [row] =
    await getDatabase()`select organization_id,workspace_id from allrice_platform_quality_checks where id=${check.id} and owner_id=${context.actor.id}`;
  if (!row) throw new DataAccessError('not_found');
  return getWorkbenchArtifact(
    {
      ...context,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
    },
    check.sessionId,
    artifactId,
  );
}
export async function platformQualityCompletionAllowed(tx: Tx, job: JobRow) {
  if ((job.payload as { type?: unknown })?.type !== 'allrice.employee.run')
    return true;
  if (!(await qualitySchemaAvailable(tx))) return !hasQualityMarker(job);
  const [row] = await tx`select q.report,q.frozen from allrice_employee_runs e
      join allrice_platform_quality_deployments d on d.assignment_id=e.employee_assignment_id
      left join allrice_platform_quality_checks q on q.run_id=e.run_id and q.job_id=${job.id}
      where e.run_id=${job.run_id}`;
  if (!row) return !hasQualityMarker(job);
  if (!hasQualityMarker(job)) return false;
  const report = QualityCheckReportSchema.safeParse(row.report);
  return (
    report.success &&
    ['passed', 'assertion_failed'].includes(report.data.verdict) &&
    frozenValid(row.frozen)
  );
}
