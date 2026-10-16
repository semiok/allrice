import { assertCloudExecutionBudget } from './cloud-execution-budget.ts';
import { executionRequestConstraints } from './browser-execution-choice.ts';
import { methodFileProof } from './employees/employee-method-file-runtime.ts';
import {
  assertCloudNetworkAuthority,
  cloudInputTransferScopes,
} from './cloud-network-authority.ts';
import { isCompiledRepositoryExecution } from './platform-repair-contracts.ts';
import { createHash } from 'node:crypto';
import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  CloudExecutionPayloadSchema,
  projectRuntimeCacheIdentity,
  cloudPythonImageV1,
  cloudToolchainImageV1,
  type CloudExecutionPayload,
  CloudCommandInputSchema,
  CloudExecutionProfileSchema,
  cloudRuntimeImage,
  RuntimeActionBindingSchema,
  EmployeeExecutionSnapshotSchema,
  EmployeeDefinitionSchema,
  PythonExecuteArgsSchema,
  runtimeContractEqual,
  type RuntimeActionBinding,
  projectResolutionCloudArguments,
  ProjectDependencyResolveInputSchema,
} from '@allrice/contracts';
import type postgres from 'postgres';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';

import {
  assertSavedProjectAuthority,
  savedProjectContext,
  isProjectSourceAuthorityError,
} from './saved-project-authority.ts';
import { assertProjectExecutionOrigin } from './project-execution.ts';
import { resolvePlatformRepositoryExecutionProofTx } from './platform-repair-verification.ts';
import type { RepositoryExecutionProof } from './platform-repair-contracts.ts';

export const cloudExecutionEnabled = () =>
  runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED') &&
  runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED');

/** Execution normalization never mutates or defaults the original tool call. */
export function normalizeCloudPythonArguments(original: unknown) {
  const args = PythonExecuteArgsSchema.parse(original);
  return CloudCommandInputSchema.parse({
    script: args.script,
    language: 'python',
    inputs: args.inputs,
    outputs: args.outputs,
    limits: args.limits,
    ...(args.execution ? { execution: args.execution } : {}),
    ...(args.network ? { network: args.network } : {}),
  });
}
export function cloudCommandBinding(
  payload: CloudExecutionPayload,
  repositoryProof?: RepositoryExecutionProof,
) {
  if ('kind' in payload)
    return {
      executableDigest: digest({
        runtime: payload.runtime,
        executable: payload.arguments.executable,
      }),
      argumentsDigest: digest({
        args: payload.arguments.args,
        preparation: payload.arguments.projectPreparation,
        ...(payload.arguments.background
          ? { background: payload.arguments.background }
          : {}),
      }),
      workingDirectoryDigest: digest({
        kind: 'cloud_copy',
        project: payload.arguments.projectSource.project,
        path: payload.arguments.path,
        files: payload.arguments.files,
      }),
      effectiveEnvironmentDigest: digest({
        backend: payload.backend,
        credentials: 'none',
        user: '1000',
        preparation: 'trusted_root_supervisor',
        ...(payload.network !== 'none'
          ? { sandboxNetwork: 'controlled-https-v1' }
          : {}),
      }),
      networkPolicyDigest: digest({ network: payload.network }),
      toolchainDigest: digest({
        backend: payload.backend,
        imageDigest: payload.imageDigest,
        architecture: 'amd64',
      }),
      budgetDigest: digest(
        payload.executionBudget
          ? {
              limits: payload.arguments.limits,
              execution: payload.executionBudget,
            }
          : payload.arguments.limits,
      ),
    };
  return {
    executableDigest: digest({
      runtime: payload.runtime,
      ...(payload.arguments.language
        ? { language: payload.arguments.language }
        : {}),
      script: payload.arguments.script,
    }),
    argumentsDigest: digest([]),
    workingDirectoryDigest: digest({
      kind: 'cloud_copy',
      inputs: payload.arguments.inputs,
    }),
    effectiveEnvironmentDigest: digest({
      backend: payload.backend,
      credentials: 'none',
      user: repositoryProof ? '0' : '65532',
      ...(payload.network !== 'none'
        ? { sandboxNetwork: 'controlled-https-v1' }
        : {}),
      ...(payload.origin?.toolName === 'workspace.project'
        ? { projectResolution: 'v1', tmpfsMiB: 256 }
        : {}),
      ...(repositoryProof
        ? {
            supervisor: repositoryProof.profileId,
            candidateUser: '1001',
            capabilities: ['KILL', 'SETGID', 'SETUID'],
            tmpfsMiB: repositoryProof.tmpfsMiB,
          }
        : {}),
    }),
    networkPolicyDigest: digest({ network: payload.network }),
    toolchainDigest: digest({
      backend: payload.backend,
      imageDigest: payload.imageDigest,
    }),
    budgetDigest: digest(
      isCompiledRepositoryExecution(repositoryProof)
        ? {
            ...payload.arguments.limits,
            timeoutMs: repositoryProof.timeoutMs,
            memoryMiB: repositoryProof.memoryMiB,
          }
        : payload.executionBudget
          ? {
              limits: payload.arguments.limits,
              execution: payload.executionBudget,
            }
          : payload.arguments.limits,
    ),
  };
}

/** DB authority for a declared cloud transfer. Never authorizes before the exact
 * P04 approval is consumed; this function runs at proposal/dispatch/heartbeat. */
export async function checkContinuingCloudProjectAuthority(
  tx: postgres.TransactionSql,
  context: RuntimePolicyPrincipal,
  binding: RuntimeActionBinding,
) {
  return checkCloudBindingAuthority(tx, context, binding, true);
}

export async function checkCloudBindingAuthority(
  tx: postgres.TransactionSql,
  context: RuntimePolicyPrincipal,
  binding: RuntimeActionBinding,
  continuingService = false,
) {
  if (
    !cloudExecutionEnabled() ||
    binding.action !== 'cloud.process.execute' ||
    binding.execution.targetKind !== 'cloud_sandbox' ||
    binding.execution.deviceId !== null ||
    binding.execution.workCopy.kind !== 'cloud_copy' ||
    binding.task.scope.projectId !== null
  )
    throw new RuntimePolicyError('resource_adapter_not_registered');
  const [stored] = await tx<
    {
      binding: unknown;
      payload: unknown;
      original_arguments: unknown | null;
      job_id: string;
      worker_id: string;
      job_lease_token: string;
    }[]
  >`select binding,payload,original_arguments,job_id,worker_id,job_lease_token::text from allrice_cloud_execution_inputs where operation_id=${binding.attempt.operationId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and owner_id=${context.actor.id} and run_id=${binding.task.runId} and grant_id=${binding.execution.grantId}`;
  if (
    !stored ||
    !runtimeContractEqual(
      RuntimeActionBindingSchema.parse(stored.binding),
      binding,
    )
  )
    throw new RuntimePolicyError('cloud_input_changed');
  const payload = CloudExecutionPayloadSchema.parse(stored.payload);
  const project = 'kind' in payload ? payload : null;
  const origin = 'kind' in payload ? undefined : payload.origin;
  if (continuingService && !project?.arguments.background?.projectService)
    throw new RuntimePolicyError('cloud_input_changed');
  if (Boolean(origin || project) !== (stored.original_arguments !== null))
    throw new RuntimePolicyError('cloud_input_changed');
  if (origin) {
    const normalized =
      origin.toolName === 'workspace.project'
        ? CloudCommandInputSchema.parse(
            projectResolutionCloudArguments(
              ProjectDependencyResolveInputSchema.parse(
                stored.original_arguments,
              ),
            ),
          )
        : normalizeCloudPythonArguments(stored.original_arguments);
    if (
      digest(stored.original_arguments) !== origin.argumentsDigest ||
      !runtimeContractEqual(normalized, payload.arguments)
    )
      throw new RuntimePolicyError('cloud_input_changed');
  }
  const method =
    !project && !origin && !('kind' in payload)
      ? await methodFileProof(
          tx,
          {
            organizationId: context.organizationId,
            workspaceId: context.workspaceId,
            runId: binding.task.runId,
            jobId: stored.job_id,
            worker: { type: 'worker', id: stored.worker_id },
            policySnapshot: {
              id: binding.policy.snapshotId,
              subjectId: context.actor.id,
            },
          },
          payload,
          binding.attempt.operationId,
          binding,
        )
      : undefined;
  if (method && method.run.lease_token !== stored.job_lease_token)
    throw new RuntimePolicyError('cloud_worker_lease_changed');
  const [frozen] =
    await tx`select e.execution_snapshot from allrice_employee_runs e join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id where e.run_id=${binding.task.runId} and e.organization_id=${context.organizationId} and e.workspace_id=${context.workspaceId} and e.owner_id=${context.actor.id} and e.session_id=${binding.task.chatSessionId} and e.employee_version_id=${binding.task.frozenConfiguration.employeeVersionId} and (${continuingService} or (c.active_run_id=e.run_id and c.state='running' and c.thread_generation=${binding.attempt.generation})) for share of e,c`;
  const snapshot = EmployeeExecutionSnapshotSchema.safeParse(
    frozen?.execution_snapshot,
  );
  if (
    !method &&
    (!snapshot.success ||
      snapshot.data.tenantContext.organizationId !== context.organizationId ||
      snapshot.data.tenantContext.workspaceId !== context.workspaceId ||
      snapshot.data.tenantContext.actorId !== context.actor.id ||
      snapshot.data.tenantContext.policySnapshotId !==
        binding.policy.snapshotId ||
      !snapshot.data.capabilitySnapshot.grantedCapabilities.includes(
        'storage:write',
      ) ||
      !snapshot.data.capabilitySnapshot.bindings.toolNames.includes(
        origin?.toolName ?? 'cloud.process.execute',
      ))
  )
    throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
  if (origin && !('kind' in payload)) {
    if (!snapshot.success)
      throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
    const f = snapshot.data;
    if (
      f.employee.definition.schemaVersion !== 2 ||
      f.employee.definition.securityPolicy.deniedCapabilities.includes(
        'storage:write',
      ) ||
      (payload.arguments.inputs.length > 0 &&
        (!f.capabilitySnapshot.grantedCapabilities.includes('storage:read') ||
          f.employee.definition.securityPolicy.deniedCapabilities.includes(
            'storage:read',
          )))
    )
      throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
    const [version] = await tx<{ manifest: unknown }[]>`
      select manifest from allrice_employee_versions where id=${f.employee.versionId} and employee_id=${f.employee.id}
        and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
        and config_checksum=${f.employee.definitionChecksum} for share`;
    const manifest = EmployeeDefinitionSchema.safeParse(version?.manifest);
    if (
      !manifest.success ||
      !runtimeContractEqual(manifest.data, f.employee.definition)
    )
      throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
    if (origin.toolName === 'workspace.project') {
      const [message] = await tx<{ text: string }[]>`
        select coalesce(m.content->>'text','') as text from allrice_employee_runs e
        join allrice_messages m on m.id=e.user_message_id and m.organization_id=e.organization_id
          and m.workspace_id=e.workspace_id and m.owner_id=e.owner_id
        where e.run_id=${binding.task.runId} and e.organization_id=${context.organizationId}
          and e.workspace_id=${context.workspaceId} and e.owner_id=${context.actor.id} for share of m`;
      if (!message)
        throw new RuntimePolicyError('run_or_frozen_configuration_changed');
      const constraints = executionRequestConstraints(message.text);
      if (constraints.localOnly || constraints.location === 'local')
        throw new RuntimePolicyError('project_resolution_requires_cloud');
      if (
        !f.capabilitySnapshot.bindings.toolNames.includes(
          'cloud.process.execute',
        ) ||
        !runtimeContractEqual(
          origin.request,
          ProjectDependencyResolveInputSchema.parse(stored.original_arguments),
        )
      )
        throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
    } else {
      const [selection] = await tx<{ metadata: Record<string, unknown> }[]>`
      select metadata from allrice_audit_events where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
        and actor_id=${context.actor.id} and action='execution.location' and resource_type='managed_python'
        and metadata->>'runId'=${binding.task.runId} and metadata->>'callId'=${origin.callId} order by occurred_at limit 1`;
      if (
        selection?.metadata.requestDigest !==
          digest({
            toolName: 'python.execute',
            arguments: stored.original_arguments,
            purpose: 'python_charts',
          }) ||
        !runtimeContractEqual(
          selection.metadata.choice &&
            (selection.metadata.choice as { location?: string }).location,
          'cloud',
        ) ||
        selection.metadata.localInputs !== false
      )
        throw new RuntimePolicyError('cloud_input_changed');
    }
  }
  const [row] = await tx<
    {
      profile: unknown;
      version: number;
      enabled: boolean;
      revoked_at: Date | null;
      capabilities: unknown;
    }[]
  >`select g.profile,g.version,g.enabled,g.revoked_at,t.capabilities from allrice_cloud_execution_grants g join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id where g.id=${binding.execution.grantId} and g.organization_id=${context.organizationId} and g.workspace_id=${context.workspaceId} and g.owner_id=${context.actor.id} and g.target_id=${binding.execution.targetId} and t.kind='cloud_sandbox' and t.state='online' and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp()) for share of g,t`;
  if (
    !row ||
    !row.enabled ||
    row.revoked_at ||
    row.version !== binding.execution.grantVersion ||
    !Array.isArray(row.capabilities) ||
    !row.capabilities.includes('process.execute')
  )
    throw new RuntimePolicyError('cloud_grant_unavailable');
  const profile = CloudExecutionProfileSchema.parse(row.profile);
  if (digest(profile) !== binding.execution.scopeDigest)
    throw new RuntimePolicyError('cloud_profile_changed');
  const [worker] =
    await tx`select j.id from allrice_cloud_execution_inputs i join allrice_jobs j on j.id=i.job_id and j.run_id=i.run_id and j.organization_id=i.organization_id and j.workspace_id=i.workspace_id and j.owner_id=i.owner_id and j.worker_id=i.worker_id and j.lease_token=i.job_lease_token where i.operation_id=${binding.attempt.operationId} and j.status='running' and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null for share of j`;
  if (!worker && !continuingService)
    throw new RuntimePolicyError('cloud_worker_lease_changed');
  if (project) {
    if (!snapshot.success)
      throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
    assertCloudExecutionBudget(project, snapshot.data, false);
    assertCloudNetworkAuthority(project, profile, snapshot.data, false);
    const source = project.arguments.projectSource;
    const needsOutbound =
      !project.arguments.projectPreparation.offline &&
      project.arguments.projectPreparation.packages.some((p) => !p.archivePath);
    if (
      needsOutbound &&
      (!snapshot.data.capabilitySnapshot.grantedCapabilities.includes(
        'network:outbound',
      ) ||
        (snapshot.data.employee.definition.schemaVersion === 2 &&
          snapshot.data.employee.definition.securityPolicy.deniedCapabilities.includes(
            'network:outbound',
          )))
    )
      throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
    if (
      !source.executionOrigin ||
      digest(stored.original_arguments) !==
        source.executionOrigin.argumentsDigest ||
      !snapshot.data.capabilitySnapshot.bindings.toolNames.includes(
        'workspace.project',
      ) ||
      project.imageDigest !==
        (project.arguments.projectPreparation.manager === 'uv'
          ? cloudPythonImageV1
          : cloudToolchainImageV1) ||
      digest(payload) !== binding.inputDigest ||
      !runtimeContractEqual(cloudCommandBinding(payload), binding.command) ||
      !runtimeContractEqual(binding.baseline, [source.project.snapshot]) ||
      !runtimeContractEqual(
        binding.dataScope,
        cloudInputTransferScopes(
          [source.project.snapshot],
          binding.attempt.operationId,
          {
            command: project,
            grantId: binding.execution.grantId,
            grantVersion: binding.execution.grantVersion,
          },
        ),
      ) ||
      source.cacheKey !==
        'sha256:' +
          createHash('sha256')
            .update(
              JSON.stringify(
                projectRuntimeCacheIdentity({
                  spec: project.arguments.projectPreparation,
                  scope: {
                    organizationId: binding.task.scope.organizationId,
                    workspaceId: binding.task.scope.workspaceId!,
                    ownerId: binding.requestedBy.id,
                  },
                  image: project.imageDigest,
                  architecture: 'amd64',
                }),
              ),
            )
            .digest('hex')
    )
      throw new RuntimePolicyError('cloud_project_identity_changed');
    await assertProjectExecutionOrigin(tx, binding, project.arguments, 'cloud');
    try {
      if (!continuingService)
        await assertSavedProjectAuthority(
          tx,
          await savedProjectContext(tx, binding, source),
          binding.task.chatSessionId!,
          source.origin,
          source.project,
          'cloud.process.execute',
        );
    } catch (error) {
      if (isProjectSourceAuthorityError(error))
        throw new RuntimePolicyError('cloud_input_not_authorized');
      throw error;
    }
    return { binding, payload, profile };
  }
  // Project branch has returned; existing script/Office/Python identities stay byte-for-byte stable.
  if ('kind' in payload) throw new RuntimePolicyError('cloud_input_changed');
  let repositoryProof: RepositoryExecutionProof | undefined;
  try {
    repositoryProof = await resolvePlatformRepositoryExecutionProofTx(
      tx,
      {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        ownerId: context.actor.id,
        runId: binding.task.runId,
        jobId: stored.job_id,
        workerId: stored.worker_id,
        leaseToken: stored.job_lease_token,
        operationId: binding.attempt.operationId,
      },
      payload,
    );
  } catch {
    throw new RuntimePolicyError('cloud_input_not_authorized');
  }
  assertCloudExecutionBudget(
    payload,
    snapshot.success ? snapshot.data : undefined,
    Boolean(repositoryProof || method),
  );
  assertCloudNetworkAuthority(
    payload,
    profile,
    snapshot.success ? snapshot.data : undefined,
    Boolean(repositoryProof || method),
  );
  const content = payload.arguments.inputs.map((file) => ({
    kind: 'storage_object' as const,
    id: file.objectId,
    checksum: file.checksum,
  }));
  if (
    digest(payload) !== binding.inputDigest ||
    !runtimeContractEqual(
      cloudCommandBinding(payload, repositoryProof),
      binding.command,
    ) ||
    payload.imageDigest !==
      cloudRuntimeImage(profile.imageDigest, payload.arguments.language) ||
    binding.baseline.length !== payload.arguments.inputs.length ||
    !runtimeContractEqual(
      binding.dataScope,
      cloudInputTransferScopes(content, binding.attempt.operationId, {
        command: payload,
        grantId: binding.execution.grantId,
        grantVersion: binding.execution.grantVersion,
      }),
    )
  )
    throw new RuntimePolicyError('cloud_input_changed');
  for (const [index, file] of payload.arguments.inputs.entries()) {
    const content = {
      kind: 'storage_object' as const,
      id: file.objectId,
      checksum: file.checksum,
    };
    if (!runtimeContractEqual(binding.baseline[index], content))
      throw new RuntimePolicyError('cloud_transfer_scope_changed');
    const [object] = await tx<
      {
        owner_id: string;
        visibility: string;
        checksum: string;
        state: string;
        deleted_at: Date | null;
        size_bytes: string;
      }[]
    >`select owner_id,visibility,checksum,state,deleted_at,size_bytes from allrice_storage_objects where id=${file.objectId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} for share`;
    if (
      !object ||
      object.state !== 'ready' ||
      object.deleted_at ||
      object.checksum !== file.checksum ||
      Number(object.size_bytes) > (repositoryProof?.inputLimit ?? 2_000_000) ||
      (object.owner_id !== context.actor.id && object.visibility === 'private')
    )
      throw new RuntimePolicyError('cloud_input_not_authorized');
  }
  return { binding, payload, profile };
}
