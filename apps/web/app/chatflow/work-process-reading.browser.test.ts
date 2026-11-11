/** Normal transcript updates in Chrome; synthetic HTTP, no DB/auth/model. */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ids, partnerArguments } from '../../test/technical-details-fixtures';
import { id } from '../../test/experience-command-theme-fixtures';
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
      if (
        [350, 336].some(
          (number) => path === `/api/v1/files/${id(number)}/download`,
        )
      ) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="result.csv"',
        );
        res.end(
          path.includes(id(350))
            ? 'item,count\nchecked,12\n'
            : 'public page evidence\n',
        );
        return;
      }
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
    i === 0
      ? page.locator('#operation-reading-0')
      : page.locator(`[data-step-id="tool:call-${i}"]`);
  const material = (page: Page, i: number) =>
    page.locator(`[data-process-material="cloud:reading-${i}"]`);
  const stepToggle = (step: Locator) =>
    step.locator('[data-disclosure-row]').first();
  async function openGroups(page: Page) {
    for (const row of await processBodyOf(page)
      .getByRole('button', { name: '已调用工具', exact: true })
      .all())
      if ((await row.getAttribute('aria-expanded')) !== 'true')
        await row.click();
  }
  const fullButton = (page: Page) =>
    card(page, 0).getByRole('button', { name: '收起', exact: true });
  const output = (page: Page) =>
    material(page, 5).locator('pre[data-process-content="result"]').last();
  const receiptGeometry = (target: Locator) =>
    target.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const step = node.closest('[data-step-id]') ?? node;
      const body = node.closest<HTMLElement>('[data-process-scrollport]');
      let top = Math.max(0, box.top),
        bottom = Math.min(innerHeight, box.bottom);
      const ancestors = [];
      for (
        let parent = node.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (
          parent === document.scrollingElement ||
          !['auto', 'scroll', 'hidden', 'clip'].includes(
            getComputedStyle(parent).overflowY,
          )
        )
          continue;
        const clip = parent.getBoundingClientRect();
        const edge = clip.top + parent.clientTop;
        top = Math.max(top, edge);
        bottom = Math.min(bottom, edge + parent.clientHeight);
        ancestors.push({
          top: edge,
          height: parent.clientHeight,
          scrollTop: parent.scrollTop,
          scrollHeight: parent.scrollHeight,
          overflow: getComputedStyle(parent).overflowY,
        });
      }
      return {
        identity: step.getAttribute('data-step-id'),
        box: { y: box.y, height: box.height },
        materials: [...step.querySelectorAll('[data-process-material]')].map(
          (item) => item.getAttribute('data-process-material'),
        ),
        readable: bottom > top,
        clip: [top, bottom],
        ancestors,
        window: [scrollY, innerHeight],
        relativeTop: body ? box.top - body.getBoundingClientRect().top : null,
        port: body
          ? {
              scrollTop: body.scrollTop,
              clientHeight: body.clientHeight,
              scrollHeight: body.scrollHeight,
            }
          : null,
      };
    });
  async function open(width = 1440, expandGroups = true) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) =>
      console.log(`Reading fixture error: ${error.message}`),
    );
    await page.goto(origin);
    await card(page, 0).waitFor();
    expect(await processOf(page).getAttribute('data-process-open')).toBe(
      'false',
    );
    await processOf(page).locator('[data-disclosure-row]').first().click();
    if (expandGroups) {
      await openGroups(page);
      expect(await page.locator('[data-step-id^="tool:call-"]').count()).toBe(
        36,
      );
    }
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
        .poll(() => page.locator('[data-step-id^="tool:call-"]').count(), {
          timeout: 5000,
        })
        .toBe(37);
  }
  async function readResult(page: Page) {
    await openGroups(page);
    const toggle = stepToggle(card(page, 5));
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await output(page).waitFor();
    // The input scroller now precedes the result in the single native detail.
    await material(page, 5)
      .locator('pre[data-process-content="input"]')
      .focus();
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
  const detailGeometry = (page: Page, target = searchStep(page)) =>
    target
      .locator('dl')
      .first()
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
      await readResult(page);
      await update(page, 'prefix');
      await stepToggle(card(page, 1)).click();
      const rangeText = (select: boolean) =>
        page.evaluate((select) => {
          if (select) (document.activeElement as HTMLElement)?.blur();
          const from = document.querySelector(
            '[data-process-material="cloud:reading-1"] [data-process-content="input"]',
          )!.firstChild!;
          const to = document.querySelector(
            '[data-process-material="cloud:reading-5"] [data-process-content="result"]',
          )!.firstChild!;
          const range = document.createRange();
          range.setStart(from, from.textContent!.length - 15);
          range.setEnd(to, 50);
          if (select) {
            document.getSelection()!.removeAllRanges();
            document.getSelection()!.addRange(range);
          }
          return select
            ? document.getSelection()!.toString()
            : range.toString();
        }, select);
      const expected = await rangeText(true);
      for (const stage of ['split', 'merge'] as const) {
        await update(page, stage);
        if (stage === 'split') {
          const changed = await rangeText(false);
          expect(changed).not.toBe(expected);
          expect(changed).toContain('补充发现：继续核对后半部分。');
        }
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
    const geometry: unknown[] = [];
    try {
      await readResult(page);
      await page.evaluate(() => window.readingDiagnostic(true));
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
        geometry.push({ stage, before: await receiptGeometry(later) });
        await update(page, stage);
        const box = (await later.boundingBox())!;
        geometry.push({ stage, after: await receiptGeometry(later) });
        expect(box.y, stage).toBeLessThan(900);
        expect(box.y + box.height, stage).toBeGreaterThan(0);
        expect(
          await page.evaluate(() => document.getSelection()!.toString()),
        ).toBe(selected);
        expect(
          await page.evaluate(() => document.activeElement === document.body),
        ).toBe(true);
      }
    } finally {
      try {
        console.log(
          'Reading later diagnostic',
          JSON.stringify({
            geometry,
            reader: await page.evaluate(() => window.readingDiagnostic(false)),
          }),
        );
      } catch {
        console.log('Reading later diagnostic unavailable');
      }
      await page.close();
    }
  });
  it.each(['process title', 'outside input'] as const)(
    'keeps the wheel reader while focus stays on the %s',
    async (target) => {
      const page = await open(390);
      try {
        const title = processOf(page).locator('[data-disclosure-row]').first();
        const outside = page.getByRole('textbox', { name: '另外阅读的位置' });
        const focused = target === 'process title' ? title : outside;
        const later = card(page, 30);
        await stepToggle(later).click();
        const reading = material(page, 30).locator(
          'pre[data-process-content="result"]',
        );
        const original = await reading.textContent();
        await focused.focus();
        const port = processBodyOf(page)
          .locator('[data-process-scrollport]')
          .first();
        const portBox = (await port.boundingBox())!;
        const visiblePort = await receiptGeometry(port);
        expect(visiblePort.readable).toBe(true);
        await page.mouse.move(
          portBox.x + 10,
          (visiblePort.clip[0]! + visiblePort.clip[1]!) / 2,
        );
        await page.mouse.wheel(
          0,
          (await reading.boundingBox())!.y - visiblePort.clip[0]! - 100,
        );
        await page.mouse.move(2, 850);
        const titleBox = (await title.boundingBox())!;
        await page.mouse.wheel(0, titleBox.y + titleBox.height + 1);
        await expect
          .poll(async () => {
            const header = (await title.boundingBox())!;
            const current = await receiptGeometry(reading);
            return (
              header.y + header.height < 0 &&
              current.readable &&
              (current.port?.scrollTop ?? 0) > 0
            );
          })
          .toBe(true);
        const before = await receiptGeometry(reading);
        expect(before.identity).toBe('tool:call-30');
        expect(before.materials).toEqual(['cloud:reading-30']);
        for (const stage of ['prefix', 'split', 'merge'] as const) {
          await update(page, stage);
          const after = await receiptGeometry(reading);
          expect(after.identity, stage).toBe(before.identity);
          expect(after.materials, stage).toEqual(before.materials);
          expect(after.readable, stage).toBe(true);
          expect(after.relativeTop, stage).toBeCloseTo(before.relativeTop!, 0);
          expect(await reading.textContent(), stage).toBe(original);
          expect(
            await focused.evaluate((node) => node === document.activeElement),
            stage,
          ).toBe(true);
        }
        if (target === 'outside input') {
          await page.keyboard.type('继续阅读');
          expect(await outside.inputValue()).toBe('继续阅读');
        }
        expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
  it('keeps an offscreen focused group title without pulling back a wheel reader', async () => {
    const page = await open(390, false);
    try {
      const group = () =>
        processBodyOf(page)
          .getByRole('button', { name: '已调用工具', exact: true })
          .first();
      await group().focus();
      await page.keyboard.press('Enter');
      const later = card(page, 30);
      const list = processBodyOf(page)
        .locator('ul[aria-label="工作步骤"]')
        .first();
      const listBox = (await list.boundingBox())!;
      await page.mouse.move(listBox.x + 10, listBox.y + 30);
      await page.mouse.wheel(
        0,
        (await later.boundingBox())!.y - listBox.y - 100,
      );
      await page.mouse.move(2, 850);
      const groupBox = (await group().boundingBox())!;
      await page.mouse.wheel(0, groupBox.y + groupBox.height + 1);
      await expect
        .poll(async () => {
          const header = (await group().boundingBox())!;
          return later.evaluate((node, headerBottom) => {
            const box = node.getBoundingClientRect();
            let top = Math.max(0, box.top);
            let bottom = Math.min(innerHeight, box.bottom);
            for (
              let parent = node.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              if (
                parent === document.scrollingElement ||
                !/(auto|scroll|hidden|clip)/.test(
                  getComputedStyle(parent).overflowY,
                )
              )
                continue;
              const clip = parent.getBoundingClientRect();
              top = Math.max(top, clip.top + parent.clientTop);
              bottom = Math.min(
                bottom,
                clip.top + parent.clientTop + parent.clientHeight,
              );
            }
            return headerBottom < 0 && bottom > top;
          }, header.y + header.height);
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
    const page = await open(390, false);
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
    const page = await open(390, false);
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
  it('keeps independent native step and approval field choices by exact operation', async () => {
    const page = await open();
    try {
      await readResult(page);
      const raw = card(page, 0).locator('[data-process-control="field:body"]');
      await raw.click();
      await update(page, 'prefix');
      expect(await raw.getAttribute('aria-expanded')).toBe('true');
      expect(
        await raw.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      const result = stepToggle(card(page, 5));
      await result.focus();
      await update(page, 'split');
      expect(
        await result.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      const app = stepToggle(card(page, 6));
      expect(await app.getAttribute('aria-expanded')).toBe('false');
      await app.click();
      await update(page, 'merge');
      expect(
        await app.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('Space');
      expect(await app.getAttribute('aria-expanded')).toBe('false');
      expect(await result.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await page.close();
    }
  });
  it('keeps the original 360px group, inherits expansion after split and releases choices for a Run or unmount', async () => {
    const page = await open(390, false);
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
      for (const row of await group().all())
        expect(await row.getAttribute('aria-expanded')).toBe('false');
      await openGroups(page);
      expect(
        await stepToggle(card(page, 5)).getAttribute('aria-expanded'),
      ).toBe('false');
      await readResult(page);
      await page.evaluate(() => window.readingMount(false));
      await expect.poll(() => processOf(page).count()).toBe(0);
      await page.evaluate(() => window.readingMount(true));
      await processOf(page).waitFor();
      await processOf(page).locator('[data-disclosure-row]').first().click();
      await openGroups(page);
      expect(
        await stepToggle(card(page, 5)).getAttribute('aria-expanded'),
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
  it('keeps every one of 36 receipts and the 37th appended receipt at its exact native step', async () => {
    const page = await open(390);
    try {
      for (let index = 0; index < 36; index++) {
        const step = page.locator(`[data-step-id="tool:call-${index}"]`);
        await stepToggle(step).click();
        expect(
          await step
            .locator(`[data-process-material="cloud:reading-${index}"]`)
            .count(),
        ).toBe(1);
      }
      await update(page, 'append');
      await stepToggle(card(page, 36)).click();
      await material(page, 36).waitFor();
      expect(
        await page.locator('[data-process-material^="cloud:reading-"]').count(),
      ).toBe(37);
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('keeps the real reader mounted when late native and feature gates enable four panels', async () => {
    const page = await open(390);
    try {
      await readResult(page);
      const process = await processOf(page).elementHandle();
      const text = await output(page).evaluate((node) => {
        node.focus();
        document
          .getSelection()!
          .setBaseAndExtent(node.firstChild!, 200, node.firstChild!, 220);
        return document.getSelection()!.toString();
      });
      const paths = [
        'managed-browser-tasks',
        'runtime/browser-workspaces',
        'runtime/local-commands',
        'runtime/local-mcp',
      ];
      for (const path of paths)
        expect(
          await page.evaluate(
            (path) => window.readingReads[`/api/v1/${path}`] ?? 0,
            path,
          ),
        ).toBe(0);
      await page.evaluate(() => {
        window.readingEnablePanels();
        window.readingUpdate('prefix');
      });
      for (const path of paths)
        await expect
          .poll(() =>
            page.evaluate(
              (path) => window.readingReads[`/api/v1/${path}`],
              path,
            ),
          )
          .toBe(1);
      expect(
        await processOf(page).evaluate(
          (node, before) => node === before,
          process,
        ),
      ).toBe(true);
      expect(await card(page, 5).getAttribute('data-step-id')).toBe(
        'tool:call-5',
      );
      expect(
        await stepToggle(card(page, 5)).getAttribute('aria-expanded'),
      ).toBe('true');
      expect(
        await output(page).evaluate((node) => node === document.activeElement),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.getSelection()!.toString()),
      ).toBe(text);
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
    } finally {
      await page.close();
    }
  });
  const cardsMaterial = (page: Page, source: string, operation: string) =>
    page.locator(`[data-process-material="${source}:${operation}"]`);
  async function openCards(
    width: number,
    theme: string,
    scenario = '',
    expandSteps = true,
  ) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?cards&theme=${theme}${scenario}`);
    await page.getByLabel('发送的完整参数', { exact: true }).waitFor();
    for (const process of await processOf(page).all())
      if ((await process.getAttribute('data-process-open')) === 'false')
        await stepToggle(process).click();
    const steps = expandSteps ? await page.locator('[data-step-id]').all() : [];
    for (const step of steps)
      if ((await stepToggle(step).getAttribute('aria-expanded')) !== 'true')
        await stepToggle(step).click();
    return page;
  }
  const focused = (target: Locator) =>
    target.evaluate((node) => node === document.activeElement);
  const precedes = async (first: Locator, second: Locator) =>
    first.evaluate(
      (node, next) =>
        !!(
          node.compareDocumentPosition(next!) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      await second.elementHandle(),
    );
  it.each(['open', 'closed'] as const)(
    'keeps a manual %s receipt choice and reading after exact late call attribution',
    async (choice) => {
      const page = await openCards(
        390,
        'light',
        `&regression=late-${choice}`,
        false,
      );
      try {
        const operation =
          choice === 'open' ? ids.succeededOperation : ids.projectOperation;
        const old = page.locator(
          `[data-step-id="operation:cloud:${operation}"]`,
        );
        const result = cardsMaterial(page, 'cloud', operation).locator(
          'pre[data-process-content="result"]',
        );
        if (choice === 'open')
          expect(
            await page
              .locator('[data-steering-segment="initial"]')
              .locator(old)
              .count(),
          ).toBe(1);
        expect(await stepToggle(old).getAttribute('aria-expanded')).toBe(
          choice === 'open' ? 'false' : 'true',
        );
        await stepToggle(old).click();
        const selected =
          choice === 'open'
            ? await result.evaluate((node) => {
                node.focus();
                node.scrollTop = 650;
                document
                  .getSelection()!
                  .setBaseAndExtent(
                    node.firstChild!,
                    1000,
                    node.firstChild!,
                    1030,
                  );
                return document.getSelection()!.toString();
              })
            : '';
        if (choice === 'closed') {
          await stepToggle(old).focus();
          expect(await focused(stepToggle(old))).toBe(true);
        } else
          expect(await result.evaluate((node) => node.scrollTop)).toBe(650);
        await update(page, 'prefix');
        const native = page.locator('[data-step-id="tool:cards-pair"]');
        const toggle = stepToggle(native);
        await native.waitFor();
        expect(await old.count()).toBe(0);
        expect(await toggle.getAttribute('aria-expanded')).toBe(
          String(choice === 'open'),
        );
        expect(await native.getAttribute('data-status')).toBe(
          choice === 'open' ? '已完成' : '未成功',
        );
        if (choice === 'open') {
          expect(
            await page
              .locator('[data-steering-segment="cards-steering"]')
              .locator(native)
              .count(),
          ).toBe(1);
          expect(await focused(result)).toBe(true);
          expect(await result.evaluate((node) => node.scrollTop)).toBe(650);
          expect(
            await page.evaluate(() => document.getSelection()!.toString()),
          ).toBe(selected);
          expect(selected.length).toBe(30);
        } else {
          expect(await focused(toggle)).toBe(true);
          await toggle.click();
        }
        for (const exact of [ids.succeededOperation, ids.projectOperation]) {
          const material = cardsMaterial(page, 'cloud', exact);
          expect(await native.locator(material).count()).toBe(1);
          expect(await material.count()).toBe(1);
          expect(
            await page
              .locator(`[data-step-id="operation:cloud:${exact}"]`)
              .count(),
          ).toBe(0);
        }
        expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
  it('reaches the exact later successful MCP material through the original link from a folded process', async () => {
    const page = await openCards(390, 'light', '&regression=retry', false);
    try {
      await stepToggle(processOf(page)).click();
      expect(await processOf(page).getAttribute('data-process-open')).toBe(
        'false',
      );
      const failure = page.locator(
        `article[data-process-operation="${id(370)}"]`,
      );
      const link = failure.getByRole('link', {
        name: '查看完成的那次',
        exact: true,
      });
      expect(await link.count()).toBe(1);
      const fragment = new URL(
        (await link.getAttribute('href'))!,
        origin,
      ).hash.slice(1);
      expect(fragment).not.toBe('');
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
      await link.click();
      const success = cardsMaterial(page, 'cloud', id(371));
      await success.waitFor();
      const target = page.locator(
        `[id=${JSON.stringify(decodeURIComponent(fragment))}]`,
      );
      expect(await target.count()).toBe(1);
      expect(await target.isVisible()).toBe(true);
      expect(
        await target.evaluate(
          (node, material) =>
            node.contains(material!) || material!.contains(node),
          await success.elementHandle(),
        ),
      ).toBe(true);
      expect(await success.count()).toBe(1);
      const box = (await success.boundingBox())!;
      expect(box.y).toBeLessThan(900);
      expect(box.y + box.height).toBeGreaterThan(0);
      expect(
        await page
          .locator('[data-step-id="tool:cards-retry-1"]')
          .locator(success)
          .count(),
      ).toBe(1);
      const result = success.locator('pre[data-process-content="result"]');
      expect(JSON.parse(await result.innerText())).toEqual({
        delivered: true,
        messageId: 'retry-371',
      });
      expect(await failure.getAttribute('data-status')).toBe('failed');
      const failedResult = cardsMaterial(page, 'cloud', id(370)).locator(
        'pre[data-process-content="result"]',
      );
      expect(await failedResult.innerText()).toBe(
        'MCP connection unavailable before dispatch',
      );
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('keeps historical browser locations tied to each action when the current observation changes', async () => {
    const page = await openCards(390, 'light', '&regression=browser');
    try {
      const location = (operation: number) =>
        cardsMaterial(page, 'browser', id(operation))
          .locator('dt')
          .evaluateAll(
            (nodes) =>
              nodes.find((node) => node.textContent === '位置')!
                .nextElementSibling!.textContent,
          );
      const contents = () =>
        page
          .locator('[data-process-material^="browser:"] pre')
          .allTextContents();
      const reads = () =>
        page.evaluate(
          () => window.readingReads['/api/v1/runtime/browser-workspaces'] ?? 0,
        );
      const original = await contents();
      const before = await reads();
      for (const title of ['当前观察甲', '当前观察乙']) {
        await page.getByText(title, { exact: true }).waitFor();
        for (const [operation, expected] of [
          [310, '组合测试电脑 · example.com'],
          [313, '组合测试电脑 · example.com/submit'],
        ] as const)
          expect(await location(operation)).toBe(expected);
        expect(await location(314)).toBe('组合测试电脑');
        expect(await contents()).toEqual(original);
        if (title === '当前观察甲') await update(page, 'prefix');
      }
      expect(await reads()).toBeGreaterThan(before);
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('keeps an unassigned cloud receipt between its original reply and exact adopted steering boundary', async () => {
    const page = await openCards(390, 'light', '&regression=order');
    try {
      const receipt = cardsMaterial(page, 'cloud', ids.unknownOperation);
      const before = page.getByText('采用补充前的说明。', { exact: true });
      const after = page.getByText('采用补充后的说明。', { exact: true });
      const input = page.locator('#message-cards-steering');
      for (const phase of ['initial', 'prefix'] as const) {
        expect(await receipt.count()).toBe(1);
        expect(
          await page
            .locator('[data-steering-segment="initial"]')
            .locator(receipt)
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator('[data-steering-segment="cards-steering"]')
            .locator(receipt)
            .count(),
        ).toBe(0);
        expect(
          await receipt
            .locator('xpath=ancestor::*[@data-step-id][1]')
            .getAttribute('data-step-id'),
        ).toBe(`operation:cloud:${ids.unknownOperation}`);
        expect(await precedes(before, receipt)).toBe(true);
        for (const next of [input, after])
          expect(await precedes(receipt, next)).toBe(true);
        expect(await page.locator('table').count()).toBe(1);
        expect(
          await processOwns(processOf(page).last(), page.locator('table')),
        ).toBe(false);
        if (phase === 'initial') {
          await update(page, 'prefix');
          await page.getByText('补充后追加的说明。', { exact: true }).waitFor();
        }
      }
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('keeps exact mixed operation history, complete exterior approval and fixed unique deliverables', async () => {
    const page = await openCards(390, 'light');
    try {
      const pair = page.locator('[data-step-id="tool:cards-pair"]');
      expect(
        await pair.locator('[data-process-material^="cloud:"]').count(),
      ).toBe(2);
      expect(await pair.getAttribute('data-status')).toBe('已完成');
      expect(await pair.innerText()).toContain('Cannot find module');
      for (const [call, operation] of [
        ['cards-sales', ids.mcpOperation],
        ['cards-partner', ids.partnerOperation],
      ])
        expect(
          await page
            .locator(
              `[data-step-id="tool:${call}"] [data-process-material="cloud:${operation}"]`,
            )
            .count(),
        ).toBe(1);
      expect(
        await page
          .locator(
            `[data-step-id="tool:cards-managed"] [data-process-material="managed-browser:${id(322)}"]`,
          )
          .count(),
      ).toBe(1);
      expect(
        await page
          .locator(
            `[data-step-id="operation:managed-browser:${id(321)}"] [data-process-material]`,
          )
          .count(),
      ).toBe(1);
      expect(
        await page
          .locator(
            `[data-step-id="operation:cloud:${ids.unknownOperation}"] [data-process-material]`,
          )
          .count(),
      ).toBe(1);
      for (const [source, operation] of [
        ['browser', id(310)],
        ['command', id(70)],
        ['mcp', id(92)],
      ])
        expect(await cardsMaterial(page, source!, operation!).count()).toBe(1);
      for (const number of [313, 314]) {
        const unassigned = page.locator(
          `[data-step-id="operation:browser:${id(number)}"]`,
        );
        expect(
          await unassigned
            .locator(`[data-process-material="browser:${id(number)}"]`)
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator(
              `[data-step-id="tool:cards-browser"] [data-process-material="browser:${id(number)}"]`,
            )
            .count(),
        ).toBe(0);
      }
      const service = page.getByRole('region', { name: '项目实时预览' });
      expect(await service.innerText()).toContain('状态待核实');
      expect(
        await service
          .getByRole('button', { name: '打开预览', exact: true })
          .isDisabled(),
      ).toBe(true);
      await stepToggle(processOf(page)).click();
      const complete = page.getByLabel('发送的完整参数', { exact: true });
      expect(await complete.isVisible()).toBe(true);
      expect(JSON.parse(await complete.innerText())).toEqual(partnerArguments);
      expect(await page.locator('[data-forged-review]').count()).toBe(0);
      const command = page.locator(`#operation-${id(70)}`);
      for (const text of [
        '/usr/local/bin/node',
        'scripts/report.mjs',
        '2026-10',
        'data/sales.csv',
      ])
        expect(await command.innerText()).toContain(text);
      const localMcp = page.locator(`#operation-${id(92)}`);
      expect(await localMcp.innerText()).toContain('上海星河贸易');
      for (const target of [
        complete,
        command,
        localMcp,
        service,
        page.locator('table'),
        page.getByRole('button', { name: '我来操作' }),
      ]) {
        expect(await target.isVisible()).toBe(true);
        expect(await processOwns(processOf(page), target)).toBe(false);
      }
      expect(
        await page
          .getByRole('button', { name: '核对结果.csv 文件选项', exact: true })
          .count(),
      ).toBe(2);
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
      await page
        .locator(`#operation-${ids.partnerOperation}`)
        .getByRole('button', { name: '允许对外发送内容' })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.readingWrites.length))
        .toBe(1);
      expect(await page.evaluate(() => window.readingWrites[0])).toMatchObject({
        url: `/api/v1/runtime/approvals/${ids.partnerApproval}`,
        body: {
          approvalId: ids.partnerApproval,
          version: 1,
          requestDigest: `sha256:${'b'.repeat(64)}`,
          decision: 'approved',
        },
      });
      await service
        .getByRole('button', { name: '停止预览', exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.readingWrites.length))
        .toBe(2);
      expect(await page.evaluate(() => window.readingWrites[1])).toEqual({
        url: `/api/v1/runtime/project-services?workspaceId=${ids.workspace}&serviceId=${id(301)}`,
        body: { action: 'stop' },
      });
      await expect
        .poll(() => service.innerText())
        .toContain('正在等待运行环境确认');
      expect(await pair.getAttribute('data-status')).toBe('已完成');
      const evidence = page.getByRole('region', { name: '云端浏览器任务' });
      await evidence.locator('summary').click();
      expect(await processOwns(processOf(page), evidence)).toBe(false);
      const evidenceDownload = page.waitForEvent('download');
      await evidence.getByRole('button', { name: '下载', exact: true }).click();
      await evidenceDownload;
      expect(await page.evaluate(() => window.readingWrites[2])).toEqual({
        url: `/api/v1/files/${id(336)}/sign`,
        body: { lifetimeSeconds: 900 },
      });
      await page
        .getByRole('button', { name: '核对结果.csv 文件选项', exact: true })
        .first()
        .click();
      const download = page.waitForEvent('download');
      await page
        .getByRole('menuitem', { name: '下载文件', exact: true })
        .click();
      const bytes: Buffer[] = [];
      for await (const chunk of (await (await download).createReadStream())!)
        bytes.push(Buffer.from(chunk));
      expect(Buffer.concat(bytes).toString()).toBe('item,count\nchecked,12\n');
      await page
        .getByRole('button', { name: '核对结果.csv 文件选项', exact: true })
        .first()
        .click();
      await page
        .getByRole('menuitem', { name: '侧栏预览', exact: true })
        .click();
      const preview = page
        .getByRole('region', { name: '文件正文', exact: true })
        .locator('code');
      await preview.waitFor();
      expect(await preview.textContent()).toBe('item,count\nchecked,12');
      expect(
        await page.evaluate(
          (path) => window.readingReads[path],
          `/api/v1/sessions/${ids.session}/artifacts/${ids.artifact}`,
        ),
      ).toBeGreaterThan(0);
      await page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await page
        .getByRole('button', {
          name: '文件修改建议.json 文件选项',
          exact: true,
        })
        .click();
      await page
        .getByRole('menuitem', { name: '侧栏预览', exact: true })
        .click();
      await page.getByRole('button', { name: '允许保存这些修改' }).waitFor();
      expect(
        await page.evaluate(
          (path) => window.readingReads[path],
          `/api/v1/sessions/${ids.session}/artifacts/${ids.doneArtifact}/executions`,
        ),
      ).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.readingWrites.length)).toBe(3);
      await page.getByLabel('提案文件', { exact: true }).waitFor();
      await page.getByRole('button', { name: '允许保存这些修改' }).click();
      await expect
        .poll(() => page.evaluate(() => window.readingWrites.length))
        .toBe(4);
      expect(await page.evaluate(() => window.readingWrites[3])).toMatchObject({
        url: `/api/v1/runtime/approvals/${ids.changesetApproval}`,
        body: {
          approvalId: ids.changesetApproval,
          version: 1,
          requestDigest: `sha256:${'b'.repeat(64)}`,
          decision: 'approved',
        },
      });
    } finally {
      await page.close();
    }
  });
  it('keeps the original polling deadlines when opening and closing mixed history', async () => {
    const page = await browser.newPage();
    try {
      const time = new Date('2026-11-10T10:00:00Z');
      await page.clock.install({ time });
      await page.clock.pauseAt(new Date(time.getTime() + 1000));
      await page.goto(`${origin}/?cards`);
      await page.getByLabel('发送的完整参数', { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.evaluate(() => window.readingReads['/api/v1/runtime/local-mcp']),
        )
        .toBe(2);
      await page
        .getByRole('button', {
          name: '文件修改建议.json 文件选项',
          exact: true,
        })
        .click();
      await page
        .getByRole('menuitem', { name: '侧栏预览', exact: true })
        .click();
      await page.getByRole('button', { name: '允许保存这些修改' }).waitFor();
      const before = await page.evaluate(() => ({ ...window.readingReads }));
      await page.clock.runFor(500);
      await stepToggle(processOf(page)).click();
      await page.clock.runFor(300);
      await stepToggle(processOf(page)).click();
      expect(await page.evaluate(() => window.readingReads)).toEqual(before);
      await page.clock.runFor(700);
      for (const [path, count] of Object.entries(before))
        expect(
          await page.evaluate((path) => window.readingReads[path], path),
        ).toBe(
          count +
            ([
              'cloud-operations',
              'local-commands',
              'local-mcp',
              'browser-workspaces',
              'executions',
            ].some((name) => path.endsWith(name))
              ? 1
              : 0),
        );
      expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
    } finally {
      await page.close();
    }
  });
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      it(`captures real mixed history and exterior review at ${width}px in ${theme}`, async () => {
        const page = await openCards(width, theme);
        try {
          const weak = await page
            .locator(
              '[data-process-material] dt, [data-process-material] dd, [data-process-material] pre, [class*="processStepStatus"]',
            )
            .evaluateAll((nodes) => {
              const context = document
                .createElement('canvas')
                .getContext('2d')!;
              const paint = (colour: string) => {
                context.fillStyle = colour;
                context.fillRect(0, 0, 1, 1);
              };
              const light = (rgb: Uint8ClampedArray) =>
                [...rgb]
                  .slice(0, 3)
                  .map((v) => {
                    const channel = v / 255;
                    return channel <= 0.04045
                      ? channel / 12.92
                      : ((channel + 0.055) / 1.055) ** 2.4;
                  })
                  .reduce(
                    (sum, value, index) =>
                      sum + value * [0.2126, 0.7152, 0.0722][index]!,
                    0,
                  );
              return nodes
                .filter((node) => node.getClientRects().length)
                .flatMap((node) => {
                  const backgrounds: string[] = [];
                  for (let at: Element | null = node; at; at = at.parentElement)
                    backgrounds.unshift(getComputedStyle(at).backgroundColor);
                  paint('white');
                  backgrounds.forEach(paint);
                  const ground = light(context.getImageData(0, 0, 1, 1).data);
                  paint(getComputedStyle(node).color);
                  const ink = light(context.getImageData(0, 0, 1, 1).data);
                  const ratio =
                    (Math.max(ink, ground) + 0.05) /
                    (Math.min(ink, ground) + 0.05);
                  return ratio < 4.5
                    ? [`${node.textContent?.slice(0, 30)} ${ratio}`]
                    : [];
                });
            });
          expect(weak).toEqual([]);
          const outputDirectory = '.local/quality/met245-process-c';
          await mkdir(outputDirectory, { recursive: true });
          const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim();
          for (const view of ['history', 'current']) {
            const target =
              view === 'history'
                ? page
                    .locator(
                      '[data-step-id="tool:cards-pair"] [data-process-material]',
                    )
                    .last()
                    .locator('dt')
                    .first()
                : page.getByLabel('发送的完整参数', { exact: true });
            if (view === 'current') await stepToggle(processOf(page)).click();
            await target.evaluate(
              (node, view) =>
                node.scrollIntoView({
                  block: view === 'history' ? 'center' : 'start',
                }),
              view,
            );
            const framing = await page
              .locator(
                '[data-step-id="tool:cards-pair"] [data-process-material]',
              )
              .evaluateAll((nodes) =>
                nodes.map((node) => {
                  const bounds = node.getBoundingClientRect();
                  let top = Math.max(0, bounds.top),
                    bottom = Math.min(innerHeight, bounds.bottom);
                  const scrolls: {
                    className: string;
                    scrollTop: number;
                    clientHeight: number;
                  }[] = [];
                  for (
                    let parent = node.parentElement;
                    parent;
                    parent = parent.parentElement
                  ) {
                    if (
                      /(auto|scroll|hidden|clip)/.test(
                        getComputedStyle(parent).overflowY,
                      )
                    ) {
                      const clip = parent.getBoundingClientRect();
                      top = Math.max(top, clip.top);
                      bottom = Math.min(bottom, clip.bottom);
                      scrolls.push({
                        className: parent.className,
                        scrollTop: parent.scrollTop,
                        clientHeight: parent.clientHeight,
                      });
                    }
                  }
                  return {
                    material: node.getAttribute('data-process-material'),
                    bounds: bounds.toJSON(),
                    visibleHeight: Math.max(0, bottom - top),
                    scrolls,
                  };
                }),
              );
            if (view === 'history') {
              expect(framing.length).toBe(2);
              for (const material of framing)
                expect(material.visibleHeight).toBeGreaterThan(24);
            }
            const name = `cards-${view}-${width}-${theme}`;
            await page.screenshot({ path: `${outputDirectory}/${name}.png` });
            await writeFile(
              `${outputDirectory}/${name}.json`,
              JSON.stringify(
                {
                  sourceSha,
                  width,
                  height: 900,
                  theme,
                  scenario: 'cards',
                  view,
                  scrollY: await page.evaluate(() => scrollY),
                  target: await target.boundingBox(),
                  framing,
                  scope:
                    view === 'history'
                      ? 'partial 1:N boundary: first result tail and second status/location/input; full values covered by behavior'
                      : 'complete MCP parameter scroller and exterior approval; other controls/artifacts covered by behavior',
                },
                null,
                2,
              ),
            );
            const overview = page.locator(
              view === 'history'
                ? '[data-step-id="tool:cards-browser"]'
                : `#operation-${ids.mcpOperation}`,
            );
            const overviewHeader =
              view === 'history'
                ? stepToggle(overview)
                : overview.locator('header').first();
            await overviewHeader.evaluate((node) =>
              node.scrollIntoView({ block: 'start' }),
            );
            if (view === 'history')
              await stepToggle(processOf(page)).evaluate((node) =>
                node.scrollIntoView({ block: 'start' }),
              );
            const overviewFraming = await overview
              .locator(
                view === 'history'
                  ? `[data-disclosure-row], [data-process-material="browser:${id(310)}"] > dl > dt, [data-process-material="browser:${id(310)}"] > dl > dd`
                  : 'header, [aria-label="这次要做的事"] > div:first-child, [aria-label="这次要做的事"] > div:nth-child(2), [aria-label="参数"]',
              )
              .evaluateAll((nodes) =>
                nodes.map((node) => {
                  const bounds = node.getBoundingClientRect();
                  let left = Math.max(0, bounds.left);
                  let right = Math.min(innerWidth, bounds.right);
                  let top = Math.max(0, bounds.top);
                  let bottom = Math.min(innerHeight, bounds.bottom);
                  const clips = [];
                  for (
                    let parent = node.parentElement;
                    parent;
                    parent = parent.parentElement
                  ) {
                    if (parent === document.scrollingElement) continue;
                    const style = getComputedStyle(parent);
                    const clipX = /(auto|scroll|hidden|clip)/.test(
                      style.overflowX,
                    );
                    const clipY = /(auto|scroll|hidden|clip)/.test(
                      style.overflowY,
                    );
                    if (!clipX && !clipY) continue;
                    const box = parent.getBoundingClientRect();
                    const clip = {
                      left: box.left + parent.clientLeft,
                      top: box.top + parent.clientTop,
                      width: parent.clientWidth,
                      height: parent.clientHeight,
                    };
                    if (clipX) {
                      left = Math.max(left, clip.left);
                      right = Math.min(right, clip.left + clip.width);
                    }
                    if (clipY) {
                      top = Math.max(top, clip.top);
                      bottom = Math.min(bottom, clip.top + clip.height);
                    }
                    clips.push({
                      tag: parent.tagName,
                      className: parent.className,
                      overflowX: style.overflowX,
                      overflowY: style.overflowY,
                      scrollLeft: parent.scrollLeft,
                      scrollTop: parent.scrollTop,
                      clip,
                    });
                  }
                  return {
                    tag: node.tagName,
                    text: node.textContent,
                    bounds: bounds.toJSON(),
                    visibleWidth: Math.max(0, right - left),
                    visibleHeight: Math.max(0, bottom - top),
                    clips,
                  };
                }),
              );
            expect(overviewFraming.length).toBe(view === 'history' ? 9 : 4);
            for (const anchor of overviewFraming) {
              expect(anchor.visibleWidth).toBeGreaterThan(0);
              expect(anchor.visibleHeight).toBeGreaterThan(0);
              expect(anchor.visibleWidth).toBeGreaterThanOrEqual(
                anchor.bounds.width - 1,
              );
              expect(anchor.visibleHeight).toBeGreaterThanOrEqual(
                anchor.bounds.height - 1,
              );
            }
            const overviewName = `cards-overview-${view}-${width}-${theme}`;
            await page.screenshot({
              path: `${outputDirectory}/${overviewName}.png`,
            });
            await writeFile(
              `${outputDirectory}/${overviewName}.json`,
              JSON.stringify(
                {
                  sourceSha,
                  width,
                  height: 900,
                  theme,
                  scenario: 'cards',
                  view,
                  kind: 'overview',
                  scroll: await page.evaluate(() => ({
                    x: scrollX,
                    y: scrollY,
                  })),
                  target: await overviewHeader.boundingBox(),
                  framing: overviewFraming,
                  scope:
                    view === 'history'
                      ? 'browser step title and complete status/location/input/result; full mixed and 1:N records covered separately'
                      : 'sales pending title, action, recipient and short parameter preview; full approval content and controls covered separately',
                },
                null,
                2,
              ),
            );
          }
        } finally {
          await page.close();
        }
      });
  it('keeps real mixed fields inside 320px and uses actual 180/181px detail layout', async () => {
    const page = await openCards(320, 'light');
    try {
      const fields = cardsMaterial(page, 'command', id(70));
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const width of [180, 181]) {
        const before = await detailGeometry(page, fields);
        await page.locator('main').evaluate((node, difference) => {
          node.style.boxSizing = 'border-box';
          node.style.width = `${node.getBoundingClientRect().width + difference}px`;
        }, width - before.width);
        const geometry = await detailGeometry(page, fields);
        expect(geometry.width).toBeCloseTo(width, 0);
        expect(geometry.contained).toBe(true);
        if (width === 180) {
          expect(geometry.valueY).toBeGreaterThan(geometry.labelY);
          expect(geometry.valueX).toBeCloseTo(geometry.labelX, 0);
        } else expect(geometry.valueY).toBeCloseTo(geometry.labelY, 0);
      }
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
  it.each(['detailed', 'verbose'] as const)(
    'honors verbose tool details and manual choices when starting in %s',
    async (view) => {
      const { page, errors, primary } = await openProcess(
        390,
        'light',
        `running${view === 'verbose' ? '&verbose' : ''}`,
      );
      const process = primary.getByRole('region', {
        name: '工作过程',
        exact: true,
      });
      const toggle = searchStep(page).locator('[data-disclosure-row]');
      const result = searchStep(page).getByText('已找到十二项对应资料', {
        exact: true,
      });
      const setView = async (next: 'detailed' | 'verbose') => {
        await page.evaluate((next) => window.processView(next), next);
        await expect
          .poll(() => process.getAttribute('data-transcript-view'))
          .toBe(next);
      };
      try {
        expect(await toggle.getAttribute('aria-expanded')).toBe(
          String(view === 'verbose'),
        );
        expect(await result.isVisible()).toBe(view === 'verbose');
        expect(
          await primary
            .locator('[data-step-id="tool:failed"]')
            .getByText('服务超时', { exact: true })
            .isVisible(),
        ).toBe(true);
        await setView('detailed');
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await result.isVisible()).toBe(false);
        await setView('verbose');
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        expect(await result.isVisible()).toBe(true);
        await toggle.click();
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        await page.evaluate(() => window.processFinish());
        const final = primary.locator(
          '[data-work-reply]:not([data-process-member])',
        );
        await final.waitFor();
        expect(await final.count()).toBe(1);
        expect(await final.locator('table').isVisible()).toBe(true);
        expect(await processOwns(process, final.locator('table'))).toBe(false);
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await result.isVisible()).toBe(false);
        await setView('detailed');
        await setView('verbose');
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await result.isVisible()).toBe(false);
        await toggle.press('Enter');
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        expect(await result.isVisible()).toBe(true);
        expect(await page.evaluate(() => window.readingWrites)).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
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
