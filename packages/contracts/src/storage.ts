import { z } from 'zod';

import { TimestampSchema, UuidSchema, VisibilitySchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const StorageCategorySchema = z.enum([
  'uploads',
  'artifacts',
  'memory',
  'exports',
]);

const uuidPattern =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const ObjectKeySchema = z
  .string()
  .regex(
    new RegExp(
      `^organizations/${uuidPattern}/workspaces/${uuidPattern}/owners/${uuidPattern}/(uploads|artifacts|memory|exports)/${uuidPattern}$`,
    ),
  );

export const StorageObjectSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    key: ObjectKeySchema,
    checksum: ChecksumSchema,
    mediaType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    retentionUntil: TimestampSchema.nullable(),
    deletedAt: TimestampSchema.nullable(),
    immutable: z.boolean(),
  })
  .strict();
export type StorageObject = z.infer<typeof StorageObjectSchema>;

export const CreateFileInputSchema = z
  .object({
    workspaceId: UuidSchema,
    category: StorageCategorySchema.default('uploads'),
    mediaType: z.string().min(1).max(255),
    contentBase64: z.string().min(1).max(12_000_000),
    visibility: VisibilitySchema.default('private'),
    retentionUntil: TimestampSchema.nullable().default(null),
    immutable: z.boolean().default(false),
  })
  .strict();

export const SignFileInputSchema = z
  .object({
    lifetimeSeconds: z.number().int().min(1).max(900).default(300),
  })
  .strict();

export const CreateMemoryInputSchema = z
  .object({
    workspaceId: UuidSchema,
    projectId: UuidSchema.nullable().default(null),
    content: z.string().min(1).max(100_000),
    metadata: z.record(z.string(), z.json()).default({}),
    visibility: VisibilitySchema.default('private'),
  })
  .strict();

export const VectorRecallInputSchema = z
  .object({
    workspaceId: UuidSchema,
    embedding: z.array(z.number().finite()).length(1536),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const CreateRagChunkInputSchema = z
  .object({
    workspaceId: UuidSchema,
    memoryId: UuidSchema,
    content: z.string().min(1).max(100_000),
    embedding: z.array(z.number().finite()).length(1536),
  })
  .strict();

export const SignedAccessGrantSchema = z
  .object({
    objectId: UuidSchema,
    subjectId: UuidSchema,
    operation: z.enum(['read', 'write']),
    expiresAt: TimestampSchema,
    nonce: UuidSchema,
  })
  .strict();
export type SignedAccessGrant = z.infer<typeof SignedAccessGrantSchema>;

export function makeObjectKey(input: {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  category: z.infer<typeof StorageCategorySchema>;
  objectId: string;
}) {
  const parsed = z
    .object({
      organizationId: UuidSchema,
      workspaceId: UuidSchema,
      ownerId: UuidSchema,
      category: StorageCategorySchema,
      objectId: UuidSchema,
    })
    .strict()
    .parse(input);
  return ObjectKeySchema.parse(
    `organizations/${parsed.organizationId}/workspaces/${parsed.workspaceId}/owners/${parsed.ownerId}/${parsed.category}/${parsed.objectId}`,
  );
}

export interface StoragePort {
  put(
    object: StorageObject,
    content: ReadableStream<Uint8Array>,
  ): Promise<void>;
  get(object: StorageObject): Promise<ReadableStream<Uint8Array>>;
  delete(object: StorageObject): Promise<void>;
  exists(object: StorageObject): Promise<boolean>;
}
