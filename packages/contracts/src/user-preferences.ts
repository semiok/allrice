import { z } from 'zod';

// DSH ui-theme / ui-chat @ 0.2.1-rc.2 presentation values. These belong to
// the signed-in account, never an employee's frozen execution configuration.
const FontSizeSchema = z.number().int().min(10).max(22);
export const TranscriptViewSchema = z.enum([
  'compact',
  'standard',
  'detailed',
  'verbose',
]);
export const CollapseTimingSchema = z.enum(['completion', 'next-input']);

export const UserPreferencesInputSchema = z
  .object({
    streamingOutput: z.boolean().optional(),
    fontSize: FontSizeSchema.optional(),
    transcriptView: TranscriptViewSchema.optional(),
    collapseTiming: CollapseTimingSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'At least one preference is required',
    },
  );
export type UserPreferencesInput = z.infer<typeof UserPreferencesInputSchema>;

export const UserPreferencesSchema = z.object({
  streamingOutput: z.boolean(),
  fontSize: FontSizeSchema.default(14),
  transcriptView: TranscriptViewSchema.default('detailed'),
  collapseTiming: CollapseTimingSchema.default('completion'),
  updatedAt: z.string().datetime().nullable(),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const defaultUserPreferences: UserPreferences = {
  streamingOutput: true,
  fontSize: 14,
  transcriptView: 'detailed',
  collapseTiming: 'completion',
  updatedAt: null,
};
