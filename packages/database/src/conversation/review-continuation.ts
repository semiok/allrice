import type { TransactionSql } from 'postgres';
import {
  ReviewContinuationInputSchema,
  ReviewFeedbackSchema,
  type ReviewContinuationInput,
} from '@allrice/contracts';
import {
  ArtifactReviewError,
  assertWorkbenchSession,
  readArtifact,
  workbenchEnabled,
  type WorkbenchPrincipal,
} from '../artifact-review.ts';
import { getDatabase } from '../core/client.ts';

export async function assertReviewRunCurrent(
  principal: WorkbenchPrincipal,
  sessionId: string,
  runId: string,
) {
  const db = getDatabase();
  await db.begin(async (tx) => {
    const [row] = await tx<
      { artifact_id: string; checksum: string }[]
    >`select artifact_id,checksum from allrice_review_continuations
      where run_id=${runId} and organization_id=${principal.organizationId} and workspace_id=${principal.workspaceId!}
      and session_id=${sessionId} and actor_id=${principal.actor.id}`;
    if (!row) return;
    await assertWorkbenchSession(tx, principal, sessionId, true);
    const artifact = await readArtifact(
      tx,
      principal,
      sessionId,
      row.artifact_id,
    );
    if (artifact.stale || artifact.object.checksum !== row.checksum)
      throw new ArtifactReviewError('review_version_changed');
  });
}

/** Called inside both message admission and Run insertion transactions. The
 * session lock serializes version publication; no plan/feedback grants a tool. */
export async function prepareReviewContinuation(
  tx: TransactionSql,
  principal: WorkbenchPrincipal,
  sessionId: string,
  raw: ReviewContinuationInput,
) {
  if (!workbenchEnabled()) throw new ArtifactReviewError('workbench_disabled');
  const review = ReviewContinuationInputSchema.parse(raw);
  await assertWorkbenchSession(tx, principal, sessionId, true);
  const artifact = await readArtifact(
    tx,
    principal,
    sessionId,
    review.artifactId,
  );
  if (artifact.stale || artifact.object.checksum !== review.checksum)
    throw new ArtifactReviewError('version_conflict');
  let instruction: string;
  if (review.kind === 'plan_review') {
    if (artifact.kind !== 'plan')
      throw new ArtifactReviewError('plan_required');
    instruction =
      '用户认可本版计划，请依据该版本继续规划后续工作。这不是文件写入、命令、网络或其他动作的批准；仍须经过各自策略与审批。';
  } else {
    const [feedback] = await tx<{ comments: unknown; revision: number }[]>`
      select comments,revision from allrice_artifact_feedback where id=${review.feedbackId}
      and organization_id=${principal.organizationId} and workspace_id=${principal.workspaceId!}
      and actor_id=${principal.actor.id} and artifact_id=${artifact.id} and checksum=${review.checksum}
      and state='submitted' for share`;
    if (!feedback) throw new ArtifactReviewError('submitted_feedback_required');
    const comments = ReviewFeedbackSchema.shape.comments.parse(
      feedback.comments,
    );
    instruction = `请根据以下用户反馈生成后续版本，保留原版本与反馈来源，不将反馈视为动作授权。\n${JSON.stringify(comments)}`;
  }
  const text = `${instruction}\n工件：${artifact.version.fileName} v${artifact.version.version}\nArtifact ID: ${artifact.id}\nObject ID: ${artifact.object.id}\nChecksum: ${artifact.object.checksum}`;
  if (text.length > 40_000) throw new ArtifactReviewError('feedback_too_large');
  return { artifact, text };
}
