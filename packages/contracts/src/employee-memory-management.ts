import { z } from 'zod';
import { UuidSchema, TimestampSchema } from './common.ts';
import {
  MemorySourceTypeSchema,
  MemoryClassSchema,
  MemoryLifecycleStateSchema,
} from './operations.ts';

export const EmployeeMemoryStateSchema = z.enum([
  'confirmed',
  'pending',
  'expired',
  'archived',
]);
export const EmployeeMemoryFilterSchema = z.enum([
  'all',
  'confirmed',
  'pending',
  'expired',
  'archived',
]);
export const EmployeeMemoryPageQuerySchema = z
  .object({
    state: EmployeeMemoryFilterSchema.default('all'),
    after: UuidSchema.optional(),
  })
  .strict();
export const EmployeeMemoryTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 1000,
    '记忆内容不能超过 1000 字节，请缩短为习惯、偏好或资料入口。',
  );

export const EmployeeMemoryPinInputSchema = z
  .object({
    instanceId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    idempotencyKey: UuidSchema,
    pinned: z.boolean(),
  })
  .strict();

// Explicit allowlist for both owner management and administrator projection.
// No source IDs, excerpts, session URLs, tool output, or private profile.
export const ManagedEmployeeMemorySchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    instanceId: UuidSchema,
    content: z.string(),
    revision: z.number().int().positive(),
    contentDigest: z.string(),
    state: EmployeeMemoryStateSchema,
    sourceType: MemorySourceTypeSchema,
    memoryClass: MemoryClassSchema,
    lifecycleState: MemoryLifecycleStateSchema,
    trust: z.enum([
      'user_confirmed',
      'platform_verified',
      'derived',
      'untrusted_external',
    ]),
    expiresAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
    pinOrder: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export const EmployeeMemoryPageSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    instanceId: UuidSchema,
    state: EmployeeMemoryFilterSchema,
    total: z.number().int().nonnegative(),
    memories: z.array(ManagedEmployeeMemorySchema),
    nextCursor: UuidSchema.nullable(),
    budget: z
      .object({
        mode: z.literal('capacity_preview'),
        maxBytes: z.literal(6000),
        maxItems: z.literal(20),
        usedBytes: z.number().int().nonnegative().max(6000),
        eligibleCount: z.number().int().nonnegative(),
        omittedCount: z.number().int().nonnegative(),
        selectedIds: z.array(UuidSchema).max(20),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ManagedEmployeeMemory = z.infer<typeof ManagedEmployeeMemorySchema>;
export type EmployeeMemoryPage = z.infer<typeof EmployeeMemoryPageSchema>;
