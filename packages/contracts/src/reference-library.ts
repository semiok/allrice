import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { ContentOwnershipSchema } from './content-maintenance.ts';

export const ReferenceUploadInputSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    sourceId: UuidSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    scope: z.enum(['personal', 'department', 'company', 'platform']),
    departmentId: UuidSchema.optional(),
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
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string(),
    status: z.enum(['active', 'archived']),
    processing: ReferenceProcessingStateSchema,
    failure: z.string().nullable(),
    canMaintain: z.boolean(),
    createdAt: TimestampSchema,
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
