/** Isolated real Chrome / built Next / PostgreSQL UI regression.
 * Synthetic persisted history, not a claim of real assistant/model execution.
 * Build Web first, then pnpm exec tsx scripts/acceptance/ui/p26-assistant-workbench.ts
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
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(join(root, 'package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
if (process.env.ALLRICE_P26_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P26_UI_ISOLATED: '1',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
        ALLRICE_TEST_CHROME:
          process.env.ALLRICE_TEST_CHROME ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit');
  process.exit(typeof code === 'number' ? code : 1);
}

const port = 3008,
  origin = `http://127.0.0.1:${port}`;
const base = 'postgres://a123@127.0.0.1:5432/allrice_b2';
const schema = `p26_ui_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(base);
databaseUrl.searchParams.set('options', `-csearch_path=${schema},public`);
const temporary = await mkdtemp(join(tmpdir(), 'allrice-p26-ui-'));
const evidenceRoot = join(temporary, 'evidence'),
  storageRoot = join(temporary, 'storage');
await mkdir(evidenceRoot, { mode: 0o700 });
const disabled = [
  'ALLRICE_LOCAL_COMMAND_ENABLED',
  'ALLRICE_RUNTIME_POLICY_ENABLED',
  'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
  'ALLRICE_BRIDGE_WSS_ENABLED',
  'ALLRICE_CLOUD_MCP_ENABLED',
  'ALLRICE_CLOUD_RUNNER_ENABLED',
  'ALLRICE_CHANGESET_ENABLED',
  'ALLRICE_LOCAL_SERVICE_ENABLED',
  'ALLRICE_CHATFLOW_REALTIME_ENABLED',
  'ALLRICE_GEMINI_API_ENABLED',
  'ALLRICE_LOCAL_BROWSER_ENABLED',
  'ALLRICE_LOCAL_MCP_ENABLED',
];
Object.assign(
  process.env,
  Object.fromEntries(disabled.map((name) => [name, '0'])),
  {
    DATABASE_URL: databaseUrl.toString(),
    ALLRICE_WORKBENCH_ENABLED: '1',
    ALLRICE_ASSISTANTS_ENABLED: '1',
    ALLRICE_PORTAL_AUTH_ENABLED: '1',
    ALLRICE_LOCAL_PORTAL: 'snow',
    ALLRICE_PORTAL_SECURE_COOKIE: '0',
    ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
    ALLRICE_STORAGE_ROOT: storageRoot,
    ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
  },
);
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
const { assistantFixture } =
  await import('../../../packages/database/src/assistant-runtime.fixture.ts');
const { SessionModelSnapshotSchema } =
  await import('../../../packages/contracts/src/index.ts');
const { createPortalSession } =
  await import('../../../apps/web/lib/portal/session.ts');
const { resolvePortal } =
  await import('../../../apps/web/lib/portal/config.ts');
const admin = postgres(base, { max: 1, onnotice: () => {} }),
  db = getDatabase();
let schemaCreated = false,
  server: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Playwright.Page | undefined,
  serverOutput = '';
const pageErrors: string[] = [],
  consoleErrors: string[] = [];
const failedResponses: { path: string; status: number }[] = [];
let phase = 'setup';
const networkFailures: { phase: string; path: string; error: string | null }[] =
  [];
const consoleErrorPhases: { phase: string; message: string }[] = [];
const activeStreams = new Map<Playwright.Request, string>();
const streamRequests: { phase: string; runId: string }[] = [];
async function waitForStreamCount(runId: string, count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      [...activeStreams.values()].filter((id) => id === runId).length === count
    )
      return;
    await delay(100);
  }
  assert.equal(
    [...activeStreams.values()].filter((id) => id === runId).length,
    count,
    `${phase}: expected ${count} active SSE request(s) for ${runId}`,
  );
}
const checks: Record<string, unknown> = {
  scope:
    'Real isolated Chrome + built Next + synthetic signed portal + PostgreSQL. No mocked API, Worker/model execution, personal browser profile, Dev or Prod writes.',
  schema,
  origin,
  passed: false,
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
async function startServer(assistants: boolean) {
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
      env: {
        ...process.env,
        ALLRICE_ASSISTANTS_ENABLED: assistants ? '1' : '0',
      },
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
      if ((await fetch(`${origin}/login`)).status < 500) return;
    } catch {
      /* Starting. */
    }
    await delay(200);
  }
  throw Error('Private Web startup timed out');
}

try {
  checks.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  checks.trackedDiffDigest = createHash('sha256')
    .update(execFileSync('git', ['diff', '--binary'], { cwd: root }))
    .digest('hex');
  const sourceFiles = [
    'apps/web/app/chatflow/assistant-tree-card.tsx',
    'apps/web/app/chatflow/assistant-run-panel.tsx',
    'apps/web/app/chatflow/use-assistant-session.ts',
    'apps/web/app/chatflow/assistant-mode-control.tsx',
    'apps/web/app/chatflow/assistant-eligibility.ts',
    'apps/web/app/chatflow/chatflow-client.tsx',
    'apps/web/app/chatflow/use-run-stream.ts',
    'apps/web/app/chatflow/session-run-stream.ts',
    'apps/web/app/chatflow/use-session.ts',
    'apps/web/app/chatflow/session-selection.ts',
    'apps/web/app/chatflow/session-actions.ts',
    'apps/web/app/chatflow/use-attachments.ts',
    'apps/web/app/api/v1/runtime/assistants/route.ts',
    'packages/database/src/assistant-runtime.ts',
    'scripts/acceptance/ui/p26-assistant-workbench.ts',
  ];
  checks.sourceDigests = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
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
  const extensions =
    await admin`select extname from pg_extension where extname in ('vector','pg_trgm')`;
  assert.equal(
    extensions.length,
    2,
    'Dedicated test DB must already have required extensions',
  );
  await admin.unsafe(`create schema "${schema}"`);
  schemaCreated = true;
  for (const file of (await readdir(join(root, 'packages/database/migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await db.unsafe(
      await readFile(join(root, 'packages/database/migrations', file), 'utf8'),
    );
  const f = await assistantFixture(db);
  const { organizationId: org, workspaceId: workspace } = f.task.scope;
  const user = f.context.actor.id,
    run = f.task.runId;
  const [membership] =
    await db`select id from allrice_memberships where user_id=${user}`;
  f.context.memberships = [
    {
      id: membership!.id,
      organizationId: org,
      workspaceId: workspace,
      userId: user,
      role: 'admin',
      active: true,
    },
  ];
  const employee = await ensureDefaultEmployee(f.context, workspace);
  const [version] =
    await db`select provider_snapshot,employee_id from allrice_employee_versions where id=${employee.employeeVersionId}`;
  const session = f.task.chatSessionId!,
    otherSession = randomUUID(),
    um = randomUUID(),
    am = randomUUID();
  assert.ok(session);
  await db`update allrice_chat_sessions set title='P26 assistant history',employee_assignment_id=${employee.id},employee_version_id=${employee.employeeVersionId} where id=${session}`;
  await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
    values(${otherSession},${org},${workspace},${user},'P26 unrelated session',${employee.id},${employee.employeeVersionId})`;
  // Synthetic frozen Session models, not executable model approvals. Keep the
  // current employee/default untouched: history's Gemini protocol should win,
  // while the other Session's Codex protocol must disable the next-task toggle.
  const models = await db<
    {
      provider_key: string;
      auth_mode: string;
      connection_id: string;
      catalog_id: string;
      model: string;
    }[]
  >`select p.provider_key,p.auth_mode,c.id as connection_id,m.id as catalog_id,m.model
    from allrice_model_providers p join allrice_model_connections c on c.provider_id=p.id
    join allrice_model_catalog_entries m on m.provider_id=p.id
    where p.provider_key in ('codex','gemini') order by c.id,m.id`;
  for (const [sessionId, provider] of [
    [session, 'gemini'],
    [otherSession, 'codex'],
  ] as const) {
    const selected = models.find((model) => model.provider_key === provider);
    assert.ok(selected, `Synthetic migrated ${provider} catalog must exist`);
    const snapshot = SessionModelSnapshotSchema.parse({
      schemaVersion: 1,
      sessionId,
      employeeId: version!.employee_id,
      policyRevision: 1,
      connectionId: selected.connection_id,
      modelCatalogEntryId: selected.catalog_id,
      harness: 'dsh',
      provider,
      authMode: selected.auth_mode,
      model: selected.model,
      reasoningEffort: 'low',
      credentialReference: 'deployment:p26-synthetic-never-resolved',
      baseUrl: null,
      fallbackPolicy: 'disabled',
      fallbackTargets: [],
      frozenAt: new Date().toISOString(),
    });
    await db`insert into allrice_session_model_snapshots(session_id,organization_id,workspace_id,employee_id,policy_revision,connection_id,model_catalog_entry_id,snapshot)
      values(${sessionId},${org},${workspace},${version!.employee_id},1,${selected.connection_id},${selected.catalog_id},${db.json(snapshot)})`;
  }
  await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,completed_at)
    values(${um},${org},${workspace},${session},${user},'user',${db.json({ text: 'Synthetic assistant UI inspection', citations: [] })},now()),
    (${am},${org},${workspace},${session},${user},'assistant',${db.json({ text: 'Synthetic persisted reply. No real model execution.', citations: [] })},now())`;
  await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,status,provider_snapshot,prompt_snapshot)
    values(${run},${org},${workspace},${user},${employee.id},${employee.employeeVersionId},${session},${um},${am},'running',${db.json(version!.provider_snapshot)},${db.json({ systemPrompt: 'Synthetic UI only', conversation: [], memories: [], userRequest: 'Synthetic UI only' })})`;
  const partial = (await f.delegate({ label: '合成资料助手' })).instance;
  const live = (await f.delegate({ label: '合成核验助手' })).instance;
  const deliveryId = randomUUID();
  // Deliberately seed historical terminal/result rows: this tests rendering, not admission/evidence validation.
  await db`update allrice_assistant_instances set status='partial',stopped_at=now() where run_id=${partial.runId}`;
  await db`update allrice_assistant_instances set status='running' where run_id=${live.runId}`;
  await db`insert into allrice_assistant_results(delivery_id,run_id,root_run_id,payload,payload_digest)
    values(${deliveryId},${partial.runId},${run},${db.json({ deliveryId, status: 'partial', summary: '<script>not executable</script> 合成资料摘要', evidence: [], incomplete: ['缺少第二份资料'], usageComplete: false })},${`sha256:${'a'.repeat(64)}`})`;
  await startServer(true);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ALLRICE_TEST_CHROME,
  });
  const browserContext = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const login = await createSession(user);
  await browserContext.addCookies([
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
        subject: 'synthetic-p26-ui',
        organizationId: org,
        workspaceId: workspace,
      }).value,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  await browserContext.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  page = await browserContext.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
      consoleErrorPhases.push({ phase, message: message.text() });
    }
  });
  page.on('requestfailed', (request) => {
    activeStreams.delete(request);
    networkFailures.push({
      phase,
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? null,
    });
  });
  page.on('requestfinished', (request) => activeStreams.delete(request));
  page.on('request', (request) => {
    const url = new URL(request.url());
    const runId = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname)?.[1];
    if (runId && url.searchParams.get('format') !== 'json') {
      activeStreams.set(request, runId);
      streamRequests.push({ phase, runId });
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  phase = 'enabled-history';
  await page.goto(`${origin}/chatflow?session=${session}`);
  const panel = page.locator(`#assistants-${run}`);
  await panel.waitFor();
  await panel.getByRole('status').filter({ hasText: '合成资料助手' }).waitFor();
  assert.equal(
    await panel.locator('details').first().getAttribute('open'),
    null,
    'Initially collapsed without hiding warnings',
  );
  assert.equal(
    await page.getByRole('combobox', { name: '下一项任务模式' }).inputValue(),
    'daily',
  );
  assert.equal(
    await page.locator('option[value=boost]').getAttribute('disabled'),
    '',
  );
  assert.equal(
    await page.locator('option[value=teamwork]').getAttribute('disabled'),
    '',
  );
  const optOut = page.getByRole('checkbox', { name: '本次不使用助手' });
  assert.equal(
    await optOut.isDisabled(),
    false,
    'Synthetic frozen Gemini protocol and employee delegation are both required',
  );
  await optOut.check();
  assert.equal(await optOut.isChecked(), true);
  const [frozen] =
    await db`select configuration from allrice_assistant_roots where root_run_id=${run}`;
  assert.equal(
    frozen!.configuration.allowAssistants,
    true,
    'Next-task selection never rewrites a running root',
  );
  await panel.locator('summary').first().click();
  await panel.getByText('未完成：缺少第二份资料', { exact: true }).waitFor();
  await panel
    .getByText('<script>not executable</script> 合成资料摘要', { exact: true })
    .waitFor();
  assert.equal(await panel.locator('script').count(), 0);
  assert.match(await panel.innerText(), /主 Rice 尚未确认采用/);
  const liveRow = panel
    .locator('li')
    .filter({ has: page.getByText('合成核验助手', { exact: true }) });
  const stopResponse = page.waitForResponse(
    (r) =>
      r.url().includes('/runtime/assistants?') &&
      r.request().method() === 'POST',
  );
  await liveRow
    .getByRole('button', { name: '停止这个助手', exact: true })
    .click();
  assert.equal((await stopResponse).status(), 202);
  await panel
    .getByText(
      '已请求停止不代表进程已退出；等待执行端确认。已经发生的外部动作不一定能撤回。',
      { exact: true },
    )
    .waitFor();
  const [stopping] =
    await db`select cancel_requested_at,stopped_at from allrice_assistant_instances where run_id=${live.runId}`;
  assert.ok(stopping!.cancel_requested_at);
  assert.equal(stopping!.stopped_at, null);
  await page.reload();
  await panel
    .getByText(
      '已请求停止不代表进程已退出；等待执行端确认。已经发生的外部动作不一定能撤回。',
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: join(evidenceRoot, 'desktop.png'),
    fullPage: true,
  });
  // Restore allow=true before changing Sessions, so the Codex request assertion
  // catches a stale/default preference even if its disabled checkbox looks safe.
  await optOut.uncheck();
  assert.equal(await optOut.isChecked(), false);
  phase = 'codex-queue';
  await page.getByRole('button', { name: /P26 unrelated session/ }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(
    await optOut.isDisabled(),
    true,
    'Frozen Codex cannot offer assistants',
  );
  assert.equal(await optOut.isChecked(), true);
  await page
    .getByText('当前模型暂不支持助手，由 Rice 独立处理。', { exact: true })
    .waitFor();
  const codexMessage = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/sessions/${otherSession}/messages` &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('textbox', { name: '给 Rice 的消息' })
    .fill('P26 synthetic Codex ordinary question. No Worker is running.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const queuedResponse = await codexMessage;
  assert.equal(queuedResponse.status(), 202);
  assert.deepEqual(
    queuedResponse.request().postDataJSON().assistantPreference,
    {
      mode: 'daily',
      allowAssistants: false,
    },
  );
  const queued = await queuedResponse.json();
  const [queuedBinding] = await db`
    select r.input,e.provider_snapshot,e.execution_snapshot,s.snapshot,j.status,j.worker_id
    from allrice_runs r join allrice_employee_runs e on e.run_id=r.id
    join allrice_jobs j on j.run_id=r.id
    join allrice_session_model_snapshots s on s.session_id=e.session_id
    where r.id=${queued.run.id} and r.organization_id=${org} and e.session_id=${otherSession}`;
  assert.ok(queuedBinding);
  assert.equal(
    queuedBinding.input.assistantConfiguration.allowAssistants,
    false,
  );
  assert.equal(queuedBinding.provider_snapshot.route, 'openai-codex');
  assert.equal(
    queuedBinding.execution_snapshot.modelSnapshot.connectionId,
    queuedBinding.snapshot.connectionId,
  );
  assert.equal(
    queuedBinding.execution_snapshot.modelSnapshot.modelCatalogEntryId,
    queuedBinding.snapshot.modelCatalogEntryId,
  );
  assert.equal(queuedBinding.status, 'queued');
  assert.equal(queuedBinding.worker_id, null);
  checks.codexQueueOnly = {
    runId: queued.run.id,
    requestAllowsAssistants: false,
    frozenAllowsAssistants: false,
    frozenProviderUnchanged: true,
    noWorkerStarted: true,
  };
  const stopCurrentRun = page.getByRole('button', {
    name: '停止本轮',
    exact: true,
  });
  await stopCurrentRun.waitFor();
  await waitForStreamCount(queued.run.id, 1);
  phase = 'return-gemini';
  await page.getByRole('button', { name: /P26 assistant history/ }).click();
  await panel.waitFor();
  await stopCurrentRun.waitFor({ state: 'detached' });
  await waitForStreamCount(queued.run.id, 0);
  const requestsAfterSwitch = streamRequests.length;
  await delay(1200);
  assert.equal(
    streamRequests.length,
    requestsAfterSwitch,
    'Completed Gemini history must not restart an old Codex SSE',
  );
  assert.equal(
    await optOut.isDisabled(),
    false,
    'Frozen Gemini becomes available again without switching any model',
  );
  phase = 'restore-codex-pending';
  await page.getByRole('button', { name: /P26 unrelated session/ }).click();
  await panel.waitFor({ state: 'detached' });
  await stopCurrentRun.waitFor();
  await waitForStreamCount(queued.run.id, 1);
  phase = 'return-gemini-again';
  await page.getByRole('button', { name: /P26 assistant history/ }).click();
  await panel.waitFor();
  await stopCurrentRun.waitFor({ state: 'detached' });
  await waitForStreamCount(queued.run.id, 0);
  checks.streamIsolation = {
    currentCodexPendingStreamVisible: true,
    completedGeminiDoesNotShowStop: true,
    oldCodexStreamAbortedWithoutRestart: true,
    returningCodexRestoresPendingStream: true,
    leavingCodexAgainAbortsStream: true,
  };
  phase = 'narrow-history';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const rail = document.querySelector('main > aside');
    return rail !== null && rail.getBoundingClientRect().width <= 58;
  });
  await panel.scrollIntoViewIfNeeded();
  await panel.getByRole('status').first().waitFor();
  const narrowBox = await panel.boundingBox();
  assert.ok(
    narrowBox && narrowBox.width >= 220 && narrowBox.x + narrowBox.width <= 391,
    'Assistant card remains legible within the narrow viewport',
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(evidenceRoot, 'narrow.png'),
    fullPage: true,
  });
  checks.enabled = {
    collapsedWarnings: true,
    detailReadsRealApi: true,
    safePlainText: true,
    futureModesDisabled: true,
    nextPreferenceDoesNotRewriteRoot: true,
    cancellationRequestNotExit: true,
    refreshRetainsState: true,
    sessionIsolation: true,
    frozenGeminiProtocolEligible: true,
    frozenCodexProtocolDisabled: true,
    narrowRendered: true,
  };
  // Flag-OFF is a separate startup check, not an outage/reconnect acceptance.
  // Session/SSE isolation must have passed above before ending this page normally.
  await page.goto('about:blank');
  phase = 'planned-server-restart';
  await stopServer();
  await startServer(false);
  phase = 'flag-off';
  await page.goto(`${origin}/chatflow?session=${session}`);
  await panel.waitFor();
  assert.equal(
    await page.getByRole('combobox', { name: '下一项任务模式' }).count(),
    0,
  );
  const rootStop = page.waitForResponse(
    (r) =>
      r.url().includes('/runtime/assistants?') &&
      r.request().method() === 'POST',
  );
  await panel
    .getByRole('button', { name: '取消整项任务（含所有助手）' })
    .click();
  assert.equal((await rootStop).status(), 202);
  const response = await page.request.get(
    `${origin}/api/v1/runtime/assistants?workspaceId=${workspace}&runId=${run}`,
  );
  assert.equal(response.status(), 200);
  assert.match(response.headers()['cache-control'] ?? '', /no-store/);
  assert.equal((await response.json()).tree.cancelRequested, true);
  checks.flagOff = {
    historicalTreeVisible: true,
    modeControlHidden: true,
    rootCancelAccepted: true,
  };
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(consoleErrors, []);
  checks.passed = true;
} catch (error) {
  checks.error = error instanceof Error ? error.stack : String(error);
  await page
    ?.screenshot({ path: join(evidenceRoot, 'failure.png'), fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  await closeDatabase();
  if (schemaCreated) {
    assert.match(schema, /^p26_ui_[a-f0-9]{32}$/);
    await admin.unsafe(`drop schema "${schema}" cascade`);
  }
  await admin.end({ timeout: 5 });
  assert.ok(storageRoot.startsWith(temporary + '/'));
  await rm(storageRoot, { force: true, recursive: true });
  checks.pageErrors = pageErrors;
  checks.consoleErrors = consoleErrors;
  checks.consoleErrorPhases = consoleErrorPhases;
  checks.networkFailures = networkFailures;
  checks.streamRequests = streamRequests;
  checks.failedResponses = failedResponses;
  checks.completedAt = new Date().toISOString();
  await writeFile(
    join(evidenceRoot, 'checks.json'),
    JSON.stringify(checks, null, 2),
    { mode: 0o600 },
  );
  await writeFile(join(evidenceRoot, 'server.log'), serverOutput, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      { passed: checks.passed, evidenceRoot, error: checks.error ?? null },
      null,
      2,
    ),
  );
}
