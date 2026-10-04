import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { journalDispatch } from './journal-fixtures.js';
import { LocalCommandRunner } from './local-command-runner.js';
import { LocalCommandError } from './local-command-inputs.js';
import { LocalProcessManager } from './local-process-manager.js';
import { LocalServiceRunner } from './local-service-runner.js';
import type { bridgeRequest } from './client.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-service-capacity-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    server: 'https://tenant.example',
    deviceId: journalDispatch(root).snapshot.binding.execution.deviceId!,
    deviceName: 'fixture',
    grants: [],
  };
  const journal = await BridgeJournal.open({
    ...config,
    directory: join(root, 'journal'),
  });
  cleanups.push(() => journal.close());
  const dispatch = journalDispatch(root);
  dispatch.payload = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['service.mjs'],
      path: '.',
      files: [{ path: 'service.mjs', sha256: bridgeDigest('synthetic') }],
      imageDigest: localCommandToolchainImageV1,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 10000,
        outputBytes: 8192,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
      background: {
        durationMs: 15000,
        readiness: { kind: 'tcp', port: 3100, path: '/', timeoutMs: 5000 },
        stdin: {
          mode: 'none',
          maxRequests: 1,
          maxBytes: 100,
          requestTimeoutMs: 1000,
        },
      },
    },
  });
  dispatch.snapshot.binding.action = 'local.process.execute';
  dispatch.snapshot.binding.inputDigest = bridgeDigest(dispatch.payload);
  await journal.receive(dispatch);
  await journal.begin(dispatch.snapshot.binding.attempt.operationId);
  const runner = new LocalCommandRunner({
    socketPath: '/synthetic/docker.sock',
    imageDigest: localCommandToolchainImageV1,
  });
  const execute = vi.spyOn(LocalServiceRunner.prototype, 'execute');
  const cleanup = vi.spyOn(runner, 'cleanup');
  const deadline = new Date(Date.now() + 15000).toISOString();
  const request = (async () => ({
    snapshot: { ...dispatch.snapshot, status: 'running' },
    leaseExpiresAt: deadline,
    hardDeadlineAt: deadline,
    acceptedSequence: -1,
    inputs: [],
    stopRequested: false,
  })) as typeof bridgeRequest;
  const manager = new LocalProcessManager({
    journal,
    runner,
    config,
    token: 'fixture',
    request,
  });
  const result = {
    backend: 'local-vm-container-v1' as const,
    containerId: 'a'.repeat(64),
    imageDigest: localCommandToolchainImageV1,
    stopped: true as const,
    exitCode: 0,
    reason: 'exited' as const,
    stdout: '',
    stderr: '',
    truncated: false,
    workCopy: 'local_isolated_copy' as const,
    sourceDirectoryModified: false as const,
  };
  return { root, journal, dispatch, manager, execute, cleanup, result };
}
describe('local service uncertain resource ownership', () => {
  it('preserves a confirmed terminal receipt when resource cleanup fails and does not reuse that Run slot', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue(f.result);
    f.cleanup.mockRejectedValue(Error('owned volume busy'));
    await f.manager.start(f.dispatch, f.root);
    await expect(f.manager.close()).rejects.toThrow('LOCAL_STOP_UNCONFIRMED');
    expect(f.manager.activeCount).toBe(1);
    const receipts = await f.journal.pending();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.signal).toMatchObject({
      type: 'operation.outcome',
      result: { status: 'succeeded' },
    });
    await expect(f.manager.start(f.dispatch, f.root)).rejects.toThrow(
      'SERVICE_CONCURRENCY_LIMIT',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('an unknown execution cannot turn close into successful resource collection', async () => {
    const f = await fixture();
    f.execute.mockRejectedValue(new LocalCommandError('RUNNER_RESULT_UNKNOWN'));
    await f.manager.start(f.dispatch, f.root);
    await expect(f.manager.close()).rejects.toThrow('LOCAL_STOP_UNCONFIRMED');
    expect(f.manager.activeCount).toBe(1);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect((await f.journal.pending())[0]!.signal.type).toBe(
      'operation.uncertain',
    );
  });
  it('confirmed process and resource cleanup releases capacity', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue(f.result);
    f.cleanup.mockResolvedValue(undefined);
    await f.manager.start(f.dispatch, f.root);
    await f.manager.close();
    expect(f.manager.activeCount).toBe(0);
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
});
