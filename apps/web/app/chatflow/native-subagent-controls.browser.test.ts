/** Real directory, root SSE, fetch and Chrome; loopback protocol fixture, no model/DB/Dev. */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChatFlowEventEnvelope,
  NativeSubagentControlTicket,
  NativeSubagentSummary,
} from '@allrice/contracts';
import { NativeSubagentFixtureFeed } from '../../test/native-subagent-fixture-feed';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const runId = '44444444-4444-4444-8444-444444444444';
const summary: NativeSubagentSummary = {
  rootId: 'native-root',
  root: { source: 'live', cursor: 10 },
  descendants: ['甲', '乙', '闲置', '一次性'].map((label, index) => ({
    kind: 'child',
    id: `native-child-${index}`,
    parentId: 'native-root',
    depth: 1,
    mode: index === 3 ? 'one-shot' : 'continuable',
    label,
    running: index !== 2,
    activity: index === 2 ? 'inactive' : 'running',
    observation: { source: 'live', cursor: 8 },
    task: `${label}自己的任务`,
    timing: { settledMs: 0 },
    usage: {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  })),
};
type Mode =
  | 'accepted'
  | 'recorded'
  | 'unknown'
  | 'rejected'
  | 'drop'
  | 'bad-json'
  | 'wrong-id'
  | 'wrong-kind'
  | 'wrong-acceptance'
  | 'forbidden'
  | 'conflict'
  | 'closed'
  | 'server-error';
type Body = {
  rootRunId: string;
  generation: number;
  input: {
    requestId: string;
    kind: 'interrupt';
    parentSessionId: string;
    childSessionId: string;
    mode: 'continuable';
  };
};
type Scenario = {
  feedId: string;
  mode: Mode;
  getMode: Mode;
  posts: Body[];
  gets: string[];
  gate?: Promise<void>;
  release?: () => void;
};
function result(mode: Mode): NativeSubagentControlTicket['result'] {
  if (mode === 'recorded' || mode === 'unknown') return { status: mode };
  if (mode === 'rejected')
    return { status: 'rejected', code: 'subagent/unauthorized' };
  return {
    status: 'accepted',
    acceptance: { kind: 'interrupt', accepted: true },
    source: { kind: 'native_ack' },
  };
}

suite('native child Stop request identity and truthful receipts', () => {
  let browser: Browser, server: Server, origin: string;
  const feed = new NativeSubagentFixtureFeed();
  const scenarios = new Map<string, Scenario>();
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const bundle = await build({
      entryPoints: ['apps/web/test/native-subagent-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const assets = new Map<string, Uint8Array>(
      bundle.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    const globals = await build({
      stdin: {
        contents: [
          ...readFileSync('apps/web/app/layout.tsx', 'utf8').matchAll(
            /^import '([^']+\.css)';$/gm,
          ),
        ]
          .map((match) => `@import '${match[1]}';`)
          .join('\n'),
        resolveDir: resolve('apps/web/app'),
        loader: 'css',
      },
      bundle: true,
      write: false,
    });
    assets.set('/layout.css', globals.outputFiles[0]!.contents);
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const id =
        url.searchParams.get('fixture') ??
        req.headers.cookie?.match(/controls-fixture=([^;]+)/)?.[1];
      const scenario = id ? scenarios.get(id) : undefined;
      if (
        scenario &&
        (url.pathname.startsWith('/api/v1/runs/') ||
          url.searchParams.get('follow') === 'true')
      ) {
        url.searchParams.set('fixture', scenario.feedId);
        req.url = url.pathname + url.search;
        if (feed.handle(req, res)) return;
      }
      if (scenario && url.pathname.endsWith('/subagents/controls')) {
        const post = req.method === 'POST';
        let body: Body | undefined;
        if (post) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
          scenario.posts.push(body);
          await scenario.gate;
        }
        const requestId =
          body?.input.requestId ?? url.searchParams.get('requestId')!;
        if (!post) scenario.gets.push(requestId);
        const mode = post ? scenario.mode : scenario.getMode;
        if (mode === 'drop') {
          res.destroy();
          return;
        }
        const code =
          mode === 'forbidden'
            ? 'AUTHORIZATION_DENIED'
            : mode === 'conflict'
              ? 'CHILD_CONTROL_CONFLICT'
              : 'CHILD_CONTROL_UNAVAILABLE';
        const status =
          mode === 'forbidden'
            ? 403
            : mode === 'conflict' || mode === 'closed'
              ? 409
              : mode === 'server-error'
                ? 503
                : 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        if (status !== 200) {
          res.end(JSON.stringify({ error: { code } }));
          return;
        }
        if (mode === 'bad-json') {
          res.end('unreadable');
          return;
        }
        const ticket = {
          requestId: mode === 'wrong-id' ? randomUUID() : requestId,
          kind: mode === 'wrong-kind' ? 'prompt' : 'interrupt',
          result:
            mode === 'wrong-acceptance'
              ? {
                  status: 'accepted',
                  acceptance: { kind: 'prompt', messageId: 'message' },
                  source: { kind: 'native_ack' },
                }
              : result(mode),
        };
        res.end(JSON.stringify({ ticket }));
        return;
      }
      if (scenario && url.pathname.endsWith('/subagents')) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ summary }));
        return;
      }
      const asset = assets.get(url.pathname);
      res.setHeader(
        'content-type',
        asset
          ? url.pathname.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      if (id && !asset)
        res.setHeader(
          'set-cookie',
          `controls-fixture=${id}; Path=/; SameSite=Lax`,
        );
      res.end(
        asset ??
          '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/native-subagent-page.css"><div id="root"></div><script type="module" src="/native-subagent-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(
      new URL('../../../worker/package.json', import.meta.url),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  });
  afterAll(async () => {
    for (const scenario of scenarios.values()) scenario.release?.();
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  function rootEvent(
    scenario: Scenario,
    type: 'turn.started' | 'run.succeeded',
    sequence: number,
  ) {
    feed.pushRoot(scenario.feedId, {
      schemaVersion: 3,
      eventId: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: null,
      runId,
      generation: 7,
      cursor: `${runId}:${sequence}`,
      sequence,
      harness: 'dsh',
      type,
      occurredAt: '2026-10-31T00:00:00Z',
      sourceEvent: null,
      payload: { turnId: 'root-turn', generation: 7 },
    } satisfies ChatFlowEventEnvelope);
  }
  async function open(mode: Mode = 'accepted', hold = false, start = true) {
    const scenario: Scenario = {
      feedId: feed.register({ summary: () => summary }),
      mode,
      getMode: 'accepted',
      posts: [],
      gets: [],
    };
    if (hold)
      scenario.gate = new Promise<void>((done) => {
        scenario.release = done;
      });
    const id = String(scenarios.size + 1);
    scenarios.set(id, scenario);
    const page = await browser.newPage({
      viewport: { width: 390, height: 850 },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?controls&fixture=${id}`);
    await expect
      .poll(
        () =>
          [...feed.rootConnections].filter((c) => c.fixture === scenario.feedId)
            .length,
      )
      .toBe(1);
    if (start) rootEvent(scenario, 'turn.started', 1);
    await show(page, '甲');
    return { page, scenario, errors };
  }
  async function show(page: Page, label: string) {
    await page.getByRole('button', { name: /4 个子智能体/ }).click();
    await page
      .getByRole('button', { name: `查看${label}摘要`, exact: true })
      .click();
    await page.getByRole('complementary', { name: '子智能体摘要' }).waitFor();
  }
  const detail = (page: Page) =>
    page.getByRole('complementary', { name: '子智能体摘要' });
  const receipt = (page: Page) =>
    detail(page).locator('[aria-label="Stop 回执"]');

  it('“只停甲”：double click and detail close/reopen retain one request; accepted is not stopped', async () => {
    const { page, scenario, errors } = await open('accepted', true);
    try {
      await detail(page)
        .getByRole('button', { name: 'Stop 此子任务', exact: true })
        .dblclick();
      await expect.poll(() => scenario.posts.length).toBe(1);
      await detail(page).getByRole('button', { name: '关闭摘要' }).focus();
      await page.keyboard.press('Escape');
      expect(
        await page
          .getByRole('button', { name: /4 个子智能体/ })
          .evaluate((button) => document.activeElement === button),
      ).toBe(true);
      await show(page, '甲');
      expect(
        await detail(page)
          .getByRole('button', { name: '发起新的 Stop 请求' })
          .isDisabled(),
      ).toBe(true);
      scenario.release!();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收；不代表子任务已经停止。');
      expect(scenario.posts).toHaveLength(1);
      expect(scenario.posts[0]).toMatchObject({
        rootRunId: runId,
        generation: 7,
        input: {
          parentSessionId: 'native-root',
          childSessionId: 'native-child-0',
          mode: 'continuable',
          kind: 'interrupt',
        },
      });
      expect(scenario.posts[0]!.input.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(await receipt(page).locator('code').textContent()).toBe(
        scenario.posts[0]!.input.requestId,
      );
      expect(await detail(page).textContent()).toContain('运行摘要 · 运行中');
      await page.keyboard.press('Escape');
      await show(page, '乙');
      expect(await detail(page).textContent()).toContain('乙自己的任务');
      expect(await receipt(page).count()).toBe(0);
      expect(scenario.gets).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      scenario.release?.();
      await page.close();
    }
  });

  it('unknown is queried by the original ID; an explicit independent Stop keeps the old receipt', async () => {
    const { page, scenario } = await open('unknown');
    try {
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('原生接收结果未知');
      const id = scenario.posts[0]!.input.requestId;
      scenario.getMode = 'unknown';
      await detail(page).getByRole('button', { name: '查看回执' }).click();
      await expect.poll(() => scenario.gets).toEqual([id]);
      await expect
        .poll(() => detail(page).textContent())
        .toContain('原生接收结果未知');
      expect(scenario.posts).toHaveLength(1);
      scenario.mode = 'accepted';
      await detail(page)
        .getByRole('button', { name: '发起新的 Stop 请求' })
        .click();
      await expect.poll(() => scenario.posts.length).toBe(2);
      await expect.poll(() => receipt(page).count()).toBe(2);
      expect(scenario.posts[1]!.input.requestId).not.toBe(id);
      expect(await receipt(page).first().textContent()).toContain(
        '原生接收结果未知',
      );
    } finally {
      await page.close();
    }
  });

  it('reload restores only query references and never a cached confirmation or POST', async () => {
    const { page, scenario } = await open();
    try {
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收');
      const id = scenario.posts[0]!.input.requestId;
      const stored = await page.evaluate(() =>
        Object.entries(sessionStorage)
          .filter(([key]) => key.startsWith('allrice-child-control-refs:'))
          .map(([, value]) => JSON.parse(value)),
      );
      expect(stored).toEqual([[scenario.posts[0]]]);
      await page.reload();
      await show(page, '甲');
      expect(await detail(page).textContent()).toContain('尚无确认结果');
      expect(await detail(page).textContent()).not.toContain('停止请求已接收');
      expect(scenario.posts).toHaveLength(1);
      await detail(page).getByRole('button', { name: '查看回执' }).click();
      await expect.poll(() => scenario.gets).toEqual([id]);
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收');
      expect(scenario.posts).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('current root/owner gate new actions while a closed root still permits original-ticket GET', async () => {
    const { page, scenario } = await open('unknown', false, false);
    try {
      const stop = detail(page).getByRole('button', { name: 'Stop 此子任务' });
      expect(await stop.isDisabled()).toBe(true);
      rootEvent(scenario, 'turn.started', 1);
      await expect.poll(() => stop.isEnabled()).toBe(true);
      await stop.click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('原生接收结果未知');
      rootEvent(scenario, 'run.succeeded', 2);
      await expect
        .poll(() => detail(page).textContent())
        .toContain('当前没有可控制的根运行');
      expect(
        await detail(page)
          .getByRole('button', { name: '发起新的 Stop 请求' })
          .isDisabled(),
      ).toBe(true);
      await detail(page).getByRole('button', { name: '查看回执' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收');
      await page.getByRole('button', { name: '切换会话所有者' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('仅会话所有者可控制');
      expect(
        await detail(page)
          .getByRole('button', { name: '查看回执' })
          .isDisabled(),
      ).toBe(true);
      expect(scenario.posts).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('native idle/one-shot details have no Stop or message composer', async () => {
    const { page, scenario } = await open();
    try {
      for (const label of ['闲置', '一次性']) {
        await page.keyboard.press('Escape');
        await show(page, label);
        expect(
          await detail(page).getByRole('button', { name: /Stop/ }).count(),
        ).toBe(0);
        expect(await detail(page).getByRole('textbox').count()).toBe(0);
      }
      expect(scenario.posts).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it.each([
    'drop',
    'bad-json',
    'wrong-id',
    'wrong-kind',
    'wrong-acceptance',
    'server-error',
  ] as const)(
    '%s never fabricates acceptance and only GET recovers the original request',
    async (mode) => {
      const { page, scenario } = await open(mode);
      try {
        await detail(page)
          .getByRole('button', { name: 'Stop 此子任务' })
          .click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain('提交结果未知');
        expect(await detail(page).textContent()).not.toContain(
          '停止请求已接收',
        );
        const id = scenario.posts[0]!.input.requestId;
        await detail(page).getByRole('button', { name: '查看回执' }).click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain('停止请求已接收');
        expect(scenario.gets).toEqual([id]);
        expect(scenario.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    ['rejected', '请求被拒绝：subagent/unauthorized'],
    ['forbidden', '当前没有控制此子任务的权限。'],
    ['conflict', '请求 ID 与原请求冲突。'],
    ['closed', '根运行或控制权限已变化。'],
    ['recorded', '请求已记录，等待原生回执。'],
  ] as const)(
    '%s displays the actual refusal or recorded state',
    async (mode, text) => {
      const { page, scenario } = await open(mode);
      try {
        await detail(page)
          .getByRole('button', { name: 'Stop 此子任务' })
          .click();
        await expect.poll(() => detail(page).textContent()).toContain(text);
        expect(await detail(page).textContent()).not.toContain(
          '停止请求已接收',
        );
        expect(scenario.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    },
  );
});
