import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('chat polling while reading, working and switching tabs', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/chat-polling-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const assets = new Map(
      result.outputFiles.map((f: { path: string; contents: Uint8Array }) => [
        f.path.slice(f.path.lastIndexOf('/')),
        f.contents,
      ]),
    );
    server = createServer((req, res) => {
      const asset = assets.get(req.url ?? '');
      res.setHeader(
        'content-type',
        req.url?.endsWith('.js') ? 'text/javascript' : 'text/html',
      );
      res.end(
        asset ??
          '<html><div id="root"></div><script type="module" src="/chat-polling-page.js"></script></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('fixture missing');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } =
      await import('../../../worker/node_modules/playwright-core/index.js');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => server?.close(() => done()));
  });
  async function fixture(
    options: {
      active?: boolean;
      hold?: boolean;
      timings?: boolean;
      pending?: boolean;
      failure?: boolean;
    } = {},
  ) {
    const page = await browser.newPage();
    await page.clock.install();
    const counts = { interactions: 0, devices: 0, quota: 0 };
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/interactions') || path.endsWith('/timings')) {
        const n = ++counts.interactions;
        if (options.hold && n === 1) await gate;
        if (options.failure) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({
          json: options.timings
            ? { inputs: [], runTimings: [] }
            : {
                runtime: {
                  state: options.active ? 'running' : 'idle',
                  runId: null,
                  turnId: null,
                  generation: 1,
                  configChecksum: `${path.includes('session-b') ? 'b' : 'a'}:${n}`,
                  currentVersionId: null,
                  nextVersionId: null,
                },
                inputs: [],
                runTimings: [],
                pendingActions: options.pending
                  ? [
                      {
                        approvalId: '11111111-1111-4111-8111-111111111111',
                        operationId: '22222222-2222-4222-8222-222222222222',
                        runId: '33333333-3333-4333-8333-333333333333',
                        expiresAt: '2027-01-01T00:00:00Z',
                      },
                    ]
                  : [],
              },
        });
      }
      if (path.endsWith('/devices')) {
        counts.devices++;
        return route.fulfill({ json: { devices: [] } });
      }
      if (path.endsWith('/monthly-quota')) counts.quota++;
      return route.fulfill({ status: 503, json: {} });
    });
    await page.goto(origin + (options.timings ? '/?timings' : '/'));
    await page.getByRole('button', { name: '刷新状态' }).waitFor();
    await expect.poll(() => counts.interactions).toBe(1);
    if (!options.hold && !options.failure)
      await page
        .getByTestId('snapshot')
        .getByText(options.timings ? 'timings-ready' : 'a:1', { exact: true })
        .waitFor();
    return {
      page,
      counts,
      release,
      close: async () => {
        release();
        await page.close();
      },
    };
  }
  async function visibility(page: Page, value: 'visible' | 'hidden') {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  }
  it('“我只是看已完成的对话”：36 seconds needs three reads, not nineteen', async () => {
    const f = await fixture();
    try {
      for (const n of [2, 3]) {
        await f.page.clock.runFor(16_000);
        await expect
          .poll(() => f.page.getByTestId('snapshot').textContent())
          .toBe(`a:${n}`);
      }
      await f.page.clock.runFor(4_000);
      expect(f.counts.interactions).toBe(3);
      expect(f.counts.devices).toBeLessThanOrEqual(3);
      expect(f.counts.quota).toBeLessThanOrEqual(2);
    } finally {
      await f.close();
    }
  });
  it.each([{ active: true }, { pending: true }])(
    'keeps the two-second cadence for active work or approval: %j',
    async (options) => {
      const f = await fixture(options);
      try {
        for (const n of [2, 3, 4]) {
          await f.page.clock.runFor(2_000);
          await expect
            .poll(() => f.page.getByTestId('snapshot').textContent())
            .toBe(`a:${n}`);
        }
        if (options.pending)
          await f.page.getByRole('link', { name: '查看并确认' }).waitFor();
      } finally {
        await f.close();
      }
    },
  );
  it('“我切走页面”：no polling while hidden, immediate read when returning', async () => {
    const f = await fixture({ active: true });
    try {
      await f.page.getByRole('button', { name: '已下载电脑助手' }).click();
      await visibility(f.page, 'hidden');
      const before = { ...f.counts };
      await f.page.clock.runFor(36_000);
      expect(f.counts).toEqual(before);
      await visibility(f.page, 'visible');
      await expect
        .poll(() => f.page.getByTestId('snapshot').textContent())
        .toBe('a:2');
      await expect.poll(() => f.counts.devices).toBe(before.devices + 1);
      await expect.poll(() => f.counts.quota).toBe(before.quota + 1);
    } finally {
      await f.close();
    }
  });
  it('“接口慢”：does not overlap polling requests and still allows an explicit refresh', async () => {
    const f = await fixture({ hold: true });
    try {
      await f.page.clock.runFor(12_000);
      expect(f.counts.interactions).toBe(1);
      await f.page.getByRole('button', { name: '刷新状态' }).click();
      await expect
        .poll(() => f.page.getByTestId('snapshot').textContent())
        .toBe('a:2');
      f.release();
      await f.page.clock.runFor(100);
      expect(await f.page.getByTestId('snapshot').textContent()).toBe('a:2');
    } finally {
      await f.close();
    }
  });
  it('switches session immediately and ignores the late old response', async () => {
    const f = await fixture({ hold: true });
    try {
      await f.page.getByRole('button', { name: '切换工作' }).click();
      await expect
        .poll(() => f.page.getByTestId('snapshot').textContent())
        .toBe('b:2');
      f.release();
      await f.page.clock.runFor(100);
      expect(await f.page.getByTestId('snapshot').textContent()).toBe('b:2');
    } finally {
      await f.close();
    }
  });
  it('keeps genuine errors visible and retries after two seconds', async () => {
    const f = await fixture({ failure: true });
    try {
      await f.page.getByRole('status').waitFor();
      await f.page.clock.runFor(4_000);
      await expect.poll(() => f.counts.interactions).toBeGreaterThan(1);
      expect(await f.page.getByRole('status').textContent()).toContain(
        '暂时读不到',
      );
    } finally {
      await f.close();
    }
  });
  it('also pauses the non-workbench timings endpoint in background tabs', async () => {
    const f = await fixture({ timings: true });
    try {
      await visibility(f.page, 'hidden');
      await f.page.clock.runFor(36_000);
      expect(f.counts.interactions).toBe(1);
      await visibility(f.page, 'visible');
      await expect.poll(() => f.counts.interactions).toBe(2);
    } finally {
      await f.close();
    }
  });
});
