import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';

// Only models supported by the pinned Codex adapter are selectable. Historical
// employee/run schemas remain permissive so retiring a provider never hides history.
export const PLATFORM_WORK_MODELS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const;
export const PLATFORM_IMAGE_MODELS = [
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export const PlatformModelConfigurationSchema = z
  .object({
    connectionId: UuidSchema,
    workModel: z.enum(PLATFORM_WORK_MODELS),
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
    configuration: PlatformModelConfigurationSchema,
  })
  .strict();
