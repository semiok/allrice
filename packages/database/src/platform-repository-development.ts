import {
  runtimeContractEqual,
  runtimeFeatureEnabled,
  type ExecutionContext,
  type StoragePort,
  type RuntimeTaskRef,
  type DevelopmentArtifactRef,
} from '@allrice/contracts';
import type { getDatabase } from './core/client.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
import type { DevelopmentCaller } from './development-cooperation.ts';
import { publishWorkbenchArtifact } from './artifact-review.ts';
import { repositoryDigest } from './platform-repository-source.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  RepositoryReviewCommandSchema,
  RepositoryReviewFrozenSchema,
} from './platform-repository-review-contracts.ts';
import {
  assertRepositoryReviewAssistantAuthority,
  repositoryReviewSchemaAvailable,
  repositoryReviewCompletionAllowed,
} from './platform-repository-review-authority.ts';
import type { JobRow } from './queue/row-mappers.ts';

type Tx = RuntimeLedgerTransaction;
type Options = {
  database: ReturnType<typeof getDatabase>;
  authorize: (
    tx: Tx,
    caller: DevelopmentCaller,
    tool: string,
    completed?: boolean,
  ) => Promise<RuntimeTaskRef>;
  registerArtifact: (
    input: DevelopmentCaller & {
      artifactId: string;
      digest: string;
      relativePath: string;
    },
  ) => Promise<unknown>;
};
function fail(reason: string): never {
  throw Error(`repository_review_${reason}`);
}

/** Native development tool adaptation for a registered platform root. The
 * ordinary Changeset/operation workflow and execution grants are untouched. */
export async function executeRepositoryDevelopment(
  input: DevelopmentCaller & {
    context: ExecutionContext;
    requestId: string;
    arguments: unknown;
  },
  storage: StoragePort,
  o: Options,
  transaction?: Tx,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const identify = async (tx: Tx) => {
    if (!(await repositoryReviewSchemaAvailable(tx))) return null;
    const [s] =
      await tx`select * from allrice_platform_repository_review_subjects where run_id=${input.rootRunId}`;
    return s ?? null;
  };
  const subject = transaction
    ? await identify(transaction)
    : await o.database.begin(identify);
  if (!subject) return { handled: false };
  if (
    !runtimeFeatureEnabled('ALLRICE_ASSISTANTS_ENABLED') ||
    !runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED')
  )
    fail('disabled');
  const args = RepositoryReviewCommandSchema.parse(input.arguments);
  if (transaction && args.action !== 'assign') fail('invalid_action');
  if (
    input.context.runId !== input.rootRunId ||
    input.context.jobId !== input.worker.jobId ||
    input.context.worker.id !== input.worker.workerId ||
    input.context.organizationId !== input.scope.organizationId ||
    input.context.workspaceId !== input.scope.workspaceId
  )
    fail('forbidden');
  const f = RepositoryReviewFrozenSchema.parse(subject.frozen),
    material = f.material;
  const seedBytes = Buffer.from(JSON.stringify(material, null, 2)),
    seedDigest = repositoryDigest(seedBytes);
  const admit = async (tx: Tx, runId = input.runId, completed = false) => {
    const task = await o.authorize(
      tx,
      { ...input, runId },
      'assistant.development',
      completed,
    );
    await assertRepositoryReviewAssistantAuthority(tx, input.rootRunId, [
      'assistant.development',
    ]);
    if (
      task.scope.organizationId !== material.organizationId ||
      task.scope.workspaceId !== material.workspaceId ||
      task.chatSessionId !== subject.session_id
    )
      fail('forbidden');
    return task;
  };
  const rootOnly = () => {
    if (input.runId !== input.rootRunId) fail('forbidden');
  };
  const current = async (tx: Tx) => {
    await admit(tx);
    const [s] =
      await tx`select * from allrice_platform_repository_review_subjects where id=${subject.id} and run_id=${input.rootRunId} for update`;
    if (
      !s ||
      s.subject_digest !== material.subjectDigest ||
      s.owner_id !== material.ownerId
    )
      fail('subject_changed');
    return s;
  };
  const reference = async (tx: Tx, candidate: DevelopmentArtifactRef) => {
    const s = await current(tx);
    if (
      !s.seed_artifact_id ||
      !runtimeContractEqual(candidate, {
        artifactId: s.seed_artifact_id,
        digest: seedDigest,
      })
    )
      fail('candidate_mismatch');
    const [a] =
      await tx`select v.id from allrice_deliverable_versions v join allrice_storage_objects o on o.id=v.object_id
      join allrice_workbench_artifacts w on w.version_id=v.id and w.run_id=${input.rootRunId} and w.kind='document'
      where v.id=${candidate.artifactId} and v.owner_id=${material.ownerId} and v.organization_id=${material.organizationId} and v.workspace_id=${material.workspaceId}
      and v.session_id=${subject.session_id} and o.state='ready' and o.immutable and o.deleted_at is null and o.checksum=${candidate.digest}
      and not exists(select 1 from allrice_deliverable_versions n where n.series_id=v.series_id and n.version>v.version) for share of v,o,w`;
    if (!a) fail('material_unavailable');
    return s;
  };
  const independent = async (tx: Tx, runId: string, completed = false) => {
    if (runId === input.rootRunId || material.authorRunIds.includes(runId))
      fail('independent_reviewer_required');
    await admit(tx, runId, completed);
    const [i] = await tx`select i.run_id from allrice_assistant_instances i
      where i.root_run_id=${input.rootRunId} and i.run_id=${runId} and i.parent_run_id=${input.rootRunId} and i.depth=1
      and i.native_session_id<>(select native_session_id from allrice_assistant_instances where run_id=${input.rootRunId})
      and i.cancel_requested_at is null ${completed ? tx`and i.status='completed'` : tx``}`;
    if (!i) fail('independent_reviewer_required');
  };
  if (args.action === 'assign') {
    rootOnly();
    const assign = async (tx: Tx) => {
      const s = await reference(tx, args.expectedHead);
      await independent(tx, args.ownerRunId);
      if (s.reviewer_run_id && s.reviewer_run_id !== args.ownerRunId)
        fail('reviewer_already_assigned');
      await tx`update allrice_platform_repository_review_subjects set reviewer_run_id=${args.ownerRunId} where id=${s.id}`;
      return {
        role: 'review',
        candidate: args.expectedHead,
        evidence: {
          kind: 'repository_ci',
          subjectId: s.id,
          evidenceDigest: material.evidenceDigest,
        },
        subjectDigest: material.subjectDigest,
        notice:
          'Read-only repository review. inspect and review only; no edits, commands, network, merge or deployment.',
      };
    };
    return {
      handled: true,
      result: transaction
        ? await assign(transaction)
        : await o.database.begin(assign),
    };
  }
  if (args.action === 'inspect') {
    let s = await o.database.begin(current);
    if (!s.seed_artifact_id) {
      rootOnly();
      const artifact = await publishWorkbenchArtifact(
        {
          context: input.context,
          sessionId: subject.session_id,
          callId: `repository-review-material:${subject.id}`,
          kind: 'document',
          fileName: 'repository-review-material.json',
          format: 'json',
          mediaType: 'application/json',
          bytes: seedBytes,
          changeSummary: '固定仓库候选与原始 CI 审查材料；无执行授权。',
        },
        storage,
        o.database,
        {
          runId: input.rootRunId,
          admit: async (tx) => {
            await current(tx);
          },
          registered: async (tx, artifactId) => {
            const c = await current(tx);
            if (c.seed_artifact_id && c.seed_artifact_id !== artifactId)
              fail('candidate_mismatch');
            await tx`update allrice_platform_repository_review_subjects set seed_artifact_id=${artifactId} where id=${subject.id}`;
          },
        },
      );
      await o.registerArtifact({
        ...input,
        artifactId: artifact.id,
        digest: seedDigest,
        relativePath: 'development/repository-review-material.json',
      });
      s = await o.database.begin(current);
    }
    const candidate = {
      artifactId: s.seed_artifact_id as string,
      digest: seedDigest,
    };
    const result = await o.database.begin(async (tx) => {
      const c = await reference(tx, args.candidate ?? candidate);
      if (input.runId !== input.rootRunId && input.runId !== c.reviewer_run_id)
        fail('verification_assignment_required');
      const [review] =
        await tx`select id,reviewer_run_id,verdict,summary,artifact_id from allrice_platform_repository_reviews where subject_id=${subject.id}`;
      return {
        candidate,
        evidence: {
          kind: 'repository_ci',
          subjectId: subject.id,
          evidenceDigest: material.evidenceDigest,
        },
        material,
        reviewerRunId: c.reviewer_run_id,
        review: review ?? null,
        applied: false,
        notice:
          'Model review is an attributed opinion. Merge and Dev acceptance are separate gates.',
      };
    });
    return { handled: true, result };
  }
  const requestDigest = technicalDigest({
    requestId: input.requestId,
    arguments: args,
  });
  const verify = async (tx: Tx) => {
    const s = await reference(tx, args.candidate);
    if (!s.reviewer_run_id) fail('verification_assignment_required');
    await independent(tx, s.reviewer_run_id, args.action === 'deliver');
    const [r] =
      await tx`select * from allrice_platform_repository_reviews where subject_id=${s.id}`;
    if (args.action === 'review') {
      if (
        input.runId !== s.reviewer_run_id ||
        args.evidence.subjectId !== s.id ||
        args.evidence.evidenceDigest !== material.evidenceDigest
      )
        fail('evidence_mismatch');
      if (r && (r.id !== input.requestId || r.request_digest !== requestDigest))
        fail('review_conflict');
      return {
        id: input.requestId,
        candidate: args.candidate,
        subjectDigest: material.subjectDigest,
        evidenceDigest: material.evidenceDigest,
        reviewerRunId: s.reviewer_run_id as string,
        verdict: args.verdict,
        summary: args.summary,
        applied: false,
      };
    }
    rootOnly();
    if (!r || r.id !== args.reviewId || r.verdict !== 'accept')
      fail('accepted_review_required');
    const [rejected] =
      await tx`select r.id from allrice_platform_repository_reviews r join allrice_platform_repository_review_subjects s on s.id=r.subject_id
      where s.owner_id=${material.ownerId} and s.content_digest=${material.candidateContentDigest} and r.verdict='revise' limit 1`;
    if (rejected) fail('revision_required');
    return {
      candidate: args.candidate,
      subjectDigest: material.subjectDigest,
      evidenceDigest: material.evidenceDigest,
      reviewId: r.id as string,
      reviewerRunId: s.reviewer_run_id as string,
      verdict: 'accept' as const,
      summary: r.summary as string,
      applied: false,
      notice:
        'Model review is an attributed opinion. Merge and Dev acceptance are separate gates.',
    };
  };
  const result = await o.database.begin(verify);
  const artifact = await publishWorkbenchArtifact(
    {
      context: input.context,
      sessionId: subject.session_id,
      callId: `repository-${args.action}:${input.requestId}`,
      kind: 'document',
      fileName: `repository-${args.action}.json`,
      format: 'json',
      mediaType: 'application/json',
      bytes: Buffer.from(JSON.stringify(result, null, 2)),
      changeSummary:
        args.action === 'review'
          ? '独立助手的仓库候选审查意见。'
          : '准确候选的审查交付记录；合并与 Dev 验收另行执行。',
    },
    storage,
    o.database,
    {
      runId: input.runId,
      admit: async (tx) => {
        await verify(tx);
      },
      registered: async (tx, artifactId) => {
        await verify(tx);
        if (args.action === 'review') {
          await tx`insert into allrice_platform_repository_reviews(id,subject_id,reviewer_run_id,request_digest,verdict,summary,evidence_digest,artifact_id)
          values(${input.requestId},${subject.id},${result.reviewerRunId},${requestDigest},${args.verdict},${args.summary},${material.evidenceDigest},${artifactId}) on conflict(id) do nothing`;
        } else
          await tx`update allrice_platform_repository_review_subjects set delivery_artifact_id=${artifactId} where id=${subject.id}`;
      },
    },
  );
  const ref = { artifactId: artifact.id, digest: artifact.object.checksum! };
  await o.registerArtifact({
    ...input,
    ...ref,
    relativePath: `development/repository-${args.action}:${input.requestId}.json`,
  });
  return { handled: true, result: { ...result, artifact: ref } };
}

/** Added to native finalization: assistant.report alone is not repository review. */
export async function repositoryDevelopmentIncomplete(
  tx: Tx,
  rootRunId: string,
) {
  if (!(await repositoryReviewSchemaAvailable(tx))) return false;
  const [s] =
    await tx`select job_id from allrice_platform_repository_review_subjects where run_id=${rootRunId}`;
  if (!s) return false;
  const [job] = await tx<
    JobRow[]
  >`select * from allrice_jobs where id=${s.job_id}`;
  return !job || !(await repositoryReviewCompletionAllowed(tx, job, false));
}
