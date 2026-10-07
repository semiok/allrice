import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import process from 'node:process';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
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
async function fixture({ browserOrigins = false } = {}) {
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
  const server = createServer((req, res) => {
    if (
      browserOrigins &&
      /^(employee|admin|foreign)\.allrice\.test:/.test(req.headers.host ?? '')
    ) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<iframe src="http://${host}/?_allrice_preview_ticket=${token}"></iframe>`,
      );
    } else void gateway.request(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port,
    suffix = `${browserOrigins ? 'preview.allrice.test' : 'preview.localhost'}:${port}`,
    host = `rice-preview-${id}.${suffix}`,
    mainOrigin = browserOrigins
      ? `http://employee.allrice.test:${port}`
      : `http://127.0.0.1:${port}`,
    adminOrigin = browserOrigins
      ? `http://admin.allrice.test:${port}`
      : undefined;
  const gateway = createProjectPreviewGateway({
    suffix,
    mainOrigin,
    adminOrigin,
    secure: false,
    resolveAccess: async (serviceId, key) => {
      if (!allowed || serviceId !== id || key !== token) throw Error('revoked');
      return { ...target };
    },
    transport: {
      openPreview: async (options) => {
        opened = options;
        if (browserOrigins)
          setTimeout(() => {
            void (async () => {
              await options.onFrame({
                type: 'preview.response',
                status: 200,
                headers: { 'content-type': 'text/html' },
              });
              await options.onFrame({
                type: 'preview.data',
                data: Buffer.from(
                  '<div id="source">fixture-preview</div>',
                ).toString('base64'),
              });
              await options.onFrame({ type: 'preview.end' });
            })().catch(() => options.onClose());
          }, 0);
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
    mainOrigin,
    adminOrigin,
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
    close: () => gateway.close(),
  };
}
describe('private preview live transfer authority', () => {
  it('streams a framework development bundle beyond four megabytes and rejects the finite response ceiling', async () => {
    for (const size of [5_000_000, 16_000_001]) {
      const f = await fixture(),
        request = f.send('GET');
      request.req.end();
      const outcome = request.response.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await until(() => f.opened());
      const opened = f.opened();
      await opened.onFrame({
        type: 'preview.response',
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      });
      try {
        for (let at = 0; at < size && !f.closed(); at += 250_000)
          await opened.onFrame({
            type: 'preview.data',
            data: Buffer.alloc(Math.min(250_000, size - at), 97).toString(
              'base64',
            ),
          });
        await opened.onFrame({ type: 'preview.end' });
      } catch (error) {
        expect(size).toBeGreaterThan(16_000_000);
        expect(error.message).toBe('PROJECT_PREVIEW_LIMIT');
        opened.onClose();
      }
      const result = await outcome;
      if (size <= 16_000_000) {
        expect(result.value.status).toBe(200);
        expect(Buffer.byteLength(result.value.body)).toBe(size);
      } else {
        expect(result.error).toBeDefined();
        expect(f.closed()).toBe(true);
      }
    }
  });
  it('rejects noncanonical or insecure production frame origins', () => {
    for (const adminOrigin of [
      'https://admin.example.test/path',
      'http://admin.example.test',
      'https://admin.example.test; https://foreign.example.test',
      'https://user@admin.example.test',
      'https://*.example.test',
    ]) {
      expect(() =>
        createProjectPreviewGateway({
          suffix: 'example.test',
          mainOrigin: 'https://employee.example.test',
          adminOrigin,
          resolveAccess: async () => {},
          transport: {},
        }),
      ).toThrow();
    }
  });

  it.skipIf(process.env.ALLRICE_RUN_BROWSER_INTEGRATION !== '1')(
    'embeds the authenticated preview in employee and admin origins while rejecting another same-site frame and revoked access',
    async () => {
      const f = await fixture({ browserOrigins: true });
      const { chromium } = createRequire(
        new URL('../../worker/package.json', import.meta.url),
      )('playwright-core');
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
        args: [
          '--no-proxy-server',
          '--host-resolver-rules=MAP *.allrice.test 127.0.0.1',
        ],
      });
      try {
        const page = await browser.newPage();
        for (const origin of [f.mainOrigin, f.adminOrigin]) {
          await page.goto(origin, { waitUntil: 'domcontentloaded' });
          await page
            .frameLocator('iframe')
            .getByText('fixture-preview', { exact: true })
            .waitFor();
        }
        const response = page.waitForResponse(
          (r) => r.url() === `http://${f.host}/` && r.status() === 200,
        );
        await page.goto(`http://foreign.allrice.test:${f.port}`, {
          waitUntil: 'domcontentloaded',
        });
        const csp = (await response).headers()['content-security-policy'];
        expect(csp).toContain(
          `frame-ancestors ${f.mainOrigin} ${f.adminOrigin};`,
        );
        expect(csp).not.toContain('foreign.allrice.test');
        await expect(
          page
            .frameLocator('iframe')
            .getByText('fixture-preview', { exact: true })
            .waitFor({ timeout: 1000 }),
        ).rejects.toThrow();
        f.revoke();
        const denied = page.waitForResponse(
          (r) => new URL(r.url()).host === f.host && r.status() === 403,
        );
        await page.goto(f.adminOrigin, { waitUntil: 'domcontentloaded' });
        expect((await denied).status()).toBe(403);
        await page
          .frameLocator('iframe')
          .getByText('预览已停止或授权已失效，请回到 AllRice 刷新状态。', {
            exact: true,
          })
          .waitFor();
      } finally {
        await browser.close();
      }
    },
    30000,
  );
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
    await f.close();
    expect(f.closed()).toBe(true);
  });
});
