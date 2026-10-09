import type { ResourcePrincipal } from './resource-principal.ts';
import { MaintenanceRepositoryBindingSchema } from './platform-maintenance-publication-contracts.ts';
import { bindMaintenanceRepositoryAction } from './platform-maintenance-publication-binding.ts';
import {
  assertMaintenanceGrant,
  assertMaintenanceReconciliation,
} from './platform-maintenance-authority.ts';
import { readMaintenanceGithubBot } from './platform-maintenance-github.ts';
import { MaintenancePublicationProvenanceSchema } from './platform-maintenance-provenance.ts';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';
import type { JobRow } from './queue/row-mappers.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { readPlatformRepositoryCredential } from './platform-repository-credentials.ts';
import { platformRepository } from './platform-repository-credential-contracts.ts';
import {
  RepositoryActionReceiptSchema,
  RepositoryStoredStepsSchema,
  repositoryFactsDigest,
} from './platform-repository-publication-ledger.ts';
import { freezeRepositoryPublicationSource } from './platform-repository-publication-source.ts';
import {
  RepositoryPublicationRequestSchema,
  RepositoryPublicationSourceSchema,
  repositoryPublicationJobType,
  repositoryPublicationStepsFor,
} from './platform-repository-publication-contracts.ts';

type Tx = postgres.TransactionSql;
const LegacyRepositoryActionBindingSchema = z
  .object({
    id: UuidSchema,
    publicationId: UuidSchema,
    request: RepositoryPublicationRequestSchema,
    source: RepositoryPublicationSourceSchema,
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    loginSessionId: UuidSchema,
    loginAuthenticatedAt: z.string().datetime({ offset: true }),
    timeoutMs: z.union([z.literal(30_000), z.literal(120_000)]),
  })
  .strict();
export const RepositoryActionBindingSchema = z.union([
  LegacyRepositoryActionBindingSchema,
  MaintenanceRepositoryBindingSchema,
]);
export type RepositoryActionBinding = z.infer<
  typeof RepositoryActionBindingSchema
>;
export interface RepositoryActionLease {
  workerId: string;
  jobId: string;
  leaseToken: string;
  attempt: number;
}

export async function assertRepositoryCredentialAuthority(
  tx: Tx,
  context: RequestContext,
  revision: number,
) {
  const [user] =
    await tx`select id from allrice_users where id=${context.actor.id} and status='active' for share`;
  if (!user) throw new DataAccessError('authorization_denied');
  await requirePlatformAdmin(context, tx);
  if (!context.sessionId || !context.authenticatedAt)
    throw new DataAccessError('authorization_denied');
  const [login] =
    await tx`select id from allrice_sessions where id=${context.sessionId}
    and user_id=${context.actor.id} and date_trunc('milliseconds',created_at)=${context.authenticatedAt}::timestamptz
    and revoked_at is null and expires_at>clock_timestamp() for share`;
  if (!login) throw new DataAccessError('authorization_denied');
  // Same lock as replace/remove; no network or model execution under this lock.
  await tx`select pg_advisory_xact_lock(hashtext(${`platform-repository-credential:${context.actor.id}:${platformRepository.id}`}))`;
  return readPlatformRepositoryCredential(context, revision, tx);
}
const credential = assertRepositoryCredentialAuthority;
export async function readAcceptedRepositorySource(
  tx: Tx,
  context: ResourcePrincipal,
  taskId: string,
  expectedRelease: string,
) {
  const [row] =
    await tx`select q.*,j.status from allrice_platform_repair_tasks q
    join allrice_jobs j on j.id=q.job_id and j.run_id=q.run_id and j.owner_id=q.owner_id
    where q.id=${UuidSchema.parse(taskId)} and q.owner_id=${context.actor.id}
      and q.organization_id=${context.organizationId} and q.workspace_id=${context.workspaceId!}
      and j.status='succeeded' for share of q,j`;
  if (!row) throw new DataAccessError('not_found');
  try {
    return freezeRepositoryPublicationSource(
      row as Parameters<typeof freezeRepositoryPublicationSource>[0],
      expectedRelease,
    );
  } catch {
    throw new QueueError('conflict');
  }
}

/** Called within enqueue's transaction, before either Run or action is visible. */
export async function bindRepositoryAction(
  tx: Tx,
  context: ResourcePrincipal,
  runId: string,
  jobId: string,
  raw: RepositoryActionBinding,
) {
  const b = RepositoryActionBindingSchema.parse(raw);
  if ('version' in b)
    return bindMaintenanceRepositoryAction(tx, context, runId, jobId, b);
  if (b.source.version !== 1) throw new DataAccessError('authorization_denied');
  const owner = await requirePlatformAdmin(context, tx);
  if (
    b.inputDigest !== technicalDigest(b.request) ||
    b.loginSessionId !== (context as RequestContext).sessionId ||
    b.loginAuthenticatedAt !== (context as RequestContext).authenticatedAt ||
    b.timeoutMs !== (b.request.action === 'publish' ? 120_000 : 30_000)
  )
    throw new DataAccessError('authorization_denied');
  const { context: internal } = await resolvePlatformPreviewContext(
    tx,
    {
      environment: 'platform',
      ownerId: owner,
      workspaceId: context.workspaceId,
    },
    owner,
  );
  if (internal.organization_id !== context.organizationId)
    throw new DataAccessError('authorization_denied');
  await credential(tx, context as RequestContext, b.request.credentialRevision);
  const source = await readAcceptedRepositorySource(
    tx,
    context,
    b.source.repairTaskId,
    b.request.action === 'publish'
      ? (process.env.ALLRICE_RELEASE_SHA ?? '')
      : b.source.baseSha,
  );
  if (technicalDigest(source) !== technicalDigest(b.source))
    throw new QueueError('conflict');
  const key = `${owner}:${source.baseSha}:${source.afterChecksum}`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`platform-repository-publication:${key}`},0))`;
  let [publication] =
    await tx`select * from allrice_platform_repository_publications
    where owner_id=${owner} and base_sha=${source.baseSha} and after_checksum=${source.afterChecksum} for update`;
  if (publication) {
    if (
      publication.id !== b.publicationId ||
      publication.source_digest !== technicalDigest(source)
    )
      throw new QueueError('conflict');
  } else {
    if (b.request.action !== 'publish') throw new DataAccessError('not_found');
    [publication] =
      await tx`insert into allrice_platform_repository_publications(id,owner_id,organization_id,workspace_id,source_task_id,base_sha,after_checksum,source,source_digest)
      values(${b.publicationId},${owner},${context.organizationId},${context.workspaceId!},${source.repairTaskId},${source.baseSha},${source.afterChecksum},${tx.json(source)},${technicalDigest(source)}) returning *`;
  }
  if (
    !publication ||
    (b.request.action === 'inspect' &&
      b.request.publicationId !== publication.id)
  )
    throw new QueueError('conflict');
  const [active] =
    await tx`select a.id from allrice_platform_repository_actions a join allrice_jobs j on j.id=a.job_id
    where a.publication_id=${publication.id} and j.status in ('queued','claimed','running') limit 1`;
  if (active) throw new QueueError('conflict');
  await tx`insert into allrice_platform_repository_actions(id,publication_id,owner_id,request_id,request,input_digest,login_session_id,login_authenticated_at,credential_revision,mode,timeout_ms,run_id,job_id)
    values(${b.id},${publication.id},${owner},${b.request.requestId},${tx.json(b.request)},${b.inputDigest},${b.loginSessionId},${b.loginAuthenticatedAt},${b.request.credentialRevision},${b.request.action},${b.timeoutMs},${runId},${jobId})`;
}
export async function assertExistingRepositoryAction(
  tx: Tx,
  context: ResourcePrincipal,
  runId: string,
  b: RepositoryActionBinding,
) {
  const [row] =
    await tx`select a.* from allrice_platform_repository_actions a where a.run_id=${runId} and a.owner_id=${context.actor.id}`;
  if (
    !row ||
    row.input_digest !== b.inputDigest ||
    (b.request.action === 'inspect' && row.publication_id !== b.publicationId)
  )
    throw new QueueError('conflict');
}

async function authorisedAction(
  tx: Tx,
  job: JobRow,
  intent: 'write' | 'reconcile' = 'write',
) {
  const [row] =
    await tx`select a.*,p.organization_id,p.workspace_id,p.source,p.source_digest,p.revision,p.metadata,p.steps,p.remote,p.ci,p.provenance,p.created_at publication_created_at,
      r.input run_input,r.owner_id run_owner,ps.subject_id policy_owner
    from allrice_platform_repository_actions a
    join allrice_platform_repository_publications p on p.id=a.publication_id and p.owner_id=a.owner_id
    join allrice_runs r on r.id=a.run_id and r.organization_id=p.organization_id and r.workspace_id=p.workspace_id
    join allrice_policy_snapshots ps on ps.id=r.policy_snapshot_id
    join allrice_workspaces w on w.id=p.workspace_id and w.organization_id=p.organization_id and w.archived_at is null
      and w.slug='employee-tests-'||p.owner_id::text
    join allrice_organizations o on o.id=p.organization_id and o.slug='allrice-platform' and o.archived_at is null
    where a.job_id=${job.id} and a.run_id=${job.run_id} and a.owner_id=${job.owner_id}
      and exists(select 1 from allrice_memberships m where m.user_id=a.owner_id and m.organization_id=p.organization_id
        and m.active and (m.workspace_id is null or m.workspace_id=p.workspace_id))`;
  if (!row) throw new DataAccessError('authorization_denied');
  const request = RepositoryPublicationRequestSchema.parse(row.request),
    source = RepositoryPublicationSourceSchema.parse(row.source);
  const input = { requestId: row.request_id, inputDigest: row.input_digest };
  if (
    row.run_owner !== job.owner_id ||
    row.policy_owner !== job.owner_id ||
    row.organization_id !== job.organization_id ||
    row.workspace_id !== job.workspace_id ||
    row.source_digest !== technicalDigest(source) ||
    row.input_digest !== technicalDigest(request) ||
    technicalDigest(row.run_input) !== technicalDigest(input) ||
    technicalDigest((job.payload as { input: unknown }).input) !==
      technicalDigest(input) ||
    job.max_attempts !== 1 ||
    request.requestId !== row.request_id ||
    request.action !== row.mode ||
    request.credentialRevision !== row.credential_revision ||
    (request.action === 'publish'
      ? request.repairTaskId !== source.repairTaskId
      : request.publicationId !== row.publication_id) ||
    row.timeout_ms !== (request.action === 'publish' ? 120_000 : 30_000)
  )
    throw new DataAccessError('authorization_denied');
  // Inspection is an HTTP-read-only lane even when a grant is otherwise live.
  if (request.action === 'inspect' && intent !== 'reconcile')
    throw new DataAccessError('authorization_denied');
  if (row.authority_version === 2) {
    const readOnly = intent === 'reconcile';
    const g = readOnly
      ? await assertMaintenanceReconciliation(
          tx,
          row.maintenance_grant_id,
          job.owner_id,
        )
      : await assertMaintenanceGrant(
          tx,
          row.maintenance_grant_id,
          job.owner_id,
        );
    const provenance = MaintenancePublicationProvenanceSchema.parse(
      row.provenance,
    );
    const [attempt] =
      await tx`select * from allrice_platform_maintenance_attempts where id=${provenance.attemptId} and primary_grant_id=${row.maintenance_grant_id}`;
    if (
      source.version !== 2 ||
      source.maintenance.grantId !== g.row.id ||
      source.maintenance.grantDigest !== g.row.frozen_digest ||
      provenance.grantId !== g.row.id ||
      provenance.grantDigest !== g.row.frozen_digest ||
      provenance.targetSha !== source.baseSha ||
      !attempt ||
      attempt.publication_id !== row.publication_id ||
      attempt.repair_task_id !== source.repairTaskId ||
      source.maintenance.attemptId !== attempt.id ||
      !g.frozen.githubBot ||
      technicalDigest(provenance.githubBot) !==
        technicalDigest(g.frozen.githubBot) ||
      request.credentialRevision !== provenance.githubBot.revision
    )
      throw new DataAccessError('authorization_denied');
    const bot = await readMaintenanceGithubBot(
      tx,
      provenance.githubBot,
      readOnly ? 'reconcile' : 'write',
    );
    return { row, source, request, token: bot.token };
  }
  if (source.version !== 1) throw new DataAccessError('authorization_denied');
  const context: RequestContext = {
    actor: { type: 'user', id: job.owner_id },
    requestId: row.request_id,
    organizationId: job.organization_id,
    workspaceId: job.workspace_id,
    memberships: [],
    sessionId: row.login_session_id,
    authenticatedAt: (row.login_authenticated_at as Date).toISOString(),
  };
  const token = await credential(tx, context, row.credential_revision);
  const { context: internal } = await resolvePlatformPreviewContext(
    tx,
    {
      environment: 'platform',
      ownerId: job.owner_id,
      workspaceId: job.workspace_id,
    },
    job.owner_id,
  );
  if (internal.organization_id !== job.organization_id)
    throw new DataAccessError('authorization_denied');
  const [scope] = await tx`select m.id from allrice_memberships m
    join allrice_workspaces w on w.id=${job.workspace_id} and w.organization_id=m.organization_id and w.archived_at is null
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    where m.id=${internal.membership_id} and m.user_id=${job.owner_id} and m.active
      and m.organization_id=${job.organization_id} and (m.workspace_id is null or m.workspace_id=w.id)
    for share of m,w,o`;
  if (!scope) throw new DataAccessError('authorization_denied');
  return { row, source, request, context, token };
}
export async function isRepositoryActionAuthorized(tx: Tx, job: JobRow) {
  if (
    (job.payload as { type?: unknown })?.type !== repositoryPublicationJobType
  )
    return true;
  try {
    const [action] =
      await tx`select mode from allrice_platform_repository_actions where job_id=${job.id} and owner_id=${job.owner_id}`;
    await authorisedAction(
      tx,
      job,
      action?.mode === 'inspect' ? 'reconcile' : 'write',
    );
    return true;
  } catch {
    return false;
  }
}
export async function repositoryActionCompletionAllowed(tx: Tx, job: JobRow) {
  if (
    (job.payload as { type?: unknown })?.type !== repositoryPublicationJobType
  )
    return true;
  if (
    job.timeout_at <= new Date() ||
    !job.lease_expires_at ||
    job.lease_expires_at <= new Date()
  )
    return false;
  const [action] =
    await tx`select a.receipt,a.observation,a.mode,a.input_digest,a.publication_id,p.* from allrice_platform_repository_actions a
    join allrice_platform_repository_publications p on p.id=a.publication_id and p.owner_id=a.owner_id where a.job_id=${job.id}`;
  const r = RepositoryActionReceiptSchema.safeParse(action?.receipt);
  if (
    !r.success ||
    !action ||
    r.data.publicationId !== action.publication_id ||
    r.data.inputDigest !== action.input_digest ||
    r.data.sourceDigest !== action.source_digest ||
    r.data.action !== action.mode ||
    r.data.jobAttempt !== job.attempt ||
    r.data.factsDigest !== repositoryFactsDigest(action)
  )
    return false;
  const steps = RepositoryStoredStepsSchema.safeParse(action.steps);
  return (
    steps.success &&
    (action.mode === 'inspect'
      ? !!action.observation &&
        action.observation.inputDigest === action.input_digest &&
        action.observation.jobAttempt === job.attempt &&
        action.observation.factsDigest === r.data.factsDigest
      : repositoryPublicationStepsFor(
          RepositoryPublicationSourceSchema.parse(action.source),
        ).every((s) => action.steps[s]?.state === 'confirmed') &&
        !!action.remote)
  );
}

/** Short transaction. Rechecks the canonical lease before every remote request. */
export async function withRepositoryAction<T>(
  lease: RepositoryActionLease,
  callback: (
    tx: Tx,
    data: Awaited<ReturnType<typeof authorisedAction>>,
    job: JobRow,
  ) => Promise<T>,
  intent: 'write' | 'reconcile' = 'write',
) {
  for (const value of [lease.workerId, lease.jobId, lease.leaseToken])
    UuidSchema.parse(value);
  return getDatabase().begin(async (tx) => {
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${lease.jobId} for update`;
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
      (job.payload as { type?: unknown })?.type !== repositoryPublicationJobType
    )
      throw new QueueError('lease_lost');
    // Lock order: Job -> current owner/login/credential -> publication. Never wait on network here.
    const data = await authorisedAction(tx, job, intent);
    const [publication] =
      await tx`select revision,steps,metadata,remote,ci,ci_evidence from allrice_platform_repository_publications where id=${data.row.publication_id} and owner_id=${job.owner_id} for update`;
    if (!publication) throw new DataAccessError('authorization_denied');
    // Locks may have waited past the lease/deadline. Recheck after acquiring them.
    const [live] =
      await tx`select id from allrice_jobs where id=${job.id} and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() and cancel_requested_at is null`;
    if (!live) throw new QueueError('lease_lost');
    Object.assign(data.row, publication);
    return callback(tx, data, job);
  });
}
export async function repositoryRequestGate(
  lease: RepositoryActionLease,
  method: 'GET' | 'POST' | 'PUT' = 'POST',
) {
  return withRepositoryAction(
    lease,
    async (_tx, data, job) => ({
      token: data.token,
      remainingMs: Math.max(0, job.timeout_at.getTime() - Date.now()),
    }),
    method === 'GET' ? 'reconcile' : 'write',
  );
}
export const newRepositoryActionId = () => randomUUID();
