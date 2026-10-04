import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { createCloudProjectPreviewTransport } from './cloud-project-preview.mjs';
import { createProjectPreviewGateway } from './project-preview.mjs';

it('uses only the private Unix socket and normalizes gateway frames without losing final response frames', async () => {
  const directory = await mkdtemp('/tmp/ar-preview-'),
    path = join(directory, 'p.sock'),
    id = randomUUID();
  const server = createServer(),
    wss = new WebSocketServer({ server, path: '/internal/project-preview' }),
    received = [],
    responses = [];
  const target = {
    serviceId: id,
    operationId: id,
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    backend: 'cloud',
    deviceId: null,
    attemptId: randomUUID(),
    containerId: 'a'.repeat(64),
    imageDigest: 'sha256:' + 'b'.repeat(64),
    port: 4173,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    hardDeadlineAt: new Date(Date.now() + 120000).toISOString(),
  };
  const transport = createCloudProjectPreviewTransport(path);
  try {
    wss.on('connection', (socket) =>
      socket.on('message', (bytes) => {
        const frame = JSON.parse(bytes);
        received.push(frame);
        if (frame.type === 'preview.end') {
          socket.send(
            JSON.stringify({
              version: 1,
              id,
              type: 'preview.response',
              status: 200,
              headers: { 'content-type': 'text/plain' },
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              id,
              type: 'preview.data',
              data: Buffer.from('42').toString('base64'),
            }),
          );
          socket.send(
            JSON.stringify({ version: 1, id, type: 'preview.end' }),
            () => socket.close(),
          );
        }
      }),
    );
    server.listen(path);
    await once(server, 'listening');
    let done;
    const closed = new Promise((resolve) => {
      done = resolve;
    });
    const channel = await transport.openPreview({
      id,
      target,
      request: {
        method: 'GET',
        path: '/',
        host: 'rice-preview-' + id + '.preview.allrice.test',
        websocket: false,
        headers: {},
      },
      onFrame: (frame) => {
        responses.push(frame);
      },
      onClose: done,
    });
    expect(await channel.send({ type: 'preview.end' })).toBe(true);
    await closed;
    expect(received.map((frame) => frame.type)).toEqual([
      'preview.open',
      'preview.end',
    ]);
    expect(
      received.every((frame) => frame.id === id && frame.version === 1),
    ).toBe(true);
    expect(responses.map((frame) => frame.type)).toEqual([
      'preview.response',
      'preview.data',
      'preview.end',
    ]);
    expect(Buffer.from(responses[1].data, 'base64').toString()).toBe('42');
    await expect(channel.send({ type: 'preview.end' })).rejects.toThrow(
      'CLOUD_PREVIEW_LOST',
    );
  } finally {
    transport.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it('carries the immediate WebSocket connected frame through private IPC and the public gateway', async () => {
  const directory = await mkdtemp('/tmp/ar-ws-'),
    path = join(directory, 'p.sock'),
    id = randomUUID(),
    token = 'fixture-access';
  const privateServer = createServer(),
    privateWs = new WebSocketServer({
      server: privateServer,
      path: '/internal/project-preview',
    }),
    publicServer = createServer();
  const transport = createCloudProjectPreviewTransport(path),
    errors = [];
  let gateway, client;
  try {
    privateWs.on('connection', (socket) =>
      socket.on('message', (bytes) => {
        const frame = JSON.parse(bytes);
        if (frame.type === 'preview.open') {
          expect(frame.request.websocket).toBe(true);
          socket.send(
            JSON.stringify({
              version: 1,
              id: frame.id,
              type: 'preview.response',
              status: 101,
              headers: { 'sec-websocket-protocol': frame.request.protocol },
            }),
          );
          socket.send(
            JSON.stringify({
              version: 1,
              id: frame.id,
              type: 'preview.data',
              binary: false,
              data: Buffer.from('{"type":"connected"}').toString('base64'),
            }),
          );
        }
      }),
    );
    privateServer.listen(path);
    await once(privateServer, 'listening');
    publicServer.listen(0, '127.0.0.1');
    await once(publicServer, 'listening');
    const port = publicServer.address().port,
      suffix = 'preview.allrice.test:' + port,
      host = 'rice-preview-' + id + '.' + suffix;
    const target = {
      serviceId: id,
      operationId: id,
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
      backend: 'cloud',
      deviceId: null,
      attemptId: randomUUID(),
      containerId: 'a'.repeat(64),
      imageDigest: 'sha256:' + 'b'.repeat(64),
      port: 4173,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      hardDeadlineAt: new Date(Date.now() + 120000).toISOString(),
    };
    gateway = createProjectPreviewGateway({
      suffix,
      mainOrigin: 'http://127.0.0.1:' + port,
      secure: false,
      transport,
      resolveAccess: async (service, key) => {
        if (service !== id || key !== token) throw Error('unavailable');
        return target;
      },
      onError: (error) => errors.push(String(error)),
    });
    publicServer.on(
      'upgrade',
      (req, socket, head) => void gateway.upgrade(req, socket, head),
    );
    client = new WebSocket('ws://127.0.0.1:' + port + '/', 'vite-hmr', {
      headers: {
        Host: host,
        Origin: 'http://' + host,
        Cookie: 'allrice_preview_test=' + token,
      },
    });
    const [message] = await once(client, 'message');
    expect(JSON.parse(message.toString())).toEqual({ type: 'connected' });
    expect(errors).toEqual([]);
  } finally {
    client?.terminate();
    await gateway?.close();
    transport.close();
    for (const socket of privateWs.clients) socket.terminate();
    await new Promise((resolve) => privateWs.close(resolve));
    await new Promise((resolve) => privateServer.close(resolve));
    await new Promise((resolve) => publicServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
