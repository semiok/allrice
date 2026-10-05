/** HTTP/Chromium over the same live, disposable PG facts, not response fixtures. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { Browser } from '../../apps/worker/node_modules/playwright-core/index.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { WorkbenchArtifact } from '@allrice/contracts';

export async function verifyDeliveryBrowser(input: {
  sessionId: string;
  workspaceId: string;
  organizationId: string;
  artifact: WorkbenchArtifact;
  failed: boolean;
  failureText?: string;
  http: (request: Request) => Promise<Response>;
  releasePreview?: () => void;
}) {
  const require = createRequire(import.meta.url),
    { build } = createRequire(require.resolve('tsx'))('esbuild');
  const built = await build({
    entryPoints: ['apps/web/test/delivery-facts-page.tsx'],
    bundle: true,
    write: false,
    outdir: '/unused-delivery-facts',
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname === '/app.js' || url.pathname === '/app.css') {
      const extension = url.pathname.endsWith('.css') ? '.css' : '.js';
      res.setHeader(
        'content-type',
        extension === '.css' ? 'text/css' : 'text/javascript',
      );
      res.end(
        built.outputFiles.find((f: { path: string }) =>
          f.path.endsWith(extension),
        )?.contents ?? '',
      );
    } else if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const config = JSON.stringify({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        tenantHeaders: {
          'x-allrice-organization-id': input.organizationId,
          'x-allrice-workspace-id': input.workspaceId,
        },
      }).replaceAll('<', '\\u003c');
      res.end(
        `<div id="root"></div><script id="fixture-input" type="application/json">${config}</script><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>`,
      );
    } else
      void input
        .http(new Request(url))
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          res.statusCode = 500;
          res.end('FIXTURE_HTTP_FAILURE');
        });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { chromium } = createRequire(resolve('apps/worker/package.json'))(
    'playwright-core',
  );
  let browser: Browser | undefined;
  try {
    const activeBrowser: Browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    browser = activeBrowser;
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('FIXTURE_LISTENER_MISSING');
    const page = await activeBrowser.newPage({
        viewport: { width: 1450, height: 1000 },
      }),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const name = input.artifact.version.fileName;
    await page
      .getByRole('button', { name: `打开 ${name}`, exact: true })
      .first()
      .waitFor();
    if (input.failed) {
      expect(input.failureText).toBeTruthy();
      await page.getByText(input.failureText!, { exact: true }).waitFor();
      await page.getByRole('button', { name: '常用任务', exact: true }).click();
      await page.getByText(/本轮未全部完成，已有 1 份可读成果/).waitFor();
      await page.keyboard.press('Escape');
    }
    await page
      .getByRole('button', { name: `打开 ${name}`, exact: true })
      .first()
      .click();
    const link = page.getByRole('link', { name: '下载', exact: true });
    await link.waitFor();
    async function download() {
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        link.click(),
      ]);
      const bytes = await readFile((await file.path())!);
      expect('sha256:' + createHash('sha256').update(bytes).digest('hex')).toBe(
        input.artifact.object.checksum,
      );
      expect(bytes.length).toBe(input.artifact.object.sizeBytes);
    }
    if (input.releasePreview) {
      await page.getByText('正在读取安全预览…', { exact: true }).waitFor();
      await download();
      input.releasePreview();
      await page
        .getByText('文档转换暂不可用，请重试预览或下载查看。', { exact: true })
        .waitFor();
    }
    await download();
    expect(errors).toEqual([]);
  } finally {
    input.releasePreview?.();
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
