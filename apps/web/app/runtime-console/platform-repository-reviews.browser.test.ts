import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import type {
  RepositoryReviewPanelSchema,
  RepositoryReviewViewSchema,
} from '@allrice/database/technical-contracts';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('repository review real browser reconciliation and readiness', () => {
  it('keeps a lost acknowledgement pending across reload, reads back once, stops the same Run, and preserves rejected/stale downloadable history', async () => {
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-repository-reviews-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-review',
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
      digest = 'sha256:' + 'a'.repeat(64),
      errors: string[] = [],
      writes: Record<string, unknown>[] = [];
    let review: z.infer<typeof RepositoryReviewViewSchema> | null = null,
      visible = false,
      deletes = 0;
    const panel: z.infer<typeof RepositoryReviewPanelSchema> = {
      publicationId,
      canStart: true,
      subjectDigest: digest,
      readiness: {
        state: 'not_started',
        subjectDigest: digest,
        reasons: ['independent_review_required'],
        notice:
          'Model review is an attributed opinion. Merge and Dev acceptance are separate gates.',
      },
      reviews: [],
    };
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e: Error) => errors.push(e.message));
      await page.addInitScript(
        ({ publicationId }: { publicationId: string }) => {
          (
            window as unknown as { repositoryReviewFixture: unknown }
          ).repositoryReviewFixture = { publicationId, credentialRevision: 1 };
        },
        { publicationId },
      );
      await page.route(
        '**/api/v1/admin/technical-assistant/repository-reviews**',
        async (route: Route) => {
          const request = route.request(),
            url = new URL(request.url());
          if (request.method() === 'POST') {
            writes.push(request.postDataJSON());
            review = {
              id: randomUUID(),
              runId: randomUUID(),
              jobId: randomUUID(),
              sessionId: randomUUID(),
              subjectDigest: digest,
              candidateContentDigest: digest,
              status: 'queued',
              reviewerRunId: null,
              employeeVersionId: randomUUID(),
              verdict: null,
              summary: null,
              reviewArtifactId: null,
              deliveryArtifactId: null,
              errorCode: null,
              createdAt: new Date().toISOString(),
              remoteVerifiedAt: null,
            };
            return route.abort('failed');
          }
          if (request.method() === 'DELETE') {
            deletes++;
            review!.status = 'canceled';
            panel.reviews = [review!];
            panel.canStart = true;
            panel.readiness.state = 'unknown';
            panel.readiness.reasons = ['canceled'];
            return route.fulfill({ json: review });
          }
          if (url.searchParams.has('requestId'))
            return route.fulfill({ json: { review: visible ? review : null } });
          return route.fulfill({ json: panel });
        },
      );
      const url =
        'http://127.0.0.1:' + (server.address() as { port: number }).port;
      await page.goto(url);
      const start = page.getByRole('button', { name: '开始独立审查' });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await start.click();
      await page
        .getByText('提交结果尚无法确认，请核对原请求；不要重复创建审查。', {
          exact: true,
        })
        .waitFor();
      expect(writes).toHaveLength(1);
      expect(await start.isDisabled()).toBe(true);
      await page.reload();
      await page.getByRole('button', { name: '核对原审查请求' }).waitFor();
      await page.getByRole('button', { name: '核对原审查请求' }).click();
      await page
        .getByText(
          '尚未找到原请求，结果仍需核对。请稍后再次核对，未重复提交。',
          { exact: true },
        )
        .waitFor();
      expect(writes).toHaveLength(1);
      visible = true;
      panel.reviews = [review!];
      panel.canStart = false;
      panel.readiness.state = 'pending';
      panel.readiness.reasons = ['review_not_complete'];
      await page.getByRole('button', { name: '核对原审查请求' }).click();
      await page
        .getByText('已找到原请求；没有重新调用模型。', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: '停止审查' }).click();
      await expect.poll(() => deletes).toBe(1);
      await expect.poll(() => start.isEnabled()).toBe(true);
      expect(writes).toHaveLength(1);
      const stored = review as z.infer<
        typeof RepositoryReviewViewSchema
      > | null;
      if (!stored) throw Error('fixture missing');
      stored.status = 'succeeded';
      stored.verdict = 'revise';
      stored.summary = 'Original rejection';
      stored.reviewArtifactId = randomUUID();
      stored.reviewerRunId = randomUUID();
      stored.remoteVerifiedAt = new Date().toISOString();
      panel.canStart = false;
      panel.readiness.state = 'revise';
      panel.readiness.reasons = ['revision_required'];
      await page.getByRole('button', { name: '刷新审查状态' }).click();
      await page.getByText('需要修改候选', { exact: true }).waitFor();
      expect(await start.isDisabled()).toBe(true);
      await page.locator('summary').click();
      expect(
        await page
          .getByRole('link', { name: '下载审查意见' })
          .getAttribute('href'),
      ).toContain(stored.reviewArtifactId);
      panel.subjectDigest = 'sha256:' + 'b'.repeat(64);
      panel.readiness.subjectDigest = panel.subjectDigest;
      panel.readiness.state = 'stale';
      panel.readiness.reasons = ['subject_changed'];
      panel.canStart = true;
      await page.getByRole('button', { name: '刷新审查状态' }).click();
      await page.getByText('版本已变化，需重新审查', { exact: true }).waitFor();
      expect(await page.locator('summary').innerText()).toContain('历史版本');
      expect(writes).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);
});
