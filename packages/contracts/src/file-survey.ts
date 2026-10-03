import { z } from 'zod';
import { isRuntimeRelativePath } from './runtime-v2/policy.ts';

/** A bounded, read-only survey within the already selected folder grant. */
export const LocalFileSurveyInputSchema = z
  .object({
    mode: z.enum(['files', 'duplicates', 'compare']).default('files'),
    comparePath: z.string().max(1024).refine(isRuntimeRelativePath).optional(),
    nameContains: z.string().min(1).max(120).optional(),
    extensions: z
      .array(z.string().regex(/^[a-zA-Z0-9]{1,20}$/))
      .max(20)
      .optional(),
    minimumBytes: z.number().int().nonnegative().optional(),
    maximumBytes: z.number().int().nonnegative().optional(),
    modifiedAfter: z.iso.datetime().optional(),
    modifiedBefore: z.iso.datetime().optional(),
    hash: z.boolean().default(false),
    maximumEntries: z.number().int().min(1).max(2000).default(1000),
    maximumHashBytes: z
      .number()
      .int()
      .min(1)
      .max(128_000_000)
      .default(64_000_000),
  })
  .strict()
  .refine(
    (p) =>
      p.mode !== 'compare' ||
      (p.maximumEntries >= 2 && p.maximumHashBytes >= 2),
    'compare requires a budget for both directories',
  )
  .refine(
    (p) => (p.mode === 'compare') === (p.comparePath !== undefined),
    'compare requires exactly one second relative directory',
  )
  .refine(
    (p) =>
      p.minimumBytes === undefined ||
      p.maximumBytes === undefined ||
      p.minimumBytes <= p.maximumBytes,
    'invalid size range',
  )
  .refine(
    (p) =>
      !p.modifiedAfter ||
      !p.modifiedBefore ||
      Date.parse(p.modifiedAfter) <= Date.parse(p.modifiedBefore),
    'invalid time range',
  );
export type LocalFileSurveyInput = z.infer<typeof LocalFileSurveyInputSchema>;
