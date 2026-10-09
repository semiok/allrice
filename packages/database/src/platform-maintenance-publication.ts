import { randomUUID } from 'node:crypto';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { cloudStableId } from './cloud-execution.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  assertMaintenanceGrant,
  assertMaintenanceReconciliation,
} from './platform-maintenance-authority.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { readAcceptedRepositorySource } from './platform-repository-publication-authority.ts';
import { enqueueMaintenanceRepositoryRun } from './execution/queue.ts';
import { MaintenanceRepositoryBindingSchema } from './platform-maintenance-publication-contracts.ts';
import {
  RepositoryPublicationRequestSchema,
  repositoryPublicationJobType,
} from './platform-repository-publication-contracts.ts';

/** Background/controller entry. No GitHub IO and no invented browser login. */
export async function startMaintenancePublication(
  grantId: string,
  action: 'publish' | 'inspect' = 'publish',
  requestId?: string,
) {
  const db = getDatabase();
  const data = await db.begin(async (tx) => {
    const [lookup] =
      await tx`select issuer_id from allrice_platform_maintenance_grants where id=${UuidSchema.parse(grantId)}`;
    if (!lookup) throw new DataAccessError('not_found');
    const owner = lookup.issuer_id as string;
    const g =
      action === 'publish'
        ? await assertMaintenanceGrant(tx, grantId, owner)
        : await assertMaintenanceReconciliation(tx, grantId, owner);
    const [a] =
      await tx`select a.* from allrice_platform_maintenance_attempts a join allrice_platform_maintenance_grant_attempts l on l.attempt_id=a.id where l.grant_id=${grantId}`;
    if (
      !a ||
      a.primary_grant_id !== grantId ||
      !a.repair_task_id ||
      !g.frozen.githubBot
    )
      throw new DataAccessError('grant_invalid');
    const { context: c } = await resolvePlatformPreviewContext(
      tx,
      { environment: 'platform', ownerId: owner, workspaceId: null },
      owner,
    );
    const principal = {
      requestId: requestId ?? randomUUID(),
      actor: { type: 'user' as const, id: owner },
      organizationId: c.organization_id,
      workspaceId: c.workspace_id,
      memberships: [
        {
          id: c.membership_id,
          organizationId: c.organization_id,
          workspaceId: c.workspace_id,
          userId: owner,
          role: c.role,
          active: true,
        },
      ],
    };
    const source = await readAcceptedRepositorySource(
      tx,
      principal,
      a.repair_task_id,
      action === 'publish'
        ? (process.env.ALLRICE_RELEASE_SHA ?? '')
        : g.frozen.baseline.sourceSha,
    );
    const publicationId = cloudStableId('maintenance-publication:' + a.id);
    if (action === 'inspect' && a.publication_id !== publicationId)
      throw new DataAccessError('not_found');
    const request = RepositoryPublicationRequestSchema.parse({
      action,
      requestId:
        action === 'publish'
          ? cloudStableId('maintenance-publication-request:' + a.id)
          : UuidSchema.parse(requestId ?? randomUUID()),
      ...(action === 'publish'
        ? { repairTaskId: a.repair_task_id }
        : { publicationId }),
      credentialRevision: g.frozen.githubBot.revision,
    });
    return {
      owner,
      workspaceId: c.workspace_id,
      binding: MaintenanceRepositoryBindingSchema.parse({
        version: 2,
        id: cloudStableId('maintenance-repository-action:' + request.requestId),
        publicationId,
        source,
        request,
        inputDigest: technicalDigest(request),
        grantId,
        grantDigest: g.row.frozen_digest,
        attemptId: a.id,
        githubBot: g.frozen.githubBot,
        timeoutMs: action === 'publish' ? 120000 : 30000,
      }),
    };
  });
  const b = data.binding;
  const result = await enqueueMaintenanceRepositoryRun(
    {
      type: repositoryPublicationJobType,
      workspaceId: data.workspaceId,
      idempotencyKey:
        'platform-repository:' + data.owner + ':' + b.request.requestId,
      maxAttempts: 1,
      timeoutMs: b.timeoutMs,
      input: { requestId: b.request.requestId, inputDigest: b.inputDigest },
    },
    b,
  );
  return {
    publicationId: b.publicationId,
    runId: result.run.id,
    created: result.created,
  };
}
