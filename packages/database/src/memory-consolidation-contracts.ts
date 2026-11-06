import { z } from 'zod';
import {
  MemorySourceEvidenceSchema,
  MemoryDraftOutputSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  ExperienceOccurrenceSchema,
  ExperienceExecutionSchema,
  ExperienceReceiptSchema,
} from './experience-consolidation-contracts.ts';

/** Version the business documents only. Native binding/consumer and PG states are unchanged. */
export const MemoryOccurrenceSchema = ExperienceOccurrenceSchema.extend({
  schemaVersion: z.literal(2),
  currentRules: ExperienceOccurrenceSchema.shape.currentRules
    .extend({
      confirmedMemories: z.array(
        z
          .object({
            id: UuidSchema,
            revision: z.number().int().positive(),
            content: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  sources: z
    .array(
      ExperienceOccurrenceSchema.shape.sources.element
        .extend({
          evidence: MemorySourceEvidenceSchema,
        })
        .strict(),
    )
    .max(16),
}).strict();
export type MemoryOccurrence = z.infer<typeof MemoryOccurrenceSchema>;
export const MemoryExecutionSchema = ExperienceExecutionSchema.extend({
  schemaVersion: z.literal(2),
}).strict();
// No pending_validation state: this output never enters the retired validator/adopter.
export const MemoryReceiptSchema = ExperienceReceiptSchema.omit({ state: true })
  .extend({
    schemaVersion: z.literal(2),
    output: MemoryDraftOutputSchema,
  })
  .strict();

export function assertMemoryBatchBounds(occurrence: MemoryOccurrence) {
  if (
    occurrence.sources.reduce((n, source) => n + source.excerpt.length, 0) >
    32000
  )
    throw Error('MEMORY_SOURCE_INPUT_LIMIT');
  if (
    Buffer.byteLength(JSON.stringify(occurrence.currentRules), 'utf8') > 16000
  )
    throw Error('MEMORY_CURRENT_RULES_LIMIT');
}
