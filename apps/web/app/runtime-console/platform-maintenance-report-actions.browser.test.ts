import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { defaultMaintenancePolicy } from '@allrice/database/technical-contracts';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('report repair authorization browser boundary', () => {
  it('recovers a lost one-time authorization, preserves report-only mode, and only offers revoke/read-only CI controls', async () => {
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-maintenance-actions-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-credential',
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
    const id = crypto.randomUUID(),
      digest = 'sha256:' + 'a'.repeat(64),
      now = new Date().toISOString();
    const deployment = {
      id: crypto.randomUUID(),
      companyName: 'QA Company',
      companySlug: 'qa-company',
      deploymentName: 'Primary',
      policy: defaultMaintenancePolicy,
      revision: 3,
      credentialRevision: 1,
      enabledAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const view = {
      reportId: id,
      reportDigest: digest,
      deployment,
      authority: {
        diagnoses: [
          { proof: { verdict: 'confirmed_code' }, proofDigest: digest },
        ],
        grants: [],
      },
    };
    let authority: Record<string, unknown> = { diagnoses: [], grants: [] };
    const writes: { url: string; body: Record<string, unknown> }[] = [],
      errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e: Error) => errors.push(e.message));
      await page.addInitScript((f: typeof view) => {
        (
          window as unknown as { maintenanceFixture: unknown }
        ).maintenanceFixture = f;
      }, view);
      await page.route('**/authority', (route: Route) =>
        route.fulfill({ json: authority }),
      );
      await page.route(
        '**/api/v1/admin/technical-assistant/maintenance/**',
        async (route: Route) => {
          const body = route.request().postDataJSON();
          writes.push({ url: route.request().url(), body });
          if (writes.length === 1) {
            authority = {
              diagnoses: [],
              grants: [
                {
                  id: crypto.randomUUID(),
                  requestId: body.requestId,
                  canControl: true,
                  reportId: id,
                  deploymentId: deployment.id,
                  defectId: crypto.randomUUID(),
                  origin: 'manual',
                  frozenDigest: digest,
                  attemptId: crypto.randomUUID(),
                  expiresAt: new Date(Date.now() + 600000).toISOString(),
                  revokedAt: null,
                  repairTaskId: null,
                  publicationId: null,
                  createdAt: now,
                },
              ],
            };
            return route.abort('failed');
          }
          if (body.action === 'revoke')
            (authority.grants as Record<string, unknown>[])[0]!.revokedAt =
              new Date().toISOString();
          return route.fulfill({ json: authority });
        },
      );
      await page.goto(
        'http://127.0.0.1:' + (server.address() as { port: number }).port,
      );
      const once = page.getByRole('button', { name: '仅本次修复并提交 PR' });
      await once.click();
      await page
        .getByText('已回读确认本次授权，不会重复创建任务。', { exact: true })
        .waitFor();
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body).toMatchObject({
        reportId: id,
        expectedReportDigest: digest,
        expectedDiagnosisDigest: digest,
        expectedDeploymentRevision: 3,
      });
      expect(deployment.policy.mode).toBe('report_only');
      expect(await once.isDisabled()).toBe(true);
      await page.getByRole('button', { name: '刷新处理状态' }).click();
      expect(writes).toHaveLength(1);
      await page.getByRole('button', { name: '撤销本次授权' }).click();
      await page.getByText('授权已撤销', { exact: true }).waitFor();
      expect(writes[1]!.body).toEqual({ action: 'revoke' });
      expect(
        await page.getByRole('button', { name: /合并|部署|Ready/ }).count(),
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30000);
});
