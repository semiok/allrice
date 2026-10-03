import { z } from 'zod';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import {
  ChangesetDocumentSchema,
  changesetFileChecksums,
  NativeFileVersionSchema,
  FileOrganizationProposalSchema,
} from './artifact-review.ts';
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
        comparisonScope: z.literal('file_organization').optional(),
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
      value.arguments.files.some(
        (f) => !f.before && !f.after && !('organization' in f),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'invalid changeset files' });
    const organized = value.arguments.files.filter((f) => 'organization' in f);
    if (value.arguments.comparisonScope === 'file_organization') {
      if (
        organized.length !== value.arguments.files.length ||
        !FileOrganizationProposalSchema.safeParse({
          operations: organized.map((f) => f.organization),
        }).success
      )
        ctx.addIssue({
          code: 'custom',
          message: 'invalid file organization payload',
        });
    } else if (organized.length)
      ctx.addIssue({
        code: 'custom',
        message: 'binary operation without organization discriminant',
      });
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
    organization: z
      .object({
        target: z.string().min(1).max(1024),
        operation: z.enum(['copy', 'move', 'rename']),
        stage: z.string().max(80),
        sourceRemoved: z.boolean(),
        file: NativeFileVersionSchema.optional(),
        recovery: z
          .object({
            path: z.string().max(1024),
            checksum: ChecksumSchema.optional(),
          })
          .strict()
          .optional(),
        sourceRecovery: z
          .object({ path: z.string().max(1024) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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

/** Receipt bytes and paths must match the exact reviewed operation. */
export function changesetFileAppliedMatches(
  file: RuntimeChangeset['arguments']['files'][number],
  result: ChangesetFileResult,
) {
  const sums = changesetFileChecksums(file);
  if (
    result.status !== 'applied' ||
    result.path !== file.path ||
    result.beforeChecksum !== sums.beforeChecksum ||
    result.afterChecksum !== sums.afterChecksum
  )
    return false;
  if (!('organization' in file)) return result.organization === undefined;
  const p = file.organization,
    r = result.organization;
  return (
    !!r &&
    r.operation === p.operation &&
    r.target === p.target &&
    r.stage === 'complete' &&
    r.sourceRemoved === (p.operation !== 'copy') &&
    r.file?.checksum === p.source.checksum &&
    r.file.sizeBytes === p.source.sizeBytes &&
    r.recovery?.path === p.target &&
    r.recovery.checksum === p.source.checksum
  );
}

/** Partial/unknown receipts retain the same ordered plan; they cannot invent a write. */
export function fileOrganizationResultMatches(
  payload: RuntimeChangeset,
  result: ChangesetExecutionResult,
) {
  return (
    payload.arguments.comparisonScope === 'file_organization' &&
    result.files.length === payload.arguments.files.length &&
    result.files.every((receipt, index) => {
      const file = payload.arguments.files[index]!;
      if (!('organization' in file)) return false;
      const item = file.organization,
        sums = changesetFileChecksums(file),
        detail = receipt.organization;
      if (
        receipt.path !== file.path ||
        receipt.beforeChecksum !== sums.beforeChecksum ||
        receipt.afterChecksum !== sums.afterChecksum ||
        detail?.target !== item.target ||
        detail.operation !== item.operation
      )
        return false;
      if (receipt.status === 'applied')
        return changesetFileAppliedMatches(file, receipt);
      return (
        !detail.file && (receipt.status === 'unknown' || !detail.sourceRemoved)
      );
    })
  );
}

/** Copy outputs remain; only confirmed moves are reversible, with fresh destination identity. */
export function fileOrganizationRestoration(
  files: RuntimeChangeset['arguments']['files'],
  results: ChangesetFileResult[],
) {
  return [...files].reverse().flatMap((file) => {
    if (!('organization' in file) || file.organization.operation === 'copy')
      return [];
    const receipt = results.find((r) => changesetFileAppliedMatches(file, r));
    if (!receipt?.organization?.file) return [];
    const p = file.organization;
    return [
      {
        path: p.target,
        before: null,
        after: null,
        organization: {
          ...p,
          path: p.target,
          target: p.path,
          source: receipt.organization.file,
          expectedDestination: null,
        },
      },
    ];
  });
}
