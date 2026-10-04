import { z } from 'zod';
import { ChecksumSchema } from './runs.ts';
import { isRuntimeRelativePath } from './runtime-v2/policy.ts';

// The complete local receipt, including maximally escaped 64 KiB output, must
// fit the existing 550 KB HTTP boundary. Source ZIPs are published server-side.
export const projectArtifactLimits = Object.freeze({
  files: 8,
  bytes: 100_000,
});
export const ProjectOutputSpecSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(240)
      .refine(isRuntimeRelativePath)
      .refine(
        (p) =>
          !p
            .split('/')
            .some((x) => ['.allrice', 'node_modules', '.venv'].includes(x)),
      ),
    fileName: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (s) =>
          !s.includes('/') &&
          !s.includes('\\') &&
          [...s].every((c) => c.codePointAt(0)! >= 32),
      ),
    format: z.enum(['html', 'json', 'text', 'zip']),
  })
  .strict();
export const ProjectOutputSpecsSchema = z
  .array(ProjectOutputSpecSchema)
  .max(projectArtifactLimits.files)
  .superRefine((files, ctx) => {
    if (
      new Set(files.map((f) => f.path)).size !== files.length ||
      new Set(files.map((f) => f.fileName)).size !== files.length
    )
      ctx.addIssue({ code: 'custom', message: 'duplicate_project_output' });
  });
export const ProjectCollectedArtifactSchema = z
  .object({
    path: ProjectOutputSpecSchema.shape.path,
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().nonnegative().max(projectArtifactLimits.bytes),
    contentBase64: z.string().max(133_336),
  })
  .strict();
export const ProjectCollectedArtifactsSchema = z
  .array(ProjectCollectedArtifactSchema)
  .max(projectArtifactLimits.files)
  .superRefine((files, ctx) => {
    if (
      files.reduce((n, f) => n + f.sizeBytes, 0) >
        projectArtifactLimits.bytes ||
      new Set(files.map((f) => f.path)).size !== files.length
    )
      ctx.addIssue({ code: 'custom', message: 'project_artifact_limit' });
  });
export type ProjectOutputSpec = z.infer<typeof ProjectOutputSpecSchema>;
export type ProjectCollectedArtifact = z.infer<
  typeof ProjectCollectedArtifactSchema
>;
export function projectArtifactsMatchOutputs(
  outputs: ProjectOutputSpec[] | undefined,
  artifacts: ProjectCollectedArtifact[] | undefined,
  succeeded: boolean,
) {
  const requested = outputs ?? [],
    collected = artifacts ?? [];
  return succeeded
    ? requested.length === collected.length &&
        requested.every((f) => collected.some((a) => a.path === f.path))
    : collected.length === 0;
}
