import { createHash, randomUUID } from 'node:crypto';

import {
  evaluateRuntimePolicy,
  PolicySnapshotSchema,
  matchesRuntimeActionApproval,
  matchesRuntimeInteractionResponse,
  RuntimeActionApprovalRequestSchema,
  RuntimeActionApprovalResponseSchema,
  RuntimeActionBindingSchema,
  runtimeContractEqual,
  RuntimePolicyControlsSchema,
  UuidSchema,
  McpError,
  type RequestContext,
  type RuntimeActionApprovalRequest,
  type RuntimeActionApprovalResponse,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import type postgres from 'postgres';

import { getDatabase } from './core/client.ts';
import { checkCloudBindingAuthority } from './cloud-authority.ts';
import { checkMcpBindingAuthority } from './mcp-authority.ts';
import { assertLocalMcpApprovalAuthority } from './local-mcp-connections.ts';
import {
  checkBrowserBindingAuthority,
  lockBrowserBindingOperations,
} from './browser-control-authority.ts';

type Transaction = postgres.TransactionSql;
type Database = ReturnType<typeof getDatabase>;
/** Device principals are not fabricated browser login sessions. */
export type RuntimePolicyPrincipal = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId' | 'requestId'
>;
export class RuntimePolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Canonical JSON only; callers must schema-parse before hashing. No secret values logged. */
export function runtimePolicyDigest(input: unknown): string {
  function canonical(value: unknown): string {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
      return JSON.stringify(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++)
        if (!Object.hasOwn(value, i))
          throw new RuntimePolicyError('non_json_binding');
      return `[${value.map(canonical).join(',')}]`;
    }
    if (
      value &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype
    )
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    throw new RuntimePolicyError('non_json_binding');
  }
  return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;
}

async function clock(transaction: Transaction) {
  const [row] = await transaction<
    { now: Date }[]
  >`select clock_timestamp() as now`;
  if (!row) throw new RuntimePolicyError('clock_unavailable');
  return row.now;
}

async function identity(
  transaction: Transaction,
  context: RuntimePolicyPrincipal,
  admin = false,
) {
  const ctx = context;
  UuidSchema.parse(ctx.organizationId);
  UuidSchema.parse(ctx.actor.id);
  UuidSchema.parse(ctx.requestId);
  UuidSchema.parse(ctx.workspaceId);
  if (ctx.actor.type !== 'user' || !ctx.workspaceId)
    throw new RuntimePolicyError('identity_denied');
  // Re-read authoritative rows: stale request membership snapshots do not grant access.
  const rows = await transaction<{ role: string }[]>`
    select membership.role from allrice_memberships membership
    join allrice_users actor on actor.id = membership.user_id
    join allrice_organizations organization on organization.id = membership.organization_id
    join allrice_workspaces workspace on workspace.id = ${ctx.workspaceId}
      and workspace.organization_id = organization.id
    where membership.organization_id = ${ctx.organizationId}
      and membership.user_id = ${ctx.actor.id} and membership.active
      and (membership.workspace_id is null or membership.workspace_id = ${ctx.workspaceId})
      and actor.status = 'active' and organization.archived_at is null
      and workspace.archived_at is null
    for share of membership, actor, organization, workspace
  `;
  if (
    !rows.some((row) =>
      admin ? row.role === 'admin' : ['admin', 'member'].includes(row.role),
    )
  )
    throw new RuntimePolicyError('membership_denied');
  return ctx;
}

async function controlsFor(
  transaction: Transaction,
  context: RuntimePolicyPrincipal,
) {
  const [row] = await transaction<{ version: number; controls: unknown }[]>`
    select version, controls from allrice_runtime_policy_controls
    where organization_id = ${context.organizationId} and workspace_id = ${context.workspaceId}
    for update
  `;
  const parsed = RuntimePolicyControlsSchema.safeParse(row?.controls);
  if (!parsed.success || parsed.data.version !== row?.version)
    throw new RuntimePolicyError('runtime_policy_missing_or_invalid');
  return parsed.data;
}

async function audit(
  transaction: Transaction,
  context: RuntimePolicyPrincipal,
  resourceId: string,
  action: string,
  reason: string,
  metadata: Record<string, string | number> = {},
) {
  await transaction`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type, resource_id,
      decision, reason, request_id, metadata
    ) values (${context.organizationId}, ${context.workspaceId}, ${context.actor.id},
      ${action}, 'runtime_operation', ${resourceId}, 'recorded', ${reason},
      ${context.requestId}, ${transaction.json(metadata)})
  `;
}

/** Admin service API. No HTTP policy-install endpoint and no seeded Allow policy in B1. */
export async function setRuntimePolicyControls(
  context: RequestContext,
  input: unknown,
  expectedVersion: number | null,
  database: Database = getDatabase(),
) {
  const controls = RuntimePolicyControlsSchema.parse(input);
  if ((expectedVersion === null ? 1 : expectedVersion + 1) !== controls.version)
    throw new RuntimePolicyError('policy_version_conflict');
  return database.begin(async (transaction) => {
    // Serializes initial insert as well as updates; this lock is never taken by dispatch.
    await transaction`select pg_advisory_xact_lock(hashtextextended(${`runtime-policy:${context.organizationId}:${context.workspaceId}`}, 0))`;
    const rows = await transaction<{ version: number }[]>`
      select version from allrice_runtime_policy_controls
      where organization_id = ${context.organizationId} and workspace_id = ${context.workspaceId} for update
    `;
    await identity(transaction, context, true);
    if ((rows[0]?.version ?? null) !== expectedVersion)
      throw new RuntimePolicyError('policy_version_conflict');
    await transaction`
      insert into allrice_runtime_policy_controls (organization_id, workspace_id, version, controls)
      values (${context.organizationId}, ${context.workspaceId}, ${controls.version}, ${transaction.json(controls)})
      on conflict (organization_id, workspace_id) do update
      set version = excluded.version, controls = excluded.controls, updated_at = clock_timestamp()
    `;
    await audit(
      transaction,
      context,
      context.workspaceId!,
      'runtime.policy.updated',
      'explicit_admin_policy',
      { version: controls.version },
    );
    return controls;
  });
}

type ApprovalRow = {
  id: string;
  runtime_request: unknown;
  runtime_response: unknown;
  runtime_binding_digest: string;
  runtime_control_version: number;
  runtime_consumed_at: Date | null;
  runtime_revoked_at: Date | null;
  runtime_expires_at: Date;
  status: string;
};

async function readApproval(
  transaction: Transaction,
  context: RequestContext,
  approvalId: string,
) {
  const [row] = await transaction<ApprovalRow[]>`
    select * from allrice_approval_requests where id = ${UuidSchema.parse(approvalId)}
      and organization_id = ${context.organizationId} and workspace_id = ${context.workspaceId}
      and resource_type = 'runtime_operation' for update
  `;
  if (!row) throw new RuntimePolicyError('approval_not_found');
  const request = RuntimeActionApprovalRequestSchema.parse(row.runtime_request);
  if (request.respondentId !== context.actor.id)
    throw new RuntimePolicyError('approval_actor_mismatch');
  return { row, request };
}

/** Binding must come from the registered server adapter, never an untrusted request body. */
async function checkBindingAuthority(
  transaction: Transaction,
  context: RuntimePolicyPrincipal,
  input: unknown,
) {
  const binding = RuntimeActionBindingSchema.parse(input);
  if (
    binding.task.scope.organizationId !== context.organizationId ||
    binding.task.scope.workspaceId !== context.workspaceId ||
    binding.requestedBy.type !== 'user' ||
    binding.requestedBy.id !== context.actor.id
  )
    throw new RuntimePolicyError('binding_scope_mismatch');
  const [run] = await transaction<
    {
      owner_id: string;
      policy_snapshot_id: string;
      execution_spec: unknown;
      state: string;
    }[]
  >`select owner_id, policy_snapshot_id, execution_spec, state from allrice_runs
    where id = ${binding.task.runId} and organization_id = ${context.organizationId}
      and workspace_id = ${context.workspaceId} for share`;
  if (
    !run ||
    run.owner_id !== context.actor.id ||
    !['queued', 'running', 'waiting_approval'].includes(run.state) ||
    run.policy_snapshot_id !== binding.policy.snapshotId ||
    runtimePolicyDigest(run.execution_spec) !==
      binding.task.frozenConfiguration.digest
  )
    throw new RuntimePolicyError('run_or_frozen_configuration_changed');
  const [snapshot] = await transaction<
    { payload: unknown; expires_at: Date; subject_id: string }[]
  >`
    select payload, expires_at, subject_id from allrice_policy_snapshots
    where id = ${binding.policy.snapshotId} and organization_id = ${context.organizationId} for share
  `;
  if (
    !snapshot ||
    snapshot.subject_id !== context.actor.id ||
    runtimePolicyDigest(snapshot.payload) !== binding.policy.digest ||
    snapshot.expires_at <= (await clock(transaction))
  )
    throw new RuntimePolicyError('frozen_policy_invalid');
  const payload = PolicySnapshotSchema.pick({
    memberships: true,
    grants: true,
  }).safeParse(snapshot.payload);
  if (
    !payload.success ||
    !payload.data.memberships.some(
      (membership) =>
        membership.active &&
        membership.userId === context.actor.id &&
        membership.organizationId === context.organizationId &&
        (membership.workspaceId === null ||
          membership.workspaceId === context.workspaceId) &&
        ['admin', 'member'].includes(membership.role),
    ) ||
    !payload.data.grants.some(
      (grant) =>
        grant.resourceType === 'job' &&
        grant.action === 'job:execute' &&
        (grant.workspaceId === null ||
          grant.workspaceId === context.workspaceId),
    )
  )
    throw new RuntimePolicyError('frozen_policy_permission_denied');
  const [target] = await transaction<{ kind: string; state: string }[]>`
    select kind, state from allrice_execution_targets where id = ${binding.execution.targetId}
      and organization_id = ${context.organizationId} and workspace_id = ${context.workspaceId} for share
  `;
  if (
    !target ||
    target.kind !== binding.execution.targetKind ||
    !['online', 'degraded'].includes(target.state)
  )
    throw new RuntimePolicyError('target_unavailable');
  if (
    binding.action === 'cloud.browser.act' ||
    binding.action === 'cloud.browser.observe' ||
    binding.action === 'local.browser.act' ||
    binding.action === 'local.browser.observe'
  ) {
    await checkBrowserBindingAuthority(transaction, context, binding);
    return { binding, policyExpiresAt: snapshot.expires_at };
  }
  if (binding.execution.targetKind === 'cloud_sandbox') {
    await checkCloudBindingAuthority(transaction, context, binding);
    return { binding, policyExpiresAt: snapshot.expires_at };
  }
  if (binding.execution.targetKind === 'cloud_mcp') {
    await checkMcpBindingAuthority(transaction, context, binding);
    return { binding, policyExpiresAt: snapshot.expires_at };
  }
  // Existing Bridge authority remains separate from cloud data transfer scopes.
  if (
    binding.execution.targetKind !== 'rice_bridge' ||
    binding.dataScope.length > 0 ||
    binding.baseline.length > 0
  )
    throw new RuntimePolicyError('resource_adapter_not_registered');
  const [grant] = await transaction<
    {
      root_fingerprint: string;
      runtime_generation: number;
      revoked_at: Date | null;
      device_revoked: Date | null;
    }[]
  >`
    select folder.root_fingerprint, folder.runtime_generation, folder.revoked_at, device.revoked_at as device_revoked
    from allrice_bridge_devices device join allrice_bridge_folder_grants folder on folder.device_id = device.id
    where folder.id = ${binding.execution.grantId} and device.id = ${binding.execution.deviceId}
      and folder.organization_id = ${context.organizationId} and folder.workspace_id = ${context.workspaceId}
      and device.organization_id = ${context.organizationId} and device.workspace_id = ${context.workspaceId}
      and folder.owner_id = ${context.actor.id} and device.owner_id = ${context.actor.id}
    for share of device, folder
  `;
  if (
    !grant ||
    grant.revoked_at ||
    grant.device_revoked ||
    binding.execution.grantVersion !== grant.runtime_generation ||
    binding.execution.scopeDigest !== `sha256:${grant.root_fingerprint}`
  )
    throw new RuntimePolicyError('grant_revoked_or_changed');
  return { binding, policyExpiresAt: snapshot.expires_at };
}

async function checkBinding(
  transaction: Transaction,
  context: RuntimePolicyPrincipal,
  input: unknown,
  resolveCurrentBinding: RuntimePolicyOptions['resolveCurrentBinding'],
) {
  const { binding, policyExpiresAt } = await checkBindingAuthority(
    transaction,
    context,
    input,
  );
  if (typeof resolveCurrentBinding !== 'function')
    throw new RuntimePolicyError('execution_adapter_missing');
  const current = RuntimeActionBindingSchema.parse(
    await resolveCurrentBinding({ transaction, binding }),
  );
  if (!runtimeContractEqual(binding, current))
    throw new RuntimePolicyError('execution_binding_changed');
  if (policyExpiresAt <= (await clock(transaction)))
    throw new RuntimePolicyError('frozen_policy_invalid');
  return { binding, policyExpiresAt };
}

export type RuntimePolicyOptions = {
  context: RuntimePolicyPrincipal;
  /** Server-owned adapter must resolve current command, baseline and target facts in this transaction.
   * Echoing the request binding is NOT a valid production implementation. Missing adapter fails closed.
   */
  resolveCurrentBinding: (input: {
    transaction: Transaction;
    binding: RuntimeActionBinding;
  }) => Promise<RuntimeActionBinding>;
  platformDeniedActions?: readonly string[];
};

export function createRuntimePolicyAdmission(options: RuntimePolicyOptions) {
  return async (input: {
    transaction: Transaction;
    binding: RuntimeActionBinding;
    phase: 'create' | 'dispatch' | 'heartbeat';
    now: Date;
  }): Promise<void | { status: 'waiting_user' }> => {
    const { transaction } = input;
    await lockBrowserBindingOperations(
      transaction,
      options.context,
      input.binding,
    );
    const controls = await controlsFor(transaction, options.context);
    await identity(transaction, options.context);
    const { binding, policyExpiresAt } = await checkBinding(
      transaction,
      options.context,
      input.binding,
      options.resolveCurrentBinding,
    );
    const decision = evaluateRuntimePolicy(
      controls,
      binding,
      options.platformDeniedActions,
    );
    if (decision.effect === 'deny')
      throw new RuntimePolicyError(decision.reason);
    const digest = runtimePolicyDigest(binding);
    const rows = await transaction<ApprovalRow[]>`
      select * from allrice_approval_requests where organization_id = ${options.context.organizationId}
        and workspace_id = ${options.context.workspaceId} and resource_type = 'runtime_operation'
        and resource_id = ${binding.attempt.operationId} for update
    `;
    if (
      rows.length > 1 ||
      (rows[0] && rows[0].runtime_binding_digest !== digest)
    )
      throw new RuntimePolicyError('approval_binding_mismatch');
    const row = rows[0];
    const now = await clock(transaction);
    if (policyExpiresAt <= now)
      throw new RuntimePolicyError('frozen_policy_invalid');
    if (!row) {
      if (decision.effect === 'allow') return;
      if (input.phase === 'create') return { status: 'waiting_user' };
      throw new RuntimePolicyError('approval_required');
    }
    // An administrator's later Allow does not erase this operation's old
    // rejection/revocation/expiry. Replanning requires a new operation identity.
    const request = RuntimeActionApprovalRequestSchema.parse(
      row.runtime_request,
    );
    if (
      row.runtime_revoked_at ||
      row.runtime_control_version !== controls.version ||
      row.runtime_expires_at <= now ||
      row.status !== 'approved' ||
      !runtimeContractEqual(request.binding, binding)
    ) {
      if (
        input.phase === 'create' &&
        decision.effect === 'ask' &&
        row.status === 'pending' &&
        row.runtime_control_version === controls.version &&
        runtimeContractEqual(request.binding, binding) &&
        !row.runtime_revoked_at &&
        row.runtime_expires_at > now
      )
        return { status: 'waiting_user' };
      throw new RuntimePolicyError('approval_invalid_or_stale');
    }
    // Renew/start checks cannot consume twice, but must still match the consumed exact approval.
    const snapshot = {
      request,
      response: row.runtime_response,
      consumedAt: null,
      revokedAt: null,
    };
    if (
      !matchesRuntimeActionApproval(snapshot, {
        trustedScope: binding.task.scope,
        task: binding.task,
        respondentId: options.context.actor.id,
        activeTurn: null,
        now: now.toISOString(),
        binding,
      })
    )
      throw new RuntimePolicyError('approval_binding_mismatch');
    if (input.phase === 'heartbeat') {
      if (!row.runtime_consumed_at)
        throw new RuntimePolicyError('approval_not_consumed');
      return;
    }
    if (row.runtime_consumed_at)
      throw new RuntimePolicyError('approval_already_consumed');
    if (input.phase === 'create') return;
    await transaction`update allrice_approval_requests set runtime_consumed_at = ${now} where id = ${row.id}`;
    await audit(
      transaction,
      options.context,
      binding.attempt.operationId,
      'runtime.approval.consumed',
      'exact_binding',
      { approvalId: row.id, digest },
    );
    const completedAt = await clock(transaction);
    if (policyExpiresAt <= completedAt)
      throw new RuntimePolicyError('frozen_policy_invalid');
    if (row.runtime_expires_at <= completedAt)
      throw new RuntimePolicyError('approval_invalid_or_stale');
  };
}

export async function requestRuntimeActionApproval(
  options: RuntimePolicyOptions,
  bindingInput: unknown,
  lifetimeMs = 600_000,
  database: Database = getDatabase(),
): Promise<RuntimeActionApprovalRequest> {
  if (
    !Number.isInteger(lifetimeMs) ||
    lifetimeMs < 1_000 ||
    lifetimeMs > 3_600_000
  )
    throw new RuntimePolicyError('approval_lifetime_invalid');
  return database.begin(async (transaction) => {
    await lockBrowserBindingOperations(
      transaction,
      options.context,
      bindingInput,
    );
    const controls = await controlsFor(transaction, options.context);
    await identity(transaction, options.context);
    const { binding, policyExpiresAt } = await checkBinding(
      transaction,
      options.context,
      bindingInput,
      options.resolveCurrentBinding,
    );
    const decision = evaluateRuntimePolicy(
      controls,
      binding,
      options.platformDeniedActions,
    );
    if (decision.effect !== 'ask')
      throw new RuntimePolicyError('approval_not_applicable');
    const digest = runtimePolicyDigest(binding);
    const existingRows = await transaction<ApprovalRow[]>`
      select * from allrice_approval_requests where organization_id = ${options.context.organizationId}
        and workspace_id = ${options.context.workspaceId} and resource_type = 'runtime_operation'
        and resource_id = ${binding.attempt.operationId} for update
    `;
    if (
      existingRows.length > 1 ||
      (existingRows[0] && existingRows[0].runtime_binding_digest !== digest)
    )
      throw new RuntimePolicyError('approval_binding_mismatch');
    const existing = existingRows[0];
    if (existing)
      return RuntimeActionApprovalRequestSchema.parse(existing.runtime_request);
    const now = await clock(transaction);
    if (policyExpiresAt <= now)
      throw new RuntimePolicyError('frozen_policy_invalid');
    const request = RuntimeActionApprovalRequestSchema.parse({
      contractVersion: 1,
      direction: 'request',
      kind: 'action_approval',
      requestId: randomUUID(),
      version: 1,
      requestDigest: digest,
      task: binding.task,
      respondentId: options.context.actor.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
      approvalId: randomUUID(),
      binding,
    });
    await transaction`
      insert into allrice_approval_requests (id, organization_id, workspace_id, run_id, actor_id,
        resource_type, resource_id, action, input_digest, requested_at, runtime_request,
        runtime_binding_digest, runtime_control_version, runtime_expires_at)
      values (${request.approvalId}, ${options.context.organizationId}, ${options.context.workspaceId},
        ${binding.task.runId}, ${options.context.actor.id}, 'runtime_operation', ${binding.attempt.operationId},
        ${binding.action}, ${binding.inputDigest}, ${now}, ${transaction.json(request)},
        ${digest}, ${controls.version}, ${request.expiresAt})
    `;
    await audit(
      transaction,
      options.context,
      binding.attempt.operationId,
      'runtime.approval.requested',
      'exact_binding',
      { approvalId: request.approvalId, digest },
    );
    const completedAt = await clock(transaction);
    if (policyExpiresAt <= completedAt)
      throw new RuntimePolicyError('frozen_policy_invalid');
    if (Date.parse(request.expiresAt) <= completedAt.getTime())
      throw new RuntimePolicyError('approval_invalid_or_stale');
    return request;
  }) as Promise<RuntimeActionApprovalRequest>;
}

export async function getRuntimeActionApproval(
  context: RequestContext,
  approvalId: string,
  database: Database = getDatabase(),
) {
  return database.begin(async (transaction) => {
    await identity(transaction, context);
    const { row, request } = await readApproval(
      transaction,
      context,
      approvalId,
    );
    return {
      request,
      response: row.runtime_response,
      consumedAt: row.runtime_consumed_at?.toISOString() ?? null,
      revokedAt: row.runtime_revoked_at?.toISOString() ?? null,
    };
  });
}

export async function decideRuntimeActionApproval(
  context: RequestContext,
  approvalId: string,
  input: unknown,
  database: Database = getDatabase(),
) {
  const submitted = RuntimeActionApprovalResponseSchema.parse(input);
  return database.begin(async (transaction) => {
    // Discover an already stored approval in the authenticated owner scope;
    // do not use the submitted response to select a root. Re-read/validate the
    // approval below after taking root→operations→controls→approval locks.
    const [registered] = await transaction<{ runtime_request: unknown }[]>`
      select runtime_request from allrice_approval_requests where id=${UuidSchema.parse(approvalId)}
        and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
        and resource_type='runtime_operation' and runtime_request->>'respondentId'=${context.actor.id}`;
    if (!registered) throw new RuntimePolicyError('approval_not_found');
    const discovered = RuntimeActionApprovalRequestSchema.parse(
      registered.runtime_request,
    );
    await lockBrowserBindingOperations(
      transaction,
      context,
      discovered.binding,
    );
    const controls = await controlsFor(transaction, context);
    await identity(transaction, context);
    const { row, request } = await readApproval(
      transaction,
      context,
      approvalId,
    );
    if (!runtimeContractEqual(request, discovered))
      throw new RuntimePolicyError('approval_binding_mismatch');
    const now = await clock(transaction);
    // Browser/device clocks are not authorization clocks. Stamp the accepted
    // response using PostgreSQL, just like request expiry and decided_at. For
    // retries preserve the first accepted timestamp, then compare every other
    // identity/decision field exactly; retrying never extends the approval.
    const response = {
      ...submitted,
      respondedAt:
        row.runtime_response === null
          ? now.toISOString()
          : RuntimeActionApprovalResponseSchema.parse(row.runtime_response)
              .respondedAt,
    };
    if (
      !matchesRuntimeInteractionResponse(request, response, {
        trustedScope: request.task.scope,
        task: request.task,
        respondentId: context.actor.id,
        activeTurn: null,
        now: now.toISOString(),
      })
    )
      throw new RuntimePolicyError('approval_response_mismatch');
    if (
      row.runtime_control_version !== controls.version ||
      row.runtime_revoked_at ||
      row.runtime_expires_at <= now
    )
      throw new RuntimePolicyError('approval_invalid_or_stale');
    if (row.runtime_response !== null) {
      if (!runtimeContractEqual(row.runtime_response, response))
        throw new RuntimePolicyError('approval_response_conflict');
      return response; // Exact response retry is acknowledged, NEVER consumes or dispatches.
    }
    if (row.status !== 'pending')
      throw new RuntimePolicyError('approval_not_pending');
    let policyExpiresAt: Date | null = null;
    if (response.decision === 'approved') {
      if (evaluateRuntimePolicy(controls, request.binding).effect === 'deny')
        throw new RuntimePolicyError('policy_denied');
      const authority = await checkBindingAuthority(
        transaction,
        context,
        request.binding,
      );
      policyExpiresAt = authority.policyExpiresAt;
      if (
        ['local.mcp.discover', 'local.mcp.call'].includes(
          request.binding.action,
        )
      ) {
        try {
          await assertLocalMcpApprovalAuthority(
            transaction,
            {
              organizationId: context.organizationId,
              workspaceId: request.task.scope.workspaceId,
              actorId: context.actor.id,
            },
            request.binding,
          );
        } catch (error) {
          if (error instanceof McpError)
            throw new RuntimePolicyError('local_mcp_authority_changed');
          throw error;
        }
      }
      const decidedAt = await clock(transaction);
      if (
        authority.policyExpiresAt <= decidedAt ||
        row.runtime_expires_at <= decidedAt
      )
        throw new RuntimePolicyError('approval_invalid_or_stale');
    }
    await transaction`update allrice_approval_requests set status = ${response.decision},
      decided_by = ${context.actor.id}, decided_at = ${now}, runtime_response = ${transaction.json(response)}
      where id = ${row.id}`;
    await audit(
      transaction,
      context,
      request.binding.attempt.operationId,
      'runtime.approval.decided',
      response.decision,
      { approvalId: row.id },
    );
    const completedAt = await clock(transaction);
    if (
      (policyExpiresAt && policyExpiresAt <= completedAt) ||
      row.runtime_expires_at <= completedAt
    )
      throw new RuntimePolicyError('approval_invalid_or_stale');
    return response;
  }) as Promise<RuntimeActionApprovalResponse>;
}

export async function revokeRuntimeActionApproval(
  context: RequestContext,
  approvalId: string,
  database: Database = getDatabase(),
) {
  return database.begin(async (transaction) => {
    await controlsFor(transaction, context);
    await identity(transaction, context);
    const { row, request } = await readApproval(
      transaction,
      context,
      approvalId,
    );
    if (!row.runtime_revoked_at) {
      await transaction`update allrice_approval_requests set runtime_revoked_at = clock_timestamp() where id = ${row.id}`;
      await audit(
        transaction,
        context,
        request.binding.attempt.operationId,
        'runtime.approval.revoked',
        'stop_future_admission',
        { approvalId: row.id },
      );
    }
    return { revoked: true, executionStopped: false }; // Device/OS stop requires later receipt evidence.
  });
}
