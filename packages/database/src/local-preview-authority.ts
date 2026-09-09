import type postgres from 'postgres';
import {
  BridgeDeviceSchema,
  LocalPreviewLeaseSchema,
  LocalPreviewTargetSchema,
  RuntimeLocalCommandSchema,
  RuntimeOperationSnapshotSchema,
  RuntimePolicyControlsSchema,
  RuntimeActionApprovalRequestSchema,
  evaluateRuntimePolicy,
  matchesRuntimeActionApproval,
  runtimeContractEqual,
  localBrowserControllerLeaseMs,
  type ExecutionContext,
  type LocalPreviewTarget,
} from '@allrice/contracts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import { createGovernedBridgePolicyOptions } from './runtime-governed-bridge.ts';
import { localBrowserEnabled } from './local-browser-grants.ts';
import { localCommandFeatureEnabled } from './local-command-service.ts';
import { localServiceFeatureEnabled } from './local-service-runtime.ts';
import type { BrowserWorkspaceRow } from './browser-control-authority.ts';

export const localPreviewEnabled = () =>
  localBrowserEnabled() &&
  localCommandFeatureEnabled() &&
  localServiceFeatureEnabled() &&
  process.env.ALLRICE_LOCAL_PREVIEW_ENABLED === '1';

/** Read the current service under its existing immutable operation identity.
 * Deliberately no operation/root/policy write locks: browser admission can run
 * after the browser ledger's locks, while the service owns another operation.
 * The issued capability never outlives either physical controller lease. */
export async function currentLocalPreviewService(
  tx: postgres.TransactionSql,
  input: {
    principal: RuntimePolicyPrincipal;
    processId: string;
    context?: ExecutionContext;
  },
) {
  if (!localPreviewEnabled())
    throw new RuntimePolicyError('local_preview_disabled');
  const ctx = input.principal;
  const [row] = await tx<
    {
      snapshot: unknown;
      initial_snapshot: unknown;
      bridge_payload: unknown;
      lease_expires_at: Date;
      hard_deadline_at: Date;
      container_id: string;
      preview_heartbeat_at: Date;
      authority_deadline_at: Date;
      clock: Date;
      device: unknown;
      job_id: string;
      worker_id: string;
      job_attempt: number;
      job_lease_token: string;
      session_id: string;
    }[]
  >`select op.snapshot,op.initial_snapshot,op.bridge_payload,op.lease_expires_at,s.hard_deadline_at,s.container_id,s.preview_heartbeat_at,
    clock_timestamp() as clock,least(op.lease_expires_at,s.hard_deadline_at,root.deadline_at,j.lease_expires_at,j.timeout_at,p.expires_at) as authority_deadline_at,
    j.id as job_id,j.worker_id,j.attempt as job_attempt,j.lease_token as job_lease_token,e.session_id,
    json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,
      'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online',
      'lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device
    from allrice_runtime_operations op join allrice_local_services s on s.operation_id=op.id
    join allrice_runtime_roots root on root.root_run_id=op.root_run_id and root.organization_id=op.organization_id and root.workspace_id=op.workspace_id
    join allrice_runs r on r.id=op.run_id and r.organization_id=op.organization_id and r.workspace_id=op.workspace_id
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=r.organization_id and a.workspace_id=r.workspace_id and a.user_id=r.owner_id
    join allrice_employees employee on employee.id=a.employee_id and employee.organization_id=r.organization_id and employee.workspace_id=r.workspace_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id
    join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_bridge_devices d on d.id=op.device_id and d.organization_id=op.organization_id and d.workspace_id=op.workspace_id and d.owner_id=r.owner_id
    where op.id=${input.processId} and op.organization_id=${ctx.organizationId} and op.workspace_id=${ctx.workspaceId} and r.owner_id=${ctx.actor.id}
      and op.snapshot->>'status'='running' and op.lease_expires_at>clock_timestamp()
      and s.ready and s.state in ('ready','waiting_input') and not s.stop_requested and s.container_id is not null and s.hard_deadline_at>clock_timestamp()
      and s.preview_heartbeat_at>clock_timestamp()-interval '5 seconds' and s.preview_heartbeat_at<=clock_timestamp()
      and root.cancel_request_id is null and root.deadline_at>clock_timestamp()
      and r.state='running' and c.active_run_id=r.id and c.state='running' and a.active and a.employee_version_id=e.employee_version_id and employee.status='active'
      and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
      and p.expires_at>clock_timestamp()
      and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'local.preview.open'
      and e.execution_snapshot->'capabilitySnapshot'->'grantedCapabilities' ? 'network:outbound'`;
  if (
    !row ||
    (input.context &&
      (row.job_id !== input.context.jobId ||
        row.worker_id !== input.context.worker.id))
  )
    throw new RuntimePolicyError('local_preview_service_unavailable');
  const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
  const initial = RuntimeOperationSnapshotSchema.parse(row.initial_snapshot);
  const command = RuntimeLocalCommandSchema.parse(row.bridge_payload);
  const device = BridgeDeviceSchema.parse(row.device),
    binding = snapshot.binding;
  if (
    binding.action !== 'local.process.execute' ||
    binding.attempt.operationId !== input.processId ||
    binding.task.scope.organizationId !== ctx.organizationId ||
    binding.task.scope.workspaceId !== ctx.workspaceId ||
    binding.task.scope.projectId !== null ||
    binding.requestedBy.id !== ctx.actor.id ||
    binding.execution.deviceId !== device.id ||
    binding.inputDigest !== digest(command) ||
    !runtimeContractEqual(initial.binding, binding) ||
    command.arguments.background?.readiness.kind !== 'http' ||
    (input.context &&
      (binding.task.runId !== input.context.runId ||
        binding.policy.snapshotId !== input.context.policySnapshot.id))
  )
    throw new RuntimePolicyError('local_preview_service_unavailable');
  // Reuse the production process adapter for frozen command, image, folder,
  // device/platform/profile, generation and employee/job validation.
  const current = await createGovernedBridgePolicyOptions(
    device,
  ).resolveCurrentBinding({ transaction: tx, binding });
  if (!runtimeContractEqual(current, binding))
    throw new RuntimePolicyError('local_preview_service_changed');
  const [controlsRow] = await tx<
    { version: number; controls: unknown }[]
  >`select version,controls from allrice_runtime_policy_controls
    where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}`;
  const controls = RuntimePolicyControlsSchema.parse(controlsRow?.controls);
  if (
    controls.version !== controlsRow?.version ||
    evaluateRuntimePolicy(controls, binding).effect === 'deny'
  )
    throw new RuntimePolicyError('local_preview_policy_denied');
  const approvals = await tx<
    {
      runtime_request: unknown;
      runtime_response: unknown;
      runtime_binding_digest: string;
      runtime_control_version: number;
      runtime_expires_at: Date;
      runtime_consumed_at: Date | null;
      runtime_revoked_at: Date | null;
      status: string;
    }[]
  >`
    select runtime_request,runtime_response,runtime_binding_digest,runtime_control_version,runtime_expires_at,runtime_consumed_at,runtime_revoked_at,status
    from allrice_approval_requests where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}
      and resource_type='runtime_operation' and resource_id=${input.processId}`;
  const approval = approvals[0];
  if (
    approvals.length !== 1 ||
    !approval ||
    approval.status !== 'approved' ||
    !approval.runtime_consumed_at ||
    approval.runtime_revoked_at ||
    approval.runtime_control_version !== controls.version ||
    approval.runtime_expires_at <= row.clock ||
    approval.runtime_binding_digest !== digest(binding) ||
    !matchesRuntimeActionApproval(
      {
        request: RuntimeActionApprovalRequestSchema.parse(
          approval.runtime_request,
        ),
        response: approval.runtime_response,
        consumedAt: null,
        revokedAt: null,
      },
      {
        trustedScope: binding.task.scope,
        task: binding.task,
        respondentId: ctx.actor.id,
        activeTurn: null,
        now: row.clock.toISOString(),
        binding,
      },
    )
  )
    throw new RuntimePolicyError('local_preview_approval_unavailable');
  return {
    ...row,
    snapshot,
    command,
    device,
    authority_deadline_at: new Date(
      Math.min(
        row.authority_deadline_at.getTime(),
        approval.runtime_expires_at.getTime(),
      ),
    ),
  };
}

export async function currentLocalPreviewAuthority(
  tx: postgres.TransactionSql,
  ctx: RuntimePolicyPrincipal,
  w: BrowserWorkspaceRow,
) {
  const [endpoint] = await tx<
    { target: unknown; endpoint_lease_id: string }[]
  >`select target,endpoint_lease_id from allrice_local_preview_endpoints
    where browser_workspace_id=${w.id} and browser_grant_id=${w.grant_id} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id}`;
  if (!endpoint) throw new RuntimePolicyError('browser_authority_unavailable');
  const target = LocalPreviewTargetSchema.parse(endpoint.target);
  const current = await currentLocalPreviewService(tx, {
    principal: ctx,
    processId: target.processId,
    context: w.execution_context,
  });
  const b = current.snapshot.binding;
  const expected: LocalPreviewTarget = {
    ...target,
    scope: b.task.scope,
    ownerId: b.requestedBy.id,
    deviceId: current.device.id,
    runId: b.task.runId,
    rootRunId: b.task.rootRunId,
    browserWorkspaceId: w.id,
    browserProfileId: w.profile_id,
    browserGrantId: w.grant_id,
    processId: b.attempt.operationId,
    attemptId: b.attempt.attemptId,
    generation: b.attempt.generation,
    fence: b.attempt.fence,
    processInputDigest: b.inputDigest,
    folderGrantId: b.execution.grantId!,
    folderGrantVersion: b.execution.grantVersion,
    containerId: current.container_id,
    imageDigest: current.command.arguments.imageDigest,
    port: current.command.arguments.background!.readiness.port,
    hardDeadlineAt: current.hard_deadline_at.toISOString(),
  };
  if (!runtimeContractEqual(target, expected))
    throw new RuntimePolicyError('browser_authority_unavailable');
  return LocalPreviewLeaseSchema.parse({
    target,
    endpointLeaseId: endpoint.endpoint_lease_id,
    expiresAt: new Date(
      Math.min(
        current.clock.getTime() + localBrowserControllerLeaseMs,
        current.lease_expires_at.getTime(),
        current.authority_deadline_at.getTime(),
        current.preview_heartbeat_at.getTime() + localBrowserControllerLeaseMs,
        current.hard_deadline_at.getTime(),
        w.expires_at.getTime(),
      ),
    ).toISOString(),
  });
}
