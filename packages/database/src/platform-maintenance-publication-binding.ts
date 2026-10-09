import type postgres from 'postgres';
import type { ResourcePrincipal } from './resource-principal.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';
import {
  assertMaintenanceGrant,
  assertMaintenanceReconciliation,
} from './platform-maintenance-authority.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  MaintenanceRepositoryBindingSchema,
  type MaintenanceRepositoryBinding,
} from './platform-maintenance-publication-contracts.ts';
import { maintenancePublicationProvenance } from './platform-maintenance-provenance.ts';
import { readAcceptedRepositorySource } from './platform-repository-publication-authority.ts';

export async function bindMaintenanceRepositoryAction(
  tx: postgres.TransactionSql,
  context: ResourcePrincipal,
  runId: string,
  jobId: string,
  raw: MaintenanceRepositoryBinding,
) {
  const b = MaintenanceRepositoryBindingSchema.parse(raw),
    owner = context.actor.id;
  const g =
    b.request.action === 'publish'
      ? await assertMaintenanceGrant(tx, b.grantId, owner)
      : await assertMaintenanceReconciliation(tx, b.grantId, owner);
  if (
    g.row.frozen_digest !== b.grantDigest ||
    !g.frozen.githubBot ||
    technicalDigest(g.frozen.githubBot) !== technicalDigest(b.githubBot) ||
    b.request.credentialRevision !== b.githubBot.revision ||
    b.inputDigest !== technicalDigest(b.request) ||
    b.timeoutMs !== (b.request.action === 'publish' ? 120000 : 30000)
  )
    throw new DataAccessError('authorization_denied');
  const [a] =
    await tx`select * from allrice_platform_maintenance_attempts where id=${b.attemptId} and primary_grant_id=${b.grantId} for update`;
  if (
    !a ||
    a.repair_task_id !== b.source.repairTaskId ||
    a.defect_id !== g.frozen.defectId
  )
    throw new DataAccessError('authorization_denied');
  const source = await readAcceptedRepositorySource(
    tx,
    context,
    a.repair_task_id,
    b.request.action === 'publish'
      ? (process.env.ALLRICE_RELEASE_SHA ?? '')
      : b.source.baseSha,
  );
  if (
    source.version !== 2 ||
    source.maintenance.grantId !== b.grantId ||
    source.maintenance.grantDigest !== b.grantDigest ||
    source.maintenance.attemptId !== b.attemptId ||
    technicalDigest(source) !== technicalDigest(b.source)
  )
    throw new QueueError('conflict');
  const provenance = maintenancePublicationProvenance(
    b.grantId,
    b.grantDigest,
    b.attemptId,
    g.frozen,
    b.githubBot,
  );
  const [existing] =
    await tx`select * from allrice_platform_repository_publications where id=${b.publicationId} for update`;
  if (existing) {
    if (
      existing.owner_id !== owner ||
      existing.source_digest !== technicalDigest(source) ||
      technicalDigest(existing.provenance) !== technicalDigest(provenance) ||
      a.publication_id !== existing.id
    )
      throw new QueueError('conflict');
  } else {
    if (b.request.action !== 'publish' || a.publication_id)
      throw new DataAccessError('not_found');
    await tx`insert into allrice_platform_repository_publications(id,owner_id,organization_id,workspace_id,source_task_id,base_sha,after_checksum,source,source_digest,provenance) values(${b.publicationId},${owner},${context.organizationId},${context.workspaceId!},${source.repairTaskId},${source.baseSha},${source.afterChecksum},${tx.json(source)},${technicalDigest(source)},${tx.json(provenance)})`;
    await tx`update allrice_platform_maintenance_attempts set publication_id=${b.publicationId} where id=${a.id}`;
    await tx`update allrice_platform_maintenance_grants set publication_id=${b.publicationId} where id=${b.grantId}`;
  }
  if (
    b.request.action === 'inspect' &&
    b.request.publicationId !== b.publicationId
  )
    throw new QueueError('conflict');
  if (
    (
      await tx`select a.id from allrice_platform_repository_actions a join allrice_jobs j on j.id=a.job_id where a.publication_id=${b.publicationId} and j.status in ('queued','claimed','running')`
    ).length
  )
    throw new QueueError('conflict');
  await tx`insert into allrice_platform_repository_actions(id,publication_id,owner_id,request_id,request,input_digest,credential_revision,mode,timeout_ms,run_id,job_id,authority_version,maintenance_grant_id) values(${b.id},${b.publicationId},${owner},${b.request.requestId},${tx.json(b.request)},${b.inputDigest},${b.githubBot.revision},${b.request.action},${b.timeoutMs},${runId},${jobId},2,${b.grantId})`;
}
