/** Real Chrome, static props only. No server, DB, device or model. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
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
    // The global stylesheets, taken from the root layout in its order, as
    // theme.browser.test.ts does; the page's component styles load after.
    const layoutStyles = [
      ...readFileSync('apps/web/app/layout.tsx', 'utf8').matchAll(
        /^import '([^']+\.css)';$/gm,
      ),
    ].map((match) => `@import '${match[1]}';`);
    expect(layoutStyles.length).toBeGreaterThanOrEqual(5);
    const globals = await build({
      stdin: {
        contents: layoutStyles.join('\n'),
        resolveDir: resolve('apps/web/app'),
        loader: 'css',
      },
      bundle: true,
      write: false,
    });
    assets.set('/layout.css', globals.outputFiles[0]!.contents);
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
          '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/sidebar-labels-page.css"></head><body><div id="root"></div><script type="module" src="/sidebar-labels-page.js"></script></body></html>',
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
  /** Text needs 4.5:1; an icon that carries meaning (the pin) needs 3:1. */
  const readable = async (label: string, node: Locator, minimum = 4.5) => {
    await node.waitFor();
    const ratio = await contrast(node);
    measured.push(`${label} ${ratio.toFixed(2)}`);
    expect.soft(ratio, label).toBeGreaterThanOrEqual(minimum);
  };
  const noOverflow = async (page: Page) =>
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  const measure = async (
    name: string,
    width: number,
    check: (page: Page) => Promise<void>,
  ) => {
    measured.length = 0;
    // Reduced motion drops the 140ms hover fade, so hover reads settled.
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    try {
      await check(page);
      await noOverflow(page);
    } finally {
      console.info(`${name}: ${measured.join(', ')}`);
      await page.close();
    }
  };
  const tree = (page: Page) => page.getByRole('tree', { name: '员工与工作' });
  const row = (page: Page, title: string) =>
    tree(page).locator('[role="treeitem"]').filter({ hasText: title });
  const time = (row: Locator) => row.getByText(/^\d+分钟$/);
  // Rows here carry no action menu, like another member's shared session,
  // so a focused row keeps its last cell (time or pin) on hover too.
  const hoverFocused = async (row: Locator) => {
    await row.focus();
    await row.hover();
  };

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const) {
      const at = `${width}px ${theme}`;
      it(`reads the sidebar and badge at ${at}`, () =>
        measure(`${at} sidebar`, width, async (page) => {
          await page.goto(`${origin}/?theme=${theme}`);
          const label = tree(page).getByText('默认', { exact: true });
          await readable('default label', label);
          await readable(
            'empty employee hint',
            tree(page).getByText('从顶部「新的工作」开始', { exact: true }),
          );
          const files = page.getByRole('button', {
            name: '工作区文件，1 项新增',
          });
          await readable(
            'new deliverable badge',
            files.getByText('1', { exact: true }),
          );
          // The employee card darkens under the pointer.
          await tree(page).getByText('Rice', { exact: true }).hover();
          await readable('default label on hover', label);
        }));

      it(`reads session times and the pin at ${at}`, () =>
        measure(`${at} rows`, width, async (page) => {
          await page.goto(`${origin}/?theme=${theme}&active=budget`);
          const selected = row(page, '核对十月预算');
          expect(await selected.getAttribute('aria-selected')).toBe('true');
          await readable('selected time', time(selected));
          const other = row(page, '会议纪要');
          await readable('unselected time', time(other));
          const pinned = row(page, '整理本周销售周报');
          const marker = (row: Locator) => row.locator(':scope > [role="img"]');
          await readable('pin', marker(pinned), 3);
          await hoverFocused(selected);
          await readable('selected time, hovered and focused', time(selected));
          await hoverFocused(other);
          await readable('unselected time, hovered and focused', time(other));
          // The pinned session selected: its marker sits on the selected fill.
          await page.goto(`${origin}/?theme=${theme}&active=weekly`);
          const pin = marker(row(page, '整理本周销售周报'));
          await readable('selected pin', pin, 3);
          await hoverFocused(row(page, '整理本周销售周报'));
          await readable('selected pin, hovered and focused', pin, 3);
        }));

      it(`reads the new-work dialog at ${at}`, () =>
        measure(`${at} new-work`, width, async (page) => {
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
          const card = dialog.locator('button').filter({ hasText: 'Rice' });
          await card.hover();
          await readable('employee default badge on hover', badge);
          // The shortcut hint and the hover「开始」 are desktop-only.
          if (width > 560) {
            await readable('close shortcut', dialog.locator('kbd'));
            await readable(
              'start on hover',
              card.getByText('开始', { exact: true }),
            );
          }
        }));

      for (const [kind, name, eyebrow] of [
        ['reference', '引用会话', '会话资料'],
        ['versions', '周报.docx 的版本历史', 'Rice 交付物'],
        ['brand', '内容工作台', '内容员工'],
      ] as const)
        it(`reads the ${kind} dialog eyebrow at ${at}`, () =>
          measure(`${at} ${kind}`, width, async (page) => {
            await page.goto(`${origin}/?theme=${theme}&dialog=${kind}`);
            await readable(
              `${kind} eyebrow`,
              page
                .getByRole('dialog', { name })
                .locator('header p')
                .getByText(eyebrow, { exact: true }),
            );
          }));
    }
});
