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
// create-employee dialog and workbench badge read at 4.5:1 in both themes.
suite('sidebar, create-employee dialog and workbench badge labels', () => {
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
    touch = false,
  ) => {
    measured.length = 0;
    // Reduced motion drops the 140ms hover fade, so hover reads settled.
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
      hasTouch: touch,
      isMobile: touch,
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
    expect(await row.locator(':scope > span').last().isVisible()).toBe(true);
    await row.hover();
  };

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const) {
      const at = `${width}px ${theme}`;
      it(`reads the sidebar and badge at ${at}`, () =>
        measure(`${at} sidebar`, width, async (page) => {
          await page.goto(`${origin}/?theme=${theme}`);
          expect(
            await tree(page).getByText('默认', { exact: true }).count(),
          ).toBe(0);
          const label = tree(page).getByText('3 个工作', { exact: true });
          await readable('saved work count', label);
          await readable(
            'empty employee hint',
            tree(page).getByText('点卡片上的加号开始', { exact: true }),
          );
          const files = page.getByRole('button', {
            name: '交付成果，1 项新增',
          });
          await readable(
            'new deliverable badge',
            files.getByText('1', { exact: true }),
          );
          // The employee card darkens under the pointer.
          await tree(page).getByText('Rice', { exact: true }).hover();
          await readable('saved work count on hover', label);
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
          await readable('selected time on hover', time(selected));
          await hoverFocused(other);
          await readable('unselected time on hover', time(other));
          // The pinned session selected: its marker sits on the selected fill.
          await page.goto(`${origin}/?theme=${theme}&active=weekly`);
          const pin = marker(row(page, '整理本周销售周报'));
          await readable('selected pin', pin, 3);
          await hoverFocused(row(page, '整理本周销售周报'));
          await readable('selected pin on hover', pin, 3);
        }));

      it(`keeps shared-session tail cells readable on touch at ${at}`, () =>
        measure(
          `${at} touch rows`,
          width,
          async (page) => {
            await page.goto(`${origin}/?theme=${theme}&active=budget`);
            expect(
              await page.evaluate(() => matchMedia('(hover: none)').matches),
            ).toBe(true);
            const selected = row(page, '核对十月预算');
            const pinned = row(page, '整理本周销售周报');
            await readable('touch selected time', time(selected));
            await readable(
              'touch pin',
              pinned.locator(':scope > [role="img"]'),
              3,
            );
            await selected.tap();
            await readable('touch selected time after tap', time(selected));
            await pinned.tap();
            await readable(
              'touch pin after tap',
              pinned.locator(':scope > [role="img"]'),
              3,
            );
          },
          true,
        ));

      it(`clips long titles and reveals them on native hover at ${at}`, () =>
        measure(`${at} long titles`, width, async (page) => {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.goto(`${origin}/?theme=${theme}&long-title=1`);
          const title = tree(page).getByText(/^整理本周销售周报与重点客户/);
          const avatar = tree(page).getByText('R', { exact: true });
          const titleBox = await title.boundingBox();
          const avatarBox = await avatar.boundingBox();
          expect(Math.abs(titleBox!.x - avatarBox!.x - 20)).toBeLessThanOrEqual(
            0.5,
          );
          expect(
            await tree(page).evaluate(
              (node) => node.scrollWidth - node.clientWidth,
            ),
          ).toBe(0);
          const titleState = () =>
            title.evaluate((node) => ({
              left: node.scrollLeft,
              range: node.scrollWidth - node.clientWidth,
              overflow: getComputedStyle(node).textOverflow,
            }));
          expect(await titleState()).toMatchObject({
            left: 0,
            overflow: 'ellipsis',
          });
          expect((await titleState()).range).toBeGreaterThan(8);
          const unbroken = tree(page).getByText(/^QuarterlyRevenueAndCustomer/);
          expect(
            await unbroken.evaluate(
              (node) =>
                node.scrollWidth > node.clientWidth &&
                getComputedStyle(node).textOverflow === 'ellipsis',
            ),
          ).toBe(true);
          await title.hover();
          await expect
            .poll(async () => (await titleState()).left)
            .toBeGreaterThan(8);
          const moving = await titleState();
          expect(moving.left).toBeLessThan(moving.range);
          expect(moving.overflow).toBe('clip');
          await expect
            .poll(async () => (await titleState()).left)
            .toBeGreaterThan(moving.left + 8);
          await page.mouse.move(width - 1, 899);
          await expect
            .poll(titleState)
            .toMatchObject({ left: 0, overflow: 'ellipsis' });
        }));

      it(`reads the create-employee dialog at ${at}`, () =>
        measure(`${at} create-employee`, width, async (page) => {
          await page.goto(`${origin}/?theme=${theme}&dialog=create`);
          const dialog = page.getByRole('dialog', { name: '创建 AI 员工' });
          await readable(
            'dialog title',
            dialog.getByRole('heading', {
              name: '创建 AI 员工 员工由人设、技能、工作场景、插件、记忆五部分组成',
              exact: true,
            }),
          );
          await readable(
            'creation guidance',
            dialog.getByText(
              '员工由人设、技能、工作场景、插件、记忆五部分组成',
              { exact: true },
            ),
          );
          expect(
            await dialog
              .getByText('名字和使命填好后才能创建', { exact: true })
              .count(),
          ).toBe(0);
          expect(
            await dialog
              .getByRole('button', { name: '确认创建', exact: true })
              .isDisabled(),
          ).toBe(true);
          expect(await dialog.getByText('默认', { exact: true }).count()).toBe(
            0,
          );
          for (const name of [
            '技能 Skills',
            '工作场景 Workflow',
            '插件 Plugins',
            '记忆 Memory',
          ])
            await readable(
              `${name} description heading`,
              dialog.getByRole('heading', { name, exact: true }),
            );
          for (const [title, status] of [
            ['技能 Skills', '自带基础技能，可再添加'],
            ['工作场景 Workflow', '默认没有，可添加'],
            ['插件 Plugins', '默认没有，可添加'],
            ['记忆 Memory', '最多 100 条'],
          ] as const)
            await readable(
              `${title} status`,
              dialog
                .getByRole('heading', { name: title, exact: true })
                .locator('..')
                .locator('..')
                .getByText(status, { exact: true }),
            );
          const expression = dialog.getByRole('combobox', {
            name: '表达偏好',
            exact: true,
          });
          const geometry = await expression.evaluate((node) => {
            const shell = node.parentElement!;
            const input = node
              .closest('form')!
              .querySelector('[data-employee-name]')!;
            const css = getComputedStyle(shell);
            const nativeCss = getComputedStyle(node);
            const inputCss = getComputedStyle(input);
            const box = shell.getBoundingClientRect();
            const nativeBox = node.getBoundingClientRect();
            return {
              appearance: nativeCss.appearance,
              height: box.height,
              left:
                nativeBox.left -
                box.left -
                parseFloat(css.borderLeftWidth) +
                parseFloat(nativeCss.borderLeftWidth),
              right:
                box.right -
                nativeBox.right -
                parseFloat(css.borderRightWidth) +
                parseFloat(nativeCss.borderRightWidth),
              inputLeft: parseFloat(inputCss.paddingLeft),
              inputRight: parseFloat(inputCss.paddingRight),
            };
          });
          expect(geometry.appearance).not.toBe('none');
          expect(
            Math.abs(geometry.height - (width > 700 ? 40 : 44)),
          ).toBeLessThanOrEqual(0.5);
          expect(Math.abs(geometry.left - 12)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(geometry.right - 12)).toBeLessThanOrEqual(0.5);
          expect(
            Math.abs(geometry.left - geometry.inputLeft),
          ).toBeLessThanOrEqual(0.5);
          expect(
            Math.abs(geometry.right - geometry.inputRight),
          ).toBeLessThanOrEqual(0.5);
          await expression.selectOption('concise');
          expect(await expression.inputValue()).toBe('concise');
          await expression.focus();
          // macOS headless Chrome cannot drive its OS select popup with arrows.
          // A trusted character key uses the native Chinese option typeahead;
          // keyboard.type would insert Unicode text instead of dispatching it.
          const keyboard = await page.context().newCDPSession(page);
          try {
            await keyboard.send('Input.dispatchKeyEvent', {
              type: 'char',
              text: '结',
              unmodifiedText: '结',
            });
          } finally {
            await keyboard.detach();
          }
          await expect.poll(() => expression.inputValue()).toBe('structured');
          await dialog
            .getByRole('textbox', { name: '员工名字', exact: true })
            .fill('焦点验证');
          expect(await expression.inputValue()).toBe('structured');
          await expression.selectOption('exploratory');
          expect(await expression.inputValue()).toBe('exploratory');
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
