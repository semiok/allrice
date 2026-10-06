import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('repository merge browser durable request recovery', () => {
  it('recovers a lost reply across reload, retries only the same absent request, stops its canonical Run and distinguishes main from Dev', async () => {
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-repository-merges-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-merge',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((req, res) => {
      const ext =
        req.url === '/app.css' ? '.css' : req.url === '/app.js' ? '.js' : null;
      res.setHeader(
        'content-type',
        ext === '.css' ? 'text/css' : ext ? 'text/javascript' : 'text/html',
      );
      res.end(
        ext
          ? (built.outputFiles?.find((f: { path: string; text: string }) =>
              f.path.endsWith(ext),
            )?.text ?? '')
          : '<div id="root"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    const publicationId = randomUUID(),
      subjectId = randomUUID(),
      digest = 'sha256:' + 'a'.repeat(64),
      errors: string[] = [],
      writes: Record<string, unknown>[] = [];
    let visible = false,
      stops = 0;
    const action = {
      id: randomUUID(),
      requestId: randomUUID() as string,
      action: 'merge',
      runId: randomUUID(),
      jobId: randomUUID(),
      status: 'queued',
      errorCode: null as string | null,
      createdAt: new Date().toISOString(),
    };
    const operation = {
      id: randomUUID(),
      publicationId,
      reviewSubjectId: subjectId,
      subjectDigest: digest,
      readyStarted: false,
      mergeStarted: false,
      receipt: null as unknown,
      actions: [action],
      createdAt: new Date().toISOString(),
    };
    const panel = () => ({
      publicationId,
      canStart: !visible,
      reviewSubjectId: subjectId,
      subjectDigest: digest,
      reason: visible
        ? operation.receipt
          ? 'merged'
          : action.status === 'queued'
            ? 'merge_active'
            : null
        : null,
      merges: visible ? [operation] : [],
    });
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e: Error) => errors.push(e.message));
      await page.addInitScript(
        ({ publicationId }: { publicationId: string }) => {
          (
            window as unknown as { repositoryMergeFixture: unknown }
          ).repositoryMergeFixture = { publicationId, credentialRevision: 1 };
        },
        { publicationId },
      );
      await page.route(
        '**/api/v1/admin/technical-assistant/repository-merges**',
        async (route: Route) => {
          const request = route.request(),
            url = new URL(request.url());
          const respond = (body: unknown) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(body),
            });
          if (request.method() === 'POST') {
            const body = request.postDataJSON() as Record<string, unknown>;
            writes.push(body);
            action.requestId = String(body.requestId);
            if (writes.length === 1) return route.abort('failed');
            visible = true;
            return respond(operation);
          }
          if (request.method() === 'DELETE') {
            expect(url.pathname.endsWith('/' + operation.id)).toBe(true);
            expect(url.searchParams.get('actionId')).toBe(action.id);
            stops++;
            action.status = 'canceled';
            return respond(operation);
          }
          if (url.searchParams.has('requestId')) {
            expect(url.searchParams.get('requestId')).toBe(action.requestId);
            return respond({ merge: visible ? operation : null });
          }
          return respond(panel());
        },
      );
      const address = server.address() as { port: number };
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page
        .getByRole('button', { name: '合并已审查候选', exact: true })
        .click();
      await expect
        .poll(() =>
          page.getByText('提交结果尚无法确认。', { exact: false }).isVisible(),
        )
        .toBe(true);
      await page.reload();
      await expect
        .poll(() =>
          page.getByRole('button', { name: '核对原合并请求' }).isVisible(),
        )
        .toBe(true);
      expect(
        await page
          .getByRole('button', { name: '合并已审查候选', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.getByRole('button', { name: '核对原合并请求' }).click();
      await page.getByRole('button', { name: '重试原合并请求' }).click();
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[1]).toEqual(writes[0]);
      await expect
        .poll(() =>
          page.getByRole('button', { name: '停止合并操作' }).isVisible(),
        )
        .toBe(true);
      await page.getByRole('button', { name: '停止合并操作' }).click();
      await expect.poll(() => stops).toBe(1);
      operation.mergeStarted = true;
      action.status = 'failed';
      action.errorCode = 'REPOSITORY_MERGE_RESULT_UNKNOWN';
      await page.getByRole('button', { name: '刷新合并状态' }).click();
      await expect
        .poll(() =>
          page.getByRole('button', { name: '核对原合并结果' }).isVisible(),
        )
        .toBe(true);
      await page.getByRole('button', { name: '核对原合并结果' }).click();
      await expect.poll(() => writes.length).toBe(3);
      expect(writes[2]!.action).toBe('reconcile');
      expect(writes[2]!.mergeId).toBe(operation.id);
      expect(writes.filter((w) => w.action === 'merge')).toHaveLength(2);
      operation.receipt = {
        version: 1,
        publicationId,
        pullNumber: 312,
        subjectDigest: digest,
        baseSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        mergeSha: '9'.repeat(40),
        mergeTree: 'd'.repeat(40),
        observedMainSha: '9'.repeat(40),
        observedAt: new Date().toISOString(),
      };
      action.status = 'succeeded';
      action.errorCode = null;
      await page.getByRole('button', { name: '刷新合并状态' }).click();
      await page.getByText('已合入 main', { exact: true }).click();
      await expect
        .poll(() =>
          page.getByText('Dev 尚未由此操作发布。', { exact: true }).isVisible(),
        )
        .toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((r, e) =>
        server.close((error) => (error ? e(error) : r())),
      );
    }
  }, 30000);
});
