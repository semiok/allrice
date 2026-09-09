import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { MemoryClassSchema } from './operations.ts';

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
  })
  .strict();
export type ExperienceCandidate = z.infer<typeof ExperienceCandidateSchema>;
export type CreateExperienceInput = z.infer<typeof CreateExperienceInputSchema>;
