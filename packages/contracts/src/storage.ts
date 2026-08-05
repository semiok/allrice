import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
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

export const SignedAccessGrantSchema = z
  .object({
    objectId: UuidSchema,
    subjectId: UuidSchema,
    operation: z.enum(['read', 'write']),
    expiresAt: TimestampSchema,
    nonce: UuidSchema,
  })
  .strict();

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
