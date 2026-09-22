import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { isRuntimeRelativePath } from './runtime-v2/policy.ts';
import type { ChangesetDocument } from './runtime-v2/artifact-review.ts';
import { ChangesetProposalSchema } from './runtime-v2/artifact-review.ts';

/** Conservative across case-insensitive/NFD filesystems. This is a logical
 * ownership key, NOT physical path resolution or a symlink/sandbox boundary. */
export function developmentPathKey(path: string) {
  return path.normalize('NFC').toLowerCase();
}
export function developmentPathsOverlap(a: string, b: string) {
  const left = developmentPathKey(a),
    right = developmentPathKey(b);
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
export const DevelopmentPathsSchema = z
  .array(z.string().max(1024).refine(isRuntimeRelativePath))
  .min(1)
  .max(32)
  .superRefine((paths, ctx) => {
    if (
      paths.some((p, i) =>
        paths.slice(i + 1).some((q) => developmentPathsOverlap(p, q)),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'overlapping development paths',
      });
  });
export const DevelopmentArtifactRefSchema = z
  .object({
    artifactId: UuidSchema,
    digest: ChecksumSchema,
  })
  .strict();
export type DevelopmentArtifactRef = z.infer<
  typeof DevelopmentArtifactRefSchema
>;

/** Native tool requests contain references/content, never caller identity,
 * execution targets, leases, grants, checksums for generated files or receipts. */
export const DevelopmentCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('initialize'),
      seed: DevelopmentArtifactRefSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('assign'),
      ownerRunId: UuidSchema,
      expectedHead: DevelopmentArtifactRefSchema,
      role: z.enum(['edit', 'test', 'review']),
      paths: DevelopmentPathsSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('inspect'),
      assignmentId: UuidSchema.optional(),
      candidate: DevelopmentArtifactRefSchema.optional(),
    })
    .strict()
    .refine((command) => !(command.assignmentId && command.candidate), {
      message: 'Inspect an edit assignment OR a candidate, not both',
    }),
  z
    .object({
      action: z.literal('publish'),
      assignmentId: UuidSchema,
      proposal: ChangesetProposalSchema,
      previous: DevelopmentArtifactRefSchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('merge'),
      expectedHead: DevelopmentArtifactRefSchema,
      proposals: z.array(DevelopmentArtifactRefSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      candidate: DevelopmentArtifactRefSchema,
      operationId: UuidSchema,
      verdict: z.enum(['accept', 'revise']),
      summary: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      action: z.literal('deliver'),
      candidate: DevelopmentArtifactRefSchema,
      reviewId: UuidSchema,
    })
    .strict(),
]);

/** Pure proposal composition. A result is neither an applied filesystem change
 * nor test/review evidence. Before-text is still checked by the physical runner. */
export function composeDevelopmentChangesets(
  head: ChangesetDocument,
  proposals: ChangesetDocument[],
): ChangesetDocument {
  DevelopmentPathsSchema.parse(head.files.map((f) => f.path));
  DevelopmentPathsSchema.parse(
    proposals.flatMap((p) => p.files.map((f) => f.path)),
  );
  const files = new Map(head.files.map((f) => [f.path, f]));
  for (const proposal of proposals)
    for (const file of proposal.files) {
      if (
        [...files.keys()].some(
          (p) => p !== file.path && developmentPathsOverlap(p, file.path),
        )
      )
        throw Error('development_path_conflict');
      const previous = files.get(file.path);
      if (
        (previous?.after?.checksum ?? null) !== (file.before?.checksum ?? null)
      )
        throw Error('development_baseline_conflict');
      // Preserve the ORIGINAL filesystem baseline, not the intermediate version.
      const merged = {
        path: file.path,
        before: previous?.before ?? null,
        after: file.after,
      };
      if (!merged.before && !merged.after) files.delete(file.path);
      else files.set(file.path, merged);
    }
  if (files.size === 0 || files.size > 32)
    throw Error('development_file_limit');
  return {
    ...head,
    files: [...files.values()].sort((a, b) =>
      a.path.localeCompare(b.path, 'en'),
    ),
  };
}
