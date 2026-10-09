import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairFixture } from '../../test/platform-repair-fixture';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('report-only historical repair view', () => {
  it('allows refresh, historical details and cancellation while refusing new repair controls', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-report-only-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-report-only',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((request, response) => {
      const extension =
        request.url === '/app.js'
          ? '.js'
          : request.url === '/app.css'
            ? '.css'
            : null;
      if (extension) {
        response.setHeader(
          'content-type',
          extension === '.js' ? 'text/javascript' : 'text/css',
        );
        response.end(
          built.outputFiles?.find((f: { path: string; text: string }) =>
            f.path.endsWith(extension),
          )?.text ?? '',
        );
      } else
        response.end(
          '<div id="root"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
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
    const writes: string[] = [];
    try {
      const page = await browser.newPage();
      const historical = {
        ...repairFixture(),
        status: 'succeeded' as 'succeeded' | 'queued',
      };
      await page.route(
        '**/api/v1/admin/technical-assistant/**',
        async (route: Route) => {
          const request = route.request(),
            path = new URL(request.url()).pathname;
          if (request.method() !== 'GET') {
            writes.push(request.method() + ' ' + path);
            return route.fulfill({
              status: 403,
              json: { error: 'platform_autonomous_actions_deferred' },
            });
          }
          if (path.endsWith('/baselines'))
            return route.fulfill({
              json: { state: 'available', baselines: [historical.baseline] },
            });
          if (path.endsWith('/repair'))
            return route.fulfill({ json: [historical] });
          if (path.endsWith('/repository-credential'))
            return route.fulfill({ json: { state: 'not_configured' } });
          return route.fulfill({ json: [] });
        },
      );
      await page.goto(
        'http://127.0.0.1:' + (server.address() as { port: number }).port,
      );
      await page.getByRole('button', { name: '查看修复详情' }).click();
      await page.getByRole('article', { name: '修复详情' }).waitFor();
      expect(
        await page
          .getByRole('button', { name: '生成修复候选', exact: true })
          .isDisabled(),
      ).toBe(true);
      historical.status = 'queued';
      await page.getByRole('button', { name: '刷新修复记录' }).click();
      expect(
        await page
          .getByRole('button', { name: '停止修复', exact: true })
          .isDisabled(),
      ).toBe(false);
      expect(
        await page
          .getByRole('button', { name: '提交候选到 GitHub', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.getByRole('button', { name: '刷新修复记录' }).click();
      await page.getByRole('button', { name: '刷新发布记录' }).click();
      expect(
        await page
          .getByText('自主修复与发布延期，当前仅查看历史记录。', {
            exact: true,
          })
          .isVisible(),
      ).toBe(true);
      expect(writes).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 15000);
});
