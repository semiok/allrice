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
  activity: running === null ? 'unknown' : 'running',
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
  task: '获授权的子任务摘要。'.repeat(5),
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
const contrast = async (node: Locator, panel: Locator) => {
  const colors = [
    (await typography(node)).color,
    await panel.evaluate((node) => getComputedStyle(node).backgroundColor),
  ];
  const luminance = colors.map((color) =>
    color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce(
        (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!,
        0,
      ),
  );
  return (Math.max(...luminance) + 0.05) / (Math.min(...luminance) + 0.05);
};

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
      'xpath=ancestor::*[contains(@class,"catalog") and not(contains(@class,"catalogHead"))][1]',
    );
    return { page, panel, title, fixture, release };
  }
  async function capture(panel: Locator, name: string) {
    const directory = join(process.cwd(), '.local/quality/met245-process-b');
    mkdirSync(directory, { recursive: true });
    await panel.screenshot({ path: join(directory, `directory-${name}.png`) });
  }

  for (const theme of ['light', 'dark']) {
    it.each([1440, 1160, 1024, 390, 320])(
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
          const status = row.getByText('上次回合已完成', { exact: true });
          const duration = row.getByText('43秒', { exact: true });
          const task = row.getByText('获授权的子任务摘要。'.repeat(5), {
            exact: true,
          });
          for (const words of [name, task, status, duration])
            expect(await contrast(words, panel)).toBeGreaterThanOrEqual(4.5);
          expect(
            await task.evaluate((node) => ({
              whiteSpace: getComputedStyle(node).whiteSpace,
              overflow: getComputedStyle(node).textOverflow,
            })),
          ).toEqual({ whiteSpace: 'nowrap', overflow: 'ellipsis' });
          expect(await typography(title)).toMatchObject({
            size: '14px',
            line: '20px',
            weight: '500',
          });
          expect(await typography(name)).toMatchObject({
            size: '14px',
            line: '20px',
            weight: '400',
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
          expect(durationBox.y).toBeGreaterThanOrEqual(nameBox.y);
          expect(durationBox.x).toBeGreaterThanOrEqual(
            nameBox.x + nameBox.width,
          );
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
            padding: '8px',
            overflow: false,
          });
          expect(surface.width).toBe(Math.min(432, width - 16));
          expect(surface.background).toBe(
            theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(44, 44, 46)',
          );
          expect((await typography(status)).color).toBe(
            theme === 'light' ? 'rgb(22, 101, 52)' : 'rgb(134, 239, 172)',
          );
          expect(
            await row
              .locator('button')
              .evaluate((node) => node.getBoundingClientRect().height),
          ).toBeGreaterThanOrEqual(44);
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
        } finally {
          await page.close();
        }
      },
    );

    it(`keeps long ${theme} names readable above a single-line duration at 320 px`, async () => {
      const longName = '首次拍摄检查清单 · 首次拍摄检查清单 · 首次拍摄检查清单';
      const { page, panel } = await open(
        summary([child('long-name', longName, false, true)]),
        320,
        theme,
      );
      try {
        const name = page.getByText(longName, { exact: true });
        const duration = page.getByText('43秒', { exact: true });
        await name.waitFor();
        const nameBox = (await name.boundingBox())!;
        const durationBox = (await duration.boundingBox())!;
        expect(nameBox.height).toBeGreaterThan(20);
        expect(durationBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
        expect(durationBox.height).toBe(18);
        expect(
          await duration.evaluate((node) => getComputedStyle(node).whiteSpace),
        ).toBe('nowrap');
        expect(
          await panel.evaluate(
            (node) =>
              node.scrollWidth > node.clientWidth ||
              document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        await capture(panel, `${theme}-320-long-name`);
      } finally {
        await page.close();
      }
    });

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
      [false, true, '上次回合已完成', false],
      [false, false, '未正常结束', true],
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
        await expect
          .poll(() => row.innerText(), {
            message: `State case ${i}: ${expected}`,
          })
          .toContain(expected);
        expect(await row.getByText(expected, { exact: true }).count()).toBe(1);
        expect(await row.getByText('未正常结束', { exact: true }).count()).toBe(
          abnormal ? 1 : 0,
        );
        expect(
          await row
            .getByRole('button', {
              name: `子智能体 ${i}，${expected}，在工作台打开`,
              exact: true,
            })
            .count(),
        ).toBe(1);
        const status = row.getByText(expected, { exact: true });
        expect(await contrast(status, panel)).toBeGreaterThanOrEqual(4.5);
        expect((await typography(status)).color).toBe(
          abnormal
            ? 'rgb(185, 28, 28)'
            : i < 3
              ? 'rgb(30, 64, 175)'
              : i === 3
                ? 'rgb(22, 101, 52)'
                : 'rgb(94, 99, 104)',
        );
        const dot = row.locator('[class*="stateDot"]');
        expect(
          await dot.evaluate((node) => {
            const style = getComputedStyle(node);
            return style.backgroundColor === 'rgba(0, 0, 0, 0)'
              ? style.borderTopColor
              : style.backgroundColor;
          }),
        ).toBe((await typography(status)).color);
      }
      const abnormal = page.getByText('未正常结束', { exact: true });
      expect(await abnormal.innerText()).toBe('未正常结束');
      expect((await typography(abnormal)).color).toBe('rgb(185, 28, 28)');
      await abnormal.locator('xpath=ancestor::*[@role="treeitem"]').focus();
      expect(await page.locator(':focus').innerText()).toContain('未正常结束');
      expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(560);
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
      expect(await panel.getByText('未正常结束', { exact: true }).count()).toBe(
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
