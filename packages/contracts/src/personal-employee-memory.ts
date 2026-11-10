import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

// PostgreSQL text/JSON cannot store NUL or unpaired UTF-16 surrogates.
const storageText = z.string().refine((text) =>
  Array.from(text).every((character) => {
    const point = character.codePointAt(0)!;
    return point !== 0 && (point < 0xd800 || point > 0xdfff);
  }),
);
export const PersonalMemorySummarySchema = storageText
  .transform((text) => text.replace(/[\r\n\u2028\u2029]/gu, ' ').trim())
  .refine(
    (text) => Array.from(text).length >= 1 && Array.from(text).length <= 40,
  );
export const PersonalMemoryDetailsSchema = storageText
  .nullable()
  .transform((text) => (text?.trim() ? text : null))
  .refine((text) => text === null || Array.from(text).length <= 2000);
export const PersonalMemoryPairSchema = z
  .object({
    summary: PersonalMemorySummarySchema,
    details: PersonalMemoryDetailsSchema,
  })
  .strict();
export const CreatePersonalEmployeeMemoryInputSchema = z
  .object({
    workspaceId: UuidSchema,
    instanceId: UuidSchema,
    idempotencyKey: UuidSchema,
    summary: PersonalMemorySummarySchema,
    details: PersonalMemoryDetailsSchema.optional().default(null),
  })
  .strict();
export const CorrectPersonalEmployeeMemoryInputSchema = z
  .object({
    instanceId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    pairDigest: ChecksumSchema,
    idempotencyKey: UuidSchema,
    summary: PersonalMemorySummarySchema,
    // Required: omission must never mean clearing a previously saved detail.
    details: PersonalMemoryDetailsSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const PersonalEmployeeMemorySchema = PersonalMemoryPairSchema.extend({
  id: UuidSchema,
  organizationId: UuidSchema,
  workspaceId: UuidSchema,
  ownerId: UuidSchema,
  instanceId: UuidSchema,
  revision: z.number().int().positive(),
  pairDigest: ChecksumSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type PersonalMemoryPair = z.infer<typeof PersonalMemoryPairSchema>;
export type PersonalEmployeeMemory = z.infer<
  typeof PersonalEmployeeMemorySchema
>;
