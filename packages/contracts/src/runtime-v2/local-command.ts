import { z } from 'zod';
import {
  ProjectOutputSpecsSchema,
  ProjectCollectedArtifactsSchema,
  projectArtifactsMatchOutputs,
} from '../project-outputs.ts';
import {
  ProjectVersionRefSchema,
  RuntimeSavedProjectSourceSchema,
} from '../project-workspace.ts';
import { runtimeContractEqual } from './identity.ts';
import {
  CommandCandidateSchema,
  CommandCandidateRefSchema,
  CommandCandidateEvidenceSchema,
} from './command-candidate.ts';

import { BridgeCommandPayloadSchema } from '../bridge.ts';
import { managedPythonPayloadForPlatform } from '../managed-python-payload.ts';
import { ChecksumSchema } from '../runs.ts';
import { isRuntimeRelativePath } from './policy.ts';
import { RuntimeChangesetSchema } from './changeset-execution.ts';
import { RuntimeLocalMcpPayloadSchema } from './local-mcp.ts';
import { RuntimeLocalServiceConfigSchema } from './local-service.ts';
import { RuntimeLocalPythonPayloadSchema } from './local-python.ts';
import { RuntimeLocalPdfPayloadSchema } from './local-pdf.ts';
import {
  RuntimeDependencyPreparationSchema,
  RuntimeDependencyPreparationResultSchema,
} from './dependency-preparation.ts';
import {
  RuntimeProjectPreparationSchema,
  RuntimeProjectPreparationEvidenceSchema,
  projectPreparationResultMatches,
} from './project-preparation.ts';
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
  profile: {
    imageDigest: string;
    architecture: string;
    projectPreparation?: { nodeImage: string; pythonImage: string };
  },
) {
  const toolchain = localCommandToolchainForPlatform(platform);
  return (
    toolchain !== null &&
    profile.architecture === toolchain.architecture &&
    profile.imageDigest === toolchain.imageDigest &&
    (!profile.projectPreparation ||
      (profile.projectPreparation.nodeImage === toolchain.imageDigest &&
        profile.projectPreparation.pythonImage ===
          managedPythonPayloadForPlatform(platform)?.imageId))
  );
}

/** Opt-in v2 ledger payload; never part of the legacy advertised capabilities. */
export const RuntimeLocalCommandSchema = z
  .object({
    capability: z.literal('local.process.execute'),
    arguments: z
      .object({
        executable: z.enum([
          '/usr/local/bin/node',
          '/usr/local/bin/npm',
          '/workspace/.venv/bin/python',
        ]),
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
        projectPreparation: RuntimeProjectPreparationSchema.optional(),
        projectSource: RuntimeSavedProjectSourceSchema.optional(),
        outputs: ProjectOutputSpecsSchema.optional(),
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
    const a = value.arguments;
    if (a.outputs && !a.projectSource)
      context.addIssue({
        code: 'custom',
        message: 'project_outputs_require_saved_source',
      });
    if (
      a.projectSource &&
      (!a.projectPreparation ||
        a.background ||
        a.dependencies ||
        a.diagnostics ||
        a.candidate ||
        a.projectPreparation.projectId !== a.projectSource.project.projectId ||
        a.projectPreparation.sourceDigest !==
          a.projectSource.snapshot.sourceDigest ||
        !runtimeContractEqual(
          a.files,
          a.projectSource.snapshot.files.map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
        ))
    )
      context.addIssue({
        code: 'custom',
        message: 'saved_project_source_changed',
      });
    if (
      a.projectPreparation &&
      (a.background || a.dependencies || a.diagnostics || a.candidate)
    )
      context.addIssue({
        code: 'custom',
        message:
          'project preparation is a foreground operation with its own exact source/lock identity',
      });
    if (
      (a.executable === '/workspace/.venv/bin/python') !==
      (a.projectPreparation?.manager === 'uv')
    )
      context.addIssue({
        code: 'custom',
        message:
          'project Python requires an isolated uv environment; Node commands require the Node runtime',
      });
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
      projectSource: true,
      // Collected output publication belongs to workspace.project, whose
      // Worker resolves and checks a canonical execution selection.
      outputs: true,
    })
    .extend({
      candidate: CommandCandidateRefSchema.optional(),
      project: ProjectVersionRefSchema.optional(),
      files: RuntimeLocalCommandSchema.shape.arguments.shape.files.optional(),
      // The trusted Node supervisor and the project Node/npm process both
      // need native threads. On the pinned ARM image a 16-task cgroup can
      // hang child startup before any output. Reject undersized NEW requests
      // before approval; retain the wire schema for historic 16-task receipts.
      limits: RuntimeLocalCommandSchema.shape.arguments.shape.limits.extend({
        pids: z.number().int().min(32).max(64),
      }),
    })
    .superRefine((c, ctx) => {
      if (!!c.files === !!c.project)
        ctx.addIssue({
          code: 'custom',
          message: 'Supply exact project OR host files',
        });
      if (
        c.project &&
        (!c.projectPreparation ||
          c.background ||
          c.candidate ||
          c.dependencies ||
          c.diagnostics)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Saved source requires finite project preparation',
        });
    });
export const RuntimeBridgePayloadSchema = z.union([
  BridgeCommandPayloadSchema,
  RuntimeLocalCommandSchema,
  RuntimeChangesetSchema,
  RuntimeLocalMcpPayloadSchema,
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPdfPayloadSchema,
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
          'project_preparation',
          'saved_project_source',
        ]),
      )
      .max(8)
      .optional(),
    projectPreparation: z
      .object({
        version: z.literal(1),
        available: z.literal(true),
        nodeImage: ChecksumSchema,
        pythonImage: ChecksumSchema,
        pnpmVersion: z.literal('10.33.3'),
        uvVersion: z.literal('0.8.22'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeLocalCommandProfile = z.infer<
  typeof RuntimeLocalCommandProfileSchema
>;

export function localCommandRuntimeImage(
  profile: RuntimeLocalCommandProfile,
  command: { projectPreparation?: { manager: 'pnpm' | 'uv' } },
) {
  return command.projectPreparation?.manager === 'uv'
    ? profile.projectPreparation?.pythonImage
    : profile.imageDigest;
}

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
      'cache_limit',
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
    projectPreparation: RuntimeProjectPreparationEvidenceSchema.optional(),
    artifacts: ProjectCollectedArtifactsSchema.optional(),
    candidate: CommandCandidateEvidenceSchema.optional(),
  })
  .strict();
export type RuntimeLocalCommandResult = z.infer<
  typeof RuntimeLocalCommandResultSchema
>;

export function localProjectResultMatchesPayload(
  payload: RuntimeLocalCommand,
  result: RuntimeLocalCommandResult,
) {
  const spec = payload.arguments.projectPreparation,
    proof = result.projectPreparation;
  if (
    !projectArtifactsMatchOutputs(
      payload.arguments.outputs,
      result.artifacts,
      result.reason === 'exited' && result.exitCode === 0,
    )
  )
    return false;
  return !spec
    ? proof === undefined
    : result.imageDigest === payload.arguments.imageDigest &&
        projectPreparationResultMatches({
          spec,
          source: payload.arguments.projectSource,
          imageDigest: payload.arguments.imageDigest,
          proof,
          succeeded: result.reason === 'exited' && result.exitCode === 0,
          commandFinished: result.reason === 'exited',
        });
}
