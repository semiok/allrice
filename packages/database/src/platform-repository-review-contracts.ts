import { z } from 'zod';
import {
  ChecksumSchema,
  UuidSchema,
  DevelopmentArtifactRefSchema,
} from '@allrice/contracts';
import {
  RepositoryPublicationSourceSchema,
  RepositoryPublicationRemoteSchema,
  RepositoryPublicationCiSchema,
} from './platform-repository-publication-contracts.ts';
import { RepositoryPublicationMetadataSchema } from './platform-repository-publication-contracts.ts';
import { RepairReportSchema } from './platform-repair-contracts.ts';

/** Platform adaptation of assistant.development, not an execution grant or a
 * Changeset. Identity and all verification material come from persisted facts. */
export const RepositoryReviewRequestSchema = z
  .object({
    requestId: UuidSchema,
    publicationId: UuidSchema,
    expectedSubjectDigest: ChecksumSchema,
    credentialRevision: z.number().int().positive(),
  })
  .strict();
export const RepositoryReviewEvidenceSchema = z
  .object({
    kind: z.literal('repository_ci'),
    subjectId: UuidSchema,
    evidenceDigest: ChecksumSchema,
  })
  .strict();
export const RepositoryReviewCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('inspect'),
      candidate: DevelopmentArtifactRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('assign'),
      expectedHead: DevelopmentArtifactRefSchema,
      ownerRunId: UuidSchema,
      role: z.literal('review'),
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      candidate: DevelopmentArtifactRefSchema,
      evidence: RepositoryReviewEvidenceSchema,
      verdict: z.enum(['accept', 'revise']),
      summary: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      action: z.literal('deliver'),
      candidate: DevelopmentArtifactRefSchema,
      reviewId: UuidSchema,
    })
    .strict(),
]);
export const RepositoryReviewMaterialSchema = z
  .object({
    version: z.literal(1),
    publicationId: UuidSchema,
    ownerId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    source: RepositoryPublicationSourceSchema,
    metadata: RepositoryPublicationMetadataSchema,
    remote: RepositoryPublicationRemoteSchema,
    // Observation time is retained for audit, never part of stable review identity.
    ci: RepositoryPublicationCiSchema,
    report: RepairReportSchema,
    beforeText: z.string().min(1).max(50000),
    authorRunIds: z.array(UuidSchema).min(1).max(16),
    subjectDigest: ChecksumSchema,
    evidenceDigest: ChecksumSchema,
    candidateContentDigest: ChecksumSchema,
  })
  .strict();
export type RepositoryReviewMaterial = z.infer<
  typeof RepositoryReviewMaterialSchema
>;
export type RepositoryReviewCommand = z.infer<
  typeof RepositoryReviewCommandSchema
>;

export const repositoryReviewTools = [
  'assistant.delegate',
  'assistant.development',
  'assistant.report',
  'assistant.stop',
] as const;
export const repositoryReviewConfiguration = {
  version: 1 as const,
  mode: 'daily' as const,
  allowAssistants: true,
  maxConcurrent: 1,
  maxDepth: 1,
  maxChildren: 1,
};
export const RepositoryReviewFrozenSchema =
  RepositoryReviewRequestSchema.extend({
    version: z.literal(1),
    material: RepositoryReviewMaterialSchema,
    loginSessionId: UuidSchema,
    loginAuthenticatedAt: z.string().datetime({ offset: true }),
    assignmentId: UuidSchema,
    employeeVersionId: UuidSchema,
    employeeRevisionId: UuidSchema,
    timeoutMs: z.literal(1800000),
    fingerprint: ChecksumSchema,
  }).strict();
export const RepositoryReviewBindingSchema = z
  .object({
    id: UuidSchema,
    inputDigest: ChecksumSchema,
    frozen: RepositoryReviewFrozenSchema,
  })
  .strict();
export type RepositoryReviewBinding = z.infer<
  typeof RepositoryReviewBindingSchema
>;

export const RepositoryReviewRemoteReceiptSchema = z
  .object({
    version: z.literal(1),
    stage: z.enum(['preflight', 'postflight']),
    subjectDigest: ChecksumSchema,
    evidenceDigest: ChecksumSchema,
    jobAttempt: z.number().int().positive(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const RepositoryReviewReadinessSchema = z
  .object({
    state: z.enum([
      'not_started',
      'pending',
      'unknown',
      'revise',
      'stale',
      'accepted',
    ]),
    subjectDigest: ChecksumSchema.nullable(),
    reasons: z
      .array(
        z.enum([
          'repository_authorization_required',
          'current_ci_required',
          'subject_changed',
          'independent_review_required',
          'revision_required',
          'review_not_complete',
          'authority_revoked',
          'canceled',
          'material_unavailable',
        ]),
      )
      .max(10),
    notice: z.literal(
      'Model review is an attributed opinion. Merge and Dev acceptance are separate gates.',
    ),
  })
  .strict();
export const RepositoryReviewViewSchema = z
  .object({
    id: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    sessionId: UuidSchema,
    subjectDigest: ChecksumSchema,
    candidateContentDigest: ChecksumSchema,
    status: z.enum([
      'queued',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'dead_letter',
    ]),
    reviewerRunId: UuidSchema.nullable(),
    employeeVersionId: UuidSchema,
    verdict: z.enum(['accept', 'revise']).nullable(),
    summary: z.string().max(16000).nullable(),
    reviewArtifactId: UuidSchema.nullable(),
    deliveryArtifactId: UuidSchema.nullable(),
    errorCode: z.string().max(200).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    remoteVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export const RepositoryReviewPanelSchema = z
  .object({
    publicationId: UuidSchema,
    canStart: z.boolean(),
    subjectDigest: ChecksumSchema.nullable(),
    readiness: RepositoryReviewReadinessSchema,
    reviews: z.array(RepositoryReviewViewSchema).max(20),
  })
  .strict();
