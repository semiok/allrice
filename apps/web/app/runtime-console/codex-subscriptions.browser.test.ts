import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('Codex subscription account controls', () => {
  it('labels both slots, explicitly activates one or neither, and keeps authorization separate', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/codex-subscriptions-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-met163',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((req, res) => {
      const css = req.url === '/app.css',
        js = req.url === '/app.js';
      res.setHeader(
        'content-type',
        css ? 'text/css' : js ? 'text/javascript' : 'text/html',
      );
      res.end(
        js || css
          ? built.outputFiles.find((f: { path: string }) =>
              f.path.endsWith(css ? '.css' : '.js'),
            ).contents
          : '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body style="padding:24px;font-family:system-ui;background:#181b20;color:white"><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 850 },
      });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await page.goto(base);
      const one = page.getByRole('region', {
        name: '1 号 · metasnowsky',
        exact: true,
      });
      const two = page.getByRole('region', {
        name: '2 号 · encorealpha',
        exact: true,
      });
      await one.getByText('已启用', { exact: true }).waitFor();
      expect(
        await two.getByRole('button', { name: '启用 2 号' }).isDisabled(),
      ).toBe(true);
      await two.getByRole('button', { name: '连接 Codex 订阅' }).click();
      expect(await page.locator('body').getAttribute('data-authorizing')).toBe(
        '2',
      );
      await one.getByText('已启用', { exact: true }).waitFor();
      await two.getByText('已停用', { exact: true }).waitFor();
      await two.getByRole('button', { name: '启用 2 号' }).click();
      await one.getByText('已停用', { exact: true }).waitFor();
      await two.getByText('已启用', { exact: true }).waitFor();
      await page.getByRole('button', { name: '全部停用', exact: true }).click();
      await one.getByText('已停用', { exact: true }).waitFor();
      await two.getByText('已停用', { exact: true }).waitFor();
      await page
        .getByRole('status')
        .filter({ hasText: 'Codex 任务暂不可执行' })
        .waitFor();
      await one.getByRole('button', { name: '启用 1 号' }).click();
      await one.getByText('已启用', { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: '/tmp/allrice-codex-slots-mobile.png',
        fullPage: true,
      });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);
});
