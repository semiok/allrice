import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  defaultMaintenancePolicy,
  type MaintenanceDeployment,
} from '@allrice/database/technical-contracts';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('maintenance configuration browser lifecycle', () => {
  it('recovers registration without duplicate installations, saves CAS settings and rotates or revokes a once-only connection key', async () => {
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-maintenance-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-maintenance',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((req, res) => {
      if (req.url === '/app.css' || req.url === '/app.js') {
        const ext = req.url.endsWith('.css') ? '.css' : '.js';
        res.setHeader(
          'content-type',
          ext === '.css' ? 'text/css' : 'text/javascript',
        );
        res.end(
          built.outputFiles?.find((f: { path: string }) => f.path.endsWith(ext))
            ?.text ?? '',
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
    let deployment: MaintenanceDeployment | null = null,
      lost = true;
    const keys = ['A'.repeat(43), 'B'.repeat(43)],
      requests: Record<string, unknown>[] = [],
      errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e: Error) => errors.push(e.message));
      await page.route(
        '**/api/v1/admin/technical-assistant/maintenance**',
        async (route: Route) => {
          if (route.request().url().includes('/maintenance/reports'))
            return route.fulfill({ json: { reports: [], nextCursor: null } });
          const req = route.request();
          if (req.method() === 'POST') {
            const input = req.postDataJSON();
            requests.push(input);
            if (!deployment) {
              const now = new Date().toISOString();
              deployment = {
                id: crypto.randomUUID(),
                companyName: input.companyName,
                companySlug: input.companySlug,
                deploymentName: input.deploymentName,
                policy: defaultMaintenancePolicy,
                revision: 1,
                credentialRevision: 1,
                enabledAt: null,
                revokedAt: null,
                createdAt: now,
                updatedAt: now,
              };
            }
            if (lost) {
              lost = false;
              return route.abort('failed');
            }
            return route.fulfill({
              json: { deployment, installationKey: null },
            });
          }
          if (req.method() === 'PUT') {
            const input = req.postDataJSON();
            requests.push(input);
            if (input.expectedRevision !== deployment!.revision)
              return route.fulfill({
                status: 409,
                json: { error: 'maintenance_configuration_conflict' },
              });
            if (req.url().endsWith('/credential')) {
              deployment = {
                ...deployment!,
                revision: deployment!.revision + 1,
                credentialRevision: deployment!.credentialRevision + 1,
                revokedAt:
                  input.action === 'revoke' ? new Date().toISOString() : null,
              };
              return route.fulfill({
                json: {
                  deployment,
                  installationKey: input.action === 'rotate' ? keys[1] : null,
                },
              });
            }
            deployment = {
              ...deployment!,
              policy: input.policy,
              revision: deployment!.revision + 1,
            };
            return route.fulfill({ json: deployment });
          }
          return route.fulfill({
            json: {
              deployments: deployment ? [deployment] : [],
              capabilities: {
                repairReady: false,
                automaticMerge: false,
                automaticDeployment: false,
                globalRepairConcurrency: 1,
              },
            },
          });
        },
      );
      await page.goto(
        'http://127.0.0.1:' + (server.address() as { port: number }).port,
      );
      await page.getByLabel('维护公司名称').fill('Fixture Company');
      await page.getByLabel('维护公司英文标识').fill('fixture-company');
      await page.getByRole('button', { name: '登记公司部署' }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: '登记结果尚未确认' })
        .waitFor();
      expect(requests).toHaveLength(1);
      await page.getByRole('button', { name: '登记公司部署' }).click();
      await page.getByRole('button', { name: '保存维护设置' }).waitFor();
      expect(requests[0]).toEqual(requests[1]);
      expect(await page.getByLabel('维护处理方式').inputValue()).toBe(
        'report_only',
      );
      expect(
        await page
          .locator('option[value="repair_and_pr"]')
          .evaluate((node: HTMLOptionElement) => node.disabled),
      ).toBe(true);
      await page.getByLabel('维护检查间隔').fill('120');
      await page.getByLabel('暂停维护任务').check();
      await page.getByRole('button', { name: '保存维护设置' }).click();
      await page.getByText('配置已保存。', { exact: true }).waitFor();
      expect(await page.getByLabel('维护检查间隔').inputValue()).toBe('120');
      expect(await page.getByLabel('暂停维护任务').isChecked()).toBe(true);
      await page.getByRole('button', { name: '更换连接密钥' }).click();
      await page.getByRole('button', { name: '下载连接配置' }).waitFor();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '下载连接配置' }).click();
      const download = await downloadPromise;
      const stream = await download.createReadStream(),
        chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
        version: 1,
        deploymentId: deployment!.id,
        installationKey: keys[1],
      });
      expect(await page.locator('body').innerText()).not.toContain(keys[1]);
      expect(
        await page.evaluate(
          () =>
            Object.keys(localStorage).length +
            Object.keys(sessionStorage).length,
        ),
      ).toBe(0);
      await page.getByRole('button', { name: '撤销部署连接' }).click();
      await page.getByText('部署连接已撤销。', { exact: true }).waitFor();
      expect(
        await page.getByRole('button', { name: '下载连接配置' }).count(),
      ).toBe(0);
      expect(
        await page.getByRole('button', { name: '撤销部署连接' }).isDisabled(),
      ).toBe(true);
      await page.reload();
      await page.getByLabel('维护公司部署').selectOption(deployment!.id);
      await page.getByRole('button', { name: '保存维护设置' }).waitFor();
      expect(await page.getByLabel('维护检查间隔').inputValue()).toBe('120');
      expect(await page.getByLabel('暂停维护任务').isChecked()).toBe(true);
      expect(errors).toEqual([]);
      expect(requests.filter((r) => r.action === 'rotate')).toHaveLength(1);
    } finally {
      await browser.close();
      await new Promise<void>((done, reject) =>
        server.close((e) => (e ? reject(e) : done())),
      );
    }
  }, 60000);
});
