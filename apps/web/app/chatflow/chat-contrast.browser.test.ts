/** Real Chrome, real chat components and static props. No server, DB, device or model. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { employeeColorPalette } from '@allrice/contracts';
import type {
  Browser,
  Locator,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

type Colour = number[];

suite('chat input, questions and receipts read clearly (MET-214)', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/chat-contrast-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    type Output = { path: string; contents: Uint8Array };
    const output = (extension: string) =>
      (result.outputFiles as Output[]).find((file) =>
        file.path.endsWith(extension),
      )!.contents;
    // The global stylesheets, taken from the root layout in its order, before
    // the components' CSS modules, as the app loads them.
    const layoutStyles = [
      ...readFileSync('apps/web/app/layout.tsx', 'utf8').matchAll(
        /^import '([^']+\.css)';$/gm,
      ),
    ].map((match) => `@import '${match[1]}';`);
    expect(layoutStyles.length).toBeGreaterThanOrEqual(5);
    const css = await build({
      stdin: {
        contents: layoutStyles.join('\n'),
        resolveDir: resolve('apps/web/app'),
        loader: 'css',
      },
      bundle: true,
      write: false,
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    });
    const files: Record<string, [string, Uint8Array]> = {
      '/layout.css': ['text/css', css.outputFiles[0]!.contents],
      '/components.css': ['text/css', output('.css')],
      '/fixture.js': ['text/javascript', output('.js')],
    };
    server = createServer((req, res) => {
      const file = files[new URL(req.url!, origin).pathname];
      if (file) {
        res.setHeader('Content-Type', file[0]);
        res.end(file[1]);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/components.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
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

  const contrast = (a: Colour, b: Colour) => {
    const luminance = (colour: Colour) => {
      const [r, g, b] = colour.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };

  /**
   * The words' colour (or the placeholder's) and the colour actually behind
   * them: every translucent background up to the first opaque one, composited.
   * Computed colours from color-mix() can arrive as color(srgb …) or oklab(…),
   * so those forms are read as well as rgb().
   */
  const look = (node: Locator, pseudo: string | null = null) =>
    node.evaluate((element, pseudo) => {
      const parse = (value: string) => {
        const srgb = value.match(
          /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/,
        );
        if (srgb)
          return [
            ...srgb.slice(1, 4).map((v) => Number(v) * 255),
            Number(srgb[4] ?? 1),
          ];
        const lab = value.match(
          /^oklab\(([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/,
        );
        if (lab) {
          const [L, A, B] = lab.slice(1, 4).map(Number) as [
            number,
            number,
            number,
          ];
          const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
          const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
          const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
          const encode = (c: number) =>
            255 *
            Math.min(
              1,
              Math.max(
                0,
                c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055,
              ),
            );
          return [
            encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
            Number(lab[4] ?? 1),
          ];
        }
        const rgb = value.match(/^rgba?\(([^)]+)\)$/);
        if (!rgb) throw new Error(`unreadable colour ${value}`);
        const [r, g, b, a] = rgb[1]!.split(/[\s,/]+/).map(Number);
        return [r!, g!, b!, a ?? 1];
      };
      const over = (top: number[], bottom: number[]) => [
        ...[0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)),
        1,
      ];
      const layers: number[][] = [];
      let overImage = false;
      for (
        let at: Element | null = element;
        at && (layers.at(-1)?.[3] ?? 0) < 1;
        at = at.parentElement
      ) {
        const style = getComputedStyle(at);
        if (style.backgroundImage !== 'none') overImage = true;
        const colour = parse(style.backgroundColor);
        if (colour[3]! > 0) layers.push(colour);
      }
      const ground = layers
        .reverse()
        .reduce((below, layer) => over(layer, below), [255, 255, 255, 1]);
      const style = getComputedStyle(element, pseudo);
      const box = element.getBoundingClientRect();
      return {
        text: over(parse(style.color), ground),
        ground,
        overImage,
        fill: parse(getComputedStyle(element).backgroundColor),
        border: parse(getComputedStyle(element).borderTopColor),
        outline: parse(getComputedStyle(element).outlineColor),
        borderWidth: parseFloat(getComputedStyle(element).borderTopWidth),
        inside: box.left >= 0 && box.right <= innerWidth,
      };
    }, pseudo);

  /** Pixels as painted: one element screenshot read back through a canvas. */
  const pixel = async (node: Locator, x: number, y: number) => {
    const png = (await node.screenshot()).toString('base64');
    return node.page().evaluate(
      async ([data, x, y]) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return [...context.getImageData(x, y, 1, 1).data];
      },
      [png, x, y] as const,
    );
  };
  const near = (a: Colour, b: Colour) =>
    Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]! - b[i]!)));
  const label = (node: Locator) =>
    node.evaluate(
      (e) => e.textContent || (e as HTMLTextAreaElement).placeholder,
    );

  const readable = async (node: Locator, pseudo: string | null = null) => {
    await node.waitFor();
    const seen = await look(node, pseudo);
    expect.soft(seen.overImage, await label(node)).toBe(false);
    expect.soft(seen.inside, await label(node)).toBe(true);
    expect
      .soft(contrast(seen.text, seen.ground), await label(node))
      .toBeGreaterThanOrEqual(4.5);
    return seen;
  };
  /** Words on a gradient (the composer seat's fade): read the painted ground. */
  const readableOnPixels = async (node: Locator) => {
    const seen = await look(node);
    const ground = await pixel(node, 8, 8);
    expect
      .soft(contrast(seen.text, ground), await label(node))
      .toBeGreaterThanOrEqual(4.5);
  };
  const ring = (card: Locator) =>
    card.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        style: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
        offset: parseFloat(style.outlineOffset),
      };
    });
  /** A control's own focus indicator: an outline or a ring-like shadow. */
  const ownFocus = (node: Locator) =>
    node.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        visible: element.matches(':focus-visible'),
        shown: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      };
    });
  const open = async (width: number, theme: string, scene: string) => {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      timezoneId: 'Asia/Shanghai',
    });
    // A missing element fails with its locator, not the test timeout.
    page.setDefaultTimeout(5_000);
    await page.goto(`${origin}/?theme=${theme}&scene=${scene}`);
    await page.locator('section').first().waitFor();
    expect(
      await page.evaluate(() => ({
        body: document.body.hasAttribute('data-ds-dark-theme'),
        html: document.documentElement.getAttribute('data-theme'),
        scheme: getComputedStyle(document.documentElement).colorScheme,
      })),
    ).toEqual({
      body: theme === 'dark',
      html: theme,
      scheme: theme === 'dark' ? 'dark' : 'light',
    });
    return page;
  };
  /** The production frame: a 240px sidebar, or the 57px rail when narrow. */
  const frame = async (page: Page, width: number) => {
    expect(
      Math.round(
        (await page
          .getByRole('navigation', { name: '员工和工作' })
          .boundingBox())!.width,
      ),
    ).toBe(width > 760 ? 240 : 57);
    const scroll = page.locator('[class*="scrollBody"]').first();
    // Nothing wider than the column: the scroller clips without a bar.
    expect
      .soft(
        await scroll.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      )
      .toBe(true);
    expect
      .soft(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  };
  const dragFiles = (page: Page) =>
    page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], '截图.png', { type: 'image/png' }));
      document.querySelector('main')!.dispatchEvent(
        new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
    });
  const messageBox = (page: Page) =>
    page.getByRole('textbox', { name: '给 Rice 的消息' });

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`keeps the chat readable at ${width}px in the ${theme} theme`, async () => {
        // The empty conversation: introduction, hint and the focus ring.
        let page = await open(width, theme, 'hero');
        try {
          await frame(page, width);
          const input = messageBox(page);
          const card = input.locator('xpath=..');
          expect(await input.getAttribute('placeholder')).toBe(
            '告诉 Rice 你想完成什么工作',
          );
          await readable(input, '::placeholder');
          await readable(page.locator('h1 + p'));
          const surface = await look(card);
          const column = await look(page.locator('[class*="emptyStage"]'));
          expect.soft(surface.inside).toBe(true);

          // D13: the ring comes with the message box's focus, from the keyboard.
          expect.soft((await ring(card)).style).toBe('none');
          await page.keyboard.press('Tab');
          expect(
            await input.evaluate(
              (node) =>
                document.activeElement === node &&
                node.matches(':focus-visible'),
            ),
          ).toBe(true);
          const focused = await ring(card);
          expect.soft(focused.style).toBe('solid');
          expect.soft(focused.width).toBeGreaterThanOrEqual(2);
          // Drawn inside the card's own box: no ancestor can clip it.
          expect.soft(focused.offset + focused.width).toBeLessThanOrEqual(0);
          // Every employee accent tints the ring; each must still stand out.
          for (const [accent, { value }] of Object.entries(
            employeeColorPalette,
          )) {
            await page.evaluate(
              (value) =>
                document
                  .querySelector<HTMLElement>('main > section')!
                  .style.setProperty('--employee-end', value),
              value,
            );
            const { outline } = await look(card);
            for (const ground of [surface.fill, column.ground])
              expect
                .soft(contrast(outline, ground), `${accent} focus ring`)
                .toBeGreaterThanOrEqual(3);
          }
          await page.evaluate(() =>
            document
              .querySelector<HTMLElement>('main > section')!
              .style.setProperty('--employee-end', '#3B82F6'),
          );
          // As painted: the ring is on screen at the card's edge.
          const box = (await card.boundingBox())!;
          const painted = await pixel(card, 1, Math.round(box.height / 2));
          expect
            .soft(contrast(painted, column.ground))
            .toBeGreaterThanOrEqual(3);
          expect
            .soft(contrast(painted, surface.fill))
            .toBeGreaterThanOrEqual(3);

          // The card's buttons keep their own focus: no second, card-wide ring.
          const add = page.getByRole('button', { name: '添加文件' });
          await page.keyboard.press('Tab');
          expect(
            await add.evaluate((node) => node === document.activeElement),
          ).toBe(true);
          expect
            .soft(await ownFocus(add))
            .toEqual({ visible: true, shown: true });
          expect.soft((await ring(card)).style).toBe('none');
          await add.click();
          expect.soft((await ring(card)).style).toBe('none');
          await input.click();
          expect.soft((await ring(card)).style).toBe('solid');

          // Dropping files over a focused box: the hint reads, the focus stays.
          await dragFiles(page);
          await readable(page.getByText('图片拖动到此处即可添加'));
          await readable(page.getByText('最多 20 张，每张 20 MB'));
          expect.soft((await ring(card)).style).toBe('solid');
        } finally {
          await page.close();
        }

        // A draft ready to send: pointer focus on 发送 leaves no card ring.
        page = await open(width, theme, 'draft');
        try {
          await frame(page, width);
          const input = messageBox(page);
          const card = input.locator('xpath=..');
          const send = page.getByRole('button', { name: '发送', exact: true });
          await input.click();
          expect.soft((await ring(card)).style).toBe('solid');
          await send.click();
          expect.soft((await ring(card)).style).toBe('none');
          await input.click();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          expect(
            await send.evaluate((node) => node === document.activeElement),
          ).toBe(true);
          expect
            .soft(await ownFocus(send))
            .toEqual({ visible: true, shown: true });
          expect.soft((await ring(card)).style).toBe('none');
        } finally {
          await page.close();
        }

        // A busy conversation: the box is disabled and never shows the ring.
        page = await open(width, theme, 'busy');
        try {
          const input = messageBox(page);
          const card = input.locator('xpath=..');
          expect(await input.isDisabled()).toBe(true);
          const at = (await input.boundingBox())!;
          await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
          await page.keyboard.press('Tab');
          expect.soft((await ring(card)).style).toBe('none');
          await dragFiles(page);
          await readable(page.getByText('当前无法添加图片'));
        } finally {
          await page.close();
        }

        // An archived conversation is read-only: no message box at all.
        page = await open(width, theme, 'archived');
        try {
          await frame(page, width);
          expect(await messageBox(page).count()).toBe(0);
          await readableOnPixels(
            page.getByRole('status').filter({ hasText: '已归档' }),
          );
          await page.getByRole('button', { name: '恢复并继续' }).focus();
          expect(await page.locator('textarea').count()).toBe(0);
        } finally {
          await page.close();
        }

        // Attachments, the transcript and the work process.
        page = await open(width, theme, 'attachments');
        try {
          await frame(page, width);
          const followUp = messageBox(page);
          expect(await followUp.getAttribute('placeholder')).toBe(
            '继续和 Rice 工作…',
          );
          await readable(followUp, '::placeholder');

          // D12: failed uploads say 重试 on an opaque chip with a red ring.
          const retries = page.getByRole('button', {
            name: '重试',
            exact: true,
          });
          expect(await retries.count()).toBe(2);
          for (const retry of await retries.all()) {
            const seen = await readable(retry);
            expect.soft(seen.fill[3]).toBe(1);
            expect.soft(seen.borderWidth).toBeGreaterThanOrEqual(1);
            expect
              .soft(contrast(seen.border, seen.fill))
              .toBeGreaterThanOrEqual(3);
            const chip = (await retry.boundingBox())!;
            const behind = await pixel(retry, 3, Math.floor(chip.height / 2));
            expect.soft(near(behind, seen.fill)).toBeLessThanOrEqual(3);
            expect
              .soft(contrast(seen.text, behind))
              .toBeGreaterThanOrEqual(4.5);
          }
          await readable(page.getByText('上传中', { exact: true }));
          // A document's name stays clear of its status chip.
          for (const name of ['合同扫描件.pdf', '十月报价单.pdf']) {
            const item = page
              .getByRole('group', { name: '待发送附件' })
              .locator(':scope > div')
              .filter({ hasText: name });
            const words = (await item.getByText(name).boundingBox())!;
            const chip = (await item
              .getByText(/^(重试|上传中)$/)
              .boundingBox())!;
            const tile = (await item.boundingBox())!;
            expect
              .soft(
                words.y + words.height <= chip.y ||
                  words.x + words.width <= chip.x,
                `${name} clear of its chip`,
              )
              .toBe(true);
            expect
              .soft(words.y >= tile.y, `${name} inside its tile`)
              .toBe(true);
          }

          // L07: the answer receipt, on its tinted header.
          const receipt = page.getByRole('article', { name: '用户确认结果' });
          const quiet = receipt.locator('header span, header time, dt');
          expect(await quiet.count()).toBeGreaterThanOrEqual(4);
          for (const node of await quiet.all()) await readable(node);
          await readable(receipt.getByText('已跳过', { exact: true }));
          // A follow-up the running task did not take.
          await readable(page.getByText('补充未被采纳', { exact: true }));
          // L04: links in a reply.
          await readable(page.getByRole('link', { name: '项目说明' }));
          // A reply that did not finish: its note is the failure.
          await readable(page.locator('small').filter({ hasText: '未完成' }));

          // L02 and the failed step, in the work process.
          const process = page.locator('[data-case="process"]');
          await readable(process.getByLabel('本轮运行时间'));
          for (const words of [
            '分析任务与处理步骤',
            '搜索资料：本周销售数据',
            '查询 NVDA 的实时行情',
            '提问已挂起，等待你的回答',
            '等待处理',
            '未成功：服务超时',
          ])
            await readable(process.getByText(words, { exact: true }));
        } finally {
          await page.close();
        }

        // D09, D10: the question takes the composer's seat.
        page = await open(width, theme, 'question');
        try {
          await frame(page, width);
          const seat = page.locator('[data-composer-seat]');
          await readable(seat.getByText('确认定时任务', { exact: true }));
          const custom = seat.getByRole('textbox', { name: '自定义答案' });
          expect(await custom.getAttribute('placeholder')).toBe(
            '或者输入其他答案',
          );
          await readable(custom, '::placeholder');
          const options = seat.getByRole('radio');
          expect(await options.count()).toBe(2);
          for (const option of await options.all())
            await readable(option.locator('i'));
          await readable(seat.getByText('在本对话里提醒你核对页面'));
          await options.first().click();
          expect(await options.first().getAttribute('aria-checked')).toBe(
            'true',
          );
          for (const option of await options.all())
            await readable(option.locator('i'));
        } finally {
          await page.close();
        }
      });
});
