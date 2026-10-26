import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForReadyJobs } from './queue-ready.ts';

/** A PostgreSQL that completes the startup handshake and then never answers,
 * the case `connect_timeout` no longer covers (MET-223 review). */
function silentPostgres() {
  const sockets = new Set<Socket>();
  let closed = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      closed++;
    });
    socket.once('data', () => {
      const ok = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
      const key = Buffer.alloc(13);
      key.write('K', 0);
      key.writeInt32BE(12, 1);
      key.writeInt32BE(4242, 5);
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
      socket.write(Buffer.concat([ok, key, ready]));
    });
  });
  return {
    async start() {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      return `postgres://wakeup@127.0.0.1:${address.port}/silent`;
    },
    closed: () => closed,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('wakeup LISTEN subscription (MET-223)', () => {
  let database: ReturnType<typeof silentPostgres>;
  beforeEach(async () => {
    database = silentPostgres();
    vi.stubEnv('DATABASE_URL', await database.start());
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await database.stop();
  });

  it('gives up and closes the connection when LISTEN never answers', async () => {
    const onListen = vi.fn();
    await expect(
      listenForReadyJobs(() => {}, onListen, { timeoutMs: 200 }),
    ).rejects.toThrow('LISTEN timed out');
    expect(onListen).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(database.closed()).toBeGreaterThan(0));
  });

  it('gives up at once when the Worker stops while LISTEN is pending', async () => {
    const aborter = new AbortController();
    const pending = listenForReadyJobs(() => {}, vi.fn(), {
      signal: aborter.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => aborter.abort(), 50);
    await expect(pending).rejects.toThrow('LISTEN aborted');
    await vi.waitFor(() => expect(database.closed()).toBeGreaterThan(0));
  });
});
