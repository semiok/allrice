import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeSubagentSummary } from '@allrice/contracts';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const summary: NativeSubagentSummary = {
  rootId: 'root',
  root: { source: 'live', cursor: 8 },
  descendants: [
    ['child', 'root', true],
    ['resident-idle', 'root', false],
    ['grandchild', 'child', true],
  ].map(([id, parentId, running]) => ({
    kind: 'child',
    id: id as string,
    parentId: parentId as string,
    depth: id === 'grandchild' ? 2 : 1,
    mode: 'continuable',
    activity: 'running',
    running: running as boolean,
    observation: { source: 'live', cursor: 8 },
    timing: { settledMs: 0 },
    lastReply: null,
    usage: {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  })),
};
suite('visible parent native running badges', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/native-subagent-sidebar-page.tsx'],
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
      const path = new URL(req.url!, origin).pathname,
        asset = assets.get(path);
      res.setHeader(
        'Content-Type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/native-subagent-sidebar-page.css"><div id="root"></div><script type="module" src="/native-subagent-sidebar-page.js"></script>',
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

  it('reads unselected visible parents, counts direct native running while the root is idle and keeps children out of business rows', async () => {
    const page = await browser.newPage(),
      calls: string[] = [];
    try {
      await page.route('**/api/v1/sessions/*/subagents?**', async (route) => {
        const url = new URL(route.request().url()),
          id = url.pathname.split('/')[4]!;
        expect(url.searchParams.get('liveOnly')).toBe('true');
        expect(route.request().headers()['x-allrice-workspace-id']).toBe(
          'workspace',
        );
        calls.push(id);
        await route.fulfill({
          json: { summary: id === 'parent-c' ? null : summary },
        });
      });
      await page.goto(origin);
      await expect
        .poll(() => [...new Set(calls)].sort())
        .toEqual(['parent-a', 'parent-b', 'parent-c']);
      for (const id of ['parent-a', 'parent-b'])
        await expect
          .poll(() =>
            page.locator(`[data-row-key="session:${id}"]`).innerText(),
          )
          .toContain('1 个子智能体运行中');
      expect(await page.getByRole('treeitem').count()).toBe(4);
      expect(await page.getByRole('navigation').innerText()).not.toMatch(
        /resident-idle|grandchild/,
      );
      expect(await page.getByLabel('子智能体当前活动状态未知').count()).toBe(1);
      expect(calls).toHaveLength(3);
    } finally {
      await page.close();
    }
  });

  it('removes stale positive counts after an unknown observation, failure or offline transition', async () => {
    const page = await browser.newPage();
    let result: NativeSubagentSummary | null | 'error' = summary;
    try {
      await page.route('**/api/v1/sessions/*/subagents?**', async (route) => {
        if (result === 'error')
          return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        await route.fulfill({ json: { summary: result } });
      });
      await page.goto(origin);
      const nav = page.getByRole('navigation');
      await expect.poll(() => nav.innerText()).toContain('1 个子智能体运行中');
      result = null;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(() => page.getByLabel('子智能体当前活动状态未知').count())
        .toBe(3);
      expect(await nav.innerText()).not.toContain('子智能体运行中');
      result = summary;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => nav.innerText()).toContain('1 个子智能体运行中');
      result = 'error';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(() => page.getByLabel('子智能体状态读取失败').count())
        .toBe(3);
      expect(await nav.innerText()).not.toContain('子智能体运行中');
      result = summary;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => nav.innerText()).toContain('1 个子智能体运行中');
      await page.context().setOffline(true);
      await expect.poll(() => nav.innerText()).not.toContain('子智能体运行中');
    } finally {
      await page.close();
    }
  });
});
