import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const ImageToolInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_000),
    fileName: z.string().trim().min(1).max(120),
    source: z
      .object({ objectId: UuidSchema, checksum: ChecksumSchema })
      .strict()
      .optional(),
  })
  .strict();
export type ImageToolInput = z.infer<typeof ImageToolInputSchema>;

export const CodexImageReceiptSchema = z
  .object({
    imageBase64: z.string().min(1).max(11_000_000),
    requestId: z.string().max(200).nullable(),
    workModel: z.string().max(120),
    imageModel: z.literal('gpt-image-2.5-flare'),
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
