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
    await page.getByRole('heading', { name: '本地项目预览' }).waitFor();
    return page;
  }
  const panel = (page: Page) => page.locator('section[aria-label="浏览器"]');
  const visibleText = (page: Page) => panel(page).innerText();
  async function expand(page: Page, title: string) {
    for (const row of await page.getByRole('button', { name: title }).all())
      await row.click();
  }

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`shows a plain summary at ${width}px in the ${theme} theme`, async () => {
        const page = await open(width, theme);
        try {
          await expand(page, '页面文字');
          await expand(page, '手动操作页面');
          // Flex rows render as separate lines; read them as sentences.
          const text = (await visibleText(page)).replace(/\s*\n\s*/g, '');
          for (const word of engineering) expect(text).not.toContain(word);
          expect(text).not.toContain('preview.allrice.invalid');
          for (const line of [
            '浏览器已关闭',
            '当前页面：飞书智能伙伴',
            '飞书智能伙伴可以帮你整理会议纪要。',
            '打开 www.feishu.cn/product/ai',
            '删除 www.feishu.cn/account 上的内容',
            '未完成，可以让 Rice 再试一次',
            'Rice 正在使用浏览器',
            '点击「提交订单」按钮',
            '等你确认',
            '在「姓名」输入框填写「张三」',
            '你已拒绝，没有执行',
            '由你操作中',
            '打开 你的项目预览',
          ])
            expect(text).toContain(line);
          // A closed browser keeps its history but offers no controls; the
          // screenshot of its last page stays available.
          expect(
            await page.getByRole('button', { name: '我来操作' }).count(),
          ).toBe(3);
          expect(
            await page.getByRole('button', { name: '查看页面截图' }).count(),
          ).toBe(1);
          // Exactly the pending click can be answered, by name.
          const allow = page.getByRole('button', { name: '允许这一步' });
          expect(await allow.count()).toBe(1);
          expect(await allow.getAttribute('aria-describedby')).toBeTruthy();
          const layout = await page.evaluate(() => {
            const root = document.querySelector(
              'section[aria-label="浏览器"]',
            )!;
            const title = [...root.querySelectorAll('*')].find(
              (node) =>
                node.childElementCount === 0 && node.textContent === '技术详情',
            )!;
            return {
              overflow:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
              card: getComputedStyle(root.querySelector('article')!)
                .backgroundColor,
              text: getComputedStyle(root).color,
              disclosure: getComputedStyle(title).color,
            };
          });
          expect(layout).toEqual(
            theme === 'dark'
              ? {
                  overflow: false,
                  card: 'rgb(35, 35, 36)',
                  text: 'rgb(249, 250, 251)',
                  disclosure: 'rgb(207, 211, 214)',
                }
              : {
                  overflow: false,
                  card: 'rgb(255, 255, 255)',
                  text: 'rgb(15, 17, 21)',
                  disclosure: 'rgb(97, 102, 107)',
                },
          );
          // Technical detail, once opened, must not widen the page either.
          await expand(page, '技术详情');
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            ),
          ).toBe(false);
        } finally {
          await page.close();
        }
      });

  it('keeps raw actions and receipts in the collapsed technical section', async () => {
    const page = await open(1440, 'light');
    try {
      expect(await visibleText(page)).not.toContain('"navigate"');
      await page.getByRole('button', { name: '技术详情' }).first().click();
      const text = await visibleText(page);
      expect(text).toContain('"navigate"');
      expect(text).toContain('"receipt"');
      expect(text).toContain('公开的 HTTPS 网站');
      expect(text).toContain('授权已失效');
    } finally {
      await page.close();
    }
  });

  it('keeps the last screenshot of a closed browser viewable', async () => {
    const page = await open(1440, 'light');
    try {
      await page.getByRole('button', { name: '查看页面截图' }).click();
      await expect
        .poll(() => page.evaluate(() => window.signPosts))
        .toEqual(['99999999-0000-4000-8000-000000000001']);
    } finally {
      await page.close();
    }
  });

  it('after a lost answer only resends the same answer, in plain words', async () => {
    const page = await open(1440, 'light');
    try {
      await page.evaluate(() => {
        window.approvalMode = 'network';
      });
      await page.getByRole('button', { name: '允许这一步' }).click();
      const alert = page.getByRole('alert');
      await alert.waitFor();
      expect(await alert.innerText()).toContain('答复可能没有送达');
      expect(await alert.innerText()).not.toContain('Failed to fetch');
      // The other answer is withheld: it would conflict if the first landed.
      expect(await page.getByRole('button', { name: '拒绝' }).count()).toBe(0);
      await page.getByRole('button', { name: '再次发送「允许」' }).click();
      await expect
        .poll(() => page.evaluate(() => window.approvalPosts.length))
        .toBe(2);
      const [first, second] = await page.evaluate(() => window.approvalPosts);
      expect(second!.responseId).toBe(first!.responseId);
      expect(second!.decision).toBe('approved');
    } finally {
      await page.close();
    }
  });

  it('explains an expired approval and an unreadable state', async () => {
    const page = await open(390, 'light');
    try {
      await page.evaluate(() => {
        window.approvalMode = 'stale';
      });
      await page.getByRole('button', { name: '拒绝' }).click();
      const alert = page.getByRole('alert');
      await expect
        .poll(() => alert.innerText())
        .toContain('这一步已过期，没有执行');
      await page.evaluate(() => {
        window.failLoad = true;
      });
      await page.getByRole('button', { name: '刷新状态' }).click();
      await expect
        .poll(() => alert.innerText())
        .toBe('暂时读不到浏览器状态，请检查网络后刷新。\n刷新状态');
    } finally {
      await page.close();
    }
  });
});
