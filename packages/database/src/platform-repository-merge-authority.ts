import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { UuidSchema, runtimeContractEqual } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { assertMaintenanceWriteAction } from './platform-maintenance-actions.ts';
import { QueueError } from './execution/queue.ts';
import type { JobRow } from './queue/row-mappers.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  readCompletedRepositoryReview,
  lockCompletedRepositoryReviewRoot,
} from './platform-repository-completed-review.ts';
import { readRepositoryReviewMaterial } from './platform-repository-review-authority.ts';
import {
  assertRepositoryCredentialAuthority,
  type RepositoryActionLease,
} from './platform-repository-publication-authority.ts';
import {
  RepositoryMergeBindingSchema,
  RepositoryMergeRequestSchema,
  RepositoryCompletedReviewSchema,
  repositoryMergeJobType,
  type RepositoryMergeBinding,
} from './platform-repository-merge-contracts.ts';
type Tx = postgres.TransactionSql;
function deny(): never {
  throw new DataAccessError('authorization_denied');
}
const input = (requestId: string, inputDigest: string) => ({
  requestId,
  inputDigest,
});

async function lockCurrentMergeScope(tx: Tx, context: RequestContext) {
  const { context: scope } = await resolvePlatformPreviewContext(
    tx,
    {
      environment: 'platform',
      ownerId: context.actor.id,
      workspaceId: context.workspaceId,
    },
    context.actor.id,
  );
  if (
    scope.organization_id !== context.organizationId ||
    scope.workspace_id !== context.workspaceId
  )
    deny();
  const [live] = await tx`select m.id from allrice_memberships m
    join allrice_workspaces w on w.id=${scope.workspace_id} and w.organization_id=m.organization_id and w.archived_at is null
    join allrice_organizations o on o.id=w.organization_id and o.slug='allrice-platform' and o.archived_at is null
    where m.id=${scope.membership_id} and m.user_id=${context.actor.id} and m.active
      and (m.workspace_id is null or m.workspace_id=w.id) for share of m,w,o`;
  if (!live) deny();
}

async function currentLogin(tx: Tx, context: RequestContext) {
  // Row locks fence revocation, but cannot fence the passage of time while
  // waiting for material, content or operation locks.
  const [login] = await tx<
    { expires_at: Date }[]
  >`select expires_at from allrice_sessions
    where id=${context.sessionId!} and user_id=${context.actor.id}
      and date_trunc('milliseconds',created_at)=${context.authenticatedAt!}::timestamptz
      and revoked_at is null and expires_at>clock_timestamp()`;
  if (!login) deny();
  return login;
}

export async function bindRepositoryMerge(
  tx: Tx,
  context: RequestContext,
  runId: string,
  jobId: string,
  raw: RepositoryMergeBinding,
) {
  const b = RepositoryMergeBindingSchema.parse(raw),
    r = b.request,
    m = b.review.material;
  if (r.action === 'merge') assertMaintenanceWriteAction('merge');
  if (
    b.inputDigest !== technicalDigest(r) ||
    b.loginSessionId !== context.sessionId ||
    b.loginAuthenticatedAt !== context.authenticatedAt ||
    m.ownerId !== context.actor.id ||
    m.organizationId !== context.organizationId ||
    m.workspaceId !== context.workspaceId
  )
    deny();
  await lockCompletedRepositoryReviewRoot(tx, context, b.review.subjectId);
  await assertRepositoryCredentialAuthority(tx, context, r.credentialRevision);
  await lockCurrentMergeScope(tx, context);
  await tx`select pg_advisory_xact_lock(hashtextextended(${`platform-repository-merge:${m.publicationId}`},0))`;
  const proof = await readCompletedRepositoryReview(
    tx,
    context,
    b.review.subjectId,
  );
  if (!runtimeContractEqual(proof, b.review)) throw new QueueError('conflict');
  let [operation] =
    await tx`select * from allrice_platform_repository_merges where id=${b.mergeId} and publication_id=${m.publicationId} for update`;
  if (r.action === 'merge') {
    if (
      r.publicationId !== m.publicationId ||
      r.reviewSubjectId !== proof.subjectId ||
      r.expectedSubjectDigest !== m.subjectDigest
    )
      deny();
    const current = await readRepositoryReviewMaterial(
      tx,
      context,
      m.publicationId,
    );
    if (current.subjectDigest !== m.subjectDigest)
      throw new QueueError('conflict');
    if (operation?.merge_intent || operation?.receipt)
      throw new QueueError('conflict');
    const [started] = await tx`select id from allrice_platform_repository_merges
      where publication_id=${m.publicationId} and id<>${b.mergeId}
      and (ready_intent is not null or merge_intent is not null or receipt is not null) limit 1`;
    // A different proof is safe only before any external START for this
    // publication. Each generation retains its original immutable evidence.
    if (started) throw new QueueError('conflict');
    if (!operation)
      [operation] =
        await tx`insert into allrice_platform_repository_merges(id,publication_id,review_subject_id,owner_id,organization_id,workspace_id,review,review_digest)
      values(${b.mergeId},${m.publicationId},${proof.subjectId},${context.actor.id},${context.organizationId},${context.workspaceId!},${tx.json(proof)},${technicalDigest(proof)}) returning *`;
  } else if (r.mergeId !== b.mergeId || !operation)
    throw new DataAccessError('not_found');
  if (
    !operation ||
    operation.id !== b.mergeId ||
    operation.owner_id !== context.actor.id ||
    operation.review_digest !== technicalDigest(proof)
  )
    throw new QueueError('conflict');
  const [active] =
    await tx`select a.id from allrice_platform_repository_merge_actions a
    join allrice_platform_repository_merges g on g.id=a.merge_id join allrice_jobs j on j.id=a.job_id
    where g.publication_id=${m.publicationId} and j.status in ('queued','claimed','running') limit 1`;
  if (active) throw new QueueError('conflict');
  await currentLogin(tx, context);
  await tx`insert into allrice_platform_repository_merge_actions(id,merge_id,owner_id,request_id,request,input_digest,login_session_id,login_authenticated_at,credential_revision,run_id,job_id)
    values(${b.id},${b.mergeId},${context.actor.id},${r.requestId},${tx.json(r)},${b.inputDigest},${context.sessionId!},${context.authenticatedAt!},${r.credentialRevision},${runId},${jobId})`;
}
export async function assertExistingRepositoryMerge(
  tx: Tx,
  context: RequestContext,
  runId: string,
  b: RepositoryMergeBinding,
) {
  const [a] =
    await tx`select id,merge_id,input_digest from allrice_platform_repository_merge_actions where run_id=${runId} and owner_id=${context.actor.id}`;
  if (
    !a ||
    a.id !== b.id ||
    a.merge_id !== b.mergeId ||
    a.input_digest !== b.inputDigest
  )
    throw new QueueError('conflict');
}
async function authority(tx: Tx, job: JobRow) {
  const [a] =
    await tx`select a.*,m.publication_id,m.review_subject_id,m.organization_id,m.workspace_id,m.review,m.review_digest,
    m.ready_intent,m.merge_intent,m.receipt,r.input as run_input,r.owner_id as run_owner,ps.subject_id as policy_owner
    from allrice_platform_repository_merge_actions a join allrice_platform_repository_merges m on m.id=a.merge_id and m.owner_id=a.owner_id
    join allrice_runs r on r.id=a.run_id join allrice_policy_snapshots ps on ps.id=r.policy_snapshot_id
    where a.job_id=${job.id} and a.run_id=${job.run_id} and a.owner_id=${job.owner_id}`;
  if (!a) deny();
  const request = RepositoryMergeRequestSchema.parse(a.request),
    review = RepositoryCompletedReviewSchema.parse(a.review),
    m = review.material;
  if (request.action === 'merge') assertMaintenanceWriteAction('merge');
  if (
    job.max_attempts !== 1 ||
    job.cancel_requested_at ||
    request.requestId !== a.request_id ||
    request.credentialRevision !== a.credential_revision ||
    a.input_digest !== technicalDigest(request) ||
    a.review_digest !== technicalDigest(review) ||
    a.run_owner !== job.owner_id ||
    a.policy_owner !== job.owner_id ||
    a.organization_id !== job.organization_id ||
    a.workspace_id !== job.workspace_id ||
    m.ownerId !== job.owner_id ||
    m.organizationId !== job.organization_id ||
    m.workspaceId !== job.workspace_id ||
    a.publication_id !== m.publicationId ||
    a.review_subject_id !== review.subjectId ||
    !runtimeContractEqual(a.run_input, input(a.request_id, a.input_digest)) ||
    !runtimeContractEqual(
      (job.payload as { input: unknown }).input,
      a.run_input,
    ) ||
    (request.action === 'merge'
      ? request.publicationId !== m.publicationId ||
        request.reviewSubjectId !== review.subjectId ||
        request.expectedSubjectDigest !== m.subjectDigest
      : request.mergeId !== a.merge_id)
  )
    deny();
  const context: RequestContext = {
    actor: { type: 'user', id: job.owner_id },
    organizationId: job.organization_id,
    workspaceId: job.workspace_id,
    memberships: [],
    requestId: a.request_id,
    sessionId: a.login_session_id,
    authenticatedAt: a.login_authenticated_at.toISOString(),
  };
  await lockCompletedRepositoryReviewRoot(tx, context, review.subjectId);
  const token = await assertRepositoryCredentialAuthority(
    tx,
    context,
    a.credential_revision,
  );
  await lockCurrentMergeScope(tx, context);
  if (request.action === 'merge' && !a.merge_intent) {
    const current = await readRepositoryReviewMaterial(
      tx,
      context,
      m.publicationId,
    );
    if (current.subjectDigest !== m.subjectDigest) deny();
  }
  const proof = await readCompletedRepositoryReview(
    tx,
    context,
    review.subjectId,
  );
  if (!runtimeContractEqual(proof, review)) deny();
  const login = await currentLogin(tx, context);
  return {
    a,
    request,
    review,
    context,
    token,
    loginExpiresAt: login.expires_at,
  };
}
export async function isRepositoryMergeJobAuthorized(tx: Tx, job: JobRow) {
  if ((job.payload as { type?: unknown }).type !== repositoryMergeJobType)
    return true;
  try {
    await authority(tx, job);
    return true;
  } catch {
    return false;
  }
}
export async function withRepositoryMerge<T>(
  lease: RepositoryActionLease,
  callback: (
    tx: Tx,
    data: Awaited<ReturnType<typeof authority>>,
    job: JobRow,
    clock: {
      now: Date;
      lease_expires_at: Date;
      timeout_at: Date;
      login_expires_at: Date;
    },
  ) => Promise<T>,
) {
  [lease.jobId, lease.workerId, lease.leaseToken].forEach((v) =>
    UuidSchema.parse(v),
  );
  return getDatabase().begin(async (tx) => {
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${lease.jobId} for update`;
    if (
      !job ||
      job.status !== 'running' ||
      (job.payload as { type?: unknown }).type !== repositoryMergeJobType ||
      job.worker_id !== lease.workerId ||
      job.lease_token !== lease.leaseToken ||
      job.attempt !== lease.attempt ||
      job.cancel_requested_at
    )
      throw new QueueError('lease_lost');
    const data = await authority(tx, job);
    const [m] =
      await tx`select ready_intent,merge_intent,receipt from allrice_platform_repository_merges where id=${data.a.merge_id} for update`;
    if (!m) deny();
    Object.assign(data.a, m);
    const login = await currentLogin(tx, data.context);
    const [live] = await tx<
      { now: Date; lease_expires_at: Date; timeout_at: Date }[]
    >`select clock_timestamp() as now,lease_expires_at,timeout_at from allrice_jobs
      where id=${job.id} and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() and cancel_requested_at is null
      and ${login.expires_at}::timestamptz>clock_timestamp()`;
    if (!live) throw new QueueError('lease_lost');
    return callback(tx, data, job, {
      ...live,
      login_expires_at: login.expires_at,
    });
  });
}
export async function repositoryMergeRequestGate(lease: RepositoryActionLease) {
  return withRepositoryMerge(lease, async (_tx, d, _j, c) => ({
    token: d.token,
    remainingMs: Math.min(
      10000,
      c.lease_expires_at.getTime() - c.now.getTime(),
      c.timeout_at.getTime() - c.now.getTime(),
      c.login_expires_at.getTime() - c.now.getTime(),
    ),
  }));
}
export async function repositoryMergeCompletionAllowed(tx: Tx, job: JobRow) {
  if ((job.payload as { type?: unknown }).type !== repositoryMergeJobType)
    return true;
  const d = await authority(tx, job);
  const [live] =
    await tx`select id from allrice_jobs where id=${job.id} and status='running' and cancel_requested_at is null
    and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp()
    and ${d.loginExpiresAt}::timestamptz>clock_timestamp()`;
  return (
    !!live &&
    !!d.a.receipt &&
    d.a.completion?.jobAttempt === job.attempt &&
    d.a.completion?.inputDigest === d.a.input_digest &&
    d.a.completion?.receiptDigest === technicalDigest(d.a.receipt)
  );
}
