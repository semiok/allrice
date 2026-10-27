/** Real Chrome, synthetic HTTP only. No DB, auth, Dev, device or model. */
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

type View = 'page' | 'cards' | 'employee' | 'commands';
type Reading = { text: string; ratio: number; need: number; dark: boolean };

// MET-214 dark audit D01, D02 and S01: the experience page, its cards in
// employee details and the workbench, and the local command card.
suite('experience and local command cards read in both themes', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/experience-command-theme-page.tsx'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: {
        'process.env.NODE_ENV': '"development"',
        'process.env': '{}',
      },
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
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/experience-command-theme-page.css"><body><div id="root"></div><script src="/experience-command-theme-page.js"></script></body>',
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
  });
  // The command card polls while an operation runs; drop open sockets.
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  const openDetails = (page: Page, root: string) =>
    page
      .locator(root)
      .first()
      .evaluate((node) =>
        node.querySelectorAll('details').forEach((d) => (d.open = true)),
      );
  /** Shows the sources of the adopted experience, as a person would. */
  async function showSources(page: Page, root: string) {
    await page
      .locator(root)
      .getByRole('button', { name: '查看来源与版本' })
      .click();
    await page
      .locator(root)
      .getByText('以下是形成这条经验的原始反馈，仅本人可见。')
      .waitFor();
  }
  const read = (target: Locator) =>
    target.evaluate(readContrast) as Promise<Reading[]>;
  const ratio = async (target: Locator) => (await read(target))[0]!.ratio;

  /** Renders a view and returns the element whose text must all pass. */
  async function open(view: View, width: number, theme: 'light' | 'dark') {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?view=${view}&theme=${theme}`);
    let root = 'main';
    if (view === 'page') {
      await page.getByText('暂无反馈与历史记录。').waitFor();
      await page.getByText('读取或撤回未完成，请稍后重试。').waitFor();
      await page.getByText('整理频率', { exact: true }).waitFor();
      await showSources(page, root);
    } else if (view === 'cards') {
      await page.getByText('下次整理', { exact: true }).waitFor();
      await showSources(page, root);
    } else if (view === 'employee') {
      await page.getByRole('tab', { name: '经验积累' }).click();
      root = '[role="tabpanel"] > section';
      await page.locator(root).getByText('整理频率').waitFor();
      await showSources(page, root);
    } else {
      await expect.poll(() => page.locator('main article').count()).toBe(4);
    }
    await openDetails(page, root);
    return { page, root };
  }
  const overflow = (page: Page) =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
  /** Keyboard focus ring against the surface around the control. */
  async function ring(page: Page, control: Locator) {
    await page.keyboard.press('Tab');
    await control.focus();
    const drawn = await control.evaluate((node) => {
      const style = getComputedStyle(node);
      if (
        !node.matches(':focus-visible') ||
        style.outlineStyle === 'none' ||
        parseFloat(style.outlineWidth) < 2
      )
        return false;
      // The ring sits on the parent: measure its color as text there.
      const probe = document.createElement('span');
      probe.id = 'ring-probe';
      probe.textContent = '_';
      probe.style.color = style.outlineColor;
      node.parentElement!.append(probe);
      return true;
    });
    if (!drawn) return 0;
    const probe = page.locator('#ring-probe');
    try {
      return await ratio(probe);
    } finally {
      await probe.evaluate((node) => node.remove());
    }
  }

  const probes: Record<View, [string, (page: Page) => Locator][]> = {
    page: [
      ['title', (p) => p.getByRole('heading', { name: '经验积累' }).first()],
      ['intro', (p) => p.getByText('根据有依据的工作反馈').first()],
      ['label', (p) => p.getByText('整理频率', { exact: true })],
      ['empty', (p) => p.getByText('暂无反馈与历史记录。')],
      ['error', (p) => p.getByText('读取或撤回未完成，请稍后重试。')],
      ['button', (p) => p.getByRole('button', { name: '重新读取' }).first()],
      ['source', (p) => p.locator('blockquote')],
    ],
    cards: [
      ['label', (p) => p.getByText('整理频率', { exact: true })],
      ['button', (p) => p.getByRole('button', { name: '收起来源与版本' })],
      ['source', (p) => p.locator('blockquote')],
    ],
    employee: [
      ['label', (p) => p.getByText('整理频率', { exact: true })],
      ['button', (p) => p.getByRole('button', { name: '重新读取' })],
    ],
    commands: [
      ['title', (p) => p.getByText('本地命令 · 操作授权').first()],
      ['note', (p) => p.getByText('此授权仅适用于上面显示的操作')],
      ['command', (p) => p.getByLabel('待执行命令').first()],
      ['stderr', (p) => p.getByText('第 12 行缺少金额，已跳过')],
      ['button', (p) => p.getByRole('button', { name: '批准这一次执行' })],
    ],
  };
  const focusTarget: Record<View, (page: Page) => Locator> = {
    page: (p) => p.getByRole('button', { name: '重新读取' }).first(),
    cards: (p) => p.getByRole('button', { name: '收起来源与版本' }),
    employee: (p) => p.getByRole('button', { name: '重新读取' }),
    commands: (p) => p.getByRole('button', { name: '批准这一次执行' }),
  };

  for (const view of ['page', 'cards', 'employee', 'commands'] as const)
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark'] as const)
        it(`${view} reads at ${width}px in the ${theme} theme`, async () => {
          const { page, root } = await open(view, width, theme);
          try {
            const readings = await read(page.locator(root).first());
            expect(readings.length).toBeGreaterThan(10);
            expect(
              readings
                .filter((r) => r.ratio < r.need)
                .map((r) => `${r.text} ${r.ratio.toFixed(2)}`),
            ).toEqual([]);
            // No surface stays in the other theme: a light card in the dark
            // theme reads fine and still breaks the page.
            expect(
              readings
                .filter((r) => r.dark !== (theme === 'dark'))
                .map((r) => r.text),
            ).toEqual([]);
            expect(await overflow(page)).toBe(false);
            const measured: Record<string, number> = {};
            for (const [name, locate] of probes[view])
              measured[name] = await ratio(locate(page));
            measured.ring = await ring(page, focusTarget[view](page));
            expect(measured.ring).toBeGreaterThanOrEqual(3);
            console.info(
              `[contrast] ${view} ${width} ${theme} ${JSON.stringify(measured)}`,
            );
          } finally {
            await page.close();
          }
        });
});

/** Every element under root (root included) with its own visible text, its
 * contrast against the composited background (needs 4.5, or 3 for large
 * text), and whether that background is the dark one of the pair.
 * Self-contained: it runs in the page. */
function readContrast(root: Element) {
  const parse = (value: string) => {
    // Chrome serializes some color-mix() results in Oklab.
    const oklab = value.match(
      /oklab\(([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([\d.]+))?/,
    );
    if (oklab) {
      const [L, a, b] = oklab.slice(1, 4).map(Number) as [
        number,
        number,
        number,
      ];
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
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
        oklab[4] === undefined ? 1 : Number(oklab[4]),
      ];
    }
    if (!/^(rgba?|color\(srgb)/.test(value))
      throw Error(`unparsed color ${value}`);
    const srgb = value.match(
      /color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([\d.]+))?/,
    );
    if (srgb)
      return [
        Number(srgb[1]) * 255,
        Number(srgb[2]) * 255,
        Number(srgb[3]) * 255,
        srgb[4] === undefined ? 1 : Number(srgb[4]),
      ];
    const [r, g, b, a] = value.match(/[\d.]+/g)!.map(Number);
    return [r!, g!, b!, a ?? 1];
  };
  const over = (top: number[], base: number[]) =>
    [0, 1, 2].map((i) => top[i]! * top[3]! + base[i]! * (1 - top[3]!));
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const readings: {
    text: string;
    ratio: number;
    need: number;
    dark: boolean;
  }[] = [];
  for (const node of [root, ...root.querySelectorAll('*')]) {
    const own = [...node.childNodes].some(
      (child) => child.nodeType === 3 && child.textContent!.trim(),
    );
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (
      !own ||
      !box.width ||
      !box.height ||
      style.visibility !== 'visible' ||
      node.closest(':disabled')
    )
      continue;
    const layers: number[][] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const fill = parse(getComputedStyle(at).backgroundColor);
      if (fill[3]) layers.push(fill);
      if (fill[3] === 1) break;
    }
    let ground = [255, 255, 255];
    for (const layer of layers.reverse()) ground = over(layer, ground);
    const ink = over(parse(style.color), ground);
    const [x, y] = [luminance(ink), luminance(ground)].sort((m, n) => n - m);
    const size = parseFloat(style.fontSize);
    readings.push({
      text: node.textContent!.trim().slice(0, 20),
      ratio: (x! + 0.05) / (y! + 0.05),
      need:
        size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
          ? 3
          : 4.5,
      dark: luminance(ground) < luminance(ink),
    });
  }
  return readings;
}
