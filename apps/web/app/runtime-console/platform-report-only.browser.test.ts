import {
  TechnicalAssistantResponseSchema,
  MaintenanceCatalogSchema,
  MaintenanceReportPageSchema,
  MaintenanceGithubBotSchema,
  QualityScheduleViewSchema,
  RegressionEvidenceSchema,
  PlatformRepositoryCredentialSchema,
  type TechnicalEvidence,
} from '@allrice/database/technical-contracts';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairFixture } from '../../test/platform-repair-fixture';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('report-only historical repair view', () => {
  it('allows refresh, historical details and cancellation while refusing new repair controls', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-report-only-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-report-only',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((request, response) => {
      const extension =
        request.url === '/app.js'
          ? '.js'
          : request.url === '/app.css'
            ? '.css'
            : null;
      if (extension) {
        response.setHeader(
          'content-type',
          extension === '.js' ? 'text/javascript' : 'text/css',
        );
        response.end(
          built.outputFiles?.find((f: { path: string; text: string }) =>
            f.path.endsWith(extension),
          )?.text ?? '',
        );
      } else
        response.end(
          '<div id="root"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
        );
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
    const writes: string[] = [];
    try {
      const page = await browser.newPage();
      const historical = {
        ...repairFixture(),
        status: 'succeeded' as 'succeeded' | 'queued',
      };
      await page.route(
        '**/api/v1/admin/technical-assistant/**',
        async (route: Route) => {
          const request = route.request(),
            path = new URL(request.url()).pathname;
          if (request.method() !== 'GET') {
            writes.push(request.method() + ' ' + path);
            return route.fulfill({
              status: 403,
              json: { error: 'platform_autonomous_actions_deferred' },
            });
          }
          if (path.endsWith('/baselines'))
            return route.fulfill({
              json: { state: 'available', baselines: [historical.baseline] },
            });
          if (path.endsWith('/repair'))
            return route.fulfill({ json: [historical] });
          if (path.endsWith('/repository-credential'))
            return route.fulfill({ json: { state: 'not_configured' } });
          return route.fulfill({ json: [] });
        },
      );
      await page.goto(
        'http://127.0.0.1:' + (server.address() as { port: number }).port,
      );
      await page.getByRole('button', { name: '查看修复详情' }).click();
      await page.getByRole('article', { name: '修复详情' }).waitFor();
      expect(
        await page
          .getByRole('button', { name: '生成修复候选', exact: true })
          .isDisabled(),
      ).toBe(true);
      historical.status = 'queued';
      await page.getByRole('button', { name: '刷新修复记录' }).click();
      expect(
        await page
          .getByRole('button', { name: '停止修复', exact: true })
          .isDisabled(),
      ).toBe(false);
      expect(
        await page
          .getByRole('button', { name: '提交候选到 GitHub', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.getByRole('button', { name: '刷新修复记录' }).click();
      await page.getByRole('button', { name: '刷新发布记录' }).click();
      expect(
        await page
          .getByText(
            '旧修复入口仅供查看历史记录；新报告请在维护设置中授权处理。',
            {
              exact: true,
            },
          )
          .isVisible(),
      ).toBe(true);
      expect(writes).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 15000);
  it('loads the actual combined console with current maintenance controls and read-only history, without writes', async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/technical-assistant-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-technical-assistant',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((request, response) => {
      if (request.url === '/app.js' || request.url === '/app.css') {
        const extension = request.url.slice(4);
        response.setHeader(
          'content-type',
          extension === '.js' ? 'text/javascript' : 'text/css',
        );
        response.end(
          built.outputFiles?.find((f: { path: string }) =>
            f.path.endsWith(extension),
          )?.text ?? '',
        );
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<div id="root"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
        );
      }
    });
    const endpoint = '/api/v1/admin/technical-assistant';
    const unknownSample = (source: TechnicalEvidence['source']) => ({
      evidence: {
        source,
        environment: 'test',
        freshness: 'unknown',
        sampledAt: null,
        windowStart: null,
        windowEnd: null,
        unavailableReason: 'no_sample',
      },
      value: null,
    });
    const historical = repairFixture();
    const responses: Record<string, unknown> = {
      [endpoint]: TechnicalAssistantResponseSchema.parse({
        diagnostics: {
          schemaVersion: 1,
          environment: 'test',
          capturedAt: new Date().toISOString(),
          web: unknownSample('web_health'),
          worker: unknownSample('worker_health'),
          inventory: unknownSample('worker_samples'),
          pressure: unknownSample('execution_pressure'),
          runs: unknownSample('runs'),
          operations: unknownSample('operations'),
          feedback: unknownSample('feedback'),
        },
        issues: [],
      }),
      [endpoint + '/tasks']: [],
      [endpoint + '/quality']: [],
      [endpoint + '/quality/schedule']: QualityScheduleViewSchema.parse({
        schedule: null,
        occurrences: [],
      }),
      [endpoint + '/quality/evidence']: RegressionEvidenceSchema.parse({
        schemaVersion: 1,
        state: 'not_configured',
        deployedSha: null,
        currentDevAcceptance: 'not_claimed',
        records: [],
      }),
      [endpoint + '/maintenance']: MaintenanceCatalogSchema.parse({
        deployments: [],
        capabilities: {
          repairReady: false,
          automaticMerge: false,
          automaticDeployment: false,
          globalRepairConcurrency: 1,
        },
      }),
      [endpoint + '/maintenance/reports']: MaintenanceReportPageSchema.parse({
        reports: [],
        nextCursor: null,
      }),
      [endpoint + '/maintenance/github-bot']: MaintenanceGithubBotSchema.parse({
        repository: 'semiok/allrice',
        revision: 0,
        configured: false,
        state: 'not_configured',
        lastWriteRequestId: null,
        updatedAt: null,
        identity: null,
        verifiedAt: null,
      }),
      [endpoint + '/repair/baselines']: {
        state: 'available',
        baselines: [historical.baseline],
      },
      [endpoint + '/repair']: [historical],
      [endpoint + '/repository-credential']:
        PlatformRepositoryCredentialSchema.parse({
          repositoryId: 1323769790,
          repository: 'semiok/allrice',
          revision: 0,
          configured: false,
          state: 'not_configured',
          updatedAt: null,
          lastWriteRequestId: null,
        }),
      [endpoint + '/repository-publications']: [],
    };
    const reads = new Set<string>(),
      writes: string[] = [],
      missing: string[] = [],
      errors: string[] = [];
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      });
      const page = await browser.newPage();
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route(
        /\/api\/v1\/admin\/technical-assistant(?:\/|\?|$)/,
        async (route: Route) => {
          const request = route.request(),
            path = new URL(request.url()).pathname;
          if (request.method() !== 'GET') {
            writes.push(request.method() + ' ' + path);
            return route.fulfill({
              status: 403,
              json: { error: 'test_read_only' },
            });
          }
          reads.add(path);
          if (!Object.hasOwn(responses, path)) {
            missing.push(path);
            return route.fulfill({
              status: 404,
              json: { error: 'missing_fixture' },
            });
          }
          return route.fulfill({ json: responses[path] });
        },
      );
      await page.goto(
        'http://127.0.0.1:' + (server.address() as { port: number }).port,
      );
      await page
        .getByRole('heading', { name: '技术助手', exact: true })
        .waitFor();
      await page.getByText(/按公司查看诊断、巡检和问题报告/).waitFor();
      await page.getByText(/合并与部署由你手动安排/).waitFor();
      expect(
        await page.getByText(/自主修复、独立审查和发布已延期/).count(),
      ).toBe(0);
      await page
        .getByText(
          '旧修复入口仅供查看历史记录；新报告请在维护设置中授权处理。',
          { exact: true },
        )
        .waitFor();
      await page.getByText('GitHub 提交账号 · 未配置', { exact: true }).click();
      expect(await page.getByLabel('GitHub 用户名').inputValue()).toBe(
        'semiok',
      );
      expect(
        await page
          .getByRole('button', { name: '保存 GitHub 授权', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page
          .getByRole('button', { name: '生成修复候选', exact: true })
          .isDisabled(),
      ).toBe(true);
      await expect
        .poll(() => Object.keys(responses).every((path) => reads.has(path)))
        .toBe(true);
      await page.getByText(/环境 test · 最近读取/).waitFor();
      await page
        .getByText('尚未登记可核验的回归证据。', { exact: true })
        .waitFor();
      await page.getByLabel('维护公司部署').waitFor();
      await page
        .getByText('暂无报告。独立部署连接后，检查结果会汇总到这里。', {
          exact: true,
        })
        .waitFor();
      await expect
        .poll(() =>
          page
            .locator('details[aria-label="平台仓库授权"] summary')
            .innerText(),
        )
        .toContain('未配置');
      await expect
        .poll(() => page.getByLabel('源码基线').locator('option').count())
        .toBe(2);
      await page
        .getByText('候选修复 · ' + historical.id.slice(0, 8), { exact: true })
        .waitFor();
      expect(
        await page
          .getByRole('region', { name: '候选仓库发布', exact: true })
          .getByRole('status')
          .count(),
      ).toBe(0);
      expect(await page.getByRole('alert').count()).toBe(0);
      expect(errors).toEqual([]);
      expect(missing).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      await browser?.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 20000);
});
