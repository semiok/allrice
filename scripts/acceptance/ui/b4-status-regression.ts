/** Real isolated Chrome + built Next + signed synthetic portal + PostgreSQL.
 * Exercises flags-OFF history and Bridge status; no API mocks, model, Worker,
 * VM, personal browser profile, Dev or production data. Build Web first, then:
 * pnpm exec tsx scripts/acceptance/ui/b4-status-regression.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import type { RequestContext } from '@allrice/contracts';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(join(root, 'package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
if (process.env.ALLRICE_B4_STATUS_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_B4_STATUS_ISOLATED: '1',
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

const port = 3007,
  origin = `http://127.0.0.1:${port}`;
const base = 'postgres://a123@127.0.0.1:5432/allrice_b2';
const schema = `b4_status_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(base);
databaseUrl.searchParams.set('options', `-csearch_path=${schema},public`);
const temporary = await mkdtemp(join(tmpdir(), 'allrice-b4-status-ui-'));
const evidenceRoot = join(temporary, 'evidence'),
  storageRoot = join(temporary, 'storage');
await mkdir(evidenceRoot);
const executionFlags = Object.fromEntries(
  [
    'ALLRICE_LOCAL_COMMAND_ENABLED',
    'ALLRICE_RUNTIME_POLICY_ENABLED',
    'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    'ALLRICE_BRIDGE_WSS_ENABLED',
    'ALLRICE_CLOUD_MCP_ENABLED',
    'ALLRICE_CLOUD_RUNNER_ENABLED',
    'ALLRICE_WORKBENCH_ENABLED',
    'ALLRICE_CHANGESET_ENABLED',
    'ALLRICE_LOCAL_SERVICE_ENABLED',
    'ALLRICE_CHATFLOW_REALTIME_ENABLED',
    'ALLRICE_GEMINI_API_ENABLED',
  ].map((name) => [name, '0']),
);
Object.assign(process.env, executionFlags, {
  DATABASE_URL: databaseUrl.toString(),
  ALLRICE_PORTAL_AUTH_ENABLED: '1',
  ALLRICE_LOCAL_PORTAL: 'snow',
  ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
  ALLRICE_PORTAL_SECURE_COOKIE: '0',
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
const { ensureDefaultEmployee } =
  await import('../../../packages/database/src/workspace/service.ts');
const { createPortalSession } =
  await import('../../../apps/web/lib/portal/session.ts');
const { resolvePortal } =
  await import('../../../apps/web/lib/portal/config.ts');
const admin = postgres(base, { max: 1, onnotice: () => {} }),
  db = getDatabase();
let server: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Playwright.Page | undefined;
let schemaCreated = false,
  serverOutput = '';
let failNextDeviceFetch = false;
const injectedNetworkFailures: string[] = [];
const pageErrors: string[] = [],
  consoleErrors: string[] = [];
const failedResponses: { path: string; status: number }[] = [],
  localRequests: string[] = [];
const requestedHistories = new Set<string>();
const checks: Record<string, unknown> = {
  scope:
    'Real Chrome + built Next + signed synthetic tenant portal + isolated PostgreSQL. No API mocks, Worker/model/VM or live tenant writes.',
  origin,
  schema,
  executionFlags,
  passed: false,
};
const user = randomUUID(),
  org = randomUUID(),
  workspace = randomUUID(),
  membership = randomUUID(),
  device = randomUUID();
const workspaceLabel = 'B4 synthetic workspace';
const sessions: {
  id: string;
  title: string;
  answers: { id: string; text: string; run: string }[];
}[] = [];

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

async function seedHistory() {
  await db.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'B4 status test','not-a-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`b4-${org}`},'B4 status synthetic')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','B4 status synthetic')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
  });
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    authenticatedAt: new Date().toISOString(),
    memberships: [
      {
        id: membership,
        organizationId: org,
        workspaceId: workspace,
        userId: user,
        role: 'admin',
        active: true,
      },
    ],
  };
  const employee = await ensureDefaultEmployee(context, workspace);
  const [version] =
    await db`select provider_snapshot from allrice_employee_versions where id=${employee.employeeVersionId}`;
  assert.ok(version);
  for (let index = 0; index < 2; index++) {
    const session = {
      id: randomUUID(),
      title: `B4 history ${index + 1}`,
      answers: [] as { id: string; text: string; run: string }[],
    };
    sessions.push(session);
    await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${session.id},${org},${workspace},${user},${session.title},${employee.id},${employee.employeeVersionId})`;
    for (let turn = 0; turn < 4; turn++) {
      const run = randomUUID(),
        um = randomUUID(),
        am = randomUUID();
      const text = `Synthetic historical answer ${index + 1}.${turn + 1}`;
      session.answers.push({ id: am, text, run });
      const created = new Date(Date.now() - 60_000 + turn * 1000);
      await db.begin(async (tx) => {
        await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,completed_at) values(${run},${org},${workspace},${user},'succeeded',now())`;
        await tx`insert into allrice_jobs(organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,completed_at)
          values(${org},${workspace},${user},${run},'succeeded',${randomUUID()},now()+interval '1 hour','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',now())`;
        await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,created_at,completed_at)
          values(${um},${org},${workspace},${session.id},${user},'user',${tx.json({ text: `Historical request ${turn + 1}`, citations: [] })},${created},${created}),
          (${am},${org},${workspace},${session.id},${user},'assistant',${tx.json({ text, citations: [] })},${created},${created})`;
        // Exercise supported legacy historical snapshots, not fabricated live model execution.
        await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,status,provider_snapshot,prompt_snapshot,completed_at)
          values(${run},${org},${workspace},${user},${employee.id},${employee.employeeVersionId},${session.id},${um},${am},'succeeded',${tx.json(version.provider_snapshot)},${tx.json({ systemPrompt: 'Synthetic history only', conversation: [], memories: [], userRequest: 'Historical test' })},now())`;
      });
    }
  }
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
    values(${device},${org},${workspace},${user},'Synthetic M5 · Rice Bridge','macos-arm64',1,array['local.fs.list'],${randomBytes(32).toString('hex')},clock_timestamp())`;
}

async function assertHistory(session: (typeof sessions)[number]) {
  for (const answer of session.answers) {
    await page!.locator(`#message-${answer.id}`).waitFor({ state: 'attached' });
    assert.ok(
      (await page!.locator(`#message-${answer.id}`).textContent())?.includes(
        answer.text,
      ),
    );
  }
  const response = await page!.request.get(
    `${origin}/api/v1/sessions/${session.id}?workspaceId=${workspace}`,
  );
  assert.equal(response.status(), 200, await response.text());
  const history = (await response.json()).history;
  assert.equal(
    history.messages.filter((message: { runId?: string }) => message.runId)
      .length,
    4,
    'The tested historical messages must really carry Run IDs',
  );
}
async function assertDeviceApi(expected: 'online' | 'offline', grants: number) {
  const response = await page!.request.get(
    `${origin}/api/v1/bridge/devices?workspaceId=${workspace}`,
  );
  assert.equal(response.status(), 200, await response.text());
  assert.match(response.headers()['cache-control'] ?? '', /no-store/);
  const { devices } = await response.json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].status, expected);
  assert.equal(devices[0].folderGrants.length, grants);
}
async function openBridge(label: string) {
  await page!.getByRole('button', { name: label, exact: true }).click();
  const dialog = page!.getByRole('dialog', {
    name: '本地工作区状态',
    exact: true,
  });
  await dialog.waitFor();
  return dialog;
}
async function refreshBridge(dialog: Playwright.Locator) {
  const response = page!.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/v1/bridge/devices' &&
      r.request().method() === 'GET',
  );
  await dialog.getByRole('button', { name: '刷新状态', exact: true }).click();
  assert.equal((await response).status(), 200);
  // A following selector assertion waits for React to consume the actual response.
}

try {
  checks.sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  checks.trackedDiffDigest = createHash('sha256')
    .update(execFileSync('git', ['diff', '--binary'], { cwd: root }))
    .digest('hex');
  checks.sourceDigests = Object.fromEntries(
    await Promise.all(
      [
        'apps/web/app/chatflow/page.tsx',
        'apps/web/app/chatflow/chatflow-client.tsx',
        'apps/web/app/chatflow/chat-transcript.tsx',
        'apps/web/app/chatflow/chat-composer.tsx',
        'apps/web/app/chatflow/use-bridge.ts',
        'apps/web/app/chatflow/bridge-view.ts',
        'apps/web/app/chatflow/bridge-refresh.ts',
        'apps/web/app/api/v1/bridge/devices/route.ts',
        'packages/database/src/bridge.ts',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ]),
    ),
  );
  checks.buildId = (
    await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')
  ).trim();
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20260907,1)`;
    await tx`create extension if not exists vector with schema public`;
    await tx`create extension if not exists pg_trgm with schema public`;
  });
  await admin.unsafe(`create schema "${schema}"`);
  schemaCreated = true;
  for (const migration of (
    await readdir(join(root, 'packages/database/migrations'))
  )
    .filter((name) => name.endsWith('.sql'))
    .sort())
    await db.unsafe(
      await readFile(
        join(root, 'packages/database/migrations', migration),
        'utf8',
      ),
    );
  await seedHistory();
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
    {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout?.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr?.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null)
      throw Error(`Private Web exited: ${serverOutput}`);
    try {
      if ((await fetch(`${origin}/login`)).status < 500) break;
    } catch {
      /* Starting. */
    }
    if (attempt === 149) throw Error('Private Web startup timed out');
    await delay(200);
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ALLRICE_TEST_CHROME,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const login = await createSession(user);
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
        subject: 'synthetic-b4-status',
        organizationId: org,
        workspaceId: workspace,
      }).value,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  // Block external browsing; application API responses are never stubbed.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      failNextDeviceFetch &&
      url.origin === origin &&
      url.pathname === '/api/v1/bridge/devices'
    ) {
      failNextDeviceFetch = false;
      injectedNetworkFailures.push(url.pathname);
      return route.abort('failed');
    }
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/runtime/local-commands')
      localRequests.push(url.pathname + url.search);
    if (/^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname))
      requestedHistories.add(url.pathname);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  await page.goto(`${origin}/chatflow?session=${sessions[0]!.id}`);
  await assertHistory(sessions[0]!);
  await page
    .getByRole('button', { name: new RegExp(sessions[1]!.title) })
    .click();
  await assertHistory(sessions[1]!);
  await page
    .getByRole('button', { name: new RegExp(sessions[0]!.title) })
    .click();
  await assertHistory(sessions[0]!);
  await page.reload();
  await assertHistory(sessions[0]!);
  assert.equal(requestedHistories.size, 2);
  checks.history = {
    sessions: 2,
    assistantRuns: 8,
    switchBack: true,
    reload: true,
  };
  await assertDeviceApi('online', 0);
  await page
    .getByRole('button', { name: 'Bridge 在线 · 未选择工作区', exact: true })
    .waitFor();
  let dialog = await openBridge('Bridge 在线 · 未选择工作区');
  await dialog
    .getByText('Bridge 在线，工作区未连接', { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(evidenceRoot, '01-online-without-workspace.png'),
    fullPage: true,
  });
  await db`insert into allrice_bridge_folder_grants(organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
    values(${org},${workspace},${user},${device},${workspaceLabel},${randomBytes(32).toString('hex')})`;
  await refreshBridge(dialog);
  await dialog
    .getByText(`本地工作区：${workspaceLabel}`, { exact: true })
    .waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('button', { name: `本地工作区 ${workspaceLabel}`, exact: true })
    .waitFor();
  await assertDeviceApi('online', 1);
  await page.screenshot({
    path: join(evidenceRoot, '02-online-workspace.png'),
    fullPage: true,
  });
  dialog = await openBridge(`本地工作区 ${workspaceLabel}`);
  await db`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '5 minutes' where id=${device}`;
  await assertDeviceApi('offline', 1); // The old grant is retained, only hidden by the UI.
  await refreshBridge(dialog);
  await dialog.getByText('Bridge 当前离线', { exact: true }).waitFor();
  assert.equal(await dialog.getByText(new RegExp(workspaceLabel)).count(), 0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('button', { name: 'Bridge 离线', exact: true })
    .waitFor();
  assert.equal(
    await page.getByText(workspaceLabel, { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: join(evidenceRoot, '03-expired-offline.png'),
    fullPage: true,
  });
  dialog = await openBridge('Bridge 离线');
  await db`update allrice_bridge_devices set last_seen_at=clock_timestamp() where id=${device}`;
  await refreshBridge(dialog);
  await dialog
    .getByText(`本地工作区：${workspaceLabel}`, { exact: true })
    .waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('button', { name: `本地工作区 ${workspaceLabel}`, exact: true })
    .waitFor();
  await assertDeviceApi('online', 1);
  checks.bridge = {
    onlineWithoutWorkspace: true,
    onlineWithWorkspace: true,
    expiredHeartbeatOffline: true,
    offlineWorkspaceHidden: true,
    refreshRestoredOnline: true,
    actualApiNoStore: true,
  };
  // Include at least one real 15-second Bridge polling cycle after the changes.
  await delay(16_000);
  assert.deepEqual(
    localRequests,
    [],
    'Flags-OFF history must not request local-commands, including after session switches and refresh',
  );
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  checks.normalConsoleErrors = [];
  // Separate explicitly injected network failure: do not invent a successful
  // API response or mistake the previous online response for current authority.
  dialog = await openBridge(`本地工作区 ${workspaceLabel}`);
  failNextDeviceFetch = true;
  await dialog.getByRole('button', { name: '刷新状态', exact: true }).click();
  await dialog.getByText('Bridge 状态待确认', { exact: true }).waitFor();
  const failedRefreshLabel = await dialog
    .locator('[data-bridge-refresh-status]')
    .textContent();
  assert.ok(failedRefreshLabel && !failedRefreshLabel.includes('状态已刷新'));
  assert.equal(await dialog.getByText(new RegExp(workspaceLabel)).count(), 0);
  await page
    .getByRole('button', {
      name: 'Bridge 状态待确认',
      exact: true,
      includeHidden: true,
    })
    .waitFor();
  await page.screenshot({
    path: join(evidenceRoot, '04-refresh-failure-unknown.png'),
    fullPage: true,
  });
  await refreshBridge(dialog);
  await dialog
    .getByText(`本地工作区：${workspaceLabel}`, { exact: true })
    .waitFor();
  assert.match(
    (await dialog.locator('[data-bridge-refresh-status]').textContent()) ?? '',
    /状态已刷新/,
  );
  assert.equal(
    await dialog.getByText('Bridge 状态待确认', { exact: true }).count(),
    0,
  );
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('button', { name: `本地工作区 ${workspaceLabel}`, exact: true })
    .waitFor();
  assert.deepEqual(injectedNetworkFailures, ['/api/v1/bridge/devices']);
  assert.equal(
    await page.getByText(/Failed to fetch|本地电脑状态加载失败/).count(),
    0,
    'Successful refresh must clear the old Bridge error, not leave a chat error banner',
  );
  assert.ok(
    consoleErrors.every((error) => /net::ERR_FAILED/.test(error)),
    'Only the deliberately injected network error may appear',
  );
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(localRequests, []);
  assert.deepEqual(pageErrors, []);
  checks.injectedNetworkFailure = {
    count: 1,
    staleOnlineCleared: true,
    workspaceHidden: true,
    refreshRecovered: true,
    oldErrorCleared: true,
    expectedConsoleErrors: consoleErrors,
  };
  await page.screenshot({
    path: join(evidenceRoot, '05-refresh-recovered.png'),
    fullPage: true,
  });
  checks.passed = true;
} catch (error) {
  checks.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (page)
    await page
      .screenshot({ path: join(evidenceRoot, 'failure.png'), fullPage: true })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  checks.localCommandRequests = localRequests;
  checks.failedResponses = failedResponses;
  checks.consoleErrors = consoleErrors;
  checks.pageErrors = pageErrors;
  await browser?.close();
  await stopServer();
  await closeDatabase();
  if (schemaCreated) await admin.unsafe(`drop schema "${schema}" cascade`);
  await admin.end();
  await rm(storageRoot, { recursive: true, force: true });
  await writeFile(join(evidenceRoot, 'server.log'), serverOutput, {
    mode: 0o600,
  });
  await writeFile(
    join(evidenceRoot, 'checks.json'),
    JSON.stringify(checks, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      passed: checks.passed,
      evidenceRoot,
      sha: checks.sha,
      buildId: checks.buildId,
    }),
  );
}
