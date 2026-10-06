import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { RepositoryPublication } from '@allrice/database/technical-contracts';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite(
  'candidate publication browser reconciliation and current-version gates',
  () => {
    it('reads a lost acknowledgement, stops the canonical operation, keeps unknown writes pending without replay, and rejects an old baseline', async () => {
      const require = createRequire(import.meta.url),
        { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        entryPoints: [
          'apps/web/test/platform-repository-publications-page.tsx',
        ],
        bundle: true,
        write: false,
        outdir: '/unused-publication',
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      const server = createServer((req, res) => {
        if (req.url === '/app.css' || req.url === '/app.js') {
          const ext = req.url === '/app.css' ? '.css' : '.js';
          res.setHeader(
            'content-type',
            ext === '.css' ? 'text/css' : 'text/javascript',
          );
          res.end(
            built.outputFiles?.find((f: { path: string; text: string }) =>
              f.path.endsWith(ext),
            )?.text ?? '',
          );
        } else {
          res.setHeader('content-type', 'text/html');
          res.end(
            '<div id="root"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
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
      const repairId = randomUUID(),
        id = randomUUID(),
        branch = 'allrice/repairs/' + id;
      let publication: RepositoryPublication | null = null,
        unknown = false,
        deletes = 0;
      const writes: {
          requestId: string;
          action: 'publish' | 'inspect';
          repairTaskId?: string;
          publicationId?: string;
          credentialRevision: number;
        }[] = [],
        errors: string[] = [];
      const action = (
        request: (typeof writes)[number],
        status: 'queued' | 'succeeded',
      ) => ({
        id: randomUUID(),
        requestId: request.requestId,
        action: request.action,
        runId: randomUUID(),
        jobId: randomUUID(),
        status,
        errorCode: null,
        createdAt: new Date().toISOString(),
      });
      try {
        const page = await browser.newPage();
        page.on('pageerror', (e: Error) => errors.push(e.message));
        await page.addInitScript(
          ({ repairId }: { repairId: string }) => {
            (
              window as unknown as { repositoryFixture: unknown }
            ).repositoryFixture = {
              repair: {
                id: repairId,
                accepted: true,
                verificationMode: 'compiled_packages',
              },
              currentBaseline: true,
            };
          },
          { repairId },
        );
        await page.route(
          '**/api/v1/admin/technical-assistant/repository-credential',
          (route: Route) =>
            route.fulfill({
              json: {
                repositoryId: 1323769790,
                repository: 'semiok/allrice',
                revision: 1,
                configured: true,
                state: 'configured',
                updatedAt: new Date().toISOString(),
                lastWriteRequestId: randomUUID(),
              },
            }),
        );
        await page.route(
          '**/api/v1/admin/technical-assistant/repository-publications**',
          async (route: Route) => {
            const request = route.request(),
              url = new URL(request.url());
            if (request.method() === 'POST') {
              const input = request.postDataJSON();
              writes.push(input);
              if (unknown) return route.abort('failed');
              publication ??= {
                id,
                branch,
                repositoryId: 1323769790,
                repository: 'semiok/allrice',
                repairTaskId: repairId,
                baseSha: 'a'.repeat(40),
                candidateChecksum: 'sha256:' + 'b'.repeat(64),
                revision: 1,
                createdAt: new Date().toISOString(),
                remote: null,
                steps: ['blob', 'tree', 'commit', 'branch', 'pull'].map(
                  (step) => ({ step, state: 'not_started' }),
                ) as RepositoryPublication['steps'],
                ci: {
                  state: 'not_observed',
                  observedAt: null,
                  workflowRunId: null,
                  runAttempt: null,
                  headSha: null,
                  checkoutSha: null,
                  checkoutTree: null,
                  materialDigest: null,
                  checks: [],
                  receipts: [],
                },
                actions: [],
              };
              publication.actions.unshift(action(input, 'queued'));
              return route.abort('failed');
            }
            if (request.method() === 'DELETE') {
              deletes++;
              publication!.actions[0]!.status = 'canceled';
              return route.fulfill({ json: publication });
            }
            const requestId = url.searchParams.get('requestId');
            return route.fulfill({
              json: requestId
                ? {
                    publication: publication?.actions.some(
                      (a) => a.requestId === requestId,
                    )
                      ? publication
                      : null,
                  }
                : [...(publication ? [publication] : [])],
            });
          },
        );
        await page.goto(
          'http://127.0.0.1:' + (server.address() as { port: number }).port,
        );
        const publish = page.getByRole('button', { name: '提交候选到 GitHub' });
        await expect.poll(() => publish.isEnabled()).toBe(true);
        await publish.click();
        await page
          .getByText('已找到原操作，未重复提交。', { exact: true })
          .waitFor();
        expect(writes).toHaveLength(1);
        await page.getByRole('button', { name: '停止当前操作' }).click();
        await expect.poll(() => deletes).toBe(1);
        await expect.poll(() => publish.isEnabled()).toBe(true);
        unknown = true;
        await page.getByRole('button', { name: '核对远端与 CI' }).click();
        await page
          .getByText('提交结果尚未确认，请核对原请求；不会自动重新提交。', {
            exact: true,
          })
          .waitFor();
        expect(writes).toHaveLength(2);
        expect(await publish.isDisabled()).toBe(true);
        await page.getByRole('button', { name: '刷新发布记录' }).click();
        await page.getByRole('button', { name: '核对原请求' }).click();
        await page
          .getByText('尚未找到原请求，结果仍未确认。', { exact: true })
          .waitFor();
        expect(writes).toHaveLength(2);
        const stored = publication as RepositoryPublication | null;
        if (!stored) throw Error('fixture missing');
        stored.actions.unshift(action(writes[1]!, 'succeeded'));
        stored.ci.state = 'unknown';
        stored.ci.observedAt = new Date().toISOString();
        await page.getByRole('button', { name: '核对原请求' }).click();
        await page.getByText('CI 尚无法确认', { exact: true }).waitFor();
        expect(writes).toHaveLength(2);
        expect(
          await page.getByRole('button', { name: '核对原请求' }).count(),
        ).toBe(0);
        expect(
          writes.every(
            (w) =>
              w.credentialRevision === 1 && !('token' in w) && !('url' in w),
          ),
        ).toBe(true);
        await page.addInitScript(() => {
          (
            window as unknown as {
              repositoryFixture: { currentBaseline: boolean };
            }
          ).repositoryFixture.currentBaseline = false;
        });
        await page.reload();
        await page
          .getByText('请先在当前基线复验编译候选，再提交。', { exact: true })
          .waitFor();
        expect(await publish.isDisabled()).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }, 30000);
  },
);
