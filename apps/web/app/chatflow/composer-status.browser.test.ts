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
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
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
    page.locator(`[data-case="${name}"] button[aria-label^="电脑"]`);

  const contrast = (a: string, b: string) => {
    const luminance = (value: string) => {
      const [r, g, b] = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map((v) => {
          const c = Number(v) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`shows a calm computer status at ${width}px in the ${theme} theme`, async () => {
        const page = await open(width, theme);
        try {
          const text = await page.locator('main').innerText();
          for (const word of ['Bridge', '上下文占用', 'DSH', 'tokens', '%'])
            expect(text).not.toContain(word);
          const expected: Record<string, string> = {
            offline: '电脑未连接',
            connected: '电脑已连接 · 未选文件夹',
            folder: '销售周报',
            tidying: '电脑连接状态待确认',
          };
          for (const [name, label] of Object.entries(expected)) {
            const button = status(page, name);
            expect(await button.innerText()).toBe(label);
            // Speaking the visible words must find the button (WCAG 2.5.3).
            expect(await button.getAttribute('aria-label')).toContain(label);
            const look = await button.evaluate((node) => {
              let element: Element | null = node;
              let ground = 'rgba(0, 0, 0, 0)';
              while (element && /rgba\(0, 0, 0, 0\)/.test(ground)) {
                ground = getComputedStyle(element).backgroundColor;
                element = element.parentElement;
              }
              const box = node.getBoundingClientRect();
              const column = node.closest('section')!.getBoundingClientRect();
              return {
                text: getComputedStyle(node).color,
                fill: getComputedStyle(node).backgroundColor,
                ground,
                dot: getComputedStyle(node.querySelector('span')!)
                  .backgroundColor,
                inside: box.left >= column.left && box.right <= column.right,
              };
            });
            expect(look.fill).toBe('rgba(0, 0, 0, 0)');
            expect(contrast(look.text, look.ground)).toBeGreaterThanOrEqual(
              4.5,
            );
            expect(look.inside).toBe(true);
            // A visible dot: opaque, not a transparent placeholder.
            expect(look.dot).toMatch(/^rgb\(/);
            if (name === 'offline' || name === 'tidying') {
              // Not connected is neutral grey, never red.
              const [r, g, b] = look.dot.match(/\d+/g)!.map(Number);
              expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(
                16,
              );
            }
          }
          expect(
            await page
              .locator('[data-case="tidying"] [role="status"]')
              .innerText(),
          ).toContain('正在整理对话，完成后继续');
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
