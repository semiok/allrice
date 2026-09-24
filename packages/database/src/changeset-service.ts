import { runtimeFeatureEnabled } from '@allrice/contracts';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  ChangesetActionInputSchema,
  ChangesetExecutionResultSchema,
  RuntimeChangesetSchema,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  RuntimeActionApprovalRequestSchema,
  BridgeDeviceSchema,
  EmployeeExecutionSnapshotSchema,
  runtimeContractEqual,
  type ChangesetActionInput,
  type ExecutionContext,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  ArtifactReviewError,
  assertWorkbenchSession,
  readArtifact,
  readArtifactBytes,
  parseChangesetBytes,
  type WorkbenchPrincipal,
} from './artifact-review.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  requestRuntimeActionApproval,
} from './runtime-policy.ts';

type Database = ReturnType<typeof getDatabase>;
export const changesetFeatureEnabled = () =>
  runtimeFeatureEnabled('ALLRICE_CHANGESET_ENABLED') &&
  runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED') &&
  runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED') &&
  runtimeFeatureEnabled('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED');
function fail(code: string): never {
  throw new ArtifactReviewError(code);
}
const id = (key: string) => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const changesetOperationId = (runId: string) => id(`changeset:${runId}`);

/** Session lock belongs to the caller's message/Run transaction. Never accepts file bytes from the browser. */
export async function prepareChangesetAction(
  tx: TransactionSql,
  context: WorkbenchPrincipal,
  sessionId: string,
  raw: ChangesetActionInput,
) {
  if (!changesetFeatureEnabled()) fail('changeset_disabled');
  const action = ChangesetActionInputSchema.parse(raw);
  await assertWorkbenchSession(tx, context, sessionId, true);
  const artifact = await readArtifact(
    tx,
    context,
    sessionId,
    action.artifactId,
  );
  if (
    artifact.kind !== 'changeset' ||
    !artifact.execution ||
    artifact.object.checksum !== action.checksum ||
    (!action.restoreOf && artifact.stale)
  )
    fail('version_conflict');
  if (action.restoreOf) {
    const [source] = await tx<
      {
        artifact_id: string;
        checksum: string;
        restore_of: string | null;
        state: string;
      }[]
    >`
      select c.artifact_id,c.checksum,c.restore_of,r.state from allrice_changeset_runs c join allrice_runs r on r.id=c.run_id
      where c.run_id=${action.restoreOf} and c.organization_id=${context.organizationId} and c.workspace_id=${context.workspaceId!}
        and c.session_id=${sessionId} and c.actor_id=${context.actor.id}`;
    if (
      !source ||
      source.restore_of ||
      source.artifact_id !== artifact.id ||
      source.checksum !== action.checksum ||
      !['succeeded', 'failed', 'canceled'].includes(source.state)
    )
      fail('restore_unavailable');
  }
  return {
    artifact,
    text: `${action.restoreOf ? '请求恢复这次执行中已确认落盘的文件；不会触碰结果未知的文件。' : '请求应用已审查的文件变更。'}\n尚未授权执行，需在精确动作卡片中批准。\n工件：${artifact.version.fileName} v${artifact.version.version}\nArtifact: ${artifact.id}\nChecksum: ${action.checksum}${action.restoreOf ? `\n恢复来源 Run: ${action.restoreOf}` : ''}`,
  };
}

export async function readChangesetEvidence(
  db: Database | TransactionSql,
  context: WorkbenchPrincipal,
  runId: string,
) {
  const [row] = await db<{ evidence: unknown }[]>`
    select payload->'evidence' as evidence from allrice_runtime_operation_receipts p
    join allrice_runtime_operations o on o.id=p.operation_id
    join allrice_changeset_runs c on c.run_id=o.run_id and c.actor_id=${context.actor.id}
      and c.organization_id=o.organization_id and c.workspace_id=o.workspace_id
    where o.id=${changesetOperationId(runId)} and o.organization_id=${context.organizationId} and o.workspace_id=${context.workspaceId!}
      and p.disposition<>'conflict' and p.payload->'attempt'=o.snapshot->'binding'->'attempt'
      and p.payload->'evidence'->'output'->>'contractVersion'='1' order by p.received_at desc,p.receipt_id desc limit 1`;
  const evidence = row?.evidence as
    { output?: unknown; summary?: string } | undefined;
  const result = ChangesetExecutionResultSchema.safeParse(evidence?.output);
  return {
    result: result.success ? result.data : null,
    summary: typeof evidence?.summary === 'string' ? evidence.summary : null,
  };
}

/** Deterministic Worker handler after acquiring the existing Session and Job lease. */
export async function createChangesetOperation(
  context: ExecutionContext,
  storage: StoragePort,
  db: Database = getDatabase(),
) {
  if (!changesetFeatureEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const owner = context.policySnapshot.subjectId;
  const principal = {
    actor: { type: 'user' as const, id: owner },
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
  };
  const [row] = await db<
    {
      artifact_id: string;
      checksum: string;
      restore_of: string | null;
      session_id: string;
      execution_spec: unknown;
      policy_snapshot_id: string;
      payload: unknown;
      execution_snapshot: unknown;
      employee_version_id: string;
      thread_generation: number;
      timeout_at: Date;
    }[]
  >`select x.*,r.execution_spec,r.policy_snapshot_id,p.payload,e.execution_snapshot,e.employee_version_id,c.thread_generation,j.timeout_at
    from allrice_changeset_runs x join allrice_runs r on r.id=x.run_id
    join allrice_employee_runs e on e.run_id=r.id and e.session_id=x.session_id and e.owner_id=x.actor_id
    join allrice_conversation_runtimes c on c.session_id=x.session_id and c.active_run_id=x.run_id and c.state='running' and c.worker_id=${context.worker.id}
    join allrice_jobs j on j.run_id=x.run_id and j.id=${context.jobId}
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id
    where x.run_id=${context.runId} and x.organization_id=${context.organizationId} and x.workspace_id=${context.workspaceId!} and x.actor_id=${owner}
    and j.status='running' and j.worker_id=${context.worker.id} and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null`;
  if (!row) throw new RuntimePolicyError('run_or_frozen_configuration_changed');
  const frozen = EmployeeExecutionSnapshotSchema.parse(row.execution_snapshot);
  if (
    frozen.schemaVersion !== 2 ||
    !frozen.capabilitySnapshot.grantedCapabilities.includes('storage:write') ||
    !frozen.capabilitySnapshot.bindings.toolNames.includes('local.fs.write')
  )
    throw new RuntimePolicyError('frozen_policy_permission_denied');
  const { artifact } = await db.begin((tx) =>
    prepareChangesetAction(tx, principal, row.session_id, {
      artifactId: row.artifact_id,
      checksum: row.checksum,
      restoreOf: row.restore_of,
    }),
  );
  const proposal = parseChangesetBytes(
    await readArtifactBytes(storage, artifact.object),
  );
  if (
    !runtimeContractEqual(artifact.execution, proposal.execution) ||
    proposal.execution.targetKind !== 'rice_bridge' ||
    proposal.execution.workCopy.kind !== 'in_place'
  )
    fail('changeset_target_invalid');
  let files = proposal.files;
  if (row.restore_of) {
    const evidence = await readChangesetEvidence(db, principal, row.restore_of);
    const original = await db<
      { bridge_payload: unknown }[]
    >`select bridge_payload from allrice_runtime_operations where id=${changesetOperationId(row.restore_of)} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}`;
    const sent = RuntimeChangesetSchema.safeParse(original[0]?.bridge_payload);
    if (
      !sent.success ||
      sent.data.arguments.artifactId !== artifact.id ||
      sent.data.arguments.direction !== 'apply' ||
      !runtimeContractEqual(sent.data.arguments.files, files) ||
      !evidence.result
    )
      fail('restore_evidence_required');
    const confirmed = new Set(
      evidence.result.files
        .filter((f) => f.status === 'applied')
        .filter((f) =>
          files.some(
            (p) =>
              p.path === f.path &&
              (p.before?.checksum ?? null) === f.beforeChecksum &&
              (p.after?.checksum ?? null) === f.afterChecksum,
          ),
        )
        .map((f) => f.path),
    );
    files = [...files]
      .reverse()
      .filter((f) => confirmed.has(f.path))
      .map((f) => ({ path: f.path, before: f.after, after: f.before }));
    if (!files.length) fail('restore_evidence_required');
  }
  const payload = RuntimeChangesetSchema.parse({
    capability: 'local.fs.changeset',
    arguments: {
      path: '.',
      artifactId: artifact.id,
      checksum: artifact.object.checksum,
      direction: row.restore_of ? 'restore' : 'apply',
      files,
    },
  });
  if (
    Buffer.byteLength(JSON.stringify(payload)) > 350_000 ||
    files.some((f) =>
      [f.before, f.after].some((s) => s && Buffer.byteLength(s.text) > 200_000),
    )
  )
    fail('changeset_too_large');
  const [target] = await db<
    { device: unknown; label: string }[]
  >`select json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online','lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device,g.label
    from allrice_bridge_devices d join allrice_bridge_folder_grants g on g.device_id=d.id
    where d.id=${proposal.execution.deviceId} and g.id=${proposal.execution.grantId} and d.organization_id=${context.organizationId} and d.workspace_id=${context.workspaceId!} and d.owner_id=${owner}
    and d.revoked_at is null and g.revoked_at is null and d.last_seen_at>clock_timestamp()-interval '90 seconds'`;
  if (!target) fail('changeset_target_unavailable');
  const device = BridgeDeviceSchema.parse(target.device),
    key = `changeset:${context.runId}`;
  const binding = RuntimeActionBindingSchema.parse({
    task: {
      scope: {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        projectId: null,
      },
      runId: context.runId,
      rootRunId: context.runId,
      parentRunId: null,
      chatSessionId: row.session_id,
      frozenConfiguration: {
        employeeVersionId: row.employee_version_id,
        digest: digest(row.execution_spec),
      },
    },
    attempt: {
      operationId: changesetOperationId(context.runId),
      attemptId: id(`${key}:attempt`),
      attemptNumber: 1,
      generation: row.thread_generation,
      fence: 1,
    },
    requestedBy: principal.actor,
    policy: { snapshotId: row.policy_snapshot_id, digest: digest(row.payload) },
    execution: proposal.execution,
    action: payload.capability,
    inputDigest: digest(payload),
    command: null,
    baseline: [],
    dataScope: [],
  });
  const ledger = createGovernedBridgeOperationLedger(device, {
    database: db,
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
        capacity: 1,
        source: { kind: 'worker', sourceId: 'changeset-v1' },
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
      { metric: 'tool_calls', amount: 1, accountingId: id(`${key}:meter`) },
    ],
  });
  if (snapshot.status === 'waiting_user')
    await requestRuntimeActionApproval(
      ledger.policyOptions,
      binding,
      undefined,
      db,
    );
  return {
    snapshot,
    payload,
    ledger,
    workspaceLabel: target.label,
    deadlineAt: row.timeout_at.toISOString(),
  };
}

export async function getChangesetRun(
  context: WorkbenchPrincipal,
  sessionId: string,
  runId: string,
  db: Database = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    const rows =
      await tx`select run_id from allrice_changeset_runs where run_id=${runId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and actor_id=${context.actor.id} and session_id=${sessionId}`;
    return rows.length > 0;
  });
}

export async function listChangesetRuns(
  context: WorkbenchPrincipal,
  sessionId: string,
  artifactId: string,
  db: Database = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    await readArtifact(tx, context, sessionId, artifactId);
    const rows = await tx<
      {
        run_id: string;
        restore_of: string | null;
        state: string;
        snapshot: unknown;
        bridge_payload: unknown;
        request: unknown;
        response: unknown;
        revoked_at: Date | null;
        consumed_at: Date | null;
      }[]
    >`
      select c.run_id,c.restore_of,r.state,o.snapshot,o.bridge_payload,a.runtime_request as request,a.runtime_response as response,a.runtime_revoked_at as revoked_at,a.runtime_consumed_at as consumed_at
      from allrice_changeset_runs c join allrice_runs r on r.id=c.run_id
      left join allrice_runtime_operations o on o.run_id=c.run_id
      left join allrice_approval_requests a on a.resource_id=o.id and a.resource_type='runtime_operation'
      where c.organization_id=${context.organizationId} and c.workspace_id=${context.workspaceId!} and c.actor_id=${context.actor.id} and c.session_id=${sessionId} and c.artifact_id=${artifactId} order by c.created_at limit 20`;
    return Promise.all(
      rows.map(async (r) => ({
        runId: r.run_id,
        restoreOf: r.restore_of,
        runState: r.state,
        snapshot: r.snapshot
          ? RuntimeOperationSnapshotSchema.parse(r.snapshot)
          : null,
        payload: r.bridge_payload
          ? RuntimeChangesetSchema.parse(r.bridge_payload)
          : null,
        approval: r.request
          ? {
              request: RuntimeActionApprovalRequestSchema.parse(r.request),
              response: r.response,
              revokedAt: r.revoked_at?.toISOString() ?? null,
              consumedAt: r.consumed_at?.toISOString() ?? null,
            }
          : null,
        evidence: await readChangesetEvidence(tx, context, r.run_id),
      })),
    );
  });
}
