import { runtimeFeatureEnabled } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import {
  CloudCommandSchema,
  McpExecutionPayloadSchema,
  RuntimeActionApprovalSnapshotSchema,
  RuntimeOperationSnapshotSchema,
  UuidSchema,
  McpError,
  type RequestContext,
  type RuntimeActionApprovalSnapshot,
  type RuntimeOperationSnapshot,
  type CloudCommand,
  type McpExecutionPayload,
} from '@allrice/contracts';
import type postgres from 'postgres';
import { getDatabase } from './core/client.ts';
import { createMcpStore } from './mcp-connections.ts';
import { createMcpOperationLedger } from './mcp-execution.ts';
import { assertEmployeeMcpAuthorization } from './mcp-employee-bindings.ts';
import {
  getRuntimeActionApproval,
  RuntimePolicyError,
} from './runtime-policy.ts';

type Database = ReturnType<typeof getDatabase>;
export type McpDisplayAuthorization = {
  available: boolean;
  reason:
    | 'available'
    | 'connection_revoked'
    | 'connection_or_tool_changed'
    | 'employee_authorization_changed'
    | 'unavailable';
};
export type CloudOperationView = {
  snapshot: RuntimeOperationSnapshot;
  enabled: boolean;
  /** Current display availability only, never an approval or execution grant. */
  mcpAuthorization: McpDisplayAuthorization | null;
  proposal:
    | {
        kind: 'cloud';
        script: string;
        inputs: CloudCommand['arguments']['inputs'];
        outputs: CloudCommand['arguments']['outputs'];
        limits: CloudCommand['arguments']['limits'];
      }
    | {
        kind: 'mcp';
        endpoint: string;
        tool: string;
        arguments: unknown;
        risk: string;
      };
  approval: RuntimeActionApprovalSnapshot | null;
  result: { output: string; code: string | null; trusted: false } | null;
};
async function mcpDisplayAuthorization(
  context: RequestContext,
  snapshot: RuntimeOperationSnapshot,
  payload: McpExecutionPayload,
  connectionEnabled: boolean | null,
  database: Database,
): Promise<McpDisplayAuthorization> {
  if (connectionEnabled === false)
    return { available: false, reason: 'connection_revoked' };
  if (connectionEnabled !== true)
    return { available: false, reason: 'unavailable' };
  const scope = {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId!,
    actorId: context.actor.id,
  };
  try {
    // Reuse the live, read-only connection/schema/tool-grant revision check.
    // This does not decrypt an execution credential or reserve any authority.
    await createMcpStore({ database }).assertAuthorized(scope, payload.tool);
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof McpError && error.code === 'MCP_DENIED'
          ? 'connection_or_tool_changed'
          : 'unavailable',
    };
  }
  try {
    const version = snapshot.binding.task.frozenConfiguration.employeeVersionId;
    if (!version)
      return { available: false, reason: 'employee_authorization_changed' };
    // The same bounded SELECT/lock check used by admission, with no state write.
    await database.begin((tx) =>
      assertEmployeeMcpAuthorization(tx, scope, payload.tool, version),
    );
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof McpError && error.code === 'MCP_DENIED'
          ? 'employee_authorization_changed'
          : 'unavailable',
    };
  }
  return { available: true, reason: 'available' };
}
async function ownedRun(
  tx: postgres.TransactionSql,
  context: RequestContext,
  runId: string,
) {
  if (context.actor.type !== 'user' || !context.workspaceId)
    throw new RuntimePolicyError('identity_denied');
  const [row] =
    await tx`select r.id from allrice_runs r join allrice_users u on u.id=r.owner_id
    join allrice_organizations o on o.id=r.organization_id join allrice_workspaces w on w.id=r.workspace_id and w.organization_id=r.organization_id
    join allrice_memberships m on m.organization_id=r.organization_id and m.user_id=r.owner_id and (m.workspace_id is null or m.workspace_id=r.workspace_id)
    where r.id=${UuidSchema.parse(runId)} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId} and r.owner_id=${context.actor.id}
    and m.active and m.role in ('admin','member') and u.status='active' and o.archived_at is null and w.archived_at is null for share of r,m,u,o,w`;
  if (!row) throw new RuntimePolicyError('run_not_owned');
}

/** Feature flags govern new execution, never erase already-existing history. */
export async function listCloudRuntimeOperations(
  context: RequestContext,
  runId: string,
  database: Database = getDatabase(),
): Promise<CloudOperationView[]> {
  const rows = await database.begin(async (tx) => {
    await ownedRun(tx, context, runId);
    return tx<
      {
        snapshot: unknown;
        mcp_payload: unknown | null;
        cloud_payload: unknown | null;
        mcp_result: {
          evidence: { output: string; code: string | null };
        } | null;
        cloud_outcome: { output: string; reason: string } | null;
        endpoint: string | null;
        connection_enabled: boolean | null;
        approval_id: string | null;
      }[]
    >`
      select o.snapshot,mi.payload as mcp_payload,ci.payload as cloud_payload,ma.result as mcp_result,ca.outcome as cloud_outcome,mc.endpoint,cb.enabled as connection_enabled,a.id as approval_id
      from allrice_runtime_operations o
      left join allrice_mcp_execution_inputs mi on mi.operation_id=o.id and mi.organization_id=o.organization_id and mi.workspace_id=o.workspace_id and mi.owner_id=${context.actor.id}
      left join allrice_mcp_binding_config mc on mc.binding_id=mi.binding_id
      left join allrice_connector_bindings cb on cb.id=mi.binding_id and cb.organization_id=o.organization_id and cb.workspace_id=o.workspace_id
      left join allrice_mcp_execution_attempts ma on ma.operation_id=mi.operation_id
      left join allrice_cloud_execution_inputs ci on ci.operation_id=o.id and ci.organization_id=o.organization_id and ci.workspace_id=o.workspace_id and ci.owner_id=${context.actor.id}
      left join allrice_cloud_execution_attempts ca on ca.operation_id=ci.operation_id
      left join allrice_approval_requests a on a.resource_type='runtime_operation' and a.resource_id=o.id and a.organization_id=o.organization_id and a.workspace_id=o.workspace_id
      where o.run_id=${runId} and o.organization_id=${context.organizationId} and o.workspace_id=${context.workspaceId}
      and o.snapshot->'binding'->>'action' in ('cloud.process.execute','cloud.mcp.call') order by o.created_at,o.id limit 100`;
  });
  // Do not hold a pool connection while the approval service opens its own
  // transaction. It rechecks current membership before returning an approval.
  const views: CloudOperationView[] = [];
  for (const row of rows) {
    const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
    if (
      snapshot.binding.requestedBy.type !== 'user' ||
      snapshot.binding.requestedBy.id !== context.actor.id
    )
      throw new RuntimePolicyError('run_not_owned');
    const approval = row.approval_id
      ? RuntimeActionApprovalSnapshotSchema.parse(
          await getRuntimeActionApproval(context, row.approval_id, database),
        )
      : null;
    if (snapshot.binding.action === 'cloud.mcp.call') {
      const payload = McpExecutionPayloadSchema.parse(row.mcp_payload);
      const args = await createMcpStore({ database }).redactForDisplay(
        {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId!,
          actorId: context.actor.id,
        },
        payload.tool.connectionId,
        payload.arguments,
      );
      views.push({
        snapshot,
        mcpAuthorization: await mcpDisplayAuthorization(
          context,
          snapshot,
          payload,
          row.connection_enabled,
          database,
        ),
        enabled:
          runtimeFeatureEnabled('ALLRICE_CLOUD_MCP_ENABLED') &&
          runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED'),
        proposal: {
          kind: 'mcp',
          endpoint: row.endpoint ?? 'Endpoint unavailable',
          tool: payload.tool.name,
          arguments: args,
          risk: payload.tool.risk,
        },
        approval,
        result: row.mcp_result
          ? {
              output: row.mcp_result.evidence.output,
              code: row.mcp_result.evidence.code,
              trusted: false,
            }
          : null,
      });
    } else {
      const payload = CloudCommandSchema.parse(row.cloud_payload);
      views.push({
        snapshot,
        mcpAuthorization: null,
        enabled:
          runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED') &&
          runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED'),
        proposal: {
          kind: 'cloud',
          script: payload.arguments.script,
          inputs: payload.arguments.inputs,
          outputs: payload.arguments.outputs,
          limits: payload.arguments.limits,
        },
        approval,
        result: row.cloud_outcome
          ? {
              output: row.cloud_outcome.output,
              code: row.cloud_outcome.reason,
              trusted: false,
            }
          : null,
      });
    }
  }
  return views;
}
export async function cancelCloudRuntimeRun(
  context: RequestContext,
  runId: string,
  database: Database = getDatabase(),
) {
  return database.begin(async (tx) => {
    await ownedRun(tx, context, runId);
    const [row] = await tx<
      { snapshot: unknown }[]
    >`select snapshot from allrice_runtime_operations where run_id=${runId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and snapshot->'binding'->>'action' in ('cloud.process.execute','cloud.mcp.call') limit 1`;
    if (!row) throw new RuntimePolicyError('cloud_operation_not_found');
    const { binding } = RuntimeOperationSnapshotSchema.parse(row.snapshot);
    if (
      binding.task.rootRunId !== runId ||
      binding.requestedBy.id !== context.actor.id
    )
      throw new RuntimePolicyError('run_not_owned');
    // Read/cancel does not require a live execution feature flag or renewed
    // connector credential, and cannot dispatch any new tool or script.
    const ledger = createMcpOperationLedger(context, database);
    await ledger.cancelRoot(
      binding.task.scope,
      binding.task.rootRunId,
      randomUUID(),
      tx,
    );
    return {
      accepted: true,
      runId,
      status: 'cancel_requested',
      remoteStopped: false,
    };
  });
}
