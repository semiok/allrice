import type {
  RepositoryReviewPanelSchema,
  RepositoryReviewMaterial,
} from './platform-repository-review-contracts.ts';
import type { z } from 'zod';
type Review = z.infer<typeof RepositoryReviewPanelSchema>['reviews'][number];
/** Presentation of attributed evidence, never a merge/deploy authorization. */
export function repositoryReviewReadiness(
  material: RepositoryReviewMaterial | null,
  reviews: Review[],
  rejection: boolean,
  reason?:
    | 'repository_authorization_required'
    | 'current_ci_required'
    | 'material_unavailable',
) {
  const notice =
    'Model review is an attributed opinion. Merge and Dev acceptance are separate gates.' as const;
  const common = { subjectDigest: material?.subjectDigest ?? null, notice };
  if (!material)
    return {
      ...common,
      state: 'unknown' as const,
      reasons: [reason ?? 'material_unavailable'],
    };
  if (rejection)
    return {
      ...common,
      state: 'revise' as const,
      reasons: ['revision_required' as const],
    };
  const current = reviews.find(
    (r) => r.subjectDigest === material.subjectDigest,
  );
  if (!current)
    return {
      ...common,
      state: reviews.length ? ('stale' as const) : ('not_started' as const),
      reasons: [
        reviews.length
          ? ('subject_changed' as const)
          : ('independent_review_required' as const),
      ],
    };
  if (current.status === 'queued' || current.status === 'running')
    return {
      ...common,
      state: 'pending' as const,
      reasons: ['review_not_complete' as const],
    };
  if (current.status !== 'succeeded')
    return {
      ...common,
      state: 'unknown' as const,
      reasons: [
        current.status === 'canceled'
          ? ('canceled' as const)
          : ('review_not_complete' as const),
      ],
    };
  if (current.verdict === 'revise')
    return {
      ...common,
      state: 'revise' as const,
      reasons: ['revision_required' as const],
    };
  if (
    current.verdict === 'accept' &&
    current.remoteVerifiedAt &&
    current.reviewerRunId &&
    current.reviewArtifactId &&
    current.deliveryArtifactId &&
    current.reviewerRunId !== current.runId &&
    !material.authorRunIds.includes(current.reviewerRunId)
  )
    return { ...common, state: 'accepted' as const, reasons: [] };
  return {
    ...common,
    state: 'unknown' as const,
    reasons: ['independent_review_required' as const],
  };
}
