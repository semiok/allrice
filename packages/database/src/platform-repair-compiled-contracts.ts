import { z } from 'zod';
import { ChecksumSchema, isRuntimeRelativePath } from '@allrice/contracts';

/** Server-only finite verification profile. Ordinary cloud/Bridge contracts do
 * not acquire its input, writable volume, compiler or candidate permissions. */
export const compiledRepairProfileId = 'allrice.output-redaction.compiled.v1';
export const compiledRepairLimits = Object.freeze({
  bundleBytes: 12_000_000,
  inputBytes: 23_000_000,
  jsonBytes: 18_000_000,
  tmpfsMiB: 128,
  memoryMiB: 768,
  compilerHeapMiB: 384,
  defaultTimeoutMs: 300_000,
  maximumTimeoutMs: 1_800_000,
});
export const compiledRepairPackages = [
  '@allrice/contracts',
  '@allrice/project-runtime',
] as const;
const digest = ChecksumSchema;
export const CompiledVerificationTimeoutSchema = z
  .number()
  .int()
  .min(compiledRepairLimits.defaultTimeoutMs)
  .max(compiledRepairLimits.maximumTimeoutMs)
  .multipleOf(300_000);
export const CompiledDependencyDescriptorSchema = z
  .object({
    version: z.literal(1),
    profileId: z.literal(compiledRepairProfileId),
    rootLockChecksum: digest,
    dependencyConfigurationDigest: digest,
    bundleChecksum: digest,
    bundleBytes: z
      .number()
      .int()
      .positive()
      .max(compiledRepairLimits.bundleBytes),
    materialDigest: digest,
    planDigest: digest,
    nodeVersion: z.string().regex(/^v22\.\d+\.\d+$/),
    timeoutMs: CompiledVerificationTimeoutSchema,
    memoryMiB: z.literal(768),
    compilerHeapMiB: z.literal(384),
    manager: z
      .object({
        version: z.literal('10.33.3'),
        checksum: digest,
        sizeBytes: z.number().int().positive().max(5_000_000),
      })
      .strict(),
    packages: z
      .array(
        z
          .object({
            name: z.string().regex(/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/),
            version: z.string().regex(/^\d+\.\d+\.\d+$/),
            integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
            checksum: digest,
            sizeBytes: z.number().int().positive().max(5_000_000),
          })
          .strict(),
      )
      .length(7),
  })
  .strict();
export type CompiledDependencyDescriptor = z.infer<
  typeof CompiledDependencyDescriptorSchema
>;
export const CompiledDependencyBundleSchema = z
  .object({
    version: z.literal(1),
    profileId: z.literal(compiledRepairProfileId),
    rootLockChecksum: digest,
    dependencyConfigurationDigest: digest,
    files: z
      .array(
        z
          .object({
            path: z.string().max(120).refine(isRuntimeRelativePath),
            checksum: digest,
            contentBase64: z.string().max(6_666_672),
            sizeBytes: z.number().int().nonnegative().max(5_000_000),
          })
          .strict(),
      )
      .length(11),
  })
  .strict();
export type CompiledDependencyBundle = z.infer<
  typeof CompiledDependencyBundleSchema
>;
const step = z
  .object({
    id: z.enum(['dependencies', 'build_contracts', 'build_project_runtime']),
    argv: z.array(z.string().max(240)).max(18),
    cwd: z.string().max(200),
    originalScript: z.string().max(100).nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(20).nullable(),
    elapsedMs: z.number().int().nonnegative(),
    outputDigest: digest,
    outputBytes: z.number().int().nonnegative().max(65536),
    outputTruncated: z.boolean(),
    status: z.enum(['passed', 'failed', 'not_run']),
  })
  .strict();
export const CompiledRepositoryEvidenceSchema = z
  .object({
    dependencyBundleChecksum: digest,
    dependencyMaterialDigest: digest,
    planDigest: digest,
    managerVersion: z.literal('10.33.3'),
    compilerVersion: z.literal('5.9.3'),
    compilerIdentity: z
      .object({
        uid: z.literal(1002),
        gid: z.literal(1002),
        capabilities: z.literal('none'),
      })
      .strict(),
    steps: z.array(step).length(3),
    packages: z
      .array(
        z
          .object({
            name: z.enum(compiledRepairPackages),
            digest,
            fileCount: z.number().int().nonnegative().max(600),
            sizeBytes: z.number().int().nonnegative().max(8_000_000),
          })
          .strict(),
      )
      .length(2),
    productionEntry: z.literal('packages/project-runtime/dist/index.js'),
    executionTarget: z.literal('production_package_export'),
    timeoutMs: CompiledVerificationTimeoutSchema,
    memoryMiB: z.literal(768),
    compilerHeapMiB: z.literal(384),
    generatedTreeDigest: digest,
    sourceProjectionDigest: digest,
    workBytesAfterBuild: z.number().int().nonnegative().max(134217728),
    offline: z.literal(true),
    lifecycleScripts: z.literal('disabled'),
    wholeWorkspaceDependenciesInstalled: z.literal(false),
  })
  .strict();
