import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { bridgeSocketPath, bridgeSocketProtocol } from '@allrice/contracts';
import { DevProducerLifecycle } from '../../../packages/database/src/dev-producer-lifecycle.ts';
import { AllRiceHttpServer } from '../server.mjs';
import { createCloudProjectPreviewTransport } from './cloud-project-preview.mjs';
import { createProjectPreviewGateway } from './project-preview.mjs';
import {
  createBridgeSocketGateway,
  createBridgeLoopbackDispatch,
} from './bridge-socket.mjs';
import { createWebRuntimeClose } from './close-runtime.mjs';
import { createDevRequestHandler } from './dev-maintenance.mjs';

const cleanups = [],
  gates = new Set();
function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const value = { promise, resolve };
  gates.add(value);
  return value;
}
afterEach(async () => {
  for (const value of gates) value.resolve();
  gates.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw Error('close fixture did not reach boundary');
    await delay(5);
  }
}
async function pending(promise) {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await delay(30);
  expect(done).toBe(false);
}
function target(backend = 'local') {
  return {
    serviceId: randomUUID(),
    operationId: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    backend,
    deviceId: backend === 'cloud' ? null : randomUUID(),
    attemptId: randomUUID(),
    containerId: 'a'.repeat(64),
    imageDigest: 'sha256:' + 'b'.repeat(64),
    port: 4173,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    hardDeadlineAt: new Date(Date.now() + 120000).toISOString(),
  };
}
async function listen(server, path) {
  server.listen(path ?? 0, path ? undefined : '127.0.0.1');
  await once(server, 'listening');
}
async function closeServer(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
async function unixFixture({ delayHandshake = false } = {}) {
  const dir = await mkdtemp('/tmp/ar-close-'),
    path = join(dir, 'p.sock'),
    server = createServer(),
    wss = new WebSocketServer({ noServer: true }),
    sockets = new Set();
  let peer, upgrade;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    upgrade = { req, socket, head };
    if (!delayHandshake)
      wss.handleUpgrade(req, socket, head, (ws) => {
        peer = ws;
      });
  });
  await listen(server, path);
  const transport = createCloudProjectPreviewTransport(path);
  cleanups.push(async () => {
    await transport.close();
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  });
  return { transport, peer: () => peer, upgrade: () => upgrade };
}
function previewRequest() {
  return {
    method: 'GET',
    path: '/',
    host: '127.0.0.1:4173',
    headers: {},
    websocket: false,
  };
}

it('cloud close joins an accepted callback and its reentrant stop, and refuses further opens', async () => {
  const f = await unixFixture(),
    blocked = gate(),
    id = randomUUID();
  let entered = false,
    notifications = 0,
    channel;
  channel = await f.transport.openPreview({
    id,
    target: target('cloud'),
    request: previewRequest(),
    onFrame: async () => {
      entered = true;
      void channel.close();
      await blocked.promise;
    },
    onClose: () => {
      notifications++;
    },
  });
  f.peer().send(
    JSON.stringify({
      version: 1,
      id,
      type: 'preview.data',
      data: 'eA==',
    }),
  );
  await until(() => entered);
  const closed = f.transport.close();
  expect(f.transport.close()).toBe(closed);
  await pending(closed);
  await expect(
    f.transport.openPreview({ target: target('cloud') }),
  ).rejects.toThrow('CLOUD_PREVIEW_UNAVAILABLE');
  blocked.resolve();
  await closed;
  expect(notifications).toBe(1);
  expect(f.peer().readyState).toBe(WebSocket.CLOSED);
});

it('a pending Unix handshake stays owned and cannot hand off after close', async () => {
  const f = await unixFixture({ delayHandshake: true });
  const opened = f.transport.openPreview({
    id: randomUUID(),
    target: target('cloud'),
    request: previewRequest(),
    onFrame: async () => {},
    onClose: () => {},
  });
  const rejected = expect(opened).rejects.toThrow();
  await until(() => f.upgrade());
  await f.transport.close();
  await rejected;
  // The peer raw upgrade can be half-open; our local WebSocket is already
  // closed. Resume the fixture peer to observe its EOF rather than inventing
  // a proof that every remote resource has shut down.
  f.upgrade().socket.resume();
  await until(() => f.upgrade().socket.readableEnded);
  expect(f.peer()).toBeUndefined();
});

async function previewFixture(options = {}) {
  const t = target(),
    server = createServer(),
    channels = [],
    sent = [],
    token = 'private-ticket';
  let gateway,
    opened,
    authorizations = 0,
    stops = 0;
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (req, res) => {
    void gateway.request(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    void gateway.upgrade(req, socket, head);
  });
  await listen(server);
  const port = server.address().port,
    host = 'rice-preview-' + t.serviceId + '.preview.test:' + port;
  gateway = createProjectPreviewGateway({
    suffix: 'preview.test:' + port,
    mainOrigin: 'http://127.0.0.1:' + port,
    secure: false,
    resolveAccess: async (id, key) => {
      authorizations++;
      if (id !== t.serviceId || key !== token) throw Error('denied');
      if (options.authorize) await options.authorize(authorizations);
      return { ...t };
    },
    transport: {
      openPreview: async (input) => {
        opened = input;
        channels.push(input);
        if (options.open) await options.open();
        return {
          send: async (frame) => {
            sent.push(frame);
            if (options.send) await options.send(frame);
            return true;
          },
          close: async () => {
            stops++;
            if (options.close) await options.close();
          },
        };
      },
    },
  });
  cleanups.push(async () => {
    await gateway.close();
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });
  const http = (ticket = false, method = 'GET') => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      method,
      path: ticket ? '/?_allrice_preview_ticket=' + token : '/',
      headers: {
        host,
        origin: 'http://' + host,
        cookie: 'allrice_preview_test=' + token,
      },
    });
    req.on('error', () => {});
    const result = new Promise((resolve) => {
      req.on('error', () => resolve({ status: 0 }));
      req.once('response', (res) => {
        const bytes = [];
        res.on('data', (chunk) => bytes.push(chunk));
        res.on('error', () => resolve({ status: 0 }));
        res.once('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(bytes).toString(),
          }),
        );
      });
    });
    req.end();
    return { req, result };
  };
  const ws = () => {
    const client = new WebSocket('ws://127.0.0.1:' + port + '/', {
      headers: {
        host,
        origin: 'http://' + host,
        cookie: 'allrice_preview_test=' + token,
      },
    });
    client.on('error', () => {});
    cleanups.push(async () => {
      if (client.readyState !== WebSocket.CLOSED) {
        const closed = once(client, 'close').catch(() => {});
        client.terminate();
        await closed;
      }
    });
    return client;
  };
  return {
    gateway,
    t,
    host,
    http,
    ws,
    opened: () => opened,
    channels,
    sent,
    stops: () => stops,
    authorizations: () => authorizations,
  };
}

it.each(['HTTP', 'bootstrap', 'upgrade'])(
  'pending %s authorization remains owned and creates no late channel or cookie',
  async (kind) => {
    const blocked = gate(),
      f = await previewFixture({ authorize: () => blocked.promise });
    let http;
    if (kind === 'upgrade') f.ws();
    else http = f.http(kind === 'bootstrap');
    await until(() => f.authorizations() === 1);
    const closed = f.gateway.close();
    await pending(closed);
    blocked.resolve();
    await closed;
    expect(f.channels).toHaveLength(0);
    if (http) expect((await http.result).status).toBe(0);
  },
);

it.each(['HTTP', 'upgrade'])(
  'late %s open is joined through the returned channel cleanup',
  async (kind) => {
    const opened = gate(),
      cleanup = gate(),
      f = await previewFixture({
        open: () => opened.promise,
        close: () => cleanup.promise,
      });
    if (kind === 'upgrade') f.ws();
    else f.http();
    await until(() => f.opened());
    const closed = f.gateway.close();
    await pending(closed);
    opened.resolve();
    await until(() => f.stops() === 1);
    await pending(closed);
    cleanup.resolve();
    await closed;
    expect(f.stops()).toBe(1);
  },
);

it('HTTP close joins held reauthorization and does not write its late response', async () => {
  const blocked = gate();
  let hold = false,
    entered = false;
  const f = await previewFixture({
    authorize: async () => {
      if (hold) {
        entered = true;
        await blocked.promise;
      }
    },
  });
  const h = f.http();
  await until(() => f.sent.some((frame) => frame.type === 'preview.end'));
  hold = true;
  const frame = f
    .opened()
    .onFrame({ type: 'preview.response', status: 200, headers: {} });
  await until(() => entered);
  const closed = f.gateway.close();
  await pending(closed);
  blocked.resolve();
  await frame;
  await closed;
  expect((await h.result).status).toBe(0);
  expect(f.stops()).toBe(1);
});

it('browser WS close joins accepted forwarding without starting a queued second send', async () => {
  const blocked = gate();
  let held = false;
  const f = await previewFixture({
    send: async (frame) => {
      if (frame.type === 'preview.data') {
        held = true;
        await blocked.promise;
      }
    },
  });
  const ws = f.ws();
  await until(() => f.opened());
  const connected = once(ws, 'open');
  await f
    .opened()
    .onFrame({ type: 'preview.response', status: 101, headers: {} });
  await connected;
  ws.send('first');
  ws.send('second');
  await until(() => held);
  const closed = f.gateway.close();
  await pending(closed);
  blocked.resolve();
  await closed;
  expect(f.sent.filter((frame) => frame.type === 'preview.data')).toHaveLength(
    1,
  );
  expect(ws.readyState).toBe(WebSocket.CLOSED);
});

async function bridgeFixture(options = {}) {
  const t = target(),
    server = options.server ?? new AllRiceHttpServer();
  if (!server.listening) await listen(server);
  const port = server.address().port,
    messages = [],
    released = [],
    admitted = [],
    connection = {
      connectionId: randomUUID(),
      deviceId: t.deviceId,
      organizationId: t.organizationId,
      workspaceId: t.workspaceId,
      ownerId: t.ownerId,
      epoch: 1,
    };
  let notify,
    currentCalls = 0,
    unsubscribeCalls = 0;
  const authority = {
    register: async () => {
      admitted.push(connection);
      if (options.register) await options.register();
      return connection;
    },
    current: async (...args) => {
      currentCalls++;
      if (options.current) return options.current(currentCalls, ...args);
      return true;
    },
    release: async (value) => {
      released.push(value);
      if (options.release) await options.release();
    },
    subscribe: async (callback) => {
      notify = callback;
      return async () => {
        unsubscribeCalls++;
      };
    },
  };
  const gateway = await createBridgeSocketGateway({
    authority,
    enabled: () => true,
    heartbeatMs: 10000,
    dispatch: options.dispatch ?? (async () => ({ status: 200, body: {} })),
    maximumConnections: options.maximumConnections ?? 256,
  });
  server.bridgeGateway = gateway;
  server.on('upgrade', (_req, socket) => socket.destroy());
  const ws = new WebSocket(
    'ws://127.0.0.1:' + port + bridgeSocketPath,
    bridgeSocketProtocol,
    { headers: { authorization: 'Bearer fixture-only-token' } },
  );
  ws.on('error', () => {});
  ws.on('message', (bytes) => messages.push(JSON.parse(bytes.toString())));
  cleanups.push(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, 'close').catch(() => {});
      ws.terminate();
      await closed;
    }
    await gateway.close().catch((error) => {
      if (!options.expectCleanupFailure) throw error;
    });
    await closeServer(server);
  });
  return {
    t,
    server,
    gateway,
    ws,
    messages,
    released,
    admitted,
    notify: (...args) => notify(...args),
    unsubscribeCalls: () => unsubscribeCalls,
    currentCalls: () => currentCalls,
  };
}

it.each(['register', 'current'])(
  'Bridge shutdown while %s is pending refuses handoff and joins exactly one release',
  async (boundary) => {
    const blocked = gate(),
      release = gate();
    const f = await bridgeFixture({
      [boundary]: async () => {
        await blocked.promise;
        return true;
      },
      release: () => release.promise,
    });
    await until(() =>
      boundary === 'register'
        ? f.admitted.length === 1
        : f.currentCalls() === 1,
    );
    const closed = f.gateway.close();
    expect(f.gateway.close()).toBe(closed);
    await pending(closed);
    blocked.resolve();
    await until(() => f.released.length === 1);
    expect(f.messages).toHaveLength(0);
    await pending(closed);
    release.resolve();
    await closed;
    expect(f.released).toHaveLength(1);
    expect(f.unsubscribeCalls()).toBe(1);
  },
);

it('a disconnected Bridge RPC stays owned, its queued second RPC never starts, and release follows completion', async () => {
  const blocked = gate();
  let dispatches = 0;
  const f = await bridgeFixture({
    dispatch: async () => {
      dispatches++;
      await blocked.promise;
      return { status: 200, body: {} };
    },
  });
  await until(() => f.messages.some((frame) => frame.type === 'welcome'));
  for (let i = 0; i < 2; i++)
    f.ws.send(
      JSON.stringify({
        version: 1,
        type: 'request',
        id: randomUUID(),
        action: 'operation.next',
        body: {},
      }),
    );
  await until(() => dispatches === 1);
  const dropped = once(f.ws, 'close');
  f.ws.terminate();
  await dropped;
  const closed = f.gateway.close();
  await pending(closed);
  expect(f.released).toHaveLength(0);
  blocked.resolve();
  await closed;
  expect(dispatches).toBe(1);
  expect(f.released).toHaveLength(1);
});

it('the native authority promise that loses its decision timeout is joined before final release', async () => {
  const blocked = gate();
  let held = false;
  const f = await bridgeFixture({
    current: async (n) => {
      if (n > 1) {
        held = true;
        await blocked.promise;
      }
      return true;
    },
  });
  await until(() => f.messages.some((frame) => frame.type === 'welcome'));
  f.ws.send(
    JSON.stringify({
      version: 1,
      type: 'request',
      id: randomUUID(),
      action: 'operation.next',
      body: {},
    }),
  );
  await until(() => held);
  await once(f.ws, 'close');
  const closed = f.gateway.close();
  await pending(closed);
  expect(f.released).toHaveLength(0);
  blocked.resolve();
  await closed;
  expect(f.released).toHaveLength(1);
}, 10000);

it('a release rejection remains a cached cleanup failure rather than successful close', async () => {
  const f = await bridgeFixture({
    release: async () => {
      throw Error('release outcome unknown');
    },
    expectCleanupFailure: true,
  });
  await until(() => f.messages.some((frame) => frame.type === 'welcome'));
  const closed = f.gateway.close();
  await expect(closed).rejects.toThrow('BRIDGE_SOCKET_CLEANUP_UNCONFIRMED');
  expect(f.gateway.close()).toBe(closed);
  expect(f.released).toHaveLength(1);
});

it('closing one virtual preview joins its callback and notification while a second channel and shared Bridge stay usable', async () => {
  const blocked = gate(),
    f = await bridgeFixture(),
    oneId = randomUUID(),
    twoId = randomUUID();
  let entered = false,
    notified = 0;
  await until(() => f.messages.some((frame) => frame.type === 'welcome'));
  const one = await f.gateway.openPreview({
    target: f.t,
    request: previewRequest(),
    id: oneId,
    onFrame: async () => {
      entered = true;
      await blocked.promise;
    },
    onClose: () => {
      notified++;
    },
  });
  const two = await f.gateway.openPreview({
    target: f.t,
    request: previewRequest(),
    id: twoId,
    onFrame: async () => {},
    onClose: () => {},
  });
  f.ws.send(
    JSON.stringify({
      version: 1,
      type: 'preview.data',
      id: oneId,
      data: 'eA==',
    }),
  );
  await until(() => entered);
  const closed = one.close();
  await pending(closed);
  expect(await two.send({ type: 'preview.data', data: 'eQ==' })).toBe(true);
  expect(f.ws.readyState).toBe(WebSocket.OPEN);
  blocked.resolve();
  await closed;
  expect(notified).toBe(1);
  expect(await two.send({ type: 'preview.end' })).toBe(true);
  expect(f.ws.readyState).toBe(WebSocket.OPEN);
});

it('normal terminal delivery is not replaced with an abort when its callback signals channel close', async () => {
  const f = await bridgeFixture();
  let channel,
    terminal = false;
  const terminalId = randomUUID();
  await until(() => f.messages.some((frame) => frame.type === 'welcome'));
  channel = await f.gateway.openPreview({
    target: f.t,
    request: previewRequest(),
    id: terminalId,
    onFrame: async (frame) => {
      terminal = frame.type === 'preview.end';
      void channel.close();
    },
    onClose: () => {},
  });
  f.ws.send(
    JSON.stringify({ version: 1, type: 'preview.end', id: terminalId }),
  );
  await until(() => terminal);
  await channel.close();
  await delay(20);
  expect(
    f.messages.filter(
      (frame) => frame.id === terminalId && frame.type === 'preview.end',
    ),
  ).toHaveLength(0);
});

it('the production coordinator latches gateways together, preserves loopback work, then joins the actual C1 handler before DB close', async () => {
  const body = gate(),
    late = gate(),
    preview = gate(),
    events = [];
  const server = new AllRiceHttpServer(),
    bootId = randomUUID();
  const lifecycle = new DevProducerLifecycle(
    true,
    'web',
    {
      service: 'web',
      mode: 'production',
      bootId,
      manifestDigest: 'sha256:' + 'a'.repeat(64),
      pid: process.pid,
    },
    {
      start: async (input) => ({ ...input, epoch: 0 }),
      finish: async () => {
        events.push('root-finished');
      },
    },
  );
  let entered = false,
    handlerDone;
  const handle = createDevRequestHandler(lifecycle, async (_req, res) => {
    entered = true;
    await body.promise;
    res.end('{}');
    await late.promise;
    events.push('handler-done');
  });
  server.on('request', (req, res) => {
    handlerDone = handle(req, res);
  });
  await listen(server);
  const f = await bridgeFixture({
    server,
    dispatch: createBridgeLoopbackDispatch(server.address().port),
  });
  await until(() => f.messages.some((frame) => frame.type === 'welcome'));
  f.ws.send(
    JSON.stringify({
      version: 1,
      type: 'request',
      id: randomUUID(),
      action: 'operation.next',
      body: {},
    }),
  );
  await until(() => entered);
  server.previewGateway = {
    close: () => {
      events.push('preview-stopped');
      return preview.promise;
    },
  };
  const close = createWebRuntimeClose({
    server,
    lifecycle,
    cloudPreview: {
      close: () => {
        events.push('cloud-stopped');
        return Promise.resolve();
      },
    },
    app: {
      close: async () => {
        events.push('next-closed');
      },
    },
    closeDatabase: async () => {
      events.push('db-closed');
    },
  });
  const closed = close();
  expect(close()).toBe(closed);
  expect(events.slice(0, 2)).toEqual(['preview-stopped', 'cloud-stopped']);
  await pending(closed);
  body.resolve();
  await until(() => f.released.length === 1);
  expect(server.listening).toBe(true);
  preview.resolve();
  await until(() => !server.listening);
  await pending(closed);
  expect(events).not.toContain('db-closed');
  late.resolve();
  await handlerDone;
  await closed;
  expect(events.slice(-4)).toEqual([
    'handler-done',
    'root-finished',
    'next-closed',
    'db-closed',
  ]);
});

it('an ordinary HTTP disconnect initiates channel close to release blocked forwarding before draining', async () => {
  const blocked = gate();
  let entered = false;
  const f = await previewFixture({
    send: async () => {
      entered = true;
      await blocked.promise;
    },
    close: async () => {
      blocked.resolve();
    },
  });
  const h = f.http();
  await until(() => entered);
  h.req.destroy();
  // No global transport shutdown is needed to break this wait.
  await until(() => f.stops() === 1);
  await f.gateway.close();
  expect((await h.result).status).toBe(0);
  expect(f.stops()).toBe(1);
});

it('an unknown non-handed-off release retires capacity but stays a failed cleanup result', async () => {
  let releaseCalls = 0;
  const f = await bridgeFixture({
    maximumConnections: 1,
    current: async (n) => n > 1,
    release: async () => {
      releaseCalls++;
      if (releaseCalls === 1) throw Error('unknown release');
    },
    expectCleanupFailure: true,
  });
  await until(() => f.released.length === 1);
  const ws = new WebSocket(
    'ws://127.0.0.1:' + f.server.address().port + bridgeSocketPath,
    bridgeSocketProtocol,
    { headers: { authorization: 'Bearer fixture-only-token' } },
  );
  ws.on('error', () => {});
  cleanups.push(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, 'close').catch(() => {});
      ws.terminate();
      await closed;
    }
  });
  const welcome = new Promise((resolve) =>
    ws.on('message', (bytes) => {
      if (JSON.parse(bytes.toString()).type === 'welcome') resolve();
    }),
  );
  await welcome;
  expect(f.admitted).toHaveLength(2);
  await expect(f.gateway.close()).rejects.toThrow(
    'BRIDGE_SOCKET_CLEANUP_UNCONFIRMED',
  );
  expect(f.released).toHaveLength(2);
});
