import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import {
  bridgeSocketPath,
  bridgeSocketMaximumFrameBytes,
  type BridgeTerminalClientFrame,
  type BridgeTerminalServerFrame,
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
    stallHandshake?: boolean;
    keepConnected?: boolean;
    retryBaseMs?: number;
    onTerminal?: (
      frame: BridgeTerminalServerFrame,
      send: (frame: BridgeTerminalClientFrame) => Promise<boolean>,
    ) => void;
    onTerminalDisconnect?: () => void;
  } = {},
) {
  const deviceId = randomUUID(),
    operationId = randomUUID();
  const token = 'synthetic-p12-device-token';
  const calls: { channel: string; path: string; body: unknown }[] = [];
  const terminalFrames: BridgeTerminalClientFrame[] = [];
  let lose = options.lose,
    connections = 0;
  let rejection = options.reject;
  let upgrades = 0;
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
  const connectionsToClean = new Set<Socket>();
  server.on('connection', (socket) => {
    connectionsToClean.add(socket);
    socket.once('close', () => connectionsToClean.delete(socket));
  });
  const sockets: WebSocket[] = [];
  let upgradeSeen = false;
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    upgradeSeen = true;
    expect(req.url).toBe(bridgeSocketPath);
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    if (options.stallHandshake) return;
    if (options.disabled || rejection) {
      socket.end(
        `HTTP/1.1 ${rejection ?? 404} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
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
          type?: string;
          id: string;
          action: string;
          body: unknown;
        };
        if (frame.type?.startsWith('terminal.')) {
          terminalFrames.push(frame as unknown as BridgeTerminalClientFrame);
          return;
        }
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
    for (const socket of connectionsToClean) socket.destroy();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new BridgeDualTransport({
    server: origin,
    deviceId,
    token,
    retryBaseMs: options.retryBaseMs ?? 1,
    keepConnected: options.keepConnected,
    handshakeTimeoutMs: 1000,
    onTerminal: options.onTerminal,
    onTerminalDisconnect: options.onTerminalDisconnect,
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
    deviceId,
    terminalFrames,
    rejectNewConnections(status: number) {
      rejection = status;
    },
    get upgrades() {
      return upgrades;
    },
    get connections() {
      return connections;
    },
    get upgradeSeen() {
      return upgradeSeen;
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

it('maintains a welcomed human-terminal socket through an idle disconnect without sending another operation', async () => {
  const f = await fixture({ keepConnected: true });
  await f.request();
  expect(f.calls).toHaveLength(1);
  f.sockets[0]!.terminate();
  for (let i = 0; i < 200 && f.connections < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.connections).toBe(2);
  expect(f.calls).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.upgrades).toBe(2);
});

it('stops scheduled idle reconnect on close and never maintains an endpoint that was not welcomed', async () => {
  let disconnected = false;
  const f = await fixture({
    keepConnected: true,
    retryBaseMs: 100,
    onTerminalDisconnect: () => {
      disconnected = true;
    },
  });
  await f.request();
  f.sockets[0]!.terminate();
  for (let i = 0; i < 100 && !disconnected; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(disconnected).toBe(true);
  f.client.close();
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(f.upgrades).toBe(1);
  const unsupported = await fixture({ keepConnected: true, disabled: true });
  expect(await unsupported.request()).toEqual({ ok: true, channel: 'http' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(unsupported.upgrades).toBe(1);
  expect(unsupported.calls).toHaveLength(1);
});

it('an explicit credential rejection ends idle reconnect maintenance without HTTP execution fallback', async () => {
  const f = await fixture({ keepConnected: true });
  await f.request();
  f.rejectNewConnections(401);
  f.sockets[0]!.terminate();
  for (let i = 0; i < 200 && f.upgrades < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(f.connections).toBe(1);
  expect(f.upgrades).toBe(2);
  await expect(f.request()).rejects.toMatchObject({ status: 401 });
  expect(f.calls).toHaveLength(1);
});

it('routes typed terminal frames over the authenticated socket and fences old senders after reconnect', async () => {
  const callbacks: {
    frame: BridgeTerminalServerFrame;
    send: (frame: BridgeTerminalClientFrame) => Promise<boolean>;
  }[] = [];
  let disconnected = false;
  const f = await fixture({
    onTerminal: (frame, send) => {
      callbacks.push({ frame, send });
    },
    onTerminalDisconnect: () => {
      disconnected = true;
    },
  });
  await f.request();
  const open: BridgeTerminalServerFrame = {
    version: 1,
    type: 'terminal.open',
    id: randomUUID(),
    target: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
      loginSessionId: randomUUID(),
      sessionId: randomUUID(),
      deviceId: f.deviceId,
      grantId: randomUUID(),
      grantVersion: 1,
      rootFingerprint: 'a'.repeat(64),
      label: 'Authorized directory',
    },
  };
  f.sockets[0]!.send(JSON.stringify(open));
  for (let i = 0; i < 100 && !callbacks.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(callbacks[0]?.frame).toEqual(open);
  expect(
    await callbacks[0]!.send({
      version: 1,
      type: 'terminal.ready',
      id: open.id,
    }),
  ).toBe(true);
  for (let i = 0; i < 100 && !f.terminalFrames.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(f.terminalFrames).toEqual([
    { version: 1, type: 'terminal.ready', id: open.id },
  ]);
  const closed = once(f.sockets[0]!, 'close');
  f.sockets[0]!.terminate();
  await closed;
  for (let i = 0; i < 100 && !disconnected; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(disconnected).toBe(true);
  for (let i = 0; i < 100 && f.connections < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await f.request();
  }
  expect(f.connections).toBe(2);
  expect(
    await callbacks[0]!.send({
      version: 1,
      type: 'terminal.ready',
      id: open.id,
    }),
  ).toBe(false);
  f.sockets[1]!.send(JSON.stringify(open));
  for (let i = 0; i < 100 && callbacks.length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(
    await callbacks[1]!.send({
      version: 1,
      type: 'terminal.ready',
      id: open.id,
    }),
  ).toBe(true);
  expect(f.calls.every((call) => call.channel === 'ws')).toBe(true);
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

it('closing during the initial handshake cannot send a new HTTP start afterward', async () => {
  const f = await fixture({ stallHandshake: true });
  const pending = f.request('start', {});
  const failure = expect(pending).rejects.toThrow('Bridge socket unavailable');
  for (let i = 0; i < 100 && !f.upgradeSeen; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(f.upgradeSeen).toBe(true);
  f.client.close();
  await failure;
  expect(f.calls).toHaveLength(0);
  await expect(f.request('start', {})).rejects.toThrow(
    'Bridge socket unavailable',
  );
});
