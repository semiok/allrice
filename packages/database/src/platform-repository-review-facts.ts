import type postgres from 'postgres';
import type { DevelopmentArtifactRef } from '@allrice/contracts';
import type { RepositoryReviewMaterial } from './platform-repository-review-contracts.ts';

/** Serializes verdict insertion and consumption across every subject with the
 * same owner and candidate bytes. Acquire after root and authority locks. */
export async function lockRepositoryReviewContent(
  tx: postgres.TransactionSql,
  ownerId: string,
  contentDigest: string,
) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`repository-review-content:${ownerId}:${contentDigest}`},0))`;
}

// Preserve the original property order and JSON encoding of saved artifacts.
export function repositoryReviewOpinion(
  id: string,
  candidate: DevelopmentArtifactRef,
  material: RepositoryReviewMaterial,
  reviewerRunId: string,
  verdict: 'accept' | 'revise',
  summary: string,
) {
  return {
    id,
    candidate,
    subjectDigest: material.subjectDigest,
    evidenceDigest: material.evidenceDigest,
    reviewerRunId,
    verdict,
    summary,
    applied: false,
  };
}

export function repositoryReviewDelivery(
  candidate: DevelopmentArtifactRef,
  material: RepositoryReviewMaterial,
  reviewId: string,
  reviewerRunId: string,
  summary: string,
) {
  return {
    candidate,
    subjectDigest: material.subjectDigest,
    evidenceDigest: material.evidenceDigest,
    reviewId,
    reviewerRunId,
    verdict: 'accept' as const,
    summary,
    applied: false,
    notice:
      'Model review is an attributed opinion. Merge and Dev acceptance are separate gates.',
  };
}
