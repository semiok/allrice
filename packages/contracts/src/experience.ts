import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { MemoryClassSchema } from './operations.ts';
import { PersonalSkillPinSchema } from './personal-skills.ts';

/** Platform Skills keep their separate source/license/test/publication gate. */
export const ExperienceScopeSchema = z.enum([
  'private',
  'workspace',
  'platform',
]);
export const ExperienceStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
]);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ExperienceCollectionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
    collectionStartedAt: TimestampSchema,
    authorizationSource: z.literal('platform_automatic_experience_policy'),
  })
  .strict();
export const ExperienceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyRevision: z.number().int().positive(),
    collectionStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
    kind: z.enum(['correction', 'explicit_feedback']),
    messageId: UuidSchema,
    runId: UuidSchema,
    relatedRunId: UuidSchema.nullable(),
    // Captured identity, not a claim that an installed/registered skill ran.
    skills: z
      .array(
        z
          .object({
            runId: UuidSchema,
            eventId: UuidSchema,
            pin: PersonalSkillPinSchema,
          })
          .strict(),
      )
      .max(16),
    artifacts: z
      .array(
        z
          .object({
            runId: UuidSchema,
            versionId: UuidSchema,
            objectId: UuidSchema,
            checksum: DigestSchema,
          })
          .strict(),
      )
      .max(32),
    inputs: z
      .array(
        z
          .object({
            messageId: UuidSchema,
            objectId: UuidSchema,
            checksum: DigestSchema,
          })
          .strict(),
      )
      .max(32),
    // Available frozen context is deliberately distinct from actual tool reads.
    availableKnowledge: z
      .array(
        z
          .object({
            runId: UuidSchema,
            revisionId: UuidSchema,
            checksum: DigestSchema,
          })
          .strict(),
      )
      .max(64),
    truncated: z.boolean(),
  })
  .strict();
export type ExperienceEvidence = z.infer<typeof ExperienceEvidenceSchema>;
export const CreateExperienceInputSchema = z
  .object({
    clientRequestId: UuidSchema,
    runId: UuidSchema,
    messageId: UuidSchema,
    sourceExcerpt: z.string().trim().min(1).max(4000),
    content: z.string().trim().min(1).max(4000),
    memoryClass: MemoryClassSchema,
    scope: ExperienceScopeSchema,
    shareAcknowledged: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope !== 'private' && !value.shareAcknowledged)
      ctx.addIssue({
        code: 'custom',
        path: ['shareAcknowledged'],
        message:
          'Sharing the exact rewritten rule requires explicit owner consent',
      });
  });
export const ReviewExperienceInputSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    expectedRevision: z.number().int().positive(),
    expectedDigest: DigestSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const ExperienceCandidateSchema = z
  .object({
    id: UuidSchema,
    content: z.string().max(4000),
    memoryClass: MemoryClassSchema,
    scope: ExperienceScopeSchema,
    status: ExperienceStatusSchema,
    archived: z.boolean(),
    revision: z.number().int().positive(),
    digest: DigestSchema,
    source: z
      .object({
        runId: UuidSchema,
        sessionId: UuidSchema,
        messageId: UuidSchema,
        excerpt: z.string().max(4000),
        digest: DigestSchema,
      })
      .strict()
      .nullable(),
    ownedByMe: z.boolean(),
    canReview: z.boolean(),
    createdAt: TimestampSchema,
    reviewedAt: TimestampSchema.nullable(),
    reviewReason: z.string().max(500).nullable(),
    originKind: z.enum(['manual', 'incremental']).optional(),
    instanceId: UuidSchema.nullable().optional(),
    evidence: ExperienceEvidenceSchema.nullable().optional(),
  })
  .strict();
export type ExperienceCandidate = z.infer<typeof ExperienceCandidateSchema>;
export type CreateExperienceInput = z.infer<typeof CreateExperienceInputSchema>;
