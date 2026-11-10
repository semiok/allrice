/** Normal transcript updates in Chrome; synthetic HTTP, no DB/auth/model. */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ids } from '../../test/technical-details-fixtures';
import type {
  Browser,
  Locator,
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
  const processBodyOf = (page: Page) => processOf(page).locator('..');
  const processOwns = async (region: Locator, target: Locator) => {
    const state = await target.evaluate(
      (node, region) => {
        const ids = (region!.getAttribute('aria-owns') ?? '')
          .split(' ')
          .filter(Boolean);
        const elements = [...document.querySelectorAll('[id]')];
        const members = ids.map((id) =>
          elements.filter((element) => element.id === id),
        );
        return {
          exact:
            new Set(ids).size === ids.length &&
            members.every(
              (matches) =>
                matches.length === 1 &&
                matches[0]!.parentElement === region!.parentElement,
            ),
          owned: members.some(
            (matches) => matches.length === 1 && matches[0]!.contains(node),
          ),
        };
      },
      await region.elementHandle(),
    );
    expect(state.exact).toBe(true);
    return state.owned;
  };
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
  async function openProcess(width = 1440, theme = 'light', scenario = '') {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?process&theme=${theme}&${scenario}`);
    await expect.poll(() => processOf(page).count()).toBe(3);
    return { page, errors, primary: page.locator(`#message-${ids.run}`) };
  }
  const answerReceipt = (page: Page, call: string, native = ids.session) =>
    page.locator(`article[data-question-id="dsh-${native}:${call}"]`);
  const searchStep = (page: Page) =>
    page.locator(`#message-${ids.run} [data-step-id="tool:search"]`);
  const textBox = (node: Locator) =>
    node.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getClientRects()[0]!;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  const detailGeometry = (page: Page) =>
    searchStep(page)
      .locator('dl')
      .evaluate((grid) => {
        const label = grid.querySelector('dt')!.getBoundingClientRect();
        const value = grid.querySelector('dd')!.getBoundingClientRect();
        return {
          width: grid.getBoundingClientRect().width,
          labelX: label.x,
          labelRight: label.right,
          labelY: label.y,
          valueX: value.x,
          valueY: value.y,
          contained:
            value.right <= grid.getBoundingClientRect().right + 1 &&
            grid.scrollWidth <= grid.clientWidth + 1,
        };
      });
  for (const width of [1440, 390]) {
    it(`shows one memory step without internal pruning at ${width}px, including reload`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}/?memory`);
        for (let replay = 0; replay < 2; replay++) {
          await processOf(page)
            .locator('[data-disclosure-row]')
            .first()
            .click();
          const group = page.getByRole('region', {
            name: '工作步骤',
            exact: true,
          });
          await group
            .getByRole('button', { name: '已调用工具', exact: true })
            .click();
          expect(await group.locator('li').count()).toBe(1);
          expect(await group.innerText()).toContain('记忆');
          expect(await group.innerText()).toContain('整理工作记忆');
          expect(
            await page.getByText('工具结果已精简', { exact: true }).count(),
          ).toBe(0);
          expect(
            await page
              .getByText('这次记忆请求已处理。', { exact: true })
              .count(),
          ).toBe(1);
          expect(await page.locator('body').innerText()).not.toContain('6 项');
          expect(
            await page
              .getByText('记忆读取失败，请重新读取。', { exact: true })
              .count(),
          ).toBe(0);
          expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
          if (replay === 0) await page.reload();
        }
        await mkdir('.local/process-prune-screenshots', { recursive: true });
        await page.screenshot({
          path: `.local/process-prune-screenshots/memory-${width}.png`,
          fullPage: true,
        });
      } finally {
        await page.close();
      }
    });
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
        processBodyOf(page)
          .getByRole('button', { name: '已调用工具', exact: true })
          .first();
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
      const groups = () =>
        processBodyOf(page).getByRole('button', {
          name: '已调用工具',
          exact: true,
        });
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
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-0"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(false);
      await page.keyboard.press('Enter');
      expect(await groups().first().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-0"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(true);
      await update(page, 'split');
      expect(await groups().count()).toBe(2);
      await groups().last().focus();
      await page.keyboard.press('Space');
      expect(await groups().last().getAttribute('aria-expanded')).toBe('false');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-4"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(false);
      await page.keyboard.press('Enter');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-4"] [class*="processStepLabel"]')
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
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-0"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(false);
      await page.keyboard.press('Enter');
      expect(await groups().first().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-0"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('inherits the open group choice when an appended member later splits into its own group', async () => {
    const page = await open(390);
    try {
      const groups = () =>
        processBodyOf(page).getByRole('button', {
          name: '已调用工具',
          exact: true,
        });
      await groups().first().click();
      await update(page, 'append');
      expect(await groups().first().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-36"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(true);
      await update(page, 'split');
      expect(await groups().count()).toBe(2);
      expect(await groups().last().getAttribute('aria-expanded')).toBe('true');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-36"] [class*="processStepLabel"]')
          .isVisible(),
      ).toBe(true);
      await groups().last().click();
      await update(page, 'merge');
      await update(page, 'split');
      expect(await groups().last().getAttribute('aria-expanded')).toBe('false');
      expect(
        await processBodyOf(page)
          .locator('[data-step-id="tool:call-36"] [class*="processStepLabel"]')
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
      const group = () =>
        processBodyOf(page).getByRole('button', {
          name: '已调用工具',
          exact: true,
        });
      await group().first().click();
      const list = processBodyOf(page)
        .locator('ul[aria-label="工作步骤"]')
        .first();
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
  it('keeps exact native question ownership, answer authority and final deliverables outside the folded process', async () => {
    const { page, errors, primary } = await openProcess();
    const process = primary.getByRole('region', {
      name: '工作过程',
      exact: true,
    });
    try {
      expect(
        await page.getByRole('article', { name: '用户确认结果' }).count(),
      ).toBe(7);
      expect(
        await primary.getByRole('article', { name: '用户确认结果' }).count(),
      ).toBe(4);
      const cross = answerReceipt(page, 'accepted', ids.runningRun);
      expect(
        await page
          .locator(`#message-${ids.succeededOperation}`)
          .locator(cross)
          .count(),
      ).toBe(1);
      for (const [call, state, title] of [
        ['accepted', 'confirmed', '提问 · 2/2 已回答'],
        ['submitted', 'waiting', '提问 · 已提交'],
        ['unknown', 'unknown', '提问 · 未能确认'],
        ['rejected', 'rejected', '提问 · 未被采纳'],
      ]) {
        const receipt = answerReceipt(page, call!);
        expect(await receipt.getAttribute('data-state')).toBe(state);
        const toggle = receipt.getByRole('button', {
          name: title,
          exact: true,
        });
        expect(await receipt.locator('dl').isVisible()).toBe(false);
        await toggle.click();
        expect(
          await receipt
            .getByText('核对哪些资料？', { exact: true })
            .isVisible(),
        ).toBe(true);
      }
      const accepted = answerReceipt(page, 'accepted');
      expect(
        await accepted.getByText('已跳过', { exact: true }).isVisible(),
      ).toBe(true);
      expect(
        await accepted.getByText('推荐', { exact: true }).isVisible(),
      ).toBe(true);
      await cross.locator('[data-disclosure-row]').first().click();
      expect(await cross.innerText()).toContain('另一会话范围');
      expect(await accepted.innerText()).not.toContain('另一会话范围');
      expect(await cross.innerText()).not.toContain('只读检查');
      for (const [call, text] of [
        ['orphan', '无归属范围'],
        ['invalid', '身份不符范围'],
      ]) {
        const receipt = answerReceipt(page, call!);
        expect(await processOwns(process, receipt)).toBe(false);
        await receipt.locator('[data-disclosure-row]').first().click();
        expect(
          await receipt.getByText(text!, { exact: true }).isVisible(),
        ).toBe(true);
      }
      const submitted = answerReceipt(page, 'submitted');
      await submitted
        .getByText('等待 Rice 接收这次回答', { exact: true })
        .waitFor();
      await page.evaluate(() => window.processAdopt());
      const received = submitted.getByRole('button', {
        name: '提问 · 1/1 已回答',
        exact: true,
      });
      await received.waitFor();
      expect(await received.getAttribute('aria-expanded')).toBe('true');
      expect(
        await submitted
          .getByText('Rice 已收到你的回答', { exact: true })
          .isVisible(),
      ).toBe(true);
      const pending = page.getByRole('region', {
        name: '核对哪些资料？',
        exact: true,
      });
      expect(
        await processOwns(
          page
            .locator(`#message-${ids.runningRun}`)
            .getByRole('region', { name: '工作过程', exact: true }),
          pending,
        ),
      ).toBe(false);
      const option = pending.getByRole('radio', {
        name: '待答范围',
        exact: true,
      });
      await option.click();
      expect(await option.getAttribute('aria-checked')).toBe('true');
      expect(
        await page
          .locator(`#message-${ids.runningRun}`)
          .getByText('等待回答', { exact: true })
          .count(),
      ).toBeGreaterThan(0);
      expect(
        await primary
          .locator('[data-step-id="tool:unsettled"]')
          .getAttribute('data-status'),
      ).toBe('结果未确认');
      expect(
        await primary
          .locator(
            '[data-step-id="tool:unsettled"] [class*="processStepStatus"]',
          )
          .innerText(),
      ).toBe('结果未确认');
      const table = primary.getByRole('table');
      expect(
        await table.evaluate((node) => {
          const reply = node.closest('[data-work-reply]')!;
          const region = reply.parentElement!.querySelector(
            ':scope > section[aria-label="工作过程"]',
          );
          return (
            !region?.contains(node) &&
            reply.parentElement === region?.parentElement
          );
        }),
      ).toBe(true);
      expect(await processOwns(process, table)).toBe(false);
      expect(
        await process
          .locator('..')
          .locator('[data-work-reply]:not([data-process-member])')
          .count(),
      ).toBe(1);
      const accessibility = await page.context().newCDPSession(page);
      const { root } = await accessibility.send('DOM.getDocument');
      const { nodes } = await accessibility.send('Accessibility.getFullAXTree');
      const axNode = async (selector: string) => {
        const { nodeId } = await accessibility.send('DOM.querySelector', {
          nodeId: root.nodeId,
          selector,
        });
        const { node } = await accessibility.send('DOM.describeNode', {
          nodeId,
        });
        const ax = nodes.find(
          (item) => item.backendDOMNodeId === node.backendNodeId,
        );
        expect(ax?.ignored).toBe(false);
        return ax!;
      };
      const regionAX = await axNode(
        `#message-${ids.run} section[aria-label="工作过程"]`,
      );
      const historyAX = await axNode(
        `#message-${ids.run} [data-step-id="tool:search"] [data-disclosure-row]`,
      );
      const finalAX = await axNode(`#message-${ids.run} table`);
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const underRegion = (node?: typeof regionAX): boolean =>
        !!node &&
        (node.nodeId === regionAX.nodeId ||
          underRegion(byId.get(node.parentId ?? '')));
      expect(underRegion(historyAX)).toBe(true);
      expect(underRegion(finalAX)).toBe(false);
      expect(finalAX.role?.value).toBe('table');
      await accessibility.detach();
      await primary
        .getByRole('region', { name: '工作过程', exact: true })
        .locator('[data-disclosure-row]')
        .first()
        .click();
      expect(await table.isVisible()).toBe(true);
      expect(
        await primary
          .getByRole('link', { name: '核对结果.csv', exact: true })
          .isVisible(),
      ).toBe(true);
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  async function readExternalQuestion(
    choice: 'open' | 'outer' | 'group',
    partial = false,
  ) {
    const { page, errors, primary } = await openProcess(
      390,
      'light',
      (choice === 'group'
        ? 'late&standard'
        : choice === 'open'
          ? 'late&empty'
          : 'late') + (partial ? '&partial' : ''),
    );
    try {
      if (partial) {
        const outer = primary
          .getByRole('region', { name: '工作过程', exact: true })
          .locator('[data-disclosure-row]')
          .first();
        expect(await outer.getAttribute('aria-expanded')).toBe('false');
        await outer.click();
      }
      const ancestor =
        choice === 'group'
          ? primary.getByRole('region', { name: '工作步骤', exact: true })
          : primary.getByRole('region', { name: '工作过程', exact: true });
      const fold = ancestor.locator('[data-disclosure-row]').first();
      if (choice === 'group') await fold.click();
      if (choice !== 'open') await fold.click();
      if (choice !== 'open')
        expect(await fold.getAttribute('aria-expanded')).toBe('false');
      const receipt = answerReceipt(page, 'accepted');
      const toggle = receipt.getByRole('button', {
        name: '提问 · 2/2 已回答',
        exact: true,
      });
      expect(
        await processOwns(
          primary.getByRole('region', { name: '工作过程', exact: true }),
          receipt,
        ),
      ).toBe(false);
      await toggle.click();
      const selected = await receipt
        .locator('dd')
        .nth(1)
        .locator('span')
        .first()
        .evaluate((node) => {
          document
            .getSelection()!
            .setBaseAndExtent(node.firstChild!, 0, node.firstChild!, 4);
          return document.getSelection()!.toString();
        });
      expect(selected).toBe('只读检查');
      await page.evaluate(() => window.processTrace());
      await expect.poll(() => primary.locator(receipt).count()).toBe(1);
      expect(
        await processOwns(
          primary.getByRole('region', { name: '工作过程', exact: true }),
          receipt,
        ),
      ).toBe(true);
      expect(await receipt.isVisible()).toBe(true);
      expect(await page.locator('#message-answer-0').count()).toBe(0);
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      expect(
        await toggle.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.getSelection()!.toString()),
      ).toBe(selected);
      await fold.click();
      expect(await receipt.isVisible()).toBe(false);
      await fold.click();
      expect(await receipt.isVisible()).toBe(true);
      await toggle.focus();
      await page.keyboard.press('Space');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
  it.each(['open', 'outer', 'group'] as const)(
    'preserves an external answer disclosure, focus and selection after a %s ancestor choice',
    (choice) => readExternalQuestion(choice),
  );
  it.each(['outer', 'group'] as const)(
    'preserves reading through a partial trace completion after closing the %s ancestor',
    (choice) => readExternalQuestion(choice, true),
  );
  it.each(['failed', 'completed', 'canceled'] as const)(
    'keeps authoritative %s above a stale pending view, then reads the complete trace',
    async (status) => {
      const { page, errors } = await openProcess(
        390,
        'light',
        `late&terminal=${status}`,
      );
      try {
        const task = page.locator(`#message-${ids.runningRun}`);
        const title =
          status === 'completed'
            ? '工作过程'
            : status === 'canceled'
              ? '已停止'
              : '未完成';
        const step = task.locator('[data-step-id="tool:pending"]');
        const heading = task
          .getByRole('region', { name: '工作过程', exact: true })
          .locator('[class*="processTitle"]')
          .first();
        for (const loaded of [false, true]) {
          await heading.waitFor();
          expect(await heading.innerText()).toBe(title);
          expect(
            await task.getByText('等待回答', { exact: true }).count(),
          ).toBe(0);
          expect(
            await task.getByText('回答已提交', { exact: true }).count(),
          ).toBe(0);
          if (!loaded) {
            expect(await step.getAttribute('data-status')).toBe('结果未确认');
            await page.evaluate(() => window.processTrace());
            await expect
              .poll(() => step.getAttribute('data-status'))
              .toBe('已完成');
          }
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
  const streamedTableSelection = async (direction: 'forward' | 'backward') => {
    const { page, errors, primary } = await openProcess(
      390,
      'light',
      'running',
    );
    try {
      const table = primary.getByRole('table');
      await table.waitFor();
      expect(
        await processOwns(
          primary.getByRole('region', { name: '工作过程', exact: true }),
          table,
        ),
      ).toBe(true);
      const before = await table
        .getByRole('cell', { name: '12', exact: true })
        .evaluate((node, direction) => {
          const text = document
            .createTreeWalker(node, NodeFilter.SHOW_TEXT)
            .nextNode()!;
          const selection = document.getSelection()!;
          const select = () =>
            selection.setBaseAndExtent(
              text,
              direction === 'backward' ? 2 : 0,
              text,
              direction === 'backward' ? 0 : 2,
            );
          select();
          const selected = selection.toString();
          const block = node.closest('[data-process-content]')!;
          const prefix = document.createRange();
          prefix.selectNodeContents(block);
          prefix.setEnd(text, 0);
          const textOffset = prefix.toString().length;
          const previousText = document
            .createTreeWalker(
              node.previousElementSibling!,
              NodeFilter.SHOW_TEXT,
            )
            .nextNode()!;
          prefix.setEnd(previousText, previousText.textContent!.length);
          selection.setBaseAndExtent(
            previousText,
            previousText.textContent!.length,
            text,
            2,
          );
          const boundary = {
            textOffset,
            previousEndOffset: prefix.toString().length,
            selected: selection.toString(),
          };
          select();
          return {
            selected,
            restored: selection.toString(),
            boundary,
            blockText: block.textContent,
          };
        }, direction);
      expect(before.selected).toBe('12');
      expect(before.restored).toBe('12');
      expect(before.boundary.textOffset).toBe(
        before.boundary.previousEndOffset,
      );
      console.info(
        'MET245 table-boundary',
        JSON.stringify({ direction, ...before.boundary }),
      );
      await page.evaluate(() => window.processFinish());
      await expect
        .poll(() =>
          processOwns(
            primary.getByRole('region', { name: '工作过程', exact: true }),
            table,
          ),
        )
        .toBe(false);
      const after = await table.evaluate((node) => {
        const selection = document.getSelection()!;
        return {
          selected: selection.toString(),
          anchor: selection.anchorNode?.nodeName,
          focus: selection.focusNode?.nodeName,
          anchorOffset: selection.anchorOffset,
          focusOffset: selection.focusOffset,
          block: node
            .closest('[data-process-content]')
            ?.getAttribute('data-process-content'),
          blockText: node.closest('[data-process-content]')?.textContent,
        };
      });
      expect(after.selected, JSON.stringify({ before, after })).toBe('12');
      expect(after.anchorOffset).toBe(direction === 'backward' ? 2 : 0);
      expect(after.focusOffset).toBe(direction === 'backward' ? 0 : 2);
      await primary
        .getByRole('link', { name: '核对结果.csv', exact: true })
        .waitFor();
      await primary
        .getByRole('region', { name: '工作过程', exact: true })
        .locator('[data-disclosure-row]')
        .first()
        .click();
      expect(await table.isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  };
  it.each(['forward', 'backward'] as const)(
    'keeps the %s streamed table selection readable when completion moves the reply outside its process',
    streamedTableSelection,
  );
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark']) {
      it(`renders real shared steps and compact questions at ${width}px in ${theme}`, async () => {
        const { page, errors } = await openProcess(width, theme);
        try {
          await searchStep(page)
            .locator('[data-disclosure-row]')
            .first()
            .click();
          const geometry = await detailGeometry(page);
          expect(geometry.width).toBeGreaterThan(180);
          expect(geometry.valueX - geometry.labelRight).toBeCloseTo(12, 0);
          expect(geometry.valueY).toBeCloseTo(geometry.labelY, 0);
          expect(geometry.contained).toBe(true);
          const title = await textBox(
            searchStep(page).locator('[class*="processStepLabel"]'),
          );
          const status = searchStep(page).locator(
            '[class*="processStepStatus"]',
          );
          expect(await status.innerText()).toBe('已完成 · 0.8秒');
          const statusBox = await textBox(status);
          expect(
            Math.abs(
              statusBox.y + statusBox.height / 2 - title.y - title.height / 2,
            ),
          ).toBeLessThanOrEqual(2);
          expect(statusBox.x).toBeGreaterThanOrEqual(title.x + title.width);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(
            await page.evaluate(() =>
              document.body.hasAttribute('data-ds-dark-theme'),
            ),
          ).toBe(theme === 'dark');
          await mkdir('.local/quality/met245-process-a', { recursive: true });
          await page.screenshot({
            path: `.local/quality/met245-process-a/process-${width}-${theme}.png`,
            fullPage: true,
          });
          await answerReceipt(page, 'accepted')
            .locator('[data-disclosure-row]')
            .first()
            .click();
          await page.screenshot({
            path: `.local/quality/met245-process-a/questions-${width}-${theme}.png`,
            fullPage: true,
          });
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      });
    }
  it('keeps two columns at 320px and switches only when the actual detail content reaches 180px', async () => {
    const { page, errors } = await openProcess(320);
    try {
      await searchStep(page).locator('[data-disclosure-row]').first().click();
      const normal = await detailGeometry(page);
      expect(normal.width).toBeGreaterThan(180);
      expect(normal.valueY).toBeCloseTo(normal.labelY, 0);
      for (const target of [180, 181]) {
        const before = await detailGeometry(page);
        await page
          .locator('main[data-process-fixture]')
          .evaluate((node, difference) => {
            node.style.width = `${node.getBoundingClientRect().width + difference}px`;
          }, target - before.width);
        const narrow = await detailGeometry(page);
        expect(narrow.width).toBeCloseTo(target, 0);
        expect(narrow.contained).toBe(true);
        if (target === 180) {
          expect(narrow.valueY).toBeGreaterThan(narrow.labelY);
          expect(narrow.valueX).toBeCloseTo(narrow.labelX, 0);
        } else expect(narrow.valueY).toBeCloseTo(narrow.labelY, 0);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
