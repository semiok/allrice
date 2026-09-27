import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  PLATFORM_IMAGE_MODELS,
  type PlatformModelConfiguration,
} from './platform-model-settings.ts';

// Based on OpenAI's image prompting guide. This is AllRice's routing policy,
// not a provider-side automatic model selector. No extra model call is needed.
export const IMAGE_MODEL_SELECTION_GUIDANCE =
  "Choose imageModel from the user's intent: gpt-image-2.5-flare for everyday images, drafts, exploration, or speed priority; gpt-image-2.5-sunburst for demanding visual quality, precise edits, or strict subject/detail preservation. Honor an explicitly requested model. Both support generation and editing; simple fast edits may use Flare and demanding new images may use Sunburst. Do not ask users to choose a model or generate two candidates just to compare. Never automatically retry a failed or unknown image request with another model.";
export const IMAGE_PROMPT_GUIDANCE =
  'Write the prompt as a clear image brief: intended use, subject, composition, style, and constraints. Quote required text exactly. For edits, describe what changes and what must remain unchanged; preserve the selected source and user intent. Do not invent requirements or add unrelated text/logos.';

export const ImageToolInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_000).describe(IMAGE_PROMPT_GUIDANCE),
    fileName: z.string().trim().min(1).max(120),
    imageModel: z
      .enum(PLATFORM_IMAGE_MODELS)
      .optional()
      .describe(IMAGE_MODEL_SELECTION_GUIDANCE),
    source: z
      .object({ objectId: UuidSchema, checksum: ChecksumSchema })
      .strict()
      .optional(),
  })
  .strict();
export type ImageToolInput = z.infer<typeof ImageToolInputSchema>;

export function resolveImageModel(
  configuration: Pick<PlatformModelConfiguration, 'imageModel'>,
  input: Pick<ImageToolInput, 'imageModel' | 'source'>,
): (typeof PLATFORM_IMAGE_MODELS)[number] {
  if (configuration.imageModel !== 'auto') return configuration.imageModel;
  return (
    input.imageModel ??
    (input.source ? 'gpt-image-2.5-sunburst' : 'gpt-image-2.5-flare')
  );
}

export const CodexImageReceiptSchema = z
  .object({
    imageBase64: z.string().min(1).max(11_000_000),
    requestId: z.string().max(200).nullable(),
    workModel: z.string().max(120),
    imageModel: z.enum(PLATFORM_IMAGE_MODELS),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CodexImageReceipt = z.infer<typeof CodexImageReceiptSchema>;
