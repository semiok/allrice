import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  WorkflowDefinitionSchema,
  WorkflowRevisionSchema,
} from './capabilities.ts';
import { EmployeeContentReferenceSchema } from './employee-content.ts';

export const workflowPackageLimits = Object.freeze({
  files: 64,
  fileBytes: 200_000,
  sourceBytes: 512_000,
  totalBytes: 256_000,
  assets: 32,
});

/** Portable package paths never name a host file or escape the package root. */
export const WorkflowPackagePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/)
  .refine(
    (path) => !path.split('/').some((part) => part === '.' || part === '..'),
  );

export const WorkflowPackageMethodSchema =
  EmployeeContentReferenceSchema.extend({
    sourceKind: z.literal('procedure'),
  }).strict();

export const WorkflowPackageObjectSchema = z
  .object({ objectId: UuidSchema, checksum: ChecksumSchema })
  .strict();

export const WorkflowPackageFileSchema = z
  .object({ path: WorkflowPackagePathSchema, checksum: ChecksumSchema })
  .strict();

/** A source is an existing immutable StorageObject, not an invented project Run. */
export const WorkflowPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    templateKey: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
      .max(120),
    method: WorkflowPackageMethodSchema,
    definitionChecksum: ChecksumSchema,
    source: WorkflowPackageObjectSchema.optional(),
    files: z
      .array(WorkflowPackageFileSchema)
      .max(workflowPackageLimits.files)
      .default([]),
    assets: z
      .array(
        WorkflowPackageFileSchema.extend({ objectId: UuidSchema }).strict(),
      )
      .max(workflowPackageLimits.assets)
      .default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = [...manifest.files, ...manifest.assets].map((file) =>
      file.path.toLowerCase(),
    );
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({
        code: 'custom',
        message: 'workflow_package_duplicate_path',
      });
    if (manifest.files.length > 0 && !manifest.source)
      ctx.addIssue({
        code: 'custom',
        message: 'workflow_package_source_required',
      });
    if (
      manifest.source &&
      !['workflow.json', 'method.md'].every((path) =>
        manifest.files.some((file) => file.path === path),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'workflow_package_entry_files_required',
      });
  });
export type WorkflowPackageManifest = z.infer<
  typeof WorkflowPackageManifestSchema
>;

/** Bounded JSON source format. Storage checksum and every decoded file are verified. */
export const WorkflowPackageSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z
      .array(
        WorkflowPackageFileSchema.extend({
          contentBase64: z
            .string()
            .max(266_672)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        }).strict(),
      )
      .min(2)
      .max(workflowPackageLimits.files),
  })
  .strict();
export type WorkflowPackageSource = z.infer<typeof WorkflowPackageSourceSchema>;

export const WorkflowPackageSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    assignmentId: UuidSchema,
    employeeId: UuidSchema,
    instanceId: UuidSchema,
    sceneId: UuidSchema.nullable(),
    workflow: WorkflowRevisionSchema,
    manifest: WorkflowPackageManifestSchema,
    checksum: ChecksumSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type WorkflowPackage = z.infer<typeof WorkflowPackageSchema>;

export const WorkflowPackageSelectionSchema = z
  .object({
    workspaceId: UuidSchema,
    instanceId: UuidSchema,
    sceneId: UuidSchema.nullable().default(null),
    workflowRevisionId: UuidSchema,
  })
  .strict();
export type WorkflowPackageSelection = z.infer<
  typeof WorkflowPackageSelectionSchema
>;

/** Server-only execution gate input. Browsers cannot select a historical Run's digest. */
export const WorkflowPackageExecutionSelectionSchema =
  WorkflowPackageSelectionSchema.extend({
    frozenPackageDigest: ChecksumSchema.optional(),
  }).strict();
export type WorkflowPackageExecutionSelection = z.infer<
  typeof WorkflowPackageExecutionSelectionSchema
>;

export const RegisterWorkflowPackageInputSchema = z
  .object({
    workspaceId: UuidSchema,
    instanceId: UuidSchema,
    sceneId: UuidSchema.nullable().default(null),
    requestId: UuidSchema,
    workflowId: UuidSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(96),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1000),
    definition: WorkflowDefinitionSchema,
    manifest: WorkflowPackageManifestSchema,
  })
  .strict()
  .refine(
    (input) => !!input.workflowId === input.expectedRevision > 0,
    'workflow_package_revision_required',
  );
export type RegisterWorkflowPackageInput = z.infer<
  typeof RegisterWorkflowPackageInputSchema
>;

export const SetWorkflowPackageBindingInputSchema =
  WorkflowPackageSelectionSchema.extend({
    requestId: UuidSchema,
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
  }).strict();
export type SetWorkflowPackageBindingInput = z.infer<
  typeof SetWorkflowPackageBindingInputSchema
>;

export const WorkflowPackageBindingSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    assignmentId: UuidSchema,
    employeeId: UuidSchema,
    instanceId: UuidSchema,
    sceneId: UuidSchema.nullable(),
    workflowRevisionId: UuidSchema,
    packageChecksum: ChecksumSchema,
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    boundAt: TimestampSchema,
  })
  .strict();
export type WorkflowPackageBinding = z.infer<
  typeof WorkflowPackageBindingSchema
>;

export const WorkflowPackageSyncStatusSchema = z.enum([
  'in_sync',
  'method_changed',
  'source_unavailable',
]);
export type WorkflowPackageSyncStatus = z.infer<
  typeof WorkflowPackageSyncStatusSchema
>;

export const WorkflowPackageResolutionSchema = z
  .object({
    package: WorkflowPackageSchema,
    binding: WorkflowPackageBindingSchema.nullable(),
    syncStatus: WorkflowPackageSyncStatusSchema,
  })
  .strict();
export type WorkflowPackageResolution = z.infer<
  typeof WorkflowPackageResolutionSchema
>;
