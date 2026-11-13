import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { MemoryClassSchema } from './operations.ts';

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
/** Model arguments carry content only; source and operation identity are Worker-owned. */
export const RememberPersonalMemoryInputSchema =
  PersonalMemoryPairSchema.extend({
    details: PersonalMemoryDetailsSchema.optional().default(null),
    memoryClass: MemoryClassSchema.default('work_note'),
  }).strict();
export const CreateRememberedMemoryCandidateInputSchema =
  RememberPersonalMemoryInputSchema.extend({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    sourceId: UuidSchema,
  }).strict();
/** Internal stored-checkpoint adapter, never a model tool or background producer. */
export const CreateCheckpointPersonalMemoryCandidateInputSchema =
  PersonalMemoryPairSchema.extend({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    sessionId: UuidSchema,
    checkpointId: UuidSchema,
    sourceLabel: z.string().trim().min(1).max(240),
    idempotencyKey: UuidSchema,
    details: PersonalMemoryDetailsSchema.optional().default(null),
  }).strict();
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

export const EmployeeMemoryMutationInputSchema = z
  .object({
    instanceId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    pairDigest: ChecksumSchema,
    idempotencyKey: UuidSchema,
  })
  .strict();
export const EmployeeMemoryCountsSchema = z
  .object({
    active: z.number().int().min(0).max(100),
    pending: z.number().int().nonnegative(),
    maxActive: z.literal(100),
  })
  .strict();
export const EmployeeMemoryListQuerySchema = z
  .object({ workspaceId: UuidSchema, instanceId: UuidSchema })
  .strict();
export const EmployeeMemoryRowSchema = z
  .object({
    id: UuidSchema,
    summary: PersonalMemorySummarySchema,
    hasDetails: z.boolean(),
    state: z.enum(['active', 'pending']),
    revision: z.number().int().positive(),
    pairDigest: ChecksumSchema,
    capturedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const EmployeeMemoryRecordSchema = EmployeeMemoryRowSchema.extend({
  details: PersonalMemoryDetailsSchema,
}).refine((row) => row.hasDetails === (row.details !== null));
export const EmployeeMemoryListSchema = EmployeeMemoryListQuerySchema.extend({
  schemaVersion: z.literal(2),
  counts: EmployeeMemoryCountsSchema,
  active: z.array(EmployeeMemoryRowSchema).max(100),
  pending: z.array(EmployeeMemoryRowSchema),
}).refine(
  (page) =>
    page.active.length === page.counts.active &&
    page.pending.length === page.counts.pending &&
    page.active.every((row) => row.state === 'active') &&
    page.pending.every((row) => row.state === 'pending'),
);
export const EmployeeMemoryDetailResponseSchema = z
  .object({ schemaVersion: z.literal(2), memory: EmployeeMemoryRecordSchema })
  .strict();
export const EmployeeMemoryWriteResponseSchema =
  EmployeeMemoryDetailResponseSchema.extend({
    counts: EmployeeMemoryCountsSchema,
  });
export type EmployeeMemoryRecord = z.infer<typeof EmployeeMemoryRecordSchema>;
