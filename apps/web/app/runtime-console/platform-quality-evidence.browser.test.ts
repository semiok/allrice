import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
import { RegressionEvidenceSchema } from '@allrice/database/technical-contracts';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('quality evidence UI version and incomplete-record boundaries', () => {
  it('retains historical and partial scope, clears prior verdict when the current request is forbidden', async () => {
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-quality-evidence-page.tsx'],
      bundle: true,
      write: false,
      outdir: '/unused-evidence',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const server = createServer((req, res) => {
      if (req.url === '/app.js' || req.url === '/app.css') {
        const suffix = req.url.slice(4);
        res.setHeader(
          'content-type',
          suffix === '.js' ? 'text/javascript' : 'text/css',
        );
        res.end(
          built.outputFiles?.find((f: { path: string }) =>
            f.path.endsWith(suffix),
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
    const digest = 'sha256:' + 'a'.repeat(64),
      now = new Date().toISOString();
    const record = {
      id: 'a'.repeat(64),
      group: 'native',
      source: { sha: 'b'.repeat(40), treeDigest: digest, dirty: false },
      relation: 'historical',
      capturedAt: now,
      recordedAt: now,
      registryDigest: digest,
      originalReportChecksum: digest,
      runnerSucceeded: true,
      executionExitStatus: 'confirmed',
      fullyVerified: false,
      passedScenarioCount: 0,
      scenarioCount: 1,
      versions: {
        node: 'v22',
        dshAgent: '0.1.5-rc.3',
        dshWeb: '0.1.7-rc.1',
        officeSkillPin: null,
        officeConversionPackage: null,
        lockDigest: digest,
        actualOfficeImage: null,
        actualBridgeVersion: null,
      },
      scenarios: [
        {
          id: randomUUID(),
          title: '未执行场景',
          status: 'skipped',
          boundary: '合成浏览器渲染检查，非功能交付证据。',
          inputDigest: digest,
          assertionDigest: digest,
          executed: 0,
          skipped: 1,
        },
      ],
      scope: '固定样例',
      physicalDeviceValidation: 'not_executed',
      realModelUsed: false,
    };
    let data = RegressionEvidenceSchema.parse({
        schemaVersion: 1,
        state: 'available',
        deployedSha: 'c'.repeat(40),
        currentDevAcceptance: 'not_claimed',
        records: [record],
      }),
      denied = false;
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route('**/quality/evidence', (route: Route) =>
        route.fulfill({
          status: denied ? 403 : 200,
          json: denied ? { code: 'AUTHORIZATION_DENIED' } : data,
        }),
      );
      await page.goto(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      );
      const panel = page.getByRole('region', { name: '版本化回归证据' });
      await panel.getByText(/历史版本证据/).waitFor();
      await panel
        .getByText(
          '这份报告尚不能确认完整通过；请核对场景覆盖和原进程退出状态。',
        )
        .waitFor();
      expect(await panel.getByText(/当前发布 cccccccccc/).count()).toBe(1);
      await panel.getByText('未执行场景 · 未执行', { exact: true }).click();
      await panel.getByText('执行 0 项 · 跳过 1 项', { exact: true }).waitFor();
      data = RegressionEvidenceSchema.parse({
        ...data,
        records: [
          {
            ...data.records[0],
            relation: 'same_material',
            source: { ...data.records[0]!.source, dirty: true },
          },
        ],
      });
      await panel.getByRole('button', { name: '刷新证据' }).click();
      await panel.getByText(/被测工作树含未提交改动/).waitFor();
      expect(await panel.getByText(/保留原被测 SHA/).count()).toBe(1);
      denied = true;
      await panel.getByRole('button', { name: '刷新证据' }).click();
      await panel
        .getByRole('status')
        .getByText('证据暂不可读，尚不能判定通过。')
        .waitFor();
      expect(await panel.getByRole('article').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30000);
});
