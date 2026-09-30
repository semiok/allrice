import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('MET-163 platform model settings (synthetic HTTP)', () => {
  it('saves one platform image choice and displays unknown receipts without false zero usage', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/met163-model-page.tsx'],
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
      let settings = {
        revision: 1,
        updatedAt: new Date().toISOString(),
        configuration: {
          connectionId: '52000000-0000-4000-8000-000000000001',
          workModel: 'gpt-6-luna',
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          imageModel: 'gpt-image-2.5-flare',
          imagesEnabled: false,
        },
      };
      let saves = 0;
      await page.route(
        '**/api/v1/admin/platform-model-settings',
        async (route: Route) => {
          if (route.request().method() === 'PUT') {
            const body = route.request().postDataJSON();
            expect(body.expectedRevision).toBe(settings.revision);
            settings = {
              ...settings,
              revision: settings.revision + 1,
              configuration: body.configuration,
            };
            saves++;
          }
          await route.fulfill({ json: { settings } });
        },
      );
      await page.route(
        '**/api/v1/admin/image-operations',
        async (route: Route) =>
          route.fulfill({
            json: {
              operations: [
                {
                  id: 'synthetic',
                  operation: 'edit',
                  status: 'unknown',
                  imageModel: 'gpt-image-2.5-flare',
                  organizationName: '验收租户',
                  createdAt: '2026-09-27T10:00:00Z',
                  errorCode: 'IMAGE_RESULT_UNKNOWN',
                  usage: null,
                },
              ],
            },
          }),
      );
      await page.goto(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      );
      const images = page.getByRole('combobox', { name: '图片模型' });
      await images.waitFor();
      expect(await images.inputValue()).toBe('');
      const workModel = page.getByRole('combobox', { name: '对话与理解模型' });
      expect(await workModel.locator('option').allTextContents()).toEqual([
        'GPT-6.1 Sol',
        'GPT-6 Sol',
        'GPT-6 Luna',
        'GPT-5.3 Codex Spark',
      ]);
      expect(await workModel.inputValue()).toBe('gpt-6-luna');
      expect(
        await page.getByRole('combobox', { name: '推理强度' }).inputValue(),
      ).toBe('xhigh');
      await workModel.selectOption('gpt-6.1-sol');
      await images.selectOption('auto');
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      expect(saves).toBe(1);
      expect(settings.configuration.imagesEnabled).toBe(true);
      expect(settings.configuration.workModel).toBe('gpt-6.1-sol');
      await page.reload();
      await images.waitFor();
      expect(await images.inputValue()).toBe('auto');
      await images.selectOption('gpt-image-2.5-sunburst');
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      expect(settings.configuration.imageModel).toBe('gpt-image-2.5-sunburst');
      await page.reload();
      await images.waitFor();
      expect(await images.inputValue()).toBe('gpt-image-2.5-sunburst');
      await page.locator('summary').click();
      await page
        .getByRole('cell', { name: '结果待核对', exact: true })
        .waitFor();
      expect(
        await page.getByRole('cell', { name: '待核对', exact: true }).count(),
      ).toBe(1);
      await page.screenshot({ path: '/tmp/met163-platform-models.png' });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);
});
