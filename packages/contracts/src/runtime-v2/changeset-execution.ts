import { z } from 'zod';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { ChangesetDocumentSchema } from './artifact-review.ts';
import { RuntimeOperationSnapshotSchema } from './operations.ts';
import { RuntimeActionApprovalSnapshotSchema } from './interactions.ts';

/** Requests an execution review, not an approval. The server loads all bytes. */
export const ChangesetActionInputSchema = z
  .object({
    artifactId: UuidSchema,
    checksum: ChecksumSchema,
    restoreOf: UuidSchema.nullable(),
  })
  .strict();
export type ChangesetActionInput = z.infer<typeof ChangesetActionInputSchema>;

/** New opt-in ledger action. Never advertised or accepted by the legacy HTTP queue. */
export const RuntimeChangesetSchema = z
  .object({
    capability: z.literal('local.fs.changeset'),
    arguments: z
      .object({
        path: z.literal('.'),
        artifactId: UuidSchema,
        checksum: ChecksumSchema,
        direction: z.enum(['apply', 'restore']),
        files: ChangesetDocumentSchema.shape.files,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.arguments.files.map((f) => f.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some((p) => paths.some((q) => p.startsWith(`${q}/`))) ||
      value.arguments.files.some((f) => !f.before && !f.after)
    )
      ctx.addIssue({ code: 'custom', message: 'invalid changeset files' });
  });
export type RuntimeChangeset = z.infer<typeof RuntimeChangesetSchema>;
export const ChangesetFileResultSchema = z
  .object({
    path: z.string().min(1).max(1024),
    status: z.enum([
      'pending',
      'prepared',
      'applied',
      'conflict',
      'canceled',
      'failed',
      'unknown',
    ]),
    beforeChecksum: ChecksumSchema.nullable(),
    afterChecksum: ChecksumSchema.nullable(),
    errorCode: z.string().max(120).optional(),
  })
  .strict();
export type ChangesetFileResult = z.infer<typeof ChangesetFileResultSchema>;
export const ChangesetExecutionResultSchema = z
  .object({
    contractVersion: z.literal(1),
    files: z.array(ChangesetFileResultSchema).min(1).max(32),
  })
  .strict();
export type ChangesetExecutionResult = z.infer<
  typeof ChangesetExecutionResultSchema
>;
export const ChangesetRunViewSchema = z
  .object({
    runId: UuidSchema,
    restoreOf: UuidSchema.nullable(),
    runState: z.string().max(40),
    snapshot: RuntimeOperationSnapshotSchema.nullable(),
    payload: RuntimeChangesetSchema.nullable(),
    approval: RuntimeActionApprovalSnapshotSchema.nullable(),
    evidence: z
      .object({
        result: ChangesetExecutionResultSchema.nullable(),
        summary: z.string().max(500).nullable(),
      })
      .strict(),
  })
  .strict();
export const ChangesetRunsResponseSchema = z
  .object({ executions: z.array(ChangesetRunViewSchema).max(20) })
  .strict();
export type ChangesetRunView = z.infer<typeof ChangesetRunViewSchema>;
