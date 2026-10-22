import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, URLSearchParams } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import {
  bridgeSocketProtocol,
  workbenchTerminalProtocol,
} from '@allrice/contracts';
import { AllRiceHttpServer } from '../server.mjs';
import { createBridgeSocketGateway } from './bridge-socket.mjs';
import { createWorkbenchTerminalGateway } from './workbench-terminal.mjs';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('terminal fixture boundary not reached');
    await delay(5);
  }
}
function target() {
  return {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    loginSessionId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    rootFingerprint: 'a'.repeat(64),
    label: 'Authorized test folder',
  };
}
async function fixture({ delayOpen = false } = {}) {
  const identity = target(),
    frames = [],
    opened = [];
  let allowed = true,
    resolves = 0,
    authorizeFailure = null;
  const server = new AllRiceHttpServer();
  server.on('request', (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  // Reproduce Next's upgrade listener so Node dispatches upgrade events, then
  // assert the two dedicated gateways intercept them before that listener.
  server.on('upgrade', (_req, socket) => socket.destroy());
  const connection = {
    ...identity,
    connectionId: randomUUID(),
    serverId: randomUUID(),
    epoch: '1',
  };
  server.bridgeGateway = await createBridgeSocketGateway({
    enabled: () => true,
    heartbeatMs: 1000,
    authority: {
      register: async () => connection,
      current: async () => true,
      release: async () => undefined,
      subscribe: async () => () => undefined,
    },
    dispatch: async () => {
      throw Error('human terminal must not invoke operation ledger');
    },
  });
  let releaseOpen;
  const openGate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  server.terminalGateway = createWorkbenchTerminalGateway({
    authorizationLeaseMs: 5,
    watchMs: 25,
    resolveAccess: async (request, input) => {
      resolves++;
      if (authorizeFailure) throw authorizeFailure;
      if (
        !allowed ||
        request.headers.cookie !== 'allrice_session=synthetic' ||
        Object.keys(input).some((key) => input[key] !== identity[key])
      ) {
        const error = Error('denied');
        error.status = 404;
        throw error;
      }
      return { target: { ...identity }, deviceName: 'Test Mac' };
    },
    transport: {
      openTerminal: async (input) => {
        opened.push(input);
        if (delayOpen) await openGate;
        return server.bridgeGateway.openTerminal(input);
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bridge = new WebSocket(
    `${origin.replace('http:', 'ws:')}/api/v1/bridge/socket`,
    bridgeSocketProtocol,
    { headers: { authorization: 'Bearer synthetic-device' } },
  );
  bridge.on('error', () => undefined);
  const seen = [];
  bridge.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    seen.push(frame);
    if (frame.type === 'terminal.open')
      bridge.send(
        JSON.stringify({ version: 1, type: 'terminal.ready', id: frame.id }),
      );
  });
  await until(() => seen.some((frame) => frame.type === 'welcome'));
  const clients = new Set();
  const url = `${origin.replace('http:', 'ws:')}/api/v1/workbench-terminal/socket?${new URLSearchParams(Object.fromEntries(['organizationId', 'workspaceId', 'sessionId', 'deviceId', 'grantId'].map((key) => [key, identity[key]])))}`;
  const browser = (options = {}) => {
    const socket = new WebSocket(
      options.url ?? url,
      workbenchTerminalProtocol,
      {
        headers: {
          cookie: 'allrice_session=synthetic',
          origin,
          ...options.headers,
        },
      },
    );
    socket.on('error', () => undefined);
    const received = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      frames.push(frame);
    });
    clients.add(socket);
    return { socket, received };
  };
  cleanups.push(async () => {
    releaseOpen();
    for (const socket of clients) socket.terminate();
    await server.terminalGateway.close();
    bridge.terminate();
    await server.bridgeGateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    identity,
    origin,
    url,
    bridge,
    browser,
    frames,
    seen,
    opened,
    releaseOpen,
    disallow: () => {
      allowed = false;
    },
    failAuthorization: () => {
      authorizeFailure = Error('temporary database failure');
    },
    get resolves() {
      return resolves;
    },
    bridgeSend: (frame) =>
      bridge.send(
        JSON.stringify({ version: 1, id: opened.at(-1).id, ...frame }),
      ),
  };
}
const send = (socket, frame) =>
  socket.send(JSON.stringify({ version: 1, ...frame }));
const request = (socket, action, args) => {
  const requestId = randomUUID();
  send(socket, { type: 'terminal.request', requestId, action, args });
  return requestId;
};
const info = {
  id: 'native-terminal',
  title: 'zsh',
  shell: { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
  cwd: '/authorized/test',
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
};

it('rejects cross-origin upgrades and foreign targets before opening a Bridge channel', async () => {
  const f = await fixture();
  const first = f.browser({ headers: { origin: 'https://foreign.example' } });
  const [, response] = await once(first.socket, 'unexpected-response');
  response.destroy();
  expect(f.opened).toHaveLength(0);
  const foreign = new URL(f.url);
  foreign.searchParams.set('sessionId', randomUUID());
  const second = f.browser({ url: foreign.href });
  const [, rejected] = await once(second.socket, 'unexpected-response');
  rejected.destroy();
  expect(rejected.statusCode).toBe(401);
  expect(f.opened).toHaveLength(0);
});

it('carries native stream credits, raw control characters, and ordered ACKs without invoking Agent operations', async () => {
  const f = await fixture(),
    b = f.browser();
  await until(() =>
    b.received.some((frame) => frame.type === 'terminal.ready'),
  );
  expect(b.received[0]).toMatchObject({
    target: f.identity,
    deviceName: 'Test Mac',
  });
  const id = request(b.socket, 'attach', { id: info.id });
  await until(() =>
    f.seen.some(
      (frame) => frame.type === 'terminal.request' && frame.requestId === id,
    ),
  );
  expect(f.seen.some((frame) => frame.type === 'terminal.next')).toBe(false);
  send(b.socket, { type: 'terminal.next', requestId: id });
  await until(() => f.seen.some((frame) => frame.type === 'terminal.next'));
  f.bridgeSend({
    type: 'terminal.frame',
    requestId: id,
    frame: {
      type: 'snapshot',
      sequence: 0,
      screen: 'test % ',
      info,
      writable: true,
    },
  });
  await until(() =>
    b.received.some((frame) => frame.frame?.type === 'snapshot'),
  );
  send(b.socket, {
    type: 'terminal.input',
    requestId: id,
    input: { type: 'write', sequence: 1, data: '\u0003\t' },
  });
  await until(() => f.seen.some((frame) => frame.type === 'terminal.input'));
  expect(
    f.seen.find((frame) => frame.type === 'terminal.input').input.data,
  ).toBe('\u0003\t');
  send(b.socket, { type: 'terminal.next', requestId: id });
  await until(
    () => f.seen.filter((frame) => frame.type === 'terminal.next').length === 2,
  );
  f.bridgeSend({
    type: 'terminal.frame',
    requestId: id,
    frame: { type: 'ack', sequence: 1 },
  });
  await until(() => b.received.some((frame) => frame.frame?.type === 'ack'));
  send(b.socket, { type: 'terminal.cancel', requestId: id });
  await until(() => f.seen.some((frame) => frame.type === 'terminal.cancel'));
  f.bridgeSend({ type: 'terminal.finished', requestId: id });
  await delay(20);
  expect(b.socket.readyState).toBe(WebSocket.OPEN);
});

it('bounds native snapshot fragments and consumes only one credit for the complete screen', async () => {
  const f = await fixture(),
    b = f.browser();
  await until(() =>
    b.received.some((frame) => frame.type === 'terminal.ready'),
  );
  const id = request(b.socket, 'attach', { id: info.id });
  send(b.socket, { type: 'terminal.next', requestId: id });
  await until(() => f.seen.some((frame) => frame.type === 'terminal.next'));
  const screen = JSON.stringify({
    type: 'snapshot',
    sequence: 0,
    screen: 'x'.repeat(1_600_000),
    info,
    writable: true,
  });
  const chunks = screen.match(/[\s\S]{1,100000}/g);
  for (let index = 0; index < chunks.length; index++)
    f.bridgeSend({
      type: 'terminal.fragment',
      requestId: id,
      index,
      total: chunks.length,
      data: chunks[index],
    });
  await until(
    () =>
      b.received.filter((frame) => frame.type === 'terminal.fragment')
        .length === chunks.length,
  );
  expect(
    b.received
      .filter((frame) => frame.type === 'terminal.fragment')
      .map((frame) => frame.data)
      .join(''),
  ).toBe(screen);
  expect(f.seen.filter((frame) => frame.type === 'terminal.next')).toHaveLength(
    1,
  );
  expect(b.socket.readyState).toBe(WebSocket.OPEN);
});

it('revocation closes a live channel with explicit revoke while a temporary authority outage only detaches', async () => {
  const f = await fixture(),
    b = f.browser();
  await until(() =>
    b.received.some((frame) => frame.type === 'terminal.ready'),
  );
  f.disallow();
  await until(() => f.seen.some((frame) => frame.type === 'terminal.end'));
  expect(f.seen.find((frame) => frame.type === 'terminal.end').revoke).toBe(
    true,
  );
  const g = await fixture(),
    c = g.browser();
  await until(() =>
    c.received.some((frame) => frame.type === 'terminal.ready'),
  );
  g.failAuthorization();
  await until(() => g.seen.some((frame) => frame.type === 'terminal.end'));
  expect(g.seen.find((frame) => frame.type === 'terminal.end').revoke).toBe(
    false,
  );
});

it('disconnecting during a delayed opener joins its channel and never starts a replacement', async () => {
  const f = await fixture({ delayOpen: true }),
    b = f.browser();
  await once(b.socket, 'open');
  await until(() => f.opened.length === 1);
  b.socket.terminate();
  f.releaseOpen();
  await until(() => f.seen.some((frame) => frame.type === 'terminal.end'));
  expect(f.opened).toHaveLength(1);
  expect(f.seen.find((frame) => frame.type === 'terminal.end').revoke).toBe(
    false,
  );
});

it('rejects a second unconsumed stream credit and does not replay the input on another channel', async () => {
  const f = await fixture(),
    b = f.browser();
  await until(() =>
    b.received.some((frame) => frame.type === 'terminal.ready'),
  );
  const id = request(b.socket, 'attach', { id: info.id });
  send(b.socket, { type: 'terminal.next', requestId: id });
  send(b.socket, { type: 'terminal.next', requestId: id });
  await until(() => f.seen.some((frame) => frame.type === 'terminal.end'));
  expect(
    f.seen.filter((frame) => frame.type === 'terminal.next').length,
  ).toBeLessThanOrEqual(1);
  expect(f.opened).toHaveLength(1);
});

it('keeps a live native attachment when only the folder display label changes', async () => {
  const f = await fixture(),
    b = f.browser();
  await until(() =>
    b.received.some((frame) => frame.type === 'terminal.ready'),
  );
  const before = f.resolves;
  f.identity.label = 'Renamed display label';
  await until(() => f.resolves > before + 1);
  expect(f.seen.some((frame) => frame.type === 'terminal.end')).toBe(false);
  expect(b.socket.readyState).toBe(WebSocket.OPEN);
});
