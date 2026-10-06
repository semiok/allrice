import type postgres from 'postgres';
import {
  AssistantResultSchema,
  RuntimeTaskRefSchema,
  runtimeContractEqual,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { repositoryDigest } from './platform-repository-source.ts';
import {
  RepositoryReviewFrozenSchema,
  RepositoryReviewRequestSchema,
  RepositoryReviewRemoteReceiptSchema,
  repositoryReviewConfiguration,
} from './platform-repository-review-contracts.ts';
import {
  repositoryReviewFrozenValid,
  readRepositoryReviewRepairs,
} from './platform-repository-review-authority.ts';
import { repositoryReviewAuthorRunIds } from './platform-repository-review-material.ts';
import { freezeRepositoryPublicationSource } from './platform-repository-publication-source.ts';
import { RepairFrozenSchema } from './platform-repair-authority.ts';
import { RepositoryCompletedReviewSchema } from './platform-repository-merge-contracts.ts';
import { runtimeLedgerInputDigest } from './runtime-ledger/ledger.ts';
import {
  lockRepositoryReviewContent,
  repositoryReviewOpinion,
  repositoryReviewDelivery,
} from './platform-repository-review-facts.ts';

type Tx = postgres.TransactionSql;
function deny(): never {
  throw new DataAccessError('authorization_denied');
}

/** Locate only, then lock the old native root before current credential or
 * publication locks. Never refresh an old clock or reinstate its worker lease. */
export async function lockCompletedRepositoryReviewRoot(
  tx: Tx,
  context: RequestContext,
  subjectId: string,
) {
  const [s] =
    await tx`select * from allrice_platform_repository_review_subjects where id=${subjectId}
    and owner_id=${context.actor.id} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}`;
  if (!s) throw new DataAccessError('not_found');
  const [root] =
    await tx`select * from allrice_runtime_roots where root_run_id=${s.run_id}
    and organization_id=${s.organization_id} and workspace_id=${s.workspace_id} for share`;
  const [assistant] =
    await tx`select * from allrice_assistant_roots where root_run_id=${s.run_id} for share`;
  const [job] =
    await tx`select j.*,r.input as run_input,r.state as run_state,r.owner_id as run_owner,
    r.organization_id as run_org,r.workspace_id as run_workspace,ps.subject_id as policy_owner
    from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_policy_snapshots ps on ps.id=r.policy_snapshot_id
    where j.id=${s.job_id} and j.run_id=${s.run_id} for share of j,r`;
  if (
    !root ||
    root.cancel_request_id ||
    root.cancel_requested_at ||
    !assistant ||
    assistant.revoked_at ||
    assistant.worker_job_id !== s.job_id ||
    !job ||
    job.status !== 'succeeded' ||
    job.run_state !== 'succeeded' ||
    job.cancel_requested_at ||
    job.max_attempts !== 1
  )
    deny();
  return { s, root, assistant, job };
}

/** Consume immutable completed facts separately from live completion. Old
 * lease/deadline/login/PAT expiry and later employee deployment do not erase
 * evidence. Explicit revocation, cancellation and same-content revise do. */
export async function readCompletedRepositoryReview(
  tx: Tx,
  context: RequestContext,
  subjectId: string,
) {
  const locked = await lockCompletedRepositoryReviewRoot(
      tx,
      context,
      subjectId,
    ),
    j = locked.job;
  if (!repositoryReviewFrozenValid(locked.s.frozen)) deny();
  const f = RepositoryReviewFrozenSchema.parse(locked.s.frozen),
    m = f.material;
  const request = RepositoryReviewRequestSchema.parse({
    requestId: f.requestId,
    publicationId: f.publicationId,
    expectedSubjectDigest: f.expectedSubjectDigest,
    credentialRevision: f.credentialRevision,
  });
  const [p] =
    await tx`select * from allrice_platform_repository_publications where id=${m.publicationId}
    and owner_id=${context.actor.id} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} for share`;
  if (!p) deny();
  const repairs = await readRepositoryReviewRepairs(
      tx,
      context,
      p.source_task_id,
    ),
    first = repairs[0];
  if (!first) deny();
  const source = freezeRepositoryPublicationSource(first, m.source.baseSha);
  if (
    technicalDigest(source) !== p.source_digest ||
    !runtimeContractEqual(source, p.source) ||
    !runtimeContractEqual(source, m.source) ||
    !runtimeContractEqual(p.metadata, m.metadata) ||
    !runtimeContractEqual(p.remote, m.remote) ||
    !runtimeContractEqual(
      repositoryReviewAuthorRunIds(repairs, source),
      m.authorRunIds,
    ) ||
    RepairFrozenSchema.parse(first.frozen).baselineText !== m.beforeText ||
    !runtimeContractEqual(first.report, m.report)
  )
    deny();
  const [s] =
    await tx`select * from allrice_platform_repository_review_subjects where id=${subjectId}
    and owner_id=${context.actor.id} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} for share`;
  if (
    !s ||
    s.run_id !== locked.s.run_id ||
    s.job_id !== j.id ||
    s.input_digest !== technicalDigest(request) ||
    s.request_id !== f.requestId ||
    !runtimeContractEqual(s.frozen, f) ||
    s.subject_digest !== m.subjectDigest ||
    s.content_digest !== m.candidateContentDigest ||
    s.publication_id !== m.publicationId ||
    m.ownerId !== context.actor.id ||
    m.organizationId !== context.organizationId ||
    m.workspaceId !== context.workspaceId ||
    j.owner_id !== s.owner_id ||
    j.organization_id !== s.organization_id ||
    j.workspace_id !== s.workspace_id ||
    j.run_owner !== s.owner_id ||
    j.run_org !== s.organization_id ||
    j.run_workspace !== s.workspace_id ||
    j.policy_owner !== s.owner_id
  )
    deny();
  const task = RuntimeTaskRefSchema.parse(locked.root.task);
  if (
    task.runId !== s.run_id ||
    task.rootRunId !== s.run_id ||
    task.parentRunId !== null ||
    task.chatSessionId !== s.session_id ||
    task.scope.organizationId !== s.organization_id ||
    task.scope.workspaceId !== s.workspace_id ||
    task.frozenConfiguration.employeeVersionId !== f.employeeVersionId ||
    !runtimeContractEqual(
      locked.assistant.configuration,
      repositoryReviewConfiguration,
    )
  )
    deny();
  const [employee] =
    await tx`select * from allrice_employee_runs where run_id=${s.run_id}
    and owner_id=${s.owner_id} and organization_id=${s.organization_id} and workspace_id=${s.workspace_id} for share`;
  const payload = j.payload as {
      type?: unknown;
      input?: Record<string, unknown>;
    },
    i = payload.input;
  if (
    !employee ||
    employee.employee_version_id !== f.employeeVersionId ||
    employee.employee_assignment_id !== f.assignmentId ||
    employee.session_id !== s.session_id ||
    payload.type !== 'allrice.employee.run' ||
    !i ||
    !runtimeContractEqual(i, j.run_input) ||
    i.repositoryReviewRequestId !== f.requestId ||
    i.repositoryReviewInputDigest !== s.input_digest ||
    i.employeeAssignmentId !== f.assignmentId ||
    i.employeeVersionId !== f.employeeVersionId ||
    i.sessionId !== s.session_id ||
    !runtimeContractEqual(
      i.assistantConfiguration,
      repositoryReviewConfiguration,
    )
  )
    deny();
  const instances =
    await tx`select * from allrice_assistant_instances where root_run_id=${s.run_id}
    and run_id=any(array[${s.run_id}::uuid,${s.reviewer_run_id}::uuid]) order by run_id for share`;
  const root = instances.find((row) => row.run_id === s.run_id),
    child = instances.find((row) => row.run_id === s.reviewer_run_id);
  if (
    !root ||
    root.status !== 'completed' ||
    root.cancel_request_id ||
    root.cancel_requested_at ||
    root.parent_run_id ||
    root.depth !== 0 ||
    !child ||
    child.status !== 'completed' ||
    child.cancel_request_id ||
    child.cancel_requested_at ||
    child.parent_run_id !== s.run_id ||
    child.depth !== 1 ||
    child.native_session_id === root.native_session_id ||
    m.authorRunIds.includes(child.run_id)
  )
    deny();
  const [review] =
    await tx`select * from allrice_platform_repository_reviews where subject_id=${s.id} for share`;
  const reports =
    await tx`select * from allrice_assistant_results where run_id=${child.run_id} order by delivery_id for share`;
  const report = reports[0];
  if (
    !review ||
    review.verdict !== 'accept' ||
    review.reviewer_run_id !== child.run_id ||
    review.evidence_digest !== m.evidenceDigest ||
    reports.length !== 1 ||
    !report ||
    report.root_run_id !== s.run_id ||
    !report.parent_message_id ||
    report.parent_adopted_seq === null ||
    report.parent_adopted_seq === undefined
  )
    deny();
  const result = AssistantResultSchema.parse(report.payload);
  if (
    result.status !== 'completed' ||
    result.incomplete.length ||
    result.deliveryId !== report.delivery_id ||
    ![true, false].some(
      (usageComplete) =>
        runtimeLedgerInputDigest({ ...result, usageComplete }) ===
        report.payload_digest,
    )
  )
    deny();
  const preflight = RepositoryReviewRemoteReceiptSchema.parse(s.preflight),
    postflight = RepositoryReviewRemoteReceiptSchema.parse(s.postflight);
  for (const [stage, receipt] of [
    ['preflight', preflight],
    ['postflight', postflight],
  ] as const) {
    if (
      receipt.stage !== stage ||
      receipt.subjectDigest !== m.subjectDigest ||
      receipt.evidenceDigest !== m.evidenceDigest ||
      receipt.jobAttempt !== j.attempt
    )
      deny();
  }
  if (Date.parse(preflight.checkedAt) > Date.parse(postflight.checkedAt))
    deny();
  const artifacts =
    await tx`select v.id,v.version,v.series_id,o.checksum,w.run_id from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id and o.state='ready' and o.immutable and o.deleted_at is null
    join allrice_workbench_artifacts w on w.version_id=v.id and w.kind='document'
    where v.id=any(array[${s.seed_artifact_id}::uuid,${review.artifact_id}::uuid,${s.delivery_artifact_id}::uuid])
    and v.owner_id=${s.owner_id} and v.organization_id=${s.organization_id} and v.workspace_id=${s.workspace_id} and v.session_id=${s.session_id}
    and not exists(select 1 from allrice_deliverable_versions n where n.series_id=v.series_id and n.version>v.version)
    order by v.id for share of v,o,w`;
  if (artifacts.length !== 3 || new Set(artifacts.map((a) => a.id)).size !== 3)
    deny();
  const ref = (id: string, runId: string) => {
    const a = artifacts.find((a) => a.id === id && a.run_id === runId);
    if (!a) deny();
    return { id, checksum: a.checksum as string };
  };
  const seed = ref(s.seed_artifact_id, s.run_id),
    opinion = ref(review.artifact_id, child.run_id),
    delivery = ref(s.delivery_artifact_id, s.run_id);
  const candidate = { artifactId: seed.id, digest: seed.checksum };
  const reviewCommand = {
    action: 'review',
    candidate,
    evidence: {
      kind: 'repository_ci',
      subjectId: s.id,
      evidenceDigest: m.evidenceDigest,
    },
    verdict: 'accept',
    summary: review.summary,
  };
  if (
    seed.checksum !==
      repositoryDigest(Buffer.from(JSON.stringify(m, null, 2))) ||
    review.request_digest !==
      technicalDigest({ requestId: review.id, arguments: reviewCommand }) ||
    opinion.checksum !==
      repositoryDigest(
        Buffer.from(
          JSON.stringify(
            repositoryReviewOpinion(
              review.id,
              candidate,
              m,
              child.run_id,
              'accept',
              review.summary,
            ),
            null,
            2,
          ),
        ),
      ) ||
    delivery.checksum !==
      repositoryDigest(
        Buffer.from(
          JSON.stringify(
            repositoryReviewDelivery(
              candidate,
              m,
              review.id,
              child.run_id,
              review.summary,
            ),
            null,
            2,
          ),
        ),
      ) ||
    !result.evidence.some(
      (e) => e.id === opinion.id && e.digest === opinion.checksum,
    )
  )
    deny();
  const [registered] =
    await tx`select artifact_id from allrice_assistant_artifacts where run_id=${child.run_id}
    and artifact_id=${opinion.id} and digest=${opinion.checksum} for share`;
  if (!registered) deny();
  // Shared by the actual verdict insert transaction. Query after acquiring it;
  // never lock another subject/publication in reverse order under this mutex.
  await lockRepositoryReviewContent(tx, s.owner_id, m.candidateContentDigest);
  const [rejected] =
    await tx`select r.id from allrice_platform_repository_reviews r join allrice_platform_repository_review_subjects q on q.id=r.subject_id
    where q.owner_id=${s.owner_id} and q.content_digest=${m.candidateContentDigest} and r.verdict='revise' limit 1`;
  if (rejected) deny();
  const fields = {
    version: 1 as const,
    subjectId: s.id as string,
    reviewId: review.id as string,
    reviewRunId: s.run_id as string,
    reviewJobId: s.job_id as string,
    reviewerRunId: child.run_id as string,
    employeeVersionId: f.employeeVersionId,
    employeeRevisionId: f.employeeRevisionId,
    assignmentId: f.assignmentId,
    reviewAttempt: Number(j.attempt),
    frozenFingerprint: f.fingerprint,
    inputDigest: s.input_digest as string,
    rootNativeSessionId: root.native_session_id as string,
    reviewerNativeSessionId: child.native_session_id as string,
    seed,
    opinion,
    delivery,
    reportDeliveryId: report.delivery_id as string,
    adoptedSeq: Number(report.parent_adopted_seq),
    parentMessageId: report.parent_message_id as string,
    reportInputDigest: report.payload_digest as string,
    reportPayloadDigest: runtimeLedgerInputDigest(result),
    preflight,
    postflight,
    material: m,
  };
  return RepositoryCompletedReviewSchema.parse({
    ...fields,
    factsDigest: technicalDigest(fields),
  });
}
