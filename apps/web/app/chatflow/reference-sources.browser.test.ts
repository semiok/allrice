/** Real transcript and native Dock, synthetic history only; no model or DB. */
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('R4 conversation source attribution', () => {
  let browser: Browser, server: Server, origin: string, evidence: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/reference-sources-page.tsx'],
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
      result.outputFiles.map((f: { path: string; contents: Uint8Array }) => [
        f.path.slice(f.path.lastIndexOf('/')),
        f.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, origin).pathname;
      const asset = assets.get(path);
      if (path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            items: [],
            operations: [],
            tasks: [],
            nextCursor: null,
          }),
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
          '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/reference-sources-page.css"><div id="root"></div><script type="module" src="/reference-sources-page.js"></script>',
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
    evidence = await mkdtemp(join(tmpdir(), 'r4c-source-browser-'));
    console.log(`R4C_SCREENSHOTS=${evidence}`);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark']) {
      it(`distinguishes parent ZIP and members without new reads at ${width}px ${theme}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: width === 390 ? 844 : 1000 },
        });
        const unexpected: string[] = [],
          errors: string[] = [];
        page.on('request', (r) => {
          if (/\/api\/v1\/(references|files)\//.test(r.url()))
            unexpected.push(r.url());
        });
        page.on('pageerror', (e) => errors.push(e.message));
        try {
          await page.goto(`${origin}/?theme=${theme}`);
          const sources = page.locator('[aria-label="参考资料来源"]');
          await sources
            .getByRole('button', { name: '[R1] 秋冬新品资料.zip', exact: true })
            .waitFor();
          expect(await sources.textContent()).not.toMatch(/可看图|可看目录/);
          for (const [label, kind, path] of [
            ['[R1] 秋冬新品资料.zip', 'ZIP 目录', ''],
            ['[R2] 文案/上新说明.md', 'ZIP 内文件 · 正文', '文案/上新说明.md'],
            ['[R3] 产品图/主图.png', 'ZIP 内文件 · 图片', '产品图/主图.png'],
            ['[R4] 秋冬新品主图.png', '图片资料', ''],
          ] as const) {
            await sources
              .getByRole('button', { name: label, exact: true })
              .click();
            const panel = page.getByRole('region', {
              name: '引用来源',
              exact: true,
            });
            await panel.waitFor();
            expect(await panel.textContent()).toContain(kind);
            if (path) expect(await panel.textContent()).toContain(path);
            if (label.startsWith('[R1]'))
              expect(await panel.textContent()).toContain(
                '目录第 1–4 项，共 4 项',
              );
            if (label.startsWith('[R2]'))
              expect(await panel.textContent()).toContain('正文第 1–86 字符');
            if (label.startsWith('[R3]'))
              expect(await panel.textContent()).toContain(
                '不代表包内其他文件已读取',
              );
            if (label.startsWith('[R4]'))
              expect(await panel.textContent()).not.toContain(
                '秋冬新品资料.zip',
              );
            expect(await panel.locator('img,a[download]').count()).toBe(0);
            expect(
              await panel.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
            ).toBe(true);
            await page.screenshot({
              path: join(
                evidence,
                `${width}-${theme}-${label.slice(1, 3)}.png`,
              ),
            });
            await page
              .getByRole('button', { name: '关闭工作台', exact: true })
              .click();
          }
          await page.getByRole('button', { name: '模拟后来失权' }).click();
          expect(await sources.getByRole('button').count()).toBe(4);
          await sources
            .getByRole('button', { name: '[R1] 秋冬新品资料.zip', exact: true })
            .click();
          await page
            .getByRole('region', { name: '引用来源', exact: true })
            .waitFor();
          await page
            .getByRole('button', { name: '关闭工作台', exact: true })
            .click();
          await page
            .getByRole('textbox', { name: '给 Rice 发消息' })
            .fill('请继续讨论刚才的结论。');
          await page.getByRole('button', { name: '发送', exact: true }).click();
          await page.getByText('已发送后续问题', { exact: true }).waitFor();
          expect(unexpected).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  it('keeps complete long member paths and renders an empty ZIP as a directory', async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    try {
      await page.goto(`${origin}/?long&empty`);
      const source = page.locator('[aria-label="参考资料来源"]');
      const path = '产品资料/'.repeat(40) + '上新说明.md';
      await source
        .getByRole('button', { name: `[R2] ${path}`, exact: true })
        .click();
      const panel = page.getByRole('region', { name: '引用来源', exact: true });
      await panel.waitFor();
      expect(await panel.textContent()).toContain(path);
      expect(
        await panel.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
      ).toBe(true);
      await page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await source
        .getByRole('button', { name: '[R1] 秋冬新品资料.zip', exact: true })
        .click();
      expect(await panel.textContent()).toContain('空目录，共 0 项');
    } finally {
      await page.close();
    }
  }, 30_000);
  it('retains the existing text citation action', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?legacy`);
      await page
        .getByRole('button', { name: '[R5] 品牌语气规范', exact: true })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.dataset.legacyOpened,
        ),
      ).toBe('true');
    } finally {
      await page.close();
    }
  }, 30_000);
});
