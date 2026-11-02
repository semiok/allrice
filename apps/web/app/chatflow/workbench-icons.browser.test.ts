/** Real header and guide components in Chrome, with synthetic directory data. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
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
const summary: NativeSubagentSummary = {
  rootId: 'root',
  root: { source: 'live', cursor: 1 },
  descendants: [
    {
      kind: 'child',
      id: 'child',
      parentId: 'root',
      depth: 1,
      mode: 'continuable',
      label: '核对数据',
      title: '核对数据',
      task: '核对数据',
      running: false,
      activity: 'running',
      observation: { source: 'live', cursor: 1 },
      timing: { settledMs: 1000, lastTurnCompleted: true },
      usage: {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      lastReply: '核对完成',
    },
  ],
};

suite('workbench icon scale and workflow identity', () => {
  let browser: Browser, server: Server, origin: string;
  const feed = new NativeSubagentFixtureFeed();
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
      if (feed.handle(req, res)) return;
      const path = new URL(req.url!, origin).pathname;
      if (path.endsWith('/subagents')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ summary }));
        return;
      }
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
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await feed.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  // Measure the rendered artwork, including its non-scaling stroke, rather
  // than accepting equal CSS boxes around differently sized drawings.
  const ink = (icon: Locator) =>
    icon.evaluate((element) => {
      const svg = element as SVGSVGElement;
      const box = svg.getBBox();
      const matrix = svg.getScreenCTM()!;
      const stroke = Math.max(
        ...Array.from(svg.querySelectorAll('*')).map((node) =>
          parseFloat(getComputedStyle(node).strokeWidth),
        ),
      );
      return {
        width: box.width * matrix.a + stroke,
        height: box.height * matrix.d + stroke,
      };
    });

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`“图标一样大，工作流改绿色路线”：${width}px ${theme}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        const fixture = feed.register({ summary: () => summary });
        try {
          await feed.bindPage(page, origin, fixture);
          await page.goto(`${origin}/?icons&theme=${theme}`);
          const agents = page.getByRole('button', { name: '1 个子智能体' });
          await agents.waitFor();
          const entries = page.getByLabel('工作台入口');
          const buttons = [
            agents,
            entries.getByRole('button', { name: '工作区文件，33 项新增' }),
            entries.getByRole('button', { name: '经验管理，1 项新增' }),
            entries.getByRole('button', { name: '工作流', exact: true }),
          ];
          const measured = [];
          for (const button of buttons) {
            const box = (await button.boundingBox())!;
            expect([box.width, box.height]).toEqual([32, 32]);
            const icon = button.locator('svg');
            const iconBox = (await icon.boundingBox())!;
            expect([iconBox.width, iconBox.height]).toEqual([20, 20]);
            measured.push(await ink(icon));
          }
          const largestPeer = Math.max(
            ...measured.slice(1).flatMap((size) => [size.width, size.height]),
          );
          expect(
            Math.max(measured[0]!.width, measured[0]!.height),
          ).toBeLessThanOrEqual(largestPeer);
          for (const size of [measured[0]!, measured[3]!]) {
            expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(
              15,
            );
            expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(20);
          }
          const green =
            theme === 'light' ? 'rgb(36, 149, 82)' : 'rgb(105, 207, 139)';
          expect(
            await buttons[3]!
              .locator('svg')
              .evaluate((node) => getComputedStyle(node).color),
          ).toBe(green);
          const guide = page.getByLabel('图标工作台');
          const workflowCard = guide.getByRole('button', { name: /工作流/ });
          expect(
            (await workflowCard.locator('svg').first().boundingBox())!.width,
          ).toBe(27);
          expect(
            await workflowCard
              .locator('svg')
              .first()
              .evaluate((node) => getComputedStyle(node).color),
          ).toBe(green);
          await agents.click();
          await page
            .getByRole('button', { name: '查看核对数据摘要' })
            .waitFor();
          expect(await agents.getAttribute('aria-expanded')).toBe('true');
          await page.keyboard.press('Escape');
          await buttons[3]!.click();
          expect(await page.getByLabel('当前工作台模块').innerText()).toBe(
            '工作流',
          );
          expect(await buttons[3]!.getAttribute('aria-pressed')).toBe('true');
          await buttons[1]!.click();
          expect(await page.getByLabel('当前工作台模块').innerText()).toBe(
            '工作区文件',
          );
          await workflowCard.click();
          expect(await page.getByLabel('当前工作台模块').innerText()).toBe(
            '工作流',
          );
          const directory = join(tmpdir(), 'allrice-met214-icons');
          mkdirSync(directory, { recursive: true });
          await page.screenshot({
            path: join(directory, `${width}-${theme}.png`),
          });
          writeFileSync(
            join(directory, `${width}-${theme}.json`),
            JSON.stringify({ measured, green }),
          );
          console.info(
            `${width}px ${theme}: ${JSON.stringify(measured)}; workflow ${green}; evidence ${directory}`,
          );
          await page.goto(`${origin}/?icons&no-workflow&theme=${theme}`);
          await page.getByLabel('图标工作台').waitFor();
          expect(
            await page.getByRole('button', { name: /工作流/ }).count(),
          ).toBe(0);
        } finally {
          await page.close();
        }
      });
});
