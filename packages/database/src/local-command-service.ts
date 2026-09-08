import { createHash, randomUUID } from 'node:crypto';

import {
  BridgeDeviceSchema,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandProfileSchema,
  RuntimeLocalCommandToolInputSchema,
  RuntimeActionApprovalRequestSchema,
  UuidSchema,
  type RequestContext,
  type ExecutionContext,
  type RuntimeOperationSnapshot,
} from '@allrice/contracts';

import { getDatabase } from './core/client.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  localCommandBinding,
  localCommandEnabled,
} from './local-command-profile.ts';
import {
  RuntimePolicyError,
  requestRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import {
  readLocalService,
  localServiceFeatureEnabled,
} from './local-service-runtime.ts';

type Database = ReturnType<typeof getDatabase>;
// Stable identities support concurrent delivery of one tool call. A changed
// payload is still an idempotency conflict, never a new implicitly approved run.
function id(key: string) {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const localCommandFeatureEnabled = () =>
  localCommandEnabled() &&
  process.env.ALLRICE_RUNTIME_POLICY_ENABLED === '1' &&
  process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1';

/** Trusted Worker entry point. No browser-supplied binding, device or image. */
export async function createLocalCommandOperation(
  input: {
    context: ExecutionContext;
    arguments: unknown;
    callId: string;
  },
  database: Database = getDatabase(),
) {
  if (!localCommandFeatureEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const args = RuntimeLocalCommandToolInputSchema.parse(input.arguments);
  if (args.background && !localServiceFeatureEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const ctx = input.context;
  const owner = ctx.policySnapshot.subjectId;
  UuidSchema.parse(ctx.runId);
  UuidSchema.parse(ctx.workspaceId);
  if (!input.callId || input.callId.length > 255)
    throw new RuntimePolicyError('invalid_tool_call');
  const [row] = await database<
    {
      execution_spec: Record<string, unknown>;
      policy_snapshot_id: string;
      payload: unknown;
      employee_version_id: string;
      session_id: string;
      thread_generation: number;
      timeout_at: Date;
    }[]
  >`select r.execution_spec,r.policy_snapshot_id,p.payload,e.employee_version_id,e.session_id,c.thread_generation,j.timeout_at
    from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_jobs j on j.run_id=r.id and j.id=${ctx.jobId}
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id and c.active_run_id=r.id and c.state='running'
    where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner}
      and r.state='running' and j.status='running' and j.worker_id=${ctx.worker.id} and j.lease_expires_at>clock_timestamp()
      and j.cancel_requested_at is null and j.timeout_at>clock_timestamp()`;
  if (!row || row.policy_snapshot_id !== ctx.policySnapshot.id)
    throw new RuntimePolicyError('run_or_frozen_configuration_changed');
  const [target] = await database<
    {
      device: unknown;
      target_id: string;
      grant_id: string;
      root_fingerprint: string;
      runtime_generation: number;
      label: string;
      profile: unknown;
    }[]
  >`select json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,
      'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online',
      'lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device,
      t.id as target_id,g.id as grant_id,g.root_fingerprint,g.runtime_generation,g.label,p.profile
    from allrice_bridge_devices d
    join allrice_bridge_runtime_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
    join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id and t.target_key='bridge.'||d.id::text and t.kind='rice_bridge' and t.state='online'
    join lateral (select * from allrice_bridge_folder_grants where device_id=d.id and organization_id=d.organization_id and workspace_id=d.workspace_id and owner_id=d.owner_id and revoked_at is null order by created_at desc limit 1) g on true
    where d.organization_id=${ctx.organizationId} and d.workspace_id=${ctx.workspaceId} and d.owner_id=${owner} and d.revoked_at is null
      and d.platform='macos-x64' and d.last_seen_at>clock_timestamp()-interval '90 seconds' and p.reported_at>clock_timestamp()-interval '90 seconds'
    order by d.last_seen_at desc limit 1`;
  if (!target) throw new RuntimePolicyError('local_runner_unavailable');
  const device = BridgeDeviceSchema.parse(target.device);
  const profile = RuntimeLocalCommandProfileSchema.parse(target.profile);
  if (!profile.available)
    throw new RuntimePolicyError('local_runner_unavailable');
  if (args.diagnostics && !profile.features?.includes('project_diagnostics'))
    throw new RuntimePolicyError('local_runner_upgrade_required');
  if (args.dependencies && !profile.features?.includes('npm_dependencies'))
    throw new RuntimePolicyError('local_runner_upgrade_required');
  if (args.background && !profile.features?.includes('background_services'))
    throw new RuntimePolicyError('local_runner_upgrade_required');
  const payload = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      ...args,
      imageDigest: profile.imageDigest,
      isolation: profile.backend,
      network: 'none',
    },
  });
  const key = `local-command:${ctx.runId}:${input.callId}`;
  const operationId = id(key);
  const task = {
    scope: {
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      projectId: null,
    },
    runId: ctx.runId,
    rootRunId: ctx.runId,
    parentRunId: null,
    chatSessionId: row.session_id,
    frozenConfiguration: {
      employeeVersionId: row.employee_version_id,
      digest: digest(row.execution_spec),
    },
  };
  const binding = RuntimeActionBindingSchema.parse({
    task,
    attempt: {
      operationId,
      attemptId: id(`${key}:attempt`),
      attemptNumber: 1,
      generation: row.thread_generation,
      fence: 1,
    },
    requestedBy: { type: 'user', id: owner },
    policy: { snapshotId: row.policy_snapshot_id, digest: digest(row.payload) },
    execution: {
      targetId: target.target_id,
      targetKind: 'rice_bridge',
      deviceId: device.id,
      grantId: target.grant_id,
      grantVersion: target.runtime_generation,
      scopeDigest: `sha256:${target.root_fingerprint}`,
      workCopy: { id: operationId, kind: 'local_copy' },
    },
    action: payload.capability,
    inputDigest: digest(payload),
    command: localCommandBinding(payload),
    baseline: [],
    dataScope: [],
  });
  const ledger = createGovernedBridgeOperationLedger(device, {
    database,
    initialOperation: { binding, payload },
  });
  await ledger.createRoot({
    task: binding.task,
    deadlineAt: row.timeout_at.toISOString(),
    budgets: [
      {
        metric: 'tool_calls',
        unit: 'calls',
        currency: null,
        capacity: 32,
        source: { kind: 'worker', sourceId: 'local-command-v1' },
      },
    ],
  });
  const snapshot = await ledger.createOperation({
    snapshot: RuntimeOperationSnapshotSchema.parse({
      contractVersion: 1,
      binding,
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: id(`${key}:delivery`),
      status: 'planned',
      result: null,
    }),
    bridgePayload: payload,
    reservations: [
      { metric: 'tool_calls', accountingId: id(`${key}:meter`), amount: 1 },
    ],
  });
  if (snapshot.status === 'waiting_user')
    await requestRuntimeActionApproval(
      ledger.policyOptions,
      binding,
      600_000,
      database,
    );
  return {
    snapshot,
    workspaceLabel: target.label,
    deadlineAt: row.timeout_at.toISOString(),
    ledger,
  };
}

/** Authoritative membership and owner checks shared by browser read/cancel. */
export async function ownedLocalCommandRun(
  database: Database,
  context: Pick<RequestContext, 'organizationId' | 'workspaceId' | 'actor'>,
  runId: string,
) {
  UuidSchema.parse(runId);
  if (context.actor.type !== 'user' || !context.workspaceId)
    throw new RuntimePolicyError('identity_denied');
  const [row] = await database<{ id: string }[]>`select r.id from allrice_runs r
    join allrice_users u on u.id=r.owner_id and u.status='active'
    join allrice_organizations o on o.id=r.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=r.workspace_id and w.organization_id=r.organization_id and w.archived_at is null
    where r.id=${runId} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId} and r.owner_id=${context.actor.id}
      and exists (select 1 from allrice_memberships m where m.organization_id=r.organization_id and m.user_id=r.owner_id and m.active
        and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.role in ('admin','member'))`;
  if (!row) throw new RuntimePolicyError('operation_not_found');
}

export async function listLocalCommandOperations(
  context: RequestContext,
  runId: string,
  database: Database = getDatabase(),
) {
  await ownedLocalCommandRun(database, context, runId);
  const rows = await database<
    {
      id: string;
      snapshot: unknown;
      bridge_payload: unknown;
      runtime_request: unknown;
      runtime_response: unknown;
      runtime_revoked_at: Date | null;
      runtime_consumed_at: Date | null;
    }[]
  >`
    select op.id,op.snapshot,op.bridge_payload,a.runtime_request,a.runtime_response,a.runtime_revoked_at,a.runtime_consumed_at
    from allrice_runtime_operations op left join allrice_approval_requests a on a.resource_id=op.id and a.resource_type='runtime_operation' and a.organization_id=op.organization_id and a.workspace_id=op.workspace_id and a.actor_id=${context.actor.id}
    where op.run_id=${runId} and op.organization_id=${context.organizationId} and op.workspace_id=${context.workspaceId}
      and op.bridge_payload->>'capability'='local.process.execute' order by op.created_at limit 32`;
  return Promise.all(
    rows.map(async (row) => {
      const output = await database<
        { sequence: number; stream: 'stdout' | 'stderr'; content: string }[]
      >`select sequence,stream,content from allrice_runtime_operation_output where operation_id=${row.id} order by sequence`;
      const [receipt] = await database<
        { evidence: unknown }[]
      >`select payload->'evidence' as evidence from allrice_runtime_operation_receipts
      where operation_id=${row.id} and disposition='applied' and payload->'signal'->>'type' in ('operation.outcome','operation.stopped') order by received_at desc limit 1`;
      return {
        snapshot: RuntimeOperationSnapshotSchema.parse(row.snapshot),
        command: RuntimeLocalCommandSchema.parse(row.bridge_payload).arguments,
        approval: row.runtime_request
          ? {
              request: RuntimeActionApprovalRequestSchema.parse(
                row.runtime_request,
              ),
              response: row.runtime_response,
              revokedAt: row.runtime_revoked_at?.toISOString() ?? null,
              consumedAt: row.runtime_consumed_at?.toISOString() ?? null,
            }
          : null,
        output,
        evidence: receipt?.evidence ?? null,
        service: localServiceFeatureEnabled()
          ? await readLocalService(row.id, database)
          : null,
      };
    }),
  );
}

export async function cancelLocalCommandRun(
  context: RequestContext,
  runId: string,
  database: Database = getDatabase(),
) {
  await ownedLocalCommandRun(database, context, runId);
  // This ledger instance can record cancellation intent only; its execution admission always denies.
  const { createRuntimeOperationLedger } =
    await import('./runtime-ledger/index.ts');
  return createRuntimeOperationLedger({
    database,
    admission: async () => {
      throw new RuntimePolicyError('identity_denied');
    },
  }).cancelRoot(
    {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId!,
      projectId: null,
    },
    runId,
    randomUUID(),
  );
}

export async function waitLocalCommandOperation(
  created: Awaited<ReturnType<typeof createLocalCommandOperation>>,
  signal?: AbortSignal,
  database: Database = getDatabase(),
) {
  const scope = created.snapshot.binding.task.scope,
    operationId = created.snapshot.binding.attempt.operationId;
  let canceled = false;
  const cancel = async () => {
    if (!canceled) {
      canceled = true;
      await created.ledger.cancelRoot(
        scope,
        created.snapshot.binding.task.rootRunId,
        randomUUID(),
      );
    }
  };
  while (Date.now() < Date.parse(created.deadlineAt)) {
    if (signal?.aborted) await cancel();
    await created.ledger.expireLeases(
      scope,
      created.snapshot.binding.task.rootRunId,
    );
    const snapshot: RuntimeOperationSnapshot =
      await created.ledger.readOperation(scope, operationId);
    if (
      !canceled &&
      snapshot.status === 'running' &&
      localServiceFeatureEnabled()
    ) {
      const service = await readLocalService(operationId, database);
      if (
        service &&
        service.ready &&
        ['ready', 'waiting_input'].includes(service.state) &&
        Date.parse(service.hardDeadlineAt) > Date.now()
      )
        return {
          operationId,
          status: 'service_ready',
          evidence: {
            summary:
              '有限后台服务已启动；端口仅隔离容器内部可达，Run结束或到期将停止',
            output: service,
          },
        };
    }
    if (
      ['succeeded', 'failed', 'canceled', 'partial', 'unknown'].includes(
        snapshot.status,
      )
    ) {
      const [receipt] = await database<
        { evidence: unknown }[]
      >`select payload->'evidence' as evidence from allrice_runtime_operation_receipts
        where operation_id=${operationId} and disposition='applied' and payload->'signal'->>'type' in ('operation.outcome','operation.stopped') order by received_at desc limit 1`;
      return {
        operationId,
        status: snapshot.status,
        evidence: receipt?.evidence ?? null,
      };
    }
    const [approval] = await database<
      { status: string; expired: boolean; revoked: boolean }[]
    >`select status,runtime_expires_at<=clock_timestamp() as expired,runtime_revoked_at is not null as revoked
      from allrice_approval_requests where resource_id=${operationId} and resource_type='runtime_operation'
        and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}`;
    if (
      approval &&
      (approval.status === 'rejected' || approval.expired || approval.revoked)
    )
      await cancel();
    if (
      canceled &&
      ['planned', 'waiting_user', 'ready', 'cancel_requested'].includes(
        snapshot.status,
      )
    ) {
      // A cancellation request alone cannot prove a previously dispatched process stopped.
      return { operationId, status: snapshot.status, evidence: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await cancel();
  return { operationId, status: 'cancel_requested', evidence: null };
}
