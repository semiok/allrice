/** Normal transcript updates in Chrome; synthetic HTTP, no DB/auth/model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ids } from '../../test/technical-details-fixtures';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('approved DSH process alignment', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/work-process-alignment-page.tsx'],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/work-process-alignment-page.css"><div id="root"></div><script type="module" src="/work-process-alignment-page.js"></script>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
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
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
  const openPage = async (query: string) => {
    const page = await browser.newPage();
    await page.goto(`${origin}/?${query}`);
    await page.locator('[data-alignment-scene]').waitFor();
    return page;
  };
  it('keeps durable answered questions in their exact process even before start or with a live tail', async () => {
    for (const suffix of ['', '&request-first', '&live-tail', '&blocking']) {
      const page = await openPage(`scene=answered${suffix}`);
      const receipt = page.getByRole('article', { name: '用户确认结果' });
      await receipt.waitFor();
      expect(await receipt.count()).toBe(1);
      expect(
        await receipt.evaluate(
          (node) => !!node.closest('[data-process-scrollport]'),
        ),
      ).toBe(true);
      await receipt.locator('[data-disclosure-row]').click();
      expect(await receipt.innerText()).toContain('按自然月');
      expect(await receipt.innerText()).not.toContain('Rice 已收到你的回答');
      await page.close();
    }
  });
  it('shows each frozen skill name and no explanation or success tail', async () => {
    const page = await openPage('scene=skills');
    const rows = page.locator('[data-step-id]');
    expect(await rows.count()).toBe(3);
    for (const name of ['数据分析', '电子表格', '演示文稿'])
      expect(await rows.allTextContents()).toContainEqual(
        expect.stringContaining(`加载技能 · ${name}`),
      );
    expect(await rows.allTextContents()).not.toContainEqual(
      expect.stringContaining('已完成'),
    );
    expect(
      await page.locator('[data-step-id="tool:skill-1"]').innerText(),
    ).not.toContain('0.3秒');
    await page.close();
  });
  it('never flashes a standalone computation card when material or call arrives first', async () => {
    for (const order of ['material-first', 'tool-first']) {
      const page = await openPage(`scene=cloud&${order}`);
      await page.waitForFunction(
        () => document.querySelectorAll('[data-step-id]').length >= 2,
      );
      const standalone = page.locator(
        `article[data-process-operation="${ids.succeededOperation}"]`,
      );
      expect(await standalone.count()).toBe(0);
      if (order === 'material-first') {
        await page.locator('[data-step-id^="operation:cloud:"]').waitFor();
        await page.evaluate(() => window.alignTrace());
      } else await page.evaluate(() => window.alignMaterial());
      const row = page.locator('[data-step-id="tool:cloud"]');
      await page.waitForFunction(() =>
        document
          .querySelector('[data-step-id="tool:cloud"]')
          ?.textContent?.includes('云端计算'),
      );
      expect(
        await page.locator('[data-step-id^="operation:cloud:"]').count(),
      ).toBe(0);
      expect(await row.innerText()).toContain(
        '云端计算 · 按月份汇总销售额与毛利率',
      );
      expect(await row.innerText()).not.toContain('python.execute');
      expect(await standalone.count()).toBe(0);
      await page.close();
    }
  });
  it('uses a gray animated step, only an employee-colored executing header, and total time outside', async () => {
    for (const theme of ['light', 'dark']) {
      const page = await openPage(`scene=running&theme=${theme}`);
      const row = page.locator('[data-step-id="tool:cloud"]');
      await row.waitFor();
      const result = await page.evaluate(() => {
        const step = document.querySelector('[data-step-id="tool:cloud"]')!;
        const header = document.querySelector('[data-executing]')!;
        const timing = document.querySelector('[aria-label="本轮运行时间"]')!;
        return {
          step: getComputedStyle(
            step.querySelector('[class*="processStepLabel"]')!,
          ).color,
          header: getComputedStyle(
            header.querySelector('[class*="processTitle"]')!,
          ).color,
          outside: !timing.closest('[data-process-scrollport]'),
          font: getComputedStyle(step).fontSize,
          animated:
            step.querySelector('[data-disclosure-row]')!.getAnimations()
              .length === 1,
        };
      });
      expect(result.outside).toBe(true);
      expect(result.animated).toBe(true);
      expect(result.step).not.toBe(result.header);
      expect(result.font).toBe('12px');
      expect(
        await page.locator('[aria-label="本轮运行时间"]').innerText(),
      ).toContain('用时');
      await page.close();
    }
  });
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 390]) {
      it(`keeps icon/text aligned, multiple details fully open and pulse synchronized at ${width}px ${theme}`, async () => {
        const page = await openPage(
          `scene=running&blocking&theme=${theme}&employee=文章哥`,
        );
        try {
          await page.setViewportSize({ width, height: 960 });
          const header = page.locator('[data-executing]');
          await expect.poll(() => header.count()).toBe(1);
          const result = await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            );
            const avatar = document.querySelector(
              '[class*="assistantIdentity"] i',
            )!;
            const header = document.querySelector(
              '[data-executing] [data-disclosure-row]',
            )!;
            const step = document.querySelector(
              '[data-step-id="tool:cloud"] [data-disclosure-row]',
            )!;
            const title = header.querySelector('[class*="processTitle"]')!;
            return {
              colors: [
                getComputedStyle(avatar).backgroundColor,
                getComputedStyle(title).color,
                getComputedStyle(
                  title.querySelector('[aria-label="本轮运行时间"]')!,
                ).color,
              ],
              clocks: [avatar, header, step].map((node) =>
                node.getAnimations().map((a) => ({
                  start: a.startTime,
                  duration: a.effect!.getTiming().duration,
                  easing: getComputedStyle(node).animationTimingFunction,
                })),
              ),
              children: [...step.querySelectorAll('*')].flatMap((node) =>
                node.getAnimations(),
              ).length,
              rows: [
                ...document.querySelectorAll(
                  '[data-step-id] [data-disclosure-row]',
                ),
              ].map((node) => {
                const icon = node.firstElementChild!.getBoundingClientRect();
                const text = node
                  .querySelector('[class*="processStepLabel"]')
                  ?.getBoundingClientRect();
                return text
                  ? Math.abs(
                      icon.y + icon.height / 2 - text.y - text.height / 2,
                    )
                  : 0;
              }),
            };
          });
          expect(new Set(result.colors).size).toBe(1);
          expect(result.clocks.every((clocks) => clocks.length === 1)).toBe(
            true,
          );
          expect(new Set(result.clocks.flat().map((a) => a.start)).size).toBe(
            1,
          );
          expect(
            result.clocks
              .flat()
              .every((a) => a.duration === 1400 && a.easing === 'ease-in-out'),
          ).toBe(true);
          expect(result.children).toBe(0);
          expect(result.rows.every((delta) => delta <= 0.5)).toBe(true);
          const group = page.locator('[data-process-scrollport]').first();
          const before = (await group.boundingBox())!.height;
          await page
            .locator('[data-step-id="tool:skill-1"] [data-disclosure-row]')
            .click();
          await page
            .locator('[data-step-id="tool:cloud"] [data-disclosure-row]')
            .click();
          const expansion = await group.evaluate((node) => ({
            height: node.getBoundingClientRect().height,
            scroll: node.scrollHeight,
            client: node.clientHeight,
            overflow: getComputedStyle(node).overflowY,
          }));
          expect(expansion.height).toBeGreaterThan(before);
          expect(expansion.scroll - expansion.client).toBeLessThanOrEqual(1);
          expect(['auto', 'scroll']).not.toContain(expansion.overflow);
          expect(
            await page.locator('[data-step-id="tool:skill-1"] dl').isVisible(),
          ).toBe(true);
          expect(
            await page
              .locator('[data-step-id="tool:cloud"] dl')
              .first()
              .isVisible(),
          ).toBe(true);
          const dir = process.env.ALLRICE_CONFIRMED_UI_SCREENSHOTS;
          if (dir) {
            await mkdir(dir, { recursive: true });
            await page.screenshot({
              path: join(dir, `process-${width}-${theme}-expanded.png`),
              fullPage: true,
            });
          }
        } finally {
          await page.close();
        }
      });
      it(`keeps the message anchor when the first timing arrives at ${width}px ${theme}`, async () => {
        const page = await openPage(`scene=running&preparing&theme=${theme}`);
        try {
          await page.setViewportSize({ width, height: 960 });
          const identity = page.locator('[class*="assistantIdentity"]');
          await identity.waitFor();
          await page.evaluate(() => document.fonts.ready);
          const top = (await identity.boundingBox())!.y;
          await page.evaluate(() => window.alignTiming());
          await page.getByLabel('本轮运行时间').waitFor();
          expect((await identity.boundingBox())!.y).toBe(top);
          expect(
            await page
              .locator('[aria-label="本地命令审批与执行"]:empty')
              .count(),
          ).toBe(0);
        } finally {
          await page.close();
        }
      });
    }
  it('keeps cloud approval reachable inside its process in every display mode', async () => {
    for (const mode of ['compact', 'standard', 'detailed']) {
      const page = await openPage(`scene=running&approval&mode=${mode}`);
      const approve = page.locator('[data-process-control="approve"]');
      await approve.waitFor({ state: 'visible' });
      expect(
        await approve.evaluate(
          (node) => !!node.closest('[data-step-id="tool:cloud"]'),
        ),
      ).toBe(true);
      expect(
        await page.locator('[data-process-control="reject"]').isVisible(),
      ).toBe(true);
      await page.close();
    }
  });
  it('does not color nested group headers in the non-streaming path', async () => {
    const page = await openPage(
      'scene=running&mode=standard&unified&tool-only',
    );
    const top = page
      .locator('[aria-label="工作过程"] > div > [data-disclosure-header]')
      .first();
    const nested = page
      .locator('section[aria-label="工作步骤"] [data-disclosure-row]')
      .first();
    await nested.waitFor();
    const color = async (row: typeof nested) =>
      row
        .locator('[class*="processTitle"]')
        .first()
        .evaluate((node) => getComputedStyle(node).color);
    expect(await color(top)).not.toBe(await color(nested));
    await page.close();
  });
  it('renders failure details without a crash and keeps their font/color consistent', async () => {
    const page = await openPage('scene=failed');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const row = page.locator('[data-step-id="tool:cloud"]');
    await row.locator('dl').first().waitFor();
    expect(await row.innerText()).toContain('缺少“销售金额”列');
    const fields = await row.locator('dt, dd').evaluateAll((nodes) =>
      nodes.map((node) => {
        const css = getComputedStyle(node);
        return [css.fontSize, css.fontWeight, css.color];
      }),
    );
    expect(new Set(fields.map((entry) => JSON.stringify(entry))).size).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});
