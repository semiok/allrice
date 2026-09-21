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
import { tenantPolicyHttp } from '../../lib/tenant-administration/policy-http';
import { employeeAdministrationHttp } from '../../lib/tenant-administration/employee-http';
import { GET as employeeDirectory } from '../api/v1/admin/platform-employees/route';
import { GET as employeeLifecycle } from '../api/v1/admin/platform-employees/[employeeId]/lifecycle/route';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { savePlatformEmployeeDraft } from '../../../../packages/database/src/employees/platform-employees.ts';

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
          const result =
            parts[4] === 'platform-employees'
              ? !parts[5]
                ? await employeeDirectory(request)
                : parts[6] === 'lifecycle'
                  ? await employeeLifecycle(request, {
                      params: Promise.resolve({ employeeId: parts[5]! }),
                    })
                  : await employeeAdministrationHttp(
                      request,
                      parts[5]!,
                      parts[6] === 'review'
                        ? 'review'
                        : parts[6] === 'publish'
                          ? 'publish'
                          : 'save',
                    )
              : parts[4] === 'platform-skills'
                ? await employeeAdministrationHttp(request, parts[5]!, 'skill')
                : parts[6] === 'policy'
                  ? await tenantPolicyHttp(request, parts[5]!)
                  : await tenantAdministrationHttp(request, parts[5], parts[7]);
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
  it('configures a workspace policy through the actual UI and rejects stale and cross-origin writes', async () => {
    const { page, context } = await pageFor();
    try {
      await page.getByLabel('管理工作区').selectOption(snow.workspaceId);
      await page.getByRole('button', { name: '执行策略', exact: true }).click();
      await page.getByLabel('启用工作区策略').check();
      await page
        .getByLabel('local.process.execute 规则', { exact: true })
        .selectOption('allow');
      await page
        .getByLabel('策略修改原因')
        .fill('Synthetic explicit policy approval');
      await page
        .getByRole('button', { name: '确认保存策略', exact: true })
        .click();
      await page
        .getByText('策略已保存并审计；未开启平台执行开关，也未授予设备权限。', {
          exact: true,
        })
        .waitFor();
      await page
        .getByText('当前版本：1 · 保存将创建版本 2', { exact: true })
        .waitFor();
      expect(
        await page
          .getByRole('row')
          .filter({
            has: page.getByText('local.process.execute', { exact: true }),
          })
          .locator('td')
          .nth(2)
          .textContent(),
      ).toContain('需精确审批');
      const [stored] =
        await fixture.db`select controls from allrice_runtime_policy_controls where workspace_id=${snow.workspaceId}`;
      expect(stored!.controls).toMatchObject({
        version: 1,
        enabled: true,
        rules: [{ action: 'local.process.execute', effect: 'allow' }],
      });
      const body = {
        workspaceId: snow.workspaceId,
        expectedVersion: null,
        controls: stored!.controls,
        reason: 'Synthetic stale request',
      };
      const url = `${origin}/api/v1/admin/tenants/${snow.organizationId}/policy`;
      expect(
        (
          await context.request.put(url, {
            headers: { Origin: origin },
            data: body,
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await context.request.put(url, {
            headers: { Origin: 'https://foreign.example.test' },
            data: body,
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await context.request.put(url, {
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            data: '{broken',
          })
        ).status(),
      ).toBe(400);
      await page.reload();
      await page.getByLabel('管理租户').selectOption(snow.organizationId);
      await page.getByLabel('管理工作区').selectOption(snow.workspaceId);
      await page.getByRole('button', { name: '执行策略', exact: true }).click();
      await page
        .getByText('当前版本：1 · 保存将创建版本 2', { exact: true })
        .waitFor();
      await page.screenshot({
        path: '/tmp/met151-policy-desktop.png',
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
  it('reads real Skills and canonical tools, reviews an exact scope, rejects changed policy then publishes after fresh confirmation', async () => {
    const f = await createEmployeeAdministrationFixture(fixture.db);
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: {
        ...f.definition,
        name: 'MET151 UI fixture',
        capabilities: {
          ...f.definition.capabilities,
          toolNames: ['workspace.skill.read', 'browser.workspace'],
        },
      },
    });
    const { page, context } = await pageFor();
    try {
      await page.goto(
        `${origin}/runtime-console?view=employees&workspaceId=${f.workspaceId}`,
      );
      await page
        .getByRole('button')
        .filter({ hasText: 'MET151 UI fixture' })
        .click();
      await page.getByRole('button', { name: '工具', exact: true }).click();
      await page.getByText('云端浏览器工作区', { exact: true }).waitFor();
      await page.getByText('本地项目预览', { exact: true }).waitFor();
      await page.getByRole('checkbox', { name: /云端隔离脚本/ }).check();
      const saving = page.waitForResponse(
        (response) =>
          response.url() ===
            `${origin}/api/v1/admin/platform-employees/${f.employeeId}` &&
          response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
      const saved = await saving;
      expect(saved.status()).toBe(200);
      expect((await saved.json()).validation.valid).toBe(true);
      await expect
        .poll(async () =>
          page
            .getByRole('button', { name: '保存草稿', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      await f.preview(); // Synthetic completion only; draft save/compile above uses real UI/HTTP.
      const unreviewed = await context.request.post(
        `${origin}/api/v1/admin/platform-employees/${f.employeeId}/publish`,
        {
          headers: { Origin: origin },
          data: { workspaceIds: [f.workspaceId] },
        },
      );
      expect(unreviewed.status()).toBe(409);
      await page.getByRole('button', { name: '安全', exact: true }).click();
      expect(
        await page
          .locator('option[value="autonomous"]')
          .evaluate((option) => (option as HTMLOptionElement).disabled),
      ).toBe(true);
      await page.getByRole('button', { name: '技能', exact: true }).click();
      await page
        .getByRole('button', {
          name: `查看 p18-${f.skillId} 内容`,
          exact: true,
        })
        .click();
      await page
        .getByRole('region', { name: 'Skill 只读内容' })
        .getByText(/Synthetic reviewed Skill/)
        .waitFor();
      await page.getByRole('button', { name: '发布租户', exact: true }).click();
      // Choosing an employee deliberately clears publish scope: make it explicit again.
      const workspaceLabel = page
        .locator('label')
        .filter({ hasText: 'Synthetic publication' })
        .filter({ has: page.locator('input[type="checkbox"]') });
      await workspaceLabel.getByRole('checkbox').check();
      expect(
        await page
          .getByRole('button', { name: '发布到所选租户', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page
        .getByRole('button', { name: '预检发布与版本差异', exact: true })
        .click();
      await page.getByRole('region', { name: '发布预检' }).waitFor();
      await page.getByText(/browser.observe 当前策略禁止/).waitFor();
      await page.getByText(/查看与已发布版本的差异/).click();
      await page
        .getByLabel('我已确认版本差异、发布范围及尚未满足的运行条件', {
          exact: true,
        })
        .check();
      // Another administrator edits policy after review using the real HTTP service.
      const url = `${origin}/api/v1/admin/tenants/${f.organizationId}/policy`;
      expect(
        (
          await context.request.put(url, {
            headers: { Origin: origin },
            data: {
              workspaceId: f.workspaceId,
              expectedVersion: null,
              controls: {
                version: 1,
                enabled: false,
                mode: 'execute',
                rules: [],
              },
              reason: 'Synthetic concurrent policy change',
            },
          })
        ).status(),
      ).toBe(200);
      await page
        .getByRole('button', { name: '发布到所选租户', exact: true })
        .click();
      await page
        .getByText(/请重新预检并确认发布范围/)
        .first()
        .waitFor();
      expect(await f.assigned()).toBe(0);
      await page
        .getByRole('button', { name: '预检发布与版本差异', exact: true })
        .click();
      await page
        .getByLabel('我已确认版本差异、发布范围及尚未满足的运行条件', {
          exact: true,
        })
        .check();
      await page.screenshot({
        path: '/tmp/met151-publication-review.png',
        fullPage: true,
      });
      await page
        .getByRole('button', { name: '发布到所选租户', exact: true })
        .click();
      await page
        .getByText(/发布成功：revision/)
        .first()
        .waitFor();
      expect(await f.assigned()).toBe(1);
      expect(
        await fixture.db`select id from allrice_memberships where user_id=${platform.user.id} and organization_id=${f.organizationId}`,
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  }, 60000);
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
