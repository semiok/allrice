import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeSubagentSummary } from '@allrice/contracts';
import { NativeSubagentFixtureFeed } from '../../test/native-subagent-fixture-feed';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
function summary(
  rootId: string,
  running: boolean | null,
): NativeSubagentSummary {
  return {
    rootId,
    root: { source: 'live', cursor: 1 },
    descendants: [
      {
        kind: 'child',
        id: 'same-child',
        parentId: rootId,
        depth: 1,
        mode: 'continuable',
        running,
        activity: running === null ? 'unknown' : 'running',
        observation: { source: 'live', cursor: 1 },
        task: `${rootId} own task`,
        timing: { settledMs: 0 },
        usage: {
          uncachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        },
        lastReply: null,
      },
    ],
  };
}
const row = (page: Page, id: string) =>
  page.locator(`[data-row-key="session:${id}"]`);

suite('native child IDs retain the parent Session namespace', () => {
  let browser: Browser, server: Server, origin: string;
  const reads: Record<string, NativeSubagentSummary | null> = {
    'parent-a': summary('root-a', true),
    'parent-b': summary('root-b', false),
    'parent-c': null,
  };
  const feed = new NativeSubagentFixtureFeed();
  const fixture = feed.register({ summary: (id) => reads[id] ?? null });
  const requests: {
    sessionId: string;
    workspaceId: string | null;
    organization: string | string[] | undefined;
    workspace: string | string[] | undefined;
    childId: string | null;
  }[] = [];
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
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
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
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
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/v1/sessions/')) {
        const sessionId = url.pathname.split('/')[4]!;
        requests.push({
          sessionId,
          workspaceId: url.searchParams.get('workspaceId'),
          organization: req.headers['x-allrice-organization-id'],
          workspace: req.headers['x-allrice-workspace-id'],
          childId: url.searchParams.get('childId'),
        });
        if (feed.handle(req, res)) return;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ summary: reads[sessionId] ?? null }));
        return;
      }
      const asset = assets.get(url.pathname);
      res.setHeader(
        'Content-Type',
        asset
          ? url.pathname.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/native-subagent-page.css"><div id="root"></div><script type="module" src="/native-subagent-page.js"></script>',
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
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  it('keeps my running child visible while another parent updates its same-ID child, and selects each raw native ID in its own tree', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.route('**/api/v1/sessions/*/subagents?**', (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('follow') === 'true')
          url.searchParams.set('fixture', fixture);
        return route.continue({ url: String(url) });
      });
      await page.goto(origin);
      await expect
        .poll(() =>
          [...new Set(requests.map((request) => request.sessionId))].sort(),
        )
        .toEqual(['parent-a', 'parent-b', 'parent-c']);
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .toContain('1 个子智能体运行中');
      expect(await row(page, 'parent-b').innerText()).not.toContain(
        '子智能体运行中',
      );
      await expect
        .poll(() =>
          [...feed.connections].some(
            (connection) =>
              connection.sessionId === 'parent-b' && !connection.childId,
          ),
        )
        .toBe(true);
      for (const running of [true, false, null]) {
        reads['parent-b'] = summary('root-b', running);
        feed.push(
          fixture,
          { type: 'directory', summary: reads['parent-b'] },
          null,
          'parent-b',
        );
        if (running === true)
          await expect
            .poll(() => row(page, 'parent-b').innerText())
            .toContain('1 个子智能体运行中');
        else
          await expect
            .poll(() => row(page, 'parent-b').innerText())
            .not.toContain('子智能体运行中');
        await expect
          .poll(() => row(page, 'parent-a').innerText())
          .toContain('1 个子智能体运行中');
      }
      await row(page, 'parent-b').hover();
      await expect
        .poll(() =>
          page
            .getByRole('button', {
              name: '复制: parent-b 父级任务',
              exact: true,
            })
            .innerText(),
        )
        .toContain('子智能体当前活动状态未知');

      for (const id of ['parent-a', 'parent-b']) {
        const root = id === 'parent-a' ? 'root-a' : 'root-b';
        if (id === 'parent-b') await row(page, id).click();
        const trigger = page.getByRole('button', {
          name:
            id === 'parent-a'
              ? '1 个子智能体 · 1 个运行中'
              : '1 个子智能体 · 运行状态未知',
          exact: true,
        });
        await trigger.waitFor();
        await trigger.click();
        const native = page.getByRole('button', {
          name: '查看same-child摘要',
          exact: true,
        });
        await native.waitFor();
        expect(await native.getAttribute('data-child')).toBe('same-child');
        expect(await native.getAttribute('data-parent')).toBe(root);
        await native.click();
        const detail = page.getByRole('complementary', {
          name: '子智能体摘要',
        });
        await expect
          .poll(() => detail.innerText())
          .toContain(`${root} own task`);
        if (id === 'parent-b') {
          expect(await detail.innerText()).toContain('当前活动状态未知');
          expect(await detail.innerText()).not.toContain('root-a own task');
        }
        await page.keyboard.press('Escape');
      }
      expect(
        requests.every(
          (request) =>
            request.workspaceId === 'workspace' &&
            request.organization === 'org' &&
            request.workspace === 'workspace',
        ),
      ).toBe(true);
      expect(
        requests.every(
          (request) =>
            ['parent-a', 'parent-b', 'parent-c'].includes(request.sessionId) &&
            (request.childId === null || request.childId === 'same-child'),
        ),
      ).toBe(true);
      expect(
        requests
          .filter((request) => request.childId)
          .map((request) => [request.sessionId, request.childId]),
      ).toEqual([
        ['parent-a', 'same-child'],
        ['parent-b', 'same-child'],
      ]);
      expect(reads['parent-b']?.descendants[0]).toMatchObject({
        id: 'same-child',
        running: null,
      });
      expect(
        await page.getByRole('navigation', { name: '业务会话' }).innerText(),
      ).not.toContain('same-child');
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
