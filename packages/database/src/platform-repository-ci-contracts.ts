import { z } from 'zod';
import { ChecksumSchema } from '@allrice/contracts';
import { platformRepository } from './platform-repository-credential-contracts.ts';
import {
  RepositoryGitShaSchema,
  repositoryRequiredChecks,
} from './platform-repository-publication-contracts.ts';
export const RepositoryCiReceiptSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal('allrice.repository-ci.v1'),
    repositoryId: z.literal(platformRepository.id),
    repository: z.literal(platformRepository.fullName),
    workflowPath: z.literal('.github/workflows/ci.yml'),
    workflowBlob: RepositoryGitShaSchema,
    workflowRunId: z.number().int().positive(),
    runAttempt: z.number().int().positive(),
    job: z.enum(repositoryRequiredChecks),
    event: z.enum(['push', 'pull_request']),
    pullRequest: z.number().int().positive().nullable(),
    headSha: RepositoryGitShaSchema.nullable(),
    baseSha: RepositoryGitShaSchema.nullable(),
    checkoutSha: RepositoryGitShaSchema,
    checkoutTree: RepositoryGitShaSchema,
    materialDigest: ChecksumSchema,
    rootLockChecksum: ChecksumSchema,
    dependencyConfigurationDigest: ChecksumSchema,
    nodeVersion: z.string().regex(/^v22\.\d+\.\d+$/),
    runnerOs: z.literal('Linux'),
    runnerArch: z.literal('X64'),
    build: z
      .object({
        rootScript: z.literal('pnpm -r --if-present run build'),
        packages: z
          .array(
            z
              .object({
                name: z.string().regex(/^@allrice\/[a-z-]+$/),
                path: z.string().regex(/^(apps|packages)\/[a-z-]+$/),
                scriptChecksum: ChecksumSchema,
                outputDigest: ChecksumSchema,
                fileCount: z.number().int().positive().max(50000),
                sizeBytes: z.number().int().positive().max(1_000_000_000),
              })
              .strict(),
          )
          .min(1)
          .max(40),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (r) => (r.job === 'validate') === (r.build !== null),
    'Only the full validation job attests the root build',
  );
export type RepositoryCiReceipt = z.infer<typeof RepositoryCiReceiptSchema>;
