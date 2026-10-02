import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const CompanyAssetSlotSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    label: z.string().trim().min(1).max(80),
    required: z.boolean(),
    multiline: z.boolean(),
  })
  .strict();
export const CompanyAssetContentSchema = z
  .object({
    kind: z.enum(['rule', 'template']),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(4000),
    category: z.string().trim().max(80),
    appliesToEmployeeIds: z.array(UuidSchema).max(30),
    taskKeywords: z.array(z.string().trim().min(1).max(80)).max(12),
    slots: z.array(CompanyAssetSlotSchema).max(12),
    sourceVersionId: UuidSchema.optional(),
    sourceMemoryId: UuidSchema.optional(),
    sourceMemoryRevisionId: UuidSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'rule' && (value.sourceVersionId || value.slots.length))
      ctx.addIssue({ code: 'custom', message: '公司规矩不包含文件或填写项' });
    if (
      value.kind === 'template' &&
      (value.sourceMemoryId || value.sourceMemoryRevisionId)
    )
      ctx.addIssue({ code: 'custom', message: '范本请选择具体成果版本' });
    if (Boolean(value.sourceMemoryId) !== Boolean(value.sourceMemoryRevisionId))
      ctx.addIssue({ code: 'custom', message: '请选择具体记忆版本' });
    if (new Set(value.slots.map((s) => s.key)).size !== value.slots.length)
      ctx.addIssue({ code: 'custom', message: '填写项名称不能重复' });
  });
export const CompanyAssetMutationSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('save'),
      assetId: UuidSchema,
      expectedRevision: z.number().int().nonnegative(),
      content: CompanyAssetContentSchema,
    })
    .strict(),
  z
    .object({
      operation: z.enum(['publish', 'pause', 'resume', 'withdraw', 'archive']),
      assetId: UuidSchema,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
]);
export const CompanyAssetFileSchema = z
  .object({
    objectId: UuidSchema,
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string(),
    fileName: z.string(),
    format: z.string(),
  })
  .strict();
export const CompanyAssetRevisionSchema = z
  .object({
    id: UuidSchema,
    number: z.number().int().positive(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    content: CompanyAssetContentSchema,
    file: CompanyAssetFileSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();
export const CompanyAssetSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    ownerId: UuidSchema,
    ownerName: z.string(),
    kind: z.enum(['rule', 'template']),
    state: z.enum(['draft', 'published', 'paused', 'withdrawn', 'archived']),
    revision: z.number().int().positive(),
    publishedRevisionId: UuidSchema.nullable(),
    latest: CompanyAssetRevisionSchema,
    canEdit: z.boolean(),
  })
  .strict();
export const CompanyAssetDirectorySchema = z
  .object({
    assets: z.array(CompanyAssetSchema),
    nextCursor: UuidSchema.nullable(),
    ruleBudget: z.object({
      maximumBytes: z.number().int(),
      publishedBytes: z.number().int(),
      maximumRules: z.number().int(),
    }),
  })
  .strict();
export type CompanyAsset = z.infer<typeof CompanyAssetSchema>;
export type CompanyAssetContent = z.infer<typeof CompanyAssetContentSchema>;
export type CompanyAssetRevision = z.infer<typeof CompanyAssetRevisionSchema>;
export type CompanyAssetMutation = z.infer<typeof CompanyAssetMutationSchema>;
export type CompanyAssetDirectory = z.infer<typeof CompanyAssetDirectorySchema>;
