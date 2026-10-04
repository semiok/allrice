import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;

suite('Platform application configuration (synthetic HTTP)', () => {
  it('submits OAuth configuration, preserves the stored secret and reports revision conflicts', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-mcp-settings-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-platform-apps',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((request, response) => {
      const css = request.url === '/app.css',
        js = request.url === '/app.js';
      response.setHeader(
        'content-type',
        css ? 'text/css' : js ? 'text/javascript' : 'text/html',
      );
      response.end(
        css || js
          ? built.outputFiles.find((file: { path: string }) =>
              file.path.endsWith(css ? '.css' : '.js'),
            ).contents
          : '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
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
        viewport: { width: 1280, height: 900 },
      });
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      let settings = {
        revision: 0,
        clientId: 'fixture-client',
        callbackUrl:
          'https://fixture.invalid/api/v1/connections/github/callback',
        secretConfigured: false,
        ready: false,
      };
      const writes: Record<string, unknown>[] = [];
      let conflict = false;
      await page.route('**/api/v1/admin/mcp-apps', async (route: Route) => {
        if (route.request().method() === 'PUT') {
          const body = route.request().postDataJSON();
          writes.push(body);
          if (conflict) {
            await route.fulfill({
              status: 409,
              json: { error: { message: '配置已变化，请刷新后再保存。' } },
            });
            return;
          }
          expect(body.expectedRevision).toBe(settings.revision);
          settings = {
            ...settings,
            revision: settings.revision + 1,
            clientId: body.clientId,
            callbackUrl: body.callbackUrl,
            secretConfigured: true,
            ready: true,
          };
        } else expect(route.request().method()).toBe('GET');
        await route.fulfill({ json: { settings } });
      });
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await page.goto(base);
      const secret = page.getByLabel('Client Secret', { exact: true });
      const client = page.getByLabel('Client ID', { exact: true });
      const save = page.getByRole('button', {
        name: '保存 GitHub 授权配置',
        exact: true,
      });
      await client.waitFor();
      await secret.fill('synthetic-secret-1');
      await save.click();
      await page.getByRole('status').filter({ hasText: '已保存。' }).waitFor();
      expect(writes).toEqual([
        {
          expectedRevision: 0,
          clientId: 'fixture-client',
          callbackUrl: settings.callbackUrl,
          clientSecret: 'synthetic-secret-1',
        },
      ]);
      expect(await secret.inputValue()).toBe('');
      expect(await secret.getAttribute('type')).toBe('password');
      expect(await page.locator('body').innerText()).not.toContain(
        'synthetic-secret-1',
      );
      await save.click();
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[1]).not.toHaveProperty('clientSecret');
      expect(writes[1]?.expectedRevision).toBe(1);
      await page.reload();
      await client.waitFor();
      expect(await client.inputValue()).toBe('fixture-client');
      expect(await secret.inputValue()).toBe('');
      expect(await secret.getAttribute('required')).toBeNull();
      conflict = true;
      await client.fill('fixture-other');
      await secret.fill('synthetic-secret-2');
      await save.click();
      await page
        .getByRole('status')
        .filter({ hasText: '配置已变化' })
        .waitFor();
      expect(writes.length).toBe(3);
      expect(settings.clientId).toBe('fixture-client');
      expect(await secret.inputValue()).toBe('synthetic-secret-2');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);
});
