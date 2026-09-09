/** Real private Chrome ChatFlow UI + production Next HTTP + PostgreSQL.
 * Synthetic session and service/container facts; no actual renderer/VM/model.
 * Physical pipeline is a separate native HTTP integration gate. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
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
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  rr = createRequire(join(root, 'package.json')),
  wr = createRequire(join(root, 'apps/worker/package.json')),
  webRequire = createRequire(join(root, 'apps/web/package.json'));
if (process.env.ALLRICE_P23_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rr.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P23_UI_ISOLATED: '1',
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
const port = 3023,
  origin = `http://127.0.0.1:${port}`,
  base = 'postgres://a123@127.0.0.1:5432/allrice_b2',
  schema = `p23_ui_${randomUUID().replaceAll('-', '')}`,
  url = new URL(base),
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'allrice-p23-ui-')));
url.searchParams.set('options', `-csearch_path=${schema},public`);
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ALLRICE_BROWSER_CONTROL_ENABLED: '1',
  ALLRICE_LOCAL_BROWSER_ENABLED: '1',
  ALLRICE_BROWSER_CONTROL_KEY: randomBytes(32).toString('hex'),
  ALLRICE_RUNTIME_POLICY_ENABLED: '1',
  ALLRICE_CLOUD_RUNNER_ENABLED: '1',
  ALLRICE_WORKBENCH_ENABLED: '1',
  ALLRICE_CLOUD_MCP_ENABLED: '0',
  ALLRICE_LOCAL_COMMAND_ENABLED: '1',
  ALLRICE_LOCAL_SERVICE_ENABLED: '1',
  ALLRICE_LOCAL_PREVIEW_ENABLED: '1',
  ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '1',
  ALLRICE_BRIDGE_WSS_ENABLED: '0',
  ALLRICE_PORTAL_AUTH_ENABLED: '1',
  ALLRICE_LOCAL_PORTAL: 'snow',
  ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
  ALLRICE_PORTAL_SECURE_COOKIE: '0',
  ALLRICE_GEMINI_API_ENABLED: '0',
  ALLRICE_STORAGE_ROOT: join(temporary, 'storage'),
  ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
});
const postgres = createRequire(join(root, 'packages/database/package.json'))(
    'postgres',
  ) as typeof Postgres,
  { chromium } = wr('playwright-core') as typeof Playwright;
const { getDatabase, closeDatabase } =
  await import('../../../packages/database/src/core/client.ts');
const { createSession } =
  await import('../../../packages/database/src/identity.ts');
const { createLocalPreviewFixture } =
  await import('../../../packages/database/src/local-preview.fixture.ts');
const { appendJobEvent } =
  await import('../../../packages/database/src/execution/queue.ts');
const { createPortalSession } =
  await import('../../../apps/web/lib/portal/session.ts');
const { resolvePortal } =
  await import('../../../apps/web/lib/portal/config.ts');
const db = getDatabase(),
  admin = postgres(base, { max: 1, onnotice: () => {} });
let server: ChildProcess | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  schemaCreated = false,
  serverOutput = '';
const errors: string[] = [],
  checks: Record<string, unknown> = {
    scope:
      'synthetic session issuer and synthetic service facts; real Chrome ChatFlow UI/HTTP/PG; no renderer/controller/VM/model/Dev state',
    schema,
    origin,
    passed: false,
  };
const deadline = setTimeout(() => {
  void browser?.close();
  server?.kill('SIGTERM');
}, 180000);
async function waitFor(check: () => Promise<boolean>, name: string) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(100);
  }
  throw Error('WAIT_' + name);
}
async function actor(user: string, org: string, workspace: string) {
  const session = await createSession(user),
    context = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
    });
  await context.addCookies([
    {
      name: 'allrice_session',
      value: session.token,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'allrice_portal_session',
      value: createPortalSession({
        portal: resolvePortal('allrice-snow.bplabs.xyz')!,
        subject: user,
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
    if (u.origin === origin || ['blob:', 'data:'].includes(u.protocol))
      await route.continue();
    else await route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (new URL(r.url()).origin === origin && r.status() >= 400)
      errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return { page, context };
}
try {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((r) => probe.close(() => r()));
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
  server.stdout?.on('data', (b) => {
    serverOutput = (serverOutput + b.toString()).slice(-100000);
  });
  server.stderr?.on('data', (b) => {
    serverOutput = (serverOutput + b.toString()).slice(-100000);
  });
  await waitFor(async () => {
    if (server!.exitCode !== null) throw Error('WEB_EARLY_EXIT');
    try {
      return (await fetch(origin + '/login')).status < 500;
    } catch {
      return false;
    }
  }, 'WEB');
  const f = await createLocalPreviewFixture(
    db,
    process.env.ALLRICE_STORAGE_ROOT!,
  );
  const serviceBeat = setInterval(() => {
    void f.exchange().catch(() => {});
  }, 1000);
  try {
    const [job] = await db<
      { lease_token: string }[]
    >`select lease_token from allrice_jobs where id=${f.execution.jobId}`;
    await appendJobEvent({
      workerId: f.worker,
      jobId: f.execution.jobId,
      leaseToken: job!.lease_token,
      type: 'tool.started',
      payload: {
        toolCallId: randomUUID(),
        name: 'local.process.execute',
        label: 'local.process.execute',
      },
    });
    browser = await chromium.launch({
      headless: true,
      executablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      chromiumSandbox: true,
    });
    const { page, context } = await actor(f.user, f.org, f.workspace);
    await page.goto(`${origin}/chatflow?session=${f.session}`);
    const service = page.getByRole('region', { name: '有限后台服务' });
    const request = service.getByRole('button', {
      name: '准备项目预览',
      exact: true,
    });
    await request.waitFor();
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/runtime/local-services?'),
    );
    await request.click();
    assert.equal((await response).status(), 200);
    const panel = page.getByRole('region', { name: '受控浏览器工作台' });
    await panel.getByRole('heading', { name: /本地项目预览/ }).waitFor();
    await panel.getByText(/不开放本机端口或公共网址/).waitFor();
    await panel.getByText('正在启动', { exact: true }).waitFor();
    assert.equal(
      (await db`select id from allrice_browser_workspaces`).length,
      1,
    );
    assert.equal(
      (await db`select operation_id from allrice_browser_operation_inputs`)
        .length,
      0,
    );
    checks.processOnlyPrepareDoesNotInventAckOrNavigation = true;
    await page.screenshot({
      path: join(temporary, '01-prepared.png'),
      fullPage: true,
    });
    await page.reload();
    await panel.getByRole('heading', { name: /本地项目预览/ }).waitFor();
    const again = service.getByRole('button', {
      name: '申请打开预览',
      exact: true,
    });
    await again.waitFor();
    const repeatResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/runtime/local-services?'),
    );
    await again.click();
    assert.equal((await repeatResponse).status(), 200);
    assert.equal(
      (await db`select id from allrice_browser_workspaces`).length,
      1,
    );
    assert.equal(
      (await db`select operation_id from allrice_browser_operation_inputs`)
        .length,
      0,
    );
    checks.reloadPendingAndUniqueEndpoint = true;
    const bad = await context.request.post(
      `${origin}/api/v1/runtime/local-services?workspaceId=${f.workspace}&runId=${f.run}&processId=${f.processId}`,
      {
        headers: { origin },
        data: { action: 'preview', port: 9999, url: 'https://foreign.example' },
      },
    );
    assert.equal(bad.status(), 400);
    checks.clientCannotChoosePreviewTarget = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await delay(250);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    await page.screenshot({
      path: join(temporary, '02-narrow.png'),
      fullPage: true,
    });
    checks.narrowNoOverflow = true;
    const stopResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/runtime/local-services?'),
    );
    await service
      .getByRole('button', { name: '停止此服务', exact: true })
      .click();
    assert.equal((await stopResponse).status(), 200);
    await waitFor(
      async () =>
        !(await service
          .getByRole('button', { name: '申请打开预览', exact: true })
          .isEnabled()),
      'STOP_DISABLES_PREVIEW',
    );
    checks.stopPreventsAnotherPreviewIntent = true;
    assert.deepEqual(errors, []);
    checks.errors = errors;
    checks.passed = true;
  } finally {
    clearInterval(serviceBeat);
  }
} catch (error) {
  checks.error = error instanceof Error ? error.stack : String(error);
  checks.errors = errors;
  process.exitCode = 1;
  for (const [i, p] of (
    browser?.contexts().flatMap((c) => c.pages()) ?? []
  ).entries())
    await p
      .screenshot({ path: join(temporary, `failure-${i}.png`), fullPage: true })
      .catch(() => {});
} finally {
  clearTimeout(deadline);
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await once(server, 'exit');
    }
  }
  await closeDatabase();
  if (schemaCreated) {
    assert.match(schema, /^p23_ui_[a-f0-9]{32}$/);
    await admin.unsafe(`drop schema "${schema}" cascade`);
  }
  await admin.end();
  await writeFile(join(temporary, 'web.log'), serverOutput, { mode: 0o600 });
  await writeFile(
    join(temporary, 'report.json'),
    JSON.stringify(checks, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      report: join(temporary, 'report.json'),
      passed: checks.passed,
    }),
  );
}
