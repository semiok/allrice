import { createHash, randomUUID } from 'node:crypto';
import {
  LocalBrowserCaptureSchema,
  localBrowserCaptureMaximumBytes,
  makeObjectKey,
  type BridgeDevice,
  type LocalBrowserCapture,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { consumeBrowserDirectInput } from './browser-control.ts';
import { lockBrowserBindingOperations } from './browser-control-authority.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import { localBrowserPrincipal } from './local-browser-grants.ts';
import {
  lockLocalBrowserController,
  type LocalControllerIdentity,
} from './local-browser-workspaces.ts';
import { ownedLocalBrowserOperation } from './local-browser-operations.ts';
import { RuntimePolicyError } from './runtime-policy.ts';

const checksum = (bytes: Buffer): StorageObject['checksum'] =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Storage bytes are untrusted evidence, not a new source of execution authority. */
export async function captureLocalBrowserFile(
  device: BridgeDevice,
  raw: LocalBrowserCapture,
  bytes: Buffer,
  storage: StoragePort,
  db = getDatabase(),
) {
  const input = LocalBrowserCaptureSchema.parse(raw);
  if (!bytes.length || bytes.length > localBrowserCaptureMaximumBytes)
    throw new RuntimePolicyError('local_browser_output_limit');
  const current =
    input.kind === 'download'
      ? await ownedLocalBrowserOperation(device, input, true, db)
      : await db.begin((tx) => lockLocalBrowserController(tx, device, input));
  const w = current.workspace;
  if (input.kind === 'screenshot') {
    if (
      input.fence !== w.control_fence ||
      bytes.length < 8 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      throw new RuntimePolicyError('local_browser_capture_denied');
  } else {
    const op = current as Awaited<
      ReturnType<typeof ownedLocalBrowserOperation>
    >;
    if (
      !w.profile.allowDownloads ||
      bytes.length > w.profile.maximumFileBytes ||
      !op.row.started_at ||
      op.snapshot.status !== 'running' ||
      ['observe', 'request', 'sensitive_fill', 'upload'].includes(
        op.command.action.type,
      )
    )
      throw new RuntimePolicyError('local_browser_capture_denied');
  }
  const objectId = randomUUID(),
    hash = checksum(bytes);
  const object: StorageObject = {
    id: objectId,
    organizationId: w.organization_id,
    workspaceId: w.workspace_id,
    ownerId: w.owner_id,
    key: makeObjectKey({
      organizationId: w.organization_id,
      workspaceId: w.workspace_id,
      ownerId: w.owner_id,
      category: 'artifacts',
      objectId,
    }),
    checksum: hash,
    mediaType: input.kind === 'screenshot' ? 'image/png' : input.mediaType,
    sizeBytes: bytes.length,
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  };
  let put = false;
  try {
    return await db.begin(async (tx) => {
      await lockWorkspaceStorageQuota(tx, w.organization_id, w.workspace_id);
      // The download capture's FK implicitly locks the runtime operation.
      // Enter root→operation before browser, just as ledger admission does.
      if (input.kind === 'download')
        await lockBrowserBindingOperations(
          tx,
          localBrowserPrincipal(device),
          (current as Awaited<ReturnType<typeof ownedLocalBrowserOperation>>)
            .snapshot.binding,
        );
      const { workspace: fresh } = await lockLocalBrowserController(
        tx,
        device,
        input,
      );
      if (fresh.control_fence !== w.control_fence)
        throw new RuntimePolicyError('browser_control_changed');
      const [prior] =
        input.kind === 'screenshot'
          ? await tx`select object_id,checksum from allrice_local_browser_captures where browser_workspace_id=${w.id} and observation_id=${input.observationId} and kind='screenshot'`
          : await tx`select object_id,checksum from allrice_local_browser_captures where browser_workspace_id=${w.id} and operation_id=${input.operationId} and kind='download'`;
      if (prior) {
        if (prior.checksum !== hash)
          throw new RuntimePolicyError('local_browser_capture_conflict');
        return { objectId: prior.object_id as string };
      }
      if (input.kind === 'download') {
        const [op] =
          await tx`select i.operation_id from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id
          where i.operation_id=${input.operationId} and i.browser_workspace_id=${w.id} and i.lease_token=${input.operationLeaseToken}
            and i.started_at is not null and i.result is null and o.snapshot->>'status'='running'`;
        if (!op) throw new RuntimePolicyError('local_browser_not_started');
      }
      const [quota] = await tx<
        { limit_bytes: string; used_bytes: string }[]
      >`select coalesce(q.limit_bytes,1073741824)::text as limit_bytes,
        coalesce((select sum(size_bytes) from allrice_storage_objects where organization_id=${w.organization_id} and workspace_id=${w.workspace_id} and state<>'deleted'),0)::text as used_bytes
        from allrice_workspaces s left join allrice_storage_quotas q on q.organization_id=s.organization_id and q.workspace_id=s.id
        where s.id=${w.workspace_id} and s.organization_id=${w.organization_id}`;
      if (
        !quota ||
        Number(quota.used_bytes) + bytes.length > Number(quota.limit_bytes)
      )
        throw new RuntimePolicyError('local_browser_output_limit');
      await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
      put = true;
      await tx`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable)
        values(${object.id},${w.organization_id},${w.workspace_id},${w.owner_id},${object.key},'artifacts',${object.mediaType},${object.sizeBytes},${object.checksum},'private','ready',true)`;
      await tx`insert into allrice_local_browser_captures(id,organization_id,workspace_id,browser_workspace_id,fence,observation_id,operation_id,kind,object_id,checksum)
        values(${randomUUID()},${w.organization_id},${w.workspace_id},${w.id},${w.control_fence},${input.kind === 'screenshot' ? input.observationId : null},${input.kind === 'download' ? input.operationId : null},${input.kind},${object.id},${object.checksum})`;
      await lockLocalBrowserController(tx, device, input);
      return { objectId: object.id };
    });
  } catch (error) {
    if (put) {
      // A lost COMMIT acknowledgment must not delete a registered artifact.
      const known =
        await db`select id from allrice_storage_objects where id=${object.id}`.catch(
          () => null,
        );
      if (known?.length === 0)
        await storage
          .delete({ ...object, immutable: false })
          .catch(() => undefined);
    }
    throw error;
  }
}

/** One-use delivery is derived exclusively from the STARTed operation; callers
 * cannot substitute an objectId, a pathname or a different private input. */
export async function takeLocalBrowserInput(
  device: BridgeDevice,
  input: LocalControllerIdentity & {
    operationId: string;
    operationLeaseToken: string;
    inputKind: 'upload' | 'private';
  },
  storage: StoragePort,
  db = getDatabase(),
): Promise<Buffer> {
  const current = await ownedLocalBrowserOperation(device, input, true, db);
  if (!current.row.started_at || current.snapshot.status !== 'running')
    throw new RuntimePolicyError('local_browser_not_started');
  if (input.inputKind === 'private') {
    if (current.command.action.type !== 'sensitive_fill')
      throw new RuntimePolicyError('browser_sensitive_input_denied');
    const bytes = await consumeBrowserDirectInput(
      localBrowserPrincipal(device),
      input.workspaceId,
      current.command,
      db,
    );
    try {
      await ownedLocalBrowserOperation(device, input, true, db);
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  if (
    current.command.action.type !== 'upload' ||
    !current.workspace.profile.allowUploads
  )
    throw new RuntimePolicyError('browser_upload_denied');
  const file = await getToolBrokerFile(
    current.workspace.execution_context,
    current.command.action.objectId,
  );
  if (
    file.object.checksum !== current.command.action.checksum ||
    file.object.sizeBytes > current.workspace.profile.maximumFileBytes ||
    file.object.sizeBytes > localBrowserCaptureMaximumBytes
  )
    throw new RuntimePolicyError('browser_upload_denied');
  // Claim consumption before fetching plaintext; a lost response never replays it.
  await db.begin(async (tx) => {
    // INSERT below takes operation KEY SHARE via its FK. It must not first
    // hold browser while a concurrent heartbeat holds operation UPDATE.
    await lockBrowserBindingOperations(
      tx,
      localBrowserPrincipal(device),
      current.snapshot.binding,
    );
    await lockLocalBrowserController(tx, device, input);
    const [claimed] =
      await tx`insert into allrice_local_browser_operation_io(operation_id,organization_id,workspace_id,browser_workspace_id,input_consumed_at)
      values(${input.operationId},${device.organizationId},${device.workspaceId},${input.workspaceId},clock_timestamp()) on conflict do nothing returning operation_id`;
    if (!claimed)
      throw new RuntimePolicyError('browser_input_already_consumed');
  });
  const reader = (await storage.get(file.object)).getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (
        size > file.object.sizeBytes ||
        size > localBrowserCaptureMaximumBytes
      ) {
        await reader.cancel();
        throw new RuntimePolicyError('browser_upload_denied');
      }
      chunks.push(Buffer.from(part.value));
    }
    const bytes = Buffer.concat(chunks);
    try {
      if (
        size !== file.object.sizeBytes ||
        checksum(bytes) !== file.object.checksum
      )
        throw new RuntimePolicyError('browser_upload_denied');
      await ownedLocalBrowserOperation(device, input, true, db);
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}
