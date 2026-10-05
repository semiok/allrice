import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TechnicalTask } from '@allrice/database/technical-contracts';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite(
  'private technical tasks: actual UI with controlled HTTP ordering',
  () => {
    it('refreshes late terminal usage and prevents a stop response from replacing another selected task', async () => {
      const require = createRequire(import.meta.url);
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        entryPoints: ['apps/web/test/technical-tasks-page.tsx'],
        bundle: true,
        write: false,
        outdir: '/unused-technical-tasks',
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      const server = createServer((req, res) => {
        const extension = req.url === '/app.css' ? '.css' : '.js';
        if (req.url === '/app.css' || req.url === '/app.js') {
          res.setHeader(
            'content-type',
            extension === '.css' ? 'text/css' : 'text/javascript',
          );
          res.end(
            built.outputFiles.find((file: { path: string }) =>
              file.path.endsWith(extension),
            )?.contents,
          );
        } else {
          res.setHeader('content-type', 'text/html');
          res.end(
            '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
          );
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
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
      const task = (
        question: string,
        status: TechnicalTask['status'],
      ): TechnicalTask => ({
        id: randomUUID(),
        requestId: randomUUID(),
        ownerId: randomUUID(),
        issueId: null,
        runId: randomUUID(),
        jobId: randomUUID(),
        status,
        environment: 'dev',
        releaseSha: 'a'.repeat(40),
        model: 'controlled-model',
        modelRevision: 1,
        workflowVersion: 1,
        question,
        createdAt: new Date().toISOString(),
        completedAt: status === 'running' ? null : new Date().toISOString(),
        answer: status === 'succeeded' ? '另一任务的诊断答案' : null,
        errorCode: null,
        usage: null,
        usageComplete: false,
        actualCostKnown: false,
        actualCost: null,
      });
      const a = task('待停止任务 A', 'running');
      const b = task('终态任务 B', 'succeeded');
      const c = task('补记用量任务 C', 'canceled');
      let failDetail = false;
      let releaseStop: (() => void) | undefined;
      let stopStarted = false;
      const stopped = new Promise<void>((done) => {
        releaseStop = done;
      });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.route(
          '**/api/v1/admin/technical-assistant/tasks**',
          async (route: Route) => {
            const path = new URL(route.request().url()).pathname;
            const id = path.split('/').at(-1);
            if (id === 'tasks') return route.fulfill({ json: [a, b, c] });
            const selected = [a, b, c].find((item) => item.id === id);
            if (!selected) return route.fulfill({ status: 404, json: {} });
            if (route.request().method() === 'DELETE') {
              stopStarted = true;
              await stopped;
              a.status = 'canceled';
              a.completedAt = new Date().toISOString();
            } else if (failDetail) {
              return route.fulfill({ status: 503, json: {} });
            }
            return route.fulfill({ json: { task: selected, receipts: [] } });
          },
        );
        await page.goto(
          `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        );
        await page.getByRole('button', { name: /补记用量任务 C/ }).click();
        const detail = page.getByRole('article', { name: '诊断任务详情' });
        await detail.getByText('Token：未知', { exact: false }).waitFor();
        c.usage = { inputTokens: 90, cachedInputTokens: 0, outputTokens: 9 };
        await page
          .getByRole('button', { name: '刷新任务', exact: true })
          .click();
        await detail
          .getByText('Token：99（记录不完整）', { exact: false })
          .waitFor();
        failDetail = true;
        await page
          .getByRole('button', { name: '刷新任务', exact: true })
          .click();
        await page
          .getByRole('alert')
          .filter({ hasText: '任务详情暂不可读' })
          .waitFor();
        expect(await detail.count()).toBe(0);
        failDetail = false;
        await page
          .getByRole('button', { name: '刷新任务', exact: true })
          .click();
        await detail
          .getByText('Token：99（记录不完整）', { exact: false })
          .waitFor();

        await page.getByRole('button', { name: /待停止任务 A/ }).click();
        await detail
          .getByRole('button', { name: '停止诊断', exact: true })
          .click();
        await expect.poll(() => stopStarted).toBe(true);
        const chooseB = page.getByRole('button', { name: /终态任务 B/ });
        expect(await chooseB.isDisabled()).toBe(true);
        releaseStop!();
        await expect.poll(() => chooseB.isEnabled()).toBe(true);
        await chooseB.click();
        await detail.getByText('另一任务的诊断答案', { exact: true }).waitFor();
        expect(await detail.getByRole('heading').textContent()).toBe(
          '终态任务 B',
        );
        expect(
          await detail.getByRole('button', { name: '停止诊断' }).count(),
        ).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        releaseStop?.();
        await browser.close();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }, 30_000);
  },
);
