import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  LocalFilePayloadSchema,
  FileDerivationPayloadSchema,
  FileDerivationContentSchema,
  fileDerivationMediaType,
  type FileDerivationPayload,
  LocalFileUserRequestSchema,
  LocalFileObjectSchema,
  LocalFileVersionSchema,
  LocalFileResultSchema,
  RuntimeOperationSnapshotSchema,
  canonicalRuntimeBridgeJson,
  runtimeContractEqual,
  localFileMaximumBytes,
  type LocalFilePayload,
  type LocalFileObject,
  type LocalFileVersion,
  type RequestContext,
  type StorageObject,
  type StoragePort,
  type Membership,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { bridgeDeviceStatus, BridgeDataError } from './bridge.ts';
import { bridgeCapabilityReadinessView } from './bridge-settings.ts';
import {
  createGovernedBridgeOperationLedger,
  createGovernedBridgePolicyOptions,
} from './runtime-governed-bridge.ts';
import {
  createRuntimePolicyAdmission,
  RuntimePolicyError,
} from './runtime-policy.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  DataAccessError,
  getStoredFile,
  createStorageMetadata,
  markStorageReady,
  abandonStorageMetadata,
} from './data.ts';
import {
  authorizeSessionOwner,
  linkFileToSession,
} from './workspace/service.ts';

const digest = (v: unknown) =>
  `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(v)).digest('hex')}`;
const leaseHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function localFileObjectReference(
  object: StorageObject,
  fileName: string,
): LocalFileObject {
  return LocalFileObjectSchema.parse({
    objectId: object.id,
    checksum: object.checksum,
    sizeBytes: object.sizeBytes,
    mediaType: object.mediaType,
    fileName,
    deliverableVersionId: null,
    deliverableVersion: null,
  });
}

export async function enqueueLocalFileCommand(
  context: RequestContext,
  raw: unknown,
) {
  const input = LocalFileUserRequestSchema.parse(raw),
    db = getDatabase();
  if (
    context.actor.type !== 'user' ||
    !context.memberships.some(
      (m) =>
        m.active &&
        m.userId === context.actor.id &&
        m.organizationId === context.organizationId &&
        (m.workspaceId === null || m.workspaceId === input.workspaceId) &&
        ['admin', 'member'].includes(m.role),
    )
  )
    throw new DataAccessError('authorization_denied');
  if (input.sessionId)
    await authorizeSessionOwner(context, input.workspaceId, input.sessionId);
  const key = `local-file-user:${context.actor.id}:${input.idempotencyKey}`,
    fingerprint = digest(input);
  const [prior] = await db<
    {
      id: string;
      request_digest: string;
      owner_id: string;
      workspace_id: string;
    }[]
  >`
    select id,request_digest,owner_id,workspace_id from allrice_bridge_commands where organization_id=${context.organizationId} and idempotency_key=${key}`;
  if (prior) {
    if (
      prior.request_digest !== fingerprint ||
      prior.owner_id !== context.actor.id ||
      prior.workspace_id !== input.workspaceId
    )
      throw new BridgeDataError('idempotency_conflict');
    return readLocalFileCommand(context, input.workspaceId, prior.id);
  }
  let object: LocalFileObject | undefined;
  if (input.action === 'save') {
    const file = await getStoredFile(context, input.objectId!);
    if (
      file.object.workspaceId !== input.workspaceId ||
      file.object.checksum !== input.checksum
    )
      throw new DataAccessError('grant_invalid');
    const [version] = await db<
      { id: string; version: number; file_name: string }[]
    >`
      select id,version,file_name from allrice_deliverable_versions where object_id=${file.object.id} and organization_id=${context.organizationId} and workspace_id=${input.workspaceId} order by created_at desc limit 1`;
    object = localFileObjectReference(
      file.object,
      version?.file_name ?? input.path!.split('/').at(-1)!,
    );
    if (version)
      object = {
        ...object,
        deliverableVersionId: version.id,
        deliverableVersion: version.version,
      };
  } else if (input.action === 'import') {
    object = LocalFileObjectSchema.parse({
      objectId: randomUUID(),
      checksum: input.expected!.checksum,
      sizeBytes: input.expected!.sizeBytes,
      mediaType: input.expected!.mediaType,
      fileName: input.path!.split('/').at(-1),
      deliverableVersionId: null,
      deliverableVersion: null,
    });
  }
  const payload = LocalFilePayloadSchema.parse({
    capability: `local.file.${input.action}`,
    arguments:
      input.action === 'select'
        ? { path: '.', objectId: randomUUID() }
        : input.action === 'save'
          ? { path: input.path, object }
          : input.action === 'import'
            ? { path: input.path, expected: input.expected, object }
            : input.action === 'inspect'
              ? { path: input.path }
              : { path: input.path, expected: input.expected },
  });
  const id = await db.begin(async (tx) => {
    const [target] = await tx<
      {
        id: string;
        runtime_generation: number;
        metadata: Record<string, unknown>;
      }[]
    >`
      select d.id,g.runtime_generation,t.metadata from allrice_bridge_devices d
      join allrice_bridge_folder_grants g on g.device_id=d.id and g.id=${input.folderGrantId}
      join allrice_execution_targets t on t.target_key='bridge.'||d.id::text and t.organization_id=d.organization_id and t.workspace_id=d.workspace_id
      where d.id=${input.deviceId} and d.organization_id=${context.organizationId} and d.workspace_id=${input.workspaceId} and d.owner_id=${context.actor.id}
        and d.revoked_at is null and g.revoked_at is null and d.capabilities @> array[${payload.capability}]::text[]
        and d.last_seen_at>clock_timestamp()-interval '90 seconds' and d.last_seen_at<=clock_timestamp()
        and t.state='online' for share of d,g,t`;
    if (!target) throw new BridgeDataError('device_offline');
    const readiness = bridgeCapabilityReadinessView(
      target.metadata,
      payload.capability,
    );
    if (['unsupported', 'paused', 'offline'].includes(readiness.state))
      throw new BridgeDataError('command_unavailable');
    const [row] = await tx<{ id: string; request_digest: string }[]>`
      insert into allrice_bridge_commands(organization_id,workspace_id,owner_id,device_id,folder_grant_id,folder_grant_version,session_id,capability,arguments,idempotency_key,request_digest,timeout_at)
      values(${context.organizationId},${input.workspaceId},${context.actor.id},${input.deviceId},${input.folderGrantId},${target.runtime_generation},${input.sessionId},${payload.capability},${tx.json(payload.arguments)},${key},${fingerprint},clock_timestamp()+interval '5 minutes')
      on conflict(organization_id,idempotency_key) do update set updated_at=allrice_bridge_commands.updated_at
      returning id,request_digest`;
    if (!row || row.request_digest !== fingerprint)
      throw new BridgeDataError('idempotency_conflict');
    return row.id;
  });
  await db`select pg_notify('allrice_bridge_commands',${input.deviceId})`;
  return readLocalFileCommand(context, input.workspaceId, id);
}

export async function readLocalFileCommand(
  context: RequestContext,
  workspaceId: string,
  id: string,
  cancel = false,
) {
  if (
    context.actor.type !== 'user' ||
    !context.memberships.some(
      (m) =>
        m.active &&
        m.userId === context.actor.id &&
        m.organizationId === context.organizationId &&
        (m.workspaceId === null || m.workspaceId === workspaceId),
    )
  )
    throw new DataAccessError('authorization_denied');
  const db = getDatabase();
  if (cancel)
    await db`update allrice_bridge_commands set cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
    status=case when status='queued' then 'canceled' else status end, updated_at=clock_timestamp()
    where id=${id} and organization_id=${context.organizationId} and workspace_id=${workspaceId} and owner_id=${context.actor.id}
      and capability like 'local.file.%' and status in ('queued','claimed','running')`;
  await db`update allrice_bridge_commands set status=case when status='queued' then 'expired' else 'unknown' end,
    error_code=case when status='queued' then 'FILE_TIMEOUT' else 'FILE_RESULT_UNKNOWN' end, updated_at=clock_timestamp()
    where id=${id} and organization_id=${context.organizationId} and workspace_id=${workspaceId} and owner_id=${context.actor.id}
      and capability like 'local.file.%' and timeout_at<=clock_timestamp() and status in ('queued','claimed','running')`;
  const [row] = await db<
    {
      id: string;
      status: string;
      result: unknown;
      summary: string | null;
      error_code: string | null;
      cancel_requested_at: Date | null;
      device_id: string;
      folder_grant_id: string;
    }[]
  >`
    select id,status,result,summary,error_code,cancel_requested_at,device_id,folder_grant_id from allrice_bridge_commands
    where id=${id} and organization_id=${context.organizationId} and workspace_id=${workspaceId} and owner_id=${context.actor.id} and capability like 'local.file.%'`;
  if (!row) throw new DataAccessError('not_found');
  return {
    id: row.id,
    status: row.status,
    summary: row.summary,
    errorCode: row.error_code,
    cancelRequested: !!row.cancel_requested_at,
    deviceId: row.device_id,
    folderGrantId: row.folder_grant_id,
    output:
      row.status === 'succeeded'
        ? LocalFileResultSchema.parse(row.result)
        : null,
  };
}

/** Current device/token, folder generation and owner checks on every stream/start/commit. */
export async function localFileTransferAuthority(
  token: string,
  kind: 'command' | 'operation',
  id: string,
  leaseToken: string,
) {
  const { device } = await bridgeDeviceStatus(token),
    db = getDatabase();
  const memberships = await db<
    Membership[]
  >`select m.id,m.user_id as "userId",m.organization_id as "organizationId",m.workspace_id as "workspaceId",m.role,m.active
    from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=${device.workspaceId} and w.organization_id=m.organization_id and w.archived_at is null
    where m.user_id=${device.ownerId} and m.organization_id=${device.organizationId} and m.active and m.role in ('admin','member')
      and (m.workspace_id is null or m.workspace_id=${device.workspaceId})`;
  if (!memberships.length) throw new DataAccessError('authorization_denied');
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: device.id,
    actor: { type: 'user', id: device.ownerId },
    organizationId: device.organizationId,
    workspaceId: device.workspaceId,
    memberships,
    authenticatedAt: new Date().toISOString(),
  };
  let payload: LocalFilePayload | FileDerivationPayload,
    sessionId: string | null;
  if (kind === 'command') {
    const [row] = await db<
      { capability: string; arguments: unknown; session_id: string | null }[]
    >`
      select c.capability,c.arguments,c.session_id from allrice_bridge_commands c
      join allrice_bridge_folder_grants g on g.id=c.folder_grant_id and g.device_id=c.device_id
      join allrice_execution_targets t on t.target_key='bridge.'||c.device_id::text and t.organization_id=c.organization_id and t.workspace_id=c.workspace_id
      where c.id=${id} and c.device_id=${device.id} and c.organization_id=${device.organizationId} and c.workspace_id=${device.workspaceId} and c.owner_id=${device.ownerId}
        and c.lease_token=${leaseToken} and c.status in ('claimed','running') and c.cancel_requested_at is null
        and c.timeout_at>clock_timestamp() and g.revoked_at is null and g.runtime_generation=c.folder_grant_version
        and t.state='online' and coalesce((t.metadata->'environment'->>'paused')::boolean,false)=false
        and c.capability=any(${device.capabilities})
        and (c.session_id is null or exists(select 1 from allrice_chat_sessions s where s.id=c.session_id and s.organization_id=c.organization_id
          and s.workspace_id=c.workspace_id and s.owner_id=c.owner_id and s.archived_at is null))`;
    if (!row) throw new BridgeDataError('lease_lost');
    payload = LocalFilePayloadSchema.parse({
      capability: row.capability,
      arguments: row.arguments,
    });
    sessionId = row.session_id;
  } else {
    const [row] = await db<{ bridge_payload: unknown; snapshot: unknown }[]>`
      select bridge_payload,snapshot from allrice_runtime_operations where id=${id} and device_id=${device.id}
        and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and lease_token_hash=${leaseHash(leaseToken)}
        and lease_expires_at>clock_timestamp() and snapshot->>'status'='running' and snapshot->>'cancelRequestId' is null`;
    if (!row) throw new BridgeDataError('lease_lost');
    const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
    const renewed = await createGovernedBridgeOperationLedger(device).heartbeat(
      {
        scope: snapshot.binding.task.scope,
        operationId: id,
        leaseToken,
        leaseMs: 120_000,
      },
    );
    if (
      renewed.snapshot.status !== 'running' ||
      renewed.snapshot.cancelRequestId
    )
      throw new BridgeDataError('lease_lost');
    const deriving = FileDerivationPayloadSchema.safeParse(row.bridge_payload);
    payload = deriving.success
      ? deriving.data
      : LocalFilePayloadSchema.parse(row.bridge_payload);
    sessionId = snapshot.binding.task.chatSessionId;
  }
  return { device, context, payload, sessionId };
}

export async function storeLocalFileUpload(input: {
  token: string;
  kind: 'command' | 'operation';
  id: string;
  leaseToken: string;
  version: LocalFileVersion;
  fileName: string;
  stream: ReadableStream<Uint8Array>;
  storage: StoragePort;
}) {
  const version = LocalFileVersionSchema.parse(input.version);
  const current = await localFileTransferAuthority(
    input.token,
    input.kind,
    input.id,
    input.leaseToken,
  );
  const payload = current.payload;
  if (
    payload.capability !== 'local.file.import' &&
    payload.capability !== 'local.file.select'
  )
    throw new DataAccessError('authorization_denied');
  if (
    payload.capability === 'local.file.import' &&
    canonicalRuntimeBridgeJson(version) !==
      canonicalRuntimeBridgeJson(payload.arguments.expected)
  )
    throw new DataAccessError('grant_invalid');
  const objectId =
    payload.capability === 'local.file.select'
      ? payload.arguments.objectId
      : payload.arguments.object.objectId;
  const object = LocalFileObjectSchema.parse({
    objectId,
    checksum: version.checksum,
    sizeBytes: version.sizeBytes,
    mediaType: version.mediaType,
    fileName: input.fileName,
    deliverableVersionId: null,
    deliverableVersion: null,
  });
  return commitLocalFileUpload({ ...input, current, version, object });
}

/** Both original imports and local derivatives use the existing storage/owner stream. */
async function commitDerivedFileInTransaction(
  tx: TransactionSql,
  input: {
    current: Awaited<ReturnType<typeof localFileTransferAuthority>>;
    token: string;
    id: string;
    leaseToken: string;
    object: LocalFileObject;
  },
  markReady: boolean,
) {
  const { current, object } = input,
    { device } = current;
  if (current.payload.capability !== 'local.file.derive')
    throw new DataAccessError('authorization_denied');
  // Reuse the Python attachment commit lock order: quota -> root -> operation
  // -> current policy/grant authority. The physical upload holds no DB locks.
  await lockWorkspaceStorageQuota(
    tx,
    device.organizationId,
    device.workspaceId,
  );
  const [root] = await tx`select root_run_id from allrice_runtime_roots
    where root_run_id=(select snapshot->'binding'->'task'->>'rootRunId' from allrice_runtime_operations where id=${input.id})::uuid
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and cancel_request_id is null and deadline_at>clock_timestamp() for update`;
  const [row] = await tx<
    { snapshot: unknown; bridge_payload: unknown }[]
  >`select snapshot,bridge_payload from allrice_runtime_operations
    where id=${input.id} and device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and lease_token_hash=${leaseHash(input.leaseToken)} and lease_expires_at>clock_timestamp()
      and snapshot->>'status'='running' and snapshot->>'cancelRequestId' is null for update`;
  if (
    !root ||
    !row ||
    !runtimeContractEqual(row.bridge_payload, current.payload)
  )
    throw new DataAccessError('authorization_denied');
  const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
  await createRuntimePolicyAdmission(createGovernedBridgePolicyOptions(device))(
    {
      transaction: tx,
      binding: snapshot.binding,
      phase: 'heartbeat',
      now: new Date(),
    },
  ).catch((error: unknown) => {
    if (error instanceof RuntimePolicyError)
      throw new DataAccessError('authorization_denied');
    throw error;
  });
  const [token] =
    await tx`select id from allrice_bridge_devices where id=${device.id} and revoked_at is null
    and token_hash=${leaseHash(input.token)} for share`;
  if (!token) throw new DataAccessError('authorization_denied');
  if (markReady) await markStorageReady(current.context, object.objectId, tx);
  if (current.sessionId)
    await linkFileToSession({
      context: current.context,
      workspaceId: device.workspaceId,
      sessionId: current.sessionId,
      objectId: object.objectId,
      fileName: object.fileName,
      database: tx,
    });
  const [stillLive] =
    await tx`select id from allrice_runtime_operations where id=${input.id}
    and lease_expires_at>clock_timestamp() and snapshot->>'status'='running' and snapshot->>'cancelRequestId' is null`;
  if (!stillLive) throw new DataAccessError('authorization_denied');
}

async function commitLocalFileUpload(input: {
  current: Awaited<ReturnType<typeof localFileTransferAuthority>>;
  token: string;
  kind: 'command' | 'operation';
  id: string;
  leaseToken: string;
  version: Pick<LocalFileVersion, 'checksum' | 'sizeBytes' | 'mediaType'>;
  object: LocalFileObject;
  stream: ReadableStream<Uint8Array>;
  storage: StoragePort;
}) {
  const { current, version, object } = input;
  const objectId = object.objectId;
  let pending = false;
  try {
    // Fixed object ID plus immutable metadata makes a lost upload ACK safe to query.
    const existing = await getStoredFile(current.context, objectId).catch(
      (e: unknown) => {
        if (e instanceof DataAccessError && e.code === 'not_found') return null;
        throw e;
      },
    );
    if (existing) {
      if (
        existing.object.checksum !== version.checksum ||
        existing.object.sizeBytes !== version.sizeBytes ||
        existing.object.mediaType !== version.mediaType
      )
        throw new DataAccessError('grant_invalid');
      await input.stream.cancel();
      if (current.payload.capability === 'local.file.derive')
        await getDatabase().begin((tx) =>
          commitDerivedFileInTransaction(tx, input, false),
        );
      else if (current.sessionId)
        await linkFileToSession({
          context: current.context,
          workspaceId: current.device.workspaceId,
          sessionId: current.sessionId,
          objectId,
          fileName: object.fileName,
        });
      return object;
    }
    const file = await createStorageMetadata(current.context, {
      id: objectId,
      workspaceId: current.device.workspaceId,
      category:
        current.payload.capability === 'local.file.derive' &&
        !current.payload.arguments.request.kind.startsWith('zip_')
          ? 'artifacts'
          : 'uploads',
      mediaType: version.mediaType,
      sizeBytes: version.sizeBytes,
      checksum: version.checksum,
      visibility: 'private',
      retentionUntil: null,
      immutable:
        current.payload.capability === 'local.file.derive' &&
        !current.payload.arguments.request.kind.startsWith('zip_'),
    });
    pending = true;
    const reader = input.stream.getReader();
    let size = 0,
      verified = false;
    const hash = createHash('sha256');
    const bounded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (
              size !== version.sizeBytes ||
              `sha256:${hash.digest('hex')}` !== version.checksum
            )
              throw new DataAccessError('grant_invalid');
            verified = true;
            controller.close();
            return;
          }
          size += chunk.value.byteLength;
          if (size > version.sizeBytes || size > localFileMaximumBytes)
            throw new DataAccessError('quota_exceeded');
          hash.update(chunk.value);
          controller.enqueue(chunk.value);
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    try {
      await input.storage.put(file.object, bounded);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!verified || !(await input.storage.exists(file.object)))
      throw new DataAccessError('grant_invalid');
    if (current.payload.capability === 'local.file.derive')
      await getDatabase().begin((tx) =>
        commitDerivedFileInTransaction(tx, input, true),
      );
    else {
      await localFileTransferAuthority(
        input.token,
        input.kind,
        input.id,
        input.leaseToken,
      );
      await markStorageReady(current.context, objectId);
      if (current.sessionId)
        await linkFileToSession({
          context: current.context,
          workspaceId: current.device.workspaceId,
          sessionId: current.sessionId,
          objectId,
          fileName: object.fileName,
        });
    }
    pending = false;
    return object;
  } catch (e) {
    if (pending) {
      await abandonStorageMetadata(current.context, objectId).catch(
        () => undefined,
      );
      const file = await getDatabase()<
        { object_key: string }[]
      >`select object_key from allrice_storage_objects where id=${objectId} and state='deleted'`;
      if (file[0])
        await input.storage
          .delete({
            id: objectId,
            organizationId: current.device.organizationId,
            workspaceId: current.device.workspaceId,
            ownerId: current.device.ownerId,
            key: file[0].object_key,
            checksum: version.checksum,
            sizeBytes: version.sizeBytes,
            mediaType: version.mediaType,
            retentionUntil: null,
            deletedAt: null,
            immutable: false,
          })
          .catch(() => undefined);
    }
    throw e;
  }
}

export async function storeLocalFileDerivation(input: {
  token: string;
  kind: 'command' | 'operation';
  id: string;
  leaseToken: string;
  metadata: unknown;
  stream: ReadableStream<Uint8Array>;
  storage: StoragePort;
}) {
  if (input.kind !== 'operation')
    throw new DataAccessError('authorization_denied');
  const current = await localFileTransferAuthority(
    input.token,
    input.kind,
    input.id,
    input.leaseToken,
  );
  const payload = current.payload;
  if (
    payload.capability !== 'local.file.derive' ||
    payload.outputObjectId === null
  )
    throw new DataAccessError('authorization_denied');
  const metadata = FileDerivationContentSchema.parse(input.metadata);
  const request = payload.arguments.request;
  if (
    request.kind === 'zip_list' ||
    metadata.fileName !== request.fileName ||
    metadata.mediaType !== fileDerivationMediaType(request)
  )
    throw new DataAccessError('grant_invalid');
  const object = LocalFileObjectSchema.parse({
    ...metadata,
    objectId: payload.outputObjectId,
    deliverableVersionId: null,
    deliverableVersion: null,
  });
  return commitLocalFileUpload({
    ...input,
    current,
    version: metadata,
    object,
  });
}

export async function readLocalFileDownload(
  token: string,
  kind: 'command' | 'operation',
  id: string,
  leaseToken: string,
) {
  const current = await localFileTransferAuthority(token, kind, id, leaseToken);
  if (current.payload.capability !== 'local.file.save')
    throw new DataAccessError('authorization_denied');
  const ref = current.payload.arguments.object;
  const file = await getStoredFile(current.context, ref.objectId);
  if (
    file.object.checksum !== ref.checksum ||
    file.object.sizeBytes !== ref.sizeBytes ||
    file.object.mediaType !== ref.mediaType ||
    file.object.workspaceId !== current.device.workspaceId
  )
    throw new DataAccessError('grant_invalid');
  return file.object;
}
