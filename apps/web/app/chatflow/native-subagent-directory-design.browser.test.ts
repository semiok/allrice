import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeSubagentSummary } from '@allrice/contracts';
import { NativeSubagentFixtureFeed } from '../../test/native-subagent-fixture-feed';
import type {
  Browser,
  Locator,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Child = Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
>;
const child = (
  id: string,
  label: string,
  running: boolean | null,
  completed: boolean | undefined,
  seconds = 43,
): Child => ({
  kind: 'child',
  id,
  label,
  parentId: 'root',
  depth: 1,
  mode: 'continuable',
  running,
  activity: 'unknown',
  observation: { source: 'live', cursor: 8 },
  timing: {
    settledMs: seconds * 1000,
    ...(completed === undefined ? {} : { lastTurnCompleted: completed }),
  },
  usage: {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  },
  lastReply: null,
});
const summary = (
  descendants = [
    child('first', '首次拍摄检查清单', false, true),
    child('second', '足球录像复盘方法', false, true, 22),
  ],
): NativeSubagentSummary => ({
  rootId: 'root',
  root: { source: 'live', cursor: 10 },
  descendants,
});
const typography = (node: Locator) =>
  node.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      size: style.fontSize,
      line: style.lineHeight,
      weight: style.fontWeight,
      family: style.fontFamily,
      color: style.color,
    };
  });

suite('MET-214 native subagent directory design', () => {
  let browser: Browser, server: Server, origin: string;
  const feed = new NativeSubagentFixtureFeed();
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    // Reuse the existing real page and transport fixture, not a mock component.
    const component = await build({
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
      component.outputFiles.map(
        (file: { path: string; contents: Uint8Array }) => [
          file.path.slice(file.path.lastIndexOf('/')),
          file.contents,
        ],
      ),
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
      if (feed.handle(req, res)) return;
      const path = new URL(req.url!, origin).pathname;
      const asset = assets.get(path);
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
    feed.attach(server);
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
    await feed.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  async function open(
    value: NativeSubagentSummary | 'error' = summary(),
    width = 1200,
    theme = 'light',
    loading = false,
  ) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    if (!loading) release();
    const fixture = feed.register({ summary: () => value });
    await page.route('**/api/v1/sessions/*/subagents?**', async (route) => {
      if (
        new URL(route.request().url()).searchParams.get('liveOnly') !== 'true'
      )
        await gate;
      await route.fulfill(
        value === 'error'
          ? { status: 503, json: { error: 'unavailable' } }
          : { json: { summary: value } },
      );
    });
    await feed.bindPage(page, origin, fixture);
    await page.goto(`${origin}?icons&no-workflow&theme=${theme}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    const trigger = page.locator('button[aria-haspopup="tree"]');
    if (!loading)
      await page
        .getByRole('button', {
          name: value === 'error' ? '子智能体读取失败' : /个子智能体/,
        })
        .waitFor();
    await trigger.click();
    const title = page.getByRole('heading', { name: '子智能体', exact: true });
    await title.waitFor();
    const panel = title.locator(
      'xpath=ancestor::*[contains(@class,"catalog")][1]',
    );
    return { page, panel, title, fixture, release };
  }
  async function capture(panel: Locator, name: string) {
    const directory = join(process.cwd(), '.local', 'met214-popover-redesign');
    mkdirSync(directory, { recursive: true });
    await panel.screenshot({ path: join(directory, `${name}.png`) });
  }

  for (const theme of ['light', 'dark']) {
    it.each([1200, 320])(
      `“名字别被状态挤成两行”：keeps ${theme} names above metadata at %s px`,
      async (width) => {
        const value = summary();
        const { page, panel, title, fixture } = await open(value, width, theme);
        try {
          const row = page.getByRole('treeitem', {
            name: '首次拍摄检查清单摘要',
            exact: true,
          });
          const name = row.getByText('首次拍摄检查清单', { exact: true });
          const status = row.getByText('已结束', { exact: true });
          const duration = row.getByText('43 秒', { exact: true });
          expect(await typography(title)).toMatchObject({
            size: '16px',
            line: '24px',
            weight: '600',
          });
          expect(await typography(name)).toMatchObject({
            size: '14px',
            line: '20px',
            weight: '500',
          });
          expect(await typography(status)).toMatchObject({
            size: '12px',
            line: '18px',
            weight: '400',
          });
          expect((await typography(name)).family).toMatch(
            /-apple-system.*PingFang SC/,
          );
          const nameBox = (await name.boundingBox())!;
          const statusBox = (await status.boundingBox())!;
          const durationBox = (await duration.boundingBox())!;
          expect(nameBox.height).toBe(20);
          expect(statusBox.y).toBeGreaterThanOrEqual(
            nameBox.y + nameBox.height + 4,
          );
          expect(durationBox.y).toBe(statusBox.y);
          expect(durationBox.height).toBe(18);
          expect(
            await duration.evaluate((el) => getComputedStyle(el).whiteSpace),
          ).toBe('nowrap');
          const surface = await panel.evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              background: style.backgroundColor,
              radius: style.borderRadius,
              padding: style.padding,
              width: node.getBoundingClientRect().width,
              secondary: getComputedStyle(document.body)
                .getPropertyValue('--ar-text-secondary')
                .trim(),
              overflow:
                document.documentElement.scrollWidth > innerWidth ||
                node.scrollWidth > node.clientWidth,
            };
          });
          expect(surface).toMatchObject({
            radius: '12px',
            padding: '16px',
            overflow: false,
          });
          expect(surface.width).toBe(width === 320 ? 288 : 360);
          expect(surface.background).toBe(
            theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(44, 44, 46)',
          );
          expect((await typography(status)).color).toBe(surface.secondary);
          expect(
            await panel.getByRole('button', { name: /详情|刷新/ }).count(),
          ).toBe(0);
          await row.click();
          expect(
            await page
              .getByRole('complementary', { name: '子智能体摘要' })
              .count(),
          ).toBe(0);
          expect(
            feed.calls.filter(
              (call) => call.fixture === fixture && call.childId,
            ),
          ).toEqual([]);
          await capture(panel, `${theme}-${width}-list`);
          if (width === 320) {
            const longName =
              '首次拍摄检查清单 · 首次拍摄检查清单 · 首次拍摄检查清单';
            value.descendants[0] = {
              ...value.descendants[0]!,
              label: longName,
            } as Child;
            feed.push(fixture, { type: 'directory', summary: value });
            const long = page.getByText(longName, { exact: true });
            await long.waitFor();
            const longBox = (await long.boundingBox())!;
            expect(longBox.height).toBeGreaterThan(20);
            expect((await duration.boundingBox())!.y).toBeGreaterThanOrEqual(
              longBox.y + longBox.height + 4,
            );
            expect(
              await panel.evaluate(
                (node) => node.scrollWidth > node.clientWidth,
              ),
            ).toBe(false);
            await capture(panel, `${theme}-${width}-long-name`);
          }
        } finally {
          await page.close();
        }
      },
    );

    it.each(['empty', 'loading'])(
      `“空态和加载别用大字”：uses body typography in ${theme} %s`,
      async (mode) => {
        const { page, panel, release } = await open(
          summary([]),
          320,
          theme,
          mode === 'loading',
        );
        try {
          const message = page.getByText(
            mode === 'loading' ? '正在读取子智能体摘要…' : '暂无子智能体',
            { exact: true },
          );
          await message.waitFor();
          expect(await typography(message)).toMatchObject({
            size: '14px',
            line: '22px',
            weight: '400',
          });
          expect((await typography(message)).family).toMatch(
            /-apple-system.*PingFang SC/,
          );
          if (mode === 'loading') {
            const bars = panel.locator('[class*="skeleton"] span');
            expect(await bars.count()).toBe(2);
            expect(
              await bars
                .first()
                .evaluate((node) => getComputedStyle(node).animationName),
            ).toBe('none');
          } else {
            expect(
              await message.evaluate(
                (node) => getComputedStyle(node).justifyContent,
              ),
            ).toBe('center');
          }
          expect(
            await panel.evaluate((node) => node.scrollWidth > node.clientWidth),
          ).toBe(false);
          await capture(panel, `${theme}-320-${mode}`);
        } finally {
          release();
          await page.close();
        }
      },
    );
  }

  it('“只显示真实状态”：running wins, unknown never claims ended, and only explicit abnormal endings show a red warning', async () => {
    const cases = [
      [true, true, '运行中', false],
      [true, false, '运行中', false],
      [true, undefined, '运行中', false],
      [false, true, '已结束', false],
      [false, false, '已结束', true],
      [false, undefined, '未运行', false],
      [null, true, '状态未知', false],
      [null, false, '状态未知', false],
      [null, undefined, '状态未知', false],
    ] as const;
    const { page, panel } = await open(
      summary(
        cases.map(([running, completed], i) =>
          child(`case-${i}`, `子智能体 ${i}`, running, completed),
        ),
      ),
    );
    try {
      for (const [i, [, , expected, abnormal]] of cases.entries()) {
        const row = page.getByRole('treeitem', {
          name: `子智能体 ${i}摘要`,
          exact: true,
        });
        expect(await row.getByText(expected, { exact: true }).count()).toBe(1);
        expect(await row.getByRole('img', { name: '未正常结束' }).count()).toBe(
          abnormal ? 1 : 0,
        );
        expect(await row.getAttribute('aria-description')).toBe(
          abnormal ? '未正常结束' : null,
        );
      }
      const abnormal = page.getByRole('img', { name: '未正常结束' });
      expect(await abnormal.innerText()).toBe('!');
      expect((await typography(abnormal)).color).toBe('rgb(185, 28, 28)');
      await abnormal.locator('xpath=ancestor::*[@role="treeitem"]').focus();
      expect(
        await page.locator(':focus').getAttribute('aria-description'),
      ).toBe('未正常结束');
      await abnormal.hover();
      await page
        .getByRole('tooltip')
        .filter({ hasText: '未正常结束' })
        .waitFor();
      await capture(panel, 'light-states');
    } finally {
      await page.close();
    }
  });

  it('keeps directory read failures separate from an abnormal child ending', async () => {
    const { page, panel } = await open('error');
    try {
      const failure = panel.getByRole('alert');
      await failure.waitFor();
      expect(await failure.innerText()).toContain('暂时读不到子智能体目录');
      expect(await panel.getByRole('treeitem').count()).toBe(0);
      expect(await panel.getByRole('img', { name: '未正常结束' }).count()).toBe(
        0,
      );
      expect(await typography(failure)).toMatchObject({
        size: '14px',
        line: '22px',
        weight: '400',
      });
    } finally {
      await page.close();
    }
  });
});
