import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  ExecutionContextSchema,
  PolicySnapshotSchema,
  authorizeExecution,
  projectSourceLimits,
  type ExecutionContext,
  type ProjectVersionRef,
  type RuntimeContentRef,
  type RuntimeSavedProjectSource,
  type RuntimeActionBinding,
  type StoragePort,
} from '@allrice/contracts';
import {
  ArtifactReviewError,
  assertPublishingRun,
  assertWorkbenchSession,
  readArtifact,
  readArtifactBytes,
} from './artifact-review.ts';
import {
  parseProjectSnapshotBytes,
  projectFail as fail,
  ProjectWorkspaceError,
} from './project-source.ts';

/** Shared exact private version lookup. Historical versions remain readable;
 * mutable heads are never substituted for an explicitly requested source. */
export async function readProjectSourceMetadata(
  tx: TransactionSql,
  ctx: ExecutionContext,
  source: RuntimeContentRef,
) {
  const principal = {
    actor: { type: 'user' as const, id: ctx.policySnapshot.subjectId },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
  };
  const [row] = await tx<
    {
      id: string;
      session_id: string;
      object_id: string;
      series_id: string;
      version: number;
    }[]
  >`
    select id,session_id,object_id,series_id,version from allrice_deliverable_versions
    where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId}
      and (${source.kind === 'storage_object'} and object_id=${source.id} or ${source.kind !== 'storage_object'} and id=${source.id}) for share`;
  if (!row) fail('snapshot_not_found');
  await assertWorkbenchSession(tx, principal, row.session_id, false, 'share');
  const [live] =
    await tx`select id from allrice_storage_objects where id=${row.object_id} and organization_id=${ctx.organizationId}
    and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId} and state='ready' and immutable
    and deleted_at is null and (retention_until is null or retention_until>clock_timestamp()) for share`;
  if (!live) fail('source_unavailable');
  const artifact = await readArtifact(tx, principal, row.session_id, row.id);
  if (
    !authorizeExecution(
      {
        type: 'storage_object',
        id: artifact.object.id,
        organizationId: artifact.object.organizationId,
        workspaceId: artifact.object.workspaceId,
        ownerId: artifact.object.ownerId,
        visibility: 'private',
        archivedAt: null,
      },
      'resource:read',
      ctx,
    ).allowed
  )
    fail('forbidden');
  if (
    artifact.kind !== 'document' ||
    artifact.object.mediaType !== 'application/json' ||
    !artifact.object.immutable ||
    artifact.object.checksum !== source.checksum
  )
    fail('source_changed');
  if (
    source.kind === 'deliverable_version' &&
    (source.objectId !== row.object_id ||
      source.seriesId !== row.series_id ||
      source.version !== row.version)
  )
    fail('source_changed');
  return artifact;
}
export async function readProjectSource(
  tx: TransactionSql,
  ctx: ExecutionContext,
  source: RuntimeContentRef,
  storage: StoragePort,
) {
  const artifact = await readProjectSourceMetadata(tx, ctx, source);
  const document = parseProjectSnapshotBytes(
    await readArtifactBytes(
      storage,
      artifact.object,
      projectSourceLimits.snapshotBytes,
    ),
  );
  return { artifact, document };
}

/** No quota/root acquisition here: execution already holds its ledger root.
 * Acquiring PR3a's publisher quota from that lock would invert lock order. */
export async function assertSavedProjectAuthority(
  tx: TransactionSql,
  ctx: ExecutionContext,
  sessionId: string,
  origin: RuntimeSavedProjectSource['origin'],
  project: ProjectVersionRef,
) {
  if (
    ctx.jobId !== origin.jobId ||
    ctx.worker.id !== origin.workerId ||
    !ctx.workspaceId ||
    Date.parse(ctx.policySnapshot.expiresAt) <= Date.now()
  )
    fail('run_unavailable');
  async function job() {
    const [lease] = await tx<
      { lease_token: string }[]
    >`select lease_token from allrice_jobs
      where id=${origin.jobId} and run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!}
        and owner_id=${ctx.policySnapshot.subjectId} and worker_id=${origin.workerId} and attempt=${origin.attempt}
        and status='running' and cancel_requested_at is null and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() for share`;
    if (
      !lease ||
      createHash('sha256').update(lease.lease_token).digest('hex') !==
        origin.leaseTokenDigest
    )
      fail('run_unavailable');
  }
  await job();
  await assertPublishingRun(tx, ctx, sessionId, 'workspace.project');
  await assertPublishingRun(tx, ctx, sessionId, 'local.process.execute');
  const [employee] = await tx`select a.id from allrice_employee_runs r
    join allrice_employee_assignments a on a.id=r.employee_assignment_id and a.organization_id=r.organization_id and a.workspace_id=r.workspace_id and a.user_id=r.owner_id and a.active
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id and e.status='active'
    join allrice_employee_versions v on v.id=r.employee_version_id and v.employee_id=e.id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    where r.run_id=${ctx.runId} and r.session_id=${sessionId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId!} and r.owner_id=${ctx.policySnapshot.subjectId}
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d where d.tenant_employee_id=e.id and d.organization_id=e.organization_id and d.workspace_id=e.workspace_id and not d.active)
    for share of r,a,e,v`;
  if (!employee) fail('run_unavailable');
  await assertWorkbenchSession(
    tx,
    {
      actor: { type: 'user', id: ctx.policySnapshot.subjectId },
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
    },
    sessionId,
    true,
    'share',
  );
  const [opened] =
    await tx`select project_id from allrice_project_workspace_heads where root_run_id=${ctx.runId} and project_id=${project.projectId}
    and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId} for share`;
  if (!opened) fail('project_not_open');
  const artifact = await readProjectSourceMetadata(tx, ctx, project.snapshot);
  // All lock waits precede the final time/lease and object retention checks.
  await job();
  const [live] =
    await tx`select id from allrice_storage_objects where id=${artifact.object.id} and state='ready' and immutable
    and checksum=${project.snapshot.checksum} and deleted_at is null and (retention_until is null or retention_until>clock_timestamp())`;
  if (!live || Date.parse(ctx.policySnapshot.expiresAt) <= Date.now())
    fail('source_unavailable');
  return artifact;
}

/** Reconstruct the originating context from the actual frozen policy and
 * immutable Worker provenance, never today's mutable employee definition. */
export async function savedProjectContext(
  tx: TransactionSql,
  binding: RuntimeActionBinding,
  source: RuntimeSavedProjectSource,
) {
  const [p] = await tx<
    {
      id: string;
      organization_id: string;
      subject_id: string;
      version: number;
      issued_at: Date;
      expires_at: Date;
      payload: { memberships?: unknown; grants?: unknown };
    }[]
  >`
    select id,organization_id,subject_id,version,issued_at,expires_at,payload from allrice_policy_snapshots
    where id=${binding.policy.snapshotId} and organization_id=${binding.task.scope.organizationId} and subject_id=${binding.requestedBy.id}`;
  if (!p) fail('run_unavailable');
  return ExecutionContextSchema.parse({
    executionId: binding.attempt.operationId,
    runId: binding.task.runId,
    jobId: source.origin.jobId,
    worker: { type: 'worker', id: source.origin.workerId },
    delegatedBy: binding.requestedBy,
    organizationId: binding.task.scope.organizationId,
    workspaceId: binding.task.scope.workspaceId,
    policySnapshot: PolicySnapshotSchema.parse({
      id: p.id,
      organizationId: p.organization_id,
      subjectId: p.subject_id,
      version: p.version,
      issuedAt: p.issued_at.toISOString(),
      expiresAt: p.expires_at.toISOString(),
      memberships: p.payload.memberships ?? [],
      grants: p.payload.grants ?? [],
    }),
    startedAt: p.issued_at.toISOString(),
  });
}

export function isProjectSourceAuthorityError(error: unknown) {
  return (
    error instanceof ArtifactReviewError ||
    error instanceof ProjectWorkspaceError
  );
}
