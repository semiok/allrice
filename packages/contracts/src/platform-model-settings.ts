import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';

// New selections use the current catalog. Read schemas also accept retired IDs
// because existing Run snapshots must retain the model that actually ran.
export const PLATFORM_WORK_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.3-codex-spark',
] as const;
const RETIRED_PLATFORM_WORK_MODELS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
] as const;
export const PLATFORM_WORK_MODEL_LABELS = {
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
} as const;
export const PLATFORM_IMAGE_MODELS = [
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export const PlatformModelConfigurationSchema = z
  .object({
    connectionId: UuidSchema,
    workModel: z.enum([
      ...PLATFORM_WORK_MODELS,
      ...RETIRED_PLATFORM_WORK_MODELS,
    ]),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    timeoutMs: z.number().int().min(30_000).max(3_600_000),
    imageModel: z.enum(['auto', ...PLATFORM_IMAGE_MODELS]),
    imagesEnabled: z.boolean(),
  })
  .strict();
export type PlatformModelConfiguration = z.infer<
  typeof PlatformModelConfigurationSchema
>;

export const PlatformModelSettingsSchema = z
  .object({
    revision: z.number().int().positive(),
    configuration: PlatformModelConfigurationSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type PlatformModelSettings = z.infer<typeof PlatformModelSettingsSchema>;

export const UpdatePlatformModelSettingsSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    configuration: PlatformModelConfigurationSchema.extend({
      workModel: z.enum(PLATFORM_WORK_MODELS),
    }),
  })
  .strict();
