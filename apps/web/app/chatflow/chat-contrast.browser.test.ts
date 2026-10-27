/** Real Chrome, real chat components and static props. No server, DB, device or model. */
import { createRequire } from 'node:module';
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/chat-contrast-page.css"><div id="root"></div><script type="module" src="/chat-contrast-page.js"></script>',
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

  const readable = async (node: Locator, pseudo: string | null = null) => {
    await node.waitFor();
    const seen = await look(node, pseudo);
    expect.soft(seen.overImage).toBe(false);
    expect.soft(seen.inside).toBe(true);
    const ratio = contrast(seen.text, seen.ground);
    expect
      .soft(
        ratio,
        `${await node.evaluate((e) => e.textContent || (e as HTMLTextAreaElement).placeholder)}`,
      )
      .toBeGreaterThanOrEqual(4.5);
    return seen;
  };
  const caseOf = (page: Page, name: string) =>
    page.locator(`[data-case="${name}"]`);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`keeps the chat readable at ${width}px in the ${theme} theme`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          timezoneId: 'Asia/Shanghai',
        });
        // A missing element fails with its locator, not the test timeout.
        page.setDefaultTimeout(5_000);
        try {
          await page.goto(`${origin}/?theme=${theme}`);
          const hero = caseOf(page, 'hero');
          const heroInput = hero.getByRole('textbox', {
            name: '给 Rice 的消息',
          });
          await heroInput.waitFor();
          expect(
            await page.evaluate(() =>
              document.body.hasAttribute('data-ds-dark-theme'),
            ),
          ).toBe(theme === 'dark');

          // D13: a visible focus ring around the message box, at every width.
          const card = heroInput.locator('xpath=..');
          const ring = () =>
            card.evaluate((node) => {
              const style = getComputedStyle(node);
              return {
                style: style.outlineStyle,
                width: parseFloat(style.outlineWidth),
                offset: parseFloat(style.outlineOffset),
              };
            });
          expect.soft((await ring()).style).toBe('none');
          await page.keyboard.press('Tab');
          expect(
            await heroInput.evaluate(
              (node) =>
                document.activeElement === node &&
                node.matches(':focus-visible'),
            ),
          ).toBe(true);
          const focused = await ring();
          expect.soft(focused.style).toBe('solid');
          expect.soft(focused.width).toBeGreaterThanOrEqual(2);
          // Drawn inside the card's own box: no ancestor can clip it.
          expect.soft(focused.offset + focused.width).toBeLessThanOrEqual(0);
          const surface = await look(card);
          const column = await look(hero);
          expect.soft(surface.inside).toBe(true);
          // Every employee accent tints the ring; each must still stand out.
          for (const [accent, { value }] of Object.entries(
            employeeColorPalette,
          )) {
            await page.evaluate(
              (value) =>
                document
                  .querySelector('main')!
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
              .querySelector('main')!
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

          // D03: the message box hints, empty and while work continues.
          expect(await heroInput.getAttribute('placeholder')).toBe(
            '告诉 Rice 你想完成什么工作',
          );
          await readable(heroInput, '::placeholder');
          const attachments = caseOf(page, 'attachments');
          const followUp = attachments.getByRole('textbox', {
            name: '给 Rice 的消息',
          });
          expect(await followUp.getAttribute('placeholder')).toBe(
            '继续和 Rice 工作…',
          );
          await readable(followUp, '::placeholder');

          // D12: failed uploads say 重试 on an opaque chip with a red ring.
          const retries = attachments.getByRole('button', {
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
          const uploading = attachments.getByText('上传中', { exact: true });
          expect.soft((await readable(uploading)).fill[3]).toBe(1);

          // D09, D10 and the question's own words.
          const form = caseOf(page, 'question');
          await readable(form.getByText('确认定时任务', { exact: true }));
          const custom = form.getByRole('textbox', { name: '自定义答案' });
          expect(await custom.getAttribute('placeholder')).toBe(
            '或者输入其他答案',
          );
          await readable(custom, '::placeholder');
          const options = form.getByRole('radio');
          expect(await options.count()).toBe(2);
          for (const option of await options.all())
            await readable(option.locator('i'));
          await readable(form.getByText('在本对话里提醒你核对页面'));
          await options.first().click();
          expect(await options.first().getAttribute('aria-checked')).toBe(
            'true',
          );
          for (const option of await options.all())
            await readable(option.locator('i'));

          // L07: the answer receipt, on its tinted header.
          const receipt = caseOf(page, 'receipt').getByRole('article', {
            name: '用户确认结果',
          });
          const quiet = receipt.locator('header span, header time, dt');
          expect(await quiet.count()).toBeGreaterThanOrEqual(3);
          for (const node of await quiet.all()) await readable(node);
          await readable(receipt.getByText('已跳过', { exact: true }));

          // L02: the empty-chat introduction and the work process.
          await readable(hero.locator('p'));
          const process = caseOf(page, 'process');
          await readable(process.getByLabel('本轮运行时间'));
          for (const words of [
            '分析任务与处理步骤',
            '搜索资料：本周销售数据',
            '提问已挂起，等待你的回答',
            '等待处理',
          ])
            await readable(process.getByText(words, { exact: true }));

          // A follow-up the running task did not take.
          await readable(
            caseOf(page, 'steering').getByText('补充未被采纳', { exact: true }),
          );
          // L04: links in a reply.
          await readable(
            caseOf(page, 'reply').getByRole('link', { name: '项目说明' }),
          );

          expect
            .soft(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth >
                  document.documentElement.clientWidth,
              ),
            )
            .toBe(false);
        } finally {
          await page.close();
        }
      });
});
