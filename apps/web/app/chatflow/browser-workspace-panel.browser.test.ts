/** Real Chrome, synthetic HTTP only. No DB, auth, Dev, device or model. */
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

// Words an ordinary employee must not meet outside the technical section.
const engineering = [
  '{',
  'Run',
  '回执',
  '重放',
  '核实',
  '当前授权不可用',
  '允许站点',
  'Bridge',
  'Chromium',
  'waiting_user',
  'navigate',
  'e2 ·',
];

suite('browser panel for ordinary employees', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/browser-workspace-page.tsx'],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/browser-workspace-page.css"><div id="root"></div><script type="module" src="/browser-workspace-page.js"></script>',
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
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function open(width: number, theme: 'light' | 'dark') {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.getByRole('heading', { name: '本地浏览器' }).waitFor();
    return page;
  }
  const visibleText = (page: Page) =>
    page.locator('section[aria-label="浏览器"]').innerText();

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`shows a plain summary at ${width}px in the ${theme} theme`, async () => {
        const page = await open(width, theme);
        try {
          const text = await visibleText(page);
          for (const word of engineering) expect(text).not.toContain(word);
          expect(text).toContain('云端浏览器');
          expect(text).toContain('浏览器已关闭');
          expect(text).toContain('打开 example.com');
          expect(text).toContain('已完成');
          expect(text).toContain('由你操作中');
          expect(text).toContain('当前页面：报名表');
          expect(text).toContain('点击页面上的按钮或链接');
          expect(text).toContain('等你确认');
          // A closed browser keeps its history but offers no controls.
          await expect(
            page.getByRole('button', { name: '我来操作' }).count(),
          ).resolves.toBe(1);
          const layout = await page.evaluate(() => ({
            overflow:
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
            card: getComputedStyle(
              document.querySelector('section[aria-label="浏览器"] article')!,
            ).backgroundColor,
            text: getComputedStyle(
              document.querySelector('section[aria-label="浏览器"]')!,
            ).color,
          }));
          expect(layout.overflow).toBe(false);
          expect(layout.card).toBe(
            theme === 'dark' ? 'rgb(35, 35, 36)' : 'rgb(255, 255, 255)',
          );
          expect(layout.text).toBe(
            theme === 'dark' ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
          );
        } finally {
          await page.close();
        }
      });

  it('keeps raw actions and receipts in the collapsed technical section', async () => {
    const page = await open(1440, 'light');
    try {
      const details = page.getByRole('button', { name: '技术详情' }).first();
      expect(await visibleText(page)).not.toContain('"navigate"');
      await details.click();
      const text = await visibleText(page);
      expect(text).toContain('"navigate"');
      expect(text).toContain('"receipt"');
      expect(text).toContain('公开的 HTTPS 网站');
      expect(text).toContain('授权已失效');
    } finally {
      await page.close();
    }
  });

  it('lets the employee retry an approval that failed, resending the same answer', async () => {
    const page = await open(1440, 'light');
    try {
      await page.evaluate(() => {
        window.failNextApproval = true;
      });
      await page.getByRole('button', { name: '允许这一步' }).click();
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').innerText()).toContain(
        '操作结果待确认',
      );
      // Before the fix the buttons vanished until a full page reload.
      await page.getByRole('button', { name: '允许这一步' }).click();
      await expect
        .poll(() => page.evaluate(() => window.approvalPosts.length))
        .toBe(2);
      const [first, second] = (await page.evaluate(
        () => window.approvalPosts,
      )) as { responseId: string; decision: string }[];
      expect(second!.responseId).toBe(first!.responseId);
      expect(second!.decision).toBe('approved');
    } finally {
      await page.close();
    }
  });
});
