import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import {
  WorkbenchArtifactSchema,
  workspaceCapabilityIds,
  type WorkspaceCapability,
} from '@allrice/contracts';
import { layoutPreferenceKey } from './use-workbench-layout';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1),
  B = id(2),
  org = id(3),
  workspace = id(4),
  user = id(5),
  run = id(6);
const now = '2026-09-20T00:00:00.000Z';
const report =
  '# COIN / MSTR / CRCL · 合成研究报告\n\n| 标的 | 说明 |\n| --- | --- |\n| COIN | 测试数据，非投资建议 |\n\n' +
  '多步研究结果与引用说明。'.repeat(100);
function session(sessionId: string) {
  return {
    id: sessionId,
    title: sessionId === A ? '研究任务 A' : '研究任务 B',
    employeeAssignmentId: id(7),
    employeeVersionId: id(8),
    visibility: 'private',
    updatedAt: now,
    archivedAt: null,
  };
}
function artifact(n: number, sessionId = A) {
  const artifactId = id(n),
    objectId = id(n + 100);
  return WorkbenchArtifactSchema.parse({
    contractVersion: 1,
    id: artifactId,
    kind: 'document',
    version: {
      id: artifactId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      objectId,
      seriesId: artifactId,
      version: 1,
      parentVersionId: null,
      parentObjectId: null,
      sessionId,
      platformTestRunId: null,
      fileName: `report-${n}.md`,
      format: 'markdown',
      changeSummary: null,
      createdAt: `2026-09-20T00:${String(n).padStart(2, '0')}:00.000Z`,
    },
    object: {
      id: objectId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      key: `organizations/${org}/workspaces/${workspace}/owners/${user}/exports/${objectId}`,
      mediaType: 'text/markdown',
      checksum: `sha256:${'a'.repeat(64)}`,
      sizeBytes: report.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    },
    provenance: {
      kind: 'model_proposal',
      runId: run,
      operationId: null,
      stepId: null,
    },
    execution: null,
    latestVersionId: artifactId,
    stale: false,
  });
}

suite('MET-147 UX01-A full tenant workbench (synthetic HTTP, no model)', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const root = process.cwd(),
      require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: root,
      entryPoints: ['apps/web/test/met147-workbench-page.tsx'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/unused-met147',
      jsx: 'automatic',
      define: {
        'process.env.NODE_ENV': '"development"',
        'process.env': '{}',
      },
    });
    const js = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.js'),
    ).contents;
    const css = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.css'),
    ).contents;
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      response.writeHead(200, {
        'content-type':
          path === '/app.js'
            ? 'application/javascript'
            : path === '/app.css'
              ? 'text/css'
              : 'text/html',
      });
      response.end(
        path === '/app.js'
          ? js
          : path === '/app.css'
            ? css
            : '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('No loopback address');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(
      resolve(root, 'apps/worker/package.json'),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  async function fixture(
    options: {
      width?: number;
      artifacts?: boolean;
      disabled?: boolean;
      noSession?: boolean;
      noStorage?: boolean;
      running?: boolean;
    } = {},
  ) {
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: 950 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      writes: string[] = [],
      unexpected: string[] = [];
    const state = {
      readinessError: false,
      readinessWrongScope: false,
      readinessDelay: null as Promise<void> | null,
      readinessRequests: 0,
      canAdminister: false,
      capabilities: workspaceCapabilityIds.map((id): WorkspaceCapability => ({
        id,
        state:
          id === 'report'
            ? 'ready'
            : id === 'local_files'
              ? 'needs_configuration'
              : 'not_released',
        reason:
          id === 'report'
            ? 'ready'
            : id === 'local_files'
              ? 'bridge_missing'
              : 'release_disabled',
        action:
          id === 'report'
            ? 'compose'
            : id === 'local_files'
              ? 'bridge'
              : 'guide',
        target: id === 'local_files' ? 'local' : 'cloud',
        responsibleRole: 'user',
        releaseEnabled: ['report', 'local_files'].includes(id),
        authorization: 'normal_policy',
      })),
      viewer: user,
      workspace,
      omitSessionA: false,
      deepLinkDenied: false,
      items: options.artifacts ? [artifact(10)] : [],
      listError: false,
      contentError: false,
      text: report,
      reply: report,
      messageStatus: options.running ? 'pending' : 'completed',
      streamRequests: 0,
      delay: null as null | Promise<void>,
    };
    let finishStream!: () => void;
    const streamGate = new Promise<void>((done) => {
      finishStream = done;
    });
    page.on('pageerror', (e) => errors.push(e.message));
    if (options.noStorage)
      await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw Error('Storage disabled');
          },
        });
      });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      const answer = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      if (route.request().method() !== 'GET') {
        writes.push(path);
        return answer({}, 500);
      }
      if (path === '/api/v1/workspace')
        return answer({
          workspace: {
            organizationId: org,
            workspaceId: state.workspace,
            viewerId: state.viewer,
            canAdminister: false,
            sessions: options.noSession
              ? []
              : state.omitSessionA
                ? [session(B)]
                : [session(A), session(B)],
            sessionModels: [],
            employeeProfiles: [],
            employees: [
              {
                id: id(7),
                employeeId: id(9),
                isDefault: true,
                versions: [],
                currentVersion: {
                  id: id(8),
                  manifest: {
                    name: 'Rice',
                    runtimePolicy: { harness: 'dsh', provider: 'codex' },
                  },
                },
              },
            ],
          },
        });
      if (path === '/api/v1/saas/capabilities')
        return answer({
          capabilities: {
            schemaVersion: 1,
            roles: ['member'],
            surfaces: ['chatflow'],
            actions: [],
            features: { chatFlowV3: true, nativeHarnessEvents: true },
          },
        });
      if (path === '/api/v1/bridge/devices') return answer({ devices: [] });
      if (path === '/api/v1/workspace/monthly-quota') {
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        return answer({
          organizationId: org,
          workspaceId: state.workspace,
          userId: state.viewer,
          displayName: 'Synthetic member',
          monthlyTokenLimit: 5000000,
          usedTokens: 2824029,
          remainingTokens: 2175971,
          remainingPercent: 43.51942,
          unknownUsageRuns: 0,
          periodStart: now,
          resetsAt: now,
          observedAt: now,
        });
      }
      if (path === '/api/v1/workspace/readiness') {
        state.readinessRequests++;
        const snapshot = {
          schemaVersion: 1,
          organizationId: org,
          workspaceId: state.workspace,
          viewerId: state.readinessWrongScope ? id(99) : state.viewer,
          sessionId: url.searchParams.get('sessionId'),
          employeeVersionId: id(8),
          observedAt: new Date().toISOString(),
          basis: 'next_task',
          canAdminister: state.canAdminister,
          capabilities: structuredClone(state.capabilities),
        };
        if (state.readinessDelay && url.searchParams.get('sessionId') === A)
          await state.readinessDelay;
        return answer(snapshot, state.readinessError ? 503 : 200);
      }
      if (path === '/api/v1/runtime/cloud-operations')
        return answer({ operations: [] });
      if (path === '/api/v1/runtime/assistants')
        return answer({ trees: [], nextCursor: null });
      if (path.endsWith('/interactions'))
        return answer({ runtime: null, pendingActions: [], inputs: [] });
      if (path.endsWith('/events')) {
        if (url.searchParams.get('format') === 'json' || !options.running)
          return answer({ events: [] });
        state.streamRequests++;
        await streamGate;
        return route.fulfill({
          contentType: 'text/event-stream',
          body: [
            { type: 'assistant.text.delta', payload: { text: report } },
            { type: 'run.succeeded', payload: {} },
          ]
            .map(
              (event, i) =>
                `data: ${JSON.stringify({
                  schemaVersion: 3,
                  eventId: id(200 + i),
                  organizationId: org,
                  workspaceId: workspace,
                  conversationId: null,
                  runId: run,
                  generation: 1,
                  cursor: `${run}:${i + 1}`,
                  sequence: i + 1,
                  harness: 'dsh',
                  occurredAt: now,
                  sourceEvent: null,
                  ...event,
                })}\n\n`,
            )
            .join(''),
        });
      }
      if (path.endsWith('/artifacts')) {
        const items = path.includes(A) ? [...state.items] : [];
        if (state.delay && path.includes(A)) await state.delay;
        return answer(
          { artifacts: items, nextCursor: null },
          state.listError ? 503 : 200,
        );
      }
      if (path.includes('/artifacts/')) {
        const a = state.items.find((item) => path.includes(item.id));
        if (!a) return answer({}, 404);
        if (path.endsWith('/content'))
          return answer(
            { kind: 'text', mediaType: 'text/markdown', text: state.text },
            state.contentError ? 503 : 200,
          );
        return answer({ artifact: a, feedback: [] });
      }
      if (path === `/api/v1/sessions/${A}` && state.deepLinkDenied)
        return answer({ error: { message: 'Not accessible' } }, 403);
      if (path === `/api/v1/sessions/${A}` || path === `/api/v1/sessions/${B}`)
        return answer({
          history: {
            session: session(path.endsWith(A) ? A : B),
            messages: path.endsWith(A)
              ? [
                  {
                    id: id(20),
                    role: 'assistant',
                    runId: run,
                    status: state.messageStatus,
                    content: {
                      text:
                        state.messageStatus === 'pending' ? '' : state.reply,
                    },
                    createdAt: now,
                  },
                ]
              : [],
            contextStatus: {
              percentage: 0,
              pressureTokens: 0,
              thresholdTokens: 40000,
              compactionDue: false,
            },
            nativeContextStatus: null,
          },
        });
      unexpected.push(path);
      return answer({}, 404);
    });
    await page.goto(
      `${origin}/?session=${options.noSession ? '' : A}${options.disabled ? '&disabled=1' : ''}`,
    );
    await page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
    const panel = page.locator('#artifact-workbench');
    const entry = page.getByRole('button', { name: /▤ 工件与审查/ });
    return {
      context,
      page,
      state,
      errors,
      writes,
      unexpected,
      panel,
      entry,
      finishRun() {
        state.messageStatus = 'completed';
        state.items = [artifact(10)];
        finishStream();
      },
      async reloadList() {
        await entry.click();
        await expect
          .poll(() =>
            page
              .getByRole('button', { name: '刷新列表', exact: true })
              .isEnabled(),
          )
          .toBe(true);
      },
      async close() {
        finishStream();
        await context.close();
        expect(errors).toEqual([]);
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
      },
    };
  }

  it('shows the current member monthly balance alongside the workbench', async () => {
    const f = await fixture();
    try {
      const quota = f.page.locator('summary[aria-label="账号月额度"]');
      await quota.getByText('Synthetic member', { exact: true }).waitFor();
      await quota.getByText('剩余 43%', { exact: true }).waitFor();
      await quota.click();
      await f.page.getByText('本月已记录', { exact: false }).waitFor();
      expect(
        await f.page.locator('details').filter({ has: quota }).innerText(),
      ).toContain('5,000,000');
      await f.page.reload();
      await quota.getByText('剩余 43%', { exact: true }).waitFor();
    } finally {
      await f.close();
    }
  });

  it('resolves chat downloads only for this Run’s authenticated artifacts', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const path = `/api/v1/files/${artifact(10).object.id}/download`;
      f.state.reply = `[下载报告](https://allrice.example${path}?name=wrong)\n\n[原始来源](https://example.org/source)`;
      await f.page.reload();
      const link = f.page.getByRole('link', { name: '下载报告', exact: true });
      await expect
        .poll(() => link.getAttribute('href'))
        .toBe(`${path}?name=report-10.md`);
      expect(await link.getAttribute('target')).toBeNull();
      expect(
        await f.page
          .getByRole('link', { name: '原始来源', exact: true })
          .getAttribute('href'),
      ).toBe('https://example.org/source');
      // Even a known file in the Session cannot resolve another Run's link.
      f.state.items = [
        {
          ...artifact(10),
          provenance: { ...artifact(10).provenance, runId: id(90) },
        },
      ];
      await f.page.reload();
      await expect
        .poll(() => link.getAttribute('href'))
        .toBe(`https://allrice.example${path}?name=wrong`);
    } finally {
      await f.close();
    }
  });

  it(
    'UX01-B keeps all entries visible, distinguishes release-off and preserves drafts without execution',
    { timeout: 20_000 },
    async () => {
      const f = await fixture();
      try {
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
        });
        await composer.fill('保留我的原始问题');
        await f.page
          .getByRole('button', { name: '能力与环境', exact: true })
          .click();
        const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .waitFor();
        expect(
          await dialog
            .locator('[data-capability]')
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute('data-capability')),
            ),
        ).toEqual([...workspaceCapabilityIds]);
        expect(
          await dialog
            .locator('[data-capability="development"]')
            .getAttribute('data-state'),
        ).toBe('not_released');
        expect(
          await dialog
            .locator('[data-capability="assistants"]')
            .getAttribute('data-state'),
        ).toBe('not_released');
        expect(
          await dialog
            .locator('[data-capability="boost"]')
            .getByRole('button', { name: /准备/ })
            .count(),
        ).toBe(0);
        expect(await dialog.getByRole('link', { name: /配置/ }).count()).toBe(
          0,
        );
        await f.page.screenshot({
          path: '/tmp/met147-capabilities-desktop.png',
        });
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .click();
        expect(await composer.inputValue()).toContain('保留我的原始问题');
        expect(await composer.inputValue()).toContain(
          'workspace.export.create',
        );
        await expect
          .poll(() => composer.evaluate((e) => e === document.activeElement))
          .toBe(true);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('UX01-B bridges missing configuration to the real pairing dialog and refreshes on return', async () => {
    const f = await fixture({ width: 390 });
    try {
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      const card = dialog.locator('[data-capability="local_files"]');
      await card
        .getByRole('button', { name: '打开 Bridge 下载与配对' })
        .click();
      const bridge = f.page.getByRole('dialog', { name: '本地工作区' });
      await bridge.waitFor();
      expect(
        await bridge.getByRole('link', { name: /下载 M 芯片版/ }).count(),
      ).toBe(1);
      const calls = f.state.readinessRequests;
      await f.page.keyboard.press('Escape');
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      await dialog.waitFor();
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await dialog.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      expect(
        await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      await f.page.screenshot({
        path: '/tmp/met147-capabilities-mobile.png',
      });
    } finally {
      await f.close();
    }
  });

  it('UX01-B revalidates after settings, protects members, and never treats errors or wrong scope as ready', async () => {
    const f = await fixture();
    try {
      f.state.capabilities = f.state.capabilities.map((c) =>
        c.id === 'cloud_mcp'
          ? {
              ...c,
              state: 'needs_authorization',
              reason: 'connection_grant_missing',
              action: 'mcp_settings',
              responsibleRole: 'tenant_admin',
            }
          : c,
      );
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      await dialog.getByText(/核对时间/).waitFor();
      const mcp = dialog.locator('[data-capability="cloud_mcp"]');
      expect(await mcp.getByRole('link').count()).toBe(0);
      f.state.canAdminister = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      const settings = mcp.getByRole('link', { name: /打开配置/ });
      await settings.waitFor();
      expect(await settings.getAttribute('href')).toBe(
        `/workspace/mcp?workspaceId=${workspace}`,
      );
      expect(await settings.getAttribute('target')).toBe('_blank');
      f.state.capabilities = f.state.capabilities.map((c) =>
        c.id === 'cloud_mcp'
          ? { ...c, state: 'ready', reason: 'ready', action: 'compose' }
          : c,
      );
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await mcp
        .getByRole('button', { name: '准备云端 MCP 连接器任务' })
        .waitFor();
      f.state.readinessError = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
      f.state.readinessError = false;
      f.state.readinessWrongScope = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  });

  it('UX01-B ignores late readiness from a previous session and recovers after a failed check', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      await dialog
        .getByRole('button', { name: '准备报告与文件交付任务' })
        .waitFor();
      f.state.readinessDelay = new Promise<void>((done) => {
        release = done;
      });
      const calls = f.state.readinessRequests;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await f.page.keyboard.press('Escape');
      f.state.capabilities = f.state.capabilities.map((c) => ({
        ...c,
        state: 'not_released',
        reason: 'release_disabled',
        action: 'guide',
        releaseEnabled: false,
      }));
      await f.page.getByRole('button', { name: /研究任务 B/ }).click();
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      await dialog.getByText(/核对时间/).waitFor();
      release();
      expect(
        await dialog
          .locator('[data-capability="report"]')
          .getAttribute('data-state'),
      ).toBe('not_released');
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
      f.state.readinessError = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      f.state.readinessError = false;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog.getByText(/核对时间/).waitFor();
      expect(
        await dialog
          .locator('[data-capability="report"]')
          .getAttribute('data-state'),
      ).toBe('not_released');
    } finally {
      release?.();
      await f.close();
    }
  });

  it(
    'restores the selected Session after reload and removes stale links for new work',
    { timeout: 20_000 },
    async () => {
      const f = await fixture({ artifacts: true });
      try {
        await f.page.getByRole('button', { name: /^研究任务 B/ }).click();
        await expect
          .poll(() => new URL(f.page.url()).searchParams.get('session'))
          .toBe(B);
        await f.page.reload();
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
        await expect
          .poll(() => f.page.locator('h1').first().textContent())
          .toBe('研究任务 B');
        expect(
          await f.panel.getByRole('heading', { name: /COIN/ }).count(),
        ).toBe(0);
        await f.page.getByRole('button', { name: /^研究任务 A/ }).click();
        await f.page.reload();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        expect(new URL(f.page.url()).searchParams.has('session')).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    'resolves a Session outside the sidebar page only through scoped history (denied=%s)',
    async (denied) => {
      const f = await fixture({ artifacts: true });
      try {
        f.state.omitSessionA = true;
        f.state.deepLinkDenied = denied;
        await f.page.reload();
        await expect
          .poll(() => f.page.locator('h1').first().textContent())
          .toBe(denied ? '研究任务 B' : '研究任务 A');
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(
          denied ? B : A,
        );
        if (denied)
          expect(
            await f.panel.getByRole('heading', { name: /COIN/ }).count(),
          ).toBe(0);
        else await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it(
    'automatically presents a newly completed SSE delivery, but never reopens a panel the user closed',
    { timeout: 20_000 },
    async () => {
      for (const closed of [false, true]) {
        const f = await fixture({ running: true });
        try {
          await expect.poll(() => f.state.streamRequests).toBeGreaterThan(0);
          await f.panel.getByText(/这个会话还没有工件/).waitFor();
          if (closed)
            await f.page
              .getByRole('button', { name: '关闭工作台', exact: true })
              .click();
          const composer = f.page.getByRole('textbox', {
            name: '给 Rice 的消息',
          });
          await composer.fill('我的后续问题');
          f.finishRun();
          await f.page.getByText('展开完整回复', { exact: true }).waitFor();
          expect(
            await composer.evaluate((e) => e === document.activeElement),
          ).toBe(true);
          if (closed) {
            expect(await f.panel.count()).toBe(0);
            expect(await f.entry.textContent()).toContain('新工件');
            await f.entry.click();
          }
          await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        } finally {
          await f.close();
        }
      }
    },
  );

  it('shows a real report in a persistent third column, leaves composer focus alone and summarizes the center', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getByRole('table').count()).toBe(1);
      expect(
        await f.page.getByText('展开完整回复', { exact: true }).count(),
      ).toBe(1);
      expect(
        await f.page.evaluate(
          () =>
            getComputedStyle(
              document.querySelector('main')!,
            ).gridTemplateColumns.split(' ').length,
        ),
      ).toBe(3);
      const composer = f.page.getByRole('textbox', {
        name: '给 Rice 的消息',
      });
      await composer.fill('继续核对来源');
      await f.page.screenshot({ path: '/tmp/met147-desktop.png' });
      f.state.items.unshift(artifact(11));
      // Trigger the same existing read-only refresh used after a completed turn.
      await f.page
        .getByRole('button', { name: '刷新列表', exact: true })
        .click();
      await composer.focus();
      await expect
        .poll(() =>
          f.panel.getByRole('combobox', { name: '工件版本' }).inputValue(),
        )
        .toBe(id(11));
      expect(await composer.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      expect(await composer.inputValue()).toBe('继续核对来源');
    } finally {
      await f.close();
    }
  });

  it(
    'remembers explicit closure and sidebar preferences per user/workspace, including blocked storage fallback',
    { timeout: 20_000 },
    async () => {
      const f = await fixture({ artifacts: true });
      try {
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.page
          .getByRole('button', { name: '收起侧边栏', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.reload();
        await f.entry.waitFor();
        expect(await f.panel.count()).toBe(0);
        expect(
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .count(),
        ).toBe(1);
        const value = await f.page.evaluate(
          (key) => localStorage.getItem(key),
          layoutPreferenceKey(user, org, workspace)!,
        );
        expect(JSON.parse(value!)).toEqual({
          sidebarCollapsed: true,
          panelOpen: false,
        });
        f.state.viewer = id(50);
        await f.page.reload();
        await f.panel.waitFor();
        expect(
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .count(),
        ).toBe(1);
        await f.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        f.state.workspace = id(51);
        f.state.items = [];
        await f.page.reload();
        await f.panel.waitFor();
      } finally {
        await f.close();
      }
      const fallback = await fixture({ noStorage: true });
      try {
        await fallback.panel.waitFor();
        await fallback.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        expect(await fallback.panel.count()).toBe(0);
      } finally {
        await fallback.close();
      }
    },
  );

  it('uses a narrow drawer, traps/restores focus, preserves drafts across resize, and has no horizontal overflow', async () => {
    const f = await fixture({ width: 390, artifacts: true });
    try {
      expect(await f.panel.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '任务与历史' }).waitFor();
      const quota = f.page.locator('summary[aria-label="账号月额度"]');
      await quota.getByText('剩余 43%', { exact: true }).waitFor();
      await quota.focus();
      await f.page.keyboard.press('Tab');
      expect(
        await f.page
          .getByRole('dialog', { name: '任务与历史' })
          .evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      await f.page.keyboard.press('Shift+Tab');
      expect(await quota.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      await f.page.keyboard.press('Escape');
      expect(
        await f.page.getByRole('dialog', { name: '任务与历史' }).count(),
      ).toBe(0);
      await f.entry.click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getAttribute('role')).toBe('dialog');
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await f.panel.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await f.entry.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      expect(await f.panel.count()).toBe(0);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.panel.waitFor();
      const opinion =
        f.panel.getByPlaceholder('提出修改意见，或说明需要澄清的地方…');
      await opinion.fill('保留我的意见');
      await f.page.setViewportSize({ width: 390, height: 844 });
      expect(await opinion.inputValue()).toBe('保留我的意见');
      expect(await f.panel.getAttribute('role')).toBe('dialog');
      await f.page.screenshot({ path: '/tmp/met147-mobile.png' });
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      f.page.once('dialog', (d) => d.dismiss());
      await f.page.keyboard.press('Escape');
      expect(await opinion.inputValue()).toBe('保留我的意见');
    } finally {
      await f.close();
    }
  });

  it('protects review drafts and explicit version selection on new artifacts, including list failure/retry', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const opinion =
        f.panel.getByPlaceholder('提出修改意见，或说明需要澄清的地方…');
      await opinion.fill('需要补充来源');
      f.state.items.unshift(artifact(11));
      await f.reloadList();
      expect(
        await f.panel.getByRole('combobox', { name: '工件版本' }).inputValue(),
      ).toBe(id(10));
      await f.panel.getByRole('button', { name: '查看新工件' }).waitFor();
      expect(await opinion.inputValue()).toBe('需要补充来源');
      f.state.listError = true;
      await f.entry.click();
      await f.panel.getByRole('alert').waitFor();
      expect(await opinion.inputValue()).toBe('需要补充来源');
      f.state.listError = false;
      await f.reloadList();
      f.page.once('dialog', (d) => d.accept());
      await f.panel.getByRole('button', { name: '查看新工件' }).click();
      await expect
        .poll(() =>
          f.panel.getByRole('combobox', { name: '工件版本' }).inputValue(),
        )
        .toBe(id(11));
      f.state.items.unshift(artifact(12));
      await f.reloadList();
      expect(
        await f.panel.getByRole('combobox', { name: '工件版本' }).inputValue(),
      ).toBe(id(11));
      await f.panel.getByRole('button', { name: '查看新工件' }).waitFor();
    } finally {
      await f.close();
    }
  });

  it('marks legacy replies as read-only message previews and clears them on session switch; empty work still has an entry', async () => {
    const f = await fixture();
    try {
      await f.page
        .getByRole('button', { name: '在工作台预览回复（非工件）' })
        .click();
      await f.panel
        .getByText('这是会话回复，非已发布工件；没有工件版本或落盘证明。', {
          exact: true,
        })
        .waitFor();
      expect(await f.panel.getByRole('combobox').count()).toBe(0);
      await f.page.getByRole('button', { name: /^研究任务 B/ }).click();
      await f.panel.getByText(/这个会话还没有工件/).waitFor();
      expect(await f.panel.getByRole('heading', { name: /COIN/ }).count()).toBe(
        0,
      );
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      await f.panel.getByText(/开始或选择一项工作/).waitFor();
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.entry.click();
      await f.panel.getByText(/开始或选择一项工作/).waitFor();
    } finally {
      await f.close();
    }
  });

  it('rejects late cross-session responses and renders content failure/retry without executing HTML or external images', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      let release!: () => void;
      f.state.delay = new Promise<void>((done) => {
        release = done;
      });
      await f.entry.click();
      await f.page.getByRole('button', { name: /^研究任务 B/ }).click();
      await f.panel.getByText(/这个会话还没有工件/).waitFor();
      release();
      f.state.delay = null;
      expect(await f.panel.getByRole('heading', { name: /COIN/ }).count()).toBe(
        0,
      );
      f.state.contentError = true;
      await f.page.getByRole('button', { name: /^研究任务 A/ }).click();
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .waitFor();
      f.state.contentError = false;
      f.state.text =
        '# Safe report\n<script>window.BAD = true</script>\n\n![tracking](https://example.com/tracker.png)\n\n[bad](javascript:alert(1))';
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .click();
      await f.panel.getByRole('heading', { name: 'Safe report' }).waitFor();
      expect(
        await f.panel
          .locator('img,iframe,script,a[href^="javascript:"]')
          .count(),
      ).toBe(0);
      f.state.text = '较长的安全原文\n'.repeat(1700);
      f.state.items.unshift(artifact(12));
      await f.reloadList();
      await f.panel.getByLabel('正文（分页只读）', { exact: true }).waitFor();
      expect(
        await f.panel
          .getByLabel('正文（分页只读）', { exact: true })
          .locator('code')
          .count(),
      ).toBe(100);
    } finally {
      await f.close();
    }
  });

  it('keeps the existing feature gate and does not invent artifacts from streaming / failed messages', async () => {
    const off = await fixture({ disabled: true });
    try {
      expect(await off.panel.count()).toBe(0);
      expect(await off.entry.count()).toBe(0);
    } finally {
      await off.close();
    }
    const f = await fixture();
    try {
      f.state.messageStatus = 'pending';
      await f.page.reload();
      await f.entry.waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
      expect(
        await f.page.getByText('展开完整回复', { exact: true }).count(),
      ).toBe(0);
      f.state.messageStatus = 'failed';
      await f.page.reload();
      await f.page.getByText('这次没有完成。', { exact: true }).waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
});
