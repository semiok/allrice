import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FrozenMcpToolSchema,
  McpCallInputSchema,
  McpExecutionPayloadSchema,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  runtimeContractEqual,
  type ExecutionContext,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { createMcpStore } from './mcp-connections.ts';
import { assertEmployeeMcpAuthorization } from './mcp-employee-bindings.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';
import {
  createRuntimePolicyAdmission,
  requestRuntimeActionApproval,
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import {
  checkMcpBindingAuthority,
  mcpCommandBinding,
  mcpExecutionEnabled,
  mcpExecutionScopeDigest,
  mcpExecutionTargetId,
  mcpStableId,
} from './mcp-authority.ts';

type Database = ReturnType<typeof getDatabase>;
const snapshotSchema = z.object({
  mcpTools: z.array(FrozenMcpToolSchema).max(128).default([]),
  capabilitySnapshot: z.object({
    bindings: z.object({ toolNames: z.array(z.string()) }),
  }),
});
export function createMcpOperationLedger(
  context: RuntimePolicyPrincipal,
  database: Database = getDatabase(),
) {
  const policyOptions = {
    context,
    resolveCurrentBinding: async ({
      transaction,
      binding,
    }: {
      transaction: Parameters<typeof checkMcpBindingAuthority>[0];
      binding: RuntimeActionBinding;
    }) =>
      (await checkMcpBindingAuthority(transaction, context, binding)).binding,
  };
  return Object.assign(
    createRuntimeOperationLedger({
      database,
      admission: createRuntimePolicyAdmission(policyOptions),
      persistLease: async ({ transaction, lease }) => {
        if (lease.snapshot.binding.action !== 'cloud.mcp.call')
          throw new RuntimePolicyError('mcp_binding_denied');
        await transaction`insert into allrice_mcp_execution_attempts(operation_id,lease_token) values(${lease.snapshot.binding.attempt.operationId},${lease.leaseToken})`;
      },
    }),
    { policyOptions },
  );
}

/** The model chooses only an entry from this Run's already-frozen service tool
 * list. Job/Worker, target, credential revision and grant are server facts. */
export async function createMcpRuntimeOperation(
  input: { context: ExecutionContext; arguments: unknown; callId: string },
  database: Database = getDatabase(),
) {
  if (!mcpExecutionEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const args = McpCallInputSchema.parse(input.arguments),
    ctx = input.context,
    owner = ctx.policySnapshot.subjectId;
  // Canonicalization rejects non-JSON, sparse arrays and non-finite values.
  digest(args);
  if (
    !ctx.workspaceId ||
    !input.callId ||
    input.callId.length > 255 ||
    Buffer.byteLength(JSON.stringify(args.arguments)) > 131072
  )
    throw new RuntimePolicyError('invalid_tool_call');
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
      lease_token: string;
    }[]
  >`
    select r.execution_spec,e.execution_snapshot,r.policy_snapshot_id,p.payload as policy,e.session_id,e.employee_version_id,c.thread_generation,j.timeout_at,j.lease_token::text
    from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_jobs j on j.run_id=r.id and j.id=${ctx.jobId} and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id
    where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner}
    and r.state='running' and c.active_run_id=r.id and c.state='running' and j.status='running' and j.worker_id=${ctx.worker.id}
    and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null and j.timeout_at>clock_timestamp() and p.expires_at>clock_timestamp()`;
  if (!run || run.policy_snapshot_id !== ctx.policySnapshot.id)
    throw new RuntimePolicyError('mcp_run_or_worker_changed');
  const frozen = snapshotSchema.parse(run.execution_snapshot);
  const matches = frozen.mcpTools.filter(
    (t) => t.connectionId === args.connectionId && t.name === args.tool,
  );
  if (
    !frozen.capabilitySnapshot.bindings.toolNames.includes('cloud.mcp.call') ||
    matches.length !== 1
  )
    throw new RuntimePolicyError('mcp_frozen_tool_not_allowed');
  const tool = matches[0]!,
    scope = {
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      actorId: owner,
    };
  const { endpoint } = await createMcpStore({ database }).assertAuthorized(
    scope,
    tool,
  );
  await assertEmployeeMcpAuthorization(
    database,
    scope,
    tool,
    run.employee_version_id,
  );
  const payload = McpExecutionPayloadSchema.parse({
    capability: 'cloud.mcp.call',
    tool,
    arguments: args.arguments,
  });
  const key = `mcp-call:${ctx.runId}:${input.callId}`,
    operationId = mcpStableId(key),
    targetId = mcpExecutionTargetId(tool.connectionId);
  // Projection of an explicitly installed connector, not a fresh grant. The
  // adapter still checks the source binding and every per-tool revision live.
  await database`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
    values(${targetId},${ctx.organizationId},${ctx.workspaceId},${`mcp.${tool.connectionId}`},'cloud_mcp','Authorized remote MCP service','online','["mcp.call"]',${database.json({ connectionId: tool.connectionId, statusSource: 'authorized_connector_projection' })}) on conflict(id) do nothing`;
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
      targetId,
      targetKind: 'cloud_mcp',
      deviceId: null,
      grantId: tool.connectionId,
      grantVersion: tool.connectionRevision,
      scopeDigest: mcpExecutionScopeDigest(endpoint, payload),
      workCopy: { id: operationId, kind: 'remote_service' },
    },
    action: 'cloud.mcp.call',
    inputDigest: digest(payload),
    command: mcpCommandBinding(endpoint, payload),
    baseline: [],
    dataScope: [],
  });
  await database`insert into allrice_mcp_execution_inputs(operation_id,organization_id,workspace_id,owner_id,run_id,binding_id,job_id,worker_id,job_lease_token,binding,payload)
    values(${operationId},${ctx.organizationId},${ctx.workspaceId},${owner},${ctx.runId},${tool.connectionId},${ctx.jobId},${ctx.worker.id},${run.lease_token},${database.json(binding)},${database.json(JSON.parse(JSON.stringify(payload)))}) on conflict(operation_id) do nothing`;
  const [stored] = await database<
    {
      binding: unknown;
      payload: unknown;
      job_id: string;
      worker_id: string;
      job_lease_token: string;
    }[]
  >`select binding,payload,job_id,worker_id,job_lease_token from allrice_mcp_execution_inputs where operation_id=${operationId}`;
  if (
    !stored ||
    !runtimeContractEqual(stored.binding, binding) ||
    !runtimeContractEqual(stored.payload, payload) ||
    stored.job_id !== ctx.jobId ||
    stored.worker_id !== ctx.worker.id ||
    stored.job_lease_token !== run.lease_token
  )
    throw new RuntimePolicyError('idempotency_conflict');
  const principal = {
    actor: { type: 'user' as const, id: owner },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    requestId: randomUUID(),
  };
  const ledger = createMcpOperationLedger(principal, database);
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
    reservations: budgets.map((b) => ({
      metric: b.metric,
      accountingId: mcpStableId(`${key}:meter:${b.metric}`),
      amount:
        b.metric === 'tool_calls'
          ? 1
          : b.metric === 'wall_time'
            ? 30000
            : b.metric === 'output_bytes'
              ? 1048576
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
    ledger,
    principal,
    scope,
    deadlineAt: run.timeout_at.toISOString(),
    context: ctx,
    jobLeaseToken: run.lease_token,
  };
}
