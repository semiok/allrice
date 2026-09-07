import { createHash, randomUUID } from 'node:crypto';

import {
  ConnectorBindingSchema,
  ConnectorCallDecisionSchema,
  ConnectorCallRequestSchema,
  ConnectorDefinitionSchema,
  CreateConnectorBindingInputSchema,
  CreateConnectorDefinitionInputSchema,
  DecideApprovalInputSchema,
  UpdateConnectorBindingHealthInputSchema,
  UuidSchema,
  type ConnectorBinding,
  type ConnectorCallDecision,
  type ConnectorDefinition,
  type ExecutionContext,
  type RequestContext,
  type SkillCapability,
} from '@allrice/contracts';
import type postgres from 'postgres';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { resolveWorkspaceId } from '../workspace/service.ts';

type JsonValue = Parameters<postgres.Sql['json']>[0];

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function userId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function requireAdmin(context: RequestContext, workspaceId: string) {
  const actor = userId(context);
  const allowed = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actor &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId) &&
      membership.role === 'admin',
  );
  if (!allowed) throw new DataAccessError('authorization_denied');
  return actor;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function connectorInputDigest(value: unknown) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export async function createConnectorDefinition(
  context: RequestContext,
  input: unknown,
): Promise<ConnectorDefinition> {
  const creation = CreateConnectorDefinitionInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, creation.workspaceId);
  const actor = requireAdmin(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<
    {
      id: string;
      connector_key: string;
      name: string;
      description: string;
      capabilities: unknown;
      input_schema: unknown;
      risk: ConnectorDefinition['risk'];
      identity_modes: unknown;
      resource_scopes: unknown;
      enabled: boolean;
    }[]
  >`
    insert into allrice_connector_definitions (
      organization_id, workspace_id, connector_key, name, description,
      capabilities, input_schema, risk, identity_modes, resource_scopes,
      created_by
    ) values (
      ${context.organizationId}, ${workspaceId}, ${creation.key},
      ${creation.name}, ${creation.description},
      ${sql.json(creation.capabilities)}, ${sql.json(toJsonValue(creation.inputSchema))},
      ${creation.risk}, ${sql.json(creation.identityModes)},
      ${sql.json(creation.resourceScopes)}, ${actor}
    ) returning id, connector_key, name, description, capabilities,
      input_schema, risk, identity_modes, resource_scopes, enabled
  `;
  const row = rows[0];
  if (!row) throw new Error('connector definition creation failed');
  return ConnectorDefinitionSchema.parse({
    id: row.id,
    key: row.connector_key,
    name: row.name,
    description: row.description,
    capabilities: row.capabilities,
    inputSchema: row.input_schema,
    risk: row.risk,
    identityModes: row.identity_modes,
    resourceScopes: row.resource_scopes,
    enabled: row.enabled,
  });
}

export async function createConnectorBinding(
  context: RequestContext,
  input: unknown,
): Promise<ConnectorBinding> {
  const creation = CreateConnectorBindingInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, creation.workspaceId);
  const actor = requireAdmin(context, workspaceId);
  if (creation.identityMode === 'user' && creation.userId !== actor) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<
    {
      id: string;
      connector_id: string;
      identity_mode: ConnectorBinding['identityMode'];
      user_id: string | null;
      credential_reference: string;
      resource_scope: unknown;
      enabled: boolean;
      health_state: ConnectorBinding['healthState'];
      last_health_check_at: Date | null;
      health_detail: string | null;
    }[]
  >`
    insert into allrice_connector_bindings (
      organization_id, workspace_id, connector_id, identity_mode, user_id,
      credential_reference, resource_scope, created_by
    ) select
      ${context.organizationId}, ${workspaceId}, d.id,
      ${creation.identityMode}, ${creation.userId},
      ${creation.credentialReference}, ${sql.json(toJsonValue(creation.resourceScope))},
      ${actor}
    from allrice_connector_definitions d
    where d.id = ${creation.connectorId}
      and d.organization_id = ${context.organizationId}
      and d.workspace_id = ${workspaceId} and d.enabled
      and d.identity_modes ? ${creation.identityMode}
    returning id, connector_id, identity_mode, user_id,
      credential_reference, resource_scope, enabled, health_state,
      last_health_check_at, health_detail
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('authorization_denied');
  return ConnectorBindingSchema.parse({
    id: row.id,
    connectorId: row.connector_id,
    identityMode: row.identity_mode,
    userId: row.user_id,
    credentialReference: row.credential_reference,
    resourceScope: row.resource_scope,
    enabled: row.enabled,
    healthState: row.health_state,
    lastHealthCheckAt: row.last_health_check_at?.toISOString() ?? null,
    healthDetail: row.health_detail,
  });
}

export async function updateConnectorBindingHealth(
  context: RequestContext,
  input: unknown,
) {
  const update = UpdateConnectorBindingHealthInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actor = requireAdmin(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<
    {
      id: string;
      connector_id: string;
      identity_mode: ConnectorBinding['identityMode'];
      user_id: string | null;
      credential_reference: string;
      resource_scope: unknown;
      enabled: boolean;
      health_state: ConnectorBinding['healthState'];
      last_health_check_at: Date | null;
      health_detail: string | null;
    }[]
  >`
    update allrice_connector_bindings
    set health_state = ${update.state}, health_detail = ${update.detail},
        last_health_check_at = now()
    where id = ${update.bindingId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
    returning id, connector_id, identity_mode, user_id,
      credential_reference, resource_scope, enabled, health_state,
      last_health_check_at, health_detail
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${context.organizationId}, ${workspaceId}, ${actor},
      'connector.health.update', 'connector_binding', ${row.id},
      ${update.state === 'offline' ? 'degraded' : 'recorded'},
      ${update.detail ?? update.state}, ${context.requestId},
      ${sql.json({ state: update.state })}
    )
  `;
  return ConnectorBindingSchema.parse({
    id: row.id,
    connectorId: row.connector_id,
    identityMode: row.identity_mode,
    userId: row.user_id,
    credentialReference: row.credential_reference,
    resourceScope: row.resource_scope,
    enabled: row.enabled,
    healthState: row.health_state,
    lastHealthCheckAt: row.last_health_check_at?.toISOString() ?? null,
    healthDetail: row.health_detail,
  });
}

export interface ConnectorToolBinding {
  bindingId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredCapabilities: SkillCapability[];
  risk: ConnectorDefinition['risk'];
  identityMode: ConnectorBinding['identityMode'];
}

export async function listConnectorToolsForExecution(input: {
  context: ExecutionContext;
  grantedCapabilities: SkillCapability[];
  allowedIdentityModes: ('user' | 'service')[];
}): Promise<ConnectorToolBinding[]> {
  if (!input.context.workspaceId) return [];
  const sql = getDatabase();
  const rows = await sql<
    {
      binding_id: string;
      connector_key: string;
      name: string;
      description: string;
      input_schema: unknown;
      capabilities: SkillCapability[];
      risk: ConnectorDefinition['risk'];
      identity_mode: ConnectorBinding['identityMode'];
      user_id: string | null;
    }[]
  >`
    select b.id as binding_id, d.connector_key, d.name, d.description,
      d.input_schema, d.capabilities, d.risk, b.identity_mode, b.user_id
    from allrice_connector_bindings b
    join allrice_connector_definitions d on d.id = b.connector_id
    where b.organization_id = ${input.context.organizationId}
      and b.workspace_id = ${input.context.workspaceId}
      and b.enabled and d.enabled and b.health_state <> 'offline'
    order by d.connector_key, b.id
  `;
  return rows.flatMap((row) => {
    if (!input.allowedIdentityModes.includes(row.identity_mode)) return [];
    if (
      row.identity_mode === 'user' &&
      row.user_id !== input.context.policySnapshot.subjectId
    ) {
      return [];
    }
    if (
      !row.capabilities.every((capability) =>
        input.grantedCapabilities.includes(capability),
      )
    ) {
      return [];
    }
    return [
      {
        bindingId: row.binding_id,
        name: `connector.${row.connector_key}`,
        description: row.description,
        inputSchema: row.input_schema as Record<string, unknown>,
        requiredCapabilities: row.capabilities,
        risk: row.risk,
        identityMode: row.identity_mode,
      },
    ];
  });
}

export async function prepareConnectorCall(input: {
  context: ExecutionContext;
  request: unknown;
  grantedCapabilities: SkillCapability[];
  allowedIdentityModes: ('user' | 'service')[];
}): Promise<ConnectorCallDecision> {
  if (!input.context.workspaceId) throw new Error('workspace is required');
  const request = ConnectorCallRequestSchema.parse(input.request);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const rows = await transaction<
      {
        binding_id: string;
        identity_mode: ConnectorBinding['identityMode'];
        user_id: string | null;
        capabilities: SkillCapability[];
        risk: ConnectorDefinition['risk'];
      }[]
    >`
      select b.id as binding_id, b.identity_mode, b.user_id,
        d.capabilities, d.risk
      from allrice_connector_bindings b
      join allrice_connector_definitions d on d.id = b.connector_id
      where b.id = ${request.connectorBindingId}
        and b.organization_id = ${input.context.organizationId}
        and b.workspace_id = ${input.context.workspaceId}
        and b.enabled and d.enabled and b.health_state <> 'offline'
    `;
    const row = rows[0];
    const identityAllowed =
      row &&
      input.allowedIdentityModes.includes(row.identity_mode) &&
      (row.identity_mode === 'service' ||
        row.user_id === input.context.policySnapshot.subjectId);
    const capabilityAllowed =
      row &&
      row.capabilities.every((capability) =>
        input.grantedCapabilities.includes(capability),
      );
    if (!row || !identityAllowed || !capabilityAllowed) {
      throw new DataAccessError('authorization_denied');
    }
    const callId = randomUUID();
    const inputDigest = connectorInputDigest({
      operation: request.operation,
      input: request.input,
    });
    const requiresApproval = row.risk !== 'read_only';
    const approvalId = requiresApproval ? randomUUID() : null;
    if (approvalId) {
      await transaction`
        insert into allrice_approval_requests (
          id, organization_id, workspace_id, run_id, actor_id,
          resource_type, resource_id, action, input_digest
        ) values (
          ${approvalId}, ${input.context.organizationId},
          ${input.context.workspaceId}, ${input.context.runId},
          ${input.context.policySnapshot.subjectId}, 'connector_call',
          ${callId}, ${request.operation}, ${inputDigest}
        )
      `;
    }
    const status = requiresApproval ? 'waiting_approval' : 'allowed';
    await transaction`
      insert into allrice_connector_calls (
        id, organization_id, workspace_id, run_id, actor_id,
        connector_binding_id, operation, identity_mode, input_digest,
        approval_id, status, side_effect
      ) values (
        ${callId}, ${input.context.organizationId},
        ${input.context.workspaceId}, ${input.context.runId},
        ${input.context.policySnapshot.subjectId}, ${row.binding_id},
        ${request.operation}, ${row.identity_mode}, ${inputDigest},
        ${approvalId}, ${status}, ${requiresApproval}
      )
    `;
    if (requiresApproval) {
      const externalRisk =
        row.risk === 'external_send'
          ? 'external_send'
          : row.risk === 'high_risk_data'
            ? 'destructive'
            : 'managed_write';
      await transaction`
        insert into allrice_external_actions (
          id, organization_id, workspace_id, run_id, actor_id,
          connector_binding_id, action, risk, status, input_digest,
          approval_id, idempotency_key
        ) values (
          ${callId}, ${input.context.organizationId},
          ${input.context.workspaceId}, ${input.context.runId},
          ${input.context.policySnapshot.subjectId}, ${row.binding_id},
          ${request.operation}, ${externalRisk}, 'pending_approval',
          ${inputDigest}, ${approvalId}, ${`connector:${callId}`}
        )
      `;
    }
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, metadata
      ) values (
        ${input.context.organizationId}, ${input.context.workspaceId},
        ${input.context.policySnapshot.subjectId}, 'connector.prepare',
        'connector_call', ${callId},
        ${requiresApproval ? 'pending' : 'allowed'},
        ${requiresApproval ? 'approval_required_before_side_effect' : 'read_only_policy_allowed'},
        ${transaction.json({
          runId: input.context.runId,
          bindingId: row.binding_id,
          operation: request.operation,
          identityMode: row.identity_mode,
          inputDigest,
        })}
      )
    `;
    return ConnectorCallDecisionSchema.parse({
      callId,
      bindingId: row.binding_id,
      inputDigest,
      identityMode: row.identity_mode,
      risk: row.risk,
      status,
      approvalId,
    });
  });
}

export async function decideConnectorApproval(
  context: RequestContext,
  approvalIdInput: string,
  input: unknown,
) {
  const decision = DecideApprovalInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, decision.workspaceId);
  const actor = userId(context);
  const approvalId = UuidSchema.parse(approvalIdInput);
  const isAdmin = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actor &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId) &&
      membership.role === 'admin',
  );
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const rows = await transaction<{ actor_id: string; resource_id: string }[]>`
      select actor_id, resource_id from allrice_approval_requests
      where id = ${approvalId} and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and status = 'pending'
        and resource_type <> 'runtime_operation'
      for update
    `;
    const row = rows[0];
    if (!row || (row.actor_id !== actor && !isAdmin)) {
      throw new DataAccessError('authorization_denied');
    }
    await transaction`
      update allrice_approval_requests set
        status = ${decision.decision}, decided_by = ${actor}, decided_at = now(),
        decision_reason = ${decision.reason}
      where id = ${approvalId}
    `;
    await transaction`
      update allrice_connector_calls set
        status = ${decision.decision === 'approved' ? 'allowed' : 'denied'},
        completed_at = ${decision.decision === 'rejected' ? new Date() : null},
        error_code = ${decision.decision === 'rejected' ? 'APPROVAL_REJECTED' : null}
      where id = ${row.resource_id} and approval_id = ${approvalId}
    `;
    await transaction`
      update allrice_external_actions set
        status = ${decision.decision === 'approved' ? 'approved' : 'rejected'},
        completed_at = ${decision.decision === 'rejected' ? new Date() : null},
        error_code = ${decision.decision === 'rejected' ? 'APPROVAL_REJECTED' : null}
      where id = ${row.resource_id} and approval_id = ${approvalId}
    `;
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actor},
        'approval.decide', 'approval', ${approvalId},
        'recorded', ${decision.reason},
        ${transaction.json({ connectorCallId: row.resource_id, approvalDecision: decision.decision })}
      )
    `;
    return { id: approvalId, status: decision.decision };
  });
}

export async function getApprovedConnectorCallForExecution(input: {
  context: ExecutionContext;
  callId: string;
}) {
  if (!input.context.workspaceId) throw new Error('workspace is required');
  const sql = getDatabase();
  const rows = await sql<
    {
      id: string;
      connector_key: string;
      operation: string;
      identity_mode: ConnectorBinding['identityMode'];
      credential_reference: string;
      resource_scope: unknown;
      input_digest: string;
    }[]
  >`
    select c.id, d.connector_key, c.operation, c.identity_mode,
      b.credential_reference, b.resource_scope, c.input_digest
    from allrice_connector_calls c
    join allrice_connector_bindings b on b.id = c.connector_binding_id
    join allrice_connector_definitions d on d.id = b.connector_id
    left join allrice_approval_requests a on a.id = c.approval_id
    where c.id = ${UuidSchema.parse(input.callId)}
      and c.organization_id = ${input.context.organizationId}
      and c.workspace_id = ${input.context.workspaceId}
      and c.run_id = ${input.context.runId}
      and c.actor_id = ${input.context.policySnapshot.subjectId}
      and c.status = 'allowed' and b.enabled and d.enabled
      and b.health_state <> 'offline'
      and (c.approval_id is null or a.status = 'approved')
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('authorization_denied');
  await sql`
    update allrice_external_actions
    set status = 'executing', started_at = coalesce(started_at, now())
    where id = ${row.id} and status = 'approved'
  `;
  return {
    callId: row.id,
    connectorKey: row.connector_key,
    operation: row.operation,
    identityMode: row.identity_mode,
    credentialReference: row.credential_reference,
    resourceScope: row.resource_scope as Record<string, unknown>,
    inputDigest: row.input_digest,
  };
}

export async function completeConnectorCall(input: {
  context: ExecutionContext;
  callId: string;
  output?: unknown;
  errorCode?: string;
}) {
  if (!input.context.workspaceId) throw new Error('workspace is required');
  const outputDigest =
    input.output === undefined ? null : connectorInputDigest(input.output);
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    update allrice_connector_calls set
      status = ${input.errorCode ? 'failed' : 'succeeded'},
      output_digest = ${outputDigest}, error_code = ${input.errorCode ?? null},
      completed_at = now()
    where id = ${UuidSchema.parse(input.callId)}
      and organization_id = ${input.context.organizationId}
      and workspace_id = ${input.context.workspaceId}
      and run_id = ${input.context.runId}
      and actor_id = ${input.context.policySnapshot.subjectId}
      and status = 'allowed'
    returning id
  `;
  if (!rows[0]) throw new DataAccessError('authorization_denied');
  await sql`
    update allrice_external_actions
    set status = ${input.errorCode ? 'failed' : 'succeeded'},
        output_digest = ${outputDigest}, error_code = ${input.errorCode ?? null},
        completed_at = now()
    where id = ${input.callId} and status in ('approved', 'executing')
  `;
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, metadata
    ) values (
      ${input.context.organizationId}, ${input.context.workspaceId},
      ${input.context.policySnapshot.subjectId}, 'connector.complete',
      'connector_call', ${input.callId},
      ${input.errorCode ? 'failed' : 'succeeded'},
      ${input.errorCode ?? 'connector_transport_completed'},
      ${sql.json({ runId: input.context.runId, outputDigest })}
    )
  `;
}
