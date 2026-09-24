import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../../../../packages/database/src/identity.ts';
import { tenantAdministrationHttp } from '../../lib/tenant-administration/http';
import { tenantEmployeesHttp } from '../../lib/tenant-administration/tenant-employees-http';
import {
  getEmployeeWorkspace,
  createChatSession,
} from '../../../../packages/database/src/workspace/service.ts';
import { tenantPolicyHttp } from '../../lib/tenant-administration/policy-http';
import { tenantResourcesHttp } from '../../lib/tenant-administration/resources-http';
import { tenantValidationHttp } from '../../lib/tenant-administration/validation-http';
import { tenantValidationFixture } from '../../../../packages/database/src/tenant-validation.fixture.ts';
import { employeeAdministrationHttp } from '../../lib/tenant-administration/employee-http';
import { GET as employeeDirectory } from '../api/v1/admin/platform-employees/route';
import { GET as employeeLifecycle } from '../api/v1/admin/platform-employees/[employeeId]/lifecycle/route';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { savePlatformEmployeeDraft } from '../../../../packages/database/src/employees/platform-employees.ts';

const ports = vi.hoisted(() => ({ context: vi.fn(), storage: vi.fn() }));
vi.mock('../../lib/storage/runtime', () => ({
  getStorageAdapter: ports.storage,
}));
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
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    fixture = await createAssistantFixtureDatabase();
    ports.storage.mockReturnValue(assistantFixtureStorage(fixture.db));
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
      // Preserve shared eager/lazy dependency initialization as production ESM does.
      format: 'esm',
      splitting: true,
      platform: 'browser',
      write: false,
      outdir: '/unused-tenant-admin',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const js = built.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('/tenant-administration-page.js'),
      ).contents,
      css = built.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('/tenant-administration-page.css'),
      ).contents;
    const assets = new Map<string, Uint8Array>(
      built.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
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
                : ['quotas', 'environments', 'mcp', 'local-mcp'].includes(
                      parts[6] ?? '',
                    )
                  ? await tenantResourcesHttp(
                      request,
                      parts[5]!,
                      parts[6] as
                        'quotas' | 'environments' | 'mcp' | 'local-mcp',
                    )
                  : parts[6] === 'employees'
                    ? await tenantEmployeesHttp(request, parts[5]!)
                    : parts[6] === 'validation'
                      ? await tenantValidationHttp(request, parts[5]!)
                      : parts[6] === 'policy'
                        ? await tenantPolicyHttp(request, parts[5]!)
                        : parts[4] === 'tenants' &&
                            (!parts[6] ||
                              (parts[6] === 'members' &&
                                parts[7] &&
                                parts.length === 8))
                          ? await tenantAdministrationHttp(
                              request,
                              parts[5],
                              parts[7],
                            )
                          : new Response(
                              '<!DOCTYPE html><title>Not Found</title>',
                              {
                                status: 404,
                                headers: { 'Content-Type': 'text/html' },
                              },
                            );
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(await result.text());
          return;
        }
        res.writeHead(200, {
          'Content-Type': path.endsWith('.js')
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
              : (assets.get(path) ??
                '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#101216"><div id="root"></div><script type="module" src="/app.js"></script></body></html>'),
        );
      } catch (e) {
        failures.push(
          e instanceof Error ? (e.stack ?? e.message) : 'fixture_error',
        );
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
    page.on('pageerror', (e) => failures.push(e.stack ?? e.message));
    await page.goto(origin);
    await page.getByLabel('管理租户').selectOption(snow.organizationId);
    await page.getByRole('button', { name: '成员与角色', exact: true }).click();
    await page
      .getByRole('button', { name: '编辑 Snow fixture', exact: true })
      .waitFor();
    return { page, context };
  }
  it('deploys, selects a default and withdraws a published employee through the real UI without a mandatory note', async () => {
    const source = await createEmployeeAdministrationFixture(fixture.db);
    await fixture.db`update allrice_workspaces set name='Deployment fixture workspace' where id=${source.workspaceId}`;
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const { page, context } = await pageFor(platform, 390);
    try {
      await page
        .getByRole('button', { name: 'AI 员工团队', exact: true })
        .click();
      const panel = page.getByRole('region', {
        name: '在岗 AI 员工',
        exact: true,
      });
      await panel.getByLabel('选择已发布员工').selectOption(source.employeeId);
      expect(await panel.getByLabel('派驻备注（可选）').inputValue()).toBe('');
      await panel
        .getByRole('button', { name: '派驻员工', exact: true })
        .click();
      await panel
        .getByText('员工已派驻，当前普通成员可以开始使用。', { exact: true })
        .waitFor();
      const card = panel.getByRole('article', {
        name: '在岗员工 Synthetic publication',
        exact: true,
      });
      await card.waitFor();
      expect(await card.innerText()).toContain('已派驻 v1');
      const member = await authenticateSession(snow.session.token, {
        organizationId: snow.organizationId,
        workspaceId: snow.workspaceId,
      });
      const available = await getEmployeeWorkspace(member!, snow.workspaceId);
      const [deployment] =
        await fixture.db`select tenant_employee_id from allrice_platform_employee_tenant_assignments where employee_id=${source.employeeId} and workspace_id=${snow.workspaceId}`;
      const employee = available.employees.find(
        (e) => e.employeeId === deployment!.tenant_employee_id,
      )!;
      expect(employee).toBeTruthy();
      const session = await createChatSession(member!, {
        workspaceId: snow.workspaceId,
        employeeAssignmentId: employee.id,
        title: 'Synthetic browser deployment',
      });
      if (await card.getByRole('button', { name: '设为默认员工' }).count())
        await card.getByRole('button', { name: '设为默认员工' }).click();
      await expect.poll(() => card.innerText()).toContain('默认员工');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await card.getByRole('button', { name: '撤回员工', exact: true }).click();
      await panel
        .getByText('员工已撤回，历史会话与成果保留。', { exact: true })
        .waitFor();
      expect(
        (await getEmployeeWorkspace(member!, snow.workspaceId)).employees.some(
          (e) => e.id === employee.id,
        ),
      ).toBe(false);
      expect(
        await fixture.db`select id from allrice_chat_sessions where id=${session.id}`,
      ).toHaveLength(1);
      await page.getByRole('button', { name: '刷新员工', exact: true }).click();
      await expect.poll(() => card.count()).toBe(0);
      const response = await context.request.post(
        `${origin}/api/v1/admin/tenants/${snow.organizationId}/employees`,
        { headers: { origin: 'https://foreign.invalid' }, data: {} },
      );
      expect(response.status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  it('opens scoped validation from a deep link, inspects the real stored Run and never exposes execution controls', async () => {
    const a = await tenantValidationFixture(fixture.db),
      { page, context } = await pageFor();
    // Synthetic metadata only: the empty evidence state must not claim a test passed.
    await fixture.db`insert into allrice_development_heads(root_run_id,seed_artifact_id,seed_digest,head_artifact_id,head_digest,execution)
      values(${a.task.runId},${a.artifact.artifactId},${`sha256:${'a'.repeat(64)}`},${a.artifact.artifactId},${`sha256:${'a'.repeat(64)}`},'{}')`;
    try {
      const start = requests.length;
      await page.goto(
        `${origin}/runtime-console?view=tenants&organizationId=${a.target.organizationId}&workspaceId=${a.target.workspaceId}&tenantView=validation&subjectId=${a.target.subjectId}`,
      );
      await page
        .getByRole('heading', { name: '验收与交付', exact: true })
        .waitFor();
      expect(
        await page.getByLabel('实际使用者', { exact: true }).inputValue(),
      ).toBe(a.target.subjectId);
      await page.getByLabel('选择验收 Run').selectOption(a.task.runId);
      await page.getByRole('region', { name: '真实任务检查结果' }).waitFor();
      const text = await page
        .getByRole('region', { name: '真实任务检查结果' })
        .innerText();
      expect(text).toContain(a.versionId);
      expect(text).toContain('运行中，用量待结算');
      expect(text).toContain('process.execute');
      expect(text).toContain('evidence.txt');
      expect(text).toContain('开发协作证据链 · 只读');
      expect(text).toContain('尚无候选版本测试操作');
      expect(text).toContain('尚无正式开发交付记录');
      expect(text).not.toContain('NEVER_EXPOSE_RAW_SNAPSHOT');
      expect(text).not.toContain('PRIVATE_TEST_SECRET');
      expect(
        await page
          .getByRole('button', { name: /批准|执行此任务|应用修改|恢复运行/ })
          .count(),
      ).toBe(0);
      await page
        .getByRole('button', {
          name: 'evidence.txt · v1 · document',
          exact: true,
        })
        .click();
      await page.getByRole('region', { name: '只读交付物预览' }).waitFor();
      expect(
        await page.getByRole('region', { name: '只读交付物预览' }).innerText(),
      ).toContain('Isolated fixture, not a real model answer.');
      expect(requests.slice(start).every((r) => r.startsWith('GET '))).toBe(
        true,
      );
      expect(requests.slice(start).some((r) => r.endsWith('/members'))).toBe(
        false,
      );
      expect(
        (
          await context.request.get(
            `${origin}/api/v1/admin/tenants/${a.target.organizationId}/members?workspaceId=${a.target.workspaceId}`,
          )
        ).status(),
      ).toBe(404);
      await page.getByRole('link', { name: '调整内部额度' }).click();
      await page.getByLabel('月 Token 上限', { exact: true }).waitFor();
      expect(
        await page.getByLabel('实际使用者', { exact: true }).inputValue(),
      ).toBe(a.target.subjectId);
    } finally {
      await context.close();
    }
  });
  it('rejects a foreign Run from the validation form and clears the previous result', async () => {
    const a = await tenantValidationFixture(fixture.db),
      b = await tenantValidationFixture(fixture.db),
      { page, context } = await pageFor();
    try {
      await page.goto(
        `${origin}/runtime-console?view=tenants&organizationId=${a.target.organizationId}&workspaceId=${a.target.workspaceId}&tenantView=validation&subjectId=${a.target.subjectId}`,
      );
      await page.getByLabel('选择验收 Run').selectOption(a.task.runId);
      await page.getByRole('region', { name: '真实任务检查结果' }).waitFor();
      await page.getByLabel('完整验收 Run ID').fill(b.task.runId);
      await page
        .getByRole('button', { name: '检查此 Run', exact: true })
        .click();
      await page.getByRole('alert').waitFor();
      expect(
        await page.getByRole('region', { name: '真实任务检查结果' }).count(),
      ).toBe(0);
    } finally {
      await context.close();
    }
  });
  it('configures real member quotas through UI, restores inheritance with CAS and prevents cross-origin updates', async () => {
    const { page, context } = await pageFor();
    try {
      await page.getByLabel('管理工作区').selectOption(snow.workspaceId);
      await page.getByRole('button', { name: '分层额度', exact: true }).click();
      await page
        .getByLabel('实际使用者', { exact: true })
        .selectOption(snow.user.id);
      await page.getByLabel('月 Token 上限', { exact: true }).fill('5000000');
      await page
        .getByLabel('额度修改原因')
        .fill('Synthetic browser quota approval');
      await page.getByRole('button', { name: '保存额度', exact: true }).click();
      await page
        .getByText(
          '额度已保存；真实用量、未知预留和 Codex 官方额度未被改写。',
          { exact: true },
        )
        .waitFor();
      const [row] =
        await fixture.db`select monthly_token_limit from allrice_model_resource_limits where organization_id=${snow.organizationId} and scope_type='user' and scope_id=${snow.user.id}`;
      expect(row?.monthly_token_limit).toBe('5000000');
      expect(
        await page
          .locator('table td')
          .first()
          .evaluate((el) => getComputedStyle(el).color),
      ).toBe('rgb(233, 237, 242)');
      if (process.env.ALLRICE_TEST_SCREENSHOT_DIR)
        await page.screenshot({
          path: resolve(
            process.env.ALLRICE_TEST_SCREENSHOT_DIR,
            'tenant-quotas.png',
          ),
          fullPage: true,
        });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 2,
        ),
      ).toBe(true);
      await page.setViewportSize({ width: 1440, height: 1000 });
      expect(
        (
          await fixture.db`select role from allrice_memberships where organization_id=${snow.organizationId} and user_id=${snow.user.id}`
        )[0]?.role,
      ).toBe('member');
      const path = `/api/v1/admin/tenants/${snow.organizationId}/quotas`,
        body = {
          workspaceId: snow.workspaceId,
          subjectId: snow.user.id,
          scope: 'user',
          expectedVersion: null,
          limits: {
            monthlyTokenLimit: 6000000,
            monthlyRunLimit: 2000,
            concurrentRunLimit: 3,
            maxRuntimeMs: 1800000,
          },
          reason: 'Concurrent stale quota form',
        };
      const stale = await context.request.put(origin + path, {
        headers: { origin },
        data: body,
      });
      expect(stale.status()).toBe(409);
      const cross = await context.request.put(origin + path, {
        headers: { origin: 'https://elsewhere.example' },
        data: body,
      });
      expect(cross.status()).toBe(403);
      await page.getByLabel(/移除此租户对象覆盖/).check();
      await page
        .getByLabel('额度修改原因')
        .fill('Synthetic restore inherited quota');
      await page.getByRole('button', { name: '保存额度', exact: true }).click();
      await expect
        .poll(async () =>
          Number(
            await page
              .getByLabel('月 Token 上限', { exact: true })
              .inputValue(),
          ),
        )
        .toBe(2000000);
    } finally {
      await context.close();
    }
  });
  it('shows all missing prerequisites, grants cloud via UI without a device and exposes scoped MCP configuration', async () => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'ab'.repeat(32));
    const target = randomUUID(),
      approvalRun = randomUUID();
    await fixture.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities) values(${target},${snow.organizationId},${snow.workspaceId},${`cloud.${target}`},'cloud_sandbox','Synthetic cloud target','online','["process.execute","browser.navigate"]')`;
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${approvalRun},${snow.organizationId},${snow.workspaceId},${snow.user.id},'waiting_approval','{}','{}')`;
    await fixture.db`insert into allrice_approval_requests(organization_id,workspace_id,run_id,actor_id,resource_type,resource_id,action,input_digest,requested_at,runtime_request,runtime_binding_digest,runtime_control_version,runtime_expires_at)
      values(${snow.organizationId},${snow.workspaceId},${approvalRun},${snow.user.id},'runtime_operation',${randomUUID()},'process.execute',${`sha256:${'a'.repeat(64)}`},now()-interval '2 hours','{}',${`sha256:${'b'.repeat(64)}`},1,now()-interval '1 hour')`;
    const { page, context } = await pageFor();
    try {
      await page.getByLabel('管理工作区').selectOption(snow.workspaceId);
      await page
        .getByRole('button', { name: '环境与连接器', exact: true })
        .click();
      await page
        .getByLabel('实际使用者', { exact: true })
        .selectOption(snow.user.id);
      await page
        .getByRole('heading', { name: '已有平台授权', exact: true })
        .waitFor();
      expect(
        await page.getByText(/连接电脑后即可处理本地任务/).count(),
      ).toBeGreaterThan(0);
      await page
        .getByText('单次任务审批状态（与环境授权分开）', { exact: true })
        .click();
      await page
        .getByText(new RegExp(`Run ${approvalRun.slice(0, 8)}.*单次审批已过期`))
        .waitFor();
      await page.getByRole('button', { name: '设备下载与确认指引' }).click();
      await page
        .getByRole('link', { name: '下载 M 芯片 Bridge', exact: true })
        .waitFor();
      await page.getByLabel('授权执行目标').selectOption(target);
      await page
        .getByLabel('环境修改原因')
        .fill('Synthetic cloud platform approval');
      await page
        .getByRole('button', { name: '保存平台授权', exact: true })
        .click();
      await page
        .getByText(
          '平台授权已保存；设备端确认、员工版本、运行审批仍需分别满足。',
          { exact: true },
        )
        .waitFor();
      expect(
        await fixture.db`select id from allrice_cloud_execution_grants where organization_id=${snow.organizationId} and owner_id=${snow.user.id} and target_id=${target} and enabled`,
      ).toHaveLength(1);
      expect(
        await fixture.db`select id from allrice_bridge_devices where organization_id=${snow.organizationId}`,
      ).toHaveLength(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (process.env.ALLRICE_TEST_SCREENSHOT_DIR)
        await page.screenshot({
          path: resolve(
            process.env.ALLRICE_TEST_SCREENSHOT_DIR,
            'tenant-environments.png',
          ),
        });
      await page
        .getByRole('button', { name: '云端 MCP 配置', exact: true })
        .click();
      await page
        .getByRole('heading', { name: '云端 MCP', exact: true })
        .waitFor();
      await expect
        .poll(
          () =>
            requests.filter((r) =>
              r.includes(`/tenants/${snow.organizationId}/mcp`),
            ).length,
        )
        .toBeGreaterThan(0);
      const read = await context.request.get(
        `${origin}/api/v1/admin/tenants/${snow.organizationId}/mcp?workspaceId=${snow.workspaceId}&subjectId=${snow.user.id}`,
      );
      expect(read.status()).toBe(200);
      expect(await read.json()).toMatchObject({
        organizationId: snow.organizationId,
        subjectId: snow.user.id,
      });
      await page
        .getByLabel('环境修改原因')
        .fill('Synthetic MCP connection configuration');
      await page
        .getByLabel('连接名称', { exact: true })
        .fill('Browser configured MCP');
      await page
        .getByLabel('HTTPS MCP 地址', { exact: true })
        .fill('https://example.com/mcp');
      await page
        .getByLabel('租户 Bearer Token', { exact: true })
        .fill('synthetic-browser-credential');
      await page.getByRole('button', { name: '保存连接', exact: true }).click();
      await page.getByText('Browser configured MCP', { exact: true }).waitFor();
      expect(
        await page
          .getByLabel('租户 Bearer Token', { exact: true })
          .inputValue(),
      ).toBe('');
      const [binding] =
        await fixture.db`select b.created_by,b.organization_id,c.credential_envelope from allrice_connector_bindings b join allrice_mcp_binding_config c on c.binding_id=b.id where b.organization_id=${snow.organizationId} and c.endpoint='https://example.com/mcp'`;
      expect(binding).toMatchObject({
        created_by: platform.user.id,
        organization_id: snow.organizationId,
      });
      expect(JSON.stringify(binding)).not.toContain(
        'synthetic-browser-credential',
      );
    } finally {
      await context.close();
    }
  });
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
        .getByLabel('assistant.delegate 规则', { exact: true })
        .selectOption('allow');
      expect(
        await page
          .getByLabel('assistant.delegate 规则', { exact: true })
          .locator('option[value="ask"]')
          .isDisabled(),
      ).toBe(true);
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
        rules: [
          { action: 'local.process.execute', effect: 'allow' },
          { action: 'assistant.delegate', effect: 'allow' },
        ],
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
      await page
        .getByRole('button', { name: '成员与角色', exact: true })
        .click();
      await page.getByLabel('管理工作区').selectOption(snow.workspaceId);
      await page.getByRole('button', { name: '执行策略', exact: true }).click();
      await page
        .getByText('当前版本：1 · 保存将创建版本 2', { exact: true })
        .waitFor();
      expect(
        await page
          .getByLabel('assistant.delegate 规则', { exact: true })
          .inputValue(),
      ).toBe('allow');
      await page.screenshot({
        path: '/tmp/met151-policy-desktop.png',
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
  it('assembles selected MCP capabilities in the draft and preserves subsequent explicit security edits without publishing', async () => {
    const f = await createEmployeeAdministrationFixture(fixture.db);
    await fixture.db`update allrice_workspaces set name='MCP safety fixture workspace' where id=${f.workspaceId}`;
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: {
        ...f.definition,
        name: 'MET151 MCP safety fixture',
        securityPolicy: {
          ...f.definition.securityPolicy,
          deniedCapabilities: ['secret:use'],
          connectorIdentityModes: ['user'],
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
        .filter({ hasText: 'MET151 MCP safety fixture' })
        .click();
      const directory = async () =>
        (
          await (
            await context.request.get(
              `${origin}/api/v1/admin/platform-employees`,
            )
          ).json()
        ).employees.find(
          (employee: { id: string }) => employee.id === f.employeeId,
        );
      const original = await directory();
      await page.getByRole('button', { name: '工具', exact: true }).click();
      await page
        .getByRole('button', {
          name: '添加开发协作工具',
          exact: true,
        })
        .click();
      expect(
        await page
          .getByRole('checkbox', { name: /受控开发提案、测试与独立审查/ })
          .isChecked(),
      ).toBe(true);
      expect((await directory()).currentDraft).toEqual(original.currentDraft);
      // Discard the unsaved development bundle before the independent MCP scenario.
      await page.reload();
      await page
        .getByRole('button')
        .filter({ hasText: 'MET151 MCP safety fixture' })
        .click();
      await page.getByRole('button', { name: '工具', exact: true }).click();
      await page.getByRole('checkbox', { name: /云端 MCP 调用/ }).check();
      await page.getByRole('button', { name: '安全', exact: true }).click();
      expect(
        await page.getByLabel('禁止 secret:use', { exact: true }).isChecked(),
      ).toBe(false);
      expect(await page.getByLabel('允许连接器身份 service').isChecked()).toBe(
        true,
      );
      const save = async () => {
        const response = page.waitForResponse(
          (r) =>
            r.url() ===
              `${origin}/api/v1/admin/platform-employees/${f.employeeId}` &&
            r.request().method() === 'PUT',
        );
        await page
          .getByRole('button', { name: '保存草稿', exact: true })
          .click();
        const result = await response;
        expect(result.status()).toBe(200);
        await expect
          .poll(() =>
            page
              .getByRole('button', { name: '保存草稿', exact: true })
              .isEnabled(),
          )
          .toBe(true);
        return result.json();
      };
      const permitted = await save();
      expect(permitted.validation.valid).toBe(true);
      const current = await directory();
      expect(
        current.currentDraft.definition.securityPolicy.deniedCapabilities,
      ).toEqual([]);
      expect(current.currentPublished).toEqual(original.currentPublished);
      expect(current.assignedWorkspaceIds).toEqual(
        original.assignedWorkspaceIds,
      );
      expect(
        current.currentDraft.definition.securityPolicy.connectorIdentityModes,
      ).toEqual(['user', 'service']);
      await page.reload();
      await page
        .getByRole('button')
        .filter({ hasText: 'MET151 MCP safety fixture' })
        .click();
      await page.getByRole('button', { name: '安全', exact: true }).click();
      expect(
        await page.getByLabel('禁止 secret:use', { exact: true }).isChecked(),
      ).toBe(false);
      expect(await page.getByLabel('允许连接器身份 service').isChecked()).toBe(
        true,
      );
      await page.getByLabel('禁止 secret:use', { exact: true }).check();
      expect((await save()).validation.valid).toBe(false);
      expect(
        (await directory()).currentDraft.definition.securityPolicy
          .deniedCapabilities,
      ).toEqual(['secret:use']);
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
        .filter({
          has: page
            .locator('strong')
            .filter({ hasText: /^Synthetic publication$/ }),
        })
        .filter({ has: page.locator('input[type="checkbox"]') });
      await workspaceLabel.getByRole('checkbox').check();
      expect(
        await page
          .getByRole('button', { name: '发布到所选租户', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page
        .getByRole('button', { name: '查看发布检查与版本差异', exact: true })
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
        .getByRole('button', { name: '查看发布检查与版本差异', exact: true })
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
  it('saves a member role without a mandatory note, refreshes it, and does not grant platform membership', async () => {
    const { page, context } = await pageFor();
    try {
      await page
        .getByRole('button', { name: '编辑 Snow fixture', exact: true })
        .click();
      await page.getByLabel('成员角色').selectOption('viewer');
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
        .getByRole('button', { name: '成员与角色', exact: true })
        .click();
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
      await page.getByLabel('成员备注（可选）').fill('Do not leak this draft');
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
      expect(await page.getByLabel('成员备注（可选）').count()).toBe(0);
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
      await page
        .getByLabel('成员备注（可选）')
        .fill('Synthetic unavailable save');
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
