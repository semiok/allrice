import { z } from 'zod';
import { UuidSchema } from './common.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BootstrapCoverageEntrySchema = z
  .object({
    key: z.string().min(1).max(100),
    digest,
  })
  .strict();
export const BootstrapContextSchema = z
  .object({
    segments: z
      .array(BootstrapCoverageEntrySchema.extend({ text: z.string() }).strict())
      .max(81),
    userMessage: BootstrapCoverageEntrySchema.optional(),
    assistantMessageId: UuidSchema.optional(),
  })
  .strict();
export const BootstrapReceiptSchema = z
  .object({
    version: z.literal(1),
    scope: digest,
    imported: z.array(BootstrapCoverageEntrySchema).max(81),
    userMessage: BootstrapCoverageEntrySchema.optional(),
    assistantMessageId: UuidSchema.optional(),
  })
  .strict();
export const BootstrapCoverageQuerySchema = z
  .object({
    scope: digest,
    candidates: z.array(BootstrapCoverageEntrySchema).max(81),
  })
  .strict();
export const BootstrapCoverageResultSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    covered: z.array(BootstrapCoverageEntrySchema).max(81),
  })
  .strict();
export type BootstrapContext = z.infer<typeof BootstrapContextSchema>;
export type BootstrapReceipt = z.infer<typeof BootstrapReceiptSchema>;
export type BootstrapCoverageQuery = z.infer<
  typeof BootstrapCoverageQuerySchema
>;
