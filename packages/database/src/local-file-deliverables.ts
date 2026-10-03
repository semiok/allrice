import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  BridgeDeviceSchema,
  FileDerivationPayloadSchema,
  FileDerivationResultSchema,
  RuntimeOperationSnapshotSchema,
  UuidSchema,
  fileDerivationResultMatches,
  runtimeContractEqual,
  type ExecutionContext,
  type RequestContext,
  type DeliveryFormat,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { getStoredFile, DataAccessError } from './data.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  createRuntimePolicyAdmission,
  runtimePolicyDigest,
  RuntimePolicyError,
} from './runtime-policy.ts';
import { createGovernedBridgePolicyOptions } from './runtime-governed-bridge.ts';
import { registerToolBrokerExport } from './execution/tool-broker.ts';
import type { StoragePort } from '@allrice/contracts';

/** Same immutable storage, formal version and Workbench publisher used by
 * local Python. Ready upload alone is not a successful operation receipt. */
export async function publishLocalFileDerivationArtifacts(
  input: { context: ExecutionContext; operationId: string },
  storage: StoragePort,
  db = getDatabase(),
) {
  const { context: ctx } = input,
    owner = ctx.policySnapshot.subjectId,
    operationId = UuidSchema.parse(input.operationId);
  const unavailable = () =>
    new RuntimePolicyError('local_file_result_unconfirmed');
  const read = async (sql: typeof db | TransactionSql) => {
    const [row] = await sql<
      {
        snapshot: unknown;
        bridge_payload: unknown;
        device_id: string;
        receipt: { attempt: unknown; evidence?: { output?: unknown } } | null;
      }[]
    >`select o.snapshot,o.bridge_payload,o.device_id,r.payload as receipt from allrice_runtime_operations o
      left join lateral(select payload from allrice_runtime_operation_receipts where operation_id=o.id and disposition='applied' and payload->'signal'->>'type'='operation.outcome' and payload->'signal'->'result'->>'status'='succeeded' order by received_at desc limit 1)r on true
      where o.id=${operationId} and o.run_id=${ctx.runId} and o.organization_id=${ctx.organizationId} and o.workspace_id=${ctx.workspaceId}`;
    if (!row) throw unavailable();
    const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot),
      payload = FileDerivationPayloadSchema.parse(row.bridge_payload),
      result = FileDerivationResultSchema.safeParse(
        row.receipt?.evidence?.output,
      );
    if (
      snapshot.status !== 'succeeded' ||
      snapshot.cancelRequestId ||
      snapshot.binding.requestedBy.id !== owner ||
      snapshot.binding.execution.deviceId !== row.device_id ||
      snapshot.binding.task.runId !== ctx.runId ||
      !snapshot.binding.task.chatSessionId ||
      !row.receipt ||
      !runtimeContractEqual(row.receipt.attempt, snapshot.binding.attempt) ||
      !result.success ||
      !fileDerivationResultMatches(payload, result.data) ||
      payload.arguments.request.kind.startsWith('zip_') ||
      !result.data.processing?.stopped ||
      !result.data.object
    )
      throw unavailable();
    return {
      snapshot,
      payload,
      result: result.data,
      object: result.data.object,
      deviceId: row.device_id,
    };
  };
  const initial = await read(db),
    requestContext: RequestContext = {
      requestId: randomUUID(),
      sessionId: initial.snapshot.binding.task.chatSessionId!,
      actor: { type: 'user', id: owner },
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      memberships: ctx.policySnapshot.memberships,
      authenticatedAt: new Date().toISOString(),
    };
  const { object } = await getStoredFile(
    requestContext,
    initial.object.objectId,
    db,
  );
  const formats: Record<string, DeliveryFormat> = {
      'application/pdf': 'pdf',
      'image/png': 'png',
      'image/jpeg': 'jpeg',
      'image/webp': 'webp',
    },
    format = formats[object.mediaType];
  if (
    !format ||
    !object.immutable ||
    object.sizeBytes > 8_000_000 ||
    object.checksum !== initial.object.checksum ||
    object.sizeBytes !== initial.object.sizeBytes ||
    object.mediaType !== initial.object.mediaType
  )
    throw unavailable();
  const stream = await storage.get(object),
    reader = stream.getReader(),
    hash = createHash('sha256');
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > object.sizeBytes || size > 8_000_000) throw unavailable();
      hash.update(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (
    size !== object.sizeBytes ||
    'sha256:' + hash.digest('hex') !== object.checksum
  )
    throw unavailable();
  return db.begin(async (tx) => {
    await lockWorkspaceStorageQuota(tx, ctx.organizationId, ctx.workspaceId);
    const [root] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${initial.snapshot.binding.task.rootRunId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and cancel_request_id is null and deadline_at>clock_timestamp() for update`;
    const [operation] =
      await tx`select id from allrice_runtime_operations where id=${operationId} and run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} for update`;
    if (!root || !operation) throw unavailable();
    const current = await read(tx);
    if (!runtimeContractEqual(initial, current)) throw unavailable();
    const [device] = await tx<
      { device: unknown }[]
    >`select json_build_object('id',id,'organizationId',organization_id,'workspaceId',workspace_id,'ownerId',owner_id,'name',name,'platform',platform,'protocolVersion',protocol_version,'capabilities',capabilities,'status','online','lastSeenAt',last_seen_at,'createdAt',created_at,'revokedAt',revoked_at)as device from allrice_bridge_devices where id=${current.deviceId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${owner} and revoked_at is null`;
    if (!device) throw unavailable();
    const admission = createRuntimePolicyAdmission(
      createGovernedBridgePolicyOptions(
        BridgeDeviceSchema.parse(device.device),
      ),
    );
    await admission({
      transaction: tx,
      binding: current.snapshot.binding,
      phase: 'heartbeat',
      now: new Date(),
    });
    const requestDigest = runtimePolicyDigest({
      operationId,
      objectId: object.id,
      fileName: current.object.fileName,
      checksum: object.checksum,
      format,
    });
    const [existing] = await tx<
      {
        version_id: string;
        request_digest: string;
        object_id: string;
        version: number;
      }[]
    >`select a.version_id,a.request_digest,v.object_id,v.version from allrice_workbench_artifacts a join allrice_deliverable_versions v on v.id=a.version_id where a.organization_id=${ctx.organizationId} and a.workspace_id=${ctx.workspaceId} and a.owner_id=${owner} and a.run_id=${ctx.runId} and a.request_id=${operationId}`;
    if (existing) {
      if (
        existing.object_id !== object.id ||
        existing.request_digest !== requestDigest
      )
        throw new DataAccessError('grant_invalid');
      return {
        artifactId: existing.version_id,
        objectId: object.id,
        versionId: existing.version_id,
        version: existing.version,
      };
    }
    const version = await registerToolBrokerExport(
      {
        context: ctx,
        sessionId: current.snapshot.binding.task.chatSessionId!,
        fileName: current.object.fileName,
        format,
        object,
        storageMode: 'existing_ready',
      },
      tx,
    );
    await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest)values(${version.id},${ctx.organizationId},${ctx.workspaceId},${owner},${ctx.runId},'file',${tx.json({ kind: 'tool_result', runId: ctx.runId, operationId, stepId: null })},${tx.json(current.snapshot.binding.execution)},${operationId},${requestDigest})`;
    await admission({
      transaction: tx,
      binding: current.snapshot.binding,
      phase: 'heartbeat',
      now: new Date(),
    });
    return {
      artifactId: version.id,
      objectId: object.id,
      versionId: version.id,
      version: version.version,
    };
  });
}
