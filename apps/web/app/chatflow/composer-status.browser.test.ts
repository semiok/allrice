/** Real Chrome, static props only. No server, DB, device or model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('composer status for ordinary employees', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/composer-status-page.tsx'],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/composer-status-page.css"><div id="root"></div><script type="module" src="/composer-status-page.js"></script>',
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

  async function open(width: number, theme: 'light' | 'dark') {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator('[data-case="tidying"]').waitFor();
    return page;
  }
  const status = (page: Page, name: string) =>
    page.locator(
      `[data-case="${name}"] button[aria-label^="电脑"], [data-case="${name}"] button[aria-label^="正在确认"]`,
    );

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`shows a calm computer status at ${width}px in the ${theme} theme`, async () => {
        const page = await open(width, theme);
        try {
          const text = await page.locator('main').innerText();
          for (const word of ['Bridge', '上下文占用', 'DSH', 'tokens', '%'])
            expect(text).not.toContain(word);
          expect(await status(page, 'offline').innerText()).toBe('电脑未连接');
          expect(await status(page, 'folder').innerText()).toBe('销售周报');
          expect(await status(page, 'tidying').innerText()).toBe(
            '正在确认电脑连接',
          );
          expect(
            await page
              .locator('[data-case="tidying"] [role="status"]')
              .innerText(),
          ).toContain('正在整理对话，完成后继续');
          const look = await status(page, 'offline').evaluate((button) => {
            const dot = button.querySelector('span')!;
            return {
              text: getComputedStyle(button).color,
              background: getComputedStyle(button).backgroundColor,
              dot: getComputedStyle(dot).backgroundColor,
            };
          });
          // Secondary text on no fill; the dot is neutral grey, not red.
          expect(look.text).toBe(
            theme === 'dark' ? 'rgb(207, 211, 214)' : 'rgb(97, 102, 107)',
          );
          expect(look.background).toBe('rgba(0, 0, 0, 0)');
          const [r, g, b] = look.dot.match(/\d+/g)!.map(Number);
          expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(16);
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            ),
          ).toBe(false);
        } finally {
          await page.close();
        }
      });
});
