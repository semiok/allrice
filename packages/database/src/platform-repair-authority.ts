import type { ResourcePrincipal } from './resource-principal.ts';
import { cloudStableId } from './cloud-execution.ts';
import { MaintenanceRepairPlanSchema } from './platform-maintenance-authority-contracts.ts';
import { assertMaintenanceGrant } from './platform-maintenance-authority.ts';
import { maintenanceVerificationHarnessChecksum } from './platform-maintenance-profile.ts';
import type postgres from 'postgres';
import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import { isPlatformAdmin, requirePlatformAdmin } from './platform-authority.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  CreateRepairTaskSchema,
  RepositoryBaselineSchema,
  RepairReportSchema,
  RepositoryCandidateSchema,
} from './platform-repair-contracts.ts';
import { repairHarnessChecksumFor } from './platform-repair-profile.ts';
import {
  repositoryCandidate,
  repositoryDigest,
} from './platform-repository-source.ts';
import { repairTemplateSlot } from './platform-repair-template.ts';
import { getDatabase } from './core/client.ts';
import type { JobRow } from './queue/row-mappers.ts';
import { QueueError } from './execution/queue.ts';

type Tx = postgres.TransactionSql;
const RepairFrozenFields = CreateRepairTaskSchema.extend({
  baseline: RepositoryBaselineSchema,
  baselineText: z.string().min(1).max(50000),
  harnessChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  releaseSha: z.string().regex(/^[a-f0-9]{40}$/),
  assignmentId: UuidSchema,
  employeeVersionId: UuidSchema,
  employeeRevisionId: UuidSchema,
  userMessageId: UuidSchema,
  assistantMessageId: UuidSchema,

  timeoutMs: z.number().int().min(1000).max(7200000),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  reuseSeed: z
    .object({
      sourceTaskId: UuidSchema,
      sourceCandidateChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      sourceReportDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      beforeChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      afterChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      afterBase64: z.string().min(1).max(66668),
    })
    .strict()
    .optional(),
}).strict();
export const RepairFrozenSchema = z.discriminatedUnion('version', [
  RepairFrozenFields.extend({
    timeoutMs: z.number().int().min(1000).max(1800000),
    version: z.literal(1),
    loginSessionId: UuidSchema,
    loginAuthenticatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  RepairFrozenFields.extend({
    version: z.literal(2),
    maintenance: z
      .object({
        grantId: UuidSchema,
        grantDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        attemptId: UuidSchema,
        verificationPlan: MaintenanceRepairPlanSchema,
        verificationPlanDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        maxCandidateRevisions: z.number().int().min(1).max(3),
        maxOutputTokens: z.number().int().min(1000).max(100000),
        outputBudgetMode: z.literal('observed_threshold'),
        maxModelCalls: z.literal(16),
      })
      .strict(),
  }).strict(),
]);
export function repairBrowserContext(f: z.infer<typeof RepairFrozenSchema>) {
  return f.version === 1
    ? { sessionId: f.loginSessionId, authenticatedAt: f.loginAuthenticatedAt }
    : {};
}
export const RepairBindingSchema = z
  .object({
    id: UuidSchema,
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    frozen: RepairFrozenSchema,
  })
  .strict();
export type RepairBinding = z.infer<typeof RepairBindingSchema>;
export type RepairLease = {
  workerId: string;
  jobId: string;
  leaseToken: string;
  attempt: number;
};
export function repairFrozenValid(raw: unknown) {
  const parsed = RepairFrozenSchema.safeParse(raw);
  if (!parsed.success) return false;
  const { fingerprint, ...fields } = parsed.data;
  if (
    fields.version === 2 &&
    (fields.verificationMode !== 'compiled_packages' ||
      fields.reuseSeed ||
      fields.reuseAcceptedTaskId ||
      fields.maintenance.verificationPlanDigest !==
        technicalDigest(fields.maintenance.verificationPlan) ||
      fields.maintenance.verificationPlan.harnessChecksum !==
        fields.harnessChecksum ||
      fields.maintenance.verificationPlan.approvedFiles.length !== 1 ||
      fields.maintenance.verificationPlan.approvedFiles[0]?.beforeChecksum !==
        repositoryDigest(fields.baselineText))
  )
    return false;
  if (fields.reuseAcceptedTaskId) {
    const seed = fields.reuseSeed;
    if (
      fields.verificationMode !== 'compiled_packages' ||
      !seed ||
      seed.sourceTaskId !== fields.reuseAcceptedTaskId ||
      seed.beforeChecksum !== repositoryDigest(fields.baselineText)
    )
      return false;
    const bytes = Buffer.from(seed.afterBase64, 'base64');
    if (
      bytes.toString('base64') !== seed.afterBase64 ||
      repositoryDigest(bytes) !== seed.afterChecksum ||
      bytes.length > 50000
    )
      return false;
    try {
      repairTemplateSlot(
        fields.baselineText,
        new TextDecoder('utf8', { fatal: true }).decode(bytes),
      );
    } catch {
      return false;
    }
  } else if (fields.reuseSeed) return false;
  if (
    fields.verificationMode === 'compiled_packages' &&
    (!fields.baseline.compiledDependencies ||
      fields.baseline.compiledDependencies.rootLockChecksum !==
        fields.baseline.rootLockChecksum ||
      fields.baseline.compiledDependencies.dependencyConfigurationDigest !==
        fields.baseline.dependencyConfigurationDigest)
  )
    return false;
  return (
    fingerprint === technicalDigest(fields) &&
    fields.baselineId === fields.baseline.id &&
    fields.harnessChecksum ===
      (fields.version === 2
        ? maintenanceVerificationHarnessChecksum
        : repairHarnessChecksumFor(
            fields.verificationMode === 'compiled_packages',
          )) &&
    fields.releaseSha === fields.baseline.sourceSha
  );
}
export interface RepairTaskRow {
  id: string;
  request_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  job_id: string;
  session_id: string;
  input_digest: string;
  frozen: unknown;
  candidate: unknown;
  input_object_id: string | null;
  dependency_object_id: string | null;
  report: unknown | null;
  created_at: Date;
}
export function hasRepairMarker(job: JobRow) {
  const input = (job.payload as { input?: Record<string, unknown> }).input;
  return (
    !!input &&
    (Object.hasOwn(input, 'repairRequestId') ||
      Object.hasOwn(input, 'repairInputDigest'))
  );
}
export async function repairSchemaAvailable(tx: Tx) {
  const [row] =
    await tx`select to_regclass(format('%I.allrice_platform_repair_tasks',current_schema())) is not null tasks,
    to_regclass(format('%I.allrice_platform_repair_candidates',current_schema())) is not null candidates,
    to_regclass(format('%I.allrice_platform_repair_verifications',current_schema())) is not null verifications`;
  if (row?.tasks && row.candidates && row.verifications) return true;
  if (row?.tasks || row?.candidates || row?.verifications)
    throw new DataAccessError('authorization_denied');
  const [m] =
    await tx`select to_regclass(format('%I.allrice_schema_migrations',current_schema())) is not null available`;
  if (
    m?.available &&
    (
      await tx`select 1 from allrice_schema_migrations where name='0143_platform_repository_repair.sql'`
    ).length
  )
    throw new DataAccessError('authorization_denied');
  return false;
}
async function admitMaintenanceRepairGrant(
  tx: Tx,
  owner: string,
  b: RepairBinding,
  existingTaskId?: string,
) {
  if (b.frozen.version !== 2) throw new DataAccessError('authorization_denied');
  const f = b.frozen,
    m = f.maintenance,
    authority = await assertMaintenanceGrant(tx, m.grantId, owner);
  const [attempt] =
    await tx`select a.*,l.grant_id from allrice_platform_maintenance_attempts a join allrice_platform_maintenance_grant_attempts l on l.attempt_id=a.id where a.id=${m.attemptId} and l.grant_id=${m.grantId} for update of a`;
  if (
    !attempt ||
    attempt.primary_grant_id !== m.grantId ||
    authority.row.frozen_digest !== m.grantDigest ||
    technicalDigest(f.baseline) !==
      technicalDigest(authority.frozen.baseline) ||
    technicalDigest(m.verificationPlan) !==
      technicalDigest(authority.frozen.verificationPlan) ||
    m.verificationPlanDigest !== authority.frozen.verificationPlanDigest ||
    m.maxCandidateRevisions !== authority.frozen.maxCandidateRevisions ||
    m.maxOutputTokens !== authority.frozen.maxOutputTokens ||
    m.outputBudgetMode !== authority.frozen.outputBudgetMode ||
    m.maxModelCalls !== authority.frozen.maxModelCalls ||
    f.timeoutMs > authority.frozen.repairTimeoutMs ||
    b.id !== cloudStableId('maintenance-repair:' + m.attemptId) ||
    f.requestId !==
      cloudStableId('maintenance-repair-request:' + m.attemptId) ||
    (existingTaskId
      ? attempt.repair_task_id !== existingTaskId ||
        authority.row.repair_task_id !== existingTaskId
      : !!attempt.repair_task_id || !!authority.row.repair_task_id)
  )
    throw new DataAccessError('authorization_denied');
  if (!existingTaskId) {
    const active =
      await tx`select q.id from allrice_platform_repair_tasks q join allrice_jobs j on j.id=q.job_id where j.status in ('queued','claimed','running','waiting_approval') limit 1`;
    if (active.length) throw new QueueError('conflict');
  }
  // Locks may have waited past the grant's wall expiry. Re-read DB time at
  // the final authority boundary, after attempt and global admission locks.
  const [now] = await tx<{ at: Date }[]>`select clock_timestamp() at`;
  if (authority.row.expires_at <= now!.at)
    throw new DataAccessError('authorization_denied');
  return authority;
}
export async function admitPlatformRepairBinding(
  tx: Tx,
  context: ResourcePrincipal,
  assignmentId: string,
  raw: RepairBinding,
) {
  const b = RepairBindingSchema.parse(raw);
  if (b.frozen.version === 2)
    await tx`select pg_advisory_xact_lock(hashtext('allrice-central-maintenance-repair'))`;
  if (
    b.frozen.version === 1 &&
    (!('sessionId' in context) || context.sessionId !== b.frozen.loginSessionId)
  )
    throw new DataAccessError('authorization_denied');
  if (!(await repairSchemaAvailable(tx)) || !repairFrozenValid(b.frozen))
    throw new DataAccessError('authorization_denied');
  const owner = await requirePlatformAdmin(context, tx);
  await resolvePlatformPreviewContext(
    tx,
    {
      environment: 'platform',
      workspaceId: context.workspaceId,
      ownerId: owner,
    },
    owner,
  );
  const [d] =
    await tx`select * from allrice_platform_quality_deployments where assignment_id=${assignmentId} for share`;
  const login =
    b.frozen.version === 1
      ? (
          await tx`select id from allrice_sessions where id=${b.frozen.loginSessionId} and user_id=${owner} and revoked_at is null and expires_at>clock_timestamp() for share`
        )[0]
      : await admitMaintenanceRepairGrant(tx, owner, b);
  if (
    !d ||
    !login ||
    d.owner_id !== owner ||
    d.organization_id !== context.organizationId ||
    d.workspace_id !== context.workspaceId ||
    assignmentId !== b.frozen.assignmentId ||
    d.employee_version_id !== b.frozen.employeeVersionId ||
    d.employee_revision_id !== b.frozen.employeeRevisionId ||
    b.inputDigest !==
      technicalDigest(
        CreateRepairTaskSchema.parse({
          requestId: b.frozen.requestId,
          baselineId: b.frozen.baselineId,
          ...(b.frozen.verificationMode
            ? { verificationMode: b.frozen.verificationMode }
            : {}),
          ...(b.frozen.reuseAcceptedTaskId
            ? { reuseAcceptedTaskId: b.frozen.reuseAcceptedTaskId }
            : {}),
        }),
      )
  )
    throw new DataAccessError('authorization_denied');
  if (b.frozen.reuseSeed) {
    const seed = b.frozen.reuseSeed;
    const [source] =
      await tx`select q.*,j.status from allrice_platform_repair_tasks q join allrice_jobs j on j.id=q.job_id
      where q.id=${seed.sourceTaskId} and q.owner_id=${owner} and q.organization_id=${context.organizationId} and q.workspace_id=${context.workspaceId!} for share of q,j`;
    if (!source || source.status !== 'succeeded' || !source.report)
      throw new DataAccessError('authorization_denied');
    const candidate = RepositoryCandidateSchema.parse(source.candidate),
      report = RepairReportSchema.parse(source.report),
      old = RepairFrozenSchema.parse(source.frozen);
    if (
      candidate.checksum !== seed.sourceCandidateChecksum ||
      report.candidateChecksum !== candidate.checksum ||
      technicalDigest(report) !== seed.sourceReportDigest ||
      candidate.files[0]?.beforeChecksum !== seed.beforeChecksum ||
      candidate.files[0]?.afterBase64 !== seed.afterBase64 ||
      old.baseline.rootLockChecksum !== b.frozen.baseline.rootLockChecksum ||
      old.baseline.dependencyConfigurationDigest !==
        b.frozen.baseline.dependencyConfigurationDigest
    )
      throw new DataAccessError('authorization_denied');
  }
}
export async function bindPlatformRepairTask(
  tx: Tx,
  context: ResourcePrincipal,
  runId: string,
  jobId: string,
  sessionId: string,
  raw: RepairBinding,
) {
  const b = RepairBindingSchema.parse(raw);
  await admitPlatformRepairBinding(tx, context, b.frozen.assignmentId, b);
  const candidate = repositoryCandidate(0, []);
  await tx`insert into allrice_platform_repair_tasks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen,candidate)
    values(${b.id},${b.frozen.requestId},${context.organizationId},${context.workspaceId!},${context.actor.id},${runId},${jobId},${sessionId},${b.inputDigest},${tx.json(b.frozen)},${tx.json(candidate)})`;
  await tx`insert into allrice_platform_repair_candidates(task_id,revision,checksum,candidate,call_id,arguments_digest)
    values(${b.id},0,${candidate.checksum},${tx.json(candidate)},'baseline',${technicalDigest(null)})`;
  if (b.frozen.version === 2) {
    const m = b.frozen.maintenance;
    await tx`update allrice_platform_maintenance_attempts set repair_task_id=${b.id} where id=${m.attemptId} and primary_grant_id=${m.grantId} and repair_task_id is null`;
    await tx`update allrice_platform_maintenance_grants set repair_task_id=${b.id} where id=${m.grantId} and repair_task_id is null`;
  }
}
export async function assertExistingRepairBinding(
  tx: Tx,
  context: ResourcePrincipal,
  runId: string,
  b: RepairBinding,
) {
  const [row] =
    await tx`select * from allrice_platform_repair_tasks where run_id=${runId} and owner_id=${context.actor.id}`;
  if (
    !row ||
    row.id !== b.id ||
    row.input_digest !== b.inputDigest ||
    !repairFrozenValid(row.frozen) ||
    row.frozen.fingerprint !== b.frozen.fingerprint
  )
    throw new QueueError('conflict');
  if (b.frozen.version === 2)
    await admitMaintenanceRepairGrant(tx, context.actor.id, b, b.id);
}
/** Called only for the reserved private Employee Run. Public chat cannot add markers. */
export async function isPlatformRepairJobAuthorized(tx: Tx, job: JobRow) {
  if (!hasRepairMarker(job) || !(await repairSchemaAvailable(tx))) return false;
  const [q] =
    await tx`select q.*,d.assignment_id,d.owner_id deployment_owner,e.employee_assignment_id,e.employee_version_id,
    e.session_id employee_session,r.input run_input,a.active assignment_active,emp.status employee_status,e.execution_snapshot,
    s.archived_at session_archived,o.archived_at organization_archived,w.archived_at workspace_archived,
    pa.active deployment_active,a.selection_mode,d.employee_version_id current_version,d.employee_revision_id current_revision,
    exists(select 1 from allrice_memberships m where m.user_id=q.owner_id and m.organization_id=q.organization_id and m.active and (m.workspace_id is null or m.workspace_id=q.workspace_id)) member_active,
    exists(select 1 from allrice_sessions l where l.id=(q.frozen->>'loginSessionId')::uuid and l.user_id=q.owner_id and l.revoked_at is null and l.expires_at>clock_timestamp()) login_active
    from allrice_platform_repair_tasks q
    join allrice_employee_runs e on e.run_id=q.run_id and e.organization_id=q.organization_id and e.workspace_id=q.workspace_id and e.owner_id=q.owner_id
    join allrice_runs r on r.id=e.run_id
    join allrice_platform_quality_deployments d on d.assignment_id=e.employee_assignment_id and d.workspace_id=q.workspace_id and d.organization_id=q.organization_id
    join allrice_employee_assignments a on a.id=d.assignment_id and a.user_id=q.owner_id and a.workspace_id=q.workspace_id and a.organization_id=q.organization_id
    join allrice_employees emp on emp.id=a.employee_id and emp.id=d.employee_id
    join allrice_platform_employee_tenant_assignments pa on pa.tenant_employee_id=emp.id and pa.workspace_id=q.workspace_id
    join allrice_chat_sessions s on s.id=q.session_id and s.owner_id=q.owner_id and s.organization_id=q.organization_id and s.workspace_id=q.workspace_id
    join allrice_organizations o on o.id=q.organization_id and o.slug='allrice-platform'
    join allrice_workspaces w on w.id=q.workspace_id and w.organization_id=q.organization_id and w.slug='employee-tests-'||q.owner_id::text
    where q.run_id=${job.run_id} for share of d,a,emp,pa,o,w`;
  if (!q || !repairFrozenValid(q.frozen)) return false;
  const f = RepairFrozenSchema.parse(q.frozen),
    input = (job.payload as { input?: Record<string, unknown> }).input;
  // Keep revocation/revision changes serialized with the caller's publication
  // transaction; mere membership/cloud grant validity cannot replace a login.
  let login;
  try {
    login =
      f.version === 1
        ? (
            await tx`select id from allrice_sessions where id=${f.loginSessionId}
    and user_id=${job.owner_id} and revoked_at is null and expires_at>clock_timestamp() for share`
          )[0]
        : await admitMaintenanceRepairGrant(
            tx,
            job.owner_id,
            { id: q.id, inputDigest: q.input_digest, frozen: f },
            q.id,
          );
  } catch (error) {
    if (error instanceof DataAccessError) return false;
    throw error;
  }
  const members =
    await tx`select user_id from allrice_memberships where user_id=${job.owner_id}
    and organization_id=${job.organization_id} and active and (workspace_id is null or workspace_id=${job.workspace_id}) for share`;
  return (
    !!login &&
    members.length > 0 &&
    !!input &&
    !Object.hasOwn(input, 'qualityRequestId') &&
    !Object.hasOwn(input, 'qualityInputDigest') &&
    q.job_id === job.id &&
    q.owner_id === job.owner_id &&
    q.deployment_owner === job.owner_id &&
    q.organization_id === job.organization_id &&
    q.workspace_id === job.workspace_id &&
    q.employee_session === q.session_id &&
    q.employee_version_id === f.employeeVersionId &&
    q.current_version === f.employeeVersionId &&
    q.current_revision === f.employeeRevisionId &&
    q.employee_assignment_id === f.assignmentId &&
    job.max_attempts === 1 &&
    q.assignment_active &&
    q.employee_status === 'active' &&
    q.deployment_active &&
    q.member_active &&
    (f.version === 2 || q.login_active) &&
    q.selection_mode !== 'exclude' &&
    !q.session_archived &&
    !q.organization_archived &&
    !q.workspace_archived &&
    q.execution_snapshot?.taskRuntimePolicy?.timeoutMs === f.timeoutMs &&
    (f.version === 1 ||
      q.execution_snapshot?.taskRuntimePolicy?.authorizationExpiresAt ===
        login.frozen.expiresAt) &&
    new Date(q.created_at).getTime() + f.timeoutMs > Date.now() &&
    input.repairRequestId === q.request_id &&
    input.repairInputDigest === q.input_digest &&
    input.sessionId === q.session_id &&
    input.employeeAssignmentId === f.assignmentId &&
    input.employeeVersionId === f.employeeVersionId &&
    input.userMessageId === f.userMessageId &&
    input.assistantMessageId === f.assistantMessageId &&
    technicalDigest(input) === technicalDigest(q.run_input) &&
    (await isPlatformAdmin({ actor: { type: 'user', id: job.owner_id } }, tx))
  );
}
export async function assertPlatformRepairLease(tx: Tx, lease: RepairLease) {
  const [job] = await tx<
    JobRow[]
  >`select * from allrice_jobs where id=${UuidSchema.parse(lease.jobId)} for share`;
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
    !(await isPlatformRepairJobAuthorized(tx, job))
  )
    throw new DataAccessError('authorization_denied');
  const [live] = await tx`select id from allrice_jobs where id=${job.id}
    and status='running' and cancel_requested_at is null
    and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp()`;
  if (!live) throw new DataAccessError('authorization_denied');
  return job;
}
export async function getPlatformRepairExecution(lease: RepairLease) {
  return getDatabase().begin(async (tx) => {
    const job = await assertPlatformRepairLease(tx, lease);
    const [q] = await tx<
      RepairTaskRow[]
    >`select * from allrice_platform_repair_tasks where run_id=${job.run_id}`;
    if (!q) throw new DataAccessError('not_found');
    return { ...q, frozen: RepairFrozenSchema.parse(q.frozen) };
  });
}
