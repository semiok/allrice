/** Real Chrome: the pre-paint script and the theme controller. No server, DB or model. */
import { createRequire } from 'node:module';
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
    const css = await build({
      stdin: {
        contents: [
          "@import './apps/web/app/dsh-upstream/design-platform.css';",
          "@import './apps/web/app/dsh-upstream/base.css';",
          "@import './apps/web/app/styles/base.css';",
        ].join('\n'),
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      write: false,
    });
    const script = result.outputFiles[0]!.contents;
    const styles = css.outputFiles[0]!.contents;
    server = createServer((req, res) => {
      const path = new URL(req.url!, origin).pathname;
      if (path === '/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(script);
      } else if (path === '/fixture.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(styles);
      } else {
        // Same order as the root layout: theme script first in <body>.
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><script>${themeScript}</script><script>${recordFirstPaint}</script><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
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
      // What a DSH dialog portaled to <body> paints with.
      layer: getComputedStyle(document.body).getPropertyValue(
        '--dsw-alias-bg-layer-1',
      ),
    }));

  for (const width of [1440, 390]) {
    it(`paints the workspace light from the first frame at ${width}px`, async () => {
      const page = await open('/chatflow', { width });
      try {
        expect(await state(page)).toMatchObject({
          firstPaint: { dark: false, theme: 'light' },
          dark: false,
          theme: 'light',
          colorScheme: 'light',
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
        });
        expect(current.layer.replace(/\s/g, '')).toBe('rgb(35,35,36)');
      } finally {
        await page.context().close();
      }
    });
  }

  for (const path of ['/chatflow', '/runtime-console'])
    it(`keeps a DSH dialog readable on ${path}`, async () => {
      const page = await open(path);
      try {
        await page.locator('#dialog-text').waitFor();
        const colors = await page.evaluate(() => {
          const text = document.getElementById('dialog-text')!;
          const title = [...document.querySelectorAll('h2')].find(
            (node) => node.textContent === '员工详情',
          )!;
          let node: Element | null = text;
          let background = 'rgba(0, 0, 0, 0)';
          while (node && background === 'rgba(0, 0, 0, 0)') {
            background = getComputedStyle(node).backgroundColor;
            node = node.parentElement;
          }
          return {
            text: getComputedStyle(text).color,
            title: getComputedStyle(title).color,
            background,
          };
        });
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
        expect(contrast(colors.text, colors.background)).toBeGreaterThan(4.5);
        expect(contrast(colors.title, colors.background)).toBeGreaterThan(4.5);
      } finally {
        await page.context().close();
      }
    });

  it('applies a stored choice per surface, and follows the system only when asked', async () => {
    const cases: [string, Record<string, string>, 'light' | 'dark', boolean][] =
      [
        [
          '/runtime-console',
          { 'allrice.theme.admin': 'light' },
          'light',
          false,
        ],
        ['/chatflow', { 'allrice.theme.tenant': 'dark' }, 'dark', true],
        ['/chatflow', { 'allrice.theme.admin': 'light' }, 'dark', false],
        ['/chatflow', { 'allrice.theme.tenant': 'system' }, 'dark', true],
        ['/chatflow', { 'allrice.theme.tenant': 'purple' }, 'dark', false],
      ];
    for (const [path, stored, colorScheme, dark] of cases) {
      const page = await open(path, { stored, colorScheme });
      try {
        const current = await state(page);
        expect(current.firstPaint, `${path} ${JSON.stringify(stored)}`).toEqual(
          { dark, theme: dark ? 'dark' : 'light' },
        );
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

  it('follows a choice made in another tab and a system change under 跟随系统', async () => {
    const context = await browser.newContext({ colorScheme: 'light' });
    try {
      const page = await open('/chatflow', { context });
      const other = await context.newPage();
      await other.goto(`${origin}/chatflow`);
      await other.evaluate(() =>
        localStorage.setItem('allrice.theme.tenant', 'dark'),
      );
      await expect.poll(async () => (await state(page)).dark).toBe(true);
      await other.evaluate(() =>
        localStorage.setItem('allrice.theme.tenant', 'system'),
      );
      await expect.poll(async () => (await state(page)).dark).toBe(false);
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(async () => (await state(page)).dark).toBe(true);
    } finally {
      await context.close();
    }
  });
});
