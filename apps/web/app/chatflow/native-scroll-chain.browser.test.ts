import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Locator,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('MET247 native nested scrolling', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/native-scroll-chain-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://fixture').pathname;
      if (path.endsWith('/references/revisions/fixture/preview')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            kind: 'text',
            mediaType: 'text/plain',
            text: Array.from(
              { length: 90 },
              (_, i) => `引用资料第 ${i} 行`,
            ).join('\n'),
          }),
        );
        return;
      }
      const asset = assets.get(path);
      res.setHeader(
        'content-type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/native-scroll-chain-page.css"><div id="root"></div><script type="module" src="/native-scroll-chain-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(
      new URL('../../../worker/package.json', import.meta.url),
    )('playwright-core');
    const executablePath =
      process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined);
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 30_000);

  // Hit the currently visible intersection without hover/click auto-scrolling
  // the reading panel and concealing a broken wheel chain.
  async function wheel(page: Page, target: Locator, x: number, y: number) {
    const point = await target.evaluate((node) => {
      let box = node.getBoundingClientRect();
      let left = Math.max(0, box.left),
        right = Math.min(innerWidth, box.right);
      let top = Math.max(0, box.top),
        bottom = Math.min(innerHeight, box.bottom);
      for (
        let parent = node.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        box = parent.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, box.left);
          right = Math.min(right, box.right);
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, box.top);
          bottom = Math.min(bottom, box.bottom);
        }
      }
      if (right <= left || bottom <= top)
        throw Error('Wheel target is outside its visible reading panel');
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(x, y);
    await target.evaluate(async (node) => {
      const ancestors: HTMLElement[] = [];
      for (
        let parent: HTMLElement | null = node as HTMLElement;
        parent;
        parent = parent.parentElement
      )
        ancestors.push(parent);
      let previous = '',
        stable = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame);
        const position = ancestors
          .map((parent) => `${parent.scrollLeft}:${parent.scrollTop}`)
          .join(',');
        stable = position === previous ? stable + 1 : 0;
        if (stable >= 4) return;
        previous = position;
      }
      throw Error('Native scrolling did not settle');
    });
  }

  it.each(['code', 'table', 'tool', 'reference', 'sidebar', 'dialog'])(
    '%s keeps internal scrolling and passes its edge to the containing reader',
    async (kind) => {
      const page = await browser.newPage({
        viewport: { width: 900, height: 820 },
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}/?case=${kind}`);
        if (kind === 'dialog')
          await page.getByRole('button', { name: '打开弹框' }).click();
        if (kind === 'tool' || kind === 'dialog')
          await page.getByText('技术详情', { exact: true }).click();
        const outer =
          kind === 'dialog'
            ? page.locator('[role="dialog"] > [class*="body"]')
            : page.locator('[data-scroll-outer]');
        const horizontal = kind === 'code' || kind === 'table';
        const source =
          kind === 'sidebar'
            ? page.getByRole('tree', { name: '员工与工作' })
            : kind === 'reference'
              ? page.getByRole('region', { name: '文件正文', exact: true })
              : kind === 'table'
                ? page.getByRole('table')
                : page.locator('pre').first();
        await source.waitFor();
        if (kind === 'table') {
          const box = (await source.boundingBox())!;
          const frame = (await outer.boundingBox())!;
          await page.mouse.move(frame.x + 40, box.y + 20);
        }
        await source.evaluate((start, horizontal) => {
          for (
            let node: HTMLElement | null = start as HTMLElement;
            node;
            node = node.parentElement
          ) {
            if (node.hasAttribute('data-scroll-outer')) break;
            const style = getComputedStyle(node),
              overflow = horizontal ? style.overflowX : style.overflowY;
            const range = horizontal
              ? node.scrollWidth - node.clientWidth
              : node.scrollHeight - node.clientHeight;
            if (['auto', 'scroll'].includes(overflow) && range > 120) {
              node.dataset.scrollInner = '';
              return;
            }
          }
          throw Error(
            'The real component did not expose its expected scrollport',
          );
        }, horizontal);
        const inner = page.locator('[data-scroll-inner]');
        expect(
          await inner.evaluate(
            (node) => getComputedStyle(node).overscrollBehavior,
          ),
        ).toBe('auto');
        expect(
          await outer.evaluate(
            (node) => getComputedStyle(node).overscrollBehavior,
          ),
        ).toBe('auto');
        const position = (target: Locator) =>
          target.evaluate(
            (node, x) => (x ? node.scrollLeft : node.scrollTop),
            horizontal,
          );
        await wheel(page, inner, horizontal ? 70 : 0, horizontal ? 0 : 70);
        await expect.poll(() => position(inner)).toBeGreaterThan(0);
        expect(await position(outer)).toBe(0);
        // Establish the boundary; the handoff itself must come from trusted wheel input.
        await inner.evaluate((node, x) => {
          if (x) node.scrollLeft = node.scrollWidth;
          else node.scrollTop = node.scrollHeight;
        }, horizontal);
        await wheel(page, inner, horizontal ? 70 : 0, horizontal ? 0 : 70);
        await expect.poll(() => position(outer)).toBeGreaterThan(0);
        // Reverse at the inner edge: it owns the opposite direction immediately.
        const outerPosition = await position(outer);
        const edge = await position(inner);
        await wheel(page, inner, horizontal ? -50 : 0, horizontal ? 0 : -50);
        await expect.poll(() => position(inner)).toBeLessThan(edge);
        expect(await position(outer)).toBe(outerPosition);
        await outer.evaluate((node, x) => {
          if (x) node.scrollLeft = 70;
          else node.scrollTop = 70;
        }, horizontal);
        await inner.evaluate((node, x) => {
          if (x) node.scrollLeft = 0;
          else node.scrollTop = 0;
        }, horizontal);
        await wheel(page, inner, horizontal ? -70 : 0, horizontal ? 0 : -70);
        await expect.poll(() => position(outer)).toBeLessThan(70);
        if (horizontal) {
          await outer.evaluate((node) => {
            node.scrollLeft = 0;
            node.scrollTop = 0;
          });
          await wheel(page, inner, 0, 80);
          await expect
            .poll(() => outer.evaluate((node) => node.scrollTop))
            .toBeGreaterThan(0);
        }
        if (kind === 'dialog') {
          expect(await page.evaluate(() => document.body.style.overflow)).toBe(
            'hidden',
          );
          expect(await page.evaluate(() => scrollY)).toBe(0);
          await page.getByRole('button', { name: '关闭', exact: true }).click();
          expect(await page.evaluate(() => document.body.style.overflow)).toBe(
            '',
          );
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  it('attachment wheel scrolls the rail internally and releases both edges to its reader', async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 820 },
    });
    try {
      await page.goto(`${origin}/?case=attachments`);
      const outer = page.locator('[data-scroll-outer]');
      const rail = page.getByRole('group', { name: '待发送附件' });
      await rail.waitFor();
      await wheel(page, rail, 0, 80);
      await expect
        .poll(() => rail.evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
      expect(await outer.evaluate((node) => node.scrollTop)).toBe(0);
      await rail.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      await wheel(page, rail, 0, 80);
      await expect
        .poll(() => outer.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await rail.evaluate((node) => {
        node.scrollLeft = 0;
      });
      await outer.evaluate((node) => {
        node.scrollTop = 30;
      });
      await wheel(page, rail, 0, -80);
      await expect.poll(() => outer.evaluate((node) => node.scrollTop)).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
});
