import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../../../../packages/database/src/identity.ts';
import { tenantAdministrationHttp } from '../../lib/tenant-administration/http';

const ports = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-151 management UI -> HTTP -> real isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    browser: Browser,
    server: Server,
    origin: string;
  let platform: Awaited<ReturnType<typeof principal>>,
    snow: Awaited<ReturnType<typeof principal>>,
    other: Awaited<ReturnType<typeof principal>>;
  const requests: string[] = [],
    failures: string[] = [];
  async function principal(displayName: string, role: 'admin' | 'member') {
    const slug = `t-${randomUUID()}`;
    const input = {
      organizationSlug: slug,
      organizationName: displayName,
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `${slug}@example.test`,
      displayName,
      role,
    };
    const p = await ensureBootstrapPortalPrincipal(input, fixture.db),
      session = await createSession(p.user.id);
    return { ...p, input, session };
  }
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    platform = await principal('Platform fixture', 'admin');
    snow = await principal('Snow fixture', 'member');
    other = await principal('Other fixture', 'member');
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', platform.user.email);
    ports.context.mockImplementation(async (request: Request) => {
      const token = request.headers
        .get('cookie')
        ?.match(/fixture_session=([^;]+)/)?.[1];
      return token ? authenticateSession(token) : null;
    });
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['apps/web/test/tenant-administration-page.tsx'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/unused-tenant-admin',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const js = built.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('.js'),
      ).contents,
      css = built.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('.css'),
      ).contents;
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, origin),
          path = url.pathname;
        if (path.startsWith('/api/')) {
          requests.push(`${req.method} ${path}`);
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (typeof value === 'string') headers.set(key, value);
          const request = new Request(url, {
            method: req.method,
            headers,
            ...(chunks.length
              ? { body: Buffer.concat(chunks).toString('utf8') }
              : {}),
          });
          const parts = path.split('/');
          const result = await tenantAdministrationHttp(
            request,
            parts[5],
            parts[7],
          );
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(await result.text());
          return;
        }
        res.writeHead(200, {
          'Content-Type':
            path === '/app.js'
              ? 'application/javascript'
              : path === '/app.css'
                ? 'text/css'
                : 'text/html',
        });
        res.end(
          path === '/app.js'
            ? js
            : path === '/app.css'
              ? css
              : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#101216"><div id="root"></div><script src="/app.js"></script></body></html>',
        );
      } catch (e) {
        failures.push(e instanceof Error ? e.name : 'fixture_error');
        res.writeHead(500);
        res.end('{}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('fixture_address');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(
      resolve(process.cwd(), 'apps/worker/package.json'),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  }, 120000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
    expect(failures).toEqual([]);
  });
  async function pageFor(p = platform, width = 1440) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    await context.addCookies([
      { name: 'fixture_session', value: p.session.token, url: origin },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => failures.push(e.name));
    await page.goto(origin);
    await page.getByLabel('管理租户').selectOption(snow.organizationId);
    await page
      .getByRole('button', { name: '编辑 Snow fixture', exact: true })
      .waitFor();
    return { page, context };
  }
  it('saves an explicit role via the real HTTP/DB path, refreshes it, and does not grant platform membership', async () => {
    const { page, context } = await pageFor();
    try {
      await page
        .getByRole('button', { name: '编辑 Snow fixture', exact: true })
        .click();
      await page.getByLabel('成员角色').selectOption('viewer');
      await page.getByLabel('修改原因').fill('Synthetic browser acceptance');
      await page
        .getByRole('button', { name: '确认保存授权', exact: true })
        .click();
      await page
        .getByRole('status')
        .filter({ hasText: '修改已保存' })
        .waitFor();
      const [row] =
        await fixture.db`select role,id from allrice_memberships where user_id=${snow.user.id} and organization_id=${snow.organizationId}`;
      expect(row!.role).toBe('viewer');
      const [audit] =
        await fixture.db`select actor_id,metadata from allrice_audit_events where resource_id=${row!.id} and action='tenant.member.updated' order by occurred_at desc limit 1`;
      expect(audit!.actor_id).toBe(platform.user.id);
      expect(audit!.metadata.deviceAuthorizationChanged).toBe(false);
      await ensureBootstrapPortalPrincipal(snow.input, fixture.db);
      await page.reload();
      await page.getByLabel('管理租户').selectOption(snow.organizationId);
      await page
        .getByRole('row')
        .filter({ hasText: 'Snow fixture' })
        .getByText('只读成员', { exact: true })
        .waitFor();
      await page.screenshot({ path: '/tmp/met151-tenant-admin-desktop.png' });
      expect(
        await page
          .getByRole('table')
          .evaluate((table) => getComputedStyle(table).color),
      ).toBe('rgb(233, 237, 242)');
      expect(
        await fixture.db`select id from allrice_memberships where user_id=${platform.user.id} and organization_id=${snow.organizationId}`,
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
  it('discards unsaved state only after confirmation, keeps scope isolated, and renders narrow screens', async () => {
    const { page, context } = await pageFor(platform, 390);
    try {
      await page
        .getByRole('button', { name: '编辑 Snow fixture', exact: true })
        .click();
      await page.getByLabel('修改原因').fill('Do not leak this draft');
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByLabel('管理租户').selectOption(other.organizationId);
      expect(await page.getByLabel('管理租户').inputValue()).toBe(
        snow.organizationId,
      );
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByLabel('管理租户').selectOption(other.organizationId);
      await page
        .getByRole('button', { name: '编辑 Other fixture', exact: true })
        .waitFor();
      expect(await page.getByLabel('修改原因').count()).toBe(0);
      expect(await page.getByText('Do not leak this draft').count()).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: '/tmp/met151-tenant-admin-mobile.png' });
    } finally {
      await context.close();
    }
  });
  it('denies tenant-admin direct API requests and cross-origin writes, and treats unconfirmed saves as non-retryable', async () => {
    const { page, context } = await pageFor();
    try {
      await page
        .getByRole('button', { name: '编辑 Snow fixture', exact: true })
        .click();
      await page.getByLabel('成员角色').selectOption('member');
      await page.getByLabel('修改原因').fill('Synthetic unavailable save');
      const before = requests.filter((r) => r.startsWith('PATCH')).length;
      await page.route('**/members/*', (route) =>
        route.fulfill({
          status: 503,
          json: { code: 'TENANT_ADMIN_UNAVAILABLE' },
        }),
      );
      await page
        .getByRole('button', { name: '确认保存授权', exact: true })
        .click();
      await page.getByRole('alert').waitFor();
      expect(
        await page
          .getByRole('button', { name: '确认保存授权', exact: true })
          .count(),
      ).toBe(0);
      expect(requests.filter((r) => r.startsWith('PATCH')).length).toBe(before);
      await page.unroute('**/members/*');
      await page.getByRole('button', { name: '刷新成员', exact: true }).click();
      await page
        .getByRole('button', { name: '编辑 Snow fixture', exact: true })
        .waitFor();
      const [row] =
        await fixture.db`select id,md5(to_jsonb(m)::text) as version from allrice_memberships m where user_id=${snow.user.id} and organization_id=${snow.organizationId}`;
      const payload = {
        workspaceId: null,
        expectedVersion: row!.version,
        role: 'admin',
        active: true,
        reason: 'Synthetic rejected write',
      };
      const write = await context.request.patch(
        `${origin}/api/v1/admin/tenants/${snow.organizationId}/members/${row!.id}`,
        { headers: { Origin: 'https://attacker.example' }, data: payload },
      );
      expect(write.status()).toBe(403);
      await fixture.db`update allrice_memberships set role='admin' where user_id=${snow.user.id}`;
      await context.addCookies([
        { name: 'fixture_session', value: snow.session.token, url: origin },
      ]);
      expect(
        (await context.request.get(`${origin}/api/v1/admin/tenants`)).status(),
      ).toBe(403);
      expect(
        (
          await context.request.patch(
            `${origin}/api/v1/admin/tenants/${snow.organizationId}/members/${row!.id}`,
            { headers: { Origin: origin }, data: payload },
          )
        ).status(),
      ).toBe(403);
    } finally {
      await context.close();
    }
  });
});
