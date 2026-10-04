import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createProjectPreviewGateway } from './project-preview.mjs';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('preview assertion timed out');
    await delay(5);
  }
}
async function fixture() {
  const id = randomUUID(),
    token = 'opaque-session-ticket';
  let allowed = true,
    opened,
    closed = false;
  const frames = [],
    target = {
      serviceId: id,
      operationId: id,
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
      backend: 'local',
      deviceId: randomUUID(),
      attemptId: randomUUID(),
      containerId: 'a'.repeat(64),
      imageDigest: 'sha256:' + 'b'.repeat(64),
      port: 4173,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      hardDeadlineAt: new Date(Date.now() + 120000).toISOString(),
    };
  const server = createServer((req, res) => void gateway.request(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port,
    suffix = `preview.localhost:${port}`,
    host = `rice-preview-${id}.${suffix}`;
  const gateway = createProjectPreviewGateway({
    suffix,
    mainOrigin: `http://127.0.0.1:${port}`,
    secure: false,
    resolveAccess: async (serviceId, key) => {
      if (!allowed || serviceId !== id || key !== token) throw Error('revoked');
      return { ...target };
    },
    transport: {
      openPreview: async (options) => {
        opened = options;
        return {
          send: async (frame) => {
            frames.push(frame);
            return true;
          },
          close: () => {
            closed = true;
          },
        };
      },
    },
  });
  server.on(
    'upgrade',
    (req, socket, head) => void gateway.upgrade(req, socket, head),
  );
  cleanups.push(async () => {
    await gateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const send = (method) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      method,
      path: '/',
      headers: {
        host,
        origin: `http://${host}`,
        cookie: `allrice_preview_test=${token}`,
        'content-type': 'text/plain',
      },
    });
    req.on('error', () => undefined);
    const response = new Promise((resolve, reject) => {
      req.once('response', (res) => {
        const parts = [];
        res.on('data', (bytes) => parts.push(bytes));
        res.once('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(parts).toString(),
          }),
        );
        res.once('error', reject);
      });
      req.once('error', (error) =>
        error.code === 'ECONNRESET'
          ? resolve({ status: 0, body: '' })
          : reject(error),
      );
    });
    return { req, response };
  };
  return {
    host,
    port,
    token,
    frames,
    target,
    send,
    revoke: () => {
      allowed = false;
    },
    opened: () => opened,
    closed: () => closed,
  };
}
describe('private preview live transfer authority', () => {
  it('preserves the public WebSocket origin, token query and protocol on the private loopback hop', async () => {
    const f = await fixture(),
      path = '/?token=vite-hmr-test',
      socket = new WebSocket(`ws://127.0.0.1:${f.port}${path}`, 'vite-hmr', {
        headers: {
          host: f.host,
          origin: `http://${f.host}`,
          cookie: `allrice_preview_test=${f.token}`,
        },
      });
    socket.on('error', () => undefined);
    cleanups.push(async () => socket.terminate());
    await until(() => f.opened() !== undefined);
    expect(f.opened().request).toEqual({
      method: 'GET',
      path,
      host: '127.0.0.1:4173',
      headers: { origin: `http://${f.host}` },
      websocket: true,
      protocol: 'vite-hmr',
    });
    const ready = once(socket, 'open');
    await f.opened().onFrame({
      type: 'preview.response',
      status: 101,
      headers: { 'sec-websocket-protocol': 'vite-hmr' },
    });
    await ready;
  });
  it('rejects a foreign public WebSocket origin before opening the private transfer', async () => {
    const f = await fixture(),
      socket = new WebSocket(`ws://127.0.0.1:${f.port}/`, 'vite-hmr', {
        headers: {
          host: f.host,
          origin: 'http://other.invalid',
          cookie: `allrice_preview_test=${f.token}`,
        },
      });
    socket.on('error', () => undefined);
    cleanups.push(async () => socket.terminate());
    const [request, response] = await once(socket, 'unexpected-response');
    expect(response.statusCode).toBe(403);
    expect(f.opened()).toBeUndefined();
    response.destroy();
    request.destroy();
  });
  it('uses the bound loopback host only after authenticating the public request', async () => {
    const f = await fixture(),
      { req, response } = f.send('GET');
    req.end();
    await until(() => f.opened() !== undefined);
    expect(f.opened().request.host).toBe('127.0.0.1:4173');
    expect(f.opened().request.headers.origin).toMatch(
      /^http:\/\/rice-preview-/,
    );
    expect(f.opened().request.headers.cookie).toBeUndefined();
    f.opened().onClose();
    await response.catch(() => undefined);
  });
  it('revocation during an upload denies later body chunks and the end marker', async () => {
    const f = await fixture(),
      { req, response } = f.send('POST');
    req.write('before');
    await until(() => f.frames.some((frame) => frame.type === 'preview.data'));
    f.revoke();
    req.end('after');
    expect([0, 403]).toContain((await response).status);
    expect(f.frames.map((frame) => frame.type)).toEqual(['preview.data']);
    expect(Buffer.from(f.frames[0].data, 'base64').toString()).toBe('before');
    expect(f.closed()).toBe(true);
  });
  it('a changed target is denied before forwarding the next request chunk', async () => {
    const f = await fixture(),
      { req, response } = f.send('POST');
    req.write('before');
    await until(() => f.frames.length === 1);
    f.target.port = 4174;
    req.end('after');
    expect([0, 403]).toContain((await response).status);
    expect(f.frames.length).toBe(1);
    expect(f.closed()).toBe(true);
  });
  it('a revoked login cannot deliver a response frame already queued by the Bridge', async () => {
    const f = await fixture(),
      { req, response } = f.send('GET');
    req.end();
    await until(() => f.frames.some((frame) => frame.type === 'preview.end'));
    f.revoke();
    await expect(
      f
        .opened()
        .onFrame({ type: 'preview.response', status: 200, headers: {} }),
    ).rejects.toThrow('revoked');
    f.opened().onClose();
    await response.catch(() => undefined);
    expect(f.closed()).toBe(true);
  });
});
