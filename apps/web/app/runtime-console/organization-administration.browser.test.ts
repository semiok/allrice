import { GET as runtimeInventoryHttp } from '../api/v1/admin/runtime-console/route';
import { GET as runtimeEventsHttp } from '../api/v1/admin/runtime-console/[sessionId]/events/route';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  login,
  createManagedOrganization,
  importOrganizationPeople,
  getEmployeeWorkspace,
} from '@allrice/database';
import { tenantValidationFixture } from '../../../../packages/database/src/tenant-validation.fixture.ts';
import { organizationActivityHttp } from '../../lib/organization-administration/activity-http';
import { tenantValidationHttp } from '../../lib/tenant-administration/validation-http';
import { organizationAdministrationHttp } from '../../lib/organization-administration/http';
import { organizationAssignmentsHttp } from '../../lib/organization-administration/assignments-http';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';

const ports = vi.hoisted(() => ({ context: vi.fn(), storage: vi.fn() }));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('../../lib/storage/runtime', () => ({
  getStorageAdapter: ports.storage,
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
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    ports.storage.mockReturnValue(assistantFixtureStorage(fixture.db));
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
            parts[4] === 'runtime-console'
              ? parts[6] === 'events'
                ? await runtimeEventsHttp(request, {
                    params: Promise.resolve({ sessionId: parts[5]! }),
                  })
                : await runtimeInventoryHttp(request)
              : parts[4] === 'activity'
                ? await organizationActivityHttp(request)
                : parts[4] === 'tenants' && parts[6] === 'validation'
                  ? await tenantValidationHttp(request, parts[5]!)
                  : parts[6] === 'ai-employees'
                    ? await organizationAssignmentsHttp(request, parts[5]!)
                    : await organizationAdministrationHttp(
                        request,
                        parts[5],
                        parts[7],
                        action,
                      );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
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

  it.each([1440, 390])(
    'scopes runtime navigation by company and person, including people without sessions (%i)',
    async (width) => {
      const a = await tenantValidationFixture(fixture.db),
        b = await tenantValidationFixture(fixture.db);
      const company = `Runtime 公司 ${width}`,
        otherCompany = `Runtime 另一公司 ${width}`;
      const org = a.target.organizationId,
        workspace = a.target.workspaceId,
        owner = a.target.subjectId;
      const peer = randomUUID(),
        empty = randomUUID(),
        peerSession = randomUUID(),
        secondWorkspace = randomUUID();
      await fixture.db`update allrice_organizations set name=${company} where id=${org}`;
      await fixture.db`update allrice_organizations set name=${otherCompany} where id=${b.target.organizationId}`;
      await fixture.db`update allrice_users set display_name='甲员工' where id=${owner}`;
      await fixture.db`update allrice_chat_sessions set title='甲员工任务' where id=${a.task.chatSessionId}`;
      await fixture.db`update allrice_chat_sessions set title='另一公司任务' where id=${b.task.chatSessionId}`;
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${peer},${peer + '@example.test'},'乙员工','not-login'),(${empty},${empty + '@example.test'},'暂无会话员工','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role,active) values(${org},${workspace},${peer},'member',true),(${org},${workspace},${empty},'member',true)`;
      await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${secondWorkspace},${org},'second','第二工作区')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role,active) values(${org},${secondWorkspace},${peer},'member',true)`;
      await fixture.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_version_id) values(${peerSession},${org},${workspace},${peer},'乙员工任务',${a.versionId})`;
      for (const [organizationId, workspaceId, ownerId, sessionId] of [
        [org, workspace, owner, a.task.chatSessionId],
        [org, workspace, peer, peerSession],
        [
          b.target.organizationId,
          b.target.workspaceId,
          b.target.subjectId,
          b.task.chatSessionId,
        ],
      ])
        await fixture.db`insert into allrice_conversation_runtimes(organization_id,workspace_id,owner_id,session_id,config_checksum,state) values(${organizationId!},${workspaceId!},${ownerId!},${sessionId!},${'sha256:' + 'a'.repeat(64)},'idle')`;
      for (const [userId, name] of [
        [owner, '甲的电脑'],
        [peer, '乙的电脑'],
      ])
        await fixture.db`insert into allrice_bridge_devices(organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values(${org},${userId === owner ? workspace : secondWorkspace},${userId!},${name!},'macos-arm64',1,array['local.fs.read'],${randomUUID().replaceAll('-', '').padEnd(64, '0')},now())`;
      const latestRun = randomUUID(),
        question = randomUUID(),
        answer = randomUUID();
      await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${latestRun},${org},${workspace},${owner},'succeeded','{}','{}')`;
      await fixture.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${question},${org},${workspace},${a.task.chatSessionId},${owner},'user','{"text":"最新问题","citations":[]}'),(${answer},${org},${workspace},${a.task.chatSessionId},${owner},'assistant','{"text":"最新回复","citations":[]}')`;
      await fixture.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot) select ${latestRun},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${question},${answer},provider_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${a.task.runId}`;
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
      });
      await context.addCookies([
        { name: 'fixture_session', value: adminToken, url: origin },
      ]);
      const page = await context.newPage(),
        errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        const scoped = await context.request.get(
          `${origin}/api/v1/admin/runtime-console?organizationId=${org}&ownerId=${peer}&limit=1`,
        );
        expect(scoped.status()).toBe(200);
        const projection = await scoped.json();
        expect(
          projection.runtimes.map(
            (r: { session: { id: string } }) => r.session.id,
          ),
        ).toEqual([peerSession]);
        expect(
          projection.employeeTenants.find((t: { bridge: unknown }) => t.bridge)
            .bridge.name,
        ).toBe('乙的电脑');
        const wrongCompany = await context.request.get(
          `${origin}/api/v1/admin/runtime-console?organizationId=${b.target.organizationId}&ownerId=${peer}`,
        );
        const wrong = await wrongCompany.json();
        expect(wrong.runtimes).toEqual([]);
        expect(
          wrong.employeeTenants.every(
            (t: { bridge: unknown; sessions: { total: number } }) =>
              !t.bridge && t.sessions.total === 0,
          ),
        ).toBe(true);
        await page.goto(`${origin}/runtime-console?view=runtimes`);
        const companies = page.locator('[aria-label="选择公司"]'),
          people = page.locator('[aria-label="选择员工"]'),
          list = page.locator('[aria-label="员工 Session Runtime"]'),
          status = page.getByLabel('员工运行概况');
        await companies
          .getByRole('button', { name: company, exact: true })
          .click();
        expect(
          await companies
            .getByRole('button', { name: company, exact: true })
            .count(),
        ).toBe(1);
        await people.getByRole('button', { name: /甲员工/ }).click();
        await page
          .getByRole('heading', { name: '甲员工任务', exact: true })
          .waitFor();
        expect(await list.innerText()).not.toContain('乙员工任务');
        expect(await list.innerText()).not.toContain('另一公司任务');
        await status.getByText(/甲的电脑/).waitFor();
        const turns = page.locator('details[data-run-id]');
        await expect.poll(() => turns.count()).toBe(2);
        expect(await turns.first().getAttribute('data-run-id')).toBe(latestRun);
        expect(await turns.first().locator('summary').innerText()).toContain(
          '第 2 轮',
        );
        expect(await turns.first().getAttribute('open')).not.toBeNull();
        expect(await turns.nth(1).getAttribute('open')).toBeNull();
        await turns.nth(1).locator('summary').first().click();
        await turns.first().locator('summary').first().click();
        await page.clock.install();
        const refreshed = page.waitForResponse((r) =>
          r.url().endsWith(`/${a.task.chatSessionId}/events`),
        );
        await page.clock.runFor(1600);
        await refreshed;
        expect(await turns.first().getAttribute('open')).toBeNull();
        expect(await turns.nth(1).getAttribute('open')).not.toBeNull();

        expect(await status.innerText()).not.toContain('乙的电脑');
        const scope = page.getByRole('region', { name: '公司与员工选择' });
        const box = await scope.boundingBox();
        expect(box!.height).toBeLessThan(width === 1440 ? 240 : 350);
        await page.screenshot({
          path: `.local/met161/runtime-hierarchy-${width}.png`,
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await people.getByRole('button', { name: /乙员工/ }).click();
        await page
          .getByRole('heading', { name: '乙员工任务', exact: true })
          .waitFor();
        await status.getByText(/乙的电脑/).waitFor();
        expect(await status.innerText()).not.toContain('甲的电脑');
        await page.clock.runFor(15001);
        expect(
          await people
            .getByRole('button', { name: /乙员工/ })
            .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(await list.innerText()).not.toContain('甲员工任务');
        await people.getByRole('button', { name: /暂无会话员工/ }).click();
        await list
          .getByText('这位员工还没有绑定 DSH Runtime 的 Session。')
          .waitFor();
        expect(
          await page
            .getByRole('heading', { name: '乙员工任务', exact: true })
            .count(),
        ).toBe(0);
        await status.getByText('未配置 Bridge · 可使用云端 Runtime').waitFor();
        await companies
          .getByRole('button', { name: otherCompany, exact: true })
          .click();
        await page
          .getByRole('heading', { name: '另一公司任务', exact: true })
          .waitFor();
        expect(await people.innerText()).not.toContain('暂无会话员工');
        expect(await list.innerText()).not.toContain('甲员工任务');
        expect(errors).toEqual([]);
        expect(failures).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );

  it.each([1440, 390])(
    'opens work and files in a visible dialog, retains detail on refresh, and rejects foreign downloads (%i)',
    async (width) => {
      const a = await tenantValidationFixture(fixture.db),
        b = await tenantValidationFixture(fixture.db);
      const companyName = `星米工作动态 ${width}`,
        personName = `小雪动态 ${width}`;
      let stage = 'open dashboard';
      await fixture.db`update allrice_organizations set name=${companyName} where id=${a.target.organizationId}`;
      await fixture.db`update allrice_users set display_name=${personName} where id=${a.target.subjectId}`;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      context.setDefaultTimeout(6000);
      await context.addCookies([
        { name: 'fixture_session', value: adminToken, url: origin },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.clock.install();
        await page.goto(`${origin}/runtime-console?view=activity`);
        await page
          .getByLabel('公司', { exact: true })
          .selectOption(a.target.organizationId);
        await page
          .getByRole('heading', { name: companyName, exact: true })
          .waitFor();
        stage = 'select employee';
        expect(
          await page.getByLabel('员工', { exact: true }).inputValue(),
        ).toBe('');
        await page
          .getByLabel('员工', { exact: true })
          .selectOption(a.target.subjectId);
        await page
          .getByRole('heading', { name: `${personName} 的工作`, exact: true })
          .waitFor();
        stage = 'open work';
        await page
          .getByRole('button', { name: '查看工作与成果', exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: '工作与成果',
          exact: true,
        });
        await dialog
          .getByRole('region', { name: '真实任务检查结果' })
          .waitFor();
        const box = await dialog.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(900);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe(
          'hidden',
        );
        expect(
          await dialog
            .locator('details')
            .filter({ hasText: '用户目标与交付回复' })
            .getAttribute('open'),
        ).not.toBeNull();
        await page.getByText('技术详情', { exact: true }).click();
        await page
          .getByRole('button', {
            name: 'evidence.txt · v1 · document',
            exact: true,
          })
          .click();
        const preview = page.getByRole('region', { name: '只读交付物预览' });
        await preview.waitFor();
        stage = 'automatic refresh';
        await page.evaluate(() => {
          document
            .querySelector('[aria-label="真实任务检查结果"]')
            ?.setAttribute('data-retained', 'yes');
        });
        const refreshed = Promise.all([
          page.waitForResponse((r) => {
            const u = new URL(r.url());
            return (
              u.pathname === '/api/v1/admin/activity' &&
              u.searchParams.get('view') === 'companyRuns'
            );
          }),
          page.waitForResponse((r) => {
            const u = new URL(r.url());
            return (
              u.pathname === '/api/v1/admin/activity' &&
              u.searchParams.get('view') === 'dashboard'
            );
          }),
        ]);
        await page.clock.runFor(15001);
        expect((await refreshed).every((r) => r.ok())).toBe(true);
        stage = 'inspect preview and download';
        for (const name of ['刷新工作详情']) {
          const button = page.getByRole('button', { name, exact: true });
          await button.click();
          await expect.poll(() => button.isEnabled()).toBe(true);
          expect(await page.locator('[data-retained="yes"]').count()).toBe(1);
          expect(
            await page
              .locator('details')
              .filter({ has: page.getByText('技术详情', { exact: true }) })
              .getAttribute('open'),
          ).not.toBeNull();
          expect(await preview.innerText()).toContain(
            'Isolated fixture, not a real model answer.',
          );
        }
        const link = await page
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('href');
        const download = await context.request.get(`${origin}${link}`);
        expect(download.status()).toBe(200);
        expect(download.headers()['content-disposition']).toContain(
          'attachment',
        );
        expect(await download.text()).toContain(
          'Isolated fixture, not a real model answer.',
        );
        expect(
          (
            await context.request.get(
              `${origin}${link!.replace(a.artifact.artifactId, b.artifact.artifactId)}`,
            )
          ).status(),
        ).toBe(404);
        const member = await createSession(b.target.subjectId);
        expect(
          (
            await context.request.get(`${origin}${link}`, {
              headers: { cookie: `fixture_session=${member.token}` },
            })
          ).status(),
        ).toBe(403);
        await page.screenshot({
          path: `.local/met161/pr5-activity-${width}.png`,
          fullPage: true,
        });
        await page.keyboard.press('Escape');
        expect(await dialog.count()).toBe(0);
        expect(
          await page
            .getByRole('button', { name: '查看工作与成果', exact: true })
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        expect(
          await page.evaluate(() => document.body.style.overflow),
        ).not.toBe('hidden');
        await page
          .getByRole('button', { name: '查看工作与成果', exact: true })
          .click();
        await dialog
          .getByRole('region', { name: '真实任务检查结果' })
          .waitFor();
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        expect(await dialog.count()).toBe(0);
        expect(errors).toEqual([]);
        expect(failures).toEqual([]);
      } catch (e) {
        throw new Error(
          `${stage}: ${String(e)}; browser=${JSON.stringify(errors)}; server=${JSON.stringify(failures)}; page=${(await page.locator('body').innerText()).slice(0, 1600)}`,
        );
      } finally {
        await context.close();
      }
    },
  );

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
        name: '全员自动配发 AI 员工',
        exact: true,
      });
      await defaults
        .getByLabel(`全员自动配发 ${source.definition.name}（含新员工）`, {
          exact: true,
        })
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
