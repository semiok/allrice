import type { TransactionSql } from 'postgres';
import {
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  UuidSchema,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import {
  finalDeliveryRootIsLocked,
  finalDeliveryUnavailable,
} from './final-delivery-commit.ts';
import type { RunDeliveryAuthority } from './run-delivery-authority.ts';

/** Current ordinary-file ACL facts only. No read receipt or content identity is
 * inferred. The caller already holds current Run/lease/member authority locks. */
export async function readFinalDeliveryFileCitations(
  tx: TransactionSql,
  authority: RunDeliveryAuthority,
  requestedIds: readonly string[],
) {
  if (
    requestedIds.length > 1000 ||
    !finalDeliveryRootIsLocked(tx, authority.rootRunId)
  )
    return finalDeliveryUnavailable();
  const ids = [
    ...new Set(requestedIds.map((id) => UuidSchema.parse(id).toLowerCase())),
  ].sort();
  if (!ids.length) return [];
  const [row] =
    await tx`select r.owner_id,p.id,p.organization_id,p.subject_id,p.version,
      p.issued_at,p.expires_at,p.payload,e.execution_snapshot,j.claimed_at
    from allrice_runs r join allrice_jobs j on j.run_id=r.id
    join allrice_employee_runs e on e.run_id=r.id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id
    where r.id=${authority.rootRunId} and r.organization_id=${authority.scope.organizationId}
      and r.workspace_id=${authority.scope.workspaceId} and j.id=${authority.worker.jobId}`;
  if (!row) return finalDeliveryUnavailable();
  const frozen = EmployeeExecutionSnapshotSchema.parse(row.execution_snapshot);
  // Match the Worker tool selection: capability AND this Run's frozen tool
  // binding. Employee defaults must not restore a tool narrowed out of a Run.
  if (
    !frozen.capabilitySnapshot.grantedCapabilities.includes('storage:read') ||
    !frozen.capabilitySnapshot.bindings.toolNames.some(
      (name) =>
        name === 'workspace.file.read' || name === 'workspace.document.read',
    )
  )
    return [];
  // Same persisted policy and delegated principal used by startClaimedJob.
  // executionId is unused by the read ACL; this path never executes or audits a tool.
  const context = ExecutionContextSchema.parse({
    executionId: authority.worker.jobId,
    runId: authority.rootRunId,
    jobId: authority.worker.jobId,
    worker: { type: 'worker', id: authority.worker.workerId },
    delegatedBy: { type: 'user', id: row.owner_id },
    organizationId: authority.scope.organizationId,
    workspaceId: authority.scope.workspaceId,
    startedAt: row.claimed_at.toISOString(),
    policySnapshot: {
      id: row.id,
      organizationId: row.organization_id,
      subjectId: row.subject_id,
      version: row.version,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      memberships: row.payload.memberships ?? [],
      grants: row.payload.grants ?? [],
    },
  });
  const citations: { objectId: string; retentionUntil: string | null }[] = [];
  for (const id of ids) {
    // Lock the object before classifying it. FOR UPDATE also excludes a new
    // deliverable FK insertion until commit, so a citation cannot bypass the
    // existing artifact/version/quality checks through a classification race.
    const [object] =
      await tx`select id,retention_until from allrice_storage_objects
      where id=${id} and organization_id=${context.organizationId}
        and workspace_id=${context.workspaceId!} and state='ready' and deleted_at is null
        and (retention_until is null or retention_until>clock_timestamp()) for update`;
    if (!object) continue;
    const [special] = await tx`select 1 where
      exists(select 1 from allrice_deliverable_versions where object_id=${id})
      or exists(select 1 from allrice_company_asset_revisions where snapshot_object_id=${id})
      or exists(select 1 from allrice_knowledge_revisions where file_object_id=${id})
      or exists(select 1 from allrice_company_asset_materials where object_id=${id})
      or exists(select 1 from allrice_company_run_assets where material_object_id=${id})`;
    if (special) continue;
    try {
      // Exact shared gate used by workspace.file.read and document.read.
      const file = await getToolBrokerFile(context, id, tx);
      if (file.artifactVersionId !== null) continue;
      citations.push({
        objectId: file.object.id,
        retentionUntil: file.object.retentionUntil,
      });
    } catch (error) {
      if (
        !(error instanceof DataAccessError) ||
        !['authorization_denied', 'not_found'].includes(error.code)
      )
        throw error;
    }
  }
  return citations;
}
