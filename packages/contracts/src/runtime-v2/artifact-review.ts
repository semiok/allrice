import { z } from 'zod';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { StorageObjectSchema } from '../storage.ts';
import { DeliverableVersionSchema } from '../operations.ts';
import { RuntimeExecutionScopeSchema } from './identity.ts';
import { isRuntimeRelativePath } from './policy.ts';

export const WorkbenchArtifactKindSchema = z.enum([
  'document',
  'plan',
  'changeset',
  'command_output',
  'browser_capture',
  'file',
]);
const relativePath = z.string().max(1024).refine(isRuntimeRelativePath);
/** Model-authored text only. Execution identity and checksums are server-owned. */
export const ChangesetProposalSchema = z
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
export const ChangesetTextSchema = z
  .object({ text: z.string().max(200_000), checksum: ChecksumSchema })
  .strict();
/** A proposal, never a command or evidence of a completed filesystem write. */
export const ChangesetDocumentSchema = z
  .object({
    contractVersion: z.literal(1),
    comparisonScope: z.literal('changeset'),
    execution: RuntimeExecutionScopeSchema,
    files: z
      .array(
        z
          .object({
            path: relativePath,
            before: ChangesetTextSchema.nullable(),
            after: ChangesetTextSchema.nullable(),
          })
          .strict(),
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
    if (value.files.some((f) => !f.before && !f.after))
      ctx.addIssue({
        code: 'custom',
        message: 'a change must have before or after content',
      });
  });
export type ChangesetDocument = z.infer<typeof ChangesetDocumentSchema>;
export const ArtifactSourceFileSchema = z
  .object({
    objectId: UuidSchema,
    checksum: ChecksumSchema,
  })
  .strict();
export type ArtifactSourceFile = z.infer<typeof ArtifactSourceFileSchema>;
export const ArtifactProvenanceSchema = z
  .object({
    kind: z.enum(['model_proposal', 'tool_result', 'legacy_deliverable']),
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
