/** Actual private Chrome + signed tenant portal + HTTP + PG + owned MCP.
 * No real model, personal credentials, Dev/Prod or remote TLS claim. The only
 * HTTP loopback exception is an explicit test transport in this script's Worker.
 * Run after pnpm --filter @allrice/web... build:
 * pnpm exec tsx scripts/acceptance/runtime/p16-mcp-workbench.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(join(root, 'package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
if (process.env.ALLRICE_P16_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P16_UI_ISOLATED: '1',
        ALLRICE_TEST_CHROME:
          process.env.ALLRICE_TEST_CHROME ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit');
  process.exit(typeof code === 'number' ? code : 1);
}
const port = 3006,
  origin = `http://127.0.0.1:${port}`,
  base = 'postgres://a123@127.0.0.1:5432/allrice_b2';
const schema = `p16_ui_${randomUUID().replaceAll('-', '')}`;
const url = new URL(base);
url.searchParams.set('options', `-csearch_path=${schema},public`);
const temporary = await mkdtemp(join(tmpdir(), 'allrice-p16-mcp-ui-'));
const storageRoot = join(temporary, 'storage'),
  evidenceRoot = join(temporary, 'evidence');
await mkdir(evidenceRoot);
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ALLRICE_CLOUD_MCP_ENABLED: '1',
  ALLRICE_RUNTIME_POLICY_ENABLED: '1',
  ALLRICE_WORKBENCH_ENABLED: '1',
  ALLRICE_CLOUD_RUNNER_ENABLED: '0',
  ALLRICE_BRIDGE_WSS_ENABLED: '0',
  ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '0',
  ALLRICE_PORTAL_AUTH_ENABLED: '1',
  ALLRICE_LOCAL_PORTAL: 'snow',
  ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
  ALLRICE_PORTAL_SECURE_COOKIE: '0',
  ALLRICE_GEMINI_API_ENABLED: '0',
  ALLRICE_MCP_CREDENTIAL_KEY: 'af'.repeat(32),
  ALLRICE_STORAGE_ROOT: storageRoot,
  ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
});
const postgres = createRequire(join(root, 'packages/database/package.json'))(
  'postgres',
) as typeof Postgres;
const { chromium } = workerRequire('playwright-core') as typeof Playwright;
const { getDatabase, closeDatabase } =
  await import('../../../packages/database/src/core/client.ts');
const { createSession } =
  await import('../../../packages/database/src/identity.ts');
const { createMcpExecutionFixture } =
  await import('../../../packages/database/src/mcp-execution.fixture.ts');
const { createPortalSession } =
  await import('../../../apps/web/lib/portal/session.ts');
const { resolvePortal } =
  await import('../../../apps/web/lib/portal/config.ts');
const admin = postgres(base, { max: 1, onnotice: () => {} }),
  db = getDatabase();
let server: ChildProcess | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let fixture: Awaited<ReturnType<typeof createMcpExecutionFixture>> | undefined;
let owner:
  { page: Playwright.Page; context: Playwright.BrowserContext } | undefined;
let serverOutput = '',
  schemaCreated = false;
const pageErrors: string[] = [];
const checks: Record<string, unknown> = {
  scope:
    'real Chrome + signed tenant portal + HTTP + PG + owned MCP; synthetic employee/model; no production endpoint',
  schema,
  origin,
};
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}
async function actorBrowser(userId: string, org: string, workspace: string) {
  const login = await createSession(userId);
  const context = await browser!.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.addCookies([
    {
      name: 'allrice_session',
      value: login.token,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'allrice_portal_session',
      value: createPortalSession({
        portal: resolvePortal('allrice-snow.bplabs.xyz')!,
        subject: 'synthetic-p16',
        organizationId: org,
        workspaceId: workspace,
      }).value,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin || ['data:', 'blob:'].includes(u.protocol))
      await route.continue();
    else await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  return { page, context };
}
try {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((r) => probe.close(() => r()));
  await admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20260907,1)`;
    await tx`create extension if not exists vector with schema public`;
    await tx`create extension if not exists pg_trgm with schema public`;
  });
  await admin.unsafe(`create schema "${schema}"`);
  schemaCreated = true;
  for (const file of (await readdir(join(root, 'packages/database/migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await db.unsafe(
      await readFile(join(root, 'packages/database/migrations', file), 'utf8'),
    );
  server = spawn(
    process.execPath,
    [
      webRequire.resolve('next/dist/bin/next'),
      'start',
      join(root, 'apps/web'),
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout?.on('data', (b) => (serverOutput += b.toString()));
  server.stderr?.on('data', (b) => (serverOutput += b.toString()));
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error(serverOutput);
    try {
      const r = await fetch(`${origin}/login`);
      if (r.status < 500) break;
    } catch {
      /* Private server may not be listening yet. */
    }
    if (i === 149) throw Error('private Web startup timeout');
    await delay(200);
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ALLRICE_TEST_CHROME,
  });
  fixture = await createMcpExecutionFixture(db, {
    bind: false,
    authorize: async (scope) => {
      owner = await actorBrowser(scope.user, scope.org, scope.workspace);
      await owner.page.goto(`${origin}/workspace/mcp`);
      const panel = owner.page.getByRole('region', { name: '云端 MCP 连接' });
      await panel
        .getByRole('button', { name: '绑定此连接', exact: true })
        .waitFor();
      const api = `${origin}/api/v1/admin/mcp?workspaceId=${scope.workspace}`;
      const initial = await owner.context.request.get(api);
      assert.equal(initial.status(), 200, await initial.text());
      assert.equal((await initial.json()).employees[0].bindings.length, 0);
      await panel
        .getByLabel('选择员工版本 P16 owned acceptance', { exact: true })
        .selectOption(scope.version);
      const save = owner.page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/v1/admin/mcp') &&
          r.request().method() === 'PATCH',
      );
      await panel
        .getByRole('button', { name: '绑定此连接', exact: true })
        .click();
      const saved = await save;
      assert.equal(saved.status(), 200, await saved.text());
      await panel.getByText(/已绑定 · 授权版本 1/).waitFor();
      await owner.page.reload();
      await owner.page.getByText(/已绑定 · 授权版本 1/).waitFor();
      await owner.page.screenshot({
        path: join(evidenceRoot, '01-employee-binding.png'),
        fullPage: true,
      });
      checks.bindingUI = {
        saved: 200,
        afterRefresh: true,
        version: scope.version,
      };
    },
  });
  const f = fixture,
    { page, context } = owner!;
  assert.equal(f.snapshot.schemaVersion, 2);
  assert.equal(f.snapshot.mcpTools!.length, 3);
  assert.equal(f.beforeBinding.executionSnapshot.mcpTools?.length, 0);
  const created = await f.create('p16-browser-approve'),
    operationId = created.snapshot.binding.attempt.operationId;
  const second = await f.create('p16-browser-reject'),
    rejectedId = second.snapshot.binding.attempt.operationId;
  const ops = `${origin}/api/v1/runtime/cloud-operations?workspaceId=${f.workspace}&runId=${f.run}`;
  const strangerId = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${strangerId},${`${strangerId}@example.test`},'Synthetic member','not-login')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${strangerId},'member')`;
  const stranger = await actorBrowser(strangerId, f.org, f.workspace);
  assert.equal(
    (
      await stranger.context.request.get(
        `${origin}/api/v1/admin/mcp?workspaceId=${f.workspace}`,
      )
    ).status(),
    403,
  );
  assert.equal((await stranger.context.request.get(ops)).status(), 403);
  const opBody = await (await context.request.get(ops)).json();
  const request = opBody.operations.find(
    (o: { snapshot: { binding: { attempt: { operationId: string } } } }) =>
      o.snapshot.binding.attempt.operationId === operationId,
  ).approval.request;
  const stolen = await stranger.context.request.post(
    `${origin}/api/v1/runtime/approvals/${request.approvalId}`,
    {
      headers: { origin },
      data: {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: request.requestId,
        version: request.version,
        requestDigest: request.requestDigest,
        task: request.task,
        responseId: randomUUID(),
        respondedBy: strangerId,
        respondedAt: new Date().toISOString(),
        approvalId: request.approvalId,
        decision: 'approved',
      },
    },
  );
  assert.equal(stolen.status(), 403);
  await page.goto(`${origin}/chatflow?session=${f.session}`);
  const card = page.locator(`#operation-${operationId}`);
  await card.getByRole('button', { name: '批准这一次执行' }).waitFor();
  await page.reload();
  await card.getByRole('button', { name: '批准这一次执行' }).waitFor();
  assert.equal(f.service.state.calls, 0);
  assert.match(await card.innerText(), /第三方 MCP 工具/);
  assert.match(await card.innerText(), /records.append/);
  assert.doesNotMatch(
    await card.innerText(),
    new RegExp(f.service.state.token),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() =>
    getComputedStyle(
      document.querySelector('main')!,
    ).gridTemplateColumns.startsWith('57px '),
  );
  assert.ok(
    (await card.boundingBox())!.width >= 250,
    'narrow approval remains readable',
  );
  await card
    .getByRole('button', { name: '批准这一次执行' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidenceRoot, '02-narrow-approval.png'),
    fullPage: true,
  });
  const allow = page.waitForResponse(
    (r) =>
      r.url().includes('/runtime/approvals/') &&
      r.request().method() === 'POST',
  );
  await card.getByRole('button', { name: '批准这一次执行' }).click();
  assert.equal((await allow).status(), 200);
  const result = await f.execute(created);
  assert.equal(result.status, 'succeeded');
  assert.equal(f.service.state.calls, 1);
  await card.getByText('执行已返回成功', { exact: true }).waitFor();
  const rejectedCard = page.locator(`#operation-${rejectedId}`);
  await rejectedCard.getByRole('button', { name: '拒绝', exact: true }).click();
  await rejectedCard.getByText('已拒绝本次操作', { exact: true }).waitFor();
  assert.equal((await f.execute(second)).code, 'MCP_APPROVAL_REJECTED');
  assert.equal(f.service.state.calls, 1);
  await page.reload();
  await card.getByText('执行已返回成功', { exact: true }).waitFor();
  await rejectedCard.getByText('已拒绝本次操作', { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidenceRoot, '03-approval-results.png'),
    fullPage: true,
  });
  await page.goto(`${origin}/workspace/mcp`);
  await page.getByRole('button', { name: '撤销员工绑定', exact: true }).click();
  await page.getByText(/已撤销 · 授权版本 2/).waitFor();
  assert.equal((await f.prepare()).executionSnapshot.mcpTools?.length, 0);
  await assert.rejects(() => f.create('after-ui-revoke'), /MCP_DENIED/);
  await page.reload();
  await page.getByText(/已撤销 · 授权版本 2/).waitFor();
  assert.deepEqual(pageErrors, []);
  checks.approvalUI = {
    refreshBefore: true,
    approve: 200,
    decline: true,
    afterRefresh: true,
    remoteCalls: f.service.state.calls,
    revoked: true,
    strangerRead: 403,
    strangerApprove: 403,
    narrowWidth: 390,
    pageErrors,
  };
  await writeFile(
    join(evidenceRoot, 'checks.json'),
    JSON.stringify(checks, null, 2),
  );
  console.info(JSON.stringify({ passed: true, evidenceRoot, checks }, null, 2));
} finally {
  await browser?.close();
  await stopServer();
  await fixture?.service.close();
  await closeDatabase();
  if (schemaCreated && /^p16_ui_[a-f0-9]{32}$/.test(schema))
    await admin.unsafe(`drop schema "${schema}" cascade`);
  await admin.end({ timeout: 5 });
  await writeFile(join(evidenceRoot, 'server.log'), serverOutput);
  await rm(storageRoot, { recursive: true, force: true });
}
