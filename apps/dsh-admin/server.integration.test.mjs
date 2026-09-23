/* global URLSearchParams, fetch, process */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { get, createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { expect, it } from 'vitest';

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

it('boots the pinned native WebUI behind both authentication boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-admin-test-'));
  const gatewayPort = await port(),
    nativePort = await port();
  const gateway = `http://127.0.0.1:${gatewayPort}`;
  const native = `http://127.0.0.1:${nativePort}`;
  const syncToken = 'synthetic-readonly-sync-token-32-bytes';
  let syncRequests = 0,
    syncMode = 'available';
  const sync = httpServer((req, res) => {
    syncRequests++;
    if (
      req.url !== '/api/v1/internal/runtime-capabilities' ||
      req.headers.authorization !== `Bearer ${syncToken}`
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(syncMode === 'unavailable' ? 503 : 200, {
      'content-type': 'application/json',
    });
    res.end(
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: new Date(
          Date.now() - (syncMode === 'stale' ? 60000 : 0),
        ).toISOString(),
        webReleaseSha: 'synthetic-release',
        workerReleaseShas: [],
        versions: ['test-version'],
        onlineWorkers: 1,
        componentCount: '32',
        enhancementCount: '7',
        availableSkills: 11,
        publishedSkills: 10,
        publications: 3,
        capabilities: [{ id: 'assistants', status: 'Worker 功能开关未开启' }],
      }),
    );
  });
  sync.listen(0, '127.0.0.1');
  await once(sync, 'listening');

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        DSH_HOME: root,
        ALLRICE_DSH_ADMIN_HOME: root,
        ALLRICE_DSH_ADMIN_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
        ALLRICE_CAPABILITY_SYNC_TOKEN: syncToken,
        ALLRICE_CAPABILITY_SYNC_BASE_URL: `http://127.0.0.1:${sync.address().port}`,
        ALLRICE_DSH_ADMIN_HOST: '127.0.0.1',
        ALLRICE_DSH_ADMIN_PORT: String(gatewayPort),
        ALLRICE_DSH_WEBUI_PORT: String(nativePort),
        ALLRICE_DSH_ADMIN_ALLOWED_HOSTS: '127.0.0.1,localhost',
        ALLRICE_DSH_ADMIN_USER: 'admin',
        ALLRICE_DSH_ADMIN_PASSWORD: 'synthetic-test-password',
        ALLRICE_DSH_ADMIN_SESSION_SECRET:
          'synthetic-secret-for-disposable-test-only',
        ALLRICE_DSH_ADMIN_SECURE_COOKIE: '0',
      },
    },
  );
  const closed = once(child, 'close');
  const request = (path, options = {}) =>
    fetch(gateway + path, { redirect: 'manual', ...options });
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await request('/health/live')).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15000 },
      )
      .toBe(200);
    expect((await request('/api/allrice/capabilities')).status).toBe(303);
    expect(syncRequests).toBe(0);
    expect((await request('/')).status).toBe(303);
    expect((await request('/api/connection')).status).toBe(303);
    expect(
      (
        await request('/', {
          headers: { cookie: 'allrice_dsh_admin_session=forged' },
        })
      ).status,
    ).toBe(303);
    const foreignHost = await new Promise((resolve, reject) => {
      get(
        gateway + '/health/live',
        { headers: { host: 'untrusted.invalid' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on('error', reject);
    });
    expect(foreignHost).toBe(421);
    expect(
      (
        await request('/login', {
          method: 'POST',
          body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
        })
      ).status,
    ).toBe(401);
    const login = await request('/login', {
      method: 'POST',
      body: new URLSearchParams({
        username: 'admin',
        password: 'synthetic-test-password',
      }),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    let html;
    await expect
      .poll(
        async () => {
          const response = await request('/', {
            headers: { cookie, accept: 'text/html' },
          });
          html = await response.text();
          expect(response.headers.get('set-cookie')).toBeNull();
          return response.status;
        },
        { timeout: 30000 },
      )
      .toBe(200);
    expect(html).toContain(
      '<meta name="allrice-dsh-admin" content="authenticated">',
    );
    expect(html).toContain('__ModuleLoader__');
    expect(html).not.toContain('?token=');
    expect((await fetch(native + '/', { redirect: 'manual' })).status).toBe(
      401,
    );
    let status;
    await expect
      .poll(
        async () => {
          const response = await request('/api/allrice/capabilities', {
            headers: { cookie },
          });
          expect(response.headers.get('cache-control')).toBe('no-store');
          status = await response.json();
          return (
            status.native?.components.filter((c) => c.state === 'active')
              .length ?? 0
          );
        },
        { timeout: 15000 },
      )
      .toBeGreaterThan(5);
    expect(status.native.version).toBe('0.1.5-rc.3');
    expect(status.allrice.data).toMatchObject({
      componentCount: '32',
      publishedSkills: 10,
    });
    expect(JSON.stringify(status)).not.toContain(syncToken);
    expect(JSON.stringify(status)).not.toContain(root);
    const syncCount = syncRequests;
    expect(
      (
        await request('/api/allrice/capabilities', {
          headers: { cookie, origin: 'https://untrusted.invalid' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/allrice/capabilities', {
          method: 'POST',
          headers: { cookie },
        })
      ).status,
    ).toBe(405);
    expect(syncRequests).toBe(syncCount);
    for (const mode of ['unavailable', 'stale']) {
      syncMode = mode;
      const failed = await (
        await request('/api/allrice/capabilities', { headers: { cookie } })
      ).json();
      expect(failed.allrice).toEqual({ status: 'unavailable', data: null });
      expect(failed.native.components.some((c) => c.state === 'active')).toBe(
        true,
      );
    }
    // A native 404 proves authenticated API routing, distinct from its 401/403 fence.
    const api = await request('/api/allrice-missing-route', {
      headers: { cookie, origin: gateway },
    });
    expect(api.status).toBe(404);
    expect(api.headers.get('set-cookie')).toBeNull();
    expect(
      (
        await request('/api/allrice-missing-route', {
          headers: { cookie, origin: 'https://untrusted.invalid' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/', {
          headers: { cookie, 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  } finally {
    stop(child);
    await closed;
    await new Promise((resolve) => sync.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
