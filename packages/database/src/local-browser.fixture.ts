import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  BridgeDeviceSchema,
  BrowserObservationSchema,
  BrowserProfileSchema,
} from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { installLocalBrowserGrant } from './local-browser-grants.ts';
import {
  createLocalBrowserWorkspace,
  claimLocalBrowserWorkspace,
} from './local-browser-workspaces.ts';
import {
  acknowledgeLocalBrowserControl,
  publishLocalBrowserObservation,
} from './local-browser-operations.ts';
import { captureLocalBrowserFile } from './local-browser-files.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

/** Dedicated synthetic Run/job/device with NO folder grant. A later actual
 * Bridge/HTTP acceptance can reuse this helper and its generated device token. */
export async function createLocalBrowserFixture(
  db: ReturnType<typeof postgres>,
  storageRoot: string,
  options: {
    frozen?: boolean;
    claim?: boolean;
    acknowledge?: boolean;
    origin?: string;
    persistLogin?: boolean;
  } = {},
) {
  const f = await createCloudExecutionFixture(db, storageRoot, {
    browserControl: true,
    localBrowser: options.frozen !== false,
  });
  const deviceId = randomUUID(),
    targetId = randomUUID(),
    token = `synthetic-browser-${randomUUID()}`;
  const now = new Date().toISOString();
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    name: 'P22 synthetic Bridge',
    platform: 'macos-arm64',
    protocolVersion: 2,
    capabilities: ['local.fs.list'],
    status: 'online',
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
    values(${deviceId},${f.org},${f.workspace},${f.user},${device.name},${device.platform},2,array['local.fs.list'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
    values(${targetId},${f.org},${f.workspace},${`bridge.${deviceId}`},'rice_bridge','P22 Bridge','online','["files.read"]',${db.json({ bridgeDeviceId: deviceId })})`;
  const profile = BrowserProfileSchema.parse({
    version: 1,
    origins: [options.origin ?? 'https://example.com'],
    allowUploads: true,
    allowDownloads: true,
    allowHumanCredentials: true,
  });
  const grant = await installLocalBrowserGrant(
    f.context,
    { deviceId, profile, persistLogin: options.persistLogin ?? false },
    db,
  );
  const [job] = await db<
    { attempt: number; lease_token: string }[]
  >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
  const open = (callId = randomUUID(), grantId = grant.grantId) =>
    createLocalBrowserWorkspace(
      {
        context: f.execution,
        callId,
        grantId,
        url: profile.origins[0] + '/',
        jobAttempt: job!.attempt,
        jobLeaseToken: job!.lease_token,
      },
      db,
    );
  if (options.frozen === false)
    return {
      ...f,
      device,
      token,
      localGrant: grant,
      open,
      profile,
      browser: null,
    };
  const w = await open();
  const controllerId = randomUUID();
  const claim =
    options.claim === false
      ? null
      : await claimLocalBrowserWorkspace(device, controllerId, true, db);
  const identity = claim?.lease
    ? { workspaceId: w.id, controllerLeaseToken: claim.lease.token }
    : null;
  let revision = 0;
  const observation = async (fence: number, publish = true) => {
    if (!identity) throw Error('controller required');
    const id = randomUUID();
    const bytes = Buffer.from(
      '89504e470d0a1a0a' +
        'synthetic'
          .split('')
          .map((c) => c.charCodeAt(0).toString(16))
          .join(''),
      'hex',
    );
    const capture = await captureLocalBrowserFile(
      device,
      { ...identity, kind: 'screenshot', fence, observationId: id },
      bytes,
      f.storage,
      db,
    );
    const capturedAt = new Date();
    const obs = BrowserObservationSchema.parse({
      version: 1,
      id,
      profileId: w.profile_id,
      fence,
      revision: ++revision,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + 60000).toISOString(),
      url: profile.origins[0] + '/',
      title: 'Synthetic browser',
      text: 'untrusted',
      pageDigest: runtimePolicyDigest('synthetic'),
      screenshotObjectId: capture.objectId,
      elements: [
        {
          id: 'e1',
          tag: 'input',
          label: 'Password',
          inputType: 'password',
          sensitive: true,
        },
        {
          id: 'e2',
          tag: 'button',
          label: 'Save',
          inputType: '',
          sensitive: false,
        },
        {
          id: 'e3',
          tag: 'input',
          label: 'File',
          inputType: 'file',
          sensitive: false,
        },
      ],
    });
    if (publish)
      await publishLocalBrowserObservation(
        device,
        { ...identity, observation: obs },
        db,
      );
    return obs;
  };
  const obs =
    identity && options.acknowledge !== false ? await observation(1) : null;
  if (obs)
    await acknowledgeLocalBrowserControl(
      device,
      { ...identity!, fence: 1, state: 'agent', observationId: obs.id },
      db,
    );
  return {
    ...f,
    device,
    token,
    localGrant: grant,
    open,
    profile,
    browser: {
      w,
      controllerId,
      claim,
      identity,
      observation,
      obs,
      command: {
        version: 1 as const,
        workspaceId: w.id,
        profileId: w.profile_id,
        actor: 'agent' as const,
        fence: 1,
        observationId: obs?.id ?? null,
        action: { type: 'click' as const, elementId: 'e2' },
      },
    },
  };
}
