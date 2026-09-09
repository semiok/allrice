/** Actual private Chrome UI + production HTTP + real PostgreSQL.
 * Synthetic session issuer (not password login), no model calls and NO local
 * Chrome automation grants outside the disposable database. Driver/VM tests
 * have separate evidence; this verifies the real management entry points. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
if (process.env.ALLRICE_P22_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rr.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P22_UI_ISOLATED: '1',
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
const port = 3022,
  origin = `http://127.0.0.1:${port}`,
  base = 'postgres://a123@127.0.0.1:5432/allrice_b2',
  schema = `p22_ui_${randomUUID().replaceAll('-', '')}`,
  url = new URL(base),
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'allrice-p22-ui-')));
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
  ALLRICE_LOCAL_COMMAND_ENABLED: '0',
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
const { createCloudExecutionFixture } =
  await import('../../../packages/database/src/cloud-execution.fixture.ts');
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
      'synthetic session issuer, real Chrome management UI/HTTP/PG; no actual driver/model/Dev state',
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
  const f = await createCloudExecutionFixture(
    db,
    process.env.ALLRICE_STORAGE_ROOT!,
    { browserControl: true, localBrowser: true },
  );
  const deviceId = randomUUID(),
    targetId = randomUUID();
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
  values(${deviceId},${f.org},${f.workspace},${f.user},'Synthetic Intel Bridge','macos-x64',2,array['local.fs.list'],${createHash('sha256').update(randomBytes(32)).digest('hex')},clock_timestamp())`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
  values(${targetId},${f.org},${f.workspace},${`bridge.${deviceId}`},'rice_bridge','P22 management only','online','["files.read"]',${db.json({ bridgeDeviceId: deviceId })})`;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromiumSandbox: true,
  });
  const { page, context } = await actor(f.user, f.org, f.workspace);
  await page.goto(origin + '/workspace/local-browser');
  const settings = page.getByRole('region', { name: '本地浏览器授权' });
  await settings.getByLabel('执行设备', { exact: true }).selectOption(deviceId);
  await settings
    .getByLabel('允许站点', { exact: true })
    .fill('https://example.com');
  assert.equal(
    await settings
      .getByRole('checkbox', {
        name: '保留这个专属浏览器的登录资料供后续任务使用',
      })
      .isChecked(),
    false,
  );
  await settings
    .getByRole('button', { name: '保存浏览器授权', exact: true })
    .click();
  const grant = settings.getByRole('article');
  await grant.waitFor();
  await grant.getByText('已授权', { exact: true }).waitFor();
  const [stored] = await db<
    { id: string; persist_login: boolean }[]
  >`select g.id,l.persist_login from allrice_browser_control_grants g join allrice_local_browser_grants l on l.grant_id=g.id`;
  assert(stored);
  assert.equal(stored.persist_login, false);
  assert.equal(
    (
      await db`select id from allrice_bridge_folder_grants where device_id=${deviceId}`
    ).length,
    0,
  );
  assert.equal((await db`select id from allrice_browser_workspaces`).length, 0);
  checks.uiCreateDefaultPrivateNoFolderNoLaunch = true;
  await page.reload();
  await grant.getByText('已授权', { exact: true }).waitFor();
  checks.persistedAfterReload = true;
  await page.screenshot({
    path: join(temporary, '01-grant.png'),
    fullPage: true,
  });
  const stranger = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${stranger},${`${stranger}@example.test`},'P22 other admin','never-login')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${stranger},'admin')`;
  const other = await actor(stranger, f.org, f.workspace),
    endpoint = origin + '/api/v1/admin/local-browser';
  const otherList = await other.context.request.get(
    endpoint + `?workspaceId=${f.workspace}`,
  );
  assert.equal(otherList.status(), 200);
  assert.deepEqual((await otherList.json()).grants, []);
  const rejected = await other.context.request.patch(endpoint, {
    headers: { origin },
    data: { workspaceId: f.workspace, action: 'revoke', grantId: stored.id },
  });
  assert.equal(rejected.status(), 403);
  checks.crossOwnerCannotReadOrRevoke = true;
  await other.context.close();
  const invalid = await context.request.post(endpoint, {
    headers: { origin },
    data: {
      workspaceId: f.workspace,
      deviceId,
      persistLogin: false,
      profile: {
        version: 1,
        origins: ['https://127.0.0.1'],
        allowUploads: false,
        allowDownloads: false,
        allowHumanCredentials: false,
        lifetimeMs: 300000,
        maximumFileBytes: 1000000,
      },
    },
  });
  assert([400, 403].includes(invalid.status()));
  checks.privateOriginRejected = true;
  await grant
    .getByRole('button', { name: '撤销并清理登录资料', exact: true })
    .click();
  await grant.getByText('已撤销', { exact: true }).waitFor();
  await grant
    .getByText('等待设备确认清理；离线设备需重新连接', { exact: true })
    .waitFor();
  checks.revocationWaitsForRealDeviceAck = true;
  await page.screenshot({
    path: join(temporary, '02-revoked.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: join(temporary, '03-narrow.png'),
    fullPage: true,
  });
  checks.narrowNoOverflow = true;
  assert.deepEqual(errors, []);
  checks.passed = true;
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
    assert.match(schema, /^p22_ui_[a-f0-9]{32}$/);
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
