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
  login,
  createManagedOrganization,
  importOrganizationPeople,
  getEmployeeWorkspace,
} from '@allrice/database';
import { organizationAdministrationHttp } from '../../lib/organization-administration/http';
import { organizationAssignmentsHttp } from '../../lib/organization-administration/assignments-http';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';

const ports = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('company administration UI -> HTTP -> isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    browser: Browser,
    server: Server,
    origin: string,
    adminToken: string;
  const failures: string[] = [];
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const p = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Platform',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: 'browser-admin@example.test',
      displayName: 'Admin',
      role: 'member',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    adminToken = (await createSession(p.user.id)).token;
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
      entryPoints: ['apps/web/test/organization-administration-page.tsx'],
      bundle: true,
      format: 'esm',
      splitting: true,
      platform: 'browser',
      write: false,
      outdir: '/unused-org-admin',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      built.outputFiles.map((f: { path: string; contents: Uint8Array }) => [
        f.path.slice(f.path.lastIndexOf('/')),
        f.contents,
      ]),
    );
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, origin);
        if (url.pathname.startsWith('/api/')) {
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
          const parts = url.pathname.split('/'),
            action =
              parts[8] === 'status'
                ? 'status'
                : parts[8] === 'password'
                  ? 'password'
                  : parts[6] === 'people' && !parts[7]
                    ? 'people'
                    : undefined;
          const response =
            parts[6] === 'ai-employees'
              ? await organizationAssignmentsHttp(request, parts[5]!)
              : await organizationAdministrationHttp(
                  request,
                  parts[5],
                  parts[7],
                  action,
                );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(await response.text());
          return;
        }
        const asset = assets.get(url.pathname);
        res.writeHead(200, {
          'content-type': url.pathname.endsWith('.js')
            ? 'application/javascript'
            : url.pathname.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        });
        res.end(
          asset ??
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/organization-administration-page.css"></head><body style="margin:0;background:#101216"><div id="root"></div><script type="module" src="/organization-administration-page.js"></script></body></html>',
        );
      } catch (e) {
        failures.push(String(e));
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
        process.env.ALLRICE_TEST_CHROMIUM_PATH ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  }, 120000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) =>
      server ? server.close(() => done()) : done(),
    );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });

  it('creates a company and employees, imports a spreadsheet, edits profiles, resets passwords and disables access', async () => {
    const context = await browser.newContext({
      viewport: { width: 1360, height: 1000 },
    });
    await context.addCookies([
      { name: 'fixture_session', value: adminToken, url: origin },
    ]);
    const page = await context.newPage(),
      errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const username = `snow-${randomUUID().slice(0, 8)}`;
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: '新建公司', exact: true }).click();
      await page.getByLabel('公司名称', { exact: true }).fill('星米科技');
      await page.getByLabel('公司业务背景').fill('企业服务与文创产品');
      await page.getByRole('button', { name: '保存公司', exact: true }).click();
      await page
        .getByRole('heading', { name: '星米科技', exact: true })
        .waitFor();
      const organizationId = await page.getByLabel('管理公司').inputValue();
      expect(await page.getByLabel('管理工作区').count()).toBe(0);
      await page.getByRole('button', { name: '添加员工', exact: true }).click();
      await page.getByLabel('英文账号', { exact: true }).fill(username);
      await page.getByLabel('姓名', { exact: true }).fill('小雪');
      await page.getByLabel('岗位', { exact: true }).fill('财务');
      await page.getByLabel('职能', { exact: true }).fill('供应商对账');
      await page.getByRole('button', { name: '保存员工', exact: true }).click();
      const row = page.getByRole('row').filter({ hasText: username });
      await row.waitFor();
      const signed = await login({ username, password: 'admin@321' });
      expect(
        (await authenticateSession(signed.session.token))?.organizationId,
      ).toBe(organizationId);
      await page.getByRole('button', { name: '批量导入', exact: true }).click();
      await page
        .getByLabel('员工表格')
        .fill('lin\t小林\t运营\t活动策划\nchen\t小陈\t销售\t客户维护');
      await page
        .getByRole('button', { name: '创建这些员工', exact: true })
        .click();
      await page.getByRole('row').filter({ hasText: '小陈' }).waitFor();
      await row.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('姓名', { exact: true }).fill('林小雪');
      await page.getByLabel('岗位', { exact: true }).fill('财务经理');
      await page.getByRole('button', { name: '保存员工', exact: true }).click();
      await expect.poll(() => row.textContent()).toContain('财务经理');
      await row.getByRole('button', { name: '重置密码', exact: true }).click();
      const reset = page.locator('form').filter({
        has: page.getByRole('heading', { name: '重置 林小雪 的密码' }),
      });
      await reset
        .getByLabel('新密码', { exact: true })
        .fill('browser-new-password');
      await reset
        .getByRole('button', { name: '重置密码', exact: true })
        .click();
      await page
        .getByText('密码已重置，旧登录已退出。', { exact: true })
        .waitFor();
      expect(await authenticateSession(signed.session.token)).toBeNull();
      expect(
        (await login({ username, password: 'browser-new-password' })).user.id,
      ).toBe(signed.user.id);
      await row.getByRole('button', { name: '停用账号', exact: true }).click();
      await row.getByText('已停用', { exact: true }).waitFor();
      await expect(
        login({ username, password: 'browser-new-password' }),
      ).rejects.toMatchObject({ code: 'authentication_failed' });
      await row.getByRole('button', { name: '启用账号', exact: true }).click();
      await row.getByText('可登录', { exact: true }).waitFor();
      await page.getByRole('button', { name: '批量导入', exact: true }).click();
      await page
        .getByLabel('员工表格')
        .fill(
          `new-person\t新员工\t助理\t整理资料\n${username}\t重复账号\t财务\t对账`,
        );
      await page
        .getByRole('button', { name: '创建这些员工', exact: true })
        .click();
      await page
        .getByRole('alert')
        .filter({ hasText: '英文账号已被使用' })
        .waitFor();
      expect(
        await fixture.db`select id from allrice_users where username='new-person'`,
      ).toHaveLength(0);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      if (process.env.ALLRICE_ORG_SCREENSHOT)
        await page.screenshot({
          path: process.env.ALLRICE_ORG_SCREENSHOT,
          fullPage: true,
        });
      const ordinary = await login({
        username,
        password: 'browser-new-password',
      });
      const denied = await page.request.get(
        `${origin}/api/v1/admin/organizations`,
        { headers: { cookie: `fixture_session=${ordinary.session.token}` } },
      );
      expect(denied.status()).toBe(403);
      const forged = await page.request.post(
        `${origin}/api/v1/admin/organizations`,
        {
          headers: { origin: 'https://attacker.invalid' },
          data: { name: '越权公司' },
        },
      );
      expect(forged.status()).toBe(403);
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60000);
  it('edits company defaults and selected employees through the real assignment API without granting other people', async () => {
    const admin = (await authenticateSession(adminToken))!;
    const c = await createManagedOrganization(admin, { name: '批量配发公司' });
    const source = await createEmployeeAdministrationFixture(fixture.db);
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    await importOrganizationPeople(admin, c.organizationId, {
      people: [
        {
          username: 'assignment-snow',
          displayName: '配发小雪',
          jobTitle: '财务',
        },
        {
          username: 'assignment-drink',
          displayName: '配发小李',
          jobTitle: '运营',
        },
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1360, height: 1000 },
    });
    await context.addCookies([
      { name: 'fixture_session', value: adminToken, url: origin },
    ]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${origin}?organizationId=${c.organizationId}`);
      await page
        .getByRole('heading', { name: '批量配发公司', exact: true })
        .waitFor();
      await page.getByLabel('选择 配发小雪', { exact: true }).check();
      await page.getByRole('button', { name: '配置已选员工的 AI · 1' }).click();
      const editor = page.getByRole('region', {
        name: '员工 AI 配发',
        exact: true,
      });
      const ai = editor
        .getByRole('row')
        .filter({ hasText: source.definition.name });
      await ai.getByRole('button', { name: '添加', exact: true }).click();
      await editor
        .getByRole('status')
        .filter({ hasText: '已更新 1 名员工' })
        .waitFor();
      await expect.poll(() => ai.textContent()).toContain('1 / 1 人当前可用');
      const a = (await authenticateSession(
        (await login({ username: 'assignment-snow', password: 'admin@321' }))
          .session.token,
      ))!;
      const b = (await authenticateSession(
        (await login({ username: 'assignment-drink', password: 'admin@321' }))
          .session.token,
      ))!;
      expect(
        (await getEmployeeWorkspace(a, c.defaultWorkspaceId)).employees,
      ).toHaveLength(1);
      expect(
        (await getEmployeeWorkspace(b, c.defaultWorkspaceId)).employees,
      ).toHaveLength(0);
      await ai.getByRole('button', { name: '移除', exact: true }).click();
      await expect.poll(() => ai.textContent()).toContain('0 / 1 人当前可用');
      await editor.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByText('公司 AI 员工、应用与用量', { exact: true }).click();
      const defaults = page.getByRole('region', {
        name: '公司默认 AI 员工',
        exact: true,
      });
      await defaults
        .getByLabel(`默认配发 ${source.definition.name}`, { exact: true })
        .click();
      await expect
        .poll(() =>
          defaults
            .getByRole('row')
            .filter({ hasText: source.definition.name })
            .textContent(),
        )
        .toContain('1 / 2 人当前可用');
      await page.reload();
      await page
        .getByRole('row')
        .filter({ hasText: 'assignment-snow' })
        .getByRole('button', { name: 'AI 员工', exact: true })
        .click();
      await expect.poll(() => ai.textContent()).toContain('1 人已明确移除');
      await ai
        .getByRole('button', { name: '跟随公司默认', exact: true })
        .click();
      await expect.poll(() => ai.textContent()).toContain('1 / 1 人当前可用');
      expect(
        (await getEmployeeWorkspace(a, c.defaultWorkspaceId)).employees,
      ).toHaveLength(1);
      expect(
        (await getEmployeeWorkspace(b, c.defaultWorkspaceId)).employees,
      ).toHaveLength(1);
      if (process.env.ALLRICE_ORG_SCREENSHOT)
        await page.screenshot({
          path: process.env.ALLRICE_ORG_SCREENSHOT,
          fullPage: true,
        });
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60000);
});
