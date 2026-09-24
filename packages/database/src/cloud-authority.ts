import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  CloudCommandSchema,
  CloudExecutionProfileSchema,
  RuntimeActionBindingSchema,
  EmployeeExecutionSnapshotSchema,
  runtimeContractEqual,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import type postgres from 'postgres';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';

export const cloudExecutionEnabled = () =>
  runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED') &&
  runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED');
export function cloudCommandBinding(
  payload: ReturnType<typeof CloudCommandSchema.parse>,
) {
  return {
    executableDigest: digest({
      runtime: payload.runtime,
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
      user: '65532',
    }),
    networkPolicyDigest: digest({ network: 'none' }),
    toolchainDigest: digest({
      backend: payload.backend,
      imageDigest: payload.imageDigest,
    }),
    budgetDigest: digest(payload.arguments.limits),
  };
}

/** DB authority for a declared cloud transfer. Never authorizes before the exact
 * P04 approval is consumed; this function runs at proposal/dispatch/heartbeat. */
export async function checkCloudBindingAuthority(
  tx: postgres.TransactionSql,
  context: RuntimePolicyPrincipal,
  binding: RuntimeActionBinding,
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
  const [frozen] =
    await tx`select e.execution_snapshot from allrice_employee_runs e join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id where e.run_id=${binding.task.runId} and e.organization_id=${context.organizationId} and e.workspace_id=${context.workspaceId} and e.owner_id=${context.actor.id} and e.session_id=${binding.task.chatSessionId} and e.employee_version_id=${binding.task.frozenConfiguration.employeeVersionId} and c.active_run_id=e.run_id and c.state='running' and c.thread_generation=${binding.attempt.generation} for share of e,c`;
  const snapshot = EmployeeExecutionSnapshotSchema.safeParse(
    frozen?.execution_snapshot,
  );
  if (
    !snapshot.success ||
    snapshot.data.tenantContext.organizationId !== context.organizationId ||
    snapshot.data.tenantContext.workspaceId !== context.workspaceId ||
    snapshot.data.tenantContext.actorId !== context.actor.id ||
    snapshot.data.tenantContext.policySnapshotId !==
      binding.policy.snapshotId ||
    !snapshot.data.capabilitySnapshot.grantedCapabilities.includes(
      'storage:write',
    ) ||
    !snapshot.data.capabilitySnapshot.bindings.toolNames.includes(
      'cloud.process.execute',
    )
  )
    throw new RuntimePolicyError('cloud_frozen_tool_not_allowed');
  const [row] = await tx<
    {
      profile: unknown;
      version: number;
      enabled: boolean;
      revoked_at: Date | null;
      capabilities: unknown;
    }[]
  >`select g.profile,g.version,g.enabled,g.revoked_at,t.capabilities from allrice_cloud_execution_grants g join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id where g.id=${binding.execution.grantId} and g.organization_id=${context.organizationId} and g.workspace_id=${context.workspaceId} and g.owner_id=${context.actor.id} and g.target_id=${binding.execution.targetId} for share of g,t`;
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
  const [stored] = await tx<
    { binding: unknown; payload: unknown }[]
  >`select binding,payload from allrice_cloud_execution_inputs where operation_id=${binding.attempt.operationId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and owner_id=${context.actor.id} and run_id=${binding.task.runId} and grant_id=${binding.execution.grantId}`;
  if (
    !stored ||
    !runtimeContractEqual(
      RuntimeActionBindingSchema.parse(stored.binding),
      binding,
    )
  )
    throw new RuntimePolicyError('cloud_input_changed');
  const [worker] =
    await tx`select j.id from allrice_cloud_execution_inputs i join allrice_jobs j on j.id=i.job_id and j.run_id=i.run_id and j.organization_id=i.organization_id and j.workspace_id=i.workspace_id and j.owner_id=i.owner_id and j.worker_id=i.worker_id and j.lease_token=i.job_lease_token where i.operation_id=${binding.attempt.operationId} and j.status='running' and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null for share of j`;
  if (!worker) throw new RuntimePolicyError('cloud_worker_lease_changed');
  const payload = CloudCommandSchema.parse(stored.payload);
  if (
    digest(payload) !== binding.inputDigest ||
    !runtimeContractEqual(cloudCommandBinding(payload), binding.command) ||
    payload.imageDigest !== profile.imageDigest ||
    binding.baseline.length !== payload.arguments.inputs.length ||
    binding.dataScope.length !== payload.arguments.inputs.length
  )
    throw new RuntimePolicyError('cloud_input_changed');
  for (const [index, file] of payload.arguments.inputs.entries()) {
    const content = {
      kind: 'storage_object' as const,
      id: file.objectId,
      checksum: file.checksum,
    };
    if (
      !runtimeContractEqual(binding.baseline[index], content) ||
      !runtimeContractEqual(binding.dataScope[index], {
        content,
        sourceTargetId: null,
        purpose: 'execution_input',
        destination: 'cloud_execution',
        authorizationId: binding.attempt.operationId,
        authorizationVersion: 1,
      })
    )
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
      Number(object.size_bytes) > 2_000_000 ||
      (object.owner_id !== context.actor.id && object.visibility === 'private')
    )
      throw new RuntimePolicyError('cloud_input_not_authorized');
  }
  return { binding, payload, profile };
}
