import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { repairFixture } from '../../test/platform-repair-fixture';
import type { RepairTask } from '@allrice/database/technical-contracts';
import { compiledDependencyFixture } from '../../../../packages/database/src/platform-repair-compiled.fixture';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite(
  'repository repair UI exact request reconciliation and stale baseline refusal',
  () => {
    it.each(['builtins', 'compiled'] as const)(
      'recovers committed %s writes, retains all request fields, refreshes declined baselines and never presents missing proof as accepted',
      async (verification) => {
        const require = createRequire(import.meta.url),
          { build } = createRequire(require.resolve('tsx'))('esbuild');
        const built = await build({
          entryPoints: ['apps/web/test/platform-repair-page.tsx'],
          bundle: true,
          write: false,
          outdir: '/unused-repair',
          platform: 'browser',
          format: 'iife',
          jsx: 'automatic',
          loader: {
            '.woff2': 'dataurl',
            '.woff': 'dataurl',
            '.ttf': 'dataurl',
          },
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
        let baseline = repairFixture().baseline,
          mode: 'lost' | 'unknown' | 'accept' | 'decline' = 'lost';
        if (verification === 'compiled') {
          const f = compiledDependencyFixture();
          baseline = {
            ...baseline,
            ...f.baseline,
            compiledDependencies: f.descriptor,
          };
        }
        const rows: RepairTask[] = [],
          history = new Map<string, RepairTask>(),
          posts: {
            requestId: string;
            baselineId: string;
            verificationMode?: 'compiled_packages';
          }[] = [],
          errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.on('pageerror', (e: Error) => errors.push(e.message));
          await page.route(
            '**/api/v1/admin/technical-assistant/repair**',
            async (route: Route) => {
              const r = route.request(),
                u = new URL(r.url());
              if (u.pathname.endsWith('/baselines'))
                return route.fulfill({
                  json: { state: 'available', baselines: [baseline] },
                });
              if (r.method() === 'POST') {
                const input = r.postDataJSON();
                posts.push(input);
                if (mode === 'decline') {
                  baseline = {
                    ...baseline,
                    id: randomUUID(),
                    sourceSha: 'c'.repeat(40),
                    observedDevSha: 'c'.repeat(40),
                  };
                  return route.fulfill({
                    status: 409,
                    json: { message: 'baseline changed' },
                  });
                }
                if (mode === 'unknown') return route.abort('failed');
                const q = {
                  ...repairFixture(input.requestId, baseline),
                  ...(input.verificationMode
                    ? { verificationMode: input.verificationMode }
                    : {}),
                };
                history.set(input.requestId, q);
                rows.unshift(q);
                if (mode === 'lost') return route.abort('failed');
                return route.fulfill({ json: q });
              }
              if (u.searchParams.has('requestId'))
                return route.fulfill({
                  json: {
                    task: history.get(u.searchParams.get('requestId')!) ?? null,
                  },
                });
              return route.fulfill({ json: rows });
            },
          );
          await page.goto(
            'http://127.0.0.1:' + (server.address() as { port: number }).port,
          );
          const generate = page.getByRole('button', {
              name: '生成修复候选',
              exact: true,
            }),
            refresh = page.getByRole('button', { name: '刷新修复记录' });
          await generate.click();
          await page.getByRole('article', { name: '修复详情' }).waitFor();
          expect(posts).toHaveLength(1);
          expect(posts[0]!.verificationMode).toBe(
            verification === 'compiled' ? 'compiled_packages' : undefined,
          );
          expect(rows).toHaveLength(1);
          expect(
            await page
              .getByText('完整构建、main 合并和 Dev 发布尚未执行。', {
                exact: false,
              })
              .count(),
          ).toBe(0);
          rows[0]!.status = 'failed';
          rows[0]!.errorCode = 'SYNTHETIC_PROOF_MISSING';
          await refresh.click();
          await generate.waitFor({ state: 'visible' });
          mode = 'unknown';
          await generate.click();
          const reconcile = page.getByRole('button', {
            name: '核对并继续原请求',
            exact: true,
          });
          await reconcile.waitFor();
          await page
            .getByRole('alert')
            .filter({ hasText: '提交结果尚未确认' })
            .waitFor();
          const unknown = posts[1]!;
          await refresh.click();
          expect(posts).toHaveLength(2);
          expect(await reconcile.count()).toBe(1);
          mode = 'accept';
          await reconcile.click();
          await page.waitForFunction(
            () =>
              !Array.from(document.querySelectorAll('button')).some(
                (b) => b.textContent === '核对并继续原请求',
              ),
          );
          expect(posts[2]).toEqual(unknown);
          expect(rows).toHaveLength(2);
          expect(history.size).toBe(2);
          rows[0]!.status = 'failed';
          rows[0]!.errorCode = 'SYNTHETIC_PROOF_MISSING';
          await refresh.click();
          mode = 'decline';
          await generate.click();
          await page
            .getByRole('alert')
            .filter({ hasText: '本次未启动修复' })
            .waitFor();
          expect(await reconcile.count()).toBe(0);
          await page.waitForFunction(
            (id: string) =>
              (
                document.querySelector(
                  'select[aria-label="源码基线"]',
                ) as HTMLSelectElement
              )?.value === id,
            baseline.id,
          );
          mode = 'accept';
          await generate.click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll('article[aria-label="修复详情"]')
                .length === 1,
          );
          await vi.waitFor(() => expect(posts).toHaveLength(5));
          expect(posts[4]!.requestId).not.toBe(posts[3]!.requestId);
          expect(posts[4]!.baselineId).toBe(baseline.id);
          expect(
            await page
              .getByText('固定断言已通过，候选待审查。', { exact: false })
              .count(),
          ).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await browser.close();
          await new Promise<void>((done) => server.close(() => done()));
        }
      },
      60000,
    );
  },
);
