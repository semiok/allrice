import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import {
  ContainerLoopback,
  ContainerProjectPreviewRelay,
} from '../../../packages/project-runtime/src/project-preview-relay.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeSocketPath, bridgeSocketProtocol } from '@allrice/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { AllRiceHttpServer } from '../server.mjs';
import { createBridgeSocketGateway } from './bridge-socket.mjs';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const waitUntil = async (check) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 12000) throw Error('PREVIEW_TEST_TIMEOUT');
    await delay(5);
  }
};
async function fixture() {
  const connection = {
    connectionId: randomUUID(),
    deviceId: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    epoch: '1',
  };
  const server = new AllRiceHttpServer();
  server.bridgeGateway = await createBridgeSocketGateway({
    enabled: () => true,
    heartbeatMs: 5000,
    authority: {
      register: async () => connection,
      current: async () => {
        await delay(20);
        return true;
      },
      release: async () => undefined,
      subscribe: async () => () => undefined,
    },
    dispatch: async () => ({ status: 200, body: {} }),
  });
  server.on('upgrade', () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    await server.bridgeGateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${bridgeSocketPath}`,
    bridgeSocketProtocol,
    {
      headers: { authorization: 'Bearer synthetic-flow-test' },
      perMessageDeflate: false,
    },
  );
  const messages = [];
  let closeCode;
  ws.on('message', (bytes) => messages.push(JSON.parse(bytes.toString())));
  ws.on('error', () => undefined);
  ws.on('close', (code) => {
    closeCode = code;
  });
  cleanups.push(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
      await once(ws, 'close');
    }
  });
  await waitUntil(() => messages.some((f) => f.type === 'welcome'));
  const target = {
    backend: 'local',
    ...connection,
    ownerId: randomUUID(),
    serviceId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    containerId: 'a'.repeat(64),
    imageDigest: `sha256:${'b'.repeat(64)}`,
    port: 3000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hardDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
  };
  delete target.connectionId;
  delete target.epoch;
  return {
    ws,
    messages,
    target,
    gateway: server.bridgeGateway,
    closed: () => closeCode,
  };
}

async function httpRelay(f, bytes = Buffer.alloc(5_000_000, 97)) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  vi.spyOn(ContainerLoopback, 'connect').mockImplementation(async () => {
    const socket = connectTcp(server.address().port, '127.0.0.1');
    await once(socket, 'connect');
    return socket;
  });
  const errors = [];
  const relay = new ContainerProjectPreviewRelay({
    alive: () => true,
    assertTarget: async () => undefined,
    api: {
      socketPath: 'unused',
      json: async () => {
        throw Error('UNEXPECTED_DOCKER_CALL');
      },
    },
    onError: (error) => errors.push(error),
  });
  cleanups.push(() => relay.close());
  return { relay, errors, bytes, server };
}
const request = {
  method: 'GET',
  path: '/large.js',
  host: 'localhost',
  headers: {},
  websocket: false,
};
const sendWs = (ws, frame) =>
  new Promise((resolve, reject) =>
    ws.send(JSON.stringify(frame), (error) =>
      error ? reject(error) : resolve(true),
    ),
  );

it.each([1000, undefined])(
  'drains accepted WS messages before normal peer close (%s) with slow ACK',
  async (code) => {
    const f = await fixture(),
      h = await httpRelay(f),
      frames = [];
    const upstream = new WebSocketServer({
      server: h.server,
      perMessageDeflate: false,
    });
    cleanups.push(() => new Promise((resolve) => upstream.close(resolve)));
    upstream.on('connection', (socket) => {
      socket.send('first');
      socket.send('second');
      socket.close(code);
    });
    f.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type.startsWith('preview.'))
        h.relay.receive(frame, (outgoing) => sendWs(f.ws, outgoing));
    });
    await f.gateway.openPreview({
      id: randomUUID(),
      target: f.target,
      request: { ...request, websocket: true },
      onFrame: async (frame) => {
        await delay(20);
        frames.push(frame);
      },
    });
    await waitUntil(() => frames.some((frame) => frame.type === 'preview.end'));
    expect(frames.map((frame) => frame.type)).toEqual([
      'preview.response',
      'preview.data',
      'preview.data',
      'preview.end',
    ]);
    expect(
      frames
        .filter((frame) => frame.type === 'preview.data')
        .map((frame) => Buffer.from(frame.data, 'base64').toString()),
    ).toEqual(['first', 'second']);
    expect(h.errors).toEqual([]);
  },
);

it('streams two complete assets with a renewed live lease over Bridge WebSocket and slow consumption', async () => {
  const f = await fixture(),
    h = await httpRelay(f),
    bodies = new Map(),
    done = new Set();
  f.ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type.startsWith('preview.'))
      h.relay.receive(frame, (outgoing) => sendWs(f.ws, outgoing));
  });
  // A renewed live lease remains valid after the original open snapshot.
  f.target.expiresAt = new Date(Date.now() - 1000).toISOString();
  const ids = [randomUUID(), randomUUID()];
  const channels = await Promise.all(
    ids.map((id) =>
      f.gateway.openPreview({
        id,
        target: f.target,
        request,
        onFrame: async (frame) => {
          await delay(5);
          if (frame.type === 'preview.data') {
            const chunks = bodies.get(id) ?? [];
            chunks.push(Buffer.from(frame.data, 'base64'));
            bodies.set(id, chunks);
          }
          if (frame.type === 'preview.end') done.add(id);
        },
      }),
    ),
  );
  await Promise.all(
    channels.map((channel) => channel.send({ type: 'preview.end' })),
  );
  await waitUntil(() => done.size === 2);
  for (const id of ids)
    expect(Buffer.concat(bodies.get(id)).equals(h.bytes)).toBe(true);
  expect(h.errors).toEqual([]);
  expect(f.closed()).toBeUndefined();
  expect(f.ws.readyState).toBe(WebSocket.OPEN);
  expect(
    f.messages.filter((frame) => frame.type === 'preview.ack').length,
  ).toBeGreaterThan(10);
}, 15_000);

it('does not acknowledge a failed consumer or accept a wrong sequence', async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.gateway.openPreview({
    id,
    target: f.target,
    request,
    onFrame: async () => {
      throw Error('REVOKED');
    },
  });
  await sendWs(f.ws, {
    version: 1,
    id,
    type: 'preview.data',
    sequence: 1,
    data: 'YQ==',
  });
  await waitUntil(() =>
    f.messages.some((frame) => frame.id === id && frame.type === 'preview.end'),
  );
  expect(
    f.messages.some((frame) => frame.id === id && frame.type === 'preview.ack'),
  ).toBe(false);
  const another = randomUUID();
  await f.gateway.openPreview({
    id: another,
    target: f.target,
    request,
    onFrame: async () => undefined,
  });
  await sendWs(f.ws, {
    version: 1,
    id: another,
    type: 'preview.data',
    sequence: 2,
    data: 'YQ==',
  });
  await waitUntil(() => f.closed() !== undefined);
  expect(f.closed()).toBe(4000);
});

it.each(['close', 'wrong-ack', 'timeout', 'send-false'])(
  'releases a pending consumer on %s without replay',
  async (mode) => {
    const f = await fixture(),
      h = await httpRelay(f, Buffer.alloc(1000, 97)),
      id = randomUUID(),
      frames = [];
    const target = {
      ...f.target,
      hardDeadlineAt: new Date(Date.now() + 350).toISOString(),
    };
    const sender = async (frame) => {
      frames.push(frame);
      if (frame.type === 'preview.data') {
        if (mode === 'close')
          h.relay.receive(
            { version: 1, type: 'preview.end', id, error: true },
            sender,
          );
        if (mode === 'wrong-ack')
          h.relay.receive(
            {
              version: 1,
              type: 'preview.ack',
              id,
              sequence: frame.sequence + 1,
            },
            sender,
          );
        if (mode === 'send-false') return false;
      }
      return true;
    };
    h.relay.receive(
      {
        version: 1,
        id,
        type: 'preview.open',
        target,
        request: { ...request, flowControl: 'consumed-ack-v1' },
      },
      sender,
    );
    h.relay.receive({ version: 1, id, type: 'preview.end' }, sender);
    await waitUntil(() => h.errors.length > 0);
    expect(
      frames.filter((frame) => frame.type === 'preview.data'),
    ).toHaveLength(1);
    // A late ACK must not resurrect the closed request.
    h.relay.receive(
      { version: 1, id, type: 'preview.ack', sequence: 1 },
      sender,
    );
    await delay(20);
    expect(
      frames.filter((frame) => frame.type === 'preview.data'),
    ).toHaveLength(1);
  },
);

it('keeps direct/cloud promise-based consumption without remote ACK', async () => {
  const f = await fixture(),
    h = await httpRelay(f, Buffer.alloc(2000, 97)),
    id = randomUUID(),
    frames = [];
  const sender = async (frame) => {
    await delay(5);
    frames.push(frame);
    return true;
  };
  h.relay.receive(
    {
      version: 1,
      id,
      type: 'preview.open',
      target: { ...f.target, backend: 'cloud', deviceId: null },
      request,
    },
    sender,
  );
  h.relay.receive({ version: 1, id, type: 'preview.end' }, sender);
  await waitUntil(() => frames.some((frame) => frame.type === 'preview.end'));
  expect(
    Buffer.concat(
      frames
        .filter((frame) => frame.type === 'preview.data')
        .map((frame) => Buffer.from(frame.data, 'base64')),
    ),
  ).toEqual(h.bytes);
  expect(frames.some((frame) => frame.sequence !== undefined)).toBe(false);
  expect(h.errors).toEqual([]);
});
