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
// Values follow DSH ui-theme `THEME_PREFERENCES` (`ui-theme.preference`).
// The employee default is light by the user's 10-27 decision; DSH's own
// default is `system`. The value applies to the employee app only.
export const AppearanceSchema = z.enum(['light', 'dark', 'system']);
export type Appearance = z.infer<typeof AppearanceSchema>;

// MET-210 PR2 (263c5b0f): reuse these contracts when adding preference writers.
export const QuestionWaitSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }).strict(),
  z
    .object({
      mode: z.literal('timed'),
      seconds: z.number().int().min(1).max(2_147_483),
    })
    .strict(),
  z.object({ mode: z.literal('forever') }).strict(),
]);
export type QuestionWait = z.infer<typeof QuestionWaitSchema>;
export const SubagentPreferencesSchema = z
  .object({
    maxDepth: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxActive: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SubagentPreferences = z.infer<typeof SubagentPreferencesSchema>;
export const NativePreferencesSnapshotSchema = z
  .object({
    version: z.literal(1),
    questionWait: QuestionWaitSchema,
    subagents: SubagentPreferencesSchema,
  })
  .strict();

export const UserPreferencesInputSchema = z
  .object({
    streamingOutput: z.boolean().optional(),
    fontSize: FontSizeSchema.optional(),
    transcriptView: TranscriptViewSchema.optional(),
    collapseTiming: CollapseTimingSchema.optional(),
    appearance: AppearanceSchema.optional(),
    questionWait: QuestionWaitSchema.optional(),
    subagents: SubagentPreferencesSchema.optional(),
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
  appearance: AppearanceSchema.default('light'),
  questionWait: QuestionWaitSchema.default({ mode: 'default' }),
  subagents: SubagentPreferencesSchema.default({ maxDepth: 1, maxActive: 8 }),
  updatedAt: z.string().datetime().nullable(),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const defaultUserPreferences: UserPreferences = {
  streamingOutput: true,
  fontSize: 14,
  transcriptView: 'detailed',
  collapseTiming: 'completion',
  appearance: 'light',
  questionWait: { mode: 'default' },
  subagents: { maxDepth: 1, maxActive: 8 },
  updatedAt: null,
};
