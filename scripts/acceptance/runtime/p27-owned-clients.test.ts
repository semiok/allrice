import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DshProtocolClient } from '../../../apps/worker/src/harness/dsh-protocol-client.ts';
import { observeP27Clients } from './p27-owned-clients.ts';

async function reap(client: DshProtocolClient) {
  // Synthetic never-initialized children cannot provide the new semantic ack.
  // Test teardown may accept only their witnessed physical exit, not success.
  await client.close().catch(() => {});
  expect(client.processState()).toMatchObject({
    state: 'exited',
    stdioClosed: true,
  });
}

describe('P27 owned host exit evidence (synthetic process; no provider)', () => {
  it('reaps a never-initialized child but preserves unconfirmed semantic close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-p27-client-test-'));
    const observer = observeP27Clients(DshProtocolClient);
    const client = new DshProtocolClient({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'],
      cwd: directory,
      environment: {},
      requestTimeoutMs: 30000,
    });
    const initialization = client.initialize({
      cwd: directory,
      provider: 'synthetic',
      model: 'never-called',
    });
    initialization.catch(() => {});
    try {
      expect(observer.snapshot()).toEqual({
        owned: 1,
        closed: 0,
        physicallyExited: 0,
        closeUnconfirmed: 0,
        allStopped: false,
        allPhysicallyExited: false,
      });
      const stopping = observer.closeAll();
      expect(observer.snapshot().allStopped).toBe(false);
      await expect(stopping).rejects.toMatchObject({
        errors: [
          {
            code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
            evidence: {
              process: { state: 'exited', stdioClosed: true },
              shutdownAcknowledged: false,
              wrapperCleanupConfirmed: false,
            },
          },
        ],
      });
      await expect(initialization).rejects.toThrow();
      expect(observer.snapshot()).toEqual({
        owned: 1,
        closed: 0,
        physicallyExited: 1,
        closeUnconfirmed: 1,
        allStopped: false,
        allPhysicallyExited: true,
      });
      await expect(observer.closeAll()).rejects.toThrow(
        'P27 owned close remains unconfirmed',
      );
    } finally {
      try {
        await reap(client);
      } finally {
        observer.restore();
        await rm(directory, { recursive: true });
      }
    }
  }, 10000);
  it('denies late initialization and retains its separate physical-exit and unconfirmed-close facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-p27-client-test-'));
    const observer = observeP27Clients(DshProtocolClient);
    await observer.closeAll();
    const client = new DshProtocolClient({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'],
      cwd: directory,
      environment: {},
      requestTimeoutMs: 30000,
    });
    try {
      await expect(
        client.initialize({
          cwd: directory,
          provider: 'synthetic',
          model: 'never-called',
        }),
      ).rejects.toMatchObject({
        message: 'p27_stopping',
        cause: {
          code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
          evidence: {
            process: { state: 'exited', stdioClosed: true },
            shutdownAcknowledged: false,
            wrapperCleanupConfirmed: false,
          },
        },
      });
      expect(observer.snapshot()).toEqual({
        owned: 1,
        closed: 0,
        physicallyExited: 1,
        closeUnconfirmed: 1,
        allStopped: false,
        allPhysicallyExited: true,
      });
    } finally {
      try {
        await reap(client);
      } finally {
        observer.restore();
        await rm(directory, { recursive: true });
      }
    }
  }, 10000);
});
