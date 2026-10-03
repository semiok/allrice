import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const integration =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('shared administration shell and dialogs', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/admin-design-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/admin-fixture',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, origin).pathname;
      const asset = assets.get(path);
      if (asset) {
        res.setHeader(
          'Content-Type',
          path.endsWith('.css') ? 'text/css' : 'text/javascript',
        );
        res.end(asset);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin-design-page.css"><div id="root"></div><script type="module" src="/admin-design-page.js"></script>',
        );
      }
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
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('keeps navigation available at 320px and scopes the dark theme to the admin', async () => {
    const page = await browser.newPage({
      viewport: { width: 320, height: 800 },
    });
    try {
      await page.goto(origin);
      await page.getByRole('heading', { name: '组织管理' }).waitFor();
      const colors = await page.evaluate(() => ({
        outside: getComputedStyle(document.querySelector('[data-outside]')!)
          .color,
        admin: getComputedStyle(document.querySelector('[data-admin-theme]')!)
          .color,
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      }));
      expect(colors.admin).not.toBe(colors.outside);
      expect(colors.overflow).toBe(false);
      await page.getByRole('button', { name: 'AI 员工', exact: true }).click();
      await page
        .getByRole('heading', { name: 'AI 员工', exact: true })
        .waitFor();
      expect(
        await page
          .getByRole('button', { name: 'AI 员工', exact: true })
          .getAttribute('aria-current'),
      ).toBe('page');
    } finally {
      await page.close();
    }
  });
  it('traps modal focus, restores the trigger and prevents closing during submission', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const trigger = page.getByRole('button', {
        name: '添加员工',
        exact: true,
      });
      await trigger.click();
      await page
        .getByRole('dialog', { name: '添加员工', exact: true })
        .waitFor();
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(
            () => !!document.activeElement?.closest('dialog'),
          ),
        ).toBe(true);
      }
      await page.getByLabel('提交中').check();
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog').count()).toBe(1);
      await page.getByLabel('提交中').uncheck();
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(
        await trigger.evaluate((el) => el === document.activeElement),
      ).toBe(true);
      await page.getByLabel('员工操作', { exact: true }).first().click();
      await page.getByRole('button', { name: '编辑员工' }).waitFor();
      await trigger.click();
      expect(await page.locator('details[open]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
