import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MaintenanceGithubBotSchema } from '@allrice/database/technical-contracts';
import type { Route } from '../../../worker/node_modules/playwright-core/index.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('platform repository credential browser write reconciliation', () => {
  it('clears secret input, confirms a lost acknowledgement by reading the same request, and never automatically replays an unknown write', async () => {
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/platform-maintenance-github-bot-page.tsx'],
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
    const token = 'github_pat_' + 'SyntheticOnly'.repeat(7);
    let settings = MaintenanceGithubBotSchema.parse({
      repository: 'semiok/allrice',
      revision: 0,
      configured: false,
      state: 'not_configured',
      lastWriteRequestId: null,
      updatedAt: null,
      identity: null,
      verifiedAt: null,
    });
    let mode: 'lost_ack' | 'unknown' | 'accept' = 'lost_ack';
    const writes: {
        requestId: string;
        expectedRevision: number;
        action: string;
        token?: string;
      }[] = [],
      errors: string[] = [];
    let initialRead = true,
      releaseInitial!: () => void,
      startedInitial!: () => void,
      completedInitial!: () => void;
    const heldInitial = new Promise<void>((done) => {
        releaseInitial = done;
      }),
      initialStarted = new Promise<void>((done) => {
        startedInitial = done;
      }),
      initialCompleted = new Promise<void>((done) => {
        completedInitial = done;
      });
    try {
      const page = await browser.newPage();
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route(
        '**/api/v1/admin/technical-assistant/maintenance/github-bot',
        async (route: Route) => {
          if (route.request().method() === 'GET' && initialRead) {
            initialRead = false;
            const snapshot = { ...settings };
            startedInitial();
            await heldInitial;
            await route.fulfill({ json: snapshot });
            completedInitial();
            return;
          }
          if (route.request().method() === 'PUT') {
            const input = route.request().postDataJSON();
            writes.push(input);
            if (mode === 'unknown') return route.abort('failed');
            settings = {
              ...settings,
              revision: settings.revision + 1,
              identity:
                input.action === 'replace'
                  ? {
                      login: 'semiok',
                      userId: 901,
                      revision: settings.revision + 1,
                    }
                  : null,
              verifiedAt:
                input.action === 'replace' ? new Date().toISOString() : null,
              configured: input.action === 'replace',
              state:
                input.action === 'replace' ? 'configured' : 'not_configured',
              lastWriteRequestId: input.requestId,
              updatedAt: new Date().toISOString(),
            };
            if (mode === 'lost_ack') return route.abort('failed');
          }
          return route.fulfill({ json: settings });
        },
      );
      await page.goto(
        'http://127.0.0.1:' + (server.address() as { port: number }).port,
      );
      await initialStarted;
      await page.getByText('GitHub 提交账号 · 读取中', { exact: true }).click();
      await page.getByRole('button', { name: '刷新 GitHub 授权' }).click();
      await page
        .getByText('GitHub 提交账号 · 未配置', { exact: true })
        .waitFor();
      const field = page.getByLabel('GitHub 个人令牌'),
        save = page.getByRole('button', { name: '保存 GitHub 授权' }),
        remove = page.getByRole('button', { name: '移除 GitHub 授权' });
      expect(await page.getByLabel('GitHub 用户名').inputValue()).toBe(
        'semiok',
      );
      const creation = new URL(
        (await page
          .getByRole('link', { name: '创建 GitHub 细粒度令牌' })
          .getAttribute('href'))!,
      );
      expect(creation.origin + creation.pathname).toBe(
        'https://github.com/settings/personal-access-tokens/new',
      );
      expect(Object.fromEntries(creation.searchParams)).toEqual({
        name: 'AllRice-maintenance',
        target_name: 'semiok',
        expires_in: '30',
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        actions: 'read',
      });
      expect(await page.locator('body').innerText()).toContain(
        '只需在这里授权一次',
      );
      expect(await page.locator('body').innerText()).toContain(
        '仅选择 allrice',
      );
      expect(await save.isDisabled()).toBe(true);
      await field.fill(token);
      await save.click();
      await page.getByText('已回读确认配置结果。', { exact: true }).waitFor();
      expect(await field.inputValue()).toBe('');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ expectedLogin: 'semiok' });
      expect(await page.locator('body').innerText()).not.toContain(token);
      expect(await page.getByText('GitHub 账号与仓库身份已核对').count()).toBe(
        1,
      );
      releaseInitial();
      await initialCompleted;
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      expect(
        await page
          .getByText('GitHub 提交账号 · 已配置', { exact: true })
          .count(),
      ).toBe(1);
      expect(await remove.isEnabled()).toBe(true);
      mode = 'unknown';
      await remove.click();
      await page
        .getByText('配置结果尚未确认，请刷新核对。', { exact: false })
        .waitFor();
      expect(writes).toHaveLength(2);
      expect(await remove.isDisabled()).toBe(true);
      await page.getByRole('button', { name: '刷新 GitHub 授权' }).click();
      await page
        .getByText('已读取当前配置，上次请求未确认。', { exact: false })
        .waitFor();
      expect(writes).toHaveLength(2);
      mode = 'accept';
      await remove.click();
      await page.getByText('GitHub 授权已移除。', { exact: true }).waitFor();
      expect(writes).toHaveLength(3);
      expect(writes[2]!.requestId).not.toBe(writes[1]!.requestId);
      expect(writes[2]!).not.toHaveProperty('token');
      expect(settings.state).toBe('not_configured');
      expect(errors).toEqual([]);
    } finally {
      releaseInitial();
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30000);
});
