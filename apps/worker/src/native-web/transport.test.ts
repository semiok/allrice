import { Agent, createServer } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeWebTransport } from './transport.js';

const cleanup: (() => Promise<void>)[] = [];
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  vi.restoreAllMocks();
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});
for (const accepted of [false, true])
  it(`close joins exact HTTP request ${accepted ? 'after accept' : 'before socket assignment'}`, async () => {
    // Transport-only close fixture; never a dummy DSH RPC/readiness server.
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const server = createServer(() => enter());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    cleanup.push(async () => {
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    let settled = false;
    const call = transport.fetch(new URL('/', origin), { method: 'GET' }).then(
      () => {
        settled = true;
        throw Error('fixture must not respond');
      },
      () => {
        settled = true;
      },
    );
    if (accepted) await entered;
    await transport.close();
    expect(settled).toBe(true);
    await call;
    await expect(
      transport.fetch(new URL('/', origin), { method: 'GET' }),
    ).rejects.toBeDefined();
  });

for (const accepted of [false, true])
  it(`WS handshake close joins physical request/socket ${accepted ? 'after TCP/Upgrade request' : 'before socket assignment'}`, async () => {
    const created: {
      socket: Duplex;
      closed: Promise<void>;
      didClose: boolean;
    }[] = [];
    const create = Agent.prototype.createConnection;
    vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (
      this: Agent,
      ...args: Parameters<Agent['createConnection']>
    ) {
      const socket = create.apply(this, args);
      if (socket) {
        const record = {
          socket,
          didClose: false,
          closed: new Promise<void>((done) =>
            socket.once('close', () => {
              record.didClose = true;
              done();
            }),
          ),
        };
        created.push(record);
      }
      return socket;
    });
    const upgraded = latch(),
      serverSockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(302, {
        location: './api/remote.mux',
        'set-cookie': 'synthetic-native-cookie=transport-only; HttpOnly',
      });
      response.end();
    });
    server.on('connection', (socket) => {
      serverSockets.add(socket);
      socket.once('close', () => serverSockets.delete(socket));
    });
    // Accept the TCP/Upgrade request, deliberately never complete the handshake.
    server.on('upgrade', () => upgraded.resolve());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    cleanup.push(async () => {
      await transport.close();
      for (const socket of serverSockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    });
    await transport.authenticate(`${origin}/?token=synthetic-transport-only`);
    await Promise.all(created.map((record) => record.closed));
    const before = created.length;
    const ws = transport.createWebSocket(
      `${origin.replace('http:', 'ws:')}/api/remote.mux`,
    ) as unknown as WebSocket;
    expect(created).toHaveLength(before + 1);
    const physical = created[before]!;
    const logicalClose = new Promise<void>((done) =>
      ws.once('close', () => done()),
    );
    if (accepted) await upgraded.promise;
    let settled = false;
    const closed = transport.close().then(() => {
      settled = true;
    });
    await logicalClose;
    if (!physical.didClose) expect(settled).toBe(false);
    await closed;
    expect(physical.didClose).toBe(true);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(() =>
      transport.createWebSocket(
        `${origin.replace('http:', 'ws:')}/api/remote.mux`,
      ),
    ).toThrow();
  });
