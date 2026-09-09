import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserObservationSchema,
  BrowserProfileSchema,
  LocalBrowserOperationSchema,
  localBrowserProfileBinding,
  type LocalBrowserReceipt,
  type LocalBrowserWorkspace,
} from '@allrice/contracts';
import { bridgeDigest } from './journal.js';
import { journalDispatch } from './journal-fixtures.js';
import { LocalBrowserController } from './local-browser-controller.js';
import { LocalBrowserOutbox } from './local-browser-outbox.js';
import { LocalBrowserProfiles } from './local-browser-profiles.js';
import type { LocalBrowserAuthority } from './local-browser-client.js';
import { LocalBrowserTransportError } from './local-browser-client.js';
import type {
  LocalBrowserDriver,
  startLocalBrowserDriver,
} from './local-browser-driver.js';

const roots: string[] = [];
const controllers: LocalBrowserController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0))
    await controller.stop().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p22-controller-'));
  roots.push(root);
  const snapshot = journalDispatch(root).snapshot;
  const workspace: LocalBrowserWorkspace = {
    id: randomUUID(),
    scope: snapshot.binding.task.scope,
    ownerId: snapshot.binding.requestedBy.id,
    deviceId: snapshot.binding.execution.deviceId!,
    runId: snapshot.binding.task.runId,
    rootRunId: snapshot.binding.task.rootRunId,
    sessionId: snapshot.binding.task.chatSessionId!,
    profileId: randomUUID(),
    logicalProfileId: randomUUID(),
    grantId: snapshot.binding.execution.grantId,
    grantRevision: 1,
    persistLogin: false,
    profile: BrowserProfileSchema.parse({
      version: 1,
      origins: ['https://site.example'],
    }),
    fence: 1,
    acknowledgedFence: 0,
    state: 'starting',
    desiredControl: 'agent',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    revoked: false,
  };
  const lease = {
    workspaceId: workspace.id,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  };
  const outbox = new LocalBrowserOutbox(
    join(root, 'config.json'),
    'https://saas.example',
    workspace.deviceId,
  );
  const profiles = new LocalBrowserProfiles(
    join(root, 'config.json'),
    'https://saas.example',
  );
  const command = {
    version: 1 as const,
    workspaceId: workspace.id,
    profileId: workspace.profileId,
    actor: 'agent' as const,
    fence: 1,
    observationId: null,
    action: { type: 'navigate' as const, url: 'https://site.example/' },
  };
  snapshot.binding.execution.workCopy = {
    id: workspace.profileId,
    kind: 'local_copy',
  };
  snapshot.binding.execution.scopeDigest = bridgeDigest(workspace.profile);
  snapshot.binding.action = 'local.browser.act';
  snapshot.binding.inputDigest = bridgeDigest(command);
  const operation = LocalBrowserOperationSchema.parse({
    snapshot,
    command,
    observation: null,
  });
  const receipts: LocalBrowserReceipt[] = [];
  let allowed = true,
    paired = true,
    first = true;
  const authority: LocalBrowserAuthority = {
    claim: vi.fn(async (_id, acceptWork) => ({
      workspace: acceptWork ? structuredClone(workspace) : null,
      lease: acceptWork ? { ...lease } : null,
      revocations: [],
    })),
    heartbeat: vi.fn(async () => ({
      workspace: structuredClone(workspace),
      lease: { ...lease, expiresAt: new Date(Date.now() + 5000).toISOString() },
    })),
    next: vi.fn(async () => {
      if (!first) return null;
      first = false;
      return structuredClone(operation);
    }),
    start: vi.fn(async () => ({
      snapshot: { ...snapshot, status: 'running' as const },
      mayExecute: true,
      operationLeaseToken: randomUUID(),
    })),
    acknowledge: vi.fn(async (request) => {
      if (request.kind === 'control_ack') {
        workspace.state = request.state;
        workspace.acknowledgedFence = request.fence;
      }
      if (request.kind === 'receipt') {
        const { kind, ...receipt } = request;
        expect(kind).toBe('receipt');
        receipts.push(receipt);
      }
    }),
    requestPermission: vi.fn(async () => ({
      operationId: randomUUID(),
      permissionToken: randomUUID(),
      status: 'ready' as const,
    })),
    takeInput: vi.fn(async () => Buffer.from('synthetic-private')),
    capture: vi.fn(async () => randomUUID()),
  };
  let options: Parameters<typeof startLocalBrowserDriver>[0]['options'];
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
        pageDigest: 'sha256:' + 'a'.repeat(64),
        elements: [],
        screenshotObjectId: null,
      }),
      screenshot: Buffer.from('synthetic-image'),
    })),
    perform: vi.fn(async () => {
      const saved = await outbox.pending();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.status).toBe('unknown');
      return {};
    }),
    close: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => {}),
  };
  const startDriver = vi.fn(
    async (input: Parameters<typeof startLocalBrowserDriver>[0]) => {
      options = input.options;
      return driver;
    },
  );
  const controller = new LocalBrowserController({
    deviceId: workspace.deviceId,
    authority,
    profiles,
    outbox,
    enabled: async () => allowed,
    paired: async () => paired,
    startDriver,
  });
  controllers.push(controller);
  return {
    root,
    controller,
    workspace,
    operation,
    authority,
    outbox,
    profiles,
    driver,
    receipts,
    startDriver,
    options: () => options,
    disable: () => {
      allowed = false;
    },
    unpair: () => {
      paired = false;
    },
  };
}
describe('P22 local controller with durable outbox and strict authority port', () => {
  it('startup with unconfirmed process cleanup never acknowledges a clean stop or starts another instance', async () => {
    const f = await fixture();
    f.startDriver.mockRejectedValue(Error('LOCAL_BROWSER_CLEANUP_PENDING'));
    await expect(f.controller.pollOnce()).rejects.toThrow(
      'LOCAL_BROWSER_LEASE_LOST',
    );
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stopped',
        confirmed: false,
        errorCode: 'LOCAL_BROWSER_CLEANUP_PENDING',
      }),
    );
    await f.controller.pollOnce();
    expect(f.startDriver).toHaveBeenCalledOnce();
    expect(f.driver.perform).not.toHaveBeenCalled();
  });
  it('publishes fresh screenshot/observation before initial control ACK and persists UNKNOWN before I/O', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    const calls = vi
      .mocked(f.authority.acknowledge)
      .mock.calls.map(([request]) => request.kind);
    expect(calls.slice(0, 2)).toEqual(['observation', 'control_ack']);
    await f.controller.pollOnce();
    expect(f.driver.perform).toHaveBeenCalledOnce();
    expect(f.receipts[0]?.status).toBe('succeeded');
    expect(await f.outbox.pending()).toEqual([]);
  });
  it('duplicate or unapproved START never invokes the renderer', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    vi.mocked(f.authority.start).mockResolvedValue({
      snapshot: f.operation.snapshot,
      mayExecute: false,
      operationLeaseToken: randomUUID(),
    });
    await f.controller.pollOnce();
    expect(f.driver.perform).not.toHaveBeenCalled();
    expect(await f.outbox.pending()).toEqual([]);
  });
  it('lost renderer response remains UNKNOWN, stops the instance, and never logs raw error', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    vi.mocked(f.driver.perform).mockRejectedValue(
      Error('synthetic-secret-raw-url'),
    );
    await f.controller.pollOnce();
    expect(f.receipts[0]?.status).toBe('unknown');
    expect(JSON.stringify(f.receipts)).not.toContain('synthetic-secret');
    expect(f.driver.close).toHaveBeenCalledWith('lost');
  });
  it('unknown network completion cannot become a successful parent click', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    vi.mocked(f.driver.perform).mockImplementation(async () => {
      const permission = await f.options().requestApproval({
        url: 'https://site.example/',
        urlDigest: 'sha256:' + 'a'.repeat(64),
        method: 'POST',
        bodyDigest: 'sha256:' + 'b'.repeat(64),
        bodyBytes: 2,
      });
      f.options().requestSent();
      await permission.complete(false);
      return {};
    });
    await f.controller.pollOnce();
    expect(f.receipts[0]).toMatchObject({
      status: 'unknown',
      networkEffect: true,
    });
  });
  it('control handover observes new fence before acknowledging and rejects old command without START', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    f.workspace.fence = 2;
    f.workspace.state = 'takeover_pending';
    f.workspace.desiredControl = 'human';
    await f.controller.heartbeat();
    await f.controller.pollOnce();
    expect(f.driver.observe).toHaveBeenLastCalledWith(2);
    await expect(f.controller.pollOnce()).rejects.toThrow();
    expect(f.authority.start).not.toHaveBeenCalled();
  });
  it.each(['disable', 'unpair'] as const)(
    'local %s closes actual controller without granting new work',
    async (operation) => {
      const f = await fixture();
      await f.controller.pollOnce();
      f[operation]();
      await f.controller.heartbeat();
      expect(f.driver.close).toHaveBeenCalledOnce();
      await f.controller.pollOnce();
      if (operation === 'unpair')
        expect(f.authority.claim).toHaveBeenCalledOnce();
      else
        expect(f.authority.claim).toHaveBeenLastCalledWith(
          f.controller.controllerId,
          false,
        );
    },
  );
  it('401 while idle cleans the original device index locally without inventing a cloud cleanup ACK', async () => {
    const f = await fixture();
    const binding = localBrowserProfileBinding(f.workspace);
    await f.profiles.save(
      { ...binding, persistLogin: true },
      f.workspace.profile,
      { cookies: [], origins: [] },
    );
    vi.mocked(f.authority.claim).mockRejectedValue(
      new LocalBrowserTransportError(401),
    );
    await expect(f.controller.pollOnce()).rejects.toThrow(
      'LOCAL_BROWSER_AUTHORITY_UNAVAILABLE',
    );
    await expect(
      f.profiles.load({ ...binding, persistLogin: true }, f.workspace.profile),
    ).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
    expect(f.authority.acknowledge).not.toHaveBeenCalled();
    await f.controller.pollOnce();
    expect(f.authority.claim).toHaveBeenCalledOnce();
  });
  it('process recovery only delivers existing UNKNOWN and cannot execute it', async () => {
    const f = await fixture();
    f.disable();
    const receipt: LocalBrowserReceipt = {
      workspaceId: f.workspace.id,
      controllerLeaseToken: randomUUID(),
      operationId: randomUUID(),
      operationLeaseToken: randomUUID(),
      receiptId: randomUUID(),
      status: 'unknown',
      networkEffect: false,
      observationId: null,
      downloadObjectId: null,
      errorCode: 'LOCAL_BROWSER_IO_UNKNOWN',
    };
    await f.outbox.prepare(receipt);
    await f.controller.pollOnce();
    expect(f.receipts).toEqual([receipt]);
    expect(f.startDriver).not.toHaveBeenCalled();
    expect(await f.outbox.pending()).toEqual([]);
  });
  it('opt-out still processes revocations and writes secret-free cleanup evidence', async () => {
    const f = await fixture();
    f.disable();
    const binding = localBrowserProfileBinding(f.workspace);
    vi.mocked(f.authority.claim).mockResolvedValue({
      workspace: null,
      lease: null,
      revocations: [binding],
    });
    await f.controller.pollOnce();
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'revoke_ack', confirmed: true }),
    );
    await expect(f.profiles.load(binding, f.workspace.profile)).rejects.toThrow(
      'LOCAL_BROWSER_POLICY_DENIED',
    );
  });
  it('failed close cannot be acknowledged as stopped or retried as success', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    vi.mocked(f.driver.close).mockRejectedValue(
      Error('synthetic-private-path'),
    );
    await expect(f.controller.stop()).rejects.toThrow(
      'LOCAL_BROWSER_CLEANUP_PENDING',
    );
    expect(f.authority.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stopped',
        confirmed: false,
        errorCode: 'LOCAL_BROWSER_CLEANUP_PENDING',
      }),
    );
  });
  it('mutated command bytes fail before START even when the requested scope looks valid', async () => {
    const f = await fixture();
    await f.controller.pollOnce();
    f.operation.command.action = {
      type: 'navigate',
      url: 'https://site.example/mutated',
    };
    await expect(f.controller.pollOnce()).rejects.toThrow();
    expect(f.authority.start).not.toHaveBeenCalled();
  });
});
