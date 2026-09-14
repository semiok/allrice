import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DshProtocolClient } from '../../../apps/worker/src/harness/dsh-protocol-client.ts';
import { observeP27Clients } from './p27-owned-clients.ts';

describe('P27 owned host exit evidence (synthetic process; no provider)', () => {
  it('closes a real spawned host whose initialize never answers, before marking it stopped', async () => {
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
        allStopped: false,
      });
      const stopping = observer.closeAll();
      expect(observer.snapshot().allStopped).toBe(false);
      await stopping;
      await expect(initialization).rejects.toThrow();
      expect(observer.snapshot()).toEqual({
        owned: 1,
        closed: 1,
        allStopped: true,
      });
    } finally {
      await client.close();
      observer.restore();
      await rm(directory, { recursive: true });
    }
  }, 10000);
  it('denies late initialization after stopping and waits for that new owned process to exit', async () => {
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
      ).rejects.toThrow('p27_stopping');
      expect(observer.snapshot()).toEqual({
        owned: 1,
        closed: 1,
        allStopped: true,
      });
    } finally {
      await client.close();
      observer.restore();
      await rm(directory, { recursive: true });
    }
  }, 10000);
});
