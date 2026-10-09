import { z } from 'zod';
import {
  ChecksumSchema,
  UuidSchema,
  isRuntimeRelativePath,
} from '@allrice/contracts';
import { RepositoryPublicationCiSchema } from './platform-repository-publication-contracts.ts';
import { RepositoryBaselineSchema } from './platform-repair-contracts.ts';
import { MaintenanceGithubIdentitySchema } from './platform-maintenance-github-contracts.ts';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const maintenanceRepairSpecId = 'command-output.credentials.v2' as const;
export const MaintenanceApprovedFileSchema = z
  .object({
    path: z.string().max(240).refine(isRuntimeRelativePath),
    mode: z.literal('100644'),
    beforeChecksum: ChecksumSchema,
    maxBytes: z.number().int().min(1).max(50000),
  })
  .strict();
export const MaintenanceRepairPlanSchema = z
  .object({
    version: z.literal(1),
    specId: z.literal(maintenanceRepairSpecId),
    fixtureDigest: ChecksumSchema,
    harnessChecksum: ChecksumSchema,
    approvedFiles: z.array(MaintenanceApprovedFileSchema).min(1).max(5),
    dependencyBundleChecksum: ChecksumSchema,
    dependencyMaterialDigest: ChecksumSchema,
    dependencyPlanDigest: ChecksumSchema,
    packages: z.tuple([
      z.literal('@allrice/contracts'),
      z.literal('@allrice/project-runtime'),
    ]),
    compilerVersion: z.literal('5.9.3'),
    nodeVersion: z.string().regex(/^v22\.\d+\.\d+$/),
    timeoutMs: z.number().int().min(300000).max(1800000).multipleOf(300000),
    network: z.literal('none'),
    candidateUid: z.literal(1001),
    compilerUid: z.literal(1002),
    memoryMiB: z.literal(768),
    compilerHeapMiB: z.literal(384),
  })
  .strict();
export const MaintenanceSourceMappingSchema = z
  .object({
    version: z.literal(1),
    specId: z.literal(maintenanceRepairSpecId),
    sourceTree: sha.nullable(),
    sourcePath: z.literal('packages/project-runtime/src/command-output.ts'),
    sourceChecksum: ChecksumSchema,
    outputPath: z.literal('packages/project-runtime/dist/command-output.js'),
    outputChecksum: ChecksumSchema,
    exportEntryPath: z.literal('packages/project-runtime/dist/index.js'),
    exportEntryChecksum: ChecksumSchema,
    compilerVersion: z.literal('5.9.3'),
    compilerChecksum: ChecksumSchema,
    configuration: z
      .array(
        z
          .object({
            path: z.enum([
              'tsconfig.base.json',
              'packages/project-runtime/tsconfig.json',
              'packages/project-runtime/tsconfig.build.json',
              'packages/project-runtime/package.json',
            ]),
            checksum: ChecksumSchema,
          })
          .strict(),
      )
      .length(4),
    sourceIndependentlyCompiled: z.literal(true),
  })
  .strict();
export const MaintenanceProbeResultSchema = z
  .object({
    id: z.enum(['quoted_spaces', 'quoted_escapes', 'streamed_secret']),
    completed: z.literal(true),
    redactionMarkerPresent: z.boolean(),
    secretAbsent: z.boolean(),
    passed: z.boolean(),
  })
  .strict();
export const MaintenanceDiagnosisProofSchema = z
  .object({
    version: z.literal(1),
    specId: z.literal(maintenanceRepairSpecId),
    baseline: RepositoryBaselineSchema,
    verificationPlan: MaintenanceRepairPlanSchema,
    verificationPlanDigest: ChecksumSchema,
    producerSourceSha: sha,
    producerSourceTree: sha,
    producerManifestDigest: ChecksumSchema,
    producerArtifactDigest: ChecksumSchema,
    producerBootId: UuidSchema,
    producerNodeVersion: z.string().regex(/^v22\.\d+\.\d+$/),
    producerRuntimeGraphDigest: ChecksumSchema,
    sourceMapping: MaintenanceSourceMappingSchema,
    sourceMappingDigest: ChecksumSchema,
    moduleArtifactDigest: ChecksumSchema,
    exportEntryArtifactDigest: ChecksumSchema,
    oracleChecksum: ChecksumSchema,
    probeResults: z.array(MaintenanceProbeResultSchema).length(3),
    failedAssertions: z
      .array(z.enum(['quoted_spaces', 'quoted_escapes', 'streamed_secret']))
      .max(3),
    verdict: z.enum(['confirmed_code', 'not_reproduced']),
  })
  .strict();
export const MaintenanceDiagnosisSchema = z
  .object({
    id: UuidSchema,
    reportId: UuidSchema,
    targetSha: sha,
    defectId: UuidSchema.nullable(),
    proof: MaintenanceDiagnosisProofSchema,
    proofDigest: ChecksumSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const CreateMaintenanceGrantSchema = z
  .object({
    requestId: UuidSchema,
    reportId: UuidSchema,
    expectedReportDigest: ChecksumSchema,
    expectedDiagnosisDigest: ChecksumSchema,
    expectedDeploymentRevision: z.number().int().positive(),
  })
  .strict();
export const MaintenanceGrantFrozenSchema = z
  .object({
    version: z.literal(1),
    reportId: UuidSchema,
    reportDigest: ChecksumSchema,
    deploymentId: UuidSchema,
    companySlug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    companyName: z.string().max(80),
    deploymentName: z.string().max(80),
    installedReleaseSha: sha,
    diagnosisId: UuidSchema,
    diagnosisDigest: ChecksumSchema,
    defectId: UuidSchema,
    baseline: RepositoryBaselineSchema,
    verificationPlan: MaintenanceRepairPlanSchema,
    verificationPlanDigest: ChecksumSchema,
    policyRevision: z.number().int().positive(),
    credentialRevision: z.number().int().positive(),
    origin: z.enum(['manual', 'automatic']),
    repairTimeoutMs: z.number().int().min(300000).max(7200000),
    maxCandidateRevisions: z.number().int().min(1).max(3),
    maxOutputTokens: z.number().int().min(1000).max(100000),
    // Old report-only grants remain readable. New execution requires this
    // explicit subscription-safe threshold semantics and finite call budget.
    githubBot: MaintenanceGithubIdentitySchema.optional(),
    outputBudgetMode: z.literal('observed_threshold').optional(),
    maxModelCalls: z.literal(16).optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const MaintenanceGrantSchema = z
  .object({
    requestId: UuidSchema.optional(),
    canControl: z.boolean().optional(),
    repairStatus: z.string().max(40).nullable().optional(),
    publication: z
      .object({
        id: UuidSchema,
        url: z
          .string()
          .regex(/^https:\/\/github\.com\/semiok\/allrice\/pull\/[1-9]\d*$/)
          .nullable(),
        number: z.number().int().positive().nullable(),
        ci: RepositoryPublicationCiSchema,
        sourceCompanySlug: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
    id: UuidSchema,
    reportId: UuidSchema,
    deploymentId: UuidSchema,
    defectId: UuidSchema,
    origin: z.enum(['manual', 'automatic']),
    frozenDigest: ChecksumSchema,
    attemptId: UuidSchema,
    expiresAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    repairTaskId: UuidSchema.nullable(),
    publicationId: UuidSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MaintenanceGrantFrozen = z.infer<
  typeof MaintenanceGrantFrozenSchema
>;
export type MaintenanceDiagnosisProof = z.infer<
  typeof MaintenanceDiagnosisProofSchema
>;
export const MaintenanceReportAuthoritySchema = z
  .object({
    diagnoses: z.array(MaintenanceDiagnosisSchema).max(10),
    grants: z.array(MaintenanceGrantSchema).max(10),
  })
  .strict();

export type MaintenanceRepairPlan = z.infer<typeof MaintenanceRepairPlanSchema>;
