import {
  BridgeDeviceSchema,
  EmployeeExecutionSnapshotSchema,
  LocalMcpDiscoverInputSchema,
  McpCallInputSchema,
  RuntimeLocalMcpPayloadSchema,
  RuntimeLocalCommandProfileSchema,
  isLocalCommandProfileForPlatform,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  type ExecutionContext,
  type RuntimeLocalMcpPayload,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  runtimePolicyDigest as digest,
  RuntimePolicyError,
  requestRuntimeActionApproval,
} from './runtime-policy.ts';
import { mcpStableId } from './mcp-authority.ts';
import { localMcpEnabled } from './local-mcp-connections.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';

export function localMcpCommandBinding(payload: RuntimeLocalMcpPayload) {
  const args = payload.arguments;
  return {
    executableDigest: digest({
      executable: '/usr/local/bin/node',
      source: args.source,
      imageDigest: args.imageDigest,
    }),
    argumentsDigest: digest(
      payload.capability === 'local.mcp.call'
        ? {
            phase: 'call',
            connectionId: args.connectionId,
            connectionRevision: args.connectionRevision,
            tool: payload.arguments.tool,
            arguments: payload.arguments.toolArguments,
          }
        : {
            phase: 'discover',
            connectionId: args.connectionId,
            connectionRevision: args.connectionRevision,
          },
    ),
    workingDirectoryDigest: digest({
      path: args.path,
      source: args.source,
      kind: 'local_copy',
    }),
    effectiveEnvironmentDigest: digest({
      version: args.isolation,
      credential: args.credential,
    }),
    networkPolicyDigest: digest({ network: args.network }),
    toolchainDigest: digest({
      imageDigest: args.imageDigest,
      backend: args.isolation,
    }),
    budgetDigest: digest(args.limits),
  };
}

/** Trusted Broker entry. The model selects a frozen connection/tool, never a
 * process path, device, credential value or permission policy. */
export async function createLocalMcpRuntimeOperation(
  input: {
    context: ExecutionContext;
    capability: 'local.mcp.discover' | 'local.mcp.call';
    arguments: unknown;
    callId: string;
  },
  database = getDatabase(),
) {
  if (!localMcpEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const args =
      input.capability === 'local.mcp.call'
        ? McpCallInputSchema.parse(input.arguments)
        : LocalMcpDiscoverInputSchema.parse(input.arguments),
    ctx = input.context,
    owner = ctx.policySnapshot.subjectId;
  if (!ctx.workspaceId || !input.callId || input.callId.length > 255)
    throw new RuntimePolicyError('invalid_tool_call');
  digest(args);
  const [run] = await database<
    {
      execution_spec: unknown;
      execution_snapshot: unknown;
      policy_snapshot_id: string;
      policy: unknown;
      session_id: string;
      employee_version_id: string;
      thread_generation: number;
      timeout_at: Date;
    }[]
  >`select r.execution_spec,e.execution_snapshot,r.policy_snapshot_id,p.payload as policy,e.session_id,e.employee_version_id,c.thread_generation,j.timeout_at
    from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_jobs j on j.run_id=r.id and j.id=${ctx.jobId} and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id
    where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner}
      and r.state='running' and c.active_run_id=r.id and c.state='running' and j.status='running' and j.worker_id=${ctx.worker.id}
      and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null and j.timeout_at>clock_timestamp() and p.expires_at>clock_timestamp()`;
  if (!run || run.policy_snapshot_id !== ctx.policySnapshot.id)
    throw new RuntimePolicyError('run_or_frozen_configuration_changed');
  const frozen = EmployeeExecutionSnapshotSchema.parse(run.execution_snapshot);
  if (frozen.schemaVersion !== 2)
    throw new RuntimePolicyError('local_mcp_frozen_connection_denied');
  const connection = frozen.localMcp?.connections.find(
    (c) => c.connectionId === args.connectionId,
  );
  if (
    !connection ||
    !frozen.capabilitySnapshot.bindings.toolNames.includes(input.capability)
  )
    throw new RuntimePolicyError('local_mcp_frozen_connection_denied');
  const [target] = await database<
    {
      device: unknown;
      target_id: string;
      root_fingerprint: string;
      label: string;
      profile: unknown;
    }[]
  >`select json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online','lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device,t.id as target_id,g.root_fingerprint,g.label,p.profile
    from allrice_bridge_devices d join allrice_bridge_runtime_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
    join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id and t.target_key='bridge.'||d.id::text and t.kind='rice_bridge' and t.state='online'
    join allrice_bridge_folder_grants g on g.device_id=d.id and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
    where d.id=${connection.deviceId} and g.id=${connection.folderGrantId} and g.runtime_generation=${connection.folderGrantVersion} and g.revoked_at is null
      and d.organization_id=${ctx.organizationId} and d.workspace_id=${ctx.workspaceId} and d.owner_id=${owner} and d.revoked_at is null
      and d.last_seen_at>clock_timestamp()-interval '90 seconds' and p.reported_at>clock_timestamp()-interval '90 seconds'`;
  if (!target) throw new RuntimePolicyError('local_runner_unavailable');
  const device = BridgeDeviceSchema.parse(target.device),
    profile = RuntimeLocalCommandProfileSchema.parse(target.profile);
  if (
    !profile.available ||
    !profile.features?.includes('local_mcp') ||
    !isLocalCommandProfileForPlatform(device.platform, profile)
  )
    throw new RuntimePolicyError('local_runner_unavailable');
  const tool =
    'tool' in args
      ? frozen.localMcp?.tools.find(
          (t) =>
            t.connectionId === connection.connectionId && t.name === args.tool,
        )
      : undefined;
  if (input.capability === 'local.mcp.call' && !tool)
    throw new RuntimePolicyError('local_mcp_frozen_tool_denied');
  const payload = RuntimeLocalMcpPayloadSchema.parse({
    capability: input.capability,
    arguments: {
      connectionId: connection.connectionId,
      connectionRevision: connection.connectionRevision,
      deviceId: device.id,
      ...connection.configuration,
      imageDigest: profile.imageDigest,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: { timeoutMs: 60000, memoryMiB: 256, cpuMillis: 1000, pids: 32 },
      ...(tool && 'arguments' in args
        ? { tool, toolArguments: args.arguments }
        : {}),
    },
  });
  const key = `local-mcp:${ctx.runId}:${input.callId}`,
    operationId = mcpStableId(key);
  const binding = RuntimeActionBindingSchema.parse({
    task: {
      scope: {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        projectId: null,
      },
      chatSessionId: run.session_id,
      runId: ctx.runId,
      rootRunId: ctx.runId,
      parentRunId: null,
      frozenConfiguration: {
        employeeVersionId: run.employee_version_id,
        digest: digest(run.execution_spec),
      },
    },
    attempt: {
      operationId,
      attemptId: mcpStableId(`${key}:attempt`),
      attemptNumber: 1,
      generation: run.thread_generation,
      fence: 1,
    },
    requestedBy: { type: 'user', id: owner },
    policy: { snapshotId: run.policy_snapshot_id, digest: digest(run.policy) },
    execution: {
      targetId: target.target_id,
      targetKind: 'rice_bridge',
      deviceId: device.id,
      grantId: connection.folderGrantId,
      grantVersion: connection.folderGrantVersion,
      scopeDigest: `sha256:${target.root_fingerprint}`,
      workCopy: { id: operationId, kind: 'local_copy' },
    },
    action: input.capability,
    inputDigest: digest(payload),
    command: localMcpCommandBinding(payload),
    baseline: [],
    dataScope: [],
  });
  const ledger = createGovernedBridgeOperationLedger(device, {
    database,
    initialOperation: { binding, payload },
  });
  const budgets = await ensureRuntimeOperationRoot(
    ledger,
    binding.task,
    run.timeout_at.toISOString(),
    database,
  );
  const snapshot = await ledger.createOperation({
    snapshot: RuntimeOperationSnapshotSchema.parse({
      contractVersion: 1,
      binding,
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: mcpStableId(`${key}:delivery`),
      status: 'planned',
      result: null,
    }),
    bridgePayload: payload,
    reservations: budgets.map((b) => ({
      metric: b.metric,
      accountingId: mcpStableId(`${key}:meter:${b.metric}`),
      amount:
        b.metric === 'tool_calls'
          ? 1
          : b.metric === 'wall_time'
            ? 60000
            : b.metric === 'output_bytes'
              ? 262144
              : 0,
    })),
  });
  if (snapshot.status === 'waiting_user')
    await requestRuntimeActionApproval(
      ledger.policyOptions,
      binding,
      600000,
      database,
    );
  return {
    snapshot,
    payload,
    workspaceLabel: target.label,
    deadlineAt: run.timeout_at.toISOString(),
    ledger,
  };
}
