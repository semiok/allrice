import { z } from 'zod';
import {
  ProjectVersionRefSchema,
  ProjectWorkspaceCommandSchema,
  RuntimeSavedProjectSourceSchema,
} from './project-workspace.ts';
import {
  RuntimeProjectPreparationSchema,
  RuntimeProjectPreparationEvidenceSchema,
  projectPreparationResultMatches,
  projectExecutionLimitsAllowed,
} from './runtime-v2/project-preparation.ts';
import { RuntimeLocalServiceConfigSchema } from './runtime-v2/local-service.ts';
import { ExecutionLocationSchema } from './execution-choice.ts';
import { ChecksumSchema } from './runs.ts';
import {
  ProjectOutputSpecsSchema,
  ProjectCollectedArtifactsSchema,
  projectArtifactsMatchOutputs,
} from './project-outputs.ts';
import { isRuntimeRelativePath } from './runtime-v2/policy.ts';
import {
  CloudCommandSchema,
  cloudBackendV1,
  cloudToolchainImageV1,
  cloudPythonImageV1,
} from './runtime-v2/cloud-command.ts';

import {
  ProjectServiceConfigSchema,
  ProjectServiceControlInputSchema,
  projectServiceReadinessLimit,
} from './project-service.ts';

const path = z.string().min(1).max(240).refine(isRuntimeRelativePath);
/** Saved source executes one finite command; no model-owned device, lease, image or network. */
const ProjectExecuteObjectSchema = z
  .object({
    action: z.literal('execute'),
    project: ProjectVersionRefSchema,
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
    projectPreparation: RuntimeProjectPreparationSchema,
    outputs: ProjectOutputSpecsSchema.optional(),
    limits: z
      .object({
        timeoutMs: z.number().int().min(500).max(600_000),
        outputBytes: z.number().int().min(1024).max(65_536),
        memoryMiB: z.number().int().min(128).max(1536),
        cpuMillis: z.number().int().min(100).max(1000),
        pids: z.number().int().min(64).max(128),
      })
      .strict(),
    location: ExecutionLocationSchema.optional(),
  })
  .strict();
export const ProjectExecuteInputSchema = ProjectExecuteObjectSchema.superRefine(
  (a, ctx) => {
    if (!projectExecutionLimitsAllowed(a.projectPreparation, a.limits))
      ctx.addIssue({
        code: 'custom',
        message: 'project_resource_profile_limit',
      });
    if (
      a.project.projectId !== a.projectPreparation.projectId ||
      (a.executable === '/workspace/.venv/bin/python') !==
        (a.projectPreparation.manager === 'uv')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'project_execution_identity_changed',
      });
  },
);
export type ProjectExecuteInput = z.infer<typeof ProjectExecuteInputSchema>;
export const ProjectServiceStartInputSchema = ProjectExecuteObjectSchema.omit({
  action: true,
  outputs: true,
})
  .extend({
    action: z.literal('service_start'),
    service: ProjectServiceConfigSchema,
  })
  .superRefine((a, c) => {
    if (!projectExecutionLimitsAllowed(a.projectPreparation, a.limits))
      c.addIssue({ code: 'custom', message: 'project_resource_profile_limit' });
    if (
      a.service.readinessTimeoutMs >
      projectServiceReadinessLimit(a.projectPreparation)
    )
      c.addIssue({
        code: 'custom',
        message: 'project_readiness_profile_limit',
      });
    if (
      a.project.projectId !== a.projectPreparation.projectId ||
      a.projectPreparation.manager !== 'pnpm' ||
      a.executable === '/workspace/.venv/bin/python'
    )
      c.addIssue({
        code: 'custom',
        message: 'project_service_requires_saved_node_project',
      });
  });
export const ProjectRunnableInputSchema = z.union([
  ProjectExecuteInputSchema,
  ProjectServiceStartInputSchema,
]);
export type ProjectRunnableInput = z.infer<typeof ProjectRunnableInputSchema>;
export type ProjectServiceStartInput = z.infer<
  typeof ProjectServiceStartInputSchema
>;
/** Keep the source-only database command separate; avoids source/installer schema cycles. */
export const ProjectWorkspaceToolInputSchema = z.union([
  ProjectWorkspaceCommandSchema,
  ProjectExecuteInputSchema,
  ProjectServiceStartInputSchema,
  ProjectServiceControlInputSchema,
]);

/** Internal cloud payload only. Its canonical call and Worker provenance come from admission. */
export const CloudProjectCommandSchema = z
  .object({
    kind: z.literal('project'),
    capability: z.literal('cloud.process.execute'),
    arguments: ProjectExecuteObjectSchema.omit({
      action: true,
      project: true,
      location: true,
    }).extend({
      background: RuntimeLocalServiceConfigSchema.optional(),
      projectSource: RuntimeSavedProjectSourceSchema,
      files: z
        .array(z.object({ path, sha256: ChecksumSchema }).strict())
        .min(1)
        .max(64),
      imageDigest: ChecksumSchema,
    }),
    backend: z.literal(cloudBackendV1),
    imageDigest: z.union([
      z.literal(cloudToolchainImageV1),
      z.literal(cloudPythonImageV1),
    ]),
    runtime: z.literal('runsc'),
    network: z.literal('none'),
  })
  .strict()
  .superRefine((c, ctx) => {
    const a = c.arguments,
      s = a.projectSource;
    if (!projectExecutionLimitsAllowed(a.projectPreparation, a.limits))
      ctx.addIssue({
        code: 'custom',
        message: 'project_resource_profile_limit',
      });
    const background = a.background;
    if (
      background?.projectService &&
      background.projectService.readinessTimeoutMs >
        projectServiceReadinessLimit(a.projectPreparation)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'project_readiness_profile_limit',
      });
    if (
      background &&
      (!background.projectService ||
        a.projectPreparation.manager !== 'pnpm' ||
        a.outputs ||
        background.durationMs !== 3_600_000 ||
        background.readiness.timeoutMs !==
          background.projectService.readinessTimeoutMs ||
        background.readiness.path !== background.projectService.path)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'cloud_project_service_configuration_changed',
      });
    const image =
      a.projectPreparation.manager === 'uv'
        ? cloudPythonImageV1
        : cloudToolchainImageV1;
    if (
      (a.executable === '/workspace/.venv/bin/python') !==
        (a.projectPreparation.manager === 'uv') ||
      c.imageDigest !== image ||
      a.imageDigest !== image ||
      s.architecture !== 'amd64' ||
      !s.executionOrigin ||
      a.projectPreparation.projectId !== s.project.projectId ||
      a.projectPreparation.sourceDigest !== s.snapshot.sourceDigest ||
      JSON.stringify(a.files) !==
        JSON.stringify(
          s.snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })),
        )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'cloud_project_identity_changed',
      });
  });
export type CloudProjectCommand = z.infer<typeof CloudProjectCommandSchema>;

export const CloudExecutionPayloadSchema = z.union([
  CloudCommandSchema,
  CloudProjectCommandSchema,
]);
export type CloudExecutionPayload = z.infer<typeof CloudExecutionPayloadSchema>;

/** Private physical journal. Failed preparation can have no container or install proof. */
export const CloudProjectRunResultSchema = z
  .object({
    containerId: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]),
    exitCode: z.number().int().nullable(),
    stopped: z.literal(true),
    reason: z.enum([
      'completed',
      'canceled',
      'deadline',
      'output_limit',
      'oom',
      'failed',
      'unknown',
    ]),
    output: z.string().max(65_536),
    artifacts: ProjectCollectedArtifactsSchema,
    elapsedMs: z.number().finite().min(0),
    imageDigest: ChecksumSchema,
    projectPreparation: RuntimeProjectPreparationEvidenceSchema.optional(),
    errorCode: z.string().max(128).optional(),
  })
  .strict();
export type CloudProjectRunResult = z.infer<typeof CloudProjectRunResultSchema>;
export function cloudProjectResultMatchesPayload(
  payload: CloudProjectCommand,
  result: CloudProjectRunResult,
) {
  if (result.imageDigest !== payload.imageDigest) return false;
  if (
    !projectArtifactsMatchOutputs(
      payload.arguments.outputs,
      result.artifacts,
      result.reason === 'completed' && result.exitCode === 0,
    )
  )
    return false;
  if (!result.containerId)
    return (
      result.reason === 'failed' &&
      result.exitCode === null &&
      !!result.errorCode &&
      result.projectPreparation === undefined
    );
  return projectPreparationResultMatches({
    spec: payload.arguments.projectPreparation,
    source: payload.arguments.projectSource,
    imageDigest: result.imageDigest,
    proof: result.projectPreparation,
    succeeded: result.reason === 'completed' && result.exitCode === 0,
    commandFinished: result.projectPreparation?.installation === 'succeeded',
  });
}
