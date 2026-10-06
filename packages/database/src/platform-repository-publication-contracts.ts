import { z } from 'zod';
import { ChecksumSchema, UuidSchema } from '@allrice/contracts';
import { platformRepository } from './platform-repository-credential-contracts.ts';

export const repositoryPublicationJobType =
  'allrice.platform.repository' as const;
export const repositoryRequiredChecks = [
  'validate',
  'developer-bootstrap',
  'tenant-workbench-browser',
  'compose-smoke',
] as const;
export const RepositoryGitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const RepositoryPublicationRequestSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('publish'),
        requestId: UuidSchema,
        repairTaskId: UuidSchema,
        credentialRevision: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        action: z.literal('inspect'),
        requestId: UuidSchema,
        publicationId: UuidSchema,
        credentialRevision: z.number().int().positive(),
      })
      .strict(),
  ],
);
export const RepositoryPublicationSourceSchema = z
  .object({
    version: z.literal(1),
    repairTaskId: UuidSchema,
    repairRunId: UuidSchema,
    repairJobId: UuidSchema,
    baseSha: RepositoryGitShaSchema,
    baseTree: RepositoryGitShaSchema,
    baselineSourceDigest: ChecksumSchema,
    candidateChecksum: ChecksumSchema,
    candidateMaterialDigest: ChecksumSchema,
    reportDigest: ChecksumSchema,
    rootLockChecksum: ChecksumSchema,
    dependencyConfigurationDigest: ChecksumSchema,
    beforeChecksum: ChecksumSchema,
    afterChecksum: ChecksumSchema,
    beforeBlob: RepositoryGitShaSchema,
    afterBlob: RepositoryGitShaSchema,
    afterBase64: z.string().min(1).max(66668),
    path: z.literal('packages/project-runtime/src/command-output.ts'),
    mode: z.literal('100644'),
  })
  .strict();
export type RepositoryPublicationSource = z.infer<
  typeof RepositoryPublicationSourceSchema
>;
export const RepositoryPublicationSteps = [
  'blob',
  'tree',
  'commit',
  'branch',
  'pull',
] as const;
export const RepositoryPublicationStepSchema = z.enum(
  RepositoryPublicationSteps,
);
export type RepositoryPublicationStep = z.infer<
  typeof RepositoryPublicationStepSchema
>;
export const RepositoryPublicationRemoteSchema = z
  .object({
    repositoryId: z.literal(platformRepository.id),
    repository: z.literal(platformRepository.fullName),
    branch: z.string().regex(/^allrice\/repairs\/[a-f0-9-]{36}$/),
    number: z.number().int().positive(),
    url: z
      .string()
      .regex(/^https:\/\/github\.com\/semiok\/allrice\/pull\/[1-9]\d*$/),
    headSha: RepositoryGitShaSchema,
    tree: RepositoryGitShaSchema,
    baseSha: RepositoryGitShaSchema,
  })
  .strict()
  .refine(
    (r) =>
      r.url ===
      `https://github.com/${platformRepository.fullName}/pull/${r.number}`,
  );
export const RepositoryPublicationCiSchema = z
  .object({
    state: z.enum([
      'not_observed',
      'pending',
      'unknown',
      'failed',
      'stale',
      'passed',
    ]),
    observedAt: z.string().datetime({ offset: true }).nullable(),
    workflowRunId: z.number().int().positive().nullable(),
    runAttempt: z.number().int().positive().nullable(),
    headSha: RepositoryGitShaSchema.nullable(),
    checkoutSha: RepositoryGitShaSchema.nullable(),
    checkoutTree: RepositoryGitShaSchema.nullable(),
    materialDigest: ChecksumSchema.nullable(),
    receipts: z
      .array(
        z
          .object({
            name: z.enum(repositoryRequiredChecks),
            artifactId: z.number().int().positive(),
            archiveDigest: ChecksumSchema,
            receiptDigest: ChecksumSchema,
          })
          .strict(),
      )
      .max(4)
      .default([]),
    checks: z
      .array(
        z
          .object({
            name: z.enum(repositoryRequiredChecks),
            id: z.number().int().positive(),
            conclusion: z.enum([
              'pending',
              'success',
              'failure',
              'cancelled',
              'skipped',
              'unknown',
            ]),
          })
          .strict(),
      )
      .max(4),
  })
  .strict()
  .refine(
    (ci) =>
      ci.state !== 'passed' ||
      (ci.observedAt !== null &&
        ci.workflowRunId !== null &&
        ci.runAttempt !== null &&
        ci.headSha !== null &&
        ci.checkoutSha !== null &&
        ci.checkoutTree !== null &&
        ci.materialDigest !== null &&
        ci.checks.length === 4 &&
        ci.receipts.length === 4 &&
        new Set(ci.receipts.map((r) => r.name)).size === 4 &&
        new Set(ci.receipts.map((r) => r.artifactId)).size === 4 &&
        new Set(ci.checks.map((c) => c.name)).size === 4 &&
        new Set(ci.checks.map((c) => c.id)).size === 4 &&
        ci.checks.every((c) => c.conclusion === 'success')),
    'Passed CI requires all original gates and complete version identity',
  );
export const RepositoryPublicationActionSchema = z
  .object({
    id: UuidSchema,
    requestId: UuidSchema,
    action: z.enum(['publish', 'inspect']),
    runId: UuidSchema,
    jobId: UuidSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    errorCode: z.string().max(120).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const RepositoryPublicationSchema = z
  .object({
    id: UuidSchema,
    repositoryId: z.literal(platformRepository.id),
    repository: z.literal(platformRepository.fullName),
    repairTaskId: UuidSchema,
    baseSha: RepositoryGitShaSchema,
    candidateChecksum: ChecksumSchema,
    revision: z.number().int().nonnegative(),
    branch: z.string().regex(/^allrice\/repairs\/[a-f0-9-]{36}$/),
    steps: z
      .array(
        z
          .object({
            step: RepositoryPublicationStepSchema,
            state: z.enum(['not_started', 'started', 'confirmed']),
          })
          .strict(),
      )
      .length(5),
    remote: RepositoryPublicationRemoteSchema.nullable(),
    ci: RepositoryPublicationCiSchema,
    actions: z.array(RepositoryPublicationActionSchema).max(20),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type RepositoryPublication = z.infer<typeof RepositoryPublicationSchema>;
