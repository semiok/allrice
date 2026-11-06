import { z } from 'zod';
import { UuidSchema } from './common.ts';

/** Business classification is supplied by the model, never inferred by words. */
export const MemoryDraftOutputSchema = z
  .object({
    schemaVersion: z.literal(2),
    drafts: z
      .array(
        z
          .object({
            sourceIds: z.array(UuidSchema).min(1).max(16),
            category: z.enum([
              'personal_habit',
              'business_preference',
              'workflow_or_resource_entry',
            ]),
            content: z
              .string()
              .trim()
              .min(1)
              .refine(
                (text) => new TextEncoder().encode(text).byteLength <= 1000,
                'Memory draft exceeds 1000 UTF-8 bytes',
              ),
            reason: z.string().trim().min(1).max(800),
          })
          .strict(),
      )
      .max(8),
    discarded: z
      .array(
        z
          .object({
            sourceIds: z.array(UuidSchema).min(1).max(16),
            category: z.enum([
              'profile_owned',
              'not_reusable',
              'conflict',
              'insufficient_evidence',
            ]),
            reason: z.string().trim().min(1).max(800),
          })
          .strict(),
      )
      .max(16),
    suggestions: z
      .array(
        z
          .object({
            sourceIds: z.array(UuidSchema).min(1).max(16),
            category: z.enum([
              'company_fact',
              'work_product',
              'workflow_steps',
            ]),
            reason: z.string().trim().min(1).max(800),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export type MemoryDraftOutput = z.infer<typeof MemoryDraftOutputSchema>;

/** References are exact input identities; rules used for conflict checks are not sources. */
export function validateMemoryDraftOutput(
  raw: unknown,
  sourceIds: readonly string[],
) {
  const output = MemoryDraftOutputSchema.parse(raw);
  const consumed = [
    ...output.drafts,
    ...output.discarded,
    ...output.suggestions,
  ].flatMap((item) => item.sourceIds);
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    consumed.length !== sourceIds.length ||
    new Set(consumed).size !== consumed.length ||
    consumed.some((id) => !sourceIds.includes(id))
  )
    throw Error('MEMORY_DRAFT_SOURCE_MISMATCH');
  return output;
}
