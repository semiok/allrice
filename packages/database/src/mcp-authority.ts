import { runtimeFeatureEnabled } from '@allrice/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type postgres from 'postgres';
import { assertEmployeeMcpAuthorization } from './mcp-employee-bindings.ts';
import {
  FrozenMcpToolSchema,
  McpExecutionPayloadSchema,
  RuntimeActionBindingSchema,
  runtimeContractEqual,
  type McpExecutionPayload,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import { connectorInputDigest } from './capabilities/connector-broker.ts';

export const mcpExecutionEnabled = () =>
  runtimeFeatureEnabled('ALLRICE_CLOUD_MCP_ENABLED') &&
  runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED');
export function mcpStableId(key: string) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const mcpExecutionTargetId = (connectionId: string) =>
  mcpStableId(`mcp-target:${connectionId}`);
export function mcpExecutionScopeDigest(
  endpoint: string,
  payload: McpExecutionPayload,
) {
  return digest({ endpoint, tool: payload.tool });
}
export function mcpCommandBinding(
  endpoint: string,
  payload: McpExecutionPayload,
) {
  return {
    executableDigest: digest({
      tool: payload.tool.name,
      schema: payload.tool.digest,
    }),
    argumentsDigest: digest(payload.arguments),
    workingDirectoryDigest: digest({ kind: 'remote_service' }),
    effectiveEnvironmentDigest: digest({
      credentialReference: payload.tool.credentialReference,
    }),
    networkPolicyDigest: digest({ endpoint, redirects: false }),
    toolchainDigest: digest({
      protocol: '2025-11-25',
      connectionRevision: payload.tool.connectionRevision,
    }),
    budgetDigest: digest({ timeoutMs: 30000, outputBytes: 1048576 }),
  };
}

/** Current DB authority, called by policy at proposal, approval, dispatch and
 * heartbeat. No browser/model-supplied frozen tool or live catalog substitution. */
export async function checkMcpBindingAuthority(
  tx: postgres.TransactionSql,
  context: RuntimePolicyPrincipal,
  binding: RuntimeActionBinding,
) {
  if (
    !mcpExecutionEnabled() ||
    context.actor.type !== 'user' ||
    binding.action !== 'cloud.mcp.call' ||
    binding.execution.targetKind !== 'cloud_mcp' ||
    binding.execution.deviceId !== null ||
    binding.execution.workCopy.kind !== 'remote_service' ||
    binding.execution.workCopy.id !== binding.attempt.operationId ||
    binding.task.scope.projectId !== null ||
    binding.baseline.length ||
    binding.dataScope.length ||
    binding.task.scope.organizationId !== context.organizationId ||
    binding.task.scope.workspaceId !== context.workspaceId ||
    binding.requestedBy.id !== context.actor.id ||
    binding.requestedBy.type !== 'user'
  )
    throw new RuntimePolicyError('mcp_binding_denied');
  const [identity] =
    await tx`select m.id from allrice_memberships m join allrice_users u on u.id=m.user_id
    join allrice_organizations o on o.id=m.organization_id join allrice_workspaces w on w.id=${context.workspaceId} and w.organization_id=o.id
    where m.organization_id=${context.organizationId} and m.user_id=${context.actor.id} and m.active and m.role in ('admin','member')
    and (m.workspace_id is null or m.workspace_id=${context.workspaceId}) and u.status='active' and o.archived_at is null and w.archived_at is null
    for share of m,u,o,w`;
  if (!identity) throw new RuntimePolicyError('membership_denied');
  const [stored] = await tx<
    {
      binding: unknown;
      payload: unknown;
      job_id: string;
      worker_id: string;
      job_lease_token: string;
    }[]
  >`
    select binding,payload,job_id,worker_id,job_lease_token from allrice_mcp_execution_inputs where operation_id=${binding.attempt.operationId}
    and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and owner_id=${context.actor.id} and run_id=${binding.task.runId}`;
  if (
    !stored ||
    !runtimeContractEqual(
      RuntimeActionBindingSchema.parse(stored.binding),
      binding,
    )
  )
    throw new RuntimePolicyError('mcp_input_changed');
  const payload = McpExecutionPayloadSchema.parse(stored.payload),
    tool = payload.tool;
  // Employee first: archive/assignment management and tenant grant changes
  // acquire this row before assignments or grant rows. Keep that global order.
  try {
    await assertEmployeeMcpAuthorization(
      tx,
      {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        actorId: context.actor.id,
      },
      tool,
      binding.task.frozenConfiguration.employeeVersionId!,
    );
  } catch {
    throw new RuntimePolicyError('mcp_employee_binding_changed');
  }
  const [run] = await tx<
    {
      execution_snapshot: { mcpTools?: unknown };
      execution_spec: unknown;
      policy_snapshot_id: string;
      policy: unknown;
    }[]
  >`
    select e.execution_snapshot,r.execution_spec,r.policy_snapshot_id,p.payload as policy from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
    join allrice_jobs j on j.id=${stored.job_id} and j.run_id=e.run_id and j.organization_id=e.organization_id and j.workspace_id=e.workspace_id and j.owner_id=e.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=e.organization_id and a.workspace_id=e.workspace_id and a.user_id=e.owner_id and a.employee_id=${tool.employeeAuthorization?.employeeId ?? null} and a.active
    where e.run_id=${binding.task.runId} and e.organization_id=${context.organizationId} and e.workspace_id=${context.workspaceId} and e.owner_id=${context.actor.id}
    and e.session_id=${binding.task.chatSessionId} and e.employee_version_id=${binding.task.frozenConfiguration.employeeVersionId}
    and r.state='running' and c.active_run_id=e.run_id and c.state='running' and c.thread_generation=${binding.attempt.generation}
    and j.status='running' and j.worker_id=${stored.worker_id} and j.lease_token::text=${stored.job_lease_token}
    and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null and p.expires_at>clock_timestamp()
    and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'cloud.mcp.call'
    for share of e,r,p,c,j,a`;
  if (
    !run ||
    run.policy_snapshot_id !== binding.policy.snapshotId ||
    digest(run.policy) !== binding.policy.digest ||
    digest(run.execution_spec) !== binding.task.frozenConfiguration.digest
  )
    throw new RuntimePolicyError('mcp_run_or_worker_changed');
  const frozen = z
    .array(FrozenMcpToolSchema)
    .max(128)
    .parse(run.execution_snapshot.mcpTools ?? []);
  if (!frozen.some((t) => runtimeContractEqual(t, tool)))
    throw new RuntimePolicyError('mcp_frozen_tool_not_allowed');
  const [connection] = await tx<
    {
      endpoint: string;
      revision: number;
      credential_reference: string;
      grant_revision: number;
      risk: string;
      digest: string;
      definition: unknown;
    }[]
  >`
    select c.endpoint,c.revision,b.credential_reference,g.grant_revision,g.risk,r.digest,r.definition from allrice_mcp_binding_config c
    join allrice_connector_bindings b on b.id=c.binding_id and b.organization_id=c.organization_id and b.workspace_id=c.workspace_id
    join allrice_connector_definitions d on d.id=b.connector_id
    join allrice_mcp_tool_grants g on g.binding_id=c.binding_id and g.organization_id=c.organization_id and g.workspace_id=c.workspace_id
    join allrice_mcp_tool_revisions r on r.id=g.revision_id and r.binding_id=g.binding_id
    where c.binding_id=${tool.connectionId} and c.organization_id=${context.organizationId} and c.workspace_id=${context.workspaceId}
    and b.enabled and d.enabled and b.identity_mode='service' and g.available and g.allowed and g.tool_name=${tool.name} and r.id=${tool.toolRevisionId}
    for share of c,b,d,g,r`;
  const declared = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
  if (
    !connection ||
    connection.revision !== tool.connectionRevision ||
    connection.credential_reference !== tool.credentialReference ||
    connection.grant_revision !== tool.grantRevision ||
    connection.risk !== tool.risk ||
    connection.digest !== tool.digest ||
    connectorInputDigest(connection.definition) !== tool.digest ||
    connectorInputDigest(declared) !== tool.digest ||
    binding.execution.targetId !== mcpExecutionTargetId(tool.connectionId) ||
    binding.execution.grantId !== tool.connectionId ||
    binding.execution.grantVersion !== tool.connectionRevision ||
    binding.execution.scopeDigest !==
      mcpExecutionScopeDigest(connection.endpoint, payload) ||
    binding.inputDigest !== digest(payload) ||
    !runtimeContractEqual(
      binding.command,
      mcpCommandBinding(connection.endpoint, payload),
    )
  )
    throw new RuntimePolicyError('mcp_grant_or_schema_changed');
  return { binding, payload, tool };
}
