import { z } from 'zod';

import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { isRuntimeRelativePath } from './policy.ts';

export const managedPythonProfileVersionV1 = 1 as const;
export const ManagedPythonPurposeSchema = z.enum(['office', 'python_charts']);
export type ManagedPythonPurpose = z.infer<typeof ManagedPythonPurposeSchema>;
const path = z.string().min(1).max(240).refine(isRuntimeRelativePath);
const name = z
  .string()
  .min(1)
  .max(240)
  .refine((s) => isRuntimeRelativePath(s) && !s.includes('/'));
const architecture = z.enum(['amd64', 'arm64']);
const format = z.enum([
  'docx',
  'xlsx',
  'pptx',
  'png',
  'txt',
  'md',
  'json',
  'csv',
]);

/** Static release allowlist. A manifest entry is not a successful native probe. */
export const ManagedPythonPayloadReleaseSchema = z
  .object({
    contractVersion: z.literal(1),
    profileVersion: z.literal(managedPythonProfileVersionV1),
    platform: z.enum(['macos-x64', 'macos-arm64']),
    architecture,
    nativeSupported: z.boolean(),
    imageId: ChecksumSchema,
    pythonVersion: z.literal('3.11.13'),
    archive: z
      .object({
        fileName: name,
        sha256: ChecksumSchema,
        sizeBytes: z.number().int().positive().max(2_000_000_000),
      })
      .strict(),
    packagesChecksum: ChecksumSchema,
    officeChecker: z
      .object({
        upstream: z.literal('@deepseek-ai/dsh-skill-office@0.1.7-alpha.2'),
        sha256: ChecksumSchema,
      })
      .strict(),
    pngChecker: z.object({ sha256: ChecksumSchema }).strict(),
    font: z
      .object({
        fileName: z.literal('NotoSansCJK-Regular.ttc'),
        sha256: ChecksumSchema,
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) => v.architecture === (v.platform === 'macos-x64' ? 'amd64' : 'arm64'),
    'native architecture must match its payload',
  );
export type ManagedPythonPayloadRelease = z.infer<
  typeof ManagedPythonPayloadReleaseSchema
>;

/** Report independent observed facts; formulas and rendering are not implied by generation. */
export const RuntimeLocalPythonProfileSchema = z
  .object({
    contractVersion: z.literal(1),
    profileVersion: z.literal(managedPythonProfileVersionV1),
    backend: z.literal('local-vm-container-v1'),
    imageId: ChecksumSchema,
    architecture,
    pythonVersion: z.literal('3.11.13'),
    packagesChecksum: ChecksumSchema,
    officeCheckerChecksum: ChecksumSchema,
    pngCheckerChecksum: ChecksumSchema,
    fontChecksum: ChecksumSchema,
    available: z.boolean(),
    purposes: z
      .array(ManagedPythonPurposeSchema)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    officeGeneration: z.boolean(),
    officeFormulaCalculation: z.literal(false),
    officePreview: z.literal(false),
    stopConfirmed: z.boolean(),
  })
  .strict()
  .refine(
    (v) =>
      !v.available ||
      (v.stopConfirmed &&
        (!v.purposes.includes('office') || v.officeGeneration)),
    'ready requires observed execution and physical stop',
  );
export type RuntimeLocalPythonProfile = z.infer<
  typeof RuntimeLocalPythonProfileSchema
>;

export const RuntimeLocalPythonInputSchema = z
  .object({
    path,
    objectId: UuidSchema,
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().nonnegative().max(20_000_000),
    mediaType: z.string().min(1).max(255),
  })
  .strict();
export const RuntimeLocalPythonOutputSchema = z
  .object({
    path,
    fileName: name,
    format,
    mediaType: z.string().min(1).max(255),
    objectId: UuidSchema,
  })
  .strict();

/** Server-created Run delegation, never a model tool or an arbitrary executable/image. */
export const RuntimeLocalPythonPayloadSchema = z
  .object({
    capability: z.literal('local.python.execute'),
    arguments: z
      .object({
        path: z.literal('.'),
        purpose: ManagedPythonPurposeSchema,
        origin: z
          .object({
            toolName: z.enum(['workspace.export.create', 'python.execute']),
            callId: z.string().min(1).max(255),
            argumentsDigest: ChecksumSchema,
          })
          .strict(),
        script: z
          .string()
          .min(1)
          .max(100_000)
          .refine((v) => !v.includes('\0')),
        inputs: z.array(RuntimeLocalPythonInputSchema).max(16),
        outputs: z.array(RuntimeLocalPythonOutputSchema).min(1).max(8),
        profileVersion: z.literal(managedPythonProfileVersionV1),
        imageId: ChecksumSchema,
        architecture,
        isolation: z.literal('local-vm-container-v1'),
        network: z.literal('none'),
        limits: z
          .object({
            timeoutMs: z.number().int().min(500).max(60_000),
            inputBytes: z.number().int().positive().max(20_000_000),
            artifactBytes: z.number().int().positive().max(8_000_000),
            outputBytes: z.number().int().min(1024).max(65_536),
            memoryMiB: z.number().int().min(128).max(512),
            cpuMillis: z.number().int().min(100).max(1000),
            pids: z.number().int().min(32).max(64),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const a = v.arguments;
    if (
      a.origin.toolName !==
      (a.purpose === 'office' ? 'workspace.export.create' : 'python.execute')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'purpose must delegate its exact original tool',
      });
    if (
      a.purpose === 'office' &&
      (a.outputs.length !== 1 ||
        !['docx', 'xlsx', 'pptx'].includes(a.outputs[0]!.format))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Office delegates one native Office output',
      });
    if (
      a.purpose === 'python_charts' &&
      (a.limits.inputBytes > 2_000_000 ||
        a.limits.artifactBytes > 4_000_000 ||
        a.outputs.some((o) => ['docx', 'xlsx', 'pptx'].includes(o.format)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'chart limits and validators remain separate from Office',
      });
    if (a.inputs.reduce((sum, i) => sum + i.sizeBytes, 0) > a.limits.inputBytes)
      ctx.addIssue({
        code: 'custom',
        message: 'declared inputs exceed the purpose budget',
      });
    for (const items of [a.inputs, a.outputs]) {
      const paths = items.map((i) => i.path);
      if (
        new Set(paths).size !== paths.length ||
        paths.some((p) => paths.some((q) => p.startsWith(`${q}/`)))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'input/output paths must be distinct files',
        });
    }
    if (new Set(a.outputs.map((o) => o.objectId)).size !== a.outputs.length)
      ctx.addIssue({
        code: 'custom',
        message: 'outputs require distinct reserved objects',
      });
  });
export type RuntimeLocalPythonPayload = z.infer<
  typeof RuntimeLocalPythonPayloadSchema
>;

/** Header metadata only; the receiving StoragePort independently hashes bytes. */
export const RuntimeLocalPythonArtifactMetadataSchema = z
  .object({
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().positive().max(8_000_000),
    mediaType: z.string().min(1).max(255),
    validation: z.enum(['dsh_office', 'trusted_png', 'utf8']),
  })
  .strict();
export type RuntimeLocalPythonArtifactMetadata = z.infer<
  typeof RuntimeLocalPythonArtifactMetadataSchema
>;
export const RuntimeLocalPythonCollectedArtifactSchema =
  RuntimeLocalPythonOutputSchema.merge(RuntimeLocalPythonArtifactMetadataSchema)
    .extend({ collected: z.literal(true) })
    .strict();
export const RuntimeLocalPythonCheckpointSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    reason: z.enum([
      'exited',
      'canceled',
      'timeout',
      'output_limit',
      'artifact_limit',
      'memory_limit',
      'lease_lost',
      'supervisor_failed',
      'validation_failed',
      'input_changed',
    ]),
    stdout: z.string().max(100_000),
    stderr: z.string().max(100_000),
    truncated: z.boolean(),
    artifacts: z
      .array(
        RuntimeLocalPythonOutputSchema.merge(
          RuntimeLocalPythonArtifactMetadataSchema,
        ),
      )
      .max(8),
  })
  .strict();
export type RuntimeLocalPythonCheckpoint = z.infer<
  typeof RuntimeLocalPythonCheckpointSchema
>;

export const RuntimeLocalPythonResultSchema = z
  .object({
    backend: z.literal('local-vm-container-v1'),
    profileVersion: z.literal(managedPythonProfileVersionV1),
    purpose: ManagedPythonPurposeSchema,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageId: ChecksumSchema,
    architecture,
    stopped: z.literal(true),
    exitCode: z.number().int().min(0).max(255),
    reason: z.enum([
      'exited',
      'canceled',
      'timeout',
      'output_limit',
      'artifact_limit',
      'memory_limit',
      'lease_lost',
      'supervisor_failed',
      'validation_failed',
      'input_changed',
    ]),
    stdout: z.string().max(100_000),
    stderr: z.string().max(100_000),
    truncated: z.boolean(),
    artifacts: z
      .array(
        RuntimeLocalPythonOutputSchema.extend({
          sizeBytes: z.number().int().positive().max(8_000_000),
          checksum: ChecksumSchema,
          validation: z.enum(['dsh_office', 'trusted_png', 'utf8']),
          collected: z.literal(true),
        }).strict(),
      )
      .max(8),
    workCopy: z.literal('local_isolated_copy'),
    sourceDirectoryModified: z.literal(false),
  })
  .strict();
export type RuntimeLocalPythonResult = z.infer<
  typeof RuntimeLocalPythonResultSchema
>;

export function localPythonProfileMatchesRelease(
  profile: RuntimeLocalPythonProfile,
  release: ManagedPythonPayloadRelease,
) {
  return (
    release.nativeSupported &&
    profile.profileVersion === release.profileVersion &&
    profile.imageId === release.imageId &&
    profile.architecture === release.architecture &&
    profile.pythonVersion === release.pythonVersion &&
    profile.packagesChecksum === release.packagesChecksum &&
    profile.officeCheckerChecksum === release.officeChecker.sha256 &&
    profile.pngCheckerChecksum === release.pngChecker.sha256 &&
    profile.fontChecksum === release.font.sha256
  );
}

export function localPythonResultMatchesPayload(
  payload: RuntimeLocalPythonPayload,
  result: RuntimeLocalPythonResult,
) {
  const a = payload.arguments;
  if (
    result.purpose !== a.purpose ||
    result.profileVersion !== a.profileVersion ||
    result.imageId !== a.imageId ||
    result.architecture !== a.architecture ||
    result.artifacts.reduce((s, o) => s + o.sizeBytes, 0) >
      a.limits.artifactBytes ||
    new Set(result.artifacts.map((o) => o.objectId)).size !==
      result.artifacts.length
  )
    return false;
  return (
    result.artifacts.every(
      (file) =>
        file.validation ===
          (a.purpose === 'office'
            ? 'dsh_office'
            : file.format === 'png'
              ? 'trusted_png'
              : 'utf8') &&
        a.outputs.some((o) =>
          Object.entries(o).every(
            ([k, v]) => file[k as keyof typeof file] === v,
          ),
        ),
    ) &&
    (result.exitCode !== 0 ||
      result.reason !== 'exited' ||
      result.artifacts.length === a.outputs.length)
  );
}
