/** Read-only real-history UI observation after both P27 Worker tasks complete.
 * This helper never starts a Worker, synthesizes results, or owns the fixture.
 * Only its private browser/server/auth session are created and cleaned up. */
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import type { AssistantTreeView } from '../../../packages/database/src/assistant-runtime.ts';
import type { P27CodexWorkerFixture } from '../runtime/p27-codex-worker-fixture.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const uuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      work,
      delay(milliseconds, undefined, { signal: abort.signal }).then(() => {
        throw new Error('P28_REAL_UI_TIMEOUT');
      }),
    ]);
  } finally {
    abort.abort();
  }
}
type Identity = Pick<
  P27CodexWorkerFixture,
  'db' | 'databaseUrl' | 'organizationId' | 'workspaceId' | 'ownerId'
>;
type Task = { runId: string; sessionId: string };
export interface CodexWorkerUiObservation {
  passed: boolean;
  scope: string;
  sourceHead?: string;
  buildId?: string;
  evidencePath?: string;
  assistant: Task;
  ordinary: Task;
  childRunIds: string[];
  artifacts: {
    id: string;
    digest: string;
    summaryVisible: boolean;
    detailRead: boolean;
    storedContentDigestVerified: boolean;
  }[];
  screenshots: string[];
  checks: Record<string, boolean>;
  failure: { code: 'P28_REAL_UI_FAILED'; phase: string } | null;
  cleanup: {
    chromeClosed: boolean;
    nextStopped: boolean;
    authSessionRemoved: boolean;
    privateDirectoryRemoved: boolean;
    fixtureLeftOpen: boolean;
  };
  diagnostics: {
    pageErrorCount: number;
    consoleErrorCount: number;
    failedResponses: { path: string; status: number }[];
    blockedRequests: { path: string; method: string; external: boolean }[];
  };
}

/** Pass the exact two completed tasks and the driver's existing private storage
 * root. The returned passed=false MUST fail the enclosing acceptance; inspect
 * only its fixed failure code/phase, never arbitrary server/provider output. */
export async function verifyCodexWorkerSessionsInChrome(input: {
  fixture: Identity;
  assistant: Task;
  ordinary: Task;
  storageRoot: string;
  evidenceDirectory: string;
  chromeExecutable?: string;
}): Promise<CodexWorkerUiObservation> {
  const { fixture, assistant, ordinary } = input;
  const report: CodexWorkerUiObservation = {
    passed: false,
    scope:
      'Real completed P27 Worker history -> private built Next -> private Chrome, exact fixture sessions only; no additional model calls, fabricated results or release authority.',
    assistant,
    ordinary,
    childRunIds: [],
    artifacts: [],
    screenshots: [],
    checks: {},
    failure: null,
    cleanup: {
      chromeClosed: false,
      nextStopped: false,
      authSessionRemoved: false,
      privateDirectoryRemoved: false,
      fixtureLeftOpen: true,
    },
    diagnostics: {
      pageErrorCount: 0,
      consoleErrorCount: 0,
      failedResponses: [],
      blockedRequests: [],
    },
  };
  let phase = 'fixture_scope',
    temporary: string | undefined;
  let server: ChildProcess | undefined,
    context: Playwright.BrowserContext | undefined,
    page: Playwright.Page | undefined;
  let authSessionId: string | undefined, evidence: string | undefined;
  const sessionIds = [assistant.sessionId, ordinary.sessionId];
  const runIds = [assistant.runId, ordinary.runId];
  const businessDigest = async () => {
    const rows = await fixture.db`
      select r.id,r.state,e.session_id,e.assistant_message_id,m.status,m.content->>'text' as delivered_text
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id
      join allrice_messages m on m.id=e.assistant_message_id
      where r.id in ${fixture.db(runIds)} and r.organization_id=${fixture.organizationId}
        and r.workspace_id=${fixture.workspaceId} and r.owner_id=${fixture.ownerId}
      order by r.id`;
    return hash(JSON.stringify(rows));
  };
  try {
    for (const id of [
      ...runIds,
      ...sessionIds,
      fixture.organizationId,
      fixture.workspaceId,
      fixture.ownerId,
    ])
      assert.ok(uuid(id));
    assert.notEqual(assistant.runId, ordinary.runId);
    assert.notEqual(assistant.sessionId, ordinary.sessionId);
    const url = new URL(fixture.databaseUrl);
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
    const [scope] =
      await fixture.db`select current_schema() as schema,current_database() as database`;
    assert.ok(scope && /^p25_[a-f0-9]{32}$/.test(scope.schema));
    assert.equal(scope.database, 'allrice_b2');
    assert.equal(
      url.searchParams.get('options'),
      `-csearch_path=${scope.schema},public`,
    );
    phase = 'private_storage';
    assert.ok(
      isAbsolute(input.storageRoot) &&
        basename(input.storageRoot) === 'storage',
    );
    assert.match(basename(dirname(input.storageRoot)), /^allrice-p27-codex-/);
    assert.ok((await lstat(input.storageRoot)).isDirectory());
    assert.equal(await realpath(input.storageRoot), resolve(input.storageRoot));
    phase = 'evidence_directory';
    assert.ok(isAbsolute(input.evidenceDirectory));
    assert.ok((await lstat(input.evidenceDirectory)).isDirectory());
    const evidenceCandidate = join(
      await realpath(input.evidenceDirectory),
      'worker-ui',
    );
    await mkdir(evidenceCandidate, { mode: 0o700 });
    evidence = evidenceCandidate;
    report.evidencePath = join(evidence, 'worker-ui-checks.json');
    phase = 'completed_history';
    report.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    report.buildId = (
      await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')
    ).trim();
    const rows = await fixture.db<
      {
        run_id: string;
        session_id: string;
        state: string;
        message_id: string;
        message_status: string;
        text: string;
      }[]
    >`
      select r.id as run_id,e.session_id,r.state,m.id as message_id,m.status as message_status,m.content->>'text' as text
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id
      join allrice_messages m on m.id=e.assistant_message_id
      where r.id in ${fixture.db(runIds)} and r.organization_id=${fixture.organizationId}
        and r.workspace_id=${fixture.workspaceId} and r.owner_id=${fixture.ownerId}
        and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id`;
    assert.equal(rows.length, 2);
    for (const task of [assistant, ordinary]) {
      const row = rows.find((item) => item.run_id === task.runId);
      assert.ok(
        row &&
          row.session_id === task.sessionId &&
          row.state === 'succeeded' &&
          row.message_status === 'completed' &&
          row.text.trim().length > 0,
      );
    }
    const ordinaryMessage = rows.find(
      (item) => item.run_id === ordinary.runId,
    )!;
    assert.match(ordinaryMessage.text, /(?:^|\D)579(?:\D|$)/);
    const beforeDigest = await businessDigest();
    report.checks.completedRowsInExactFixture = true;

    phase = 'private_server';
    temporary = await mkdtemp(join(tmpdir(), 'allrice-p28-real-ui-'));
    const serverProbe = createServer();
    serverProbe.listen(0, '127.0.0.1');
    await once(serverProbe, 'listening');
    const address = serverProbe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port,
      origin = `http://127.0.0.1:${port}`;
    await new Promise<void>((done) => serverProbe.close(() => done()));
    const authSecret = randomBytes(32).toString('hex');
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'production',
      __NEXT_PROCESSED_ENV: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: fixture.databaseUrl,
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
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_GEMINI_API_ENABLED',
      'ALLRICE_CHATFLOW_REALTIME_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      'ALLRICE_BRIDGE_WSS_ENABLED',
      'ALLRICE_CLOUD_MCP_ENABLED',
      'ALLRICE_CLOUD_RUNNER_ENABLED',
      'ALLRICE_CHANGESET_ENABLED',
      'ALLRICE_LOCAL_SERVICE_ENABLED',
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_LOCAL_MCP_ENABLED',
      'ALLRICE_BROWSER_CONTROL_ENABLED',
    ])
      environment[name] = '0';
    const webRequire = createRequire(join(root, 'apps/web/package.json'));
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
      { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    let processFailed = false;
    server.once('error', () => {
      processFailed = true;
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(processFailed, false);
      assert.equal(server.exitCode, null);
      try {
        if (
          (
            await fetch(`${origin}/login`, {
              signal: AbortSignal.timeout(2000),
              redirect: 'manual',
            })
          ).status < 500
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Local startup only. */
      }
      await delay(200);
    }
    assert.ok(ready);

    phase = 'private_browser';
    const { chromium } = createRequire(join(root, 'apps/worker/package.json'))(
      'playwright-core',
    ) as typeof Playwright;
    context = await chromium.launchPersistentContext(
      join(temporary, 'profile'),
      {
        executablePath:
          input.chromeExecutable ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        viewport: { width: 1440, height: 1100 },
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        args: ['--disable-background-networking'],
        serviceWorkers: 'block',
      },
    );
    const token = randomBytes(32).toString('base64url');
    authSessionId = randomUUID();
    await fixture.db`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${authSessionId},${fixture.ownerId},${hash(token)},now()+interval '10 minutes')`;
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        portalKey: 'snow',
        subject: 'p28-exact-completed-fixture-ui',
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        issuedAt: now,
        expiresAt: now + 600,
        nonce: randomBytes(12).toString('base64url'),
      }),
    ).toString('base64url');
    const portalToken = `${payload}.${createHmac('sha256', authSecret).update(payload).digest('base64url')}`;
    await context.addCookies([
      {
        name: 'allrice_session',
        value: token,
        url: origin,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'allrice_portal_session',
        value: portalToken,
        url: origin,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    await context.route('**/*', (route) => {
      const request = route.request(),
        requestUrl = new URL(request.url());
      const external =
        requestUrl.origin !== origin &&
        !['data:', 'blob:'].includes(requestUrl.protocol);
      if (external || !['GET', 'HEAD'].includes(request.method())) {
        report.diagnostics.blockedRequests.push({
          path: external ? '[external]' : requestUrl.pathname,
          method: request.method(),
          external,
        });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => {
      report.diagnostics.blockedRequests.push({
        path: '[websocket]',
        method: 'WEBSOCKET',
        external: true,
      });
      socket.close();
    });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', () => report.diagnostics.pageErrorCount++);
    page.on('console', (message) => {
      if (message.type() === 'error') report.diagnostics.consoleErrorCount++;
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        report.diagnostics.failedResponses.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
    });

    phase = 'assistant_history';
    const treeResponse = await page.request.get(
      `${origin}/api/v1/runtime/assistants?workspaceId=${fixture.workspaceId}&runId=${assistant.runId}`,
      { timeout: 20_000, maxRedirects: 0 },
    );
    assert.equal(treeResponse.status(), 200);
    const { tree } = (await treeResponse.json()) as { tree: AssistantTreeView };
    assert.equal(tree.rootRunId, assistant.runId);
    const children = tree.instances.filter(
      (item) => item.parentRunId === assistant.runId,
    );
    assert.equal(children.length, 2);
    assert.equal(new Set(children.map((item) => item.runId)).size, 2);
    assert.ok(
      tree.instances.length === 3 &&
        tree.instances.every((item) => item.status === 'completed'),
    );
    assert.equal(tree.results.length, 2);
    assert.equal(new Set(tree.results.map((item) => item.runId)).size, 2);
    report.childRunIds = children.map((item) => item.runId);
    await page.goto(`${origin}/chatflow?session=${assistant.sessionId}`);
    const panel = page.locator(`#assistants-${assistant.runId}`);
    await panel.waitFor();
    await panel.locator('summary').first().click();
    await panel.getByText('结果：已完成', { exact: true }).first().waitFor();
    assert.equal(
      await panel.getByText('结果：已完成', { exact: true }).count(),
      2,
    );
    assert.equal(
      await panel
        .getByRole('button', { name: '停止这个助手', exact: true })
        .count(),
      2,
    );
    for (const button of await panel
      .getByRole('button', { name: '停止这个助手', exact: true })
      .all())
      assert.ok(await button.isDisabled());
    for (const result of tree.results) {
      assert.ok(
        report.childRunIds.includes(result.runId) &&
          result.status === 'completed' &&
          result.usageComplete &&
          result.evidence.length === 1,
      );
      await panel.getByText(result.summary, { exact: true }).waitFor();
      const ref = result.evidence[0]!;
      assert.ok(uuid(ref.id));
      assert.match(ref.digest, /^sha256:[a-f0-9]{64}$/);
      await panel.locator(`[title="${ref.digest}"]`).waitFor();
      const detail = await page.request.get(
        `${origin}/api/v1/sessions/${assistant.sessionId}/artifacts/${ref.id}?workspaceId=${fixture.workspaceId}`,
        { timeout: 20_000, maxRedirects: 0 },
      );
      assert.equal(detail.status(), 200);
      const value = await detail.json();
      assert.equal(value.artifact.id, ref.id);
      assert.equal(value.artifact.version.sessionId, assistant.sessionId);
      assert.equal(value.artifact.object.checksum, ref.digest);
      assert.equal(
        value.artifact.version.organizationId,
        fixture.organizationId,
      );
      assert.equal(value.artifact.version.workspaceId, fixture.workspaceId);
      assert.equal(value.artifact.version.ownerId, fixture.ownerId);
      assert.equal(value.artifact.object.immutable, true);
      const content = await page.request.get(
        `${origin}/api/v1/sessions/${assistant.sessionId}/artifacts/${ref.id}/content?workspaceId=${fixture.workspaceId}`,
        { timeout: 20_000, maxRedirects: 0 },
      );
      assert.equal(content.status(), 200);
      const stored = await content.json();
      assert.equal(stored.kind, 'text');
      assert.equal(typeof stored.text, 'string');
      assert.equal(`sha256:${hash(stored.text)}`, ref.digest);
      report.artifacts.push({
        id: ref.id,
        digest: ref.digest,
        summaryVisible: true,
        detailRead: true,
        storedContentDigestVerified: true,
      });
    }
    assert.equal(new Set(report.artifacts.map((item) => item.id)).size, 2);
    assert.equal(
      await panel
        .getByRole('button', { name: '查看关联工件', exact: true })
        .count(),
      2,
    );
    report.checks.twoCompletedChildrenAndArtifactSummariesVisible = true;
    await panel.scrollIntoViewIfNeeded();
    for (const [name, width, height] of [
      ['assistant-desktop', 1440, 1100],
      ['assistant-narrow', 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await panel.scrollIntoViewIfNeeded();
      const path = join(evidence, `worker-ui-${name}.png`);
      await page.screenshot({ path, fullPage: true, timeout: 10_000 });
      report.screenshots.push(path);
    }

    phase = 'ordinary_follow_up';
    await page.goto(`${origin}/chatflow?session=${ordinary.sessionId}`);
    const message = page.locator(`#message-${ordinaryMessage.message_id}`);
    await message.waitFor();
    // Inspect only the delivered ordinary answer, never hidden reasoning/DOM.
    assert.match(await message.innerText(), /(?:^|\D)579(?:\D|$)/);
    assert.equal(
      await page.locator(`#assistants-${assistant.runId}`).count(),
      0,
    );
    report.checks.ordinaryExactSessionDelivered579 = true;
    await page.setViewportSize({ width: 1440, height: 1100 });
    await message.scrollIntoViewIfNeeded();
    const ordinaryShot = join(evidence, 'worker-ui-ordinary-desktop.png');
    await page.screenshot({
      path: ordinaryShot,
      fullPage: true,
      timeout: 10_000,
    });
    report.screenshots.push(ordinaryShot);
    assert.equal(await businessDigest(), beforeDigest);
    report.checks.completedBusinessRowsUnchanged = true;
    assert.equal(report.diagnostics.pageErrorCount, 0);
    assert.equal(report.diagnostics.consoleErrorCount, 0);
    assert.deepEqual(report.diagnostics.failedResponses, []);
    assert.deepEqual(report.diagnostics.blockedRequests, []);
    report.passed = true;
  } catch {
    report.failure = { code: 'P28_REAL_UI_FAILED', phase };
    if (page && evidence)
      await page
        .screenshot({
          path: join(evidence, 'worker-ui-failure.png'),
          fullPage: true,
          timeout: 10_000,
        })
        .catch(() => {});
  } finally {
    try {
      if (context) await bounded(context.close(), 15_000);
      report.cleanup.chromeClosed = true;
    } catch {
      /* Never claim disposal without ACK. */
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
      /* Keep unknown cleanup. */
    }
    try {
      if (authSessionId)
        await bounded(
          Promise.resolve(
            fixture.db`delete from allrice_sessions where id=${authSessionId} and user_id=${fixture.ownerId}`,
          ),
          10_000,
        );
      report.cleanup.authSessionRemoved = true;
    } catch {
      /* Caller still owns the fixture. */
    }
    if (report.cleanup.chromeClosed && report.cleanup.nextStopped) {
      try {
        if (temporary) {
          assert.match(basename(temporary), /^allrice-p28-real-ui-/);
          await rm(temporary, { recursive: true, force: true });
        }
        report.cleanup.privateDirectoryRemoved = true;
      } catch {
        /* Keep unconfirmed cleanup. */
      }
    }
    if (!Object.values(report.cleanup).every(Boolean)) {
      report.passed = false;
      report.failure ??= { code: 'P28_REAL_UI_FAILED', phase: 'cleanup' };
    }
    if (evidence) {
      try {
        await writeFile(
          join(evidence, 'worker-ui-checks.json'),
          `${JSON.stringify(report, null, 2)}\n`,
          { mode: 0o600, flag: 'wx' },
        );
      } catch {
        report.passed = false;
        report.failure ??= {
          code: 'P28_REAL_UI_FAILED',
          phase: 'evidence_write',
        };
      }
    }
  }
  return report;
}
