import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import { nativeExcelAssetResponse } from '../../lib/chatflow/native-document-asset';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const encode = (s: string | Buffer) => Buffer.from(s).toString('base64');
function pdf() {
  const text = 'BT /F1 16 Tf 30 350 Td (Native PDF selectable text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n ')
    .join(
      '\n',
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { kind: 'pdf', base64: encode(result) };
}
suite('DSH native document previews', () => {
  let browser: Browser, server: Server, origin: string;
  const excelTransfers: { encoding: string | null; bytes: number }[] = [];
  const require = createRequire(import.meta.url);
  beforeAll(async () => {
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['apps/web/test/native-document-page.tsx'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/unused-preview',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const js = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.js'),
    ).contents;
    const css = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.css'),
    ).contents;
    const chunks = await Promise.all(
      ['pdf', 'excel'].map((name) =>
        readFile(
          `apps/web/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.${name}.js`,
        ),
      ),
    );
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (path === '/api/dsh-ui/excel') {
        void nativeExcelAssetResponse(
          new Request('http://fixture' + request.url, {
            headers: {
              'accept-encoding': String(
                request.headers['accept-encoding'] ?? '',
              ),
            },
          }),
        )
          .then(async (result) => {
            response.writeHead(
              result.status,
              Object.fromEntries(result.headers),
            );
            const bytes = Buffer.from(await result.arrayBuffer());
            excelTransfers.push({
              encoding: result.headers.get('content-encoding'),
              bytes: bytes.length,
            });
            response.end(bytes);
          })
          .catch(() => {
            response.statusCode = 500;
            response.end();
          });
        return;
      }
      response.setHeader(
        'content-type',
        path.endsWith('.css')
          ? 'text/css'
          : path === '/app.js' || path.startsWith('/api/dsh-ui/')
            ? 'text/javascript'
            : 'text/html',
      );
      response.end(
        path === '/app.js'
          ? js
          : path === '/app.css'
            ? css
            : path === '/api/dsh-ui/pdf'
              ? chunks[0]
              : path === '/api/dsh-ui/excel'
                ? chunks[1]
                : '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('missing listener');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
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
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });
  async function mount(items: unknown[], width = 1200) {
    const page = await browser.newPage({ viewport: { width, height: 820 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'setPreviewItems') === 'function',
    );
    await page.evaluate(
      (values) => Reflect.get(window, 'setPreviewItems')(values),
      items,
    );
    return { page, errors };
  }
  async function loadedImage(page: Page) {
    await expect
      .poll(
        () =>
          page
            .locator('img')
            .evaluateAll(
              (imgs) =>
                imgs.length > 0 &&
                imgs.every(
                  (img) =>
                    (img as HTMLImageElement).complete &&
                    (img as HTMLImageElement).naturalWidth > 0,
                ),
            ),
        { timeout: 15_000 },
      )
      .toBe(true);
  }
  it('keeps missing fonts in the native toolbar notice without blocking the PDF', async () => {
    const { page, errors } = await mount(
      [
        {
          name: '中文文档.docx',
          preview: {
            ...pdf(),
            converted: true,
            missingFonts: ['Microsoft YaHei'],
          },
        },
      ],
      390,
    );
    try {
      await page
        .getByText('Native PDF selectable text', { exact: true })
        .waitFor({ timeout: 30000 });
      expect(await page.getByRole('dialog').count()).toBe(0);
      const warning = page.getByRole('button', {
        name: '缺失 1 种字体，点击查看',
      });
      expect(
        (await warning.locator('svg').boundingBox())!.width,
      ).toBeGreaterThanOrEqual(14);
      await warning.click();
      const dialog = page.getByRole('dialog', { name: '缺失的字体' });
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain('文字和排版可能与原文档不同');
      expect(await dialog.innerText()).toContain('Microsoft YaHei');
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      expect(await dialog.count()).toBe(0);
      expect(await warning.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('opens native Excel and PDF concurrently without cross-registering chunks', async () => {
    const ExcelJS = createRequire(resolve('apps/worker/package.json'))(
      'exceljs',
    );
    const book = new ExcelJS.Workbook();
    book.addWorksheet('销售明细').addRows([
      ['名称', '金额'],
      ['验收数据', 123],
    ]);
    book.addWorksheet('汇总').addRows([['合计', 123]]);
    const { page, errors } = await mount([
      { name: 'report.pdf', preview: pdf() },
      {
        name: 'report.xlsx',
        preview: {
          kind: 'spreadsheet',
          format: 'xlsx',
          base64: encode(Buffer.from(await book.xlsx.writeBuffer())),
        },
      },
    ]);
    try {
      await page
        .getByText('Native PDF selectable text', { exact: true })
        .waitFor({ timeout: 30_000 });
      await page
        .getByText('销售明细', { exact: true })
        .waitFor({ timeout: 30_000 });
      await page.getByText('汇总', { exact: true }).click();
      expect(await page.locator('[data-excel-preview]').count()).toBe(1);
      expect(excelTransfers.at(-1)?.encoding).toBe('br');
      expect(excelTransfers.at(-1)?.bytes).toBeLessThan(2_000_000);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
  it.each(['gif', 'svg'])(
    'previews %s in the native image context on mobile',
    async (format) => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" onload="parent.previewEscaped=true"><rect width="240" height="120" fill="blue"/><script>parent.previewEscaped=true</script></svg>';
      const { page, errors } = await mount(
        [
          {
            name: `image.${format}`,
            preview: {
              kind: 'image',
              mediaType: format === 'svg' ? 'image/svg+xml' : 'image/gif',
              base64:
                format === 'svg'
                  ? encode(svg)
                  : 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
            },
          },
        ],
        390,
      );
      try {
        await loadedImage(page);
        expect(
          await page.evaluate(() => Reflect.get(window, 'previewEscaped')),
        ).toBeUndefined();
        expect(await page.locator('[data-document-zoom-mode]').count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
  it('uses native static HTML sanitization and an opaque iframe for interaction', async () => {
    const html =
      "<h1>原生网页预览</h1><button onclick=\"document.querySelector('h1').textContent='交互成功'\">点击测试</button><script>try { parent.previewEscaped=true } catch {}</script>";
    const { page, errors } = await mount([
      { name: 'static.html', preview: { kind: 'html', base64: encode(html) } },
      {
        name: 'interactive.html',
        preview: { kind: 'html', base64: encode(html) },
        interactive: true,
      },
    ]);
    try {
      await page
        .frameLocator('section[aria-label="static.html"] iframe')
        .getByRole('heading')
        .waitFor();
      await page
        .frameLocator('section[aria-label="interactive.html"] iframe')
        .getByRole('button')
        .click();
      await page
        .frameLocator('section[aria-label="interactive.html"] iframe')
        .getByRole('heading', { name: '交互成功' })
        .waitFor();
      expect(
        await page
          .frameLocator('section[aria-label="static.html"] iframe')
          .locator('script')
          .count(),
      ).toBe(0);
      expect(
        await page.evaluate(() => Reflect.get(window, 'previewEscaped')),
      ).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
  it('loads subsequent text pages under StrictMode without duplicating or dropping lines', async () => {
    const { page, errors } = await mount([
      {
        name: 'large.txt',
        pageUrl: '/preview?workspaceId=fixture',
        preview: {
          kind: 'text',
          text: 'line 1\nline 2',
          mediaType: 'text/plain',
          offset: 1,
          lines: 2,
          eof: false,
        },
      },
    ]);
    try {
      await page.route('**/preview?**', async (route) => {
        const query = new URL(route.request().url()).searchParams;
        expect(query.get('offset')).toBe('3');
        await route.fulfill({
          json: {
            kind: 'text',
            text: 'line 3\nline 4',
            mediaType: 'text/plain',
            offset: 3,
            lines: 2,
            eof: true,
          },
        });
      });
      await page.getByRole('button', { name: '加载更多内容' }).click();
      await page.getByText('line 4', { exact: false }).waitFor();
      expect(await page.locator('code').textContent()).toContain(
        'line 1\nline 2\nline 3\nline 4',
      );
      expect(
        await page.getByRole('button', { name: '加载更多内容' }).count(),
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
  it.each(['csv', 'tsv'])(
    'opens quoted %s data as a spreadsheet',
    async (format) => {
      const separator = format === 'csv' ? ',' : '\t';
      const { page, errors } = await mount([
        {
          name: `data.${format}`,
          preview: {
            kind: 'spreadsheet',
            format,
            base64: encode(
              `名称${separator}值\n"两行\n文字"${separator}00123\n公式${separator}=1+1`,
            ),
          },
        },
      ]);
      try {
        await page.locator('[data-excel-preview]').waitFor({ timeout: 30_000 });
        expect(
          await page
            .getByText('无法打开此表格。请检查文件格式、内容或密码保护。', {
              exact: true,
            })
            .count(),
        ).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    45_000,
  );
});
