import { randomUUID, createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  BridgeDeviceSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { createLocalPreviewWorkspace } from './local-preview.ts';

/** Real DB admission/approval/START/service-event path; synthetic process facts.
 * Native Docker/Chrome is deliberately a separate physical acceptance gate. */
export async function createLocalPreviewFixture(
  db: ReturnType<typeof postgres>,
  storageRoot: string,
  options: { frozen?: boolean; kind?: 'http' | 'tcp'; ready?: boolean } = {},
) {
  const f = await createCloudExecutionFixture(db, storageRoot, {
    browserControl: true,
    localBrowser: true,
    localProcess: true,
    localPreview: options.frozen !== false,
  });
  const deviceId = randomUUID(),
    targetId = randomUUID(),
    folderId = randomUUID(),
    token = `synthetic-preview-${randomUUID()}`;
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    name: 'P23 synthetic Bridge',
    platform: 'macos-arm64',
    protocolVersion: 2,
    capabilities: ['local.fs.list'],
    status: 'online',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
  });
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
    values(${deviceId},${f.org},${f.workspace},${f.user},${device.name},${device.platform},2,array['local.fs.list'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
    values(${targetId},${f.org},${f.workspace},${`bridge.${deviceId}`},'rice_bridge','P23 Bridge','online','["files.read"]',${db.json({ bridgeDeviceId: deviceId })})`;
  await db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
    values(${folderId},${f.org},${f.workspace},${f.user},${deviceId},'P23 synthetic folder',${'a'.repeat(64)})`;
  await reportLocalCommandProfile(
    device,
    {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      architecture: 'arm64',
      available: true,
      imageDigest: localCommandToolchainImageV1,
      features: ['background_services'],
    },
    db,
  );
  const created = await createLocalCommandOperation(
    {
      context: f.execution,
      callId: 'p23-service',
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['service.mjs'],
        path: '.',
        files: [{ path: 'service.mjs', sha256: `sha256:${'b'.repeat(64)}` }],
        limits: {
          timeoutMs: 10000,
          outputBytes: 4096,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
        background: {
          durationMs: 60000,
          readiness: {
            kind: options.kind ?? 'http',
            port: 3100,
            path: '/',
            timeoutMs: 5000,
          },
          stdin: {
            mode: 'none',
            maxRequests: 1,
            maxBytes: 100,
            requestTimeoutMs: 10000,
          },
        },
      },
    },
    db,
  );
  await f.approve(created);
  const scope = created.snapshot.binding.task.scope,
    processId = created.snapshot.binding.attempt.operationId;
  const claim = await created.ledger.claimNextBridgeOperation({
    scope,
    deviceId,
    leaseMs: 30000,
    supportsLocalCommand: true,
    supportsBackgroundServices: true,
  });
  if (!claim) throw Error('synthetic service claim denied');
  const base = {
    scope,
    operationId: processId,
    leaseToken: claim.leaseToken,
    attempt: claim.snapshot.binding.attempt,
  };
  await created.ledger.startOperation({ ...base, receiptId: randomUUID() });
  const exchange = (
    events: Parameters<
      typeof created.ledger.exchangeLocalService
    >[0]['events'] = [],
  ) => created.ledger.exchangeLocalService({ ...base, events });
  const initialized = await exchange();
  await exchange([
    {
      processId,
      attemptId: base.attempt.attemptId,
      sequence: 0,
      type: 'starting',
      containerId: 'c'.repeat(64),
      hardDeadlineAt: initialized.hardDeadlineAt,
    },
    ...(options.ready === false
      ? []
      : [
          {
            processId,
            attemptId: base.attempt.attemptId,
            sequence: 1,
            type: 'ready' as const,
            port: 3100,
            visibility: 'container_only' as const,
          },
        ]),
  ]);
  const [job] = await db<
    { attempt: number; lease_token: string }[]
  >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
  const open = () =>
    createLocalPreviewWorkspace(
      {
        context: f.execution,
        processId,
        jobAttempt: job!.attempt,
        jobLeaseToken: job!.lease_token,
      },
      db,
    );
  return {
    ...f,
    device,
    token,
    targetId,
    folderId,
    created,
    processId,
    base,
    exchange,
    open,
  };
}
