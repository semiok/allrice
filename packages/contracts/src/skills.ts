import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const SkillCapabilitySchema = z.enum([
  'network:outbound',
  'storage:read',
  'storage:write',
  'secret:use',
  'model:invoke',
]);

export const CatalogSkillSchema = z
  .object({
    id: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    publisher: z.string().min(1).max(120),
  })
  .strict();

export const SkillVersionSchema = z
  .object({
    id: UuidSchema,
    catalogSkillId: UuidSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    status: z.enum(['draft', 'published', 'deprecated', 'revoked']),
    capabilities: z.array(SkillCapabilitySchema),
    compatibility: z.object({ api: z.literal('v1') }).strict(),
    publishedAt: TimestampSchema.nullable(),
  })
  .strict();

export const SkillArtifactSchema = z
  .object({
    id: UuidSchema,
    skillVersionId: UuidSchema,
    checksum: ChecksumSchema,
    objectKey: z.string().min(1).max(1024),
    sizeBytes: z.number().int().positive(),
    source: z
      .object({
        repository: z.string().url(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        path: z.string().min(1),
        license: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const SkillInstallationSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema.nullable(),
    catalogSkillId: UuidSchema,
    pinnedVersionId: UuidSchema.nullable(),
    enabled: z.boolean(),
    favorite: z.boolean(),
    grantedCapabilities: z.array(SkillCapabilitySchema),
    timeoutMs: z.number().int().positive().max(3_600_000),
    budgetCents: z.number().int().nonnegative(),
  })
  .strict();
