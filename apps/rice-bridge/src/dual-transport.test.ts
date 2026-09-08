import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import {
  bridgeSocketPath,
  bridgeSocketProtocol,
  bridgeSocketMaximumFrameBytes,
} from '@allrice/contracts';
import { BridgeDualTransport } from './dual-transport.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture(
  options: {
    disabled?: boolean;
    reject?: number;
    lose?: string;
    stall?: boolean;
    wrongDevice?: boolean;
  } = {},
) {
  const deviceId = randomUUID(),
    operationId = randomUUID();
  const token = 'synthetic-p12-device-token';
  const calls: { channel: string; path: string; body: unknown }[] = [];
  let lose = options.lose,
    connections = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      calls.push({
        channel: 'http',
        path: req.url!,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, channel: 'http' }));
    })();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const sockets: WebSocket[] = [];
  server.on('upgrade', (req, socket, head) => {
    expect(req.url).toBe(bridgeSocketPath);
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    if (options.disabled || options.reject) {
      socket.end(
        `HTTP/1.1 ${options.reject ?? 404} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      sockets.push(ws);
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'welcome',
          deviceId: options.wrongDevice ? randomUUID() : deviceId,
          connectionId: randomUUID(),
          epoch: String(connections),
          heartbeatMs: 1000,
          maximumFrameBytes: bridgeSocketMaximumFrameBytes,
        }),
      );
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          id: string;
          action: string;
          body: unknown;
        };
        calls.push({ channel: 'ws', path: frame.action, body: frame.body });
        if (frame.action === lose) {
          lose = undefined;
          ws.terminate();
          return;
        }
        if (!options.stall)
          ws.send(
            JSON.stringify({
              version: 1,
              type: 'response',
              id: frame.id,
              status: 200,
              body: { ok: true, channel: 'ws' },
            }),
          );
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    for (const ws of sockets) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new BridgeDualTransport({
    server: origin,
    deviceId,
    token,
    retryBaseMs: 1,
    handshakeTimeoutMs: 1000,
  });
  cleanup.push(() => client.close());
  const request = (
    action = 'next',
    body: unknown = { supportsClaimRecovery: true },
    timeoutMs = 1500,
  ) =>
    client.request({
      server: origin,
      token,
      path: `/api/v1/bridge/device/operations/${action === 'next' ? 'next' : `${operationId}/${action}`}`,
      method: 'POST',
      body,
      maximumResponseBytes: 4096,
      timeoutMs,
    });
  return {
    client,
    calls,
    sockets,
    request,
    get connections() {
      return connections;
    },
  };
}

it('uses native authenticated WebSocket, shares one connection across concurrent requests, and closes wakeup waiters', async () => {
  const f = await fixture();
  const results = await Promise.all([f.request(), f.request('heartbeat')]);
  expect(results).toEqual([
    { ok: true, channel: 'ws' },
    { ok: true, channel: 'ws' },
  ]);
  expect(f.connections).toBe(1);
  const waiting = f.client.waitForWork(30000);
  f.sockets[0]!.send(JSON.stringify({ version: 1, type: 'wakeup' }));
  await waiting;
  const closing = f.client.waitForWork(30000);
  f.client.close();
  await closing;
});

it('falls back to unchanged HTTP when the server has no WSS endpoint', async () => {
  const f = await fixture({ disabled: true });
  expect(await f.request()).toEqual({ ok: true, channel: 'http' });
  expect(f.calls).toHaveLength(1);
});

it('does not treat rejected device authentication as a transport fallback', async () => {
  const f = await fixture({ reject: 401 });
  await expect(f.request()).rejects.toMatchObject({ status: 401 });
  await expect(f.request()).rejects.toMatchObject({ status: 401 });
  expect(f.calls).toHaveLength(0);
});

it.each(['next', 'output', 'receipts', 'heartbeat', 'service'])(
  'retries identical recoverable %s evidence/state over HTTP after a lost WSS response',
  async (action) => {
    const f = await fixture({ lose: `operation.${action}` });
    const body = {
      supportsClaimRecovery: true,
      sequence: 7,
      content: 'bounded fixture',
    };
    expect(await f.request(action, body)).toEqual({
      ok: true,
      channel: 'http',
    });
    expect(f.calls.map((c) => c.channel)).toEqual(['ws', 'http']);
    expect(f.calls[0]!.body).toEqual(f.calls[1]!.body);
  },
);

it.each(['start', 'next'])(
  'never replays ambiguous %s without a recovery contract',
  async (action) => {
    const f = await fixture({ lose: `operation.${action}` });
    await expect(f.request(action, {})).rejects.toThrow(
      'execution is not replayed',
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.channel).toBe('ws');
  },
);

it('bounds response waits, rejects plaintext remote endpoints and mismatched connection identity', async () => {
  expect(
    () =>
      new BridgeDualTransport({
        server: 'http://example.test',
        deviceId: randomUUID(),
        token: 'test',
      }),
  ).toThrow('ORIGIN_INVALID');
  const f = await fixture({ stall: true });
  await expect(f.request('start', {}, 25)).rejects.toThrow(
    'execution is not replayed',
  );
  const wrong = await fixture({ wrongDevice: true });
  expect(await wrong.request()).toEqual({ ok: true, channel: 'http' });
  expect(wrong.calls).toHaveLength(1); // no request was sent on the wrong-device socket
});

it('recovers after a real server-side socket close without parallel reconnect storms', async () => {
  const f = await fixture();
  await f.request();
  const closed = once(f.sockets[0]!, 'close');
  f.sockets[0]!.terminate();
  await closed;
  // A short polling interval exercises actual reconnect backoff; no execution retry.
  for (let i = 0; i < 20 && f.connections < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([f.request(), f.request()]);
  }
  expect(f.connections).toBe(2);
});
