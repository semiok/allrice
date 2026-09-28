import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('Codex authorization UX', () => {
  it('keeps reauthorization secondary, shows compact codes, and handles clipboard denial', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/codex-authorization-page.tsx'],
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
      const panel = page.getByRole('region', { name: 'Codex 订阅连接' });
      await panel.getByText('已连接', { exact: true }).waitFor();
      expect(
        await panel.getByRole('button', { name: '开始重新授权' }).isVisible(),
      ).toBe(false);
      expect(await page.locator('body').getAttribute('data-starts')).toBe(null);
      await panel.locator('summary').click();
      await panel.getByRole('button', { name: '开始重新授权' }).click();
      await panel.getByText('TEST-CODE', { exact: true }).waitFor();
      expect(await page.locator('body').getAttribute('data-starts')).toBe('1');
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async () => {
              throw Error('denied');
            },
          },
        }),
      );
      await panel
        .getByRole('button', { name: '复制授权码', exact: true })
        .click();
      await panel.getByRole('status').filter({ hasText: '手动复制' }).waitFor();
      expect(
        await panel
          .getByRole('link', { name: '打开官方授权页' })
          .getAttribute('href'),
      ).toBe('https://auth.openai.com/codex/device');
      const box = await panel
        .getByRole('button', { name: '复制授权码', exact: true })
        .boundingBox();
      expect(box!.height).toBeLessThan(65);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: '/tmp/allrice-auth-mobile.png' });
      await panel.getByRole('button', { name: '取消本次授权' }).click();
      await panel.getByRole('button', { name: '开始重新授权' }).waitFor();
      expect(await panel.getByText('已连接', { exact: true }).isVisible()).toBe(
        true,
      );
      await page.goto(base + '?disconnected=1');
      await panel.getByRole('button', { name: '连接 Codex 订阅' }).waitFor();
      await page.goto(base + '/?disconnected&failed');
      await page
        .getByRole('alert')
        .filter({ hasText: '连接官方授权服务失败' })
        .waitFor();
      expect(await page.getByText('上一次授权流程已结束。').count()).toBe(0);
      await page.getByRole('button', { name: '连接 Codex 订阅' }).click();
      await page.getByText('TEST-CODE', { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);
});
