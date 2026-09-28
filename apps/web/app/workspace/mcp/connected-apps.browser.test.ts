import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../../worker/node_modules/playwright-core/index.js';
import { McpConnectionSchema } from '@allrice/contracts';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const workspaceId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
suite('member connected-apps page', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const output = await build({
      absWorkingDir: process.cwd(),
      stdin: {
        contents: `import { createRoot } from 'react-dom/client'; import { ConnectedApps } from './connected-apps'; createRoot(document.getElementById('root')).render(<ConnectedApps workspaceId="${workspaceId}" />);`,
        resolveDir: resolve('apps/web/app/workspace/mcp'),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outdir: '/unused-connected-apps',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const asset = (suffix: string) =>
      output.outputFiles.find((f: { path: string }) => f.path.endsWith(suffix))
        ?.contents;
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      response.setHeader(
        'content-type',
        path === '/app.js'
          ? 'application/javascript'
          : path === '/app.css'
            ? 'text/css'
            : 'text/html',
      );
      response.end(
        path === '/app.js'
          ? asset('.js')
          : path === '/app.css'
            ? asset('.css')
            : '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('server');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });
  it('keeps cards mounted during connection, never sends credentials to chat, and deletes the connection', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [],
      writes: { action: string; bearerToken?: string }[] = [];
    let reads = 0;
    const connection = McpConnectionSchema.parse({
      id: connectionId,
      definitionId: connectionId,
      workspaceId,
      name: '工作资料',
      endpoint: 'https://mcp.example.test/mcp',
      enabled: true,
      revision: 1,
      credentialConfigured: false,
      credentialReference: 'synthetic',
      managed: true,
      shared: false,
      discoveryState: 'error',
      discoveryCode: 'MCP_AUTH_REQUIRED',
      checkedAt: null,
      tools: [],
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      expect(new URL(route.request().url()).pathname).toBe(
        '/api/v1/connections',
      );
      if (route.request().method() === 'PATCH') {
        const input = route.request().postDataJSON();
        writes.push(input);
        if (input.action === 'credential') {
          connection.discoveryState = 'queued';
          connection.discoveryCode = null;
          connection.credentialConfigured = true;
        }
        if (input.action === 'disconnect') connection.disconnected = true;
        if (input.action === 'delete') {
          connection.disconnected = true;
          connection.removed = true;
        }
        await route.fulfill({ json: { connection } });
      } else {
        reads++;
        await route.fulfill({ json: { connections: [connection] } });
      }
    });
    try {
      await page.goto(`${origin}/chatflow?session=${connectionId}`);
      await page.getByText('管理连接', { exact: true }).click();
      await page.getByRole('button', { name: '填写连接凭据' }).click();
      await page
        .getByLabel('应用访问令牌')
        .fill('synthetic-browser-only-token');
      await page.getByRole('button', { name: '保存并连接' }).click();
      await expect
        .poll(() => page.locator('article').innerText())
        .toContain('正在连接');
      await page
        .locator('article')
        .evaluate((node) => node.setAttribute('data-mounted', 'same'));
      connection.discoveryState = 'ready';
      connection.discoveryCode = null;
      await expect
        .poll(() => page.locator('article').innerText(), { timeout: 5000 })
        .toContain('已连接');
      expect(await page.locator('article').getAttribute('data-mounted')).toBe(
        'same',
      );
      expect(await page.locator('body').innerText()).not.toContain(
        'synthetic-browser-only-token',
      );
      expect(writes[0]?.bearerToken).toBe('synthetic-browser-only-token');
      const settled = reads;
      await page.waitForTimeout(1800);
      expect(reads).toBe(settled);
      await page.getByRole('button', { name: '断开连接' }).click();
      await expect
        .poll(() => page.locator('article').innerText())
        .toContain('已断开');
      await page.getByRole('button', { name: '删除连接' }).click();
      await expect.poll(() => page.locator('article').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);
  it('offers GitHub token setup before platform OAuth exists and sends Linear through native account login', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const writes: Record<string, unknown>[] = [];
    const connections: ReturnType<typeof McpConnectionSchema.parse>[] = [];
    await page.route('**/api/v1/connections**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/authorize')) {
        await route.fulfill({
          contentType: 'text/html',
          body: '<p>Official account login</p>',
        });
        return;
      }
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON();
        writes.push(input);
        const github = input.appId === 'github';
        const connection = McpConnectionSchema.parse({
          id: github ? connectionId : '44444444-4444-4444-8444-444444444444',
          definitionId: connectionId,
          workspaceId,
          name: github ? 'GitHub' : 'Linear',
          endpoint: github
            ? 'https://api.githubcopilot.com/mcp/'
            : 'https://mcp.linear.app/mcp',
          enabled: true,
          managed: true,
          shared: false,
          revision: 1,
          credentialConfigured: github,
          credentialReference: 'synthetic',
          discoveryState: github ? 'ready' : 'error',
          loginState: github ? 'none' : 'redirect',
          discoveryCode: github ? null : 'MCP_AUTH_REQUIRED',
          checkedAt: null,
          tools: [],
        });
        connections.push(connection);
        await route.fulfill({ json: { connection } });
      } else
        await route.fulfill({
          json: {
            connections,
            apps: {
              github: { oauthReady: false },
              linear: { oauthReady: true },
            },
          },
        });
    });
    try {
      await page.goto(`${origin}/chatflow?session=${connectionId}`);
      await page
        .getByRole('button', { name: '使用访问令牌连接', exact: true })
        .click();
      await page
        .getByLabel('GitHub 访问令牌')
        .fill('synthetic-github-personal-token');
      expect(
        await page.getByLabel('GitHub 访问令牌').getAttribute('type'),
      ).toBe('password');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole('button', { name: '保存并连接', exact: true })
        .click();
      await expect
        .poll(() => page.locator('article').innerText())
        .toContain('已连接');
      expect(writes[0]).toEqual({
        workspaceId,
        appId: 'github',
        method: 'token',
        bearerToken: 'synthetic-github-personal-token',
      });
      expect(await page.locator('body').innerText()).not.toContain(
        'synthetic-github-personal-token',
      );
      await page
        .getByRole('button', { name: '连接 Linear', exact: true })
        .click();
      await page.waitForURL('**/api/v1/connections/authorize?**');
      expect(writes[1]).toEqual({
        workspaceId,
        appId: 'linear',
        method: 'oauth',
        returnSessionId: connectionId,
      });
    } finally {
      await context.close();
    }
  }, 20000);
});
