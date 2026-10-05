import { z } from 'zod';
import {
  ChecksumSchema,
  UuidSchema,
  isRuntimeRelativePath,
  TextChangesetProposalSchema,
} from '@allrice/contracts';

// Private platform source/profile contract. Ordinary project and Bridge limits
// remain unchanged; only this registered repository source uses these budgets.
export const repositorySourceLimits = Object.freeze({
  files: 4096,
  fileBytes: 2_000_000,
  totalBytes: 32_000_000,
  archiveBytes: 12_000_000,
  jsonBytes: 48_000_000,
});
export const repairProfileId = 'allrice.output-redaction.v1' as const;
export const repairProductPath =
  'packages/project-runtime/src/command-output.ts';
export const RepositorySourceFileSchema = z
  .object({
    path: z.string().min(1).max(240).refine(isRuntimeRelativePath),
    mode: z.enum(['100644', '100755']),
    sizeBytes: z.number().int().min(0).max(repositorySourceLimits.fileBytes),
    checksum: ChecksumSchema,
    contentBase64: z.string().max(2_666_672),
  })
  .strict();
export const RepositoryArchiveSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(RepositorySourceFileSchema)
      .min(1)
      .max(repositorySourceLimits.files),
  })
  .strict();
export type RepositoryArchive = z.infer<typeof RepositoryArchiveSchema>;
export const RepositoryBaselineSchema = z
  .object({
    version: z.literal(1),
    id: UuidSchema,
    repositoryId: z.literal('semiok/allrice'),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    gitTree: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDigest: ChecksumSchema,
    rootLockChecksum: ChecksumSchema,
    dependencyConfigurationDigest: ChecksumSchema,
    archiveChecksum: ChecksumSchema,
    archiveBytes: z
      .number()
      .int()
      .min(1)
      .max(repositorySourceLimits.archiveBytes),
    fileCount: z.number().int().min(1).max(repositorySourceLimits.files),
    sourceBytes: z.number().int().min(1).max(repositorySourceLimits.totalBytes),
    observedDevSha: z.string().regex(/^[a-f0-9]{40}$/),
    registeredAt: z.string().datetime({ offset: true }),
    materializer: z.literal('git-tracked-json-gzip-v1'),
    profileId: z.literal(repairProfileId),
    dependencyMode: z.literal('runtime_builtins_only'),
    monorepoDependenciesInstalled: z.literal(false),
  })
  .strict();
export type RepositoryBaseline = z.infer<typeof RepositoryBaselineSchema>;
export const RepositoryCatalogSchema = z
  .object({
    state: z.enum(['available', 'not_configured', 'unavailable']),
    baselines: z.array(RepositoryBaselineSchema).max(12),
  })
  .strict();
export const RepairFilePatchSchema = z
  .object({
    path: z.literal(repairProductPath),
    beforeChecksum: ChecksumSchema,
    afterBase64: z.string().max(66_668),
  })
  .strict();
export const RepositoryCandidateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(0).max(3),
    checksum: ChecksumSchema,
    files: z.array(RepairFilePatchSchema).max(1),
  })
  .strict();
export type RepositoryCandidate = z.infer<typeof RepositoryCandidateSchema>;
export const RepositoryVerificationSchema = z
  .object({
    version: z.literal(1),
    baselineId: UuidSchema,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    baselineSourceDigest: ChecksumSchema,
    restoredDigest: ChecksumSchema,
    candidateChecksum: ChecksumSchema,
    candidateMaterialDigest: ChecksumSchema,
    actualMaterialDigest: ChecksumSchema,
    rootLockChecksum: ChecksumSchema,
    dependencyConfigurationDigest: ChecksumSchema,
    profileId: z.literal(repairProfileId),
    harnessChecksum: ChecksumSchema,
    dependencyMode: z.literal('runtime_builtins_only'),
    monorepoDependenciesInstalled: z.literal(false),
    nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
    sourceFileCount: z.number().int().min(1).max(repositorySourceLimits.files),
    sourceBytes: z.number().int().min(1).max(repositorySourceLimits.totalBytes),
    candidateIdentity: z
      .object({
        uid: z.literal(1001),
        gid: z.literal(1001),
        capabilities: z.literal('none'),
      })
      .strict(),
    assertions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_]{1,60}$/),
            passed: z.boolean(),
          })
          .strict(),
      )
      .length(8),
    failureKind: z.enum(['assertion_failed', 'harness_error']).nullable(),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(3)]),
  })
  .strict();
export type RepositoryVerification = z.infer<
  typeof RepositoryVerificationSchema
>;
/** Worker-only sidecar from the persisted private operation, never model args. */
export const RepositoryExecutionProofSchema = z
  .object({
    version: z.literal(1),
    profileId: z.literal(repairProfileId),
    commandDigest: ChecksumSchema,
    baselineId: UuidSchema,
    candidateChecksum: ChecksumSchema,
    inputLimit: z.literal(repositorySourceLimits.archiveBytes),
    tmpfsMiB: z.literal(64),
  })
  .strict();
export type RepositoryExecutionProof = z.infer<
  typeof RepositoryExecutionProofSchema
>;

export const CreateRepairTaskSchema = z
  .object({
    requestId: UuidSchema,
    baselineId: UuidSchema,
  })
  .strict();
export const RepairToolInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('apply'),
      expectedCandidate: ChecksumSchema,
      proposal: TextChangesetProposalSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('verify'), candidateChecksum: ChecksumSchema })
    .strict(),
]);
export const RepairArtifactSchema = z
  .object({
    artifactId: UuidSchema,
    versionId: UuidSchema,
    objectId: UuidSchema,
    checksum: ChecksumSchema,
    fileName: z.string().min(1).max(120),
    sizeBytes: z.number().int().nonnegative().max(200000),
    kind: z.enum(['candidate', 'report']),
  })
  .strict();
export const RepairVerificationObservationSchema = z
  .object({
    completedAt: z.string().datetime({ offset: true }),
    revision: z.number().int().min(0).max(3),
    operationId: UuidSchema,
    report: RepositoryVerificationSchema,
    stopped: z.literal(true),
    cleanup: z.literal('confirmed'),
  })
  .strict();
export const RepairReportSchema = z
  .object({
    version: z.literal(1),
    candidateChecksum: ChecksumSchema,
    before: RepairVerificationObservationSchema,
    after: RepairVerificationObservationSchema,
    artifacts: z.array(RepairArtifactSchema).length(2),
    completedAt: z.string().datetime({ offset: true }),
    verdict: z.literal('fixed_assertions_passed'),
    publishedToMain: z.literal(false),
    wholeRepositoryBuildVerified: z.literal(false),
  })
  .strict()
  .refine(
    (r) =>
      r.before.revision === 0 &&
      r.before.report.exitCode === 1 &&
      r.before.report.failureKind === 'assertion_failed' &&
      r.after.revision > 0 &&
      r.after.report.exitCode === 0 &&
      r.after.report.candidateChecksum === r.candidateChecksum &&
      r.artifacts.some((a) => a.kind === 'candidate') &&
      r.artifacts.some((a) => a.kind === 'report'),
    'Repair completion requires actual before/after verification for the candidate',
  );
export const RepairTaskSchema = z
  .object({
    id: UuidSchema,
    requestId: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    sessionId: UuidSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    baseline: RepositoryBaselineSchema,
    releaseSha: z.string().regex(/^[a-f0-9]{40}$/),
    employeeVersionId: UuidSchema,
    employeeRevisionId: UuidSchema,
    candidate: RepositoryCandidateSchema,
    source: z
      .object({
        path: z.literal(repairProductPath),
        before: z.string().max(50000),
        after: z.string().max(50000).nullable(),
      })
      .strict(),
    verifications: z.array(RepairVerificationObservationSchema).max(4),
    report: RepairReportSchema.nullable(),
    accepted: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    errorCode: z.string().max(120).nullable(),
  })
  .strict()
  .refine(
    (q) => q.accepted === (q.status === 'succeeded' && q.report !== null),
  );
export type RepairTask = z.infer<typeof RepairTaskSchema>;
export type RepairReport = z.infer<typeof RepairReportSchema>;
export type RepairVerificationObservation = z.infer<
  typeof RepairVerificationObservationSchema
>;
