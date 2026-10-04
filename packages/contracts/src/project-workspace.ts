import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { RuntimeContentRefSchema } from './runtime-v2/identity.ts';
import { isRuntimeRelativePath } from './runtime-v2/policy.ts';
import { TextChangesetProposalSchema } from './runtime-v2/artifact-review.ts';
import { developmentPathsOverlap } from './development-cooperation.ts';

export const projectSourceLimits = Object.freeze({
  files: 64,
  fileBytes: 200_000,
  totalBytes: 256_000,
  snapshotBytes: 512_000,
});
const path = z.string().min(1).max(240).refine(isRuntimeRelativePath);
export const ProjectFileInputSchema = z.union([
  z
    .object({ path, text: z.string().max(projectSourceLimits.fileBytes) })
    .strict(),
  z.object({ path, objectId: UuidSchema, checksum: ChecksumSchema }).strict(),
]);
export const ProjectSnapshotSchema = z
  .object({
    version: z.literal(1),
    projectId: UuidSchema,
    sourceDigest: ChecksumSchema,
    files: z
      .array(
        z
          .object({
            path,
            sha256: ChecksumSchema,
            sizeBytes: z
              .number()
              .int()
              .min(0)
              .max(projectSourceLimits.fileBytes),
            contentBase64: z.string().max(266_672),
          })
          .strict(),
      )
      .max(projectSourceLimits.files),
    source: RuntimeContentRefSchema.optional(),
    parent: RuntimeContentRefSchema.optional(),
    inputs: z.array(RuntimeContentRefSchema).max(64).optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.files.reduce((n, f) => n + f.sizeBytes, 0) >
      projectSourceLimits.totalBytes
    )
      ctx.addIssue({ code: 'custom', message: 'project_source_byte_limit' });
    if (
      snapshot.files.some((f, i) =>
        snapshot.files
          .slice(i + 1)
          .some((g) => developmentPathsOverlap(f.path, g.path)),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'project_path_conflict' });
  });
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
export const ProjectVersionRefSchema = z
  .object({
    projectId: UuidSchema,
    snapshot: RuntimeContentRefSchema,
  })
  .strict();
export type ProjectVersionRef = z.infer<typeof ProjectVersionRefSchema>;
/** Canonical project execution call, added by the trusted selector only. */
export const ProjectExecutionOriginSchema = z
  .object({
    toolName: z.literal('workspace.project'),
    callId: z.string().min(1).max(255),
    argumentsDigest: ChecksumSchema,
    selectionId: UuidSchema,
  })
  .strict();
export type ProjectExecutionOrigin = z.infer<
  typeof ProjectExecutionOriginSchema
>;
/** Trusted operation input only. Model input contains the exact version ref,
 * never source bytes, runtime architecture or Worker lease provenance. */
export const RuntimeSavedProjectSourceSchema = z
  .object({
    version: z.literal(1),
    project: ProjectVersionRefSchema,
    snapshot: ProjectSnapshotSchema,
    architecture: z.enum(['amd64', 'arm64']),
    cacheKey: ChecksumSchema,
    executionOrigin: ProjectExecutionOriginSchema.optional(),
    origin: z
      .object({
        jobId: UuidSchema,
        workerId: UuidSchema,
        attempt: z.number().int().nonnegative(),
        leaseTokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()
  .refine(
    (s) => s.project.projectId === s.snapshot.projectId,
    'project_source_identity_changed',
  );
export type RuntimeSavedProjectSource = z.infer<
  typeof RuntimeSavedProjectSourceSchema
>;
export const ProjectWorkspaceCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('open'),
      files: z.array(ProjectFileInputSchema).max(64).optional(),
      source: RuntimeContentRefSchema.optional(),
    })
    .strict()
    .refine((c) => !(c.files && c.source), 'Supply source OR files'),
  z
    .object({ action: z.literal('list'), project: ProjectVersionRefSchema })
    .strict(),
  z
    .object({
      action: z.literal('read'),
      project: ProjectVersionRefSchema,
      path,
      offset: z.number().int().min(0).max(200_000).default(0),
      limit: z.number().int().min(1).max(4000).default(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      project: ProjectVersionRefSchema,
      query: z.string().min(1).max(200),
      offset: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z
    .object({
      action: z.literal('apply'),
      expectedHead: ProjectVersionRefSchema,
      proposal: TextChangesetProposalSchema,
    })
    .strict(),
]);
export type ProjectWorkspaceCommand = z.infer<
  typeof ProjectWorkspaceCommandSchema
>;
