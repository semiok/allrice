import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { ReferenceRevisionSchema } from './reference-library.ts';
import { platformFileMaximumBase64Characters } from './storage.ts';
import { WorkbenchFileSharingSchema } from './file-audience.ts';
export { WorkbenchFileSharingSchema } from './file-audience.ts';
export type { WorkbenchFileSharing } from './file-audience.ts';

export const WorkbenchFileSchema = z
  .object({
    objectId: UuidSchema,
    workspaceId: UuidSchema,
    fileName: z.string(),
    mediaType: z.string(),
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    ownedByMe: z.boolean(),
    canMaintain: z.boolean(),
    revision: z.number().int().nonnegative(),
    sharing: z.object({
      scope: z.enum([
        'personal',
        'departments',
        'company',
        'workspace',
        'platform',
      ]),
      departmentIds: z.array(UuidSchema),
      departmentNames: z.array(z.string()),
    }),
    category: z.enum(['upload', 'artifact', 'reference']),
    sessionIds: z.array(UuidSchema),
    artifact: z
      .object({
        id: UuidSchema,
        sessionId: UuidSchema,
        version: z.number().int().positive(),
      })
      .nullable(),
    isReference: z.boolean(),
    reference: ReferenceRevisionSchema.nullable(),
  })
  .strict();
export type WorkbenchFile = z.infer<typeof WorkbenchFileSchema>;

export const WorkbenchFileCatalogSchema = z.object({
  files: z.array(WorkbenchFileSchema),
  truncated: z.boolean(),
  options: z.object({
    writable: z.boolean(),
    maintenanceLevel: z.enum(['personal', 'department', 'company']),
    departmentId: UuidSchema.nullable(),
    departments: z.array(z.object({ id: UuidSchema, name: z.string() })),
  }),
});
export type WorkbenchFileCatalog = z.infer<typeof WorkbenchFileCatalogSchema>;

/** Owner-only display projection. These IDs locate existing resources; they
 * never grant access to a conversation or its original bytes. */
export const WorkbenchDeliverableSourceSchema = z.object({
  sessionId: UuidSchema,
  sessionTitle: z.string(),
  employeeAssignmentId: UuidSchema,
  employeeInstanceId: UuidSchema,
  employeeName: z.string(),
});
export const WorkbenchDeliverableSchema = WorkbenchFileSchema.extend({
  origin: z.enum(['business-deliverable', 'user-upload']),
  sources: z.array(WorkbenchDeliverableSourceSchema),
});
export type WorkbenchDeliverable = z.infer<typeof WorkbenchDeliverableSchema>;
export const WorkbenchDeliverablesCatalogSchema = z.object({
  files: z.array(WorkbenchDeliverableSchema),
  employees: z.array(z.object({ id: UuidSchema, name: z.string() })),
  nextCursor: UuidSchema.nullable(),
});
export const WorkbenchDeliverablesFilterSchema = z.object({
  workspaceId: UuidSchema,
  employeeInstanceId: UuidSchema.optional(),
  category: z.enum(['all', 'artifact', 'upload']).default('all'),
  query: z.string().max(200).default(''),
  cursor: UuidSchema.optional(),
  objectId: UuidSchema.optional(),
});

export const WorkbenchFileUploadSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    fileName: z.string().trim().min(1).max(160),
    mediaType: z.string().min(1).max(255),
    contentBase64: z.string().min(1).max(platformFileMaximumBase64Characters),
    sharing: WorkbenchFileSharingSchema.default({
      scope: 'personal',
      departmentIds: [],
    }),
  })
  .strict();

export const WorkbenchFileUpdateSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    expectedRevision: z.number().int().nonnegative(),
    sharing: WorkbenchFileSharingSchema.optional(),
    isReference: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.sharing !== undefined || value.isReference !== undefined,
    { message: '请指定要调整的文件范围或长期参考状态。' },
  );
export type WorkbenchFileUpdate = z.infer<typeof WorkbenchFileUpdateSchema>;
