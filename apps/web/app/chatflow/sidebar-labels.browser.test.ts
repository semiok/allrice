/** Real Chrome, static props only. No server, DB, device or model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Locator,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

// MET-214 dark audit D07, D11 and L01: small labels in the sidebar, the
// 「新的工作」 dialog and the workbench badge read at 4.5:1 in both themes.
suite('sidebar, new-work dialog and workbench badge labels', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/sidebar-labels-page.tsx'],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/sidebar-labels-page.css"><div id="root"></div><script type="module" src="/sidebar-labels-page.js"></script>',
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
  }, 60_000);
  // Closing real Chrome can take over 10 seconds on macOS.
  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 60_000);

  /** Contrast of the text against the backgrounds actually stacked behind it. */
  const contrast = (node: Locator) =>
    node.evaluate((element) => {
      const rgba = (value: string) => {
        const [r = 0, g = 0, b = 0, a = 1] = value
          .match(/[\d.]+/g)!
          .map(Number);
        return [r, g, b, a] as const;
      };
      const over = (
        top: readonly number[],
        under: readonly number[],
      ): number[] =>
        [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
      const layers: (readonly number[])[] = [];
      for (let at: Element | null = element; at; at = at.parentElement) {
        const layer = rgba(getComputedStyle(at).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] === 1) break;
      }
      let ground: number[] = [255, 255, 255];
      for (const layer of layers.reverse()) ground = over(layer, ground);
      const text = over(rgba(getComputedStyle(element).color), ground);
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const [x, y] = [luminance(text), luminance(ground)].sort((m, n) => n - m);
      return (x! + 0.05) / (y! + 0.05);
    });
  const measured: string[] = [];
  const readable = async (label: string, node: Locator) => {
    await node.waitFor();
    const ratio = await contrast(node);
    measured.push(`${label} ${ratio.toFixed(2)}`);
    expect.soft(ratio, label).toBeGreaterThanOrEqual(4.5);
  };
  const noOverflow = async (page: Page) =>
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const) {
      it(`reads the sidebar and badge at ${width}px in the ${theme} theme`, async () => {
        measured.length = 0;
        // Reduced motion drops the 140ms hover fade, so hover reads settled.
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        try {
          await page.goto(`${origin}/?theme=${theme}`);
          const tree = page.getByRole('tree', { name: '员工与工作' });
          const label = tree.getByText('默认', { exact: true });
          await readable('default label', label);
          const selected = tree.locator(
            '[role="treeitem"][aria-selected="true"]',
          );
          await readable(
            'selected session time',
            selected.getByText(/^\d+分钟$/),
          );
          await readable(
            'empty employee hint',
            tree.getByText('从顶部「新的工作」开始', { exact: true }),
          );
          const files = page.getByRole('button', {
            name: '工作区文件，1 项新增',
          });
          await readable(
            'new deliverable badge',
            files.getByText('1', { exact: true }),
          );
          await noOverflow(page);
          // The employee card darkens under the pointer.
          await tree.getByText('Rice', { exact: true }).hover();
          await readable('default label on hover', label);
        } finally {
          console.info(`${width}px ${theme}: ${measured.join(', ')}`);
          await page.close();
        }
      });

      it(`reads the new-work dialog at ${width}px in the ${theme} theme`, async () => {
        measured.length = 0;
        // Reduced motion drops the 140ms hover fade, so hover reads settled.
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        try {
          await page.goto(`${origin}/?theme=${theme}&dialog=picker`);
          const dialog = page.getByRole('dialog', { name: '选择 AI 员工' });
          await readable(
            'dialog eyebrow',
            dialog.locator('header p').getByText('新的工作', { exact: true }),
          );
          const badge = dialog.getByText('默认', { exact: true });
          await readable('employee default badge', badge);
          await readable(
            'dialog footer',
            dialog.getByText('选择一位员工，开始新的工作', { exact: true }),
          );
          // The shortcut hint is desktop-only.
          if (width > 560)
            await readable('close shortcut', dialog.locator('kbd'));
          await noOverflow(page);
          await dialog.getByText('Rice', { exact: true }).hover();
          await readable('employee default badge on hover', badge);
        } finally {
          console.info(`${width}px ${theme}: ${measured.join(', ')}`);
          await page.close();
        }
      });
    }
});
