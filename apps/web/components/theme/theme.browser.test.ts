/** Real Chrome: the pre-paint script and the theme controller. No server, DB or model. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  BrowserContext,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import { themeScript } from '../../lib/theme/theme-script';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

// What the page looked like right after the theme script, before any content.
const recordFirstPaint = `window.firstPaint = {
  dark: document.body.hasAttribute('data-ds-dark-theme'),
  theme: document.documentElement.getAttribute('data-theme'),
};`;

const rgb = (value: string) =>
  value
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number);
const luminance = (value: string) => {
  const [r, g, b] = rgb(value).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

suite('theme runtime', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/theme-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    type Output = { path: string; contents: Uint8Array };
    const output = (extension: string) =>
      (result.outputFiles as Output[]).find((file) =>
        file.path.endsWith(extension),
      )?.contents;
    const script = output('.js');
    // The CSS modules the page imports (the dialog's surface and backdrop):
    // esbuild emits them beside the script and does not inject them.
    const componentStyles = output('.css');
    expect(script).toBeDefined();
    expect(componentStyles).toBeDefined();
    // The global stylesheets, taken from the root layout in its order.
    const layoutStyles = [
      ...readFileSync('apps/web/app/layout.tsx', 'utf8').matchAll(
        /^import '([^']+\.css)';$/gm,
      ),
    ].map((match) => `@import '${match[1]}';`);
    expect(layoutStyles.length).toBeGreaterThanOrEqual(5);
    const css = await build({
      stdin: {
        contents: layoutStyles.join('\n'),
        resolveDir: resolve('apps/web/app'),
        loader: 'css',
      },
      bundle: true,
      write: false,
    });
    const styles = css.outputFiles[0]!.contents;
    server = createServer((req, res) => {
      const path = new URL(req.url!, origin).pathname;
      if (path === '/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(script);
      } else if (path === '/fixture.css' || path === '/components.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(path === '/fixture.css' ? styles : componentStyles);
      } else {
        // Same order as the root layout: theme script first in <body>.
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html><html data-allrice-framework="v2" lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><link rel="stylesheet" href="/components.css"></head><body><script>${themeScript}</script><script>${recordFirstPaint}</script><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
        );
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
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
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  async function open(
    path: string,
    options: {
      width?: number;
      stored?: Record<string, string>;
      colorScheme?: 'light' | 'dark';
      context?: BrowserContext;
    } = {},
  ) {
    const context =
      options.context ??
      (await browser.newContext({
        viewport: { width: options.width ?? 1440, height: 800 },
        colorScheme: options.colorScheme ?? 'light',
      }));
    if (options.stored)
      await context.addInitScript((stored) => {
        for (const [key, value] of Object.entries(stored))
          localStorage.setItem(key, value);
      }, options.stored);
    const page = await context.newPage();
    await page.goto(`${origin}${path}`);
    await page.locator('#surface').waitFor();
    return page;
  }
  const state = (page: Page) =>
    page.evaluate(() => ({
      firstPaint: (window as unknown as { firstPaint: object }).firstPaint,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      theme: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      layer: getComputedStyle(document.body).getPropertyValue(
        '--dsw-alias-bg-layer-1',
      ),
      overflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    }));

  // Media query changes are reported before the next animation frame.
  const settle = (page: Page) =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );

  for (const width of [1440, 390]) {
    // A dark system theme must not leak into either default.
    it(`paints the workspace light from the first frame at ${width}px`, async () => {
      const page = await open('/chatflow', { width, colorScheme: 'dark' });
      try {
        expect(await state(page)).toMatchObject({
          firstPaint: { dark: false, theme: 'light' },
          dark: false,
          theme: 'light',
          colorScheme: 'light',
          overflow: false,
        });
      } finally {
        await page.context().close();
      }
    });
    it(`paints the admin console dark from the first frame at ${width}px`, async () => {
      const page = await open('/runtime-console', { width });
      try {
        const current = await state(page);
        expect(current).toMatchObject({
          firstPaint: { dark: true, theme: 'dark' },
          dark: true,
          theme: 'dark',
          colorScheme: 'dark',
          overflow: false,
        });
        expect(current.layer.replace(/\s/g, '')).toBe('rgb(35,35,36)');
      } finally {
        await page.context().close();
      }
    });
  }

  // The dialog's own surface (Dialog.module.css): white on the workspace,
  // DSH's dark input surface on the admin console.
  const dialogSurface = {
    '/chatflow': 'rgb(255,255,255)',
    '/runtime-console': 'rgb(44,44,46)',
  };
  for (const width of [1440, 390])
    for (const [path, surface] of Object.entries(dialogSurface))
      it(`keeps a DSH dialog readable on ${path} at ${width}px`, async () => {
        const page = await open(`${path}?dialog`, { width });
        try {
          const dialog = page.getByRole('dialog', { name: '员工详情' });
          await dialog.waitFor();
          const colors = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]')!;
            const text = document.getElementById('dialog-text')!;
            // The first painted box behind the text is what it is read on.
            let painted: Element | null = text;
            while (
              painted &&
              getComputedStyle(painted).backgroundColor === 'rgba(0, 0, 0, 0)'
            )
              painted = painted.parentElement;
            return {
              paintedByDialog: painted === dialog,
              background: getComputedStyle(dialog).backgroundColor,
              backdrop: getComputedStyle(dialog.parentElement!).position,
              text: getComputedStyle(text).color,
              title: getComputedStyle(dialog.querySelector('h2')!).color,
              overflow:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            };
          });
          expect(colors).toMatchObject({
            paintedByDialog: true,
            backdrop: 'fixed',
            overflow: false,
          });
          expect(colors.background.replace(/\s/g, '')).toBe(surface);
          expect(
            contrast(colors.text, colors.background),
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrast(colors.title, colors.background),
          ).toBeGreaterThanOrEqual(4.5);
          // It closes, and the backdrop goes with it.
          await dialog.getByRole('button', { name: '关闭' }).click();
          await expect.poll(() => dialog.count()).toBe(0);
          await page.getByRole('button', { name: '去前台' }).click();
        } finally {
          await page.context().close();
        }
      });

  it('applies a stored choice per surface and ignores the system theme', async () => {
    const cases: [string, Record<string, string>, 'light' | 'dark', boolean][] =
      [
        ['/runtime-console', { 'allrice.theme.admin': 'light' }, 'dark', false],
        ['/chatflow', { 'allrice.theme.tenant': 'dark' }, 'light', true],
        ['/chatflow', { 'allrice.theme.admin': 'light' }, 'dark', false],
        // Unknown values, including a "system" this runtime never offers,
        // mean no choice.
        ['/chatflow', { 'allrice.theme.tenant': 'system' }, 'dark', false],
        [
          '/runtime-console',
          { 'allrice.theme.admin': 'system' },
          'light',
          true,
        ],
        ['/chatflow', { 'allrice.theme.tenant': 'purple' }, 'dark', false],
      ];
    for (const [path, stored, colorScheme, dark] of cases) {
      const page = await open(path, { stored, colorScheme });
      try {
        const current = await state(page);
        expect(current.firstPaint, `${path} ${JSON.stringify(stored)}`).toEqual(
          { dark, theme: dark ? 'dark' : 'light' },
        );
        expect(current.dark).toBe(dark);
      } finally {
        await page.context().close();
      }
    }
  });

  it('switches on client navigation between the workspace and the admin console', async () => {
    const page = await open('/chatflow');
    try {
      await page.getByRole('button', { name: '去后台' }).click();
      await expect.poll(async () => (await state(page)).dark).toBe(true);
      await page.getByRole('button', { name: '去前台' }).click();
      await expect.poll(async () => (await state(page)).dark).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  it('saves a workspace choice, keeps it across pages, and leaves the admin console alone', async () => {
    const context = await browser.newContext({ colorScheme: 'light' });
    try {
      const page = await open('/chatflow', { context });
      const other = await context.newPage();
      await other.goto(`${origin}/chatflow`);
      await other.locator('#surface').waitFor();
      await page.getByRole('button', { name: '选深色' }).click();
      // At once in this tab, and in the other open tab through storage.
      expect(await state(page)).toMatchObject({ dark: true, theme: 'dark' });
      await expect
        .poll(() => page.locator('#saved').textContent())
        .toBe('true');
      await expect.poll(async () => (await state(other)).dark).toBe(true);
      // The admin console keeps its own default; back in the workspace the
      // choice holds, and a reload paints it from the first frame.
      await page.getByRole('button', { name: '去后台' }).click();
      await expect.poll(async () => (await state(page)).dark).toBe(true);
      await page.getByRole('button', { name: '去前台' }).click();
      expect((await state(page)).dark).toBe(true);
      await page.reload();
      await page.locator('#surface').waitFor();
      expect((await state(page)).firstPaint).toEqual({
        dark: true,
        theme: 'dark',
      });
      // A system change moves neither a saved choice nor a default.
      await page.emulateMedia({ colorScheme: 'light' });
      await settle(page);
      expect((await state(page)).dark).toBe(true);
      await page.getByRole('button', { name: '选浅色' }).click();
      await expect.poll(async () => (await state(other)).dark).toBe(false);
      await other.emulateMedia({ colorScheme: 'dark' });
      await settle(other);
      expect((await state(other)).dark).toBe(false);
      expect(
        await page.evaluate(() => localStorage.getItem('allrice.theme.tenant')),
      ).toBe('light');
    } finally {
      await context.close();
    }
  });
});
