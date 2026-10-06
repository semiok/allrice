import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@allrice/contracts';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  enqueueRun,
  QueueError,
  requestRunCancellationTransaction,
} from './execution/queue.ts';
import { readAcceptedRepositorySource } from './platform-repository-publication-authority.ts';
import { platformRepository } from './platform-repository-credential-contracts.ts';
import {
  RepositoryPublicationRequestSchema,
  RepositoryPublicationSchema,
  RepositoryPublicationSourceSchema,
  RepositoryPublicationSteps,
  repositoryPublicationJobType,
} from './platform-repository-publication-contracts.ts';

export const emptyRepositoryCi = () => ({
  state: 'not_observed' as const,
  observedAt: null,
  workflowRunId: null,
  runAttempt: null,
  headSha: null,
  checkoutSha: null,
  checkoutTree: null,
  materialDigest: null,
  checks: [],
});
export async function platformRepositoryContext(
  context: RequestContext,
  provision = false,
): Promise<RequestContext> {
  const owner = await requirePlatformAdmin(context);
  const { context: p } = await getDatabase().begin((tx) =>
    resolvePlatformPreviewContext(
      tx,
      { environment: 'platform', ownerId: owner, workspaceId: null },
      owner,
      provision,
    ),
  );
  return {
    ...context,
    organizationId: p.organization_id,
    workspaceId: p.workspace_id,
    memberships: [
      {
        id: p.membership_id,
        organizationId: p.organization_id,
        workspaceId: p.workspace_id,
        userId: owner,
        role: p.role,
        active: true,
      },
    ],
  };
}
const internalContext = platformRepositoryContext;
export async function getPlatformRepositoryPublication(
  context: RequestContext,
  id: string,
) {
  const owner = await requirePlatformAdmin(context),
    sql = getDatabase();
  const [p] =
    await sql`select * from allrice_platform_repository_publications where id=${UuidSchema.parse(id)} and owner_id=${owner}`;
  if (!p) throw new DataAccessError('not_found');
  const source = RepositoryPublicationSourceSchema.parse(p.source);
  const actions =
    await sql`select a.*,j.status,j.last_error_code from allrice_platform_repository_actions a
    join allrice_jobs j on j.id=a.job_id and j.run_id=a.run_id and j.owner_id=a.owner_id
    where a.publication_id=${id} and a.owner_id=${owner} order by a.created_at desc,a.id desc limit 20`;
  return RepositoryPublicationSchema.parse({
    id: p.id,
    repositoryId: platformRepository.id,
    repository: platformRepository.fullName,
    repairTaskId: p.source_task_id,
    baseSha: p.base_sha,
    candidateChecksum: source.candidateChecksum,
    revision: p.revision,
    branch: `allrice/repairs/${p.id}`,
    steps: RepositoryPublicationSteps.map((step) => ({
      step,
      state: p.steps[step]?.state ?? 'not_started',
    })),
    remote: p.remote,
    ci: p.ci ?? emptyRepositoryCi(),
    createdAt: p.created_at.toISOString(),
    actions: actions.map((a) => ({
      id: a.id,
      requestId: a.request_id,
      action: a.mode,
      runId: a.run_id,
      jobId: a.job_id,
      status:
        a.status === 'claimed'
          ? 'running'
          : a.status === 'dead_letter'
            ? 'failed'
            : a.status,
      errorCode: a.last_error_code ?? null,
      createdAt: a.created_at.toISOString(),
    })),
  });
}
export async function listPlatformRepositoryPublications(
  context: RequestContext,
) {
  const owner = await requirePlatformAdmin(context);
  const rows =
    await getDatabase()`select id from allrice_platform_repository_publications where owner_id=${owner} order by created_at desc,id desc limit 50`;
  return Promise.all(
    rows.map((p) => getPlatformRepositoryPublication(context, p.id)),
  );
}
export async function findPlatformRepositoryPublication(
  context: RequestContext,
  requestId: string,
) {
  const owner = await requirePlatformAdmin(context);
  const [a] =
    await getDatabase()`select publication_id from allrice_platform_repository_actions where owner_id=${owner} and request_id=${UuidSchema.parse(requestId)}`;
  return a ? getPlatformRepositoryPublication(context, a.publication_id) : null;
}
/** Source/action/Run bind in the existing enqueue transaction; no GitHub IO here. */
export async function createPlatformRepositoryAction(
  context: RequestContext,
  input: unknown,
) {
  const request = RepositoryPublicationRequestSchema.parse(input),
    owner = await requirePlatformAdmin(context);
  const digest = technicalDigest(request),
    sql = getDatabase();
  const [existing] =
    await sql`select input_digest,publication_id from allrice_platform_repository_actions where owner_id=${owner} and request_id=${request.requestId}`;
  if (existing) {
    if (existing.input_digest !== digest) throw new QueueError('conflict');
    return getPlatformRepositoryPublication(context, existing.publication_id);
  }
  if (!context.sessionId || !context.authenticatedAt)
    throw new DataAccessError('authorization_denied');
  const execution = await internalContext(context, true);
  const binding = await sql.begin(async (tx) => {
    if (request.action === 'inspect') {
      const [p] =
        await tx`select * from allrice_platform_repository_publications where id=${request.publicationId} and owner_id=${owner}`;
      if (!p) throw new DataAccessError('not_found');
      return {
        publicationId: p.id as string,
        source: RepositoryPublicationSourceSchema.parse(p.source),
      };
    }
    const source = await readAcceptedRepositorySource(
      tx,
      execution,
      request.repairTaskId,
      process.env.ALLRICE_RELEASE_SHA ?? '',
    );
    const [p] =
      await tx`select id from allrice_platform_repository_publications where owner_id=${owner} and base_sha=${source.baseSha} and after_checksum=${source.afterChecksum}`;
    return { publicationId: (p?.id ?? randomUUID()) as string, source };
  });
  const timeoutMs = request.action === 'publish' ? 120_000 : 30_000;
  await enqueueRun(
    execution,
    {
      workspaceId: execution.workspaceId,
      type: repositoryPublicationJobType,
      idempotencyKey: `platform-repository:${owner}:${request.requestId}`,
      maxAttempts: 1,
      timeoutMs,
      input: { requestId: request.requestId, inputDigest: digest },
    },
    {
      repositoryBinding: {
        id: randomUUID(),
        ...binding,
        request,
        inputDigest: digest,
        loginSessionId: context.sessionId,
        loginAuthenticatedAt: context.authenticatedAt,
        timeoutMs,
      },
    },
  );
  const found = await findPlatformRepositoryPublication(
    context,
    request.requestId,
  );
  if (!found) throw new DataAccessError('not_found');
  return found;
}
export async function cancelPlatformRepositoryAction(
  context: RequestContext,
  publicationId: string,
  actionId: string,
) {
  const detail = await getPlatformRepositoryPublication(context, publicationId);
  const action = detail.actions.find(
    (a) => a.id === UuidSchema.parse(actionId),
  );
  if (!action) throw new DataAccessError('not_found');
  await getDatabase().begin((tx) =>
    requestRunCancellationTransaction(
      tx,
      context,
      action.runId,
      'platform_admin_requested',
      true,
    ),
  );
  return getPlatformRepositoryPublication(context, publicationId);
}
