import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { ReferenceRevisionSchema } from './reference-library.ts';

// Reuse the existing file reader page size and reference retrieval fan-out.
// Search is literal text, never an interpretation of the user's authorization.
export const referenceSearchPolicy = {
  maximumQueryCharacters: 1000,
  maximumResults: 6,
  excerptCharacters: 800,
  readCharacters: 4000,
  maximumInlineCharacters: 12_000,
} as const;

export const ReferenceSearchCategorySchema = z.enum([
  'all',
  'company',
  'departments',
  'mine',
]);
export const ReferenceSearchCursorSchema = z
  .object({
    queryDigest: ChecksumSchema,
    createdAt: TimestampSchema,
    sourceId: UuidSchema,
  })
  .strict();

export const ReferencePublicationQuerySchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(referenceSearchPolicy.maximumQueryCharacters)
      .default(''),
    category: ReferenceSearchCategorySchema.default('all'),
    sourceId: UuidSchema.optional(),
    cursor: ReferenceSearchCursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ReferencePublicationQuery = z.infer<
  typeof ReferencePublicationQuerySchema
>;

/** Natural positions refer to the immutable extracted text, in UTF-16 units,
 * matching R2's persisted start/end offsets. No file path grants access. */
export const ReferenceTextLocationSchema = z
  .object({
    unit: z.number().int().nonnegative(),
    label: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    pageNumber: z.number().int().positive().optional(),
    sheetName: z.string().optional(),
  })
  .strict();
export type ReferenceTextLocation = z.infer<typeof ReferenceTextLocationSchema>;

export const ReferenceFullTextCoverageSchema = z
  .object({
    ready: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  })
  .strict();

export const ReferencePublicationQueryResultSchema = z
  .object({
    references: z.array(ReferenceRevisionSchema),
    nextCursor: ReferenceSearchCursorSchema.nullable(),
    matches: z.array(
      z
        .object({
          revisionId: UuidSchema,
          content: z.string().max(referenceSearchPolicy.excerptCharacters),
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          locations: z.array(ReferenceTextLocationSchema),
        })
        .strict(),
    ),
    // Counts only currently authorized publications in this category, before
    // text matching. An incomplete index must not masquerade as no matches.
    fullTextCoverage: ReferenceFullTextCoverageSchema,
  })
  .strict();

export const ReferenceSearchInputSchema = ReferencePublicationQuerySchema.omit({
  sourceId: true,
  limit: true,
})
  .extend({
    query: z
      .string()
      .trim()
      .min(1)
      .max(referenceSearchPolicy.maximumQueryCharacters),
    limit: z
      .number()
      .int()
      .min(1)
      .max(referenceSearchPolicy.maximumResults)
      .default(3),
  })
  .strict();
export type ReferenceSearchInput = z.infer<typeof ReferenceSearchInputSchema>;

export const ReferenceReadInputSchema = z
  .object({
    sourceId: UuidSchema,
    revisionId: UuidSchema,
    digest: ChecksumSchema,
    checksum: ChecksumSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(referenceSearchPolicy.readCharacters)
      .default(referenceSearchPolicy.readCharacters),
  })
  .strict();
export type ReferenceReadInput = z.infer<typeof ReferenceReadInputSchema>;
