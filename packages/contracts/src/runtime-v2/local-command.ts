import { z } from 'zod';
import {
  CommandCandidateSchema,
  CommandCandidateRefSchema,
  CommandCandidateEvidenceSchema,
} from './command-candidate.ts';

import { BridgeCommandPayloadSchema } from '../bridge.ts';
import { ChecksumSchema } from '../runs.ts';
import { isRuntimeRelativePath } from './policy.ts';
import { RuntimeChangesetSchema } from './changeset-execution.ts';
import { RuntimeLocalMcpPayloadSchema } from './local-mcp.ts';
import { RuntimeLocalServiceConfigSchema } from './local-service.ts';
import {
  RuntimeDependencyPreparationSchema,
  RuntimeDependencyPreparationResultSchema,
} from './dependency-preparation.ts';
import {
  RuntimeProjectDiagnosticsRequestSchema,
  RuntimeProjectDiagnosticsSchema,
} from './project-diagnostics.ts';

const path = z.string().max(1024).refine(isRuntimeRelativePath);

// Immutable multi-platform OCI index (not a per-architecture config digest).
// Docker's containerd image store reports this index as image.Id on both hosts.
// Always bind it to the verified native platform; a digest alone is insufficient.
export const localCommandToolchainImageV1 =
  'sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';

export function localCommandToolchainForPlatform(platform: string) {
  if (platform !== 'macos-x64' && platform !== 'macos-arm64') return null;
  return {
    imageDigest: localCommandToolchainImageV1,
    architecture:
      platform === 'macos-arm64' ? ('arm64' as const) : ('amd64' as const),
  };
}

export function isLocalCommandProfileForPlatform(
  platform: string,
  profile: { imageDigest: string; architecture: string },
) {
  const toolchain = localCommandToolchainForPlatform(platform);
  return (
    toolchain !== null &&
    profile.architecture === toolchain.architecture &&
    profile.imageDigest === toolchain.imageDigest
  );
}

/** Opt-in v2 ledger payload; never part of the legacy advertised capabilities. */
export const RuntimeLocalCommandSchema = z
  .object({
    capability: z.literal('local.process.execute'),
    arguments: z
      .object({
        executable: z.enum(['/usr/local/bin/node', '/usr/local/bin/npm']),
        args: z
          .array(
            z
              .string()
              .max(4096)
              .refine((s) => !s.includes('\0')),
          )
          .max(32),
        path: z.union([z.literal('.'), path]),
        diagnostics: RuntimeProjectDiagnosticsRequestSchema.optional(),
        dependencies: RuntimeDependencyPreparationSchema.optional(),
        background: RuntimeLocalServiceConfigSchema.optional(),
        candidate: CommandCandidateSchema.optional(),
        files: z
          .array(z.object({ path, sha256: ChecksumSchema }).strict())
          .min(1)
          .max(64),
        imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        isolation: z.literal('local-vm-container-v1'),
        network: z.literal('none'),
        limits: z
          .object({
            timeoutMs: z.number().int().min(500).max(60_000),
            outputBytes: z.number().int().min(1024).max(65_536),
            memoryMiB: z.number().int().min(128).max(512),
            cpuMillis: z.number().int().min(100).max(1000),
            pids: z.number().int().min(16).max(64),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.arguments.candidate &&
      (value.arguments.background ||
        value.arguments.dependencies ||
        value.arguments.diagnostics)
    )
      context.addIssue({
        code: 'custom',
        message:
          'candidate execution is a foreground verification command only',
      });
    if (
      value.arguments.background &&
      (value.arguments.dependencies || value.arguments.diagnostics)
    )
      context.addIssue({
        code: 'custom',
        message:
          'background service does not combine preparation/diagnostics in v1',
      });
    if (value.arguments.dependencies && value.arguments.diagnostics)
      context.addIssue({
        code: 'custom',
        message: 'diagnostics never installs dependencies',
      });
    if (
      value.arguments.diagnostics &&
      (value.arguments.executable !== '/usr/local/bin/node' ||
        value.arguments.args.length)
    )
      context.addIssue({
        code: 'custom',
        message:
          'diagnostics requires node and empty args; project scripts are never run',
      });
    const paths = value.arguments.files.map((file) => file.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some((p) => paths.some((q) => p.startsWith(`${q}/`)))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate or overlapping input paths',
      });
    }
  });

export type RuntimeLocalCommand = z.infer<typeof RuntimeLocalCommandSchema>;
export const RuntimeLocalCommandToolInputSchema =
  RuntimeLocalCommandSchema.shape.arguments
    .omit({
      imageDigest: true,
      isolation: true,
      network: true,
      candidate: true,
    })
    .extend({ candidate: CommandCandidateRefSchema.optional() });
export const RuntimeBridgePayloadSchema = z.union([
  BridgeCommandPayloadSchema,
  RuntimeLocalCommandSchema,
  RuntimeChangesetSchema,
  RuntimeLocalMcpPayloadSchema,
]);
export type RuntimeBridgePayload = z.infer<typeof RuntimeBridgePayloadSchema>;

export const RuntimeLocalCommandProfileSchema = z
  .object({
    contractVersion: z.literal(1),
    backend: z.literal('local-vm-container-v1'),
    imageDigest: ChecksumSchema,
    architecture: z.enum(['amd64', 'arm64']),
    available: z.boolean(),
    features: z
      .array(
        z.enum([
          'project_diagnostics',
          'npm_dependencies',
          'background_services',
          'local_mcp',
          'changeset_candidate',
        ]),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type RuntimeLocalCommandProfile = z.infer<
  typeof RuntimeLocalCommandProfileSchema
>;

export const RuntimeLocalCommandResultSchema = z
  .object({
    backend: z.literal('local-vm-container-v1'),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageDigest: ChecksumSchema,
    stopped: z.literal(true),
    exitCode: z.number().int().min(0).max(255),
    reason: z.enum([
      'exited',
      'canceled',
      'timeout',
      'output_limit',
      'memory_limit',
      'lease_lost',
      'supervisor_failed',
      'readiness_timeout',
      'port_conflict',
      'input_expired',
      'input_protocol_error',
    ]),
    stdout: z.string().max(100_000),
    stderr: z.string().max(100_000),
    truncated: z.boolean(),
    workCopy: z.literal('local_isolated_copy'),
    sourceDirectoryModified: z.literal(false),
    diagnostics: RuntimeProjectDiagnosticsSchema.optional(),
    dependencies: RuntimeDependencyPreparationResultSchema.optional(),
    candidate: CommandCandidateEvidenceSchema.optional(),
  })
  .strict();
export type RuntimeLocalCommandResult = z.infer<
  typeof RuntimeLocalCommandResultSchema
>;
