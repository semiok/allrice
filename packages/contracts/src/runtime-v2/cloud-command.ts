import { z } from 'zod';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { isRuntimeRelativePath } from './policy.ts';

/** P15 fixed server-side runtime. Never inherited from a Bridge profile. */
export const cloudToolchainImageV1 =
  'sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
/** Additional approved runtime, not a replacement for frozen Node commands. */
export const cloudPythonImageV1 =
  'sha256:d6a52afde3d7c99d8cba9c89ff5078a8e1b6a177f97512ff4facfa4f930fe38e';
export const cloudBackendV1 = 'cloud-gvisor-v1' as const;
export const CloudCommandLanguageSchema = z.enum(['javascript', 'python']);
export type CloudCommandLanguage = z.infer<typeof CloudCommandLanguageSchema>;

/** An existing approved execution profile admits both platform runtimes. The
 * exact selected image is frozen in the operation; models cannot supply it. */
export function cloudRuntimeImage(
  profileImage: typeof cloudToolchainImageV1,
  language?: CloudCommandLanguage,
) {
  return language === 'python' ? cloudPythonImageV1 : profileImage;
}
const path = z.string().max(240).refine(isRuntimeRelativePath);
export const CloudCommandLimitsSchema = z
  .object({
    timeoutMs: z.number().int().min(500).max(60_000).default(30_000),
    outputBytes: z.number().int().min(1024).max(65_536).default(32_768),
    artifactBytes: z.number().int().min(1024).max(4_000_000).default(1_000_000),
    memoryMiB: z.number().int().min(128).max(512).default(256),
    cpuMillis: z.number().int().min(100).max(1000).default(500),
    // Includes gVisor/Node runtime threads as well as tenant children.
    pids: z.literal(64).default(64),
  })
  .strict();
export const CloudCommandInputSchema = z
  .object({
    // Do not materialize a default: legacy command bytes/digests stay identical.
    language: CloudCommandLanguageSchema.optional(),
    script: z
      .string()
      .min(1)
      .max(100_000)
      .refine((s) => !s.includes('\0')),
    inputs: z
      .array(
        z
          .object({ path, objectId: UuidSchema, checksum: ChecksumSchema })
          .strict(),
      )
      .max(16)
      .default([]),
    outputs: z
      .array(
        z
          .object({
            path,
            fileName: z
              .string()
              .min(1)
              .max(120)
              .refine(
                (name) =>
                  [...name].every(
                    (char) =>
                      char.charCodeAt(0) >= 32 && char !== '/' && char !== '\\',
                  ),
                'Invalid file name',
              ),
            format: z.enum(['json', 'csv', 'txt', 'png']),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    limits: CloudCommandLimitsSchema.default({
      timeoutMs: 30_000,
      outputBytes: 32_768,
      artifactBytes: 1_000_000,
      memoryMiB: 256,
      cpuMillis: 500,
      pids: 64,
    }),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const [index, output] of v.outputs.entries()) {
      if (
        output.format === 'png' &&
        (v.language !== 'python' ||
          !output.path.toLowerCase().endsWith('.png') ||
          !output.fileName.toLowerCase().endsWith('.png'))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', index],
          message: 'PNG requires the Python runtime and .png output names',
        });
    }
    for (const files of [v.inputs, v.outputs]) {
      const paths = files.map((f) => f.path);
      if (
        new Set(paths).size !== paths.length ||
        paths.some((p) => paths.some((q) => p.startsWith(`${q}/`)))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate or overlapping cloud paths',
        });
    }
    if (new Set(v.inputs.map((f) => f.objectId)).size !== v.inputs.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate cloud input object' });
  });
export type CloudCommandInput = z.infer<typeof CloudCommandInputSchema>;
export const CloudCommandSchema = z
  .object({
    capability: z.literal('cloud.process.execute'),
    arguments: CloudCommandInputSchema,
    backend: z.literal(cloudBackendV1),
    imageDigest: z.union([
      z.literal(cloudToolchainImageV1),
      z.literal(cloudPythonImageV1),
    ]),
    runtime: z.literal('runsc'),
    network: z.literal('none'),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (
      command.imageDigest !==
      cloudRuntimeImage(cloudToolchainImageV1, command.arguments.language)
    )
      ctx.addIssue({ code: 'custom', message: 'cloud runtime/image mismatch' });
  });
export type CloudCommand = z.infer<typeof CloudCommandSchema>;
export const CloudExecutionProfileSchema = z
  .object({
    backend: z.literal(cloudBackendV1),
    imageDigest: z.literal(cloudToolchainImageV1),
    architecture: z.literal('amd64'),
    runtime: z.literal('runsc'),
    runtimeVersion: z.literal('release-20260831.0'),
    runtimeChecksum: z.literal(
      'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
    ),
    network: z.literal('none'),
    maximumConcurrency: z.number().int().min(1).max(32),
  })
  .strict();
export type CloudExecutionProfile = z.infer<typeof CloudExecutionProfileSchema>;
