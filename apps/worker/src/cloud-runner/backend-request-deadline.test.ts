import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { CloudRunnerBackend } from './backend.js';

it('closes a stalled Docker wait at its short reconciliation deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rice-api-'));
  const socket = join(dir, 'daemon.sock');
  let requestClosed!: Promise<unknown>;
  const server = createServer((req, res) => {
    if (req.url?.includes('/wait')) {
      requestClosed = new Promise<void>((resolve) => {
        req.once('close', resolve);
        req.on('error', () => undefined); // Client deadline aborts this request.
      });
      // Keep the wait open like a container which has not stopped.
    } else res.end(JSON.stringify({ State: { Running: false } }));
  });
  try {
    server.listen(socket);
    await once(server, 'listening');
    // Only the test points to this private fake daemon. Production's dedicated
    // backend constructor and socket validation remain unchanged.
    const backend = Object.create(
      CloudRunnerBackend.prototype,
    ) as CloudRunnerBackend;
    Object.defineProperty(backend, 'socketPath', { value: socket });
    const started = Date.now();
    await expect(
      backend.json('POST', '/containers/synthetic/wait', undefined, 100),
    ).rejects.toThrow('CLOUD_DAEMON_TIMEOUT');
    await requestClosed;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await backend.json('GET', '/containers/synthetic/json')).toEqual({
      State: { Running: false },
    });
    await expect(backend.call('GET', '/', undefined, 0)).rejects.toThrow(
      'CLOUD_DAEMON_INVALID_TIMEOUT',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
