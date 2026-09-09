import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserObservationSchema,
  BrowserProfileSchema,
  LocalPreviewLeaseSchema,
  localPreviewOrigin,
  type LocalBrowserWorkspace,
} from '@allrice/contracts';
import { journalDispatch } from './journal-fixtures.js';
import { LocalBrowserController } from './local-browser-controller.js';
import { LocalBrowserOutbox } from './local-browser-outbox.js';
import { LocalBrowserProfiles } from './local-browser-profiles.js';
import { LocalCommandRunner } from './local-command-runner.js';
import type { LocalBrowserAuthority } from './local-browser-client.js';
import type {
  LocalBrowserDriver,
  startLocalBrowserDriver,
} from './local-browser-driver.js';
import { testImage, testSocket } from '../test/toolchain.js';

const roots: string[] = [];
const controllers: LocalBrowserController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0))
    await controller.stop().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Unit authority/renderer ports only; the adjacent native integration suite
 * supplies the real VM, Chromium and supervisor. No security CLI or user data. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p23-controller-'));
  roots.push(root);
  const task = journalDispatch(root).snapshot.binding;
  const endpointId = randomUUID();
  const workspace: LocalBrowserWorkspace = {
    id: randomUUID(),
    scope: task.task.scope,
    ownerId: task.requestedBy.id,
    deviceId: task.execution.deviceId!,
    runId: task.task.runId,
    rootRunId: task.task.rootRunId,
    sessionId: task.task.chatSessionId!,
    profileId: randomUUID(),
    logicalProfileId: randomUUID(),
    grantId: randomUUID(),
    grantRevision: 1,
    persistLogin: false,
    profile: BrowserProfileSchema.parse({
      version: 1,
      origins: [localPreviewOrigin(endpointId)],
    }),
    fence: 1,
    acknowledgedFence: 0,
    state: 'starting',
    desiredControl: 'agent',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    revoked: false,
  };
  workspace.preview = LocalPreviewLeaseSchema.parse({
    target: {
      version: 1,
      endpointId,
      scope: workspace.scope,
      ownerId: workspace.ownerId,
      deviceId: workspace.deviceId,
      runId: workspace.runId,
      rootRunId: workspace.rootRunId,
      browserWorkspaceId: workspace.id,
      browserProfileId: workspace.profileId,
      browserGrantId: workspace.grantId,
      processId: randomUUID(),
      attemptId: randomUUID(),
      generation: 1,
      fence: 1,
      processInputDigest: 'sha256:' + '1'.repeat(64),
      folderGrantId: randomUUID(),
      folderGrantVersion: 1,
      containerId: 'a'.repeat(64),
      imageDigest: testImage,
      port: 3100,
      hardDeadlineAt: workspace.expiresAt,
    },
    endpointLeaseId: randomUUID(),
    expiresAt: new Date(Date.now() + 4800).toISOString(),
  });
  const lease = {
    workspaceId: workspace.id,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  };
  let previewEnabled = true;
  const enabled = vi.fn(async () => previewEnabled);
  const authority: LocalBrowserAuthority = {
    claim: vi.fn(async (_id, acceptWork, acceptPreview) => ({
      workspace:
        acceptWork && acceptPreview ? structuredClone(workspace) : null,
      lease: acceptWork && acceptPreview ? { ...lease } : null,
      revocations: [],
    })),
    heartbeat: vi.fn(async () => ({
      workspace: structuredClone(workspace),
      lease: { ...lease, expiresAt: new Date(Date.now() + 5000).toISOString() },
    })),
    next: vi.fn(async () => null),
    start: vi.fn(async () => {
      throw Error('no operation authorized in this fixture');
    }),
    acknowledge: vi.fn(async (request) => {
      if (request.kind === 'control_ack') {
        workspace.state = request.state;
        workspace.acknowledgedFence = request.fence;
      }
    }),
    requestPermission: vi.fn(async () => {
      throw Error('no network request authorized in this fixture');
    }),
    takeInput: vi.fn(async () => {
      throw Error('preview has no private input capability');
    }),
    capture: vi.fn(async () => randomUUID()),
  };
  const driver: LocalBrowserDriver = {
    observe: vi.fn(async (fence) => ({
      observation: BrowserObservationSchema.parse({
        version: 1,
        id: randomUUID(),
        profileId: workspace.profileId,
        fence,
        revision: 1,
        capturedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10000).toISOString(),
        url: 'about:blank',
        title: '',
        text: '',
        pageDigest: 'sha256:' + 'b'.repeat(64),
        elements: [],
        screenshotObjectId: null,
      }),
      screenshot: Buffer.from('synthetic screenshot'),
    })),
    perform: vi.fn(async () => ({})),
    close: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => {}),
  };
  let input!: Parameters<typeof startLocalBrowserDriver>[0];
  const startDriver = vi.fn(async (value: typeof input) => {
    input = value;
    expect(await value.preview?.current()).toEqual(workspace.preview);
    return driver;
  });
  const controller = new LocalBrowserController({
    deviceId: workspace.deviceId,
    authority,
    profiles: new LocalBrowserProfiles(
      join(root, 'config.json'),
      'https://saas.example',
    ),
    outbox: new LocalBrowserOutbox(
      join(root, 'config.json'),
      'https://saas.example',
      workspace.deviceId,
    ),
    enabled: async () => true,
    paired: async () => true,
    preview: {
      enabled,
      // Constructed only: no Docker preflight/exec happens in these unit tests.
      runner: new LocalCommandRunner({
        socketPath: testSocket,
        imageDigest: testImage,
      }),
    },
    startDriver,
  });
  controllers.push(controller);
  return {
    controller,
    workspace,
    authority,
    driver,
    startDriver,
    enabled,
    input: () => input,
    disable: () => {
      previewEnabled = false;
    },
    forceClaim: () =>
      vi.mocked(authority.claim).mockResolvedValue({
        workspace: structuredClone(workspace),
        lease: { ...lease },
        revocations: [],
      }),
  };
}

describe('P23 preview opt-in and exact target controller authority', () => {
  it('does not advertise preview or start a driver without explicit local opt-in', async () => {
    const f = await fixture();
    f.disable();
    await f.controller.pollOnce();
    expect(f.authority.claim).toHaveBeenCalledWith(
      f.controller.controllerId,
      true,
      false,
    );
    expect(f.startDriver).not.toHaveBeenCalled();
  });
  it('keeps the real target unchanged and publishes fresh observation before control ACK', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    expect(f.authority.claim).toHaveBeenCalledWith(
      f.controller.controllerId,
      true,
      true,
    );
    expect(f.startDriver).toHaveBeenCalledOnce();
    expect(f.input().leaseExpiresAt()).toBe(
      Date.parse(f.workspace.preview!.expiresAt),
    );
    expect(
      vi.mocked(f.authority.acknowledge).mock.calls.map(([r]) => r.kind),
    ).toEqual(['observation', 'control_ack']);
    expect(f.driver.perform).not.toHaveBeenCalled();
  });
  it('preview opt-out immediately closes and stops renewing the active workspace', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    vi.mocked(f.authority.heartbeat).mockClear();
    f.disable();
    await f.controller.heartbeat();
    expect(f.driver.close).toHaveBeenCalledWith('lost');
    expect(f.authority.heartbeat).not.toHaveBeenCalled();
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stopped', confirmed: true }),
    );
    await f.controller.pollOnce();
    expect(f.authority.claim).toHaveBeenLastCalledWith(
      f.controller.controllerId,
      true,
      false,
    );
    expect(f.startDriver).toHaveBeenCalledOnce();
  });
  it('opt-out during initial validation retires the unstarted workspace, not a sticky active lease', async () => {
    const f = await fixture();
    f.enabled.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(f.controller.pollOnce()).rejects.toThrow(
      'LOCAL_BROWSER_LEASE_LOST',
    );
    expect(f.startDriver).not.toHaveBeenCalled();
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stopped', confirmed: true }),
    );
    await f.controller.pollOnce();
    expect(f.authority.claim).toHaveBeenCalledTimes(2);
    expect(f.authority.heartbeat).not.toHaveBeenCalled();
  });
  it.each([
    'deviceId',
    'ownerId',
    'runId',
    'rootRunId',
    'browserWorkspaceId',
    'browserProfileId',
    'browserGrantId',
  ] as const)(
    'rejects the initial preview when target %s belongs elsewhere before launching anything',
    async (field) => {
      const f = await fixture();
      f.workspace.preview!.target[field] = randomUUID();
      await expect(f.controller.pollOnce()).rejects.toThrow(
        'LOCAL_BROWSER_LEASE_LOST',
      );
      expect(f.startDriver).not.toHaveBeenCalled();
      expect(f.authority.acknowledge).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'stopped', confirmed: true }),
      );
    },
  );
  it.each(['generation', 'container', 'lease'] as const)(
    'a renewed controller lease cannot replace immutable preview %s',
    async (field) => {
      const f = await fixture();
      await f.controller.pollOnce();
      if (field === 'generation') f.workspace.preview!.target.generation++;
      if (field === 'container')
        f.workspace.preview!.target.containerId = 'c'.repeat(64);
      if (field === 'lease')
        f.workspace.preview!.endpointLeaseId = randomUUID();
      await f.controller.heartbeat();
      expect(f.driver.close).toHaveBeenCalledOnce();
      expect(f.driver.perform).not.toHaveBeenCalled();
      expect(f.authority.acknowledge).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'stopped', confirmed: true }),
      );
    },
  );
  it.each([
    'persistLogin',
    'allowUploads',
    'allowDownloads',
    'allowHumanCredentials',
  ] as const)(
    'does not inherit %s into a development preview',
    async (field) => {
      const f = await fixture();
      if (field === 'persistLogin') f.workspace.persistLogin = true;
      else f.workspace.profile[field] = true;
      await expect(f.controller.pollOnce()).rejects.toThrow(
        'LOCAL_BROWSER_LEASE_LOST',
      );
      expect(f.startDriver).not.toHaveBeenCalled();
    },
  );
  it('an expired preview cannot borrow the longer browser controller lease', async () => {
    const f = await fixture();
    f.workspace.preview!.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(f.controller.pollOnce()).rejects.toThrow(
      'LOCAL_BROWSER_LEASE_LOST',
    );
    expect(f.startDriver).not.toHaveBeenCalled();
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stopped', confirmed: true }),
    );
  });
  it('a close failure remains cleanup pending and never starts another preview', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    vi.mocked(f.driver.close).mockRejectedValue(
      Error('synthetic-private-path'),
    );
    f.disable();
    await f.controller.heartbeat();
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stopped',
        confirmed: false,
        errorCode: 'LOCAL_BROWSER_CLEANUP_PENDING',
      }),
    );
    await f.controller.pollOnce();
    expect(f.startDriver).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(vi.mocked(f.authority.acknowledge).mock.calls),
    ).not.toContain('synthetic-private-path');
  });
});
