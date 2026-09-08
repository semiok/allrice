/** Real Chrome + HTTP + PostgreSQL + runsc + downloaded XLSX acceptance.
 * No model/DSH invocation. Never uses Dev/Prod, real users or a personal browser
 * profile. Run: pnpm exec tsx scripts/acceptance/runtime/b4-cloud-workbench.ts
 * Requires the already-built Web and dedicated allrice-cloud-b4 VM.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
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
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const rootRequire = createRequire(join(root, 'package.json'));
const port = 3005,
  origin = `http://127.0.0.1:${port}`;
const baseDatabaseUrl = 'postgres://a123@127.0.0.1:5432/allrice_b2';

// Re-exec ourselves with an allowlisted environment, before loading application
// modules. Neither the Web nor in-process synthetic Worker inherits credentials.
if (process.env.ALLRICE_B4_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_B4_UI_ISOLATED: '1',
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

const schema = `b4_ui_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('options', `-csearch_path=${schema},public`);
const temporary = await mkdtemp(join(tmpdir(), 'allrice-b4-workbench-'));
const storageRoot = join(temporary, 'storage');
const evidenceRoot = join(temporary, 'evidence');
await mkdir(evidenceRoot);
Object.assign(process.env, {
  DATABASE_URL: databaseUrl.toString(),
  ALLRICE_CLOUD_RUNNER_ENABLED: '1',
  ALLRICE_RUNTIME_POLICY_ENABLED: '1',
  ALLRICE_WORKBENCH_ENABLED: '1',
  ALLRICE_CLOUD_MCP_ENABLED: '0',
  ALLRICE_BRIDGE_WSS_ENABLED: '0',
  ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '0',
  ALLRICE_PORTAL_AUTH_ENABLED: '0',
  ALLRICE_PORTAL_SECURE_COOKIE: '0',
  ALLRICE_GEMINI_API_ENABLED: '0',
  ALLRICE_STORAGE_ROOT: storageRoot,
  ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
});

const postgres = createRequire(join(root, 'packages/database/package.json'))(
  'postgres',
) as typeof Postgres;
const { chromium } = workerRequire('playwright-core') as typeof Playwright;
type Worksheet = {
  name: string;
  rowCount: number;
  getCell(address: string): { value: unknown };
};
const ExcelJS = workerRequire('exceljs') as {
  Workbook: new () => {
    worksheets: Worksheet[];
    getWorksheet(name: string): Worksheet | undefined;
    xlsx: { load(bytes: ArrayBuffer): Promise<void> };
  };
};
const { getDatabase, closeDatabase } =
  await import('../../../packages/database/src/core/client.ts');
const { createSession } =
  await import('../../../packages/database/src/identity.ts');
const { createCloudExecutionFixture } =
  await import('../../../packages/database/src/cloud-execution.fixture.ts');
const { CloudRunnerBackend } =
  await import('../../../apps/worker/src/cloud-runner/backend.ts');
const { runCloudCommandOperation } =
  await import('../../../apps/worker/src/cloud-runner/executor.ts');
const { exportReconciliation } =
  await import('../../../apps/worker/src/tool-broker/handlers/reconciliation.ts');
const admin = postgres(baseDatabaseUrl, { max: 2, onnotice: () => {} });
const db = getDatabase();
const backend = new CloudRunnerBackend();
const attempts: string[] = [];
const pageErrors: string[] = [];
const failedHttp: { path: string; status: number }[] = [];
const checks: Record<string, unknown> = {
  mode: 'real Chrome + HTTP + PG + runsc + XLSX; no model or DSH E2E',
  schema,
  origin,
};
let server: ChildProcess | undefined;
let serverOutput = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let schemaCreated = false;

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

async function startServer() {
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
      cwd: temporary,
      env: { ...process.env }, // Already re-execed with the explicit allowlist above.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [server.stdout, server.stderr])
    stream?.on('data', (chunk: Buffer) => {
      serverOutput = (serverOutput + chunk.toString()).slice(-100_000);
    });
  for (let n = 0; n < 120; n++) {
    if (server.exitCode !== null)
      throw Error(`Isolated Web exited: ${serverOutput}`);
    try {
      if (
        (await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) }))
          .ok
      )
        return;
    } catch {
      /* Only polling our own just-spawned private server. */
    }
    await delay(250);
  }
  throw Error(`Private Web not ready: ${serverOutput}`);
}

try {
  // Refuse to contact/stop another application already occupying this port.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
  await access(join(root, 'apps/web/.next/BUILD_ID'));
  // Next normally reads dotenv files even with a minimal inherited env. Refuse
  // them entirely here, as well as setting its already-processed guard.
  for (const file of await readdir(join(root, 'apps/web'))) {
    assert.ok(
      !/^\.env(?:\.|$)/.test(file),
      'Web dotenv file found; use a clean built worktree for acceptance',
    );
  }
  await admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20260907,1)`;
    await tx`create extension if not exists vector with schema public`;
    await tx`create extension if not exists pg_trgm with schema public`;
  });
  await admin.unsafe(`create schema ${schema}`);
  schemaCreated = true;
  const migrations = join(root, 'packages/database/migrations');
  for (const file of (await readdir(migrations))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await db.unsafe(await readFile(join(migrations, file), 'utf8'));
  }
  console.info('B4 UI: isolated schema migrated');
  const fixture = await createCloudExecutionFixture(db, storageRoot, {
    workbench: true,
    reconciliationOnly: true,
  });
  const rejectedFixture = await createCloudExecutionFixture(db, storageRoot, {
    workbench: true,
  });
  // A different active member of the SAME workspace, not merely another tenant.
  const strangerId = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${strangerId},${`${strangerId}@example.test`},'B4 UI different member','not-login')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${fixture.org},${fixture.workspace},${strangerId},'member')`;
  await db`update allrice_chat_sessions set title='B4 浏览器对账验收' where id=${fixture.session}`;
  const directory = join(root, 'skills/business-reconciliation');
  const inputs = [];
  for (const path of ['invoices.csv', 'payments.csv']) {
    const object = await fixture.upload(
      await readFile(join(directory, 'assets', path)),
      'text/csv',
    );
    inputs.push({ path, objectId: object.id, checksum: object.checksum });
  }
  const created = await fixture.create('b4-browser-reconcile', {
    script: await readFile(join(directory, 'scripts/reconcile.mjs'), 'utf8'),
    inputs,
    outputs: [
      {
        path: 'reconciliation.json',
        fileName: 'reconciliation.json',
        format: 'json',
      },
      {
        path: 'reconciliation.csv',
        fileName: 'reconciliation.csv',
        format: 'csv',
      },
    ],
  });
  const rejected = await rejectedFixture.create('b4-browser-reject');
  attempts.push(
    created.snapshot.binding.attempt.attemptId,
    rejected.snapshot.binding.attempt.attemptId,
  );
  assert.equal(created.snapshot.status, 'waiting_user');
  assert.equal(
    (
      await db`select id from allrice_bridge_devices where organization_id=${fixture.org}`
    ).length,
    0,
  );

  await startServer();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ALLRICE_TEST_CHROME,
  });
  async function actorBrowser(userId: string, width = 1600) {
    const login = await createSession(userId);
    const context = await browser!.newContext({
      viewport: { width, height: 1100 },
      acceptDownloads: true,
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
    ]);
    // No external navigation/API is permitted by this disposable test context.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol))
        await route.continue();
      else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500)
        failedHttp.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
    });
    return { context, page };
  }
  const { context, page } = await actorBrowser(fixture.user);
  const headers = {
    'x-allrice-organization-id': fixture.org,
    'x-allrice-workspace-id': fixture.workspace,
  };
  const operationsUrl = `/api/v1/runtime/cloud-operations?workspaceId=${fixture.workspace}&runId=${fixture.run}`;
  const initial = await context.request.get(`${origin}${operationsUrl}`, {
    headers,
  });
  assert.equal(initial.status(), 200, await initial.text());
  const initialBody = await initial.json();
  const request = initialBody.operations[0].approval.request;
  checks.approvalId = request.approvalId;
  const { context: stranger } = await actorBrowser(strangerId);
  const forbiddenRead = await stranger.request.get(
    `${origin}${operationsUrl}`,
    { headers },
  );
  assert.ok([403, 404].includes(forbiddenRead.status()));
  const forgedDecision = {
    contractVersion: 1,
    direction: 'response',
    kind: 'action_approval',
    requestId: request.requestId,
    version: request.version,
    requestDigest: request.requestDigest,
    task: request.task,
    responseId: randomUUID(),
    respondedBy: fixture.user,
    respondedAt: new Date().toISOString(),
    approvalId: request.approvalId,
    decision: 'approved',
  };
  const forbiddenApproval = await stranger.request.post(
    `${origin}/api/v1/runtime/approvals/${request.approvalId}`,
    { headers: { ...headers, Origin: origin }, data: forgedDecision },
  );
  assert.ok([403, 404].includes(forbiddenApproval.status()));
  checks.sameWorkspaceOtherUserDenied = {
    read: forbiddenRead.status(),
    approve: forbiddenApproval.status(),
  };

  await page.goto(`${origin}/chatflow?session=${fixture.session}`, {
    waitUntil: 'domcontentloaded',
  });
  const card = page.locator(
    `#operation-${created.snapshot.binding.attempt.operationId}`,
  );
  await card
    .getByRole('button', { name: '批准这一次执行', exact: true })
    .waitFor({ timeout: 25_000 });
  assert.ok((await card.textContent())?.includes(inputs[0]!.checksum));
  await page.screenshot({
    path: join(evidenceRoot, '01-pending-wide.png'),
    fullPage: true,
  });
  console.info('B4 UI: pending card visible; refreshing');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await card
    .getByRole('button', { name: '批准这一次执行', exact: true })
    .waitFor();
  const approveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/runtime/approvals/${request.approvalId}`) &&
      response.request().method() === 'POST',
  );
  await card
    .getByRole('button', { name: '批准这一次执行', exact: true })
    .click();
  const approvedHttp = await approveResponse;
  assert.equal(approvedHttp.status(), 200);
  await card
    .getByRole('status')
    .filter({ hasText: '已批准，等待派发' })
    .waitFor();
  const submittedDecision = approvedHttp.request().postDataJSON();
  // Retry the exact already-submitted response over HTTP, without a second permission.
  const replay = await context.request.post(approvedHttp.url(), {
    headers: { ...headers, Origin: origin },
    data: submittedDecision,
  });
  assert.equal(replay.status(), 200, await replay.text());
  checks.refreshThenApproveAndRetry = true;
  console.info('B4 UI: browser refresh + approval HTTP + exact replay passed');

  const computed = await runCloudCommandOperation(created, {
    storage: fixture.storage,
    backend,
    database: db,
  });
  assert.equal(computed.status, 'succeeded', JSON.stringify(computed));
  assert.equal(computed.artifacts.length, 2);
  assert.equal(
    await backend.inspect(created.snapshot.binding.attempt.attemptId),
    null,
  );
  const json = computed.artifacts.find(
    (artifact) => artifact.fileName === 'reconciliation.json',
  );
  assert.ok(json);
  const exportArgs = {
    artifactId: json.versionId,
    fileName: 'B4浏览器验收对账',
  };
  const exported = JSON.parse(
    (
      await exportReconciliation({
        input: {
          context: fixture.execution,
          capabilities: ['storage:read', 'storage:write'],
          storageRoot,
          sessionId: fixture.session,
          call: {
            id: 'b4-browser-xlsx',
            name: 'workspace.reconciliation.export',
            arguments: exportArgs,
          },
        },
        arguments: exportArgs,
      })
    ).modelContent,
  );
  checks.sandbox = {
    status: computed.status,
    artifacts: computed.artifacts.length,
    destroyed: true,
  };
  checks.export = {
    artifactId: exported.artifactId,
    objectId: exported.objectId,
    totals: exported.totals,
  };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await card
    .getByRole('status')
    .filter({ hasText: '执行已返回成功' })
    .waitFor();
  await page.getByRole('button', { name: /▤ 工件与审查/ }).click();
  const workbench = page.getByRole('complementary', {
    name: '工件与审查工作台',
  });
  await workbench
    .getByLabel('工件版本', { exact: true })
    .selectOption(exported.artifactId);
  await workbench.getByText(/目标：云端沙箱/).waitFor();
  assert.equal(await workbench.getByText(/目标：本地 Bridge/).count(), 0);
  checks.cloudArtifactTargetLabel = true;
  const download = page.waitForEvent('download');
  await workbench
    .getByRole('link', { name: '下载此版本', exact: true })
    .click();
  const actualDownload = await download;
  assert.equal(await actualDownload.failure(), null);
  const downloadedPath = join(evidenceRoot, 'downloaded-reconciliation.xlsx');
  await actualDownload.saveAs(downloadedPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    Uint8Array.from(await readFile(downloadedPath)).buffer,
  );
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['核对摘要', '发票明细', '待人工核查'],
  );
  const details = workbook.getWorksheet('发票明细')!;
  assert.equal(details.rowCount, 6);
  assert.deepEqual(
    ['A2', 'B2', 'C2', 'D2', 'E2'].map((cell) => details.getCell(cell).value),
    ['A', 10050, 10050, 0, 'matched'],
  );
  assert.deepEqual(
    ['A3', 'B3', 'C3', 'D3', 'E3'].map((cell) => details.getCell(cell).value),
    ['B', 20000, 18000, 2000, 'ambiguous'],
  );
  assert.equal(workbook.getWorksheet('待人工核查')!.rowCount, 4);
  checks.browserDownloadReopened = {
    suggestedFilename: actualDownload.suggestedFilename(),
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    rowCount: details.rowCount,
  };
  const forbiddenDownload = await stranger.request.get(
    `${origin}/api/v1/files/${exported.objectId}/download`,
  );
  assert.ok([403, 404].includes(forbiddenDownload.status()));
  checks.sameWorkspaceOtherUserDownloadDenied = forbiddenDownload.status();
  await page.screenshot({
    path: join(evidenceRoot, '02-workbench-wide.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = page.getByRole('dialog', { name: '工件与审查工作台' });
  await drawer.waitFor();
  assert.equal(await drawer.getAttribute('aria-modal'), 'true');
  const box = await drawer.boundingBox();
  assert.ok(box && box.x >= -1 && box.width <= 392);
  await page.screenshot({
    path: join(evidenceRoot, '03-workbench-narrow.png'),
    fullPage: true,
  });
  await drawer.getByRole('button', { name: '关闭工作台' }).click();
  await drawer.waitFor({ state: 'hidden' });
  checks.narrowDrawer = true;

  const { page: rejectedPage } = await actorBrowser(rejectedFixture.user, 390);
  await rejectedPage.goto(
    `${origin}/chatflow?session=${rejectedFixture.session}`,
    { waitUntil: 'domcontentloaded' },
  );
  const rejectedCard = rejectedPage.locator(
    `#operation-${rejected.snapshot.binding.attempt.operationId}`,
  );
  await rejectedCard
    .getByRole('button', { name: '拒绝', exact: true })
    .waitFor();
  const rejectionResponse = rejectedPage.waitForResponse(
    (response) =>
      response.url().includes('/runtime/approvals/') &&
      response.request().method() === 'POST',
  );
  await rejectedCard.getByRole('button', { name: '拒绝', exact: true }).click();
  assert.equal((await rejectionResponse).status(), 200);
  await rejectedPage.reload({ waitUntil: 'domcontentloaded' });
  await rejectedCard
    .getByRole('status')
    .filter({ hasText: '已拒绝本次操作' })
    .waitFor();
  const blocked = await runCloudCommandOperation(rejected, {
    storage: rejectedFixture.storage,
    backend,
    database: db,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(
    await backend.inspect(rejected.snapshot.binding.attempt.attemptId),
    null,
  );
  assert.equal(
    (
      await db`select operation_id from allrice_cloud_execution_attempts where operation_id=${rejected.snapshot.binding.attempt.operationId}`
    ).length,
    0,
  );
  checks.rejectedAfterRefreshNeverDispatched = true;
  await rejectedPage.screenshot({
    path: join(evidenceRoot, '04-rejected-narrow.png'),
    fullPage: true,
  });

  // A second private Web boot also exercises the real signed tenant portal
  // proxy. The built proxy must contain the exact MCP management exception;
  // these cookies contain only this random schema's synthetic tenant IDs.
  for (const current of browser.contexts()) await current.close();
  await stopServer();
  Object.assign(process.env, {
    ALLRICE_PORTAL_AUTH_ENABLED: '1',
    ALLRICE_LOCAL_PORTAL: 'snow',
    ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
    ALLRICE_CLOUD_MCP_ENABLED: '1',
    ALLRICE_CLOUD_RUNNER_ENABLED: '0',
  });
  const { createPortalSession } =
    await import('../../../apps/web/lib/portal/session.ts');
  const { resolvePortal } =
    await import('../../../apps/web/lib/portal/config.ts');
  await startServer();
  const portalAdmin = await actorBrowser(fixture.user);
  const portalMember = await actorBrowser(strangerId);
  const managementUrl = `${origin}/api/v1/admin/mcp?workspaceId=${fixture.workspace}`;
  assert.equal(
    (await portalAdmin.context.request.get(managementUrl)).status(),
    401,
  );
  const portalCookie = (key: 'snow' | 'drink') => ({
    name: 'allrice_portal_session',
    value: createPortalSession({
      portal: resolvePortal(`allrice-${key}.bplabs.xyz`)!,
      subject: 'synthetic-b4-portal-only',
      organizationId: fixture.org,
      workspaceId: fixture.workspace,
    }).value,
    url: origin,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax' as const,
  });
  await portalAdmin.context.addCookies([portalCookie('drink')]);
  assert.equal(
    (await portalAdmin.context.request.get(managementUrl)).status(),
    401,
  );
  await portalAdmin.context.addCookies([portalCookie('snow')]);
  await portalMember.context.addCookies([portalCookie('snow')]);
  const management = await portalAdmin.context.request.get(managementUrl);
  assert.equal(management.status(), 200, await management.text());
  assert.deepEqual((await management.json()).connections, []);
  assert.equal(
    (await portalMember.context.request.get(managementUrl)).status(),
    403,
  );
  assert.equal(
    (
      await portalAdmin.context.request.get(
        `${origin}/api/v1/admin/platform-employees`,
      )
    ).status(),
    403,
  );
  assert.equal(
    (
      await portalAdmin.context.request.get(`${origin}/api/v1/admin/mcp/extra`)
    ).status(),
    403,
  );
  const historyFlagOff = await portalAdmin.context.request.get(
    `${origin}${operationsUrl}`,
  );
  assert.equal(historyFlagOff.status(), 200);
  const historyBody = await historyFlagOff.json();
  assert.equal(historyBody.operations[0].enabled, false);
  assert.equal(historyBody.operations[0].snapshot.status, 'succeeded');
  await portalAdmin.page.goto(`${origin}/chatflow?session=${fixture.session}`, {
    waitUntil: 'domcontentloaded',
  });
  await portalAdmin.page.getByRole('link', { name: 'MCP 连接管理' }).click();
  await portalAdmin.page
    .getByRole('heading', { name: '当前租户的 MCP 连接' })
    .waitFor();
  const mcpPanel = portalAdmin.page.getByRole('region', {
    name: '云端 MCP 连接',
  });
  await mcpPanel.getByLabel('连接名称', { exact: true }).waitFor();
  await mcpPanel
    .getByText('此环境尚未启用云端 MCP，不能创建或执行连接。')
    .waitFor({ state: 'hidden' });
  assert.equal(await mcpPanel.getByRole('alert').count(), 0);
  await portalAdmin.page.screenshot({
    path: join(evidenceRoot, '05-synthetic-tenant-mcp.png'),
    fullPage: true,
  });
  checks.signedTenantPortal = {
    administratorManagement: 200,
    currentMemberDenied: 403,
    platformAndNeighborPathsDenied: 403,
    absentOrWrongPortalCookieDenied: 401,
    realMcpPage: true,
    cloudHistoryFlagOffStillVisible: true,
  };
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedHttp, []);
  checks.pageErrors = pageErrors;
  checks.serverErrors = failedHttp;
  checks.passed = true;
  console.info(`B4 UI acceptance passed; evidence: ${evidenceRoot}`);
} catch (error) {
  checks.passed = false;
  checks.error = error instanceof Error ? error.stack : String(error);
  console.error(checks.error);
  for (const context of browser?.contexts() ?? [])
    for (const [index, page] of context.pages().entries()) {
      await page
        .screenshot({
          path: join(evidenceRoot, `failure-${randomUUID()}-${index}.png`),
          fullPage: true,
        })
        .catch(() => {});
    }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  for (const attempt of attempts) {
    await backend.stop(attempt).catch(() => false);
    await backend.cleanup(attempt).catch(() => {});
  }
  await closeDatabase();
  if (schemaCreated) {
    assert.match(schema, /^b4_ui_[a-f0-9]{32}$/);
    await admin.unsafe(`drop schema ${schema} cascade`);
  }
  await admin.end();
  // Only this script's private generated storage is removed. Evidence stays.
  assert.equal(storageRoot, join(temporary, 'storage'));
  await rm(storageRoot, { recursive: true, force: true });
  await writeFile(
    join(evidenceRoot, 'result.json'),
    JSON.stringify(checks, null, 2),
  );
  await writeFile(join(evidenceRoot, 'server.log'), serverOutput);
  console.info(
    `Evidence retained at ${evidenceRoot}; private server stopped and schema removed.`,
  );
}
