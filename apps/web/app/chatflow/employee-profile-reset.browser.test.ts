/** Controlled real components only; no production reset/API/receipt assertion. */
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Locator,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('U1 Rice reset controlled presentation', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-rice-reset');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-profile-reset-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/rice-reset-fixture',
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
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://localhost').pathname;
      const asset = assets.get(path);
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
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-profile-reset-page.css"><div id="root"></div><script type="module" src="/employee-profile-reset-page.js"></script>',
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
    await mkdir(evidence, { recursive: true });
    console.info(`Rice reset presentation evidence: ${evidence}`);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  async function fixture(
    width: number,
    dark: boolean,
    outcome: 'success' | 'pending' | 'rejected' = 'success',
  ) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      colorScheme: dark ? 'dark' : 'light',
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && !url.pathname.startsWith('/api/'))
        await route.continue();
      else {
        unexpected.push(`${route.request().method()} ${url.pathname}`);
        await route.abort();
      }
    });
    try {
      await page.goto(
        `${origin}/chatflow?theme=${dark ? 'dark' : 'light'}&outcome=${outcome}`,
      );
      await expect
        .poll(() => page.getByLabel('名字', { exact: true }).isVisible())
        .toBe(true);
    } catch (cause) {
      await context.close();
      throw cause;
    }
    return {
      page,
      async run(work: () => Promise<void>) {
        try {
          await work();
          expect(errors).toEqual([]);
          expect(unexpected).toEqual([]);
        } finally {
          await context.close();
        }
      },
      async open() {
        await page
          .getByRole('button', { name: '恢复默认', exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: '重置人设',
          exact: true,
        });
        await expect.poll(() => dialog.isVisible()).toBe(true);
        return dialog;
      },
      events: () => page.getByLabel('呈现回调记录').textContent(),
    };
  }

  async function focusedWithin(dialog: Locator) {
    await expect
      .poll(() =>
        dialog.evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
  }

  it.each([
    { width: 1440, dark: false },
    { width: 390, dark: true },
  ])(
    'renders approved confirm and success at $width px dark=$dark',
    async ({ width, dark }) => {
      const f = await fixture(width, dark);
      await f.run(async () => {
        const trigger = f.page.getByRole('button', {
          name: '恢复默认',
          exact: true,
        });
        const triggerBox = await trigger.boundingBox();
        const cancelBox = await f.page
          .getByRole('button', { name: '取消', exact: true })
          .boundingBox();
        expect(triggerBox).not.toBeNull();
        expect(cancelBox).not.toBeNull();
        expect(triggerBox!.x + triggerBox!.width).toBeLessThan(cancelBox!.x);
        expect(
          await trigger.evaluate((node) => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--ar-link)';
            document.body.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return getComputedStyle(node).color === expected;
          }),
        ).toBe(true);
        const dialog = await f.open();
        expect(await dialog.locator('header button').count()).toBe(0);
        expect(await dialog.locator('p').allTextContents()).toEqual([
          '人设重置后，记忆、技能和工作场景依然保留。',
        ]);
        expect(await dialog.getByRole('list').count()).toBe(0);
        const geometry = await dialog.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const title = getComputedStyle(node.querySelector('h2')!);
          const text = getComputedStyle(node.querySelector('p')!);
          const paint = getComputedStyle(node);
          const probe = document.createElement('span');
          probe.style.color = 'var(--ar-text)';
          document.body.append(probe);
          const token = getComputedStyle(probe).color;
          probe.remove();
          return {
            left: bounds.left,
            right: document.documentElement.clientWidth - bounds.right,
            width: bounds.width,
            viewport: document.documentElement.clientWidth,
            title: [title.fontSize, title.lineHeight, title.fontWeight],
            text: [text.fontSize, text.lineHeight],
            color: paint.color,
            token,
            background: paint.backgroundColor,
            radius: paint.borderRadius,
          };
        });
        expect(geometry.title).toEqual(['20px', '28px', '600']);
        expect(geometry.text).toEqual(['15px', '26px']);
        expect(geometry.color).toBe(geometry.token);
        expect(geometry.background).not.toMatch(/rgba\([^)]*, 0\)/);
        expect(geometry.width).toBe(
          width === 390 ? geometry.viewport - 40 : 408,
        );
        if (width === 390) {
          expect(geometry.left).toBe(20);
          expect(geometry.right).toBe(20);
          expect(geometry.radius).toBe('20px');
          const actions = await dialog.locator('footer button').all();
          const first = await actions[0]!.boundingBox();
          const second = await actions[1]!.boundingBox();
          expect(first).not.toBeNull();
          expect(second).not.toBeNull();
          expect(first!.width).toBe(second!.width);
          expect(first!.height).toBeGreaterThanOrEqual(44);
          expect(second!.height).toBeGreaterThanOrEqual(44);
        }
        await focusedWithin(dialog);
        await dialog.screenshot({
          path: resolve(
            evidence,
            `confirm-${width}-${dark ? 'dark' : 'light'}.png`,
          ),
        });
        await dialog
          .getByRole('button', { name: '恢复默认', exact: true })
          .click();
        const success = f.page.getByRole('dialog', {
          name: '恢复完成',
          exact: true,
        });
        await expect.poll(() => success.isVisible()).toBe(true);
        expect(
          await success.getByRole('heading', { level: 3 }).textContent(),
        ).toBe('已恢复默认人设。');
        expect(await success.locator('p').count()).toBe(0);
        expect(
          await success.getByRole('button', { name: '关闭' }).count(),
        ).toBe(0);
        expect(await success.locator('header button').count()).toBe(1);
        const back = await success.locator('header button').boundingBox();
        expect(back).not.toBeNull();
        expect(back!.width).toBe(width === 390 ? 40 : 36);
        expect(back!.height).toBe(width === 390 ? 40 : 36);
        const box = await success.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBe(width === 390 ? geometry.viewport : 552);
        if (width === 390) {
          expect(box!.x).toBe(0);
          expect(box!.y).toBe(0);
          expect(box!.height).toBe(844);
        }
        await focusedWithin(success);
        await success.screenshot({
          path: resolve(
            evidence,
            `success-${width}-${dark ? 'dark' : 'light'}.png`,
          ),
        });
        await success
          .getByRole('button', { name: '返回编辑', exact: true })
          .last()
          .click();
        await expect.poll(() => f.page.getByRole('dialog').count()).toBe(0);
        expect(
          await f.page.getByLabel('名字', { exact: true }).isVisible(),
        ).toBe(true);
        expect(await f.events()).toBe('["confirm-reset","return-editor"]');
      });
    },
    30_000,
  );

  it('cancels through the footer, Escape and mask without confirming or losing the caller draft', async () => {
    const f = await fixture(1440, false);
    await f.run(async () => {
      await f.page.getByLabel('使命', { exact: true }).fill('保留取消后的草稿');
      for (const exit of ['cancel', 'Escape', 'mask'] as const) {
        const dialog = await f.open();
        await dialog.getByRole('button', { name: '取消', exact: true }).focus();
        await f.page.keyboard.press('Shift+Tab');
        await focusedWithin(dialog);
        if (exit === 'cancel')
          await dialog
            .getByRole('button', { name: '取消', exact: true })
            .click();
        else if (exit === 'Escape') await f.page.keyboard.press('Escape');
        else await f.page.mouse.click(1, 1);
        await expect.poll(() => f.page.getByRole('dialog').count()).toBe(0);
        expect(
          await f.page.getByLabel('使命', { exact: true }).inputValue(),
        ).toBe('保留取消后的草稿');
        await expect
          .poll(() =>
            f.page
              .getByRole('button', { name: '恢复默认', exact: true })
              .evaluate((node) => document.activeElement === node),
          )
          .toBe(true);
      }
      expect(await f.events()).toBe(
        '["cancel-reset","cancel-reset","cancel-reset"]',
      );
    });
  });

  it('locks every exit while the controlled reset is pending without a second confirmation', async () => {
    const f = await fixture(390, false, 'pending');
    await f.run(async () => {
      await f.page.emulateMedia({ reducedMotion: 'no-preference' });
      const dialog = await f.open();
      await dialog
        .getByRole('button', { name: '恢复默认', exact: true })
        .click();
      await expect
        .poll(() => dialog.getByRole('status').isVisible())
        .toBe(true);
      expect(await dialog.getByRole('status').textContent()).toBe('正在恢复…');
      expect(await dialog.getByRole('button').count()).toBe(1);
      expect(
        await dialog.getByRole('button', { name: '恢复中' }).isDisabled(),
      ).toBe(true);
      const spinner = dialog
        .getByRole('status')
        .locator('[aria-hidden="true"]');
      expect(
        await spinner.evaluate((node) => getComputedStyle(node).animationName),
      ).not.toBe('none');
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      await expect
        .poll(() =>
          spinner.evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              animation: style.animationName,
              borders: [
                style.borderTopStyle,
                style.borderRightStyle,
                style.borderBottomStyle,
                style.borderLeftStyle,
              ],
            };
          }),
        )
        .toEqual({
          animation: 'none',
          borders: ['dotted', 'dotted', 'dotted', 'dotted'],
        });
      await f.page.keyboard.press('Escape');
      await f.page.mouse.click(1, 1);
      await f.page.keyboard.press('Tab');
      await focusedWithin(dialog);
      expect(await dialog.isVisible()).toBe(true);
      expect(await dialog.getByRole('alert').count()).toBe(0);
      expect(await f.events()).toBe('["confirm-reset"]');
    });
  });

  it('renders only a caller-confirmed rejection and allows an explicit retry callback', async () => {
    const f = await fixture(1440, true, 'rejected');
    await f.run(async () => {
      const dialog = await f.open();
      await dialog
        .getByRole('button', { name: '恢复默认', exact: true })
        .click();
      await expect.poll(() => dialog.getByRole('alert').isVisible()).toBe(true);
      expect(await dialog.getByRole('alert').textContent()).toBe(
        '恢复失败，请重试。',
      );
      expect(
        await f.page.getByRole('dialog', { name: '恢复完成' }).count(),
      ).toBe(0);
      await dialog
        .getByRole('button', { name: '恢复默认', exact: true })
        .click();
      expect(await f.events()).toBe('["confirm-reset","confirm-reset"]');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await expect.poll(() => f.page.getByRole('dialog').count()).toBe(0);
    });
  });
});
