import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { LocalFilePathSchema, LocalFileVersionSchema } from './local-files.ts';

export const FolderTriggerConfigSchema = z
  .object({
    contractVersion: z.literal(1),
    deviceId: UuidSchema,
    folderGrantId: UuidSchema,
    folderGrantVersion: z.number().int().positive(),
    relativePath: z.union([z.literal('.'), LocalFilePathSchema]),
    extensions: z
      .array(z.enum(['pdf', 'xlsx', 'csv']))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
    ignorePaths: z
      .array(LocalFilePathSchema)
      .min(1)
      .max(16)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export type FolderTriggerConfig = z.infer<typeof FolderTriggerConfigSchema>;
export const FolderTriggerRuleSchema = FolderTriggerConfigSchema.omit({
  contractVersion: true,
})
  .extend({
    automationId: UuidSchema,
    revision: z.number().int().positive(),
    admissionExpiresAt: TimestampSchema,
  })
  .strict();
export type FolderTriggerRule = z.infer<typeof FolderTriggerRuleSchema>;
export const FolderTriggerEventSchema = z
  .object({
    eventId: UuidSchema,
    ruleId: UuidSchema,
    revision: z.number().int().positive(),
    grantId: UuidSchema,
    grantVersion: z.number().int().positive(),
    path: LocalFilePathSchema,
    expected: LocalFileVersionSchema,
    observedAt: TimestampSchema,
  })
  .strict();
export type FolderTriggerEvent = z.infer<typeof FolderTriggerEventSchema>;
export const FolderTriggerObservationSchema = z
  .object({
    ruleId: UuidSchema,
    revision: z.number().int().positive(),
    status: z.enum(['listening', 'paused', 'error']),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,100}$/)
      .nullable(),
  })
  .strict();
