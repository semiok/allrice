import type { RequestContext } from '@allrice/contracts';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { DataAccessError } from './data.ts';
import {
  enqueueRun,
  QueueError,
  requestRunCancellationTransaction,
} from './execution/queue.ts';
import { platformRepositoryContext } from './platform-repository-publications.ts';
import {
  assertRepositoryCredentialAuthority,
  type RepositoryActionLease,
} from './platform-repository-publication-authority.ts';
import {
  readCompletedRepositoryReview,
  lockCompletedRepositoryReviewRoot,
} from './platform-repository-completed-review.ts';
import { readRepositoryReviewMaterial } from './platform-repository-review-authority.ts';
import { withRepositoryMerge } from './platform-repository-merge-authority.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  RepositoryMergeRequestSchema,
  RepositoryMergeBindingSchema,
  RepositoryCompletedReviewSchema,
  RepositoryMergeViewSchema,
  RepositoryMergePanelSchema,
  RepositoryMergeReceiptSchema,
  RepositoryMergePreflightSchema,
  repositoryMergeJobType,
} from './platform-repository-merge-contracts.ts';

export async function getPlatformRepositoryMerge(
  context: RequestContext,
  id: string,
) {
  const owner = await requirePlatformAdmin(context);
  const [m] =
    await getDatabase()`select * from allrice_platform_repository_merges where id=${UuidSchema.parse(id)} and owner_id=${owner}`;
  if (!m) throw new DataAccessError('not_found');
  const proof = RepositoryCompletedReviewSchema.parse(m.review);
  const actions =
    await getDatabase()`select a.*,j.status,j.last_error_code from allrice_platform_repository_merge_actions a
    join allrice_jobs j on j.id=a.job_id and j.run_id=a.run_id and j.owner_id=a.owner_id
    where a.merge_id=${m.id} and a.owner_id=${owner} order by a.created_at desc,a.id desc limit 20`;
  return RepositoryMergeViewSchema.parse({
    id: m.id,
    publicationId: m.publication_id,
    reviewSubjectId: m.review_subject_id,
    subjectDigest: proof.material.subjectDigest,
    readyStarted: !!m.ready_intent,
    mergeStarted: !!m.merge_intent,
    receipt: m.receipt,
    actions: actions.map((a) => ({
      id: a.id,
      requestId: a.request_id,
      action: a.request.action,
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
    createdAt: m.created_at.toISOString(),
  });
}
export async function findPlatformRepositoryMerge(
  context: RequestContext,
  requestId: string,
) {
  const owner = await requirePlatformAdmin(context);
  const [a] =
    await getDatabase()`select merge_id from allrice_platform_repository_merge_actions where owner_id=${owner} and request_id=${UuidSchema.parse(requestId)}`;
  return a ? getPlatformRepositoryMerge(context, a.merge_id) : null;
}
export async function getPlatformRepositoryMergePanel(
  context: RequestContext,
  publicationId: string,
  credentialRevision: number | null,
) {
  const internal = await platformRepositoryContext(context),
    id = UuidSchema.parse(publicationId),
    sql = getDatabase();
  const [p] =
    await sql`select id from allrice_platform_repository_publications where id=${id} and owner_id=${context.actor.id}`;
  if (!p) throw new DataAccessError('not_found');
  const existing =
    await sql`select id from allrice_platform_repository_merges where publication_id=${id} and owner_id=${context.actor.id} order by created_at desc,id desc limit 20`;
  const merges = await Promise.all(
    existing.map((m) => getPlatformRepositoryMerge(context, m.id)),
  );
  let subjectId: string | null = null,
    subjectDigest: string | null = null;
  let reason: ReturnType<typeof RepositoryMergePanelSchema.parse>['reason'] =
    'completed_review_required';
  if (!credentialRevision) reason = 'repository_authorization_required';
  else
    try {
      await sql.begin(async (tx) => {
        const [s] =
          await tx`select s.id from allrice_platform_repository_review_subjects s join allrice_jobs j on j.id=s.job_id
      join allrice_platform_repository_reviews r on r.subject_id=s.id and r.verdict='accept'
      where s.publication_id=${id} and s.owner_id=${context.actor.id} and j.status='succeeded'
      order by s.created_at desc,s.id desc limit 1`;
        if (!s) return;
        await lockCompletedRepositoryReviewRoot(tx, internal, s.id);
        await assertRepositoryCredentialAuthority(
          tx,
          internal,
          credentialRevision,
        );
        const material = await readRepositoryReviewMaterial(tx, internal, id);
        const review = await readCompletedRepositoryReview(tx, internal, s.id);
        if (review.material.subjectDigest !== material.subjectDigest)
          throw new QueueError('conflict');
        subjectId = review.subjectId;
        subjectDigest = review.material.subjectDigest;
        reason = null;
      });
    } catch {
      reason = 'review_invalid';
    }
  const operation =
    merges.find((m) => m.receipt) ??
    merges.find((m) => m.mergeStarted || m.readyStarted) ??
    merges[0];
  if (operation?.receipt) reason = 'merged';
  else if (
    merges.some((m) =>
      m.actions.some((a) => ['queued', 'running'].includes(a.status)),
    )
  )
    reason = 'merge_active';
  else if (operation?.mergeStarted) reason = 'merge_started_reconcile_only';
  else if (operation?.readyStarted && operation.reviewSubjectId !== subjectId)
    reason = 'started_review_fixed';
  return RepositoryMergePanelSchema.parse({
    publicationId: id,
    canStart: reason === null,
    reviewSubjectId: subjectId,
    subjectDigest,
    reason,
    merges,
  });
}
export async function createPlatformRepositoryMerge(
  context: RequestContext,
  input: unknown,
) {
  const r = RepositoryMergeRequestSchema.parse(input),
    owner = await requirePlatformAdmin(context),
    digest = technicalDigest(r),
    sql = getDatabase();
  const [prior] =
    await sql`select merge_id,input_digest from allrice_platform_repository_merge_actions where owner_id=${owner} and request_id=${r.requestId}`;
  if (prior) {
    if (prior.input_digest !== digest) throw new QueueError('conflict');
    return getPlatformRepositoryMerge(context, prior.merge_id);
  }
  if (!context.sessionId || !context.authenticatedAt)
    throw new DataAccessError('authorization_denied');
  const internal = await platformRepositoryContext(context, true);
  const readExisting = async () => {
    const [a] =
      await sql`select merge_id,input_digest from allrice_platform_repository_merge_actions where owner_id=${owner} and request_id=${r.requestId}`;
    if (!a) return null;
    if (a.input_digest !== digest) throw new QueueError('conflict');
    return getPlatformRepositoryMerge(context, a.merge_id);
  };
  let review;
  try {
    review = await sql.begin(async (tx) => {
      let subjectId = r.action === 'merge' ? r.reviewSubjectId : null;
      if (r.action === 'reconcile') {
        const [m] =
          await tx`select review_subject_id from allrice_platform_repository_merges where id=${r.mergeId} and owner_id=${owner}`;
        if (!m) throw new DataAccessError('not_found');
        subjectId = m.review_subject_id as string;
      }
      await lockCompletedRepositoryReviewRoot(tx, internal, subjectId!);
      await assertRepositoryCredentialAuthority(
        tx,
        internal,
        r.credentialRevision,
      );
      return readCompletedRepositoryReview(tx, internal, subjectId!);
    });
  } catch (e) {
    const saved = await readExisting();
    if (saved) return saved;
    throw e;
  }
  const mergeId =
    r.action === 'merge'
      ? cloudStableId(
          `repository-merge:${review.material.publicationId}:${technicalDigest(review)}`,
        )
      : r.mergeId;
  const b = RepositoryMergeBindingSchema.parse({
    id: cloudStableId(`repository-merge-action:${owner}:${r.requestId}`),
    mergeId,
    request: r,
    inputDigest: digest,
    review,
    loginSessionId: context.sessionId,
    loginAuthenticatedAt: context.authenticatedAt,
    timeoutMs: 300000,
  });
  try {
    await enqueueRun(
      internal,
      {
        workspaceId: internal.workspaceId,
        type: repositoryMergeJobType,
        idempotencyKey: `platform-repository-merge:${owner}:${r.requestId}`,
        maxAttempts: 1,
        timeoutMs: 300000,
        input: { requestId: r.requestId, inputDigest: digest },
      },
      { repositoryMergeBinding: b },
    );
  } catch (e) {
    const saved = await readExisting();
    if (saved) return saved;
    throw e;
  }
  const found = await readExisting();
  if (!found) throw new DataAccessError('not_found');
  return found;
}
export async function cancelPlatformRepositoryMerge(
  context: RequestContext,
  id: string,
  actionId: string,
) {
  const m = await getPlatformRepositoryMerge(context, id),
    a = m.actions.find((a) => a.id === UuidSchema.parse(actionId));
  if (!a) throw new DataAccessError('not_found');
  await getDatabase().begin((tx) =>
    requestRunCancellationTransaction(
      tx,
      context,
      a.runId,
      'platform_admin_requested',
      true,
    ),
  );
  return getPlatformRepositoryMerge(context, id);
}
export async function readRepositoryMergeAction(lease: RepositoryActionLease) {
  return withRepositoryMerge(lease, async (_tx, d) => ({
    id: d.a.merge_id as string,
    publicationId: d.a.publication_id as string,
    mode: d.request.action,
    review: d.review,
    readyStarted: !!d.a.ready_intent,
    mergeStarted: !!d.a.merge_intent,
    receipt: d.a.receipt,
  }));
}
export async function startRepositoryMergeEffect(
  lease: RepositoryActionLease,
  step: 'ready' | 'merge',
  preflight: unknown,
) {
  const proof = RepositoryMergePreflightSchema.parse(preflight);
  return withRepositoryMerge(lease, async (tx, d, j, c) => {
    if (d.request.action !== 'merge' || d.a.receipt)
      throw new QueueError('conflict');
    const field = step === 'ready' ? 'ready_intent' : 'merge_intent';
    if (d.a[field]) return false;
    const m = d.review.material;
    const stable = (ci: typeof m.ci) => ({
      ...ci,
      observedAt: null,
      checks: [...ci.checks].sort((a, b) => a.name.localeCompare(b.name, 'en')),
      receipts: [...ci.receipts].sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      ),
    });
    if (
      proof.pull.number !== m.remote.number ||
      proof.pull.url !== m.remote.url ||
      proof.pull.headSha !== m.metadata.commit ||
      proof.pull.baseSha !== m.source.baseSha ||
      technicalDigest(stable(proof.ci)) !== technicalDigest(stable(m.ci)) ||
      (step === 'merge' && proof.pull.draft)
    )
      throw new QueueError('conflict');
    const intent = {
      version: 1,
      step,
      actionId: d.a.id,
      jobId: j.id,
      jobAttempt: j.attempt,
      reviewDigest: d.a.review_digest,
      baseSha: d.review.material.source.baseSha,
      headSha: d.review.material.metadata.commit,
      pullNumber: d.review.material.remote.number,
      startedAt: c.now.toISOString(),
      preflight: proof,
    };
    if (step === 'ready')
      await tx`update allrice_platform_repository_merges set ready_intent=${tx.json(intent)} where id=${d.a.merge_id}`;
    else
      await tx`update allrice_platform_repository_merges set merge_intent=${tx.json(intent)} where id=${d.a.merge_id}`;
    return true;
  });
}
export async function finishRepositoryMergeAction(
  lease: RepositoryActionLease,
  raw: unknown,
) {
  const receipt = RepositoryMergeReceiptSchema.parse(raw);
  return withRepositoryMerge(lease, async (tx, d, j, c) => {
    const m = d.review.material;
    if (
      !d.a.merge_intent ||
      receipt.publicationId !== m.publicationId ||
      receipt.pullNumber !== m.remote.number ||
      receipt.subjectDigest !== m.subjectDigest ||
      receipt.baseSha !== m.source.baseSha ||
      receipt.headSha !== m.metadata.commit ||
      receipt.mergeTree !== m.metadata.tree
    )
      throw new QueueError('conflict');
    if (d.a.receipt) {
      const old = RepositoryMergeReceiptSchema.parse(d.a.receipt);
      if (
        old.mergeSha !== receipt.mergeSha ||
        old.mergeTree !== receipt.mergeTree
      )
        throw new QueueError('conflict');
    } else
      await tx`update allrice_platform_repository_merges set receipt=${tx.json(receipt)} where id=${d.a.merge_id}`;
    const final = d.a.receipt ?? receipt;
    const completion = {
      version: 1,
      jobAttempt: j.attempt,
      inputDigest: d.a.input_digest,
      receiptDigest: technicalDigest(final),
      checkedAt: c.now.toISOString(),
    };
    await tx`update allrice_platform_repository_merge_actions set completion=${tx.json(completion)} where id=${d.a.id} and completion is null`;
    return { mergeId: d.a.merge_id, receipt: final, devDeployed: false };
  });
}
