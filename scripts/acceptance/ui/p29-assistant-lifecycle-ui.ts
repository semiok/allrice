/** MET140: real built Next/Chrome against a caller-owned isolated native fixture.
 * No model/provider startup here. Cancellation is acknowledged only by the
 * caller's real production-controller/native drain, never by SQL status edits.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import type { AssistantTreeView } from '../../../packages/database/src/assistant-runtime.ts';
import type { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const uuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
type Database = Awaited<
  ReturnType<typeof createAssistantFixtureDatabase>
>['db'];
export type LifecycleUiTask = {
  org: string;
  workspace: string;
  user: string;
  session: string;
  rootRunId: string;
};
export type LifecycleUiInput = {
  db: Database;
  databaseUrl: string;
  storageRoot: string;
  evidenceDirectory: string;
  partial: LifecycleUiTask;
  cancellation: LifecycleUiTask;
  /** Same partial-history owner/workspace, deliberately the wrong Session. */
  partialOtherSessionId: string;
  /** Existing same-owner empty/different Session. The helper never queues work. */
  otherSessionId: string;
  /** Reads production cancellation, stops only owned native work, then ACKs. */
  drainCancellation: () => Promise<unknown>;
  /** Bind a later root only after the old single-child cancellation is drained.
   * Production permits exactly one active execution owner per Session. */
  createSameSessionPeer: () => Promise<{
    rootRunId: string;
    assertUnchanged: () => Promise<Record<string, unknown>>;
  }>;
};

export interface LifecycleUiReport {
  passed: boolean;
  scope: string;
  phase: string;
  evidencePath?: string;
  sourceHead?: string;
  trackedDiffDigest?: string;
  buildId?: string;
  sourceDigests: Record<string, string>;
  checks: Record<string, unknown>;
  screenshots: { path: string; sha256: string }[];
  failure: { code: 'MET140_UI_FAILED'; phase: string } | null;
  diagnostics: {
    pageErrors: number;
    consoleErrors: { phase: string; injectedFetchFailure: boolean }[];
    injectedNetworkFailures: number;
    failedResponses: { phase: string; path: string; status: number }[];
    blockedRequests: { path: string; method: string }[];
    controls: { runId: string; childRunId: string | null; status: number }[];
  };
  cleanup: {
    chromeClosed: boolean;
    nextStopped: boolean;
    authRemoved: boolean;
    privateDirectoryRemoved: boolean;
    fixtureLeftOpen: true;
  };
}

/** Unknown UI ownership never authorizes destruction of its backing fixture. */
export function lifecycleFixtureCleanupAllowed(
  uiEntered: boolean,
  cleanup?: Pick<
    LifecycleUiReport['cleanup'],
    'chromeClosed' | 'nextStopped' | 'authRemoved'
  >,
) {
  return (
    !uiEntered ||
    (cleanup?.chromeClosed === true &&
      cleanup.nextStopped === true &&
      cleanup.authRemoved === true)
  );
}

export function assertLifecycleUiScope(input: LifecycleUiInput) {
  const url = new URL(input.databaseUrl);
  assert.equal(url.protocol, 'postgres:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5432');
  assert.equal(url.username, 'a123');
  assert.equal(url.password, '');
  assert.equal(url.pathname, '/allrice_b2');
  assert.equal([...url.searchParams].length, 1);
  assert.match(
    url.searchParams.get('options') ?? '',
    /^-csearch_path=p25_[a-f0-9]{32},public$/,
  );
  for (const task of [input.partial, input.cancellation])
    for (const id of [
      task.org,
      task.workspace,
      task.user,
      task.session,
      task.rootRunId,
    ])
      assert.ok(uuid(id));
  assert.ok(uuid(input.otherSessionId));
  assert.ok(uuid(input.partialOtherSessionId));
  assert.notEqual(input.partial.session, input.partialOtherSessionId);
  assert.notEqual(input.partial.rootRunId, input.cancellation.rootRunId);
  assert.notEqual(input.cancellation.session, input.otherSessionId);
  return url.searchParams
    .get('options')!
    .slice('-csearch_path='.length)
    .split(',')[0]!;
}

async function bounded<T>(work: Promise<T>, milliseconds = 15000): Promise<T> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      work,
      delay(milliseconds, undefined, { signal: abort.signal }).then(() => {
        throw Error('MET140_BOUNDED_TIMEOUT');
      }),
    ]);
  } finally {
    abort.abort();
  }
}

export async function verifyAssistantLifecycleInChrome(
  input: LifecycleUiInput,
): Promise<LifecycleUiReport> {
  const report: LifecycleUiReport = {
    passed: false,
    scope:
      'MET140: private Chrome + built Next + isolated PG + caller-owned production controller/controlled native fixture; no real Codex provider, full Worker or deployment claim.',
    phase: 'scope',
    sourceDigests: {},
    checks: {},
    screenshots: [],
    failure: null,
    diagnostics: {
      pageErrors: 0,
      injectedNetworkFailures: 0,
      consoleErrors: [],
      failedResponses: [],
      blockedRequests: [],
      controls: [],
    },
    cleanup: {
      chromeClosed: false,
      nextStopped: false,
      authRemoved: false,
      privateDirectoryRemoved: false,
      fixtureLeftOpen: true,
    },
  };
  let temporary: string | undefined, evidence: string | undefined;
  let server: ChildProcess | undefined,
    context: Playwright.BrowserContext | undefined,
    page: Playwright.Page | undefined;
  const authIds: { id: string; user: string }[] = [];
  let detailOutage = false;
  const tasks = [input.partial, input.cancellation];
  const controlRoots = new Set([input.cancellation.rootRunId]);
  const controlChildren = new Set<string>();
  const phase = (value: string) => {
    report.phase = value;
  };
  try {
    const schema = assertLifecycleUiScope(input);
    const [scope] =
      await input.db`select current_schema() as schema,current_database() as database`;
    assert.equal(scope?.schema, schema);
    assert.equal(scope?.database, 'allrice_b2');
    phase('evidence');
    assert.ok(isAbsolute(input.evidenceDirectory));
    assert.ok((await lstat(input.evidenceDirectory)).isDirectory());
    evidence = join(await realpath(input.evidenceDirectory), 'met140-ui');
    await mkdir(evidence, { mode: 0o700 });
    report.evidencePath = join(evidence, 'checks.json');
    phase('storage');
    assert.ok(isAbsolute(input.storageRoot));
    assert.equal(await realpath(input.storageRoot), resolve(input.storageRoot));
    assert.ok((await lstat(input.storageRoot)).isDirectory());
    phase('source');
    report.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    report.trackedDiffDigest = hash(
      execFileSync('git', ['diff', '--binary'], { cwd: root }),
    );
    report.buildId = (
      await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')
    ).trim();
    for (const path of [
      'apps/web/app/chatflow/assistant-run-panel.tsx',
      'apps/web/app/chatflow/assistant-tree-card.tsx',
      'apps/web/app/chatflow/use-assistant-session.ts',
      'apps/web/app/chatflow/assistant-eligibility.ts',
      'apps/web/app/api/v1/runtime/assistants/route.ts',
      'packages/database/src/assistant-runtime.ts',
      'apps/worker/src/harness/dsh/assistant-controller.ts',
      'apps/worker/src/harness/dsh/assistant-bridge.ts',
      'scripts/acceptance/ui/p29-assistant-lifecycle-ui.ts',
    ])
      report.sourceDigests[path] = hash(await readFile(join(root, path)));
    for (const task of tasks) {
      const [row] =
        await input.db`select r.id from allrice_runs r join allrice_employee_runs e on e.run_id=r.id where r.id=${task.rootRunId} and r.organization_id=${task.org} and r.workspace_id=${task.workspace} and r.owner_id=${task.user} and e.session_id=${task.session}`;
      assert.ok(row);
    }
    const [other] =
      await input.db`select id from allrice_chat_sessions where id=${input.otherSessionId} and organization_id=${input.cancellation.org} and workspace_id=${input.cancellation.workspace} and owner_id=${input.cancellation.user}`;
    assert.ok(other);
    const [partialOther] =
      await input.db`select id from allrice_chat_sessions where id=${input.partialOtherSessionId} and organization_id=${input.partial.org} and workspace_id=${input.partial.workspace} and owner_id=${input.partial.user}`;
    assert.ok(partialOther);

    phase('private_server');
    temporary = await mkdtemp(join(tmpdir(), 'allrice-met140-ui-'));
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port,
      origin = `http://127.0.0.1:${port}`;
    await new Promise<void>((done) => probe.close(() => done()));
    const authSecret = randomBytes(32).toString('hex');
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'production',
      __NEXT_PROCESSED_ENV: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: input.databaseUrl,
      ALLRICE_PORTAL_AUTH_ENABLED: '1',
      ALLRICE_LOCAL_PORTAL: 'snow',
      ALLRICE_PORTAL_SECURE_COOKIE: '0',
      ALLRICE_PORTAL_SESSION_SECRET: authSecret,
      ALLRICE_STORAGE_ROOT: input.storageRoot,
      ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
      ALLRICE_ASSISTANTS_ENABLED: '1',
      ALLRICE_WORKBENCH_ENABLED: '1',
    };
    for (const name of [
      'RUNTIME_POLICY',
      'GEMINI_API',
      'CHATFLOW_REALTIME',
      'LOCAL_COMMAND',
      'BRIDGE_OPERATION_LEDGER',
      'BRIDGE_WSS',
      'CLOUD_MCP',
      'CLOUD_RUNNER',
      'CHANGESET',
      'LOCAL_SERVICE',
      'LOCAL_BROWSER',
      'LOCAL_MCP',
      'BROWSER_CONTROL',
    ])
      environment[`ALLRICE_${name}_ENABLED`] = '0';
    server = spawn(
      process.execPath,
      [
        createRequire(join(root, 'apps/web/package.json')).resolve(
          'next/dist/bin/next',
        ),
        'start',
        join(root, 'apps/web'),
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    let startFailed = false;
    server.once('error', () => {
      startFailed = true;
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(startFailed, false);
      assert.equal(server.exitCode, null);
      try {
        if (
          (
            await fetch(`${origin}/login`, {
              signal: AbortSignal.timeout(2000),
            })
          ).status < 500
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Owned startup. */
      }
      await delay(200);
    }
    assert.ok(ready);
    phase('private_browser');
    const { chromium } = createRequire(join(root, 'apps/worker/package.json'))(
      'playwright-core',
    ) as typeof Playwright;
    context = await chromium.launchPersistentContext(
      join(temporary, 'profile'),
      {
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        viewport: { width: 1440, height: 1100 },
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        args: ['--disable-background-networking'],
        serviceWorkers: 'block',
      },
    );
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const external =
        url.origin !== origin && !['data:', 'blob:'].includes(url.protocol);
      let allowed = ['GET', 'HEAD'].includes(request.method());
      if (
        !external &&
        request.method() === 'POST' &&
        url.pathname === '/api/v1/runtime/assistants'
      ) {
        const body = request.postDataJSON();
        allowed =
          controlRoots.has(url.searchParams.get('runId') ?? '') &&
          url.searchParams.get('workspaceId') ===
            input.cancellation.workspace &&
          uuid(body.requestId) &&
          (body.action === 'cancel_root' ||
            (body.action === 'stop_child' &&
              controlChildren.has(body.childRunId)));
      }
      if (external || !allowed) {
        report.diagnostics.blockedRequests.push({
          path: external ? '[external]' : url.pathname,
          method: request.method(),
        });
        return route.abort('blockedbyclient');
      }
      if (
        detailOutage &&
        request.method() === 'GET' &&
        url.pathname === '/api/v1/runtime/assistants' &&
        url.searchParams.get('runId') === input.cancellation.rootRunId
      ) {
        report.diagnostics.injectedNetworkFailures++;
        return route.abort('failed'); // Transport outage, not a fabricated API response.
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => {
      report.diagnostics.blockedRequests.push({
        path: '[websocket]',
        method: 'WEBSOCKET',
      });
      socket.close();
    });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', () => report.diagnostics.pageErrors++);
    page.on('console', (message) => {
      if (message.type() === 'error')
        report.diagnostics.consoleErrors.push({
          phase: report.phase,
          injectedFetchFailure:
            detailOutage &&
            message.text() === 'Failed to load resource: net::ERR_FAILED',
        });
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        report.diagnostics.failedResponses.push({
          phase: report.phase,
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
    });
    const authenticate = async (task: LifecycleUiTask) => {
      await page!.goto('about:blank');
      const token = randomBytes(32).toString('base64url'),
        id = randomUUID();
      await input.db`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${id},${task.user},${hash(token)},now()+interval '15 minutes')`;
      authIds.push({ id, user: task.user });
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          portalKey: 'snow',
          subject: 'met140-controlled-native-ui',
          organizationId: task.org,
          workspaceId: task.workspace,
          issuedAt: now,
          expiresAt: now + 900,
          nonce: randomBytes(12).toString('base64url'),
        }),
      ).toString('base64url');
      const portal = `${payload}.${createHmac('sha256', authSecret).update(payload).digest('base64url')}`;
      await context!.clearCookies();
      await context!.addCookies(
        [
          { name: 'allrice_session', value: token },
          { name: 'allrice_portal_session', value: portal },
        ].map((cookie) => ({
          ...cookie,
          url: origin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax' as const,
        })),
      );
    };
    const tree = async (task: LifecycleUiTask) => {
      const response = await page!.request.get(
        `${origin}/api/v1/runtime/assistants?workspaceId=${task.workspace}&runId=${task.rootRunId}`,
      );
      assert.equal(response.status(), 200);
      assert.match(response.headers()['cache-control'] ?? '', /no-store/);
      return (await response.json()).tree as AssistantTreeView;
    };
    const screenshot = async (name: string) => {
      const path = join(evidence!, `${name}.png`);
      await page!.screenshot({ path, fullPage: true, timeout: 10000 });
      report.screenshots.push({ path, sha256: hash(await readFile(path)) });
    };
    const openPanel = async (task: LifecycleUiTask) => {
      const panel = page!.locator(`#assistants-${task.rootRunId}`);
      await panel.waitFor();
      if (
        (await panel.locator('details').first().getAttribute('open')) === null
      )
        await panel.locator('summary').first().click();
      await panel
        .getByText('正在读取权威明细…', { exact: true })
        .waitFor({ state: 'detached' });
      return panel;
    };

    phase('partial_failed_history');
    await authenticate(input.partial);
    const partial = await tree(input.partial);
    assert.ok(partial.results.some((result) => result.status === 'partial'));
    assert.ok(partial.results.some((result) => result.status === 'failed'));
    await page.goto(`${origin}/chatflow?session=${input.partial.session}`);
    let panel = await openPanel(input.partial);
    for (const result of partial.results) {
      await panel.getByText(result.summary, { exact: true }).waitFor();
      if (result.incomplete.length)
        await panel
          .getByText(`未完成：${result.incomplete.join('；')}`, { exact: true })
          .first()
          .waitFor();
    }
    assert.equal(await panel.locator('script').count(), 0);
    report.checks.partialAndFailureAuthoritativeResultsVisible = true;
    await screenshot('partial-failed-desktop');
    for (const status of ['partial', 'failed']) {
      const result = partial.results.find((item) => item.status === status)!;
      await panel
        .getByText(result.summary, { exact: true })
        .evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await screenshot(`${status}-result-visible`);
    }
    const artifactProofs: Record<string, unknown>[] = [];
    phase('artifact_detail');
    for (const result of partial.results)
      for (const ref of result.evidence) {
        const endpoint = `${origin}/api/v1/sessions/${input.partial.session}/artifacts/${ref.id}?workspaceId=${input.partial.workspace}`;
        const response = await page.request.get(endpoint);
        assert.equal(response.status(), 200);
        const artifact = (await response.json()).artifact;
        assert.equal(artifact.object.checksum, ref.digest);
        assert.equal(artifact.object.immutable, true);
        assert.equal(artifact.version.sessionId, input.partial.session);
        assert.equal(artifact.provenance.runId, result.runId);
        const content = await page.request.get(
          `${origin}/api/v1/sessions/${input.partial.session}/artifacts/${ref.id}/content?workspaceId=${input.partial.workspace}`,
        );
        assert.equal(content.status(), 200);
        const stored = await content.json();
        assert.equal(stored.kind, 'text');
        assert.equal(`sha256:${hash(stored.text)}`, ref.digest);
        artifactProofs.push({
          id: ref.id,
          childRunId: result.runId,
          digest: ref.digest,
          fileName: artifact.version.fileName,
        });
        const row = panel
          .locator('li')
          .filter({ has: page.locator(`[title="${ref.digest}"]`) })
          .filter({
            has: page.getByRole('button', {
              name: '查看关联工件',
              exact: true,
            }),
          })
          .last();
        await row
          .getByRole('button', { name: '查看关联工件', exact: true })
          .click();
        const workbench = page.getByRole('complementary', {
          name: '工件与审查工作台',
        });
        await workbench.waitFor();
        await workbench
          .getByRole('heading', {
            name: artifact.version.fileName,
            exact: true,
          })
          .waitFor();
        await screenshot(`artifact-${artifactProofs.length}`);
        await page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
      }
    assert.ok(artifactProofs.length >= 2);
    assert.equal(
      new Set(artifactProofs.map((item) => item.id)).size,
      artifactProofs.length,
    );
    assert.equal(
      new Set(artifactProofs.map((item) => item.digest)).size,
      artifactProofs.length,
    );
    assert.equal(new Set(artifactProofs.map((item) => item.fileName)).size, 1);
    report.checks.artifacts = artifactProofs;
    report.checks.sameNamedChildOutputsIsolated = true;
    report.checks.artifactConflict = {
      covered: false,
      reason:
        'covered_by_separate_real_pg_runtime_regression_not_ui_report_submission',
    };
    await page.reload();
    panel = await openPanel(input.partial);
    for (const result of partial.results)
      await panel.getByText(result.summary, { exact: true }).waitFor();
    assert.deepEqual((await tree(input.partial)).results, partial.results);
    report.checks.partialResultsRetainedAfterRefresh = true;
    phase('same_owner_cross_session_artifact');
    const wrongSessionDenials: { artifactId: string; status: number }[] = [];
    for (const artifact of artifactProofs) {
      const denied = await page.request.get(
        `${origin}/api/v1/sessions/${input.partialOtherSessionId}/artifacts/${artifact.id}?workspaceId=${input.partial.workspace}`,
      );
      assert.ok([403, 404].includes(denied.status()));
      wrongSessionDenials.push({
        artifactId: String(artifact.id),
        status: denied.status(),
      });
    }
    await page.goto(
      `${origin}/chatflow?session=${input.partialOtherSessionId}`,
    );
    await page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
    assert.equal(
      await page.locator(`#assistants-${input.partial.rootRunId}`).count(),
      0,
    );
    const partialOtherTrees = await page.request.get(
      `${origin}/api/v1/runtime/assistants?workspaceId=${input.partial.workspace}&sessionId=${input.partialOtherSessionId}`,
    );
    assert.equal(partialOtherTrees.status(), 200);
    assert.deepEqual((await partialOtherTrees.json()).trees, []);
    report.checks.sameOwnerWrongSessionArtifactDenied = wrongSessionDenials;
    await screenshot('same-owner-other-session-no-artifacts');

    phase('cancellation_initial');
    await authenticate(input.cancellation);
    const initial = await tree(input.cancellation);
    const children = initial.instances.filter(
      (item) => item.parentRunId === initial.rootRunId,
    );
    assert.equal(children.length, 2);
    assert.ok(
      children.every(
        (item) =>
          item.status === 'running' &&
          item.stoppedAt === null &&
          item.cancelRequestedAt === null,
      ),
    );
    for (const child of children) controlChildren.add(child.runId);
    await page.goto(`${origin}/chatflow?session=${input.cancellation.session}`);
    panel = await openPanel(input.cancellation);
    const childRow = (id: string) =>
      panel
        .locator('li')
        .filter({
          has: page!.getByText(
            children.find((child) => child.runId === id)!.label,
            { exact: true },
          ),
        })
        .first();
    phase('detail_outage');
    detailOutage = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await panel.getByRole('alert').waitFor();
    assert.equal(
      await panel.getByText('执行端已确认停止', { exact: false }).count(),
      0,
    );
    assert.equal(
      (await tree(input.cancellation)).instances.filter(
        (item) => item.stoppedAt,
      ).length,
      0,
    );
    await screenshot('detail-outage-not-stopped');
    detailOutage = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await panel.getByRole('alert').waitFor({ state: 'detached' });
    report.checks.detailOutageDoesNotFabricateStopAndRecovers = true;
    const stop = async (childRunId?: string) => {
      const prefix = childRunId ? 'single_cancel' : 'root_cancel';
      const responsePromise = page!
        .waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/runtime/assistants' &&
            response.request().method() === 'POST',
        )
        .then(
          (response) => response,
          () => null,
        );
      const button = childRunId
        ? childRow(childRunId).getByRole('button', {
            name: '停止这个助手',
            exact: true,
          })
        : panel.getByRole('button', {
            name: '取消整项任务（含所有助手）',
            exact: true,
          });
      phase(`${prefix}_click`);
      await bounded(button.click({ timeout: 10000 }));
      phase(`${prefix}_response`);
      const response = await bounded(responsePromise);
      assert.ok(response, 'controlled UI POST must receive a response');
      assert.equal(response.status(), 202);
      // The production UI consumes status only, not this response body. Assert
      // the actual submitted action, then independently GET authoritative state.
      // Do not depend on DevTools buffering a body the browser never consumes.
      const body = response.request().postDataJSON();
      assert.equal(body.action, childRunId ? 'stop_child' : 'cancel_root');
      assert.equal(body.childRunId ?? null, childRunId ?? null);
      report.diagnostics.controls.push({
        runId: input.cancellation.rootRunId,
        childRunId: childRunId ?? null,
        status: response.status(),
      });
      phase(`${prefix}_request`);
    };
    phase('single_cancel_request');
    await stop(children[0]!.runId);
    let current = await tree(input.cancellation);
    assert.ok(
      current.instances.find((item) => item.runId === children[0]!.runId)
        ?.cancelRequestedAt,
    );
    assert.equal(
      current.instances.find((item) => item.runId === children[0]!.runId)
        ?.stoppedAt,
      null,
    );
    assert.equal(
      current.instances.find((item) => item.runId === children[1]!.runId)
        ?.cancelRequestedAt,
      null,
    );
    const pendingText =
      '已请求停止不代表进程已退出；等待执行端确认。已经发生的外部动作不一定能撤回。';
    await panel.getByText(pendingText, { exact: true }).waitFor();
    await page.reload();
    panel = await openPanel(input.cancellation);
    await panel.getByText(pendingText, { exact: true }).waitFor();
    await screenshot('single-cancel-pending-after-refresh');
    phase('single_cancel_native_ack');
    await bounded(input.drainCancellation(), 30000);
    current = await tree(input.cancellation);
    const stopped = current.instances.find(
      (item) => item.runId === children[0]!.runId,
    )!;
    assert.equal(stopped.status, 'canceled');
    assert.ok(stopped.stoppedAt);
    const sibling = current.instances.find(
      (item) => item.runId === children[1]!.runId,
    )!;
    assert.equal(sibling.status, 'running');
    assert.equal(sibling.cancelRequestedAt, null);
    assert.equal(sibling.stoppedAt, null);
    await childRow(stopped.runId)
      .getByText('执行端已确认停止', { exact: false })
      .waitFor();
    await screenshot('single-cancel-native-confirmed');
    report.checks.singleCancelRequestRefreshAndNativeStop = {
      childRunId: stopped.runId,
      siblingRunId: sibling.runId,
      siblingStillRunning: true,
    };
    phase('same_session_successor_bind');
    const peer = await bounded(input.createSameSessionPeer(), 30000);
    assert.ok(uuid(peer.rootRunId));
    assert.notEqual(peer.rootRunId, input.cancellation.rootRunId);
    const peerTask = { ...input.cancellation, rootRunId: peer.rootRunId };
    const peerBefore = await tree(peerTask);
    assert.equal(peerBefore.cancelRequested, false);
    assert.equal(peerBefore.instances.length, 1);
    assert.equal(peerBefore.instances[0]?.status, 'running');
    await page.reload();
    panel = await openPanel(input.cancellation);
    await page.locator(`#assistants-${peer.rootRunId}`).waitFor();
    phase('root_cancel_request');
    await stop();
    current = await tree(input.cancellation);
    assert.equal(current.cancelRequested, true);
    assert.ok(
      current.instances.find((item) => item.runId === sibling.runId)
        ?.cancelRequestedAt,
    );
    assert.equal(
      current.instances.find((item) => item.runId === sibling.runId)?.stoppedAt,
      null,
    );
    await page.reload();
    panel = await openPanel(input.cancellation);
    await panel.getByText(pendingText, { exact: true }).waitFor();
    await screenshot('root-cancel-pending-after-refresh');
    phase('root_cancel_native_ack');
    await bounded(input.drainCancellation(), 30000);
    current = await tree(input.cancellation);
    assert.ok(
      current.instances.every(
        (item) =>
          item.cancelRequestedAt &&
          item.stoppedAt &&
          item.status === 'canceled',
      ),
    );
    await page.reload();
    panel = await openPanel(input.cancellation);
    assert.equal(
      await panel.getByText(pendingText, { exact: true }).count(),
      0,
    );
    assert.equal(
      await panel.getByText('执行端已确认停止', { exact: false }).count(),
      2,
    );
    await panel.evaluate((element) =>
      element.scrollIntoView({ block: 'start' }),
    );
    await screenshot('root-cancel-native-confirmed');
    report.checks.rootCancelRequestRefreshAndNativeStop = {
      rootRunId: current.rootRunId,
      allInstancesStopped: true,
    };
    assert.deepEqual(await tree(peerTask), peerBefore);
    report.checks.sameSessionOldRootCancellationPreservesNewActiveRoot =
      await peer.assertUnchanged();
    await page
      .locator(`#assistants-${peer.rootRunId}`)
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await screenshot('same-session-new-root-not-canceled');

    phase('same_session_boundary');
    const sessionsEndpoint = `${origin}/api/v1/runtime/assistants?workspaceId=${input.cancellation.workspace}&sessionId=${input.cancellation.session}`;
    const same = await page.request.get(sessionsEndpoint);
    assert.equal(same.status(), 200);
    const sameTrees = (await same.json()).trees as AssistantTreeView[];
    assert.equal(
      sameTrees.filter(
        (item) => item.rootRunId === input.cancellation.rootRunId,
      ).length,
      1,
    );
    assert.equal(
      sameTrees.filter((item) => item.rootRunId === peer.rootRunId).length,
      1,
    );
    const sameRoots = sameTrees.map((item) => item.rootRunId);
    const linked =
      await input.db`select run_id from allrice_employee_runs where session_id=${input.cancellation.session} and organization_id=${input.cancellation.org} and workspace_id=${input.cancellation.workspace} and owner_id=${input.cancellation.user}`;
    assert.ok(sameRoots.every((id) => linked.some((row) => row.run_id === id)));
    phase('other_session_boundary');
    await page.goto(`${origin}/chatflow?session=${input.otherSessionId}`);
    assert.equal(
      await page.locator(`#assistants-${input.cancellation.rootRunId}`).count(),
      0,
    );
    const different = await page.request.get(
      `${origin}/api/v1/runtime/assistants?workspaceId=${input.cancellation.workspace}&sessionId=${input.otherSessionId}`,
    );
    assert.equal(different.status(), 200);
    assert.deepEqual((await different.json()).trees, []);
    await screenshot('other-session-no-canceled-tree');
    // GET-only denial on an artifact ID bound to another Session/tenant.
    for (const artifact of artifactProofs) {
      const denied = await page.request.get(
        `${origin}/api/v1/sessions/${input.otherSessionId}/artifacts/${artifact.id}?workspaceId=${input.cancellation.workspace}`,
      );
      assert.ok([403, 404].includes(denied.status()));
    }
    report.checks.sameSessionStableAndOtherSessionIsolated = true;
    report.checks.crossTenantArtifactReadDenied = true;
    await page.goto(`${origin}/chatflow?session=${input.cancellation.session}`);
    panel = await openPanel(input.cancellation);
    assert.equal(
      await panel.getByText('执行端已确认停止', { exact: false }).count(),
      2,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await screenshot('cancel-confirmed-narrow');
    await childRow(children[1]!.runId).evaluate((element) =>
      element.scrollIntoView({ block: 'start' }),
    );
    await screenshot('cancel-confirmed-narrow-second-child');
    report.checks.returningSessionKeepsConfirmedTree = true;
    assert.equal(report.diagnostics.pageErrors, 0);
    assert.ok(report.diagnostics.injectedNetworkFailures > 0);
    assert.ok(
      report.diagnostics.consoleErrors.length <=
        report.diagnostics.injectedNetworkFailures,
    );
    assert.deepEqual(
      report.diagnostics.consoleErrors.filter(
        (error) =>
          error.phase !== 'detail_outage' || !error.injectedFetchFailure,
      ),
      [],
    );
    assert.deepEqual(report.diagnostics.failedResponses, []);
    assert.deepEqual(report.diagnostics.blockedRequests, []);
    assert.equal(
      (await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')).trim(),
      report.buildId,
    );
    report.passed = true;
    phase('complete');
  } catch {
    report.failure = { code: 'MET140_UI_FAILED', phase: report.phase };
    if (page && evidence) {
      const path = join(evidence, 'failure.png');
      await page
        .screenshot({ path, fullPage: true, timeout: 10000 })
        .then(async () => {
          report.screenshots.push({ path, sha256: hash(await readFile(path)) });
        })
        .catch(() => {});
    }
  } finally {
    try {
      if (context) await bounded(context.close());
      report.cleanup.chromeClosed = true;
    } catch {
      /* Unconfirmed. */
    }
    try {
      if (
        server?.pid &&
        server.exitCode === null &&
        server.signalCode === null
      ) {
        server.kill('SIGTERM');
        await bounded(once(server, 'exit'), 5000).catch(() => {});
        if (server.exitCode === null && server.signalCode === null) {
          server.kill('SIGKILL');
          await bounded(once(server, 'exit'), 5000);
        }
      }
      report.cleanup.nextStopped =
        !server?.pid || server.exitCode !== null || server.signalCode !== null;
    } catch {
      /* Unconfirmed. */
    }
    try {
      for (const auth of authIds)
        await input.db`delete from allrice_sessions where id=${auth.id} and user_id=${auth.user}`;
      report.cleanup.authRemoved = true;
    } catch {
      /* Caller retains fixture. */
    }
    try {
      if (report.cleanup.chromeClosed && report.cleanup.nextStopped) {
        if (temporary) {
          assert.match(basename(temporary), /^allrice-met140-ui-/);
          await rm(temporary, { recursive: true, force: true });
        }
        report.cleanup.privateDirectoryRemoved = true;
      }
    } catch {
      /* Unconfirmed. */
    }
    if (!Object.values(report.cleanup).every(Boolean)) {
      report.passed = false;
      report.failure ??= { code: 'MET140_UI_FAILED', phase: 'cleanup' };
    }
    if (evidence)
      await writeFile(
        join(evidence, 'checks.json'),
        JSON.stringify(report, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      ).catch(() => {
        report.passed = false;
        report.failure ??= {
          code: 'MET140_UI_FAILED',
          phase: 'evidence_write',
        };
      });
  }
  return report;
}
