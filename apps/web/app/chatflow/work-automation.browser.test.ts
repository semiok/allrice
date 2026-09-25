import type * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import type { RequestContext } from '@allrice/contracts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture';
import { createCloudExecutionFixture } from '../../../../packages/database/src/cloud-execution.fixture';
import { GET, PATCH } from '../api/v1/me/work-automation/route';

let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
let context: RequestContext | null;
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: async () => context,
}));
vi.mock(
  '../../../../packages/database/src/core/client.ts',
  async (original) => ({
    ...(await original<typeof DatabaseClient>()),
    getDatabase: () => fixture.db,
  }),
);
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('member work settings: real browser, route and PostgreSQL', () => {
  let browser: Browser,
    server: Server,
    origin: string,
    storageRoot: string,
    workspaceId: string,
    gets = 0;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-work-settings-'));
    const f = await createCloudExecutionFixture(fixture.db, storageRoot);
    context = f.context;
    workspaceId = f.workspace;
    await fixture.db`delete from allrice_member_work_automation where organization_id=${f.org}`;
    await fixture.db`update allrice_memberships set role='member' where organization_id=${f.org}`;
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const assets = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WorkAutomationSettings} from './app/chatflow/work-automation-settings';createRoot(document.getElementById('root')).render(<WorkAutomationSettings workspaceId=${JSON.stringify(workspaceId)}/>);`,
        resolveDir: resolve('apps/web'),
        loader: 'tsx',
      },
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      bundle: true,
      write: false,
      outdir: '/unused-work-settings',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const js = assets.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.js'),
    ).text;
    const css = assets.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.css'),
    ).text;
    server = createServer((req, res) => {
      void (async () => {
        const path = new URL(req.url!, origin).pathname;
        if (path === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(
            `<meta name="viewport" content="width=device-width"><style>${css}</style><div id="root"></div><script src="/app.js"></script>`,
          );
          return;
        }
        if (path === '/app.js') {
          res.setHeader('content-type', 'application/javascript');
          res.end(js);
          return;
        }
        if (path !== '/api/v1/me/work-automation') {
          res.statusCode = 404;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (req.method === 'GET') gets++;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (value)
            headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const request = new Request(new URL(req.url!, origin), {
          method: req.method,
          headers,
          ...(req.method === 'PATCH' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await (req.method === 'PATCH' ? PATCH : GET)(request);
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await response.text());
      })().catch(() => {
        res.statusCode = 500;
        res.end('fixture failed');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('listener');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
    });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await fixture?.close();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });
  it('ordinary member toggles the native switches, reloads persistence and sees a conflict without false success', async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(origin);
      const cloud = page.getByRole('switch', { name: '云端自动工作' });
      await cloud.waitFor();
      expect(await cloud.getAttribute('aria-checked')).toBe('true');
      expect(await page.getByRole('switch').count()).toBe(3);
      await cloud.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[role=switch]')
            ?.getAttribute('aria-checked') === 'false',
      );
      await page.reload();
      await cloud.waitFor();
      expect(await cloud.getAttribute('aria-checked')).toBe('false');
      const { updateWorkAutomation } =
        await import('../../../../packages/database/src/work-automation');
      await updateWorkAutomation(
        context!,
        workspaceId,
        { expectedRevision: 1, capability: 'computer', enabled: false },
        fixture.db,
      );
      await cloud.click();
      await page.getByRole('alert').waitFor();
      expect(await cloud.getAttribute('aria-checked')).toBe('false');
      await page.getByRole('button', { name: '重新读取' }).click();
      await page
        .getByRole('switch', { name: '我的电脑自动工作', checked: false })
        .waitFor();
      expect(
        await page
          .getByRole('switch', { name: '我的电脑自动工作' })
          .getAttribute('aria-checked'),
      ).toBe('false');
      const before = gets;
      await page.clock.install();
      await page.clock.fastForward(30000);
      expect(gets).toBe(before);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('route requires login, same origin, strict input and current member scope', async () => {
    const request = (body: unknown, originHeader = origin) =>
      new Request(
        `${origin}/api/v1/me/work-automation?workspaceId=${workspaceId}`,
        {
          method: 'PATCH',
          headers: { origin: originHeader, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    expect(
      (
        await PATCH(
          request(
            { expectedRevision: 2, capability: 'cloud', enabled: true },
            'https://foreign.invalid',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await PATCH(
          request({
            expectedRevision: 2,
            capability: 'cloud',
            enabled: true,
            userId: 'forged',
          }),
        )
      ).status,
    ).toBe(400);
    const saved = context;
    context = null;
    expect(
      (
        await GET(
          new Request(
            `${origin}/api/v1/me/work-automation?workspaceId=${workspaceId}`,
          ),
        )
      ).status,
    ).toBe(401);
    context = saved;
    await fixture.db`update allrice_memberships set role='viewer' where user_id=${context!.actor.id}`;
    expect(
      (
        await PATCH(
          request({ expectedRevision: 2, capability: 'cloud', enabled: true }),
        )
      ).status,
    ).toBe(403);
  });
});
