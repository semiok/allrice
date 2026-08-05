import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
export const SchemaVersionSchema = z.literal(1);

export const ActorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: UuidSchema }).strict(),
  z.object({ type: z.literal('service'), id: UuidSchema }).strict(),
  z.object({ type: z.literal('worker'), id: UuidSchema }).strict(),
  z.object({ type: z.literal('system'), id: z.literal('allrice') }).strict(),
]);
export type Actor = z.infer<typeof ActorSchema>;

export const VisibilitySchema = z.enum([
  'private',
  'workspace',
  'organization',
]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const ResourceRefSchema = z
  .object({
    type: z.string().min(1).max(64),
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    ownerId: UuidSchema.nullable(),
    visibility: VisibilitySchema,
    archivedAt: TimestampSchema.nullable().default(null),
  })
  .strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const TenantOwnedRecordSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    projectId: UuidSchema.nullable(),
    ownerId: UuidSchema.nullable(),
    visibility: VisibilitySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict();
export type TenantOwnedRecord = z.infer<typeof TenantOwnedRecordSchema>;
