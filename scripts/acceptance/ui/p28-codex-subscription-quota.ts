/** Real Chrome + built Next + isolated PostgreSQL, synthetic UI observations
 * only. No account/model call, personal browser profile, mocked API or release.
 * Run: env -u DATABASE_URL pnpm exec tsx scripts/acceptance/ui/p28-codex-subscription-quota.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(join(root, 'package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const base = 'postgres://a123@127.0.0.1:5432/allrice_b2';
if (process.env.ALLRICE_P28_QUOTA_UI_ISOLATED !== '1') {
  assert.equal(
    process.env.DATABASE_URL,
    undefined,
    'Unset ambient DATABASE_URL first',
  );
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
        ALLRICE_P28_QUOTA_UI_ISOLATED: '1',
        ALLRICE_TEST_DATABASE_URL: base,
        ALLRICE_RUN_DB_INTEGRATION: '1',
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
assert.equal(process.env.DATABASE_URL, undefined);
assert.equal(process.env.ALLRICE_TEST_DATABASE_URL, base);
const temporary = await mkdtemp(join(tmpdir(), 'allrice-p28-quota-ui-'));
const evidenceRoot = join(temporary, 'evidence');
const profileRoot = join(temporary, 'chrome-profile');
const storageRoot = join(temporary, 'storage');
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
  'ALLRICE_ASSISTANTS_ENABLED',
  'ALLRICE_BROWSER_CONTROL_ENABLED',
];
Object.assign(
  process.env,
  Object.fromEntries(disabled.map((name) => [name, '0'])),
  {
    ALLRICE_PORTAL_AUTH_ENABLED: '1',
    ALLRICE_LOCAL_PORTAL: 'runtime-console',
    ALLRICE_PORTAL_SECURE_COOKIE: '0',
    ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
    ALLRICE_STORAGE_ROOT: storageRoot,
    ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
  },
);
const { createP27CodexWorkerFixture } =
  await import('../runtime/p27-codex-worker-fixture.ts');
const {
  RouteDecisionSchema,
  resolveAssistantSubscriptionSnapshot,
  CodexSubscriptionQuotaSnapshotSchema,
} = await import('../../../packages/contracts/src/index.ts');
const { recordRouteDecision, completeRouteDecision } =
  await import('../../../packages/database/src/execution/route-decision.ts');
const { freezeRouteSubscriptionSnapshot } =
  await import('../../../packages/database/src/execution/route-subscription.ts');
const { createSession } =
  await import('../../../packages/database/src/identity.ts');
const { createPortalSession } =
  await import('../../../apps/web/lib/portal/session.ts');
const { resolvePortal } =
  await import('../../../apps/web/lib/portal/config.ts');
const { chromium } = workerRequire('playwright-core') as typeof Playwright;
let fixture:
  Awaited<ReturnType<typeof createP27CodexWorkerFixture>> | undefined;
let server: ChildProcess | undefined;
let context: Playwright.BrowserContext | undefined;
let page: Playwright.Page | undefined;
let origin = '',
  phase = 'setup',
  stopped = false;
let serverOutput = '';
const pageErrors: string[] = [],
  consoleErrors: string[] = [];
const failedResponses: { path: string; status: number }[] = [];
const externalRequests: string[] = [],
  mutationRequests: string[] = [];
const cases: { name: string; rendered: string; apiStatus: number }[] = [];
const contrast: {
  phase: string;
  text: string;
  color: string;
  background: number[];
  ratio: number;
}[] = [];
const checks: Record<string, unknown> = {
  scope:
    'Real private Chrome + existing built Next + random PostgreSQL schema; synthetic data only, no mocked API, account/model execution, personal profile, Dev/Prod or deployment.',
  passed: false,
  cases,
};
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopped = true;
    void page?.close().catch(() => {});
  });
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}
async function loadCase(name: string, quota: unknown) {
  phase = name;
  assert.equal(stopped, false, 'UI acceptance interrupted');
  const parsed =
    quota === null ? null : CodexSubscriptionQuotaSnapshotSchema.parse(quota);
  // Synthetic UI fixture mutation, deliberately not the monotonic probe writer:
  // each case is an independent persisted observation rendered by the real GET.
  await fixture!
    .db`insert into allrice_provider_status(provider,auth_mode,status,detail_code,checked_at,subscription_quota)
    values('codex','chatgpt_subscription','connected','synthetic_ui_only',now(),${parsed ? fixture!.db.json(parsed) : null})
    on conflict(provider) do update set status=excluded.status,detail_code=excluded.detail_code,
      subscription_quota=excluded.subscription_quota,checked_at=excluded.checked_at`;
  const api = page!.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/admin/providers/codex',
  );
  await page!.goto(`${origin}/runtime-console?view=governance`);
  const response = await api;
  assert.equal(response.status(), 200);
  const body = await response.json();
  assert.deepEqual(body.provider.quota, parsed);
  const card = page!
    .getByRole('region', { name: 'Codex 订阅额度', exact: true })
    .first();
  await card.waitFor();
  await page!
    .getByRole('heading', { name: '平台内部月度限制', exact: true })
    .waitFor();
  const rendered = await card.innerText();
  cases.push({ name, rendered, apiStatus: response.status() });
  return card;
}
async function observeContrast(card: Playwright.Locator) {
  // This fixed browser-only body deliberately remains a string: tsx's
  // keepNames transform injects Node-side __name helpers into nested callbacks.
  // No DOM/user text is interpolated or executed, and no Node object crosses.
  const readContrast = new Function(
    'element',
    String.raw`
    const rgba = (color) => {
      const parts = color.match(/[\d.]+/g)?.map(Number);
      if (!parts || (parts.length !== 3 && parts.length !== 4))
        throw Error('UI_CONTRAST_UNSUPPORTED_COLOR');
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const composite = (foreground, background) => foreground.slice(0, 3).map(
      (channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3])
    );
    const luminance = (channels) => {
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    return [...element.querySelectorAll('h3,h4,p,li span,li strong,li small')].map((node) => {
      const ancestors = [];
      for (let current = node; current; current = current.parentElement) ancestors.push(current);
      const background = ancestors.reverse().reduce(
        (previous, ancestor) => composite(rgba(getComputedStyle(ancestor).backgroundColor), previous),
        [255, 255, 255]
      );
      const color = getComputedStyle(node).color;
      const foreground = composite(rgba(color), background);
      const a = luminance(foreground), b = luminance(background);
      return {
        text: node.textContent?.trim().slice(0, 160) ?? '', color, background,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      };
    });
  `,
  ) as (
    element: SVGElement | HTMLElement,
  ) => { text: string; color: string; background: number[]; ratio: number }[];
  const observations = await card.evaluate(readContrast);
  contrast.push(...observations.map((value) => ({ phase, ...value })));
}
function measured(usedPercent = 70, minutes = 10_080) {
  const now = Date.now();
  return CodexSubscriptionQuotaSnapshotSchema.parse({
    source: 'codex_app_server',
    status: 'available',
    checkedAt: new Date(now).toISOString(),
    accountFingerprint: `sha256:${'a'.repeat(64)}`,
    detailCode: 'codex_quota_synthetic_ui',
    buckets: [
      {
        limitId: 'codex',
        limitReached: false,
        windows: [
          {
            slot: 'primary',
            status: 'unknown',
            usedPercent: null,
            windowDurationMins: null,
            resetsAt: null,
          },
          {
            slot: 'secondary',
            status: 'available',
            usedPercent,
            windowDurationMins: minutes,
            resetsAt: Math.floor(now / 1000) + 7200,
          },
        ],
      },
    ],
  });
}
try {
  checks.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  checks.buildId = (
    await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')
  ).trim();
  checks.scriptSha256 = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  checks.sourceDigests = Object.fromEntries(
    await Promise.all(
      [
        'apps/web/app/runtime-console/codex-subscription-quota.tsx',
        'apps/web/app/runtime-console/codex-subscription-quota.module.css',
        'apps/web/app/runtime-console/governance-console.tsx',
        'apps/web/app/api/v1/admin/providers/codex/route.ts',
        'packages/database/src/providers/status.ts',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ]),
    ),
  );
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  checks.origin = origin;
  fixture = await createP27CodexWorkerFixture();
  checks.schema = fixture.schema;
  process.env.ALLRICE_PLATFORM_ADMIN_EMAILS = `${fixture.ownerId}@example.test`;
  const task = await fixture.prepareOrdinaryTask(
    'Synthetic UI ledger observation, not model execution.',
  );
  const frozen = task.binding.executionSnapshot.modelSnapshot!;
  const decision = RouteDecisionSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    runId: task.runId,
    organizationId: fixture.organizationId,
    workspaceId: fixture.workspaceId,
    actorId: fixture.ownerId,
    employeeId: fixture.employeeId,
    inputChecksum: `sha256:${'b'.repeat(64)}`,
    candidates: [
      {
        id: 'direct:synthetic-ui',
        kind: 'direct',
        name: 'Synthetic UI only',
        bindingId: null,
        requiredCapabilities: ['model:invoke'],
        risk: 'low',
        requiresApproval: false,
        authorized: true,
        exclusionReason: null,
        score: 1,
      },
    ],
    selectedKind: 'direct',
    selectedCandidateId: 'direct:synthetic-ui',
    harness: 'dsh',
    provider: 'openai-codex',
    model: frozen.model,
    modelConnectionId: fixture.connectionId,
    modelCatalogEntryId: fixture.catalogId,
    modelPolicyRevision: frozen.policyRevision,
    generation: 1,
    attempt: 1,
    reasonCodes: ['direct_no_capability_match'],
    createdAt: new Date().toISOString(),
  });
  await recordRouteDecision(decision, fixture.db);
  const snapshot = resolveAssistantSubscriptionSnapshot({
    sessionId: task.sessionId,
    modelSnapshot: frozen,
    decision,
    providerSnapshot: {
      provider: 'dsh',
      route: 'openai-codex',
      authMode: 'platform_subscription',
      model: frozen.model,
      reasoningEffort: frozen.reasoningEffort,
      credentialReference: frozen.credentialReference!,
      baseUrl: null,
    },
  })!;
  await freezeRouteSubscriptionSnapshot(
    {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      decisionId: decision.id,
      snapshot,
    },
    fixture.db,
  );
  await completeRouteDecision(
    {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      outcome: {
        decisionId: decision.id,
        status: 'succeeded',
        inputTokens: 123,
        cachedInputTokens: 0,
        outputTokens: 45,
        costCents: null,
        usageComplete: true,
        cacheUsageKnown: false,
        completedAt: new Date().toISOString(),
        errorCode: null,
        failureCategory: null,
      },
    },
    fixture.db,
  );
  await fixture.db`insert into allrice_organization_model_quotas(organization_id,monthly_run_limit,monthly_token_limit,monthly_cost_limit_cents)
    values(${fixture.organizationId},987,654321,12345)`;
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
    { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [server.stdout, server.stderr])
    stream?.on('data', (chunk) => {
      serverOutput = (serverOutput + chunk.toString()).slice(-64_000);
    });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(stopped, false, 'UI acceptance interrupted');
    assert.equal(server.exitCode, null, 'Private Next exited before ready');
    try {
      if ((await fetch(`${origin}/login`)).status < 500) {
        ready = true;
        break;
      }
    } catch {
      /* Starting. */
    }
    await delay(200);
  }
  assert.ok(ready, 'Private Next startup timed out');
  context = await chromium.launchPersistentContext(profileRoot, {
    headless: true,
    executablePath: process.env.ALLRICE_TEST_CHROME,
    viewport: { width: 1440, height: 1100 },
    args: ['--disable-background-networking'],
  });
  const session = await createSession(fixture.ownerId);
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
        portal: resolvePortal('allrice-dsh.bplabs.xyz')!,
        subject: 'synthetic-p28-quota-ui',
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
      }).value,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  await context.route('**/*', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) {
      externalRequests.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      mutationRequests.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });

  let card = await loadCase(
    'weekly-70-used-30-remaining-primary-unknown',
    measured(),
  );
  assert.match(await card.innerText(), /7 天窗口（周额度）/);
  assert.match(await card.innerText(), /剩余 30%/);
  assert.match(await card.innerText(), /已用 70%/);
  assert.match(await card.innerText(), /时长未知的窗口[\s\S]*剩余额度未知/);
  assert.doesNotMatch(await card.innerText(), /剩余 70%|5 小时窗口/);
  const internal = page.locator('section').filter({
    has: page.getByRole('heading', { name: '平台内部月度限制', exact: true }),
  });
  assert.match(await internal.innerText(), /订阅用量/);
  assert.match(
    await internal.innerText(),
    /不适用按次 API 费用；订阅额度另行展示/,
  );
  assert.match(await internal.innerText(), /168/);
  assert.equal(
    await page.getByLabel('运行上限', { exact: true }).inputValue(),
    '987',
  );
  assert.equal(
    await page.getByLabel('Token 上限', { exact: true }).inputValue(),
    '654321',
  );
  assert.equal(
    await page
      .getByLabel('API 成本上限（分，订阅不适用）', { exact: true })
      .inputValue(),
    '12345',
  );
  assert.doesNotMatch(await internal.innerText(), /剩余 30%|0\.00/);
  await observeContrast(card);
  await page.screenshot({
    path: join(evidenceRoot, 'weekly-and-internal-quota.png'),
    fullPage: true,
  });

  card = await loadCase('dynamic-90-minute-window', measured(70, 90));
  assert.match(await card.innerText(), /90 分钟窗口/);
  assert.doesNotMatch(await card.innerText(), /7 天窗口|5 小时窗口/);

  card = await loadCase('100-percent-exhausted', measured(100));
  assert.match(await card.innerText(), /已耗尽/);
  assert.match(await card.innerText(), /已用 100%/);
  assert.doesNotMatch(await card.innerText(), /剩余 100%/);
  await observeContrast(card);

  const error = {
    ...measured(),
    status: 'error',
    detailCode: 'codex_quota_synthetic_error',
    buckets: [],
  };
  card = await loadCase('read-error-unknown-not-zero', error);
  assert.match(await card.innerText(), /暂时无法读取订阅额度，当前剩余未知/);
  assert.doesNotMatch(await card.innerText(), /剩余 \d+%|已耗尽/);

  card = await loadCase('stale-observation-not-live-allowance', {
    ...measured(),
    checkedAt: new Date(Date.now() - 301_000).toISOString(),
  });
  assert.match(await card.innerText(), /额度快照已过期，当前剩余未知/);
  assert.doesNotMatch(await card.innerText(), /剩余 \d+%/);

  const reset = measured(100);
  reset.buckets[0]!.windows[1].resetsAt = Math.floor(Date.now() / 1000) - 1;
  card = await loadCase('reset-passed-does-not-invent-refill', reset);
  assert.match(await card.innerText(), /已到上次重置时间[\s\S]*不视为已恢复/);
  assert.doesNotMatch(await card.innerText(), /剩余 \d+%|已耗尽/);

  card = await loadCase('missing-observation-unknown', null);
  assert.match(await card.innerText(), /尚未读取订阅额度，当前剩余未知/);
  assert.doesNotMatch(await card.innerText(), /剩余 \d+%/);

  card = await loadCase('narrow-weekly-card', measured());
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  assert.ok(
    box && box.width >= 220 && box.x >= 0 && box.x + box.width <= 391,
    'Quota card fits narrow screen',
  );
  await page.screenshot({
    path: join(evidenceRoot, 'narrow-weekly.png'),
    fullPage: true,
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(mutationRequests, []);
  phase = 'computed-text-contrast';
  assert.ok(contrast.length > 0);
  assert.deepEqual(
    contrast.filter((item) => item.ratio < 4.5),
    [],
    'Quota card text requires at least 4.5:1 computed contrast',
  );
  checks.passed = true;
} catch (error) {
  checks.error = error instanceof Error ? error.stack : String(error);
  checks.failurePhase = phase;
  await page
    ?.screenshot({ path: join(evidenceRoot, 'failure.png'), fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown> = {};
  try {
    await context?.close();
    cleanup.chromeClosed = true;
  } catch {
    cleanup.chromeClosed = false;
  }
  try {
    await stopServer();
    cleanup.nextStopped =
      !server || server.exitCode !== null || server.signalCode !== null;
  } catch {
    cleanup.nextStopped = false;
  }
  if (cleanup.chromeClosed && cleanup.nextStopped) {
    try {
      cleanup.database = await fixture?.close();
    } catch {
      cleanup.database = 'unconfirmed';
    }
    for (const path of [profileRoot, storageRoot]) {
      assert.ok(path.startsWith(`${temporary}/`));
      await rm(path, { force: true, recursive: true });
    }
    cleanup.privateProfileRemoved = await lstat(profileRoot).then(
      () => false,
      (error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return true;
        throw error;
      },
    );
  }
  if (
    !cleanup.chromeClosed ||
    !cleanup.nextStopped ||
    cleanup.database === 'unconfirmed' ||
    !cleanup.privateProfileRemoved
  ) {
    checks.passed = false;
    process.exitCode = 1;
  }
  Object.assign(checks, {
    cleanup,
    pageErrors,
    consoleErrors,
    failedResponses,
    externalRequests,
    mutationRequests,
    contrast,
    minimumTextContrast:
      contrast.length > 0
        ? Math.min(...contrast.map((item) => item.ratio))
        : null,
    serverLogSha256: createHash('sha256').update(serverOutput).digest('hex'),
    completedAt: new Date().toISOString(),
  });
  await writeFile(
    join(evidenceRoot, 'checks.json'),
    JSON.stringify(checks, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        passed: checks.passed,
        evidenceRoot,
        cases: cases.length,
        failurePhase: checks.failurePhase ?? null,
      },
      null,
      2,
    ),
  );
}
