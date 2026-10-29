/** Real transcript in Chrome; component fetches are stubbed, no auth/DB/model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('one receipt within each native call in the chat transcript', () => {
  let browser: Browser, server: Server, origin: string, screenshots: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/work-process-page.tsx'],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/work-process-page.css"><div id="root"></div><script type="module" src="/work-process-page.js"></script>',
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
    screenshots = await mkdtemp(join(tmpdir(), 'met236-process-'));
    console.log(`Synthetic transcript screenshots: ${screenshots}`);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
  const processOf = (page: Page) =>
    page.getByRole('region', { name: '工作过程', exact: true });
  const calls = (page: Page) => processOf(page).locator('[data-work-call]');
  const expandGroups = async (page: Page) => {
    for (const group of await processOf(page)
      .getByRole('button', { name: /项$/ })
      .all())
      if ((await group.getAttribute('aria-expanded')) === 'false')
        await group.click();
  };
  it('preserves an opened receipt and its focused node when late trace prepends a step', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?delayed-trace`);
      await expect.poll(() => calls(page).count()).toBe(32);
      await processOf(page).locator('[data-disclosure-row]').first().click();
      await expandGroups(page);
      expect(await calls(page).first().getAttribute('data-work-call')).toBe(
        'tool:call-0',
      );
      const call = page.locator('#operation-receipt-1');
      await call.getByRole('button').click();
      const receipt = call.locator('article');
      await receipt
        .getByRole('button', { name: '执行结果', exact: true })
        .click();
      const detail = receipt.getByRole('button', {
        name: '技术详情',
        exact: true,
      });
      await detail.click();
      await detail.focus();
      const focused = await detail.elementHandle();
      expect(await receipt.innerText()).toContain('synthetic-result-1');
      // Resolve the pending fetch stub without clicking a fixture control or helper.
      await page.evaluate(() => window.processDeliverTrace());
      await page.locator('main[data-delayed-trace="loaded"]').waitFor();
      expect(await calls(page).first().getAttribute('data-work-call')).toBe(
        'think:1:1:0',
      );
      expect(
        await focused!.evaluate(
          (node) => node.isConnected && document.activeElement === node,
        ),
      ).toBe(true);
      expect(await detail.getAttribute('aria-expanded')).toBe('true');
      expect(await receipt.innerText()).toContain('synthetic-result-1');
      expect(await page.locator('#operation-receipt-0 article').count()).toBe(
        0,
      );
      expect(await page.locator('[id="operation-receipt-1"]').count()).toBe(1);
    } finally {
      await page.close();
    }
  });
  for (const width of [1440, 390])
    for (const unified of [false, true])
      it(`keeps 34 calls once and receipts on demand at ${width}px, unified=${unified}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        try {
          await page.goto(`${origin}/?${unified ? 'unified' : ''}`);
          await expect.poll(() => calls(page).count()).toBe(34);
          const process = processOf(page);
          expect(await process.getAttribute('data-process-open')).toBe('false');
          expect(
            await page
              .getByText('已核对，最终结论保留在这里。', { exact: true })
              .isVisible(),
          ).toBe(true);
          expect(await processOf(page).locator('article:visible').count()).toBe(
            0,
          );
          await page.screenshot({
            path: join(screenshots, `${width}-${unified}-default.png`),
          });
          await process.locator('[data-disclosure-row]').first().click();
          await expandGroups(page);
          expect(
            await calls(page)
              .locator(
                ':scope > div > [data-disclosure-header] [data-disclosure-row]',
              )
              .count(),
          ).toBe(34);
          expect(
            await calls(page).evaluateAll(
              (nodes) =>
                new Set(nodes.map((n) => n.getAttribute('data-work-call')))
                  .size,
            ),
          ).toBe(34);
          expect(await processOf(page).locator('article').count()).toBe(0);
          await page.screenshot({
            path: join(screenshots, `${width}-${unified}-expanded.png`),
          });
          const first = process.locator('[data-work-call="tool:call-0"]');
          await first.getByRole('button').click();
          const receipt = first.locator('article');
          await receipt.waitFor();
          expect(await processOf(page).locator('article').count()).toBe(1);
          expect(await receipt.innerText()).toContain('授权等级：写入');
          expect(
            await receipt.getByRole('button', { name: '查看详情' }).count(),
          ).toBe(0);
          await receipt
            .getByRole('button', { name: '执行结果', exact: true })
            .click();
          await receipt
            .getByRole('button', { name: '技术详情', exact: true })
            .click();
          expect(await receipt.innerText()).toContain('synthetic-result-0');
          await page.screenshot({
            path: join(screenshots, `${width}-${unified}-detail.png`),
          });
          // A later input must not override a reader's manual expansion.
          await page
            .getByRole('button', { name: '下一轮输入', exact: true })
            .click();
          expect(await process.getAttribute('data-process-open')).toBe('true');
          expect(await receipt.isVisible()).toBe(true);
          await first.locator('[data-disclosure-row]').first().click();
          await process.locator('[data-disclosure-row]').first().click();
          await page
            .getByRole('button', { name: '定位已有调用', exact: true })
            .click();
          await receipt.waitFor();
          expect(await page.locator('[id="operation-receipt-0"]').count()).toBe(
            1,
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          if (!unified) {
            const order = await process
              .locator('[data-work-reply], [data-work-call]')
              .evaluateAll((nodes) =>
                nodes.map(
                  (n) =>
                    n.getAttribute('data-work-reply') ??
                    n.getAttribute('data-work-call'),
                ),
              );
            expect(order.indexOf('reply:progress')).toBeLessThan(
              order.indexOf('tool:call-0'),
            );
            expect(order.indexOf('tool:call-16')).toBeLessThan(
              order.indexOf('reply:progress-2'),
            );
            expect(order.indexOf('reply:progress-2')).toBeLessThan(
              order.indexOf('tool:call-17'),
            );
            expect(order.at(-1)).toBe('reply:answer');
          }
        } finally {
          await page.close();
        }
      });
  it('keeps pending decisions and failed receipts visible, with the existing approval write', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?attention`);
      const approve = page.getByRole('button', {
        name: '允许写入数据',
        exact: true,
      });
      await approve.waitFor();
      expect(
        await page.locator('#operation-receipt-28').innerText(),
      ).not.toContain('结果未确认');
      expect(await processOf(page).getAttribute('data-process-open')).toBe(
        'true',
      );
      expect(
        await page.locator('#operation-receipt-29 article').isVisible(),
      ).toBe(true);
      expect(await processOf(page).locator('article:visible').count()).toBe(2);
      await page.screenshot({ path: join(screenshots, 'attention.png') });
      await page
        .locator('#operation-receipt-28')
        .screenshot({ path: join(screenshots, 'pending-call.png') });
      await page
        .locator('#operation-receipt-29')
        .screenshot({ path: join(screenshots, 'failed-call.png') });
      await approve.click();
      await expect
        .poll(() => page.evaluate(() => window.processWrites.length))
        .toBe(1);
      expect(
        await page.evaluate(
          () => (window.processWrites[0] as { decision: string }).decision,
        ),
      ).toBe('approved');
      await expect.poll(() => approve.count()).toBe(0);
      expect(
        await page.locator('#operation-receipt-29 article').isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('retains receipt-read and trace retry entrances without repeating a call', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?load-error&trace-error`);
      await page.getByRole('button', { name: '重试读取操作状态' }).click();
      await expect.poll(() => calls(page).count()).toBe(34);
      await page
        .getByRole('button', { name: '过程加载失败，点击重试' })
        .click();
      await expect
        .poll(() =>
          page.getByRole('button', { name: '过程加载失败，点击重试' }).count(),
        )
        .toBe(0);
      expect(await calls(page).count()).toBe(34);
    } finally {
      await page.close();
    }
  });
  it('uses completion timing without discarding a call that the reader already expanded', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?live`);
      await expect.poll(() => calls(page).count()).toBe(34);
      await page
        .locator('[data-work-call="tool:call-0"]')
        .getByRole('button')
        .click();
      await page.getByRole('button', { name: '完成本轮', exact: true }).click();
      expect(await processOf(page).getAttribute('data-process-open')).toBe(
        'false',
      );
      await processOf(page).locator('[data-disclosure-row]').first().click();
      await expandGroups(page);
      expect(
        await page.locator('#operation-receipt-0 article').isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  for (const preference of ['next-input', 'verbose'])
    it(`preserves the existing ${preference} preference`, async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}/?${preference}`);
        await expect.poll(() => calls(page).count()).toBe(34);
        expect(await processOf(page).getAttribute('data-process-open')).toBe(
          'true',
        );
        await page
          .getByRole('button', { name: '下一轮输入', exact: true })
          .click();
        expect(await processOf(page).getAttribute('data-process-open')).toBe(
          preference === 'verbose' ? 'true' : 'false',
        );
      } finally {
        await page.close();
      }
    });
  it('keeps compact live details hidden until their existing group is expanded', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?live&compact`);
      await expect.poll(() => calls(page).count()).toBe(34);
      expect(await calls(page).locator(':visible').count()).toBe(0);
      expect(await page.locator('main').innerText()).not.toContain(
        '检查第 1 项公开资料',
      );
      await expandGroups(page);
      expect(await page.locator('[data-work-call]:visible').count()).toBe(34);
    } finally {
      await page.close();
    }
  });
});
