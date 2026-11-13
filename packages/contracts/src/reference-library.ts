import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { ContentOwnershipSchema } from './content-maintenance.ts';
import { WorkbenchFileSharingSchema } from './file-audience.ts';

// PostgreSQL UUID identity is case-insensitive; JSON ownership and dedup keys must agree.
const ReferenceInputUuidSchema = UuidSchema.transform((id) => id.toLowerCase());

export const ReferenceAudienceSchema = WorkbenchFileSharingSchema.transform(
  (value) => ({
    ...value,
    departmentIds: value.departmentIds.map((id) => id.toLowerCase()).sort(),
  }),
).superRefine((value, context) => {
  if (new Set(value.departmentIds).size !== value.departmentIds.length)
    context.addIssue({ code: 'custom', message: '部门不能重复。' });
});
export type ReferenceAudience = z.infer<typeof ReferenceAudienceSchema>;

const publicationInput = {
  workspaceId: ReferenceInputUuidSchema,
  requestId: ReferenceInputUuidSchema,
  audience: ReferenceAudienceSchema,
  purpose: z.string().trim().max(1000).default(''),
};
export const ReferencePublishInputSchema = z.discriminatedUnion('origin', [
  z
    .object({
      ...publicationInput,
      origin: z.literal('file'),
      objectId: ReferenceInputUuidSchema,
    })
    .strict(),
  z
    .object({
      ...publicationInput,
      origin: z.literal('upload'),
      fileName: z.string().trim().min(1).max(160),
      mediaType: z.string().min(1).max(255),
      contentBase64: z.string().max(70_000_000),
    })
    .strict(),
]);
export type ReferencePublishInput = z.infer<typeof ReferencePublishInputSchema>;

const publicationAction = {
  workspaceId: ReferenceInputUuidSchema,
  requestId: ReferenceInputUuidSchema,
  expectedRevision: z.number().int().positive(),
};
export const ReferencePublicationActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...publicationAction,
      action: z.literal('audience'),
      audience: ReferenceAudienceSchema,
    })
    .strict(),
  z
    .object({
      ...publicationAction,
      action: z.enum(['revoke', 'delete']),
    })
    .strict(),
]);

/** Server-captured pin; file bytes and revision manifest have different digests. */
export const ReferenceSelectionSchema = z
  .object({
    sourceId: UuidSchema,
    revisionId: UuidSchema,
    revision: z.number().int().positive(),
    fileName: z.string().max(160),
    purpose: z.string().max(1000),
    digest: ChecksumSchema,
    checksum: ChecksumSchema,
    ownership: ContentOwnershipSchema,
  })
  .strict();
export type ReferenceSelection = z.infer<typeof ReferenceSelectionSchema>;
export const ReferenceSelectionsSchema = z
  .array(ReferenceSelectionSchema)
  .max(3);

export const ReferenceUploadInputSchema = z
  .object({
    workspaceId: ReferenceInputUuidSchema,
    requestId: ReferenceInputUuidSchema,
    sourceId: ReferenceInputUuidSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    scope: z.enum(['personal', 'department', 'company', 'platform']),
    departmentId: ReferenceInputUuidSchema.optional(),
    fileName: z.string().trim().min(1).max(160),
    purpose: z.string().trim().max(1000).default(''),
    mediaType: z.string().min(1).max(255),
    contentBase64: z.string().max(70_000_000),
  })
  .strict()
  .superRefine((v, c) => {
    if (!!v.sourceId !== !!v.expectedRevision)
      c.addIssue({ code: 'custom', message: '更新资料需要指定当前版本' });
    if ((v.scope === 'department') !== !!v.departmentId)
      c.addIssue({ code: 'custom', message: '部门资料需要指定部门' });
  });
export type ReferenceUploadInput = z.infer<typeof ReferenceUploadInputSchema>;
export const ReferenceArtifactSaveInputSchema = z
  .object({
    workspaceId: ReferenceInputUuidSchema,
    requestId: ReferenceInputUuidSchema,
    artifactVersionId: ReferenceInputUuidSchema,
    scope: z.enum(['personal', 'department', 'company']).default('personal'),
    departmentId: ReferenceInputUuidSchema.optional(),
    purpose: z.string().trim().max(1000).default(''),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.scope === 'department') !== !!v.departmentId)
      c.addIssue({ code: 'custom', message: '部门资料需要指定部门' });
  });
export type ReferenceArtifactSaveInput = z.infer<
  typeof ReferenceArtifactSaveInputSchema
>;
export const ReferenceSaveResultSchema = z
  .object({
    sourceId: UuidSchema,
    revisionId: UuidSchema,
  })
  .strict();
export const ReferenceLibraryOptionsSchema = z.object({
  workspaceId: UuidSchema,
  platformMaintainer: z.boolean(),
  maintenanceLevel: z.enum(['personal', 'department', 'company']),
  writable: z.boolean(),
  departmentId: UuidSchema.nullable(),
  departments: z.array(z.object({ id: UuidSchema, name: z.string() })),
});
export const ReferenceProcessingStateSchema = z.enum([
  'uploading',
  'saved',
  'processing',
  'ready',
  'failed',
  'unsupported',
]);
export const ReferenceRevisionSchema = z
  .object({
    sourceId: UuidSchema,
    revisionId: UuidSchema,
    revision: z.number().int().positive(),
    ownership: ContentOwnershipSchema,
    fileName: z.string(),
    purpose: z.string(),
    checksum: ChecksumSchema,
    manifestDigest: ChecksumSchema.optional(),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string(),
    status: z.enum(['active', 'archived']),
    processing: ReferenceProcessingStateSchema,
    failure: z.string().nullable(),
    canMaintain: z.boolean(),
    canRetryProcessing: z.boolean().optional(),
    publication: z
      .object({
        origin: z.enum(['file', 'upload']),
        publisherId: UuidSchema,
        publisherName: z.string(),
        audience: ReferenceAudienceSchema,
        audienceRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    createdAt: TimestampSchema,
    companyTemplate: z
      .object({
        assetId: UuidSchema,
        revisionId: UuidSchema,
        digest: ChecksumSchema,
      })
      .strict()
      .optional(),
    origin: z
      .object({
        fileName: z.string(),
        version: z.number().int().positive(),
        checksum: ChecksumSchema,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type ReferenceRevision = z.infer<typeof ReferenceRevisionSchema>;
export const ReferenceActionSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    action: z.enum(['retry', 'archive', 'restore']),
  })
  .strict();
