import {
  runtimeContractEqual,
  runtimeFeatureEnabled,
  type ExecutionContext,
  type StoragePort,
  type DevelopmentArtifactRef,
} from '@allrice/contracts';
import type { getDatabase } from './core/client.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
import type { RepositoryActionLease } from './platform-repository-publication-authority.ts';
import { publishWorkbenchArtifact } from './artifact-review.ts';
import { repositoryDigest } from './platform-repository-source.ts';
import {
  lockRepositoryReviewContent,
  repositoryReviewOpinion,
  repositoryReviewDelivery,
} from './platform-repository-review-facts.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  RepositoryReviewCommandSchema,
  RepositoryReviewFrozenSchema,
} from './platform-repository-review-contracts.ts';
import {
  assertRepositoryReviewLease,
  isRepositoryReviewJobAuthorized,
} from './platform-repository-review-authority.ts';
import type { JobRow } from './queue/row-mappers.ts';

type Tx = RuntimeLedgerTransaction;
function fail(reason: string): never {
  throw Error(`repository_review_${reason}`);
}

/** Business tool on the normal Employee/Job path. No assistant runtime,
 * delegated report or extra execution state is involved. */
export async function executeRepositoryReview(
  input: {
    context: ExecutionContext;
    worker: RepositoryActionLease;
    requestId: string;
    arguments: unknown;
  },
  storage: StoragePort,
  database: ReturnType<typeof getDatabase>,
): Promise<unknown> {
  if (!runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED')) fail('disabled');
  const args = RepositoryReviewCommandSchema.parse(input.arguments);
  if (
    input.context.jobId !== input.worker.jobId ||
    input.context.worker.id !== input.worker.workerId
  )
    fail('forbidden');
  const admit = async (tx: Tx) => {
    const [job] = await tx<JobRow[]>`select * from allrice_jobs
      where id=${input.worker.jobId} and run_id=${input.context.runId}
      and owner_id=${input.context.policySnapshot.subjectId} and organization_id=${input.context.organizationId} and workspace_id=${input.context.workspaceId!}
      and worker_id=${input.worker.workerId} and lease_token=${input.worker.leaseToken} and attempt=${input.worker.attempt}`;
    if (!job || !(await isRepositoryReviewJobAuthorized(tx, job)))
      fail('forbidden');
    await assertRepositoryReviewLease(tx, job);
  };
  const current = async (tx: Tx) => {
    await admit(tx);
    const [s] =
      await tx`select * from allrice_platform_repository_review_subjects
      where run_id=${input.context.runId} and job_id=${input.worker.jobId} for update`;
    if (!s || s.reviewer_run_id !== input.context.runId)
      fail('independent_reviewer_required');
    return s;
  };
  const subject = await database.begin(current);
  const f = RepositoryReviewFrozenSchema.parse(subject.frozen),
    material = f.material;
  const seedBytes = Buffer.from(JSON.stringify(material, null, 2)),
    seedDigest = repositoryDigest(seedBytes);
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
      join allrice_workbench_artifacts w on w.version_id=v.id and w.run_id=${input.context.runId} and w.kind='document'
      where v.id=${candidate.artifactId} and v.owner_id=${material.ownerId} and v.organization_id=${material.organizationId} and v.workspace_id=${material.workspaceId}
      and v.session_id=${subject.session_id} and o.state='ready' and o.immutable and o.deleted_at is null and o.checksum=${candidate.digest}
      and not exists(select 1 from allrice_deliverable_versions n where n.series_id=v.series_id and n.version>v.version) for share of v,o,w`;
    if (!a) fail('material_unavailable');
    return s;
  };
  if (args.action === 'inspect') {
    let s = await database.begin(current);
    if (!s.seed_artifact_id) {
      await publishWorkbenchArtifact(
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
        database,
        {
          requiredTool: 'workspace.export.create',
          runId: input.context.runId,
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
      s = await database.begin(current);
    }
    const candidate = {
      artifactId: s.seed_artifact_id as string,
      digest: seedDigest,
    };
    const result = await database.begin(async (tx) => {
      const c = await reference(tx, args.candidate ?? candidate);
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
    return result;
  }
  const requestDigest = technicalDigest({
    requestId: input.requestId,
    arguments: args,
  });
  const verify = async (tx: Tx) => {
    const s = await reference(tx, args.candidate);
    const [r] =
      await tx`select * from allrice_platform_repository_reviews where subject_id=${s.id}`;
    if (args.action === 'review') {
      if (
        input.context.runId !== s.reviewer_run_id ||
        args.evidence.subjectId !== s.id ||
        args.evidence.evidenceDigest !== material.evidenceDigest
      )
        fail('evidence_mismatch');
      if (r && (r.id !== input.requestId || r.request_digest !== requestDigest))
        fail('review_conflict');
      return repositoryReviewOpinion(
        input.requestId,
        args.candidate,
        material,
        s.reviewer_run_id as string,
        args.verdict,
        args.summary,
      );
    }
    if (!r || r.id !== args.reviewId || r.verdict !== 'accept')
      fail('accepted_review_required');
    const [rejected] =
      await tx`select r.id from allrice_platform_repository_reviews r join allrice_platform_repository_review_subjects s on s.id=r.subject_id
      where s.owner_id=${material.ownerId} and s.content_digest=${material.candidateContentDigest} and r.verdict='revise' limit 1`;
    if (rejected) fail('revision_required');
    return repositoryReviewDelivery(
      args.candidate,
      material,
      r.id as string,
      s.reviewer_run_id as string,
      r.summary as string,
    );
  };
  const result = await database.begin(verify);
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
          ? '独立仓库审查 Job 的候选审查意见。'
          : '准确候选的审查交付记录；合并与 Dev 验收另行执行。',
    },
    storage,
    database,
    {
      requiredTool: 'workspace.export.create',
      runId: input.context.runId,
      admit: async (tx) => {
        await verify(tx);
      },
      registered: async (tx, artifactId) => {
        await verify(tx);
        await lockRepositoryReviewContent(
          tx,
          material.ownerId,
          material.candidateContentDigest,
        );
        // The actual registration transaction, not only the initial preview,
        // participates in the same-content verdict/merge boundary.
        if (args.action === 'review') {
          await tx`insert into allrice_platform_repository_reviews(id,subject_id,reviewer_run_id,request_digest,verdict,summary,evidence_digest,artifact_id)
          values(${input.requestId},${subject.id},${result.reviewerRunId},${requestDigest},${args.verdict},${args.summary},${material.evidenceDigest},${artifactId}) on conflict(id) do nothing`;
        } else {
          const [rejected] =
            await tx`select r.id from allrice_platform_repository_reviews r join allrice_platform_repository_review_subjects s on s.id=r.subject_id
            where s.owner_id=${material.ownerId} and s.content_digest=${material.candidateContentDigest} and r.verdict='revise' limit 1`;
          if (rejected) fail('revision_required');
          await tx`update allrice_platform_repository_review_subjects set delivery_artifact_id=${artifactId} where id=${subject.id}`;
        }
      },
    },
  );
  const ref = { artifactId: artifact.id, digest: artifact.object.checksum! };
  return { ...result, artifact: ref };
}
