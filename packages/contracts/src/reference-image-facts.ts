import { z } from 'zod';
import { ChecksumSchema } from './runs.ts';

/** Immutable server inspection, not permission or a complete decode receipt. */
export const ReferenceImageFactsSchema = z
  .object({
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().positive(),
    mediaType: z.enum(['image/png', 'image/jpeg']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    static: z.literal(true),
  })
  .strict();
export type ReferenceImageFacts = z.infer<typeof ReferenceImageFactsSchema>;
export const ReferenceReadCapabilitiesSchema = z
  .object({
    text: z.boolean(),
    image: z.boolean(),
    archive: z.boolean(),
  })
  .strict();
