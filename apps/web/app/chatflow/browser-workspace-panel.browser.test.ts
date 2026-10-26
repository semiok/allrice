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
      if (path === '/api/v1/files/99999999-0000-4000-8000-000000000001') {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="green"/></svg>',
        );
      } else if (path.startsWith('/api/v1/files/')) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end('synthetic download');
      } else if (asset) {
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
      const image = page.getByRole('img', {
        name: '当前页面截图（已隐去敏感内容）',
      });
      await expect
        .poll(() =>
          image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBe(120);
      expect(await page.evaluate(() => window.signPosts)).toEqual([
        '99999999-0000-4000-8000-000000000001',
      ]);
      await page.getByRole('button', { name: '关闭截图' }).click();
      expect(await image.count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('offers a refresh when a step result is unconfirmed', async () => {
    const page = await open(390, 'light');
    try {
      const closed = page
        .locator('article')
        .filter({ hasText: '飞书智能伙伴' });
      expect(await closed.innerText()).toContain('有一步的结果还没有确认');
      const before = await page.evaluate(() => window.loads);
      const writes = await page.evaluate(() => window.browserPosts.length);
      await closed.getByRole('button', { name: '刷新状态' }).click();
      // It reads the state again and writes nothing.
      await expect
        .poll(() => page.evaluate(() => window.loads))
        .toBeGreaterThan(before);
      expect(await page.evaluate(() => window.browserPosts.length)).toBe(
        writes,
      );
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
        window.approvalMode = 'expired';
      });
      await page.getByRole('button', { name: '拒绝' }).click();
      const alert = page.getByRole('alert');
      await expect
        .poll(() => alert.innerText())
        .toContain('这一步的答复没有被接受，可能已经过期');
      expect(await alert.innerText()).not.toContain('再点一次');
      await page.evaluate(() => {
        window.failLoad = true;
      });
      await alert.getByRole('button', { name: '刷新状态' }).click();
      await expect
        .poll(() => alert.innerText())
        .toBe('暂时读不到浏览器状态，请检查网络后刷新。\n刷新状态');
    } finally {
      await page.close();
    }
  });
  const card = (page: Page, title: string) =>
    page.locator('article').filter({ hasText: title });

  for (const narrow of [false, true])
    it(`sends exactly what the employee does by hand${narrow ? ' in the 253px phone column' : ''}`, async () => {
      const page = await open(narrow ? 390 : 1440, 'dark');
      try {
        // The real 390px transcript leaves 253px after sidebar and gutters.
        if (narrow)
          await page.locator('main').evaluate((el) => {
            el.style.width = '253px';
            el.style.padding = '0';
          });
        const human = card(page, '下载中心');
        await human.getByRole('button', { name: '手动操作页面' }).click();
        const field = (label: string) =>
          human.locator('form').filter({ hasText: label });
        await field('搜索').locator('input').fill('季度报告');
        await field('搜索').getByRole('button', { name: '填写' }).click();
        await expect
          .poll(() => page.evaluate(() => window.browserPosts.length))
          .toBe(1);
        await field('密码').locator('input').fill('synthetic-secret');
        await field('密码')
          .getByRole('button', { name: '安全输入（不发给 Rice）' })
          .click();
        await expect
          .poll(() => page.evaluate(() => window.browserPosts.length))
          .toBe(3);
        await field('附件')
          .locator('input')
          .setInputFiles({
            name: 'fixture.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('synthetic upload'),
          });
        await field('附件')
          .getByRole('button', { name: '上传到这个网站（需确认）' })
          .click();
        await expect
          .poll(() => page.evaluate(() => window.browserPosts.length))
          .toBe(4);
        await field('季度报告.pdf')
          .getByRole('button', { name: '保存为成果' })
          .click();
        await expect
          .poll(() => page.evaluate(() => window.browserPosts.length))
          .toBe(5);
        const posts = await page.evaluate(() => window.browserPosts);
        expect(
          posts.map((post) =>
            post.kind === 'act'
              ? (post.command as { action: unknown }).action
              : post,
          ),
        ).toEqual([
          { type: 'fill', elementId: 'e3', value: '季度报告' },
          expect.objectContaining({
            kind: 'input',
            elementId: 'e5',
            value: 'synthetic-secret',
            fence: 3,
          }),
          {
            type: 'sensitive_fill',
            elementId: 'e5',
            inputId: '77777777-7777-4777-8777-777777777777',
          },
          {
            type: 'upload',
            elementId: 'e6',
            objectId: '77777777-7777-4777-8777-777777777777',
            checksum: `sha256:${'c'.repeat(64)}`,
            fileName: 'fixture.txt',
          },
          { type: 'download', elementId: 'e4' },
        ]);
        expect(await page.evaluate(() => window.filePosts)).toEqual([
          expect.objectContaining({
            mediaType: 'text/plain',
            contentBase64: Buffer.from('synthetic upload').toString('base64'),
            visibility: 'private',
          }),
        ]);
        // Typed secrets never stay on screen.
        expect(await visibleText(page)).not.toContain('synthetic-secret');
        const download = page.waitForEvent('download');
        await human.getByRole('button', { name: '保存下载的文件' }).click();
        const file = await download;
        const bytes: Buffer[] = [];
        for await (const chunk of (await file.createReadStream())!)
          bytes.push(Buffer.from(chunk));
        expect(Buffer.concat(bytes).toString()).toBe('synthetic download');
        const box = await panel(page).evaluate((el) => ({
          width: el.clientWidth,
          content: el.scrollWidth,
        }));
        expect(box.content).toBeLessThanOrEqual(box.width);
      } finally {
        await page.close();
      }
    });

  it('sends fenced control requests from the buttons', async () => {
    const page = await open(390, 'light');
    try {
      await card(page, '提交订单')
        .getByRole('button', { name: '我来操作' })
        .click();
      const human = card(page, '下载中心');
      for (const name of ['交还 Rice', '暂停', '关闭浏览器']) {
        const count = await page.evaluate(() => window.browserPosts.length);
        await human.getByRole('button', { name }).click();
        await expect
          .poll(() => page.evaluate(() => window.browserPosts.length))
          .toBe(count + 1);
      }
      const posts = (await page.evaluate(() => window.browserPosts)) as {
        kind: string;
        id: string;
        request: { control: string; expectedFence: number };
      }[];
      expect(
        posts.map((post) => [
          post.kind,
          post.id.slice(0, 8),
          post.request.control,
          post.request.expectedFence,
        ]),
      ).toEqual([
        ['control', '22222222', 'human', 2],
        ['control', '33333333', 'agent', 3],
        ['control', '33333333', 'paused', 3],
        ['control', '33333333', 'closed', 3],
      ]);
    } finally {
      await page.close();
    }
  });
});
