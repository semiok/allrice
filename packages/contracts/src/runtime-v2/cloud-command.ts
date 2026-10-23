import { z } from 'zod';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { isRuntimeRelativePath } from './policy.ts';
import { cloudPlatform } from './cloud-platform.ts';
import {
  SandboxNetworkRequestSchema,
  SandboxNetworkGrantSchema,
} from './sandbox-network.ts';
import {
  SandboxExecutionRequestSchema,
  SandboxExecutionBudgetSpecSchema,
} from './sandbox-execution.ts';
import { ProjectDependencyResolveInputSchema } from '../project-dependency-resolution.ts';
import { projectResolutionCloudArguments } from '../project-resolution-script.ts';

/** P15 fixed server-side runtime. Never inherited from a Bridge profile. */
export const cloudToolchainImageV1: string = cloudPlatform.images.node;
/** Additional approved runtime, not a replacement for frozen Node commands. */
export const cloudPythonImageV1: string = cloudPlatform.images.python;
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
    network: SandboxNetworkRequestSchema.optional(),
    execution: SandboxExecutionRequestSchema.optional(),
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
            // Server-side lineage only; omission preserves historical call digests.
            parentObjectId: UuidSchema.optional(),
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
    const parents = v.outputs.flatMap((output) =>
      output.parentObjectId ? [output.parentObjectId.toLowerCase()] : [],
    );
    if (new Set(parents).size !== parents.length)
      ctx.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: 'duplicate cloud output parent',
      });
  });
export type CloudCommandInput = z.infer<typeof CloudCommandInputSchema>;
/** Server-created proof of the canonical call, not a model-selectable tool. */
export const CloudPythonOriginSchema = z
  .object({
    toolName: z.literal('python.execute'),
    callId: z.string().min(1).max(255),
    purpose: z.literal('python_charts'),
    argumentsDigest: ChecksumSchema,
  })
  .strict();
export type CloudPythonOrigin = z.infer<typeof CloudPythonOriginSchema>;
export const CloudProjectResolutionOriginSchema = z
  .object({
    toolName: z.literal('workspace.project'),
    callId: z.string().min(1).max(255),
    purpose: z.literal('project_dependency_resolution'),
    argumentsDigest: ChecksumSchema,
    request: ProjectDependencyResolveInputSchema,
  })
  .strict();
export type CloudProjectResolutionOrigin = z.infer<
  typeof CloudProjectResolutionOriginSchema
>;
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
    network: z.union([z.literal('none'), SandboxNetworkRequestSchema]),
    origin: z
      .union([CloudPythonOriginSchema, CloudProjectResolutionOriginSchema])
      .optional(),
    executionBudget: SandboxExecutionBudgetSpecSchema.optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (
      Boolean(command.arguments.execution) !==
        Boolean(command.executionBudget) ||
      (command.arguments.execution &&
        command.executionBudget &&
        command.arguments.execution.kind !== command.executionBudget.kind)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'cloud execution budget/request mismatch',
      });
    if (
      JSON.stringify(command.network) !==
      JSON.stringify(command.arguments.network ?? 'none')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'cloud network/request mismatch',
      });
    if (
      command.origin?.toolName === 'python.execute' &&
      command.arguments.language !== 'python'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'canonical Python delegation requires the Python runtime',
      });
    if (
      command.origin?.toolName === 'workspace.project' &&
      (!command.executionBudget ||
        JSON.stringify(command.arguments) !==
          JSON.stringify(
            CloudCommandInputSchema.parse(
              projectResolutionCloudArguments(command.origin.request),
            ),
          ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'project resolution controller changed',
      });
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
    architecture: z.literal(cloudPlatform.architecture),
    runtime: z.literal('runsc'),
    runtimeVersion: z.literal('release-20260831.0'),
    runtimeChecksum: z.literal(cloudPlatform.runtimeChecksum),
    network: z.literal('none'),
    sandboxNetwork: SandboxNetworkGrantSchema.optional(),
    maximumConcurrency: z.number().int().min(1).max(32),
  })
  .strict();
export type CloudExecutionProfile = z.infer<typeof CloudExecutionProfileSchema>;
