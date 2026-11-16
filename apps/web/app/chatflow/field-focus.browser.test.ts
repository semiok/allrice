/** Actual product fields; fixed props/read DTOs, with no backend or writes. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
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
type Control = {
  selector?: string;
  label?: string;
  role?: string;
  name?: string;
  ownerSelector?: string;
};
type Metadata = {
  ready: boolean;
  case: string;
  controls: Control[];
  actions?: Control[];
  writes: string[];
  unexpectedReads: string[];
};

suite('fields retain one native focus owner without a fill jump', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/field-focus-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/focus-fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    const globals = await build({
      stdin: {
        contents: [
          ...readFileSync('apps/web/app/layout.tsx', 'utf8').matchAll(
            /^import '([^']+\.css)';$/gm,
          ),
        ]
          .map((match) => `@import '${match[1]}';`)
          .join('\n'),
        resolveDir: resolve('apps/web/app'),
        loader: 'css',
      },
      bundle: true,
      write: false,
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    });
    assets.set('/layout.css', globals.outputFiles[0]!.contents);
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://fixture').pathname,
        asset = assets.get(path);
      res.setHeader(
        'Content-Type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/field-focus-page.css"><div id="root"></div><script type="module" src="/field-focus-page.js"></script>',
      );
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
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 60_000);

  const locate = (page: Page, control: Control): Locator =>
    control.selector
      ? page.locator(control.selector)
      : control.label
        ? page.getByLabel(control.label, { exact: true })
        : page.getByRole(control.role as 'textbox', {
            name: control.name,
            exact: true,
          });
  const paint = (field: Locator, control: Control) =>
    field.evaluate((node, metadata) => {
      const frame = metadata.ownerSelector
        ? node.closest(metadata.ownerSelector)!
        : node;
      const css = getComputedStyle(frame),
        inner = getComputedStyle(node);
      const probe = document.createElement('span');
      probe.style.color = 'var(--dsw-alias-state-business-primary)';
      frame.parentElement!.append(probe);
      const focusColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        framed: frame !== null,
        wrapper: frame !== node,
        border: css.borderWidth,
        color: css.borderColor,
        background: css.backgroundColor,
        shadow: css.boxShadow,
        outline: css.outlineStyle,
        innerOutline: inner.outlineStyle,
        innerBorder: inner.borderWidth,
        nativeSelect: node.tagName === 'SELECT',
        innerBorderColors: [inner.borderLeftColor, inner.borderRightColor],
        innerShadow: inner.boxShadow,
        focusColor,
        keyboard:
          node === document.activeElement && node.matches(':focus-visible'),
      };
    }, control);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      for (const [name, mode] of [
        ['memory', 'add'],
        ['memory', 'edit'],
        ['employee-edit', ''],
        ['reference-add', ''],
        ['reference-audience', ''],
      ])
        it(`${name} ${mode} at ${width}px ${theme}`, async () => {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
            reducedMotion: 'reduce',
          });
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          try {
            await page.goto(
              `${origin}/?${new URLSearchParams({ case: name!, mode: mode!, theme })}`,
            );
            await page.waitForFunction(
              () => window.__focusCapture?.ready === true,
            );
            let metadata = await page.evaluate(
              () => window.__focusCapture as Metadata,
            );
            for (const action of metadata.actions ?? [])
              await locate(page, action).click();
            metadata = await page.evaluate(
              () => window.__focusCapture as Metadata,
            );
            if (name === 'reference-audience') {
              const dialog = page.getByRole('dialog', { name: '编辑资料' });
              expect(await dialog.locator('textarea').count()).toBe(1);
              expect(await dialog.getByRole('radio').count()).toBe(3);
              await dialog
                .getByRole('radio', { name: '指定部门', exact: true })
                .check();
              await dialog
                .getByRole('checkbox', { name: '财务部', exact: true })
                .check();
              expect(
                await dialog
                  .getByRole('checkbox', { name: '财务部', exact: true })
                  .isChecked(),
              ).toBe(true);
            }
            {
              for (const control of metadata.controls) {
                const field = locate(page, control);
                await field.waitFor();
                await field.evaluate((node) => (node as HTMLElement).blur());
                const before = await paint(field, control);
                await field.focus();
                await page.keyboard.press('Shift+Tab');
                await page.keyboard.press('Tab');
                const focused = await paint(field, control);
                expect(focused.keyboard).toBe(true);
                expect(focused.framed).toBe(true);
                expect(focused.outline).toBe('none');
                expect(focused.innerOutline).toBe('none');
                expect(parseFloat(focused.border)).toBeGreaterThan(0);
                expect(focused.border).toBe(before.border);
                expect(focused.color).toBe(focused.focusColor);
                expect(focused.color).not.toBe(before.color);
                expect(focused.background).toBe(before.background);
                expect(focused.shadow).toBe(before.shadow);
                if (focused.wrapper) {
                  expect(focused.innerBorder).toBe(
                    focused.nativeSelect ? '0px 12px' : '0px',
                  );
                  if (focused.nativeSelect)
                    expect(focused.innerBorderColors).toEqual([
                      'rgba(0, 0, 0, 0)',
                      'rgba(0, 0, 0, 0)',
                    ]);
                  expect(focused.innerShadow).toBe('none');
                }
              }
            }
            const final = await page.evaluate(
              () => window.__focusCapture as Metadata,
            );
            expect(final.writes).toEqual([]);
            expect(final.unexpectedReads).toEqual([]);
            expect(errors).toEqual([]);
          } finally {
            await page.close();
          }
        });

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      it(`native select edges open the actual picker at ${width}px ${theme}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          for (const [name, control] of [
            ['deliverables', { role: 'combobox', name: '按员工筛选' }],
            ['automation', { role: 'combobox', name: '筛选员工' }],
            ['settings', { label: '外观' }],
          ] as const) {
            await page.goto(
              `${origin}/?${new URLSearchParams({ case: name, theme })}`,
            );
            await page.waitForFunction(
              () => window.__focusCapture?.ready === true,
            );
            const field = locate(page, control);
            await field.waitFor();
            await page.evaluate(() => document.fonts.ready);
            const geometry = await field.evaluate((node) => {
              const frame = node.closest('[data-select-field]')!;
              const outer = getComputedStyle(frame),
                inner = getComputedStyle(node);
              const box = frame.getBoundingClientRect(),
                native = node.getBoundingClientRect();
              // Headless Chrome can dismiss its native popup before a later
              // CDP read. Observe :open inside the real trusted click instead.
              node.addEventListener('click', (event) =>
                node.setAttribute(
                  'data-edge-hit',
                  JSON.stringify({
                    nativeTarget: event.target === node,
                    trusted: event.isTrusted,
                    focused: node === document.activeElement,
                    open: node.matches(':open'),
                  }),
                ),
              );
              return {
                outerLabel: node.closest('label') !== null,
                appearance: inner.appearance,
                height: box.height,
                contentInset: [
                  native.left -
                    box.left -
                    parseFloat(outer.borderLeftWidth) +
                    parseFloat(inner.borderLeftWidth),
                  box.right -
                    native.right -
                    parseFloat(outer.borderRightWidth) +
                    parseFloat(inner.borderRightWidth),
                ],
                nativeEdgeGap: [
                  native.left - box.left - parseFloat(outer.borderLeftWidth),
                  box.right - native.right - parseFloat(outer.borderRightWidth),
                ],
              };
            });
            expect(geometry.outerLabel).toBe(false);
            expect(geometry.appearance).not.toBe('none');
            expect(
              Math.abs(geometry.height - (width > 700 ? 40 : 44)),
            ).toBeLessThanOrEqual(0.5);
            for (const inset of geometry.contentInset)
              expect(Math.abs(inset - 12)).toBeLessThanOrEqual(0.5);
            for (const gap of geometry.nativeEdgeGap)
              expect(Math.abs(gap)).toBeLessThanOrEqual(0.5);
            const originalValue = await field.inputValue();
            for (const edge of ['left', 'right']) {
              await field.evaluate((node) => {
                (node as HTMLElement).blur();
                node.removeAttribute('data-edge-hit');
              });
              const box = (await field.locator('..').boundingBox())!;
              await page.mouse.click(
                edge === 'left' ? box.x + 5 : box.x + box.width - 5,
                box.y + box.height / 2,
              );
              expect(
                JSON.parse((await field.getAttribute('data-edge-hit'))!),
              ).toEqual({
                nativeTarget: true,
                trusted: true,
                focused: true,
                open: true,
              });
              await page.keyboard.press('Tab');
              expect(await field.inputValue()).toBe(originalValue);
            }
            const final = await page.evaluate(
              () => window.__focusCapture as Metadata,
            );
            expect(final.writes).toEqual([]);
            expect(final.unexpectedReads).toEqual([]);
          }
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      });
});
