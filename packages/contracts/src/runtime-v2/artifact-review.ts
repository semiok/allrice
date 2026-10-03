import { z } from 'zod';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { StorageObjectSchema } from '../storage.ts';
import { DeliverableVersionSchema } from '../operations.ts';
import { RuntimeExecutionScopeSchema } from './identity.ts';
import { isRuntimeRelativePath } from './policy.ts';
import { LocalFilePathSchema } from '../local-files.ts';

export const WorkbenchArtifactKindSchema = z.enum([
  'document',
  'plan',
  'changeset',
  'command_output',
  'browser_capture',
  'file',
]);
const relativePath = z.string().max(1024).refine(isRuntimeRelativePath);
export const NativeFileVersionSchema = z
  .object({
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().min(0).max(9_000_000),
    version: ChecksumSchema,
  })
  .strict();
export const FileOrganizationItemSchema = z
  .object({
    path: LocalFilePathSchema,
    operation: z.enum(['copy', 'move', 'rename']),
    target: LocalFilePathSchema,
    source: NativeFileVersionSchema,
    expectedDestination: z.null(),
  })
  .strict()
  .refine((p) => p.path !== p.target, 'source and destination must differ');
export const FileOrganizationProposalSchema = z
  .object({
    operations: z.array(FileOrganizationItemSchema).min(1).max(32),
  })
  .strict()
  .superRefine((p, ctx) => {
    const paths = p.operations.flatMap((f) => [f.path, f.target]);
    if (
      new Set(paths.map((v) => v.toLocaleLowerCase())).size !== paths.length ||
      paths.some((a) =>
        paths.some((b) =>
          a.toLocaleLowerCase().startsWith(b.toLocaleLowerCase() + '/'),
        ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'overlapping file organization paths',
      });
    if (p.operations.reduce((n, f) => n + f.source.sizeBytes, 0) > 128_000_000)
      ctx.addIssue({ code: 'custom', message: 'file organization byte limit' });
  });
export type FileOrganizationItem = z.infer<typeof FileOrganizationItemSchema>;
/** The legacy text shape remains strict and unchanged; binary plans use their own discriminant. */
export const TextChangesetProposalSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: relativePath,
            before: z.string().max(200_000).nullable(),
            after: z.string().max(200_000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export const ChangesetProposalSchema = z.union([
  TextChangesetProposalSchema,
  FileOrganizationProposalSchema,
]);
export const ChangesetTextSchema = z
  .object({ text: z.string().max(200_000), checksum: ChecksumSchema })
  .strict();
/** A proposal, never a command or evidence of a completed filesystem write. */
export const ChangesetDocumentSchema = z
  .object({
    contractVersion: z.literal(1),
    comparisonScope: z.enum(['changeset', 'file_organization']),
    execution: RuntimeExecutionScopeSchema,
    files: z
      .array(
        z.union([
          z
            .object({
              path: relativePath,
              before: ChangesetTextSchema.nullable(),
              after: ChangesetTextSchema.nullable(),
            })
            .strict(),
          z
            .object({
              path: relativePath,
              before: z.null(),
              after: z.null(),
              organization: FileOrganizationItemSchema,
            })
            .strict()
            .refine((f) => f.path === f.organization.path),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.files.map((f) => f.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some((p) => paths.some((q) => p.startsWith(`${q}/`)))
    )
      ctx.addIssue({ code: 'custom', message: 'overlapping paths' });
    const organized = value.files.filter((f) => 'organization' in f);
    if (value.comparisonScope === 'file_organization') {
      if (
        organized.length !== value.files.length ||
        value.execution.workCopy.kind !== 'in_place'
      )
        ctx.addIssue({
          code: 'custom',
          message: 'file organization requires an in-place binary plan',
        });
      else {
        const checked = FileOrganizationProposalSchema.safeParse({
          operations: organized.map((f) => f.organization),
        });
        if (!checked.success)
          ctx.addIssue({
            code: 'custom',
            message: 'invalid file organization plan',
          });
      }
    } else if (organized.length)
      ctx.addIssue({
        code: 'custom',
        message: 'binary operation is not a text changeset',
      });
    if (
      value.comparisonScope === 'changeset' &&
      value.files.some((f) => !f.before && !f.after)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'a change must have before or after content',
      });
  });
export type ChangesetDocument = z.infer<typeof ChangesetDocumentSchema>;
export function changesetFileChecksums(
  file: ChangesetDocument['files'][number],
) {
  return 'organization' in file
    ? {
        beforeChecksum: file.organization.source.checksum,
        afterChecksum: file.organization.source.checksum,
      }
    : {
        beforeChecksum: file.before?.checksum ?? null,
        afterChecksum: file.after?.checksum ?? null,
      };
}
export const ArtifactSourceFileSchema = z
  .object({
    objectId: UuidSchema,
    checksum: ChecksumSchema,
  })
  .strict();
export type ArtifactSourceFile = z.infer<typeof ArtifactSourceFileSchema>;
export const ArtifactProvenanceSchema = z
  .object({
    kind: z.enum([
      'model_proposal',
      'tool_result',
      'legacy_deliverable',
      'project_snapshot',
    ]),
    runId: UuidSchema.nullable(),
    operationId: UuidSchema.nullable(),
    stepId: UuidSchema.nullable(),
  })
  .strict();
export const WorkbenchArtifactSchema = z
  .object({
    contractVersion: z.literal(1),
    // Identity IS the existing DeliverableVersion, not a second content version.
    id: UuidSchema,
    kind: WorkbenchArtifactKindSchema,
    version: DeliverableVersionSchema,
    object: StorageObjectSchema,
    provenance: ArtifactProvenanceSchema,
    execution: RuntimeExecutionScopeSchema.nullable(),
    latestVersionId: UuidSchema,
    stale: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const v = value.version,
      o = value.object;
    if (
      value.id !== v.id ||
      v.objectId !== o.id ||
      v.organizationId !== o.organizationId ||
      v.workspaceId !== o.workspaceId ||
      v.ownerId !== o.ownerId ||
      value.stale !== (value.latestVersionId !== value.id)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'inconsistent artifact identity',
      });
    if (
      (value.provenance.kind === 'legacy_deliverable' &&
        (value.provenance.runId !== null || value.execution !== null)) ||
      (value.provenance.kind !== 'legacy_deliverable' &&
        value.provenance.runId === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'inconsistent artifact provenance',
      });
  });
export type WorkbenchArtifact = z.infer<typeof WorkbenchArtifactSchema>;
export const WorkbenchCursorSchema = z
  .object({ createdAt: TimestampSchema, id: UuidSchema })
  .strict();
export const ReviewAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whole') }).strict(),
  z
    .object({
      kind: z.literal('lines'),
      path: relativePath.nullable(),
      side: z.enum(['before', 'after']),
      startLine: z.number().int().min(1).max(200_001),
      endLine: z.number().int().min(1).max(200_001),
      checksum: ChecksumSchema,
    })
    .strict()
    .refine((a) => a.endLine >= a.startLine),
]);
export const ReviewCommentSchema = z
  .object({
    id: UuidSchema,
    anchor: ReviewAnchorSchema,
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
export const ReviewDraftInputSchema = z
  .object({
    feedbackId: UuidSchema,
    artifactId: UuidSchema,
    checksum: ChecksumSchema,
    expectedRevision: z.number().int().nonnegative(),
    comments: z.array(ReviewCommentSchema).min(1).max(20),
  })
  .strict()
  .refine(
    (v) => new Set(v.comments.map((c) => c.id)).size === v.comments.length,
  );
export type ReviewDraftInput = z.infer<typeof ReviewDraftInputSchema>;
export const ReviewFeedbackSchema = z
  .object({
    id: UuidSchema,
    artifactId: UuidSchema,
    actorId: UuidSchema,
    revision: z.number().int().positive(),
    checksum: ChecksumSchema,
    comments: z.array(ReviewCommentSchema).min(1).max(20),
    state: z.enum(['draft', 'submitted', 'addressed']),
    stale: z.boolean(),
    resultArtifactId: UuidSchema.nullable(),
    resolution: z.string().max(4000).nullable(),
    createdAt: TimestampSchema,
    submittedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.state === 'draft') !== (value.submittedAt === null) ||
      (value.state === 'addressed') !== (value.resultArtifactId !== null) ||
      (value.resultArtifactId === null) !== (value.resolution === null)
    )
      ctx.addIssue({ code: 'custom', message: 'inconsistent feedback state' });
  });
export type ReviewFeedback = z.infer<typeof ReviewFeedbackSchema>;
