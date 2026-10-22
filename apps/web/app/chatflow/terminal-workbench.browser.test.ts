/** Actual pinned DSH model and xterm in Chrome; synthetic Host isolates browser
 * transport/lifetime checks. Real PTY and database authority run separately. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import {
  type TerminalNativeFrameSchema,
  WorkbenchTerminalBrowserFrameSchema,
  type TerminalTarget,
  type TerminalStreamMode,
} from '@allrice/contracts';
import { nativeTerminalAssetResponse } from '../../lib/chatflow/native-terminal-asset';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const target: TerminalTarget = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  sessionId: '44444444-4444-4444-8444-444444444444',
  deviceId: '55555555-5555-4555-8555-555555555555',
  grantId: '66666666-6666-4666-8666-666666666666',
  loginSessionId: '77777777-7777-4777-8777-777777777777',
  grantVersion: 1,
  rootFingerprint: 'a'.repeat(64),
  label: 'AI-what',
};
type Frame = ReturnType<typeof TerminalNativeFrameSchema.parse>;
type Info = Extract<Frame, { type: 'snapshot' }>['info'];
type FixtureState = {
  processes: Map<string, { info: Info; screen: string; sequence: number }>;
  creates: number;
  closes: number;
  failClose?: boolean;
  connections: number;
  screenRequests: number;
  inputs: Array<{ type: string; sequence: number; data?: string }>;
  errors: string[];
  streamMode: TerminalStreamMode;
  nextCredits: number;
};

suite('official terminal browser adapter', { timeout: 30000 }, () => {
  let browser: Browser, origin: string, server: ReturnType<typeof createServer>;
  const fixtures = new Map<string, FixtureState>();
  beforeAll(async () => {
    const require = createRequire(resolve(root, 'package.json'));
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const output = await build({
      entryPoints: [resolve(root, 'apps/web/test/workbench-terminal-page.tsx')],
      bundle: true,
      write: false,
      outdir: '/unused-terminal-ui',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      alias: {
        '@allrice/contracts': resolve(root, 'packages/contracts/src/index.ts'),
      },
      nodePaths: [
        resolve(root, 'apps/web/node_modules'),
        resolve(root, 'node_modules'),
      ],
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    });
    const javascript = output.outputFiles.find((file: { path: string }) =>
      file.path.endsWith('.js'),
    ).contents;
    const stylesheet = output.outputFiles.find((file: { path: string }) =>
      file.path.endsWith('.css'),
    ).contents;
    server = createServer(async (request, response) => {
      if (request.url === '/app.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(javascript);
        return;
      }
      if (request.url === '/app.css') {
        response.setHeader('content-type', 'text/css');
        response.end(stylesheet);
        return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path.startsWith('/api/dsh-ui/terminal-')) {
        const name = path.slice('/api/dsh-ui/terminal-'.length);
        if (!['gateway', 'model', 'screen'].includes(name)) {
          response.writeHead(404);
          response.end();
          return;
        }
        const asset = await nativeTerminalAssetResponse(
          name as 'gateway' | 'model' | 'screen',
          new Request('http://localhost' + request.url),
        );
        response.writeHead(asset.status, Object.fromEntries(asset.headers));
        response.end(Buffer.from(await asset.arrayBuffer()));
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>:root{--dsw-alias-label-primary:#20242d;--dsw-alias-label-secondary:#606775;--dsw-alias-label-tertiary:#7c8390;--dsw-alias-bg-base:#fff;--dsw-alias-bg-l1:#fff;--dsw-alias-border-l2:#e2e5e9;--dsw-alias-border-l3:#d9dde4;--dsw-alias-border-l4:#eceef3;--dsw-alias-state-business-primary:#3478ef;--dsw-alias-interactive-bg-hover:#f3f5f8;color-scheme:light}*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    const { WebSocketServer } = createRequire(
      resolve(root, 'apps/web/package.json'),
    )('ws');
    const ws = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const token = /fixture=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1];
      const state = token ? fixtures.get(token) : undefined;
      if (!state) {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(
        request,
        socket,
        head,
        (client: {
          readyState: number;
          send: (data: string) => void;
          close: (code?: number) => void;
          on: (event: 'message', handler: (raw: Buffer) => void) => void;
        }) => {
          state.connections++;
          type Stream = {
            id: string;
            action: 'attach' | 'retain';
            pending: Frame[];
            credit: boolean;
            missing?: boolean;
          };
          const streams = new Map<string, Stream>();
          const send = (frame: unknown) => {
            if (client.readyState === 1) client.send(JSON.stringify(frame));
          };
          const deliver = (requestId: string, stream: Stream) => {
            if (
              (state.streamMode === 'push' || stream.credit) &&
              stream.missing
            ) {
              streams.delete(requestId);
              send({
                version: 1,
                type: 'terminal.finished',
                requestId,
                error: {
                  code: 'terminal/unavailable',
                  message: 'Missing process',
                },
              });
              return;
            }
            while (
              stream.pending.length &&
              (state.streamMode === 'push' || stream.credit)
            ) {
              stream.credit = false;
              send({
                version: 1,
                type: 'terminal.frame',
                requestId,
                frame: stream.pending.shift(),
              });
            }
          };
          send({
            version: 1,
            type: 'terminal.ready',
            target,
            deviceName: 'Fixture.local',
            ...(state.streamMode === 'push' ? { streamMode: 'push' } : {}),
          });
          client.on('message', (raw) => {
            try {
              const frame = WorkbenchTerminalBrowserFrameSchema.parse(
                JSON.parse(raw.toString()),
              );
              if (frame.type === 'terminal.cancel') {
                streams.delete(frame.requestId);
                return;
              }
              if (frame.type === 'terminal.next') {
                state.nextCredits++;
                if (state.streamMode === 'push')
                  throw Error('Push stream must not issue next credits');
                const stream = streams.get(frame.requestId);
                if (!stream || stream.credit)
                  throw Error('Unexpected duplicate stream credit');
                stream.credit = true;
                deliver(frame.requestId, stream);
                return;
              }
              if (frame.type === 'terminal.input') {
                const stream = streams.get(frame.requestId);
                if (!stream || stream.action !== 'attach')
                  throw Error('Input without output attachment');
                state.inputs.push(frame.input);
                const process = state.processes.get(stream.id);
                if (!process) {
                  stream.pending.push({
                    type: 'ack',
                    sequence: frame.input.sequence,
                    refusal: 'not-running',
                  });
                  deliver(frame.requestId, stream);
                  return;
                }
                if (frame.input.type === 'resize') {
                  process.info = {
                    ...process.info,
                    cols: frame.input.cols,
                    rows: frame.input.rows,
                  };
                  // The pinned native Host broadcasts resized state before ACK.
                  stream.pending.push({
                    type: 'state',
                    info: process.info,
                    writable: true,
                  });
                }
                stream.pending.push({
                  type: 'ack',
                  sequence: frame.input.sequence,
                });
                if (frame.input.type === 'write') {
                  const text =
                    frame.input.data === '\x03'
                      ? '^C\r\nnative% '
                      : frame.input.data === '\t'
                        ? 'TAB'
                        : frame.input.data;
                  process.screen += text;
                  stream.pending.push({
                    type: 'output',
                    sequence: ++process.sequence,
                    data: text,
                  });
                }
                deliver(frame.requestId, stream);
                return;
              }
              const args = frame.args as {
                id?: string;
                request?: { id: string; cols: number; rows: number };
                title?: string;
              };
              const result = (value: unknown) =>
                send({
                  version: 1,
                  type: 'terminal.result',
                  requestId: frame.requestId,
                  result: { ok: true, value },
                });
              if (frame.action === 'environment')
                result({
                  cwd: '/fixture/AI-what',
                  maxInputBytes: 65536,
                  maxBufferedBytes: 2 * 1024 * 1024,
                  maxCols: 500,
                  maxRows: 200,
                  scrollback: 1000,
                });
              else if (frame.action === 'shells')
                result([{ path: '/bin/zsh', args: ['-i'], name: 'zsh' }]);
              else if (frame.action === 'list')
                result(
                  [...state.processes.values()].map((value) => value.info),
                );
              else if (frame.action === 'create') {
                const request = args.request!;
                if (!state.processes.has(request.id)) {
                  state.creates++;
                  state.processes.set(request.id, {
                    info: {
                      id: request.id,
                      title: 'zsh',
                      shell: { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
                      cwd: '/fixture/AI-what',
                      cols: request.cols,
                      rows: request.rows,
                      state: 'running',
                      exitCode: null,
                    },
                    sequence: 0,
                    screen: 'native% ',
                  });
                }
                result(state.processes.get(request.id)!.info);
              } else if (frame.action === 'close') {
                if (state.failClose)
                  send({
                    version: 1,
                    type: 'terminal.result',
                    requestId: frame.requestId,
                    result: {
                      ok: false,
                      error: {
                        code: 'gateway/internal',
                        message: 'Fixture close refused',
                      },
                    },
                  });
                else {
                  state.processes.delete(args.id!);
                  state.closes++;
                  result(undefined);
                }
              } else if (frame.action === 'rename') {
                state.processes.get(args.id!)!.info.title = args.title!;
                result(undefined);
              } else {
                const process = state.processes.get(args.id!);
                if (!process) {
                  streams.set(frame.requestId, {
                    id: args.id!,
                    action: frame.action as 'attach' | 'retain',
                    pending: [],
                    credit: false,
                    missing: true,
                  });
                  deliver(frame.requestId, streams.get(frame.requestId)!);
                  return;
                }
                const pending: Frame[] =
                  frame.action === 'retain'
                    ? [{ type: 'retained' }]
                    : [
                        {
                          type: 'snapshot',
                          sequence: process.sequence,
                          screen: process.screen,
                          info: process.info,
                          writable: true,
                          inputWindow: {
                            maxBytes: 2 * 1024 * 1024,
                            frameOverheadBytes: 256,
                          },
                        },
                      ];
                streams.set(frame.requestId, {
                  id: args.id!,
                  action: frame.action as 'attach' | 'retain',
                  pending,
                  credit: false,
                });
                deliver(frame.requestId, streams.get(frame.requestId)!);
              }
            } catch (error) {
              state.errors.push(
                error instanceof Error ? error.message : String(error),
              );
              client.close(1008);
            }
          });
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const { chromium } = createRequire(
      resolve(root, 'apps/worker/package.json'),
    )('playwright-core');
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
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  async function fixture(
    options: {
      waitForTerminal?: boolean;
      delayScreen?: Promise<void>;
      failModel?: boolean;
      streamMode?: TerminalStreamMode;
    } = {},
  ) {
    const token = randomUUID();
    const state: FixtureState = {
      processes: new Map(),
      creates: 0,
      closes: 0,
      inputs: [],
      errors: [],
      connections: 0,
      screenRequests: 0,
      streamMode: options.streamMode ?? 'pull',
      nextCredits: 0,
    };
    fixtures.set(token, state);
    const context = await browser.newContext({
      viewport: { width: 1100, height: 720 },
    });
    await context.addCookies([{ name: 'fixture', value: token, url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (options.delayScreen)
      await page.route('**/api/dsh-ui/terminal-screen?*', async (route) => {
        state.screenRequests++;
        await options.delayScreen;
        await route.continue();
      });
    if (options.failModel)
      await page.route('**/api/dsh-ui/terminal-model?*', (route) =>
        route.abort(),
      );
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    if (options.waitForTerminal !== false) {
      try {
        await page
          .locator('[data-sidebar-terminal] textarea')
          .waitFor({ state: 'attached' });
      } catch (error) {
        throw new Error(
          'Native terminal did not mount: ' +
            JSON.stringify({
              errors,
              host: state.errors,
              creates: state.creates,
              body: await page.locator('body').innerText(),
            }),
          { cause: error },
        );
      }
    }
    return {
      page,
      state,
      close: async () => {
        await context.close();
        fixtures.delete(token);
        expect(errors).toEqual([]);
        expect(state.errors).toEqual([]);
      },
    };
  }

  it('renders a continuous 205-key native burst in the official model/xterm without network credits', async () => {
    const f = await fixture({ streamMode: 'push' });
    try {
      const input = f.page.locator('[data-sidebar-terminal] textarea');
      await expect
        .poll(() =>
          input.evaluate(
            (element) => (element as HTMLTextAreaElement).readOnly,
          ),
        )
        .toBe(false);
      // Writable input does not prove that xterm has parsed its first snapshot.
      await expect
        .poll(
          async () =>
            (await f.page.locator('.xterm-rows').textContent())?.replace(
              /\s/gu,
              '',
            ) ?? '',
          { timeout: 5000 },
        )
        .toContain('native%');
      await input.pressSequentially('x'.repeat(205), { delay: 1 });
      await expect
        .poll(
          () =>
            f.state.inputs
              .filter((item) => item.type === 'write')
              .map((item) => item.data)
              .join(''),
          { timeout: 5000 },
        )
        .toBe('x'.repeat(205));
      await expect
        .poll(
          async () =>
            (await f.page.locator('.xterm-rows').textContent())?.replace(
              /\s/gu,
              '',
            ) ?? '',
          { timeout: 5000 },
        )
        .toContain('x'.repeat(205));
      await input.press('Tab');
      await input.press('Enter');
      await input.press('Control+c');
      await expect
        .poll(() =>
          f.state.inputs
            .filter((item) => item.type === 'write')
            .map((item) => item.data)
            .join(''),
        )
        .toBe('x'.repeat(205) + '\t\r\x03');
      expect(f.state.nextCredits).toBe(0);
      expect(f.state.creates).toBe(1);
    } catch (error) {
      console.error('Terminal burst fixture state', {
        inputBytes: f.state.inputs
          .filter((item) => item.type === 'write')
          .map((item) => item.data)
          .join('').length,
        host: [...f.state.processes.values()].map((process) => ({
          cols: process.info.cols,
          rows: process.info.rows,
          outputSequence: process.sequence,
        })),
        dom: await f.page.locator('.xterm-rows').evaluate((element) => ({
          displayedXCount: element.textContent?.match(/x/gu)?.length ?? 0,
          rect: element.getBoundingClientRect().toJSON(),
        })),
      });
      throw error;
    } finally {
      await f.close();
    }
  });

  it('passes raw Tab, Enter and Ctrl+C through official xterm and native ACK ordering', async () => {
    const f = await fixture();
    try {
      const input = f.page.locator('[data-sidebar-terminal] textarea');
      await input.waitFor({ state: 'attached' });
      await input.pressSequentially('hello');
      await input.press('Tab');
      await input.press('Enter');
      await input.press('Control+c');
      await expect
        .poll(() =>
          f.state.inputs
            .filter((input) => input.type === 'write')
            .map((input) => input.data)
            .join(''),
        )
        .toBe('hello\t\r\x03');
      expect(f.state.inputs.map((input) => input.sequence)).toEqual(
        f.state.inputs.map((_, index) => index + 1),
      );
      expect(f.state.creates).toBe(1);
      expect(
        await f.page.getByText('Fixture.local', { exact: true }).count(),
      ).toBe(1);
      expect(
        await f.page.getByText('/fixture/AI-what', { exact: true }).count(),
      ).toBe(1);
      expect(await f.page.getByPlaceholder('输入命令').count()).toBe(0);
      if (process.env.ALLRICE_TERMINAL_SCREENSHOT_PATH)
        await f.page.screenshot({
          path: process.env.ALLRICE_TERMINAL_SCREENSHOT_PATH,
          fullPage: true,
          style: '[data-test-controls]{display:none!important}',
        });
    } finally {
      await f.close();
    }
  });

  it('collapse and reload reattach the same identity; tab close terminates it once', async () => {
    const f = await fixture();
    try {
      await f.page
        .locator('[data-sidebar-terminal] textarea')
        .waitFor({ state: 'attached' });
      const id = [...f.state.processes.keys()][0];
      await f.page.getByRole('button', { name: '折叠或展开工作台' }).click();
      expect(f.state.closes).toBe(0);
      await f.page.getByRole('button', { name: '折叠或展开工作台' }).click();
      await f.page
        .locator('[data-sidebar-terminal] textarea')
        .waitFor({ state: 'attached' });
      await f.page.reload();
      await f.page
        .locator('[data-sidebar-terminal] textarea')
        .waitFor({ state: 'attached' });
      expect(f.state.creates).toBe(1);
      expect([...f.state.processes.keys()]).toEqual([id]);
      await f.page.getByRole('button', { name: '关闭终端标签' }).click();
      await expect.poll(() => f.state.closes).toBe(1);
      expect(f.state.processes.size).toBe(0);
      await expect
        .poll(() =>
          f.page.evaluate(
            () =>
              Object.keys(localStorage).filter((key) =>
                key.includes('.dsh.terminal.close.v1.'),
              ).length,
          ),
        )
        .toBe(0);
    } finally {
      await f.close();
    }
  });

  it('a missing restored terminal never allocates a replacement shell', async () => {
    const f = await fixture();
    try {
      await f.page
        .locator('[data-sidebar-terminal] textarea')
        .waitFor({ state: 'attached' });
      f.state.processes.clear();
      await f.page.reload();
      await f.page
        .getByRole('alert')
        .filter({ hasText: '此终端已不存在' })
        .waitFor();
      expect(f.state.creates).toBe(1);
      expect(
        await f.page
          .getByRole('button', { name: '新建终端', exact: true })
          .count(),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('keeps failed cleanup visible after the tab closes and retries the native durable intent', async () => {
    const f = await fixture();
    try {
      f.state.failClose = true;
      await f.page.getByRole('button', { name: '关闭终端标签' }).click();
      await f.page
        .getByRole('alert')
        .filter({ hasText: 'Fixture close refused' })
        .waitFor();
      expect(f.state.processes.size).toBe(1);
      expect(
        await f.page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.includes('.dsh.terminal.close.v1.'),
            ).length,
        ),
      ).toBe(1);
      f.state.failClose = false;
      await f.page.getByRole('button', { name: '重试结束' }).click();
      await expect.poll(() => f.state.closes).toBe(1);
      expect(f.state.processes.size).toBe(0);
      await expect.poll(() => f.page.getByRole('alert').count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('a delayed old owner never creates a carrier and cannot remove the new A-to-B-to-A runtime', async () => {
    let release!: () => void;
    const delayScreen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ waitForTerminal: false, delayScreen });
    try {
      await expect.poll(() => f.state.screenRequests).toBe(1);
      await f.page.getByRole('button', { name: '切换账号' }).click();
      await expect
        .poll(() => f.page.getByLabel('当前账号').textContent())
        .toBe('99999999-9999-4999-8999-999999999999');
      await f.page.getByRole('button', { name: '切换账号' }).click();
      await expect
        .poll(() => f.page.getByLabel('当前账号').textContent())
        .toBe(target.ownerId);
      release();
      await f.page
        .locator('[data-sidebar-terminal] textarea')
        .waitFor({ state: 'attached' });
      expect(f.state.connections).toBe(1);
      expect(f.state.creates).toBe(1);
      await f.page.getByRole('button', { name: '关闭终端标签' }).click();
      await expect.poll(() => f.state.closes).toBe(1);
      expect(f.state.connections).toBe(1);
    } finally {
      release();
      await f.close();
    }
  });

  it('asset failure while closing stays visible and retryable without an unhandled rejection or shell allocation', async () => {
    const f = await fixture({ waitForTerminal: false, failModel: true });
    try {
      await f.page
        .getByRole('status')
        .filter({ hasText: '原生组件加载失败' })
        .waitFor();
      await f.page.getByRole('button', { name: '关闭终端标签' }).click();
      await f.page
        .getByRole('alert')
        .filter({ hasText: '原生组件加载失败' })
        .waitFor();
      expect(f.state.creates).toBe(0);
      await f.page.unroute('**/api/dsh-ui/terminal-model?*');
      await f.page.getByRole('button', { name: '重试结束' }).click();
      await expect.poll(() => f.page.getByRole('alert').count()).toBe(0);
      expect(f.state.creates).toBe(0);
    } finally {
      await f.close();
    }
  });
});
