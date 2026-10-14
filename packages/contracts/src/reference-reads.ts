import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { KnowledgeCitationSchema } from './knowledge.ts';
import { ReferenceSelectionSchema } from './reference-library.ts';

/** Evidence of bounded excerpts returned to an authorized execution, not an
 * assertion that the whole file was read or that the model used every excerpt. */
export const ReferenceReadSchema = z
  .object({
    receiptId: UuidSchema,
    origin: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('explicit') }).strict(),
      z.object({ kind: z.literal('common') }).strict(),
      z
        .object({
          kind: z.literal('scene'),
          sceneId: UuidSchema,
          sceneDigest: ChecksumSchema,
        })
        .strict(),
    ]),
    citation: KnowledgeCitationSchema.extend({
      reference: ReferenceSelectionSchema,
      referenceLabel: z.string().regex(/^R[1-9]\d?$/),
    }),
    contentChecksum: ChecksumSchema,
    runId: UuidSchema,
    generationId: UuidSchema,
    jobId: UuidSchema,
    workerId: z.string().min(1).max(255),
    readAt: TimestampSchema,
  })
  .strict();
export type ReferenceRead = z.infer<typeof ReferenceReadSchema>;
export const ReferenceReadsSchema = z
  .array(ReferenceReadSchema)
  .max(64)
  .superRefine((reads, ctx) => {
    if (
      new Set(reads.map((r) => r.receiptId)).size !== reads.length ||
      reads.some(
        (r, i) =>
          r.citation.id !== r.receiptId ||
          r.citation.referenceLabel !== `R${i + 1}` ||
          r.citation.knowledgeRevisionId !== r.citation.reference.revisionId ||
          r.runId !== reads[0]?.runId ||
          r.generationId !== reads[0]?.generationId,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Reference receipts must retain stable Run identity and labels',
      });
  });
