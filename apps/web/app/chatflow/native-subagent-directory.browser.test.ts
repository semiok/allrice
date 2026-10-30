import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeSubagentSummary } from '@allrice/contracts';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Child = Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
>;
function child(
  id: string,
  parentId: string,
  overrides: Partial<Child> = {},
): Child {
  return {
    kind: 'child',
    id,
    parentId,
    depth: 1,
    mode: 'continuable',
    label: id,
    running: false,
    activity: 'running',
    observation: { source: 'live', cursor: 8 },
    title: `${id} 自有标题`,
    task: `${id} 自己的初始任务`,
    timing: {
      settledMs: 2000,
      active: { since: 1000, through: 4000 },
      lastTurnCompleted: true,
    },
    usage: {
      uncachedInputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      outputTokens: 40,
    },
    lastReply: `${id} 自己的最后回复`,
    ...overrides,
  };
}
function summary(rootId = 'native-root'): NativeSubagentSummary {
  return {
    rootId,
    root: { source: 'live', cursor: 10 },
    descendants: [
      child('fork-a', rootId, { running: true, timing: { settledMs: 0 } }),
      child('idle-b', rootId),
      child('grandchild', 'fork-a', { depth: 2, running: true }),
    ],
  };
}

suite('native subagent directory and employee sidebar', () => {
  let browser: Browser, server: Server, origin: string;
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
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  async function open(
    value = summary(),
    width = 1200,
    fullReply?: { gate: Promise<void>; delivered: () => void },
  ) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const calls: { id: string; liveOnly: boolean }[] = [];
    let response: NativeSubagentSummary | 'error' = value;
    await page.route('**/api/v1/sessions/*/subagents?**', async (route) => {
      const url = new URL(route.request().url()),
        id = url.pathname.split('/')[4]!,
        liveOnly = url.searchParams.get('liveOnly') === 'true';
      calls.push({ id, liveOnly });
      expect(route.request().headers()['x-allrice-organization-id']).toBe(
        'org',
      );
      if (response === 'error')
        return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      const read =
        id === 'parent-c' && liveOnly
          ? null
          : id === 'parent-b'
            ? summary('other-root')
            : liveOnly && response.root.source === 'prepared'
              ? null
              : response;
      if (!liveOnly) await fullReply?.gate;
      await route.fulfill({ json: { summary: read } });
      if (!liveOnly) fullReply?.delivered();
    });
    await page.goto(origin);
    await page
      .getByRole('button', {
        name:
          value.root.source === 'prepared'
            ? '子智能体状态未知'
            : /2 个子智能体/,
      })
      .waitFor();
    return {
      page,
      calls,
      setResponse: (next: NativeSubagentSummary | 'error') => {
        response = next;
      },
    };
  }
  const row = (page: Page, id: string) =>
    page.locator(`[data-row-key="session:${id}"]`);

  it('probes every visible parent without cold reads, counts direct native running and hides children from business navigation', async () => {
    const { page, calls } = await open();
    try {
      await expect
        .poll(() =>
          calls
            .filter((call) => call.liveOnly)
            .map((call) => call.id)
            .sort(),
        )
        .toEqual(['parent-a', 'parent-a', 'parent-b', 'parent-c']);
      expect(
        calls.filter((call) => !call.liveOnly).map((call) => call.id),
      ).toEqual([]);
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .toContain('1 个子智能体运行中');
      expect(await row(page, 'parent-b').innerText()).toContain(
        '1 个子智能体运行中',
      );
      expect(
        await page.getByRole('navigation', { name: '业务会话' }).innerText(),
      ).not.toMatch(/fork-a|idle-b|grandchild/);
      await row(page, 'parent-c').hover();
      await expect
        .poll(() =>
          page
            .getByRole('button', {
              name: '复制: parent-c 父级任务',
              exact: true,
            })
            .innerText(),
        )
        .toContain('子智能体当前活动状态未知');
      const trigger = page.getByRole('button', {
        name: '2 个子智能体 · 1 个运行中',
        exact: true,
      });
      await trigger.click();
      await page.getByRole('button', { name: '查看idle-b摘要' }).waitFor();
      expect(
        calls.filter((call) => !call.liveOnly).map((call) => call.id),
      ).toEqual(['parent-a']);
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).innerText(),
      ).toContain('上次回合已完成');
      expect(
        await page.getByRole('button', { name: '查看grandchild摘要' }).count(),
      ).toBe(0);
      await page.getByRole('button', { name: '展开fork-a' }).click();
      await page.getByRole('button', { name: '查看grandchild摘要' }).waitFor();
      expect(await trigger.innerText()).toBe('2 个子智能体 · 1 个运行中');
      await page.getByRole('button', { name: '查看fork-a摘要' }).click();
      const detail = page.getByRole('complementary', { name: '子智能体摘要' });
      expect(await detail.innerText()).toContain('fork-a 自己的初始任务');
      expect(await detail.innerText()).toContain('fork-a 自己的最后回复');
      expect(await detail.innerText()).not.toContain('父级任务');
      expect(await detail.innerText()).not.toContain('上次回合已完成');
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe(
        'parent-a 父级任务',
      );
      await page.keyboard.press('Escape');
      expect(await detail.count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('supports hover, pinning, tree keyboard navigation and Escape across clipped header actions', async () => {
    const { page } = await open();
    try {
      const trigger = page.getByRole('button', { name: /2 个子智能体/ });
      await trigger.hover();
      await page.getByRole('tree', { name: '子智能体目录' }).waitFor();
      await page.getByRole('button', { name: '查看idle-b摘要' }).hover();
      await page.waitForTimeout(180);
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(1);
      await page.mouse.move(1100, 800);
      await expect
        .poll(() => page.getByRole('tree', { name: '子智能体目录' }).count())
        .toBe(0);
      await trigger.click();
      await page.mouse.move(1100, 800);
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(1);
      const first = page.getByRole('button', { name: '查看fork-a摘要' });
      await first.focus();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('button', { name: '查看grandchild摘要' }).waitFor();
      await page.keyboard.press('End');
      await expect
        .poll(() =>
          page
            .getByRole('button', { name: '查看idle-b摘要' })
            .evaluate((node) => node === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press('Escape');
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(0);
      expect(
        await trigger.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => first.evaluate((node) => node === document.activeElement))
        .toBe(true);
      await page.keyboard.press('Escape');
    } finally {
      await page.close();
    }
  });

  it.each(['select', 'Escape', 'outside', 'scope'])(
    'preserves keyboard intent during a delayed cold read (%s)',
    async (action) => {
      const cold = summary();
      cold.root.source = 'prepared';
      cold.descendants = cold.descendants.map((entry) => ({
        ...entry,
        running: null,
        observation: { source: 'prepared', cursor: 8 },
      }));
      let release!: () => void, receive!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const delivered = new Promise<void>((done) => {
        receive = done;
      });
      const { page, calls } = await open(cold, 1200, {
        gate,
        delivered: receive,
      });
      try {
        const trigger = page.locator('button[aria-haspopup="tree"]');
        const first = page.getByRole('button', { name: '查看fork-a摘要' });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect
          .poll(() => calls.filter((c) => !c.liveOnly).length)
          .toBe(1);
        await page
          .getByText('正在读取子智能体摘要…', { exact: true })
          .waitFor();
        await page.keyboard.press('ArrowDown');
        expect(await first.count()).toBe(0);
        if (action === 'Escape') await page.keyboard.press('Escape');
        else if (action === 'outside')
          await page.getByRole('heading', { level: 1 }).click();
        else if (action === 'scope') {
          await row(page, 'parent-b').focus();
          await page.keyboard.press('Enter');
        }
        release();
        await delivered;
        if (action === 'select') {
          await expect
            .poll(() =>
              first.evaluate((node) => node === document.activeElement),
            )
            .toBe(true);
          await page.keyboard.press('Enter');
          const detail = page.getByRole('complementary', {
            name: '子智能体摘要',
          });
          expect(await detail.innerText()).toContain('fork-a 自己的初始任务');
        } else {
          expect(await trigger.getAttribute('aria-expanded')).toBe('false');
          expect(
            await page.getByRole('tree', { name: '子智能体目录' }).count(),
          ).toBe(0);
          expect(
            await page
              .getByRole('complementary', { name: '子智能体摘要' })
              .count(),
          ).toBe(0);
          if (action === 'scope')
            expect(
              await page.getByRole('heading', { level: 1 }).innerText(),
            ).toBe('parent-b 父级任务');
        }
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.close();
      }
    },
  );

  it('keeps historical completion separate from unknown current state, freezes elapsed time and never falls back to the parent task', async () => {
    const cold = summary();
    cold.root.source = 'prepared';
    cold.descendants = cold.descendants.map((entry) => ({
      ...entry,
      running: null,
      observation: { source: 'prepared', cursor: 8 },
    }));
    (cold.descendants[1] as Child).task = undefined;
    const { page, calls } = await open(cold, 390);
    try {
      const trigger = page.locator('button[aria-haspopup="tree"]');
      await expect.poll(() => calls.length).toBe(4);
      expect(await trigger.innerText()).toBe('子智能体状态未知');
      expect(await trigger.innerText()).not.toContain('0 个运行中');
      expect(calls.every((call) => call.liveOnly)).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => calls.length).toBe(8);
      expect(calls.every((call) => call.liveOnly)).toBe(true);
      await trigger.click();
      await page.getByRole('button', { name: '查看idle-b摘要' }).waitFor();
      expect(await trigger.innerText()).toContain('运行状态未知');
      expect(calls.filter((call) => !call.liveOnly)).toHaveLength(1);
      await page.getByRole('button', { name: '查看idle-b摘要' }).click();
      const detail = page.getByRole('complementary', { name: '子智能体摘要' });
      const text = await detail.innerText();
      expect(text).toContain('历史摘要 · 当前活动状态未知');
      expect(text).toContain('上次回合已完成');
      expect(text).toContain('暂无自有任务记录');
      expect(text).toContain('100 tokens · 5 秒');
      expect(text).toContain('不代表本次运行账单');
      expect(text).not.toContain('父级任务');
      await page.waitForTimeout(1100);
      expect(await detail.innerText()).toBe(text);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.keyboard.press('Escape');
      await expect.poll(() => trigger.innerText()).toBe('子智能体状态未知');
      const before = calls.length;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => calls.length).toBeGreaterThan(before);
      expect(calls.filter((call) => !call.liveOnly)).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('retains diagnostic nodes and clears stale running badges on errors and lost observations', async () => {
    const { page, setResponse } = await open();
    try {
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .toContain('1 个子智能体运行中');
      setResponse('error');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('button', { name: '子智能体读取失败' }).waitFor();
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .not.toContain('子智能体运行中');
      await page.getByRole('button', { name: '子智能体读取失败' }).click();
      expect(await page.getByRole('alert').innerText()).toContain(
        '暂时读不到子智能体目录',
      );
      const diagnostic: NativeSubagentSummary = {
        rootId: 'native-root',
        root: { source: 'prepared', cursor: 8 },
        descendants: [
          {
            kind: 'diagnostic',
            id: 'unsupported-child',
            parentId: 'native-root',
            depth: 1,
            reason: 'unsupported',
          },
        ],
      };
      setResponse(diagnostic);
      await page.getByRole('button', { name: '刷新子智能体摘要' }).click();
      const trigger = page.getByRole('button', { name: /1 个子智能体/ });
      await trigger.waitFor();
      if ((await trigger.getAttribute('aria-expanded')) !== 'true')
        await trigger.click();
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).innerText(),
      ).toContain('暂不支持此类型');
      expect(
        await page
          .getByRole('button', { name: '查看unsupported-child摘要' })
          .isDisabled(),
      ).toBe(true);
      expect(await trigger.innerText()).not.toContain('0 个运行中');
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .not.toContain('子智能体运行中');
    } finally {
      await page.close();
    }
  });
});
