import { z } from 'zod';
import { ChecksumSchema, UuidSchema } from '@allrice/contracts';
import {
  RepositoryGitShaSchema,
  RepositoryPublicationCiSchema,
} from './platform-repository-publication-contracts.ts';
import {
  RepositoryReviewMaterialSchema,
  RepositoryReviewRemoteReceiptSchema,
} from './platform-repository-review-contracts.ts';

export const repositoryMergeJobType =
  'allrice.platform.repository.merge' as const;
export const RepositoryMergeRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('merge'),
      requestId: UuidSchema,
      publicationId: UuidSchema,
      reviewSubjectId: UuidSchema,
      expectedSubjectDigest: ChecksumSchema,
      credentialRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal('reconcile'),
      requestId: UuidSchema,
      mergeId: UuidSchema,
      credentialRevision: z.number().int().positive(),
    })
    .strict(),
]);
export const RepositoryCompletedReviewSchema = z
  .object({
    version: z.literal(1),
    subjectId: UuidSchema,
    reviewId: UuidSchema,
    reviewRunId: UuidSchema,
    reviewJobId: UuidSchema,
    reviewerRunId: UuidSchema,
    employeeVersionId: UuidSchema,
    employeeRevisionId: UuidSchema,
    assignmentId: UuidSchema,
    reviewAttempt: z.number().int().positive(),
    frozenFingerprint: ChecksumSchema,
    inputDigest: ChecksumSchema,
    rootNativeSessionId: z.string().min(1).max(200),
    reviewerNativeSessionId: z.string().min(1).max(200),
    seed: z.object({ id: UuidSchema, checksum: ChecksumSchema }).strict(),
    opinion: z.object({ id: UuidSchema, checksum: ChecksumSchema }).strict(),
    delivery: z.object({ id: UuidSchema, checksum: ChecksumSchema }).strict(),
    reportDeliveryId: UuidSchema,
    adoptedSeq: z.number().int().nonnegative(),
    parentMessageId: z.string().min(1).max(200),
    reportInputDigest: ChecksumSchema,
    reportPayloadDigest: ChecksumSchema,
    preflight: RepositoryReviewRemoteReceiptSchema,
    postflight: RepositoryReviewRemoteReceiptSchema,
    material: RepositoryReviewMaterialSchema,
    factsDigest: ChecksumSchema,
  })
  .strict();
export type RepositoryCompletedReview = z.infer<
  typeof RepositoryCompletedReviewSchema
>;
export const RepositoryMergeBindingSchema = z
  .object({
    id: UuidSchema,
    mergeId: UuidSchema,
    request: RepositoryMergeRequestSchema,
    inputDigest: ChecksumSchema,
    review: RepositoryCompletedReviewSchema,
    loginSessionId: UuidSchema,
    loginAuthenticatedAt: z.string().datetime({ offset: true }),
    timeoutMs: z.literal(300000),
  })
  .strict();
export type RepositoryMergeBinding = z.infer<
  typeof RepositoryMergeBindingSchema
>;
export const RepositoryMergePreflightSchema = z
  .object({
    policy: z
      .object({
        version: z.literal(1),
        kind: z.literal('strict_protected_main'),
        digest: ChecksumSchema,
      })
      .strict(),
    ci: RepositoryPublicationCiSchema.refine((ci) => ci.state === 'passed'),
    pull: z
      .object({
        number: z.number().int().positive(),
        url: z
          .string()
          .regex(/^https:\/\/github\.com\/semiok\/allrice\/pull\/[1-9]\d*$/),
        headSha: RepositoryGitShaSchema,
        baseSha: RepositoryGitShaSchema,
        draft: z.boolean(),
        state: z.literal('open'),
        nodeId: z.string().min(1).max(200),
        merged: z.literal(false),
        mergeSha: z.null(),
      })
      .strict(),
  })
  .strict();
export const RepositoryMergeReceiptSchema = z
  .object({
    version: z.literal(1),
    publicationId: UuidSchema,
    pullNumber: z.number().int().positive(),
    subjectDigest: ChecksumSchema,
    baseSha: RepositoryGitShaSchema,
    headSha: RepositoryGitShaSchema,
    mergeSha: RepositoryGitShaSchema,
    mergeTree: RepositoryGitShaSchema,
    observedMainSha: RepositoryGitShaSchema,
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const RepositoryMergeViewSchema = z
  .object({
    id: UuidSchema,
    publicationId: UuidSchema,
    reviewSubjectId: UuidSchema,
    subjectDigest: ChecksumSchema,
    readyStarted: z.boolean(),
    mergeStarted: z.boolean(),
    receipt: RepositoryMergeReceiptSchema.nullable(),
    actions: z
      .array(
        z
          .object({
            id: UuidSchema,
            requestId: UuidSchema,
            action: z.enum(['merge', 'reconcile']),
            runId: UuidSchema,
            jobId: UuidSchema,
            status: z.enum([
              'queued',
              'running',
              'succeeded',
              'failed',
              'canceled',
            ]),
            errorCode: z.string().max(120).nullable(),
            createdAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .max(20),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const RepositoryMergePanelSchema = z
  .object({
    publicationId: UuidSchema,
    canStart: z.boolean(),
    reviewSubjectId: UuidSchema.nullable(),
    subjectDigest: ChecksumSchema.nullable(),
    reason: z
      .enum([
        'automatic_merge_disabled',
        'repository_authorization_required',
        'completed_review_required',
        'merge_active',
        'merge_started_reconcile_only',
        'started_review_fixed',
        'merged',
        'review_invalid',
      ])
      .nullable(),
    merges: z.array(RepositoryMergeViewSchema).max(20),
  })
  .strict();
