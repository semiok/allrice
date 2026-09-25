import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startManagedBrowserPinnedProxy } from './managed-browser.js';

async function fixture() {
  const peers = new Set<Socket>();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => peers.delete(socket));
    socket.on('data', (data) => socket.write(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No fixture port');
  const transports: Socket[] = [];
  let waitForConnect: Promise<void> | undefined;
  let connectionStarted: (() => void) | undefined;
  const proxy = await startManagedBrowserPinnedProxy({
    resolvePublicAddresses: async () => [
      { address: '93.184.216.34', family: 4 },
    ],
    connectTcp: async (ip, port) => {
      expect(ip).toBe('93.184.216.34');
      expect(port).toBe(443);
      connectionStarted?.();
      if (waitForConnect) await waitForConnect;
      // Only this explicit fixture transport redirects the validated public
      // destination into a local echo server. Production uses pinned TCP.
      const socket = connect(address.port, '127.0.0.1');
      await once(socket, 'connect');
      transports.push(socket);
      return socket;
    },
  });
  const clients = new Set<Socket>();
  async function open() {
    const client = connect(Number(new URL(proxy.server).port), '127.0.0.1');
    client.on('error', () => client.destroy());
    clients.add(client);
    await once(client, 'connect');
    const response = once(client, 'data');
    const credentials = Buffer.from(
      `${proxy.username}:${proxy.password}`,
    ).toString('base64');
    client.write(
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`,
    );
    return { client, response };
  }
  return {
    open,
    transports,
    pause(promise: Promise<void>) {
      waitForConnect = promise;
      return new Promise<void>((resolve) => {
        connectionStarted = resolve;
      });
    },
    async healthy() {
      const { client, response } = await open();
      expect(String((await response)[0])).toContain(
        '200 Connection Established',
      );
      const echoed = once(client, 'data');
      client.write('still-alive');
      expect(String((await echoed)[0])).toBe('still-alive');
      client.destroy();
    },
    async close() {
      for (const client of clients) client.destroy();
      await proxy.close();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('managed browser proxy disconnects', () => {
  it.each(['EPIPE', 'ECONNRESET'])(
    'contains %s within the failed tunnel and accepts the next request',
    async (code) => {
      const f = await fixture();
      try {
        const { client, response } = await f.open();
        expect(String((await response)[0])).toContain(
          '200 Connection Established',
        );
        const closed = once(client, 'close');
        const upstream = f.transports[0]!;
        // Before the fix, the connected Socket has no error listener and this
        // exact event escapes to Node, terminating the entire Worker.
        expect(() =>
          upstream.emit('error', Object.assign(new Error(code), { code })),
        ).not.toThrow();
        await closed;
        expect(upstream.destroyed).toBe(true);
        await f.healthy();
      } finally {
        await f.close();
      }
    },
  );

  it('releases an upstream that connects after the browser has disconnected', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connecting = f.pause(gate);
    try {
      const { client, response } = await f.open();
      void response.catch(() => {});
      await connecting;
      client.destroy();
      await expect.poll(() => client.destroyed).toBe(true);
      release();
      await expect.poll(() => f.transports[0]?.destroyed).toBe(true);
      await f.healthy();
    } finally {
      release();
      await f.close();
    }
  });
});
