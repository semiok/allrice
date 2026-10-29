/** Normal transcript updates in Chrome; synthetic HTTP, no DB/auth/model. */
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
suite('reading a receipt while late native trace changes its group', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/work-process-reading-page.tsx'],
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
      const path = new URL(req.url!, origin).pathname,
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/work-process-reading-page.css"><div id="root"></div><script type="module" src="/work-process-reading-page.js"></script>',
      );
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
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
  const processOf = (page: Page) =>
    page.getByRole('region', { name: '工作过程', exact: true });
  const card = (page: Page, i: number) =>
    page.locator(`#operation-reading-${i}`);
  const fullButton = (page: Page) =>
    card(page, 0).getByRole('button', { name: '收起', exact: true });
  const output = (page: Page) => card(page, 5).locator('pre').last();
  async function open(width = 1440) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) =>
      console.log(`Reading fixture error: ${error.message}`),
    );
    await page.goto(origin);
    await expect
      .poll(() => page.locator('article[id^="operation-reading-"]').count())
      .toBe(36);
    expect(await processOf(page).getAttribute('data-process-open')).toBe(
      'false',
    );
    await processOf(page).locator('[data-disclosure-row]').first().click();
    return page;
  }
  async function update(
    page: Page,
    stage: 'prefix' | 'split' | 'merge' | 'append',
  ) {
    await page.evaluate((stage) => window.readingUpdate(stage), stage);
    await page.locator(`main[data-stage="${stage}"]`).waitFor();
    if (stage === 'split')
      await page
        .getByText('补充发现：继续核对后半部分。', { exact: true })
        .waitFor();
    if (stage === 'append')
      await expect
        .poll(() => page.locator('article[id^="operation-reading-"]').count(), {
          timeout: 5000,
        })
        .toBe(37);
  }
  async function readResult(page: Page) {
    await card(page, 5)
      .getByRole('button', { name: '查看详情', exact: true })
      .click();
    await card(page, 5)
      .getByRole('button', { name: '执行结果', exact: true })
      .click();
    await card(page, 5)
      .getByRole('button', { name: '技术详情', exact: true })
      .click();
    await output(page).waitFor();
  }
  for (const width of [1440, 390]) {
    it(`keeps the expanded field's semantic focus and sends one approval at ${width}px`, async () => {
      const page = await open(width);
      try {
        await card(page, 0)
          .getByRole('button', { name: '展开全文', exact: true })
          .click();
        for (const stage of ['prefix', 'split', 'merge', 'append'] as const) {
          await update(page, stage);
          expect(await fullButton(page).getAttribute('aria-expanded')).toBe(
            'true',
          );
          expect(
            await fullButton(page).evaluate(
              (node) => document.activeElement === node,
            ),
          ).toBe(true);
          expect(
            await card(page, 0).getByLabel('参数', { exact: true }).innerText(),
          ).toContain('核对这次对外发送的内容及附件。'.repeat(60));
        }
        await page.keyboard.press('Space');
        expect(
          await card(page, 0)
            .getByRole('button', { name: '展开全文', exact: true })
            .getAttribute('aria-expanded'),
        ).toBe('false');
        await page.keyboard.press('Enter');
        expect(await fullButton(page).getAttribute('aria-expanded')).toBe(
          'true',
        );
        await card(page, 0)
          .getByRole('button', { name: '允许对外发送内容', exact: true })
          .click();
        await expect
          .poll(() => page.evaluate(() => window.readingWrites.length))
          .toBe(1);
        expect(
          await page.evaluate(() => window.readingWrites[0]),
        ).toMatchObject({
          url: '/api/v1/runtime/approvals/10000000-0000-4000-8000-000000000035',
          body: {
            contractVersion: 1,
            kind: 'action_approval',
            decision: 'approved',
          },
        });
        await expect
          .poll(() =>
            card(page, 0)
              .getByRole('button', { name: '允许对外发送内容', exact: true })
              .count(),
          )
          .toBe(0);
        expect(await page.evaluate(() => window.readingWrites.length)).toBe(1);
      } finally {
        await page.close();
      }
    });
    it(`keeps a long result's internal scroll and selected text through regrouping at ${width}px`, async () => {
      const page = await open(width);
      try {
        await readResult(page);
        const expected = await output(page).evaluate((node) => {
          node.scrollTop = 900;
          node.scrollIntoView({ block: 'center' });
          (document.activeElement as HTMLElement)?.blur();
          const text = node.firstChild!;
          const start = text.textContent!.indexOf('结果第 050 行');
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + 24);
          document.getSelection()!.removeAllRanges();
          document.getSelection()!.addRange(range);
          return { text: range.toString(), top: node.scrollTop };
        });
        for (const stage of ['prefix', 'split', 'merge', 'append'] as const) {
          await update(page, stage);
          expect(await output(page).evaluate((node) => node.scrollTop)).toBe(
            expected.top,
          );
          expect(
            await page.evaluate(() => document.getSelection()?.toString()),
          ).toBe(expected.text);
          expect(await output(page).isVisible()).toBe(true);
          const box = await output(page).boundingBox();
          expect(box!.y).toBeLessThan(900);
          expect(box!.y + box!.height).toBeGreaterThan(0);
        }
        expect(await page.evaluate(() => window.readingWrites.length)).toBe(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
      } finally {
        await page.close();
      }
    });
    it(`keeps native Tab focus and keyboard selection in the long output at ${width}px`, async () => {
      for (const stage of ['prefix', 'split', 'merge'] as const) {
        const page = await open(width);
        try {
          if (stage === 'merge') await update(page, 'split');
          await readResult(page);
          await page.keyboard.press('Tab');
          expect(
            await output(page).evaluate(
              (node) => node === document.activeElement,
            ),
            stage,
          ).toBe(true);
          await page.keyboard.press('End');
          await expect
            .poll(() =>
              output(page).evaluate(
                (node) =>
                  node.scrollHeight - node.clientHeight - node.scrollTop,
              ),
            )
            .toBeLessThan(2);
          const priorSelection = await output(page).evaluate((node) => {
            const text = node.firstChild!;
            const start = text.textContent!.length - 30;
            document
              .getSelection()!
              .setBaseAndExtent(text, start, text, start + 18);
            return document.getSelection()!.toString();
          });
          expect(
            await output(page).evaluate(
              (node) => node === document.activeElement,
            ),
            stage,
          ).toBe(true);
          await page.keyboard.press('Shift+ArrowRight');
          const selected = await page.evaluate(() =>
            document.getSelection()!.toString(),
          );
          expect(selected.length, stage).toBeGreaterThan(0);
          expect(selected, stage).not.toBe(priorSelection);
          expect(
            await output(page).evaluate(
              (node) => node === document.activeElement,
            ),
            stage,
          ).toBe(true);
          const before = await output(page).evaluate((node) => node.scrollTop);
          await update(page, stage);
          expect(
            await output(page).evaluate(
              (node) => node === document.activeElement,
            ),
            stage,
          ).toBe(true);
          expect(
            await page.evaluate(() => document.getSelection()!.toString()),
            stage,
          ).toBe(selected);
          expect(
            await output(page).evaluate((node) => node.scrollTop),
            stage,
          ).toBe(before);
          await page.keyboard.press('Home');
          await expect
            .poll(() => output(page).evaluate((node) => node.scrollTop))
            .toBe(0);
        } finally {
          await page.close();
        }
      }
    });
  }
  it('preserves a mouse reading position without any focused control or selection', async () => {
    const page = await open(390);
    try {
      await readResult(page);
      await output(page).evaluate((node) => {
        node.scrollTop = 650;
        (document.activeElement as HTMLElement)?.blur();
        document.getSelection()?.removeAllRanges();
      });
      await update(page, 'prefix');
      await update(page, 'split');
      await update(page, 'merge');
      expect(await output(page).evaluate((node) => node.scrollTop)).toBe(650);
      expect(
        await page.evaluate(() => document.activeElement === document.body),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it.each(['field', 'arguments'] as const)(
    'preserves the real selection in %s when a prefix replaces its group',
    async (area) => {
      const page = await open(390);
      try {
        await card(page, 0)
          .getByRole('button', { name: '展开全文', exact: true })
          .click();
        if (area === 'arguments')
          await card(page, 0)
            .getByRole('button', { name: '技术详情', exact: true })
            .click();
        const content =
          area === 'arguments'
            ? card(page, 0).getByLabel('发送的原始参数')
            : card(page, 0)
                .getByLabel('参数', { exact: true })
                .locator('dd span')
                .first();
        const expected = await content.evaluate((node) => {
          (document.activeElement as HTMLElement)?.blur();
          const text = node.firstChild!;
          document.getSelection()!.setBaseAndExtent(text, 40, text, 15);
          return document.getSelection()!.toString();
        });
        await update(page, 'prefix');
        expect(
          await page.evaluate(() => document.getSelection()?.toString()),
        ).toBe(expected);
        expect(await content.isVisible()).toBe(true);
        expect(
          await page.evaluate(
            () =>
              document.getSelection()!.anchorOffset >
              document.getSelection()!.focusOffset,
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    },
  );
  it('does not reapply a selection to changed result text', async () => {
    const page = await open(390);
    try {
      await readResult(page);
      const selected = await output(page).evaluate((node) => {
        (document.activeElement as HTMLElement)?.blur();
        document
          .getSelection()!
          .setBaseAndExtent(node.firstChild!, 300, node.firstChild!, 340);
        return document.getSelection()!.toString();
      });
      await page.evaluate(() => window.readingUpdate('prefix', true));
      await expect
        .poll(() => output(page).textContent())
        .toContain('内容已更新');
      expect(
        await page.evaluate(() => document.getSelection()?.toString()),
      ).not.toBe(selected);
    } finally {
      await page.close();
    }
  });
  it('does not restore changed text between selection endpoints after a native split', async () => {
    const page = await open(390);
    try {
      await card(page, 0)
        .getByRole('button', { name: '技术详情', exact: true })
        .click();
      await readResult(page);
      await update(page, 'prefix');
      const expected = await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        const from = document.querySelector(
          '#operation-reading-0 pre',
        )!.firstChild!;
        const to = document.querySelector(
          '#operation-reading-5 [data-process-content="result"]',
        )!.firstChild!;
        document
          .getSelection()!
          .setBaseAndExtent(from, from.textContent!.length - 15, to, 50);
        return document.getSelection()!.toString();
      });
      for (const stage of ['split', 'merge'] as const) {
        await update(page, stage);
        expect(
          await page.evaluate(() => document.getSelection()!.toString()),
        ).toBe('');
      }
      expect(expected.length).toBeGreaterThan(50);
    } finally {
      await page.close();
    }
  });
  it('keeps the reader at the later receipt after scrolling away from an old selection', async () => {
    const page = await open(390);
    try {
      await readResult(page);
      const selected = await output(page).evaluate((node) => {
        node.scrollTop = 650;
        node.scrollIntoView({ block: 'center' });
        (document.activeElement as HTMLElement)?.blur();
        document
          .getSelection()!
          .setBaseAndExtent(node.firstChild!, 1000, node.firstChild!, 1030);
        return document.getSelection()!.toString();
      });
      const later = card(page, 30);
      await later.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      const old = (await output(page).boundingBox())!;
      expect(old.y + old.height).toBeLessThan(0);
      for (const stage of ['prefix', 'split', 'merge'] as const) {
        await update(page, stage);
        const box = (await later.boundingBox())!;
        expect(box.y).toBeLessThan(900);
        expect(box.y + box.height).toBeGreaterThan(0);
        expect(
          await page.evaluate(() => document.getSelection()!.toString()),
        ).toBe(selected);
        expect(
          await page.evaluate(() => document.activeElement === document.body),
        ).toBe(true);
      }
    } finally {
      await page.close();
    }
  });
  it('keeps an offscreen focused group title without pulling back a wheel reader', async () => {
    const page = await open(390);
    try {
      const group = () =>
        processOf(page).getByRole('button', { name: /项$/ }).first();
      await group().focus();
      await page.keyboard.press('Enter');
      const later = card(page, 30);
      await page.mouse.move(2, 850);
      await page.mouse.wheel(0, (await later.boundingBox())!.y - 450);
      await expect
        .poll(async () => {
          const box = (await later.boundingBox())!;
          return box.y < 900 && box.y + box.height > 0;
        })
        .toBe(true);
      expect(
        await group().evaluate((node) => node === document.activeElement),
      ).toBe(true);
      const old = (await group().boundingBox())!;
      expect(old.y + old.height).toBeLessThan(0);
      for (const stage of ['prefix', 'split', 'merge'] as const) {
        await update(page, stage);
        expect(
          await group().evaluate((node) => node === document.activeElement),
        ).toBe(true);
        const box = (await later.boundingBox())!;
        expect(box.y, stage).toBeLessThan(900);
        expect(box.y + box.height, stage).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });
  it('keeps the native group title focused and keyboard-operable after prefix and merge', async () => {
    const page = await open(390);
    try {
      const groups = () => processOf(page).getByRole('button', { name: /项$/ });
      await groups().first().focus();
      await page.keyboard.press('Enter');
      await update(page, 'prefix');
      expect(
        await groups()
          .first()
          .evaluate((node) => document.activeElement === node),
      ).toBe(true);
      await page.keyboard.press('Space');
      expect(await groups().first().getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(
        await processOf(page)
          .getByText('核对第 0 项资料', { exact: true })
          .isVisible(),
      ).toBe(false);
      await page.keyboard.press('Enter');
      expect(await groups().first().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processOf(page)
          .getByText('核对第 0 项资料', { exact: true })
          .isVisible(),
      ).toBe(true);
      await update(page, 'split');
      expect(await groups().count()).toBe(2);
      await groups().last().focus();
      await page.keyboard.press('Space');
      expect(await groups().last().getAttribute('aria-expanded')).toBe('false');
      expect(
        await processOf(page)
          .getByText('核对第 4 项资料', { exact: true })
          .isVisible(),
      ).toBe(false);
      await page.keyboard.press('Enter');
      expect(
        await processOf(page)
          .getByText('核对第 4 项资料', { exact: true })
          .isVisible(),
      ).toBe(true);
      await update(page, 'merge');
      expect(await groups().count()).toBe(1);
      expect(
        await groups()
          .first()
          .evaluate((node) => document.activeElement === node),
      ).toBe(true);
      await page.keyboard.press('Space');
      expect(await groups().first().getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(
        await processOf(page)
          .getByText('核对第 0 项资料', { exact: true })
          .isVisible(),
      ).toBe(false);
      await page.keyboard.press('Enter');
      expect(await groups().first().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processOf(page)
          .getByText('核对第 0 项资料', { exact: true })
          .isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('inherits the open group choice when an appended member later splits into its own group', async () => {
    const page = await open(390);
    try {
      const groups = () => processOf(page).getByRole('button', { name: /项$/ });
      await groups().first().click();
      await update(page, 'append');
      expect(await groups().first().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processOf(page)
          .getByText('核对第 36 项资料', { exact: true })
          .isVisible(),
      ).toBe(true);
      await update(page, 'split');
      expect(await groups().count()).toBe(2);
      expect(await groups().last().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processOf(page)
          .getByText('核对第 36 项资料', { exact: true })
          .isVisible(),
      ).toBe(true);
      await groups().last().click();
      await update(page, 'merge');
      await update(page, 'split');
      expect(await groups().last().getAttribute('aria-expanded')).toBe('false');
      expect(
        await processOf(page)
          .getByText('核对第 36 项资料', { exact: true })
          .isVisible(),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });
  it('distinguishes same-named technical controls by operation and section', async () => {
    const page = await open();
    try {
      await readResult(page);
      const raw = card(page, 0).getByRole('button', {
        name: '技术详情',
        exact: true,
      });
      await raw.click();
      await update(page, 'prefix');
      expect(await raw.getAttribute('aria-expanded')).toBe('true');
      expect(
        await raw.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      const result = card(page, 5).getByRole('button', {
        name: '技术详情',
        exact: true,
      });
      await result.focus();
      await update(page, 'split');
      expect(
        await result.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await card(page, 5)
        .getByRole('button', { name: '应用与工具', exact: true })
        .click();
      const app = card(page, 5).getByRole('button', {
        name: '技术详情',
        exact: true,
      });
      expect(await app.getAttribute('aria-expanded')).toBe('false');
      await app.click();
      await update(page, 'merge');
      expect(
        await app.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('Space');
      expect(await app.getAttribute('aria-expanded')).toBe('false');
      await card(page, 5)
        .getByRole('button', { name: '执行结果', exact: true })
        .click();
      expect(await result.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await page.close();
    }
  });
  it('keeps the original 360px group, inherits expansion after split and releases choices for a Run or unmount', async () => {
    const page = await open(390);
    try {
      const group = () => processOf(page).getByRole('button', { name: /项$/ });
      await group().first().click();
      const list = processOf(page).locator('ul[aria-label="工作步骤"]').first();
      expect(
        await list.evaluate((node) => ({
          height: getComputedStyle(node.parentElement!).maxHeight,
          overflow: getComputedStyle(node.parentElement!).overflowY,
        })),
      ).toEqual({ height: '360px', overflow: 'auto' });
      await update(page, 'split');
      for (const row of await group().all())
        expect(await row.getAttribute('aria-expanded')).toBe('true');
      await readResult(page);
      await page.evaluate(() => window.readingRun('different-run'));
      await page.locator('main[data-run="different-run"]').waitFor();
      await processOf(page).locator('[data-disclosure-row]').first().click();
      expect(
        await card(page, 5)
          .getByRole('button', { name: '查看详情', exact: true })
          .getAttribute('aria-expanded'),
      ).toBe('false');
      for (const row of await group().all())
        expect(await row.getAttribute('aria-expanded')).toBe('false');
      await readResult(page);
      await page.evaluate(() => window.readingMount(false));
      await expect.poll(() => processOf(page).count()).toBe(0);
      await page.evaluate(() => window.readingMount(true));
      await processOf(page).waitFor();
      await processOf(page).locator('[data-disclosure-row]').first().click();
      expect(
        await card(page, 5)
          .getByRole('button', { name: '查看详情', exact: true })
          .getAttribute('aria-expanded'),
      ).toBe('false');
    } finally {
      await page.close();
    }
  });
  it('does not steal a later input focus or scroll back to its old selected output', async () => {
    const page = await open();
    try {
      await readResult(page);
      await output(page).evaluate((node) => {
        node.scrollTop = 650;
        node.scrollIntoView({ block: 'center' });
        (document.activeElement as HTMLElement)?.blur();
        document
          .getSelection()!
          .setBaseAndExtent(node.firstChild!, 1000, node.firstChild!, 1030);
      });
      const outside = page.getByRole('textbox', { name: '另外阅读的位置' });
      await outside.focus();
      const before = await page.evaluate(() => scrollY);
      await update(page, 'prefix');
      expect(
        await outside.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      expect(await page.evaluate(() => scrollY)).toBeCloseTo(before, 0);
      expect((await outside.boundingBox())!.y).toBeGreaterThanOrEqual(0);
      expect((await outside.boundingBox())!.y).toBeLessThan(900);
      await page.keyboard.type('继续编辑');
      expect(await outside.inputValue()).toBe('继续编辑');
    } finally {
      await page.close();
    }
  });
});
