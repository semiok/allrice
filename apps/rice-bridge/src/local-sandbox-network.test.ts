import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { journalDispatch } from './journal-fixtures.js';
import { expect, it, vi } from 'vitest';
import * as networkRuntime from '@allrice/project-runtime';
import { LocalDockerApi } from './local-docker-api.js';
import {
  RuntimeLocalCommandSchema,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  type SandboxNetworkLease,
} from '@allrice/contracts';
import {
  LocalSandboxNetwork,
  requireLocalSandboxNetwork,
  unconfirmedLocalNetworkOutcome,
} from './local-sandbox-network.js';
function fixture() {
  const network = {
      mode: 'controlled_https' as const,
      origins: ['https://pypi.org'],
    },
    execution = { version: 1 as const, kind: 'compute' as const },
    grant = {
      id: randomUUID(),
      version: 1,
      digest: 'sha256:' + 'a'.repeat(64),
    };
  const payload = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    executionBudget: sandboxExecutionBudgetSpec(
      execution,
      resolveSandboxExecutionPolicy([]),
    ),
    networkGrant: grant,
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['main.js'],
      path: '.',
      files: [{ path: 'main.js', sha256: 'sha256:' + 'b'.repeat(64) }],
      network,
      execution,
      imageDigest: 'sha256:' + 'c'.repeat(64),
      isolation: 'local-vm-container-v1',
      limits: {
        timeoutMs: 1000,
        outputBytes: 4096,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
    },
  });
  const lease: SandboxNetworkLease = {
    version: 1,
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    runId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    target: { kind: 'bridge', targetId: randomUUID(), deviceId: randomUUID() },
    policyDigest: grant.digest,
    grantId: grant.id,
    grantVersion: grant.version,
    network,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maximumConnections: 8,
    maximumBytes: 10000,
  };
  return { payload, lease };
}
it.each([
  'absent',
  'cloud',
  'old-grant',
  'other-attempt',
  'wider-origins',
  'expired',
])('rejects a %s lease before physical setup', (mode) => {
  const { payload, lease } = fixture(),
    attempt = lease.attemptId;
  if (mode === 'cloud')
    lease.target = { kind: 'cloud', targetId: randomUUID() };
  if (mode === 'old-grant') lease.grantVersion++;
  if (mode === 'other-attempt') lease.attemptId = randomUUID();
  if (mode === 'wider-origins')
    lease.network = {
      ...lease.network,
      origins: [...lease.network.origins, 'https://example.com'],
    };
  if (mode === 'expired')
    lease.expiresAt = new Date(Date.now() - 1).toISOString();
  expect(() =>
    requireLocalSandboxNetwork(
      payload,
      mode === 'absent' ? undefined : lease,
      attempt,
    ),
  ).toThrow('SANDBOX_NETWORK_DENIED');
});
it('does not conflate process exit with the outcome of an external request', () => {
  const { payload, lease } = fixture();
  expect(() =>
    requireLocalSandboxNetwork(payload, lease, lease.attemptId),
  ).not.toThrow();
  expect(
    unconfirmedLocalNetworkOutcome(payload, {
      reason: 'lease_lost',
      exitCode: 137,
      network: { sentBytes: 100 },
    }),
  ).toBe(true);
  expect(
    unconfirmedLocalNetworkOutcome(payload, {
      reason: 'supervisor_failed',
      exitCode: 125,
    }),
  ).toBe(true);
  expect(
    unconfirmedLocalNetworkOutcome(payload, {
      reason: 'exited',
      exitCode: 1,
      network: { sentBytes: 0 },
    }),
  ).toBe(false);
  expect(
    unconfirmedLocalNetworkOutcome(payload, {
      reason: 'exited',
      exitCode: 0,
      network: { sentBytes: 100 },
      errorCode: 'SANDBOX_NETWORK_REVOKED',
    }),
  ).toBe(true);
});

it('keeps a network outcome uncertain after restart even when physical recovery finds exit zero', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bridge-network-recovery-')),
  );
  let journal: BridgeJournal | undefined;
  try {
    const { payload } = fixture(),
      original = journalDispatch(root);
    const dispatch = {
      ...original,
      payload,
      snapshot: {
        ...original.snapshot,
        binding: {
          ...original.snapshot.binding,
          action: payload.capability,
          inputDigest: bridgeDigest(payload),
          command: {
            executableDigest: payload.networkGrant!.digest,
            argumentsDigest: payload.networkGrant!.digest,
            workingDirectoryDigest: payload.networkGrant!.digest,
            effectiveEnvironmentDigest: payload.networkGrant!.digest,
            networkPolicyDigest: payload.networkGrant!.digest,
            toolchainDigest: payload.networkGrant!.digest,
            budgetDigest: payload.networkGrant!.digest,
          },
        },
      },
    };
    const operationId = dispatch.snapshot.binding.attempt.operationId;
    journal = await BridgeJournal.open({
      directory: join(root, 'journal'),
      server: 'https://tenant.example',
      deviceId: dispatch.snapshot.binding.execution.deviceId!,
    });
    await journal.receive(dispatch);
    await journal.begin(operationId);
    await journal.uncertain(operationId, 'connection_lost');
    const result = {
      backend: 'local-vm-container-v1' as const,
      containerId: 'a'.repeat(64),
      imageDigest: payload.arguments.imageDigest,
      stopped: true as const,
      exitCode: 0,
      reason: 'exited' as const,
      stdout: '',
      stderr: '',
      truncated: false,
      workCopy: 'local_isolated_copy' as const,
      sourceDirectoryModified: false as const,
    };
    await expect(
      journal.reconcileLocalCommand(operationId, result),
    ).rejects.toThrow('JOURNAL_NETWORK_RECONCILIATION_REQUIRED');
    expect(await journal.unknownLocalCommands()).toHaveLength(1);
  } finally {
    await journal?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'fences a revoked relay only while the physical container is running (%s)',
  async (running) => {
    const { lease } = fixture(),
      id = 'a'.repeat(64),
      stop = vi.fn(async () => {}),
      allowExecution = vi.fn(async () => {});
    let closed: ((code: 'SANDBOX_NETWORK_REVOKED') => void) | undefined;
    const mock = vi
      .spyOn(networkRuntime, 'openSandboxNetwork')
      .mockImplementation(async (_api, input) => {
        closed = input.onClosed;
        return {
          observation: {
            sentBytes: 12,
            receivedBytes: 24,
            openedConnections: 1,
          },
          close: () => {},
        } as never;
      });
    const api = new LocalDockerApi('/synthetic/docker.sock');
    const inspect = vi
      .spyOn(api, 'json')
      .mockResolvedValue({
        Id: id,
        Config: { Labels: { 'xyz.bplabs.allrice.attempt': lease.attemptId } },
        HostConfig: { NetworkMode: 'none', Privileged: false },
        State: { Running: running },
      });
    const session = new LocalSandboxNetwork({
      api,
      containerId: id,
      attemptId: lease.attemptId,
      lease,
      signal: new AbortController().signal,
      maintainLease: async () => true,
      stop,
      allowExecution,
      relayRuntime: 'node',
    });
    try {
      await session.start();
      expect(allowExecution).toHaveBeenCalledOnce();
      closed!('SANDBOX_NETWORK_REVOKED');
      await vi.waitFor(() => expect(inspect).toHaveBeenCalled());
      if (running) {
        await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('lease_lost'));
        expect(session.evidence.errorCode).toBe('SANDBOX_NETWORK_REVOKED');
      } else {
        expect(stop).not.toHaveBeenCalled();
        expect(session.evidence.errorCode).toBeUndefined();
      }
    } finally {
      await session.finish();
      mock.mockRestore();
      inspect.mockRestore();
    }
  },
);
