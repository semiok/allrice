/** Private Chrome + authentic session issuer/HTTP/PG + real cloud browser I/O.
 * Synthetic account/session fixture (not a password-login test), no model call,
 * no shared Dev flags, no personal browser profile. Requires an owned live HTTPS fixture. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
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
import type { BrowserWorkspaceView } from '../../../packages/database/src/browser-control.ts';
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  rr = createRequire(join(root, 'package.json')),
  wr = createRequire(join(root, 'apps/worker/package.json')),
  webRequire = createRequire(join(root, 'apps/web/package.json'));
if (process.env.ALLRICE_P21_UI_ISOLATED !== '1') {
  if (!process.env.ALLRICE_BROWSER_FIXTURE_STATE)
    throw Error('OWNED_FIXTURE_STATE_REQUIRED');
  const child = spawn(
    process.execPath,
    ['--import', rr.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P21_UI_ISOLATED: '1',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
        ALLRICE_BROWSER_FIXTURE_STATE:
          process.env.ALLRICE_BROWSER_FIXTURE_STATE,
        ALLRICE_MANAGED_BROWSER_EXECUTABLE:
          process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit');
  process.exit(typeof code === 'number' ? code : 1);
}
const statePath = process.env.ALLRICE_BROWSER_FIXTURE_STATE!;
const fixtureState = async () =>
  JSON.parse(await readFile(statePath, 'utf8')) as {
    endpoint: string;
    logins: number;
    uploads: number;
    downloads: number;
    stoppedAt: string | null;
  };
const start = await fixtureState(),
  site = new URL(start.endpoint);
assert.equal(start.stoppedAt, null);
assert.equal(site.protocol, 'https:');
assert.match(site.hostname, /^[a-z-]+\.trycloudflare\.com$/);
const port = 3021,
  origin = `http://127.0.0.1:${port}`,
  base = 'postgres://a123@127.0.0.1:5432/allrice_b2',
  schema = `p21_ui_${randomUUID().replaceAll('-', '')}`,
  url = new URL(base),
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'allrice-p21-ui-')));
url.searchParams.set('options', `-csearch_path=${schema},public`);
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ALLRICE_BROWSER_CONTROL_ENABLED: '1',
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
const { createBrowserWorkspace, createBrowserOperation, recordBrowserStopped } =
  await import('../../../packages/database/src/browser-control.ts');
const { startBrowserWorkspaceController } =
  await import('../../../apps/worker/src/browser-control/controller.ts');
const { appendJobEvent } =
  await import('../../../packages/database/src/execution/queue.ts');
const db = getDatabase(),
  admin = postgres(base, { max: 1, onnotice: () => {} }),
  abort = new AbortController();
let server: ChildProcess | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  controller: ReturnType<typeof startBrowserWorkspaceController> | undefined,
  schemaCreated = false,
  serverOutput = '';
const errors: string[] = [],
  checks: Record<string, unknown> = {
    scope:
      'synthetic account/session issuer + real private Chrome UI, HTTP, PG and production pinned cloud Chromium; no model/password-login/Dev/real user profile',
    schema,
    origin,
    passed: false,
  };
const deadline = setTimeout(() => {
  abort.abort();
  void browser?.close();
  server?.kill('SIGTERM');
}, 240000);
async function waitFor(
  check: () => Promise<boolean>,
  name: string,
  ms = 20000,
) {
  const until = Date.now() + ms;
  while (Date.now() < until && !abort.signal.aborted) {
    if (await check()) return;
    await delay(100);
  }
  throw Error('WAIT_' + name);
}
async function actor(userId: string, org: string, workspace: string) {
  const session = await createSession(userId),
    context = await browser!.newContext({
      viewport: { width: 1440, height: 1100 },
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
        subject: userId,
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
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).origin === origin) {
      const records = (checks.httpMutations ??= []) as unknown[];
      records.push({ path: new URL(r.url()).pathname, status: r.status() });
    }
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
    serverOutput = (serverOutput + b.toString()).slice(-200000);
  });
  server.stderr?.on('data', (b) => {
    serverOutput = (serverOutput + b.toString()).slice(-200000);
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
    { browserControl: true },
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE,
    chromiumSandbox: true,
  });
  const { page, context } = await actor(f.user, f.org, f.workspace);
  await page.goto(origin + '/workspace/browser');
  const settings = page.getByRole('region', { name: '云端浏览器授权管理' });
  await settings.getByLabel(/^执行目标/).selectOption(f.target);
  await settings.getByLabel(/^授权使用者/).selectOption(f.user);
  await settings
    .getByLabel('允许站点（每行一个精确 HTTPS origin）', { exact: true })
    .fill(site.origin);
  await settings
    .getByLabel('允许上传文件（每次仍须审批）', { exact: true })
    .check();
  await settings.getByLabel('允许下载工件', { exact: true }).check();
  await settings
    .getByLabel('允许人工敏感登录（短期加密输入）', { exact: true })
    .check();
  await settings
    .getByRole('button', { name: '创建精确站点授权', exact: true })
    .click();
  await settings.getByRole('article', { name: '云端浏览器授权记录' }).waitFor();
  await page.reload();
  await settings
    .getByRole('button', { name: '撤销授权', exact: true })
    .waitFor();
  assert.equal((await db`select id from allrice_browser_workspaces`).length, 0);
  checks.grantCreatedByNativeUiWithoutStarting = true;
  await page.screenshot({
    path: join(temporary, '01-grant.png'),
    fullPage: true,
  });
  const [job] = await db<
    { attempt: number; lease_token: string }[]
  >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
  const callId = randomUUID(),
    w = await createBrowserWorkspace({
      context: f.execution,
      callId,
      url: start.endpoint,
      jobAttempt: job!.attempt,
      jobLeaseToken: job!.lease_token,
    });
  await appendJobEvent({
    workerId: f.worker,
    jobId: f.execution.jobId,
    leaseToken: job!.lease_token,
    type: 'tool.started',
    payload: {
      toolCallId: callId,
      name: 'browser.workspace',
      label: 'browser.workspace',
    },
  });
  controller = startBrowserWorkspaceController(w, {
    storage: f.storage,
    signal: abort.signal,
  });
  const views = async () => {
    const r = await context.request.get(
      `${origin}/api/v1/runtime/browser-workspaces?workspaceId=${f.workspace}&runId=${f.run}`,
    );
    assert.equal(r.status(), 200);
    return (await r.json()).workspaces as BrowserWorkspaceView[];
  };
  await waitFor(
    async () => (await views())[0]?.state === 'agent',
    'CONTROLLER',
  );
  const initialOp = await createBrowserOperation(
    f.context,
    {
      version: 1,
      workspaceId: w.id,
      profileId: w.profile_id,
      actor: 'agent',
      fence: 1,
      observationId: null,
      action: { type: 'navigate', url: start.endpoint },
    },
    randomUUID(),
  );
  const stranger = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${stranger},${`${stranger}@example.test`},'Other synthetic','not-login')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${stranger},'admin')`;
  const other = await actor(stranger, f.org, f.workspace);
  assert.equal(
    (
      await other.context.request.get(
        `${origin}/api/v1/runtime/browser-workspaces?workspaceId=${f.workspace}&runId=${f.run}`,
      )
    ).status(),
    403,
  );
  await other.context.close();
  checks.ownerIsolation = true;
  await page.goto(`${origin}/chatflow?session=${f.session}`);
  const panel = page.getByRole('region', { name: '受控浏览器工作台' });
  async function approve(id: string) {
    const card = page.locator(`#browser-operation-${id}`);
    await card
      .getByRole('button', { name: '批准本次操作', exact: true })
      .waitFor();
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/api/v1/runtime/approvals/'),
    );
    await card
      .getByRole('button', { name: '批准本次操作', exact: true })
      .click();
    const r = await response;
    assert.equal(r.status(), 200);
    await r.body();
  }
  const initialId = initialOp.snapshot.binding.attempt.operationId;
  await page.locator(`#browser-operation-${initialId}`).waitFor();
  await page.reload();
  await approve(initialId);
  await waitFor(
    async () =>
      Boolean(
        (await views())[0]!.observation?.elements.some((e) => e.sensitive),
      ),
    'LOGIN_OBSERVATION',
  );
  checks.navigateApprovalSurvivesRefresh = true;
  await panel.getByRole('button', { name: '人工接管', exact: true }).click();
  await panel.getByText('人工独占控制', { exact: true }).waitFor();
  await panel.getByText('页面观察与控件', { exact: true }).click();
  async function submitField(label: string, value: string, sensitive = false) {
    const before = new Set(
      (await views())[0]!.operations.map(
        (o) => o.snapshot.binding.attempt.operationId,
      ),
    );
    const form = panel
      .locator('form')
      .filter({ has: page.getByLabel(new RegExp(label)) });
    await form.locator('input[name=value]').fill(value);
    await form
      .getByRole('button', {
        name: sensitive ? '安全输入（不发送给模型）' : '填写',
        exact: true,
      })
      .click();
    let id = '';
    await waitFor(async () => {
      id =
        (await views())[0]!.operations.find(
          (o) => !before.has(o.snapshot.binding.attempt.operationId),
        )?.snapshot.binding.attempt.operationId ?? '';
      return !!id;
    }, 'FIELD_PROPOSAL');
    await approve(id);
    await waitFor(async () => {
      const state = (await views())[0]!;
      return (
        state.operations.find(
          (o) => o.snapshot.binding.attempt.operationId === id,
        )?.snapshot.status === 'succeeded'
      );
    }, 'FIELD_DONE');
    // UI refresh is a one-second poll; wait for its fresh observation before entering another field.
    await delay(1200);
    return id;
  }
  await submitField('Username', 'P21-synthetic');
  const sensitiveId = await submitField(
    'Password',
    'P21-Synthetic-Password',
    true,
  );
  assert(!JSON.stringify(await views()).includes('P21-Synthetic-Password'));
  const inputs =
    await db`select envelope,consumed_at from allrice_browser_direct_inputs`;
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.envelope, null);
  assert(inputs[0]!.consumed_at);
  checks.directInputConsumedWithoutPlaintext = true;
  const beforeClick = new Set(
    (await views())[0]!.operations.map(
      (o) => o.snapshot.binding.attempt.operationId,
    ),
  );
  await panel
    .locator('form')
    .filter({ hasText: 'Sign in' })
    .getByRole('button', { name: '点击', exact: true })
    .click();
  let clickId = '';
  await waitFor(async () => {
    clickId =
      (await views())[0]!.operations.find(
        (o) =>
          !beforeClick.has(o.snapshot.binding.attempt.operationId) &&
          o.command.action.type === 'click',
      )?.snapshot.binding.attempt.operationId ?? '';
    return !!clickId;
  }, 'CLICK');
  await approve(clickId);
  let requestId = '';
  await waitFor(async () => {
    requestId =
      (await views())[0]!.operations.find(
        (o) => o.command.action.type === 'request',
      )?.snapshot.binding.attempt.operationId ?? '';
    return !!requestId;
  }, 'NETWORK_APPROVAL');
  assert.equal((await fixtureState()).logins, start.logins);
  await page.reload();
  await approve(requestId);
  await waitFor(
    async () =>
      Boolean(
        (await views())[0]!.observation?.text.includes(
          'Signed in: P21 synthetic',
        ),
      ),
    'REAL_LOGIN',
  );
  assert.equal((await fixtureState()).logins, start.logins + 1);
  checks.realLoginViaExactPost = { sensitiveId, clickId, requestId };
  await panel.getByText('页面观察与控件', { exact: true }).click();
  async function propose(type: string, submit: () => Promise<void>) {
    const prior = new Set(
      (await views())[0]!.operations.map(
        (o) => o.snapshot.binding.attempt.operationId,
      ),
    );
    await submit();
    let id = '';
    await waitFor(async () => {
      id =
        (await views())[0]!.operations.find(
          (o) =>
            o.command.action.type === type &&
            !prior.has(o.snapshot.binding.attempt.operationId),
        )?.snapshot.binding.attempt.operationId ?? '';
      return !!id;
    }, 'NATIVE_' + type.toUpperCase());
    return id;
  }
  async function settled(id: string) {
    await waitFor(
      async () =>
        (await views())[0]!.operations.find(
          (o) => o.snapshot.binding.attempt.operationId === id,
        )?.snapshot.status === 'succeeded',
      'SETTLED',
    );
    await delay(1200);
  }
  const uploadForm = panel
    .locator('form')
    .filter({ has: page.locator('input[type=file]') });
  const uploadId = await propose('upload', async () => {
    await uploadForm.locator('input[type=file]').setInputFiles({
      name: 'p21-synthetic.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('P21-synthetic-upload'),
    });
    await uploadForm
      .getByRole('button', { name: '上传到此站点（需审批）', exact: true })
      .click();
  });
  assert.equal((await fixtureState()).uploads, start.uploads);
  await approve(uploadId);
  await settled(uploadId);
  const submitUploadId = await propose('click', () =>
    panel
      .locator('form')
      .filter({ hasText: 'Upload synthetic file' })
      .getByRole('button', { name: '点击', exact: true })
      .click(),
  );
  await approve(submitUploadId);
  let uploadRequestId = '';
  await waitFor(async () => {
    uploadRequestId =
      (await views())[0]!.operations.find(
        (o) =>
          o.command.action.type === 'request' &&
          o.command.action.parentOperationId === submitUploadId,
      )?.snapshot.binding.attempt.operationId ?? '';
    return !!uploadRequestId;
  }, 'UPLOAD_POST');
  assert.equal((await fixtureState()).uploads, start.uploads);
  await approve(uploadRequestId);
  await settled(submitUploadId);
  assert.equal((await fixtureState()).uploads, start.uploads + 1);
  const downloadId = await propose('download', () =>
    panel
      .locator('form')
      .filter({ hasText: 'Download synthetic file' })
      .getByRole('button', { name: '下载到工件', exact: true })
      .click(),
  );
  assert.equal((await fixtureState()).downloads, start.downloads);
  await approve(downloadId);
  await settled(downloadId);
  assert.equal((await fixtureState()).downloads, start.downloads + 1);
  const download = page.waitForEvent('download');
  await page
    .locator(`#browser-operation-${downloadId}`)
    .getByRole('button', { name: '保存已交付文件', exact: true })
    .click();
  const delivered = await download,
    deliveredPath = await delivered.path();
  assert(deliveredPath);
  assert.equal(await readFile(deliveredPath, 'utf8'), 'P21-synthetic-download');
  checks.nativeUploadAndDeliveredDownload = {
    uploadId,
    submitUploadId,
    uploadRequestId,
    downloadId,
  };
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  await panel.getByText('已暂停输入', { exact: true }).waitFor();
  assert.equal(
    await panel
      .getByRole('button', { name: '交还 Rice', exact: true })
      .isEnabled(),
    true,
  );
  await panel.getByRole('button', { name: '交还 Rice', exact: true }).click();
  await panel.getByText('Rice 控制中', { exact: true }).waitFor();
  checks.pausedResume = true;
  const current = (await views())[0]!;
  const deniedOp = await createBrowserOperation(
    f.context,
    {
      version: 1,
      workspaceId: w.id,
      profileId: w.profile_id,
      actor: 'agent',
      fence: current.fence,
      observationId: current.observation!.id,
      action: {
        type: 'click',
        elementId: current.observation!.elements.find(
          (e) => e.tag === 'button',
        )!.id,
      },
    },
    randomUUID(),
  );
  const approval = (await views())[0]!.operations.find(
    (o) =>
      o.snapshot.binding.attempt.operationId ===
      deniedOp.snapshot.binding.attempt.operationId,
  )!.approval!.request;
  await page.goto(origin + '/workspace/browser');
  await settings.getByRole('button', { name: '撤销授权', exact: true }).click();
  await settings.getByText('授权已撤销', { exact: true }).waitFor();
  const rejected = await context.request.post(
    `${origin}/api/v1/runtime/approvals/${approval.approvalId}`,
    {
      headers: { origin, 'x-allrice-workspace-id': f.workspace },
      data: {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: approval.requestId,
        version: approval.version,
        requestDigest: approval.requestDigest,
        task: approval.task,
        responseId: randomUUID(),
        respondedBy: approval.respondentId,
        respondedAt: new Date().toISOString(),
        approvalId: approval.approvalId,
        decision: 'approved',
      },
    },
  );
  assert.equal(rejected.status(), 403);
  await rejected.body();
  await controller.closed;
  await page.goto(`${origin}/chatflow?session=${f.session}`);
  await panel.getByText('浏览器已确认关闭', { exact: true }).waitFor();
  const final = (await views())[0]!;
  assert.equal(final.state, 'closed');
  assert(final.stoppedAt);
  assert.equal(final.available, false);
  assert.equal(
    await panel
      .getByRole('button', { name: '批准本次操作', exact: true })
      .count(),
    0,
  );
  assert.equal(
    final.operations.find(
      (o) =>
        o.snapshot.binding.attempt.operationId ===
        deniedOp.snapshot.binding.attempt.operationId,
    )!.approval!.revokedAt,
    null,
  );
  assert.equal((await fixtureState()).logins, start.logins + 1);
  checks.revokedUiOldApprovalDeniedAndPhysicalStop = true;
  await page.screenshot({
    path: join(temporary, '02-final.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(temporary, '03-narrow.png'),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  checks.narrowNoOverflow = true;
  assert.deepEqual(errors, []);
  checks.passed = true;
} catch (error) {
  if (schemaCreated) {
    checks.browserStates =
      await db`select id,state,desired_control,control_fence,acknowledged_fence,stopped_at from allrice_browser_workspaces`.catch(
        () => [],
      );
    checks.tasks =
      await db`select id,status,error_code from allrice_managed_browser_tasks`.catch(
        () => [],
      );
    checks.controllerReasons =
      await db`select reason,metadata from allrice_audit_events where action='browser.controller.closed'`.catch(
        () => [],
      );
    checks.operations =
      await db`select i.operation_id,i.payload->'action'->>'type' as action,i.result,o.snapshot->>'status' as status from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id`.catch(
        () => [],
      );
  }
  checks.error = error instanceof Error ? error.stack : String(error);
  checks.errors = errors;
  for (const [i, p] of (
    browser?.contexts().flatMap((c) => c.pages()) ?? []
  ).entries())
    await p
      .screenshot({ path: join(temporary, `failure-${i}.png`), fullPage: true })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  abort.abort();
  await controller?.closed.catch(() => {});
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await once(server, 'exit');
    }
  }
  if (schemaCreated) {
    const pending =
      await db`select id,worker_id,job_lease_token from allrice_browser_workspaces where stopped_at is null`;
    for (const row of pending)
      await recordBrowserStopped(
        row.id,
        row.worker_id,
        row.job_lease_token,
        false,
      ).catch(() => {});
  }
  await closeDatabase();
  if (schemaCreated) {
    assert.match(schema, /^p21_ui_[a-f0-9]{32}$/);
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
