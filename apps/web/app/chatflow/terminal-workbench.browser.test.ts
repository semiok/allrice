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
  closeRequests: number;
  failClose?: boolean;
  holdClose?: boolean;
  connections: number;
  readyConnections: number;
  authorize?: Promise<void>;
  interruptAuthorization?: () => void;
  endAuthorization?: () => void;
  authorizationRevoked?: boolean;
  screenRequests: number;
  inputs: Array<{ type: string; sequence: number; data?: string }>;
  shells: Array<{ path: string; args: string[]; name: string }>;
  shellRequests: number;
  shellsReady?: Promise<void>;
  errors: string[];
  streamMode: TerminalStreamMode;
  nextCredits: number;
};

function authorizationGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const [r, g, b] = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((channel) => {
        const value = Number(channel) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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
      if (path === '/api/v1/bridge/devices') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            devices: [
              {
                id: target.deviceId,
                // An old pairing's default name; people see only the computer name.
                name: 'Fixture.local · Rice Bridge',
                status: 'online',
                humanTerminalVersion: 2,
                folderGrants: [
                  { id: target.grantId, label: target.label },
                  {
                    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    label: 'Second folder',
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
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
        '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>:root{--dsw-alias-label-primary:#20242d;--dsw-alias-label-secondary:#606775;--dsw-alias-label-tertiary:#7c8390;--dsw-alias-bg-base:#fff;--dsw-alias-border-l2:#e2e5e9;--dsw-alias-border-l3:#d9dde4;--dsw-alias-border-l4:#eceef3;--dsw-alias-state-business-primary:#3478ef;--dsw-alias-interactive-bg-hover:#f3f5f8;color-scheme:light}*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
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
          state.interruptAuthorization = () => {
            send({
              version: 1,
              type: 'terminal.ended',
              error: {
                code: 'terminal/unavailable',
                message: 'HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE',
              },
            });
            client.close(4009);
          };
          state.endAuthorization = () => client.close(4403);
          if (state.authorizationRevoked) {
            client.close(4403);
            return;
          }
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
          let authorized = false;
          const ready = () => {
            authorized = true;
            state.readyConnections++;
            send({
              version: 1,
              type: 'terminal.ready',
              target: {
                ...target,
                sessionId:
                  new URL(request.url!, 'http://localhost').searchParams.get(
                    'sessionId',
                  ) ?? target.sessionId,
                grantId:
                  new URL(request.url!, 'http://localhost').searchParams.get(
                    'grantId',
                  ) ?? target.grantId,
              },
              deviceName: 'Fixture.local · Rice Bridge',
              ...(state.streamMode === 'push' ? { streamMode: 'push' } : {}),
            });
          };
          if (state.authorize) void state.authorize.then(ready);
          else ready();
          client.on('message', (raw) => {
            try {
              if (!authorized)
                throw Error('Request before fresh authorization');
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
              else if (frame.action === 'shells') {
                state.shellRequests++;
                if (state.shellsReady)
                  void state.shellsReady.then(() => result(state.shells));
                else result(state.shells);
              } else if (frame.action === 'list')
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
                state.closeRequests++;
                if (state.holdClose) return;
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
      guide?: boolean;
      shells?: FixtureState['shells'];
      rememberedShell?: string;
    } = {},
  ) {
    const token = randomUUID();
    const state: FixtureState = {
      processes: new Map(),
      creates: 0,
      closes: 0,
      closeRequests: 0,
      inputs: [],
      shells: options.shells ?? [
        { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
      ],
      shellRequests: 0,
      errors: [],
      connections: 0,
      readyConnections: 0,
      screenRequests: 0,
      streamMode: options.streamMode ?? 'pull',
      nextCredits: 0,
    };
    fixtures.set(token, state);
    const context = await browser.newContext({
      viewport: { width: 1100, height: 720 },
    });
    await context.addCookies([{ name: 'fixture', value: token, url: origin }]);
    if (options.rememberedShell) {
      const scope = JSON.stringify([
        target.organizationId,
        target.workspaceId,
        target.ownerId,
        target.sessionId,
        target.deviceId,
        target.grantId,
      ]);
      await context.addInitScript(
        ({ key, value }) => localStorage.setItem(key, value),
        {
          key: `allrice.terminal.native.v1.${scope}.dsh.terminal.shell`,
          value: options.rememberedShell,
        },
      );
    }
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
    await page.goto(origin + (options.guide ? '/?guide' : ''), {
      waitUntil: 'domcontentloaded',
    });
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
      expect(await f.page.getByText(/Rice Bridge/).count()).toBe(0);
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

  it.each(['pull', 'push'] as const)(
    'recovers the same native process after temporary authority loss in %s mode',
    async (streamMode) => {
      const f = await fixture({ streamMode });
      const authority = authorizationGate();
      try {
        const input = f.page.locator('[data-sidebar-terminal] textarea');
        const writes = () =>
          f.state.inputs
            .filter((item) => item.type === 'write')
            .map((item) => item.data)
            .join('');
        await expect
          .poll(() =>
            input.evaluate(
              (element) => (element as HTMLTextAreaElement).readOnly,
            ),
          )
          .toBe(false);
        await input.pressSequentially('before');
        await expect.poll(writes).toBe('before');
        await f.page.getByRole('button', { name: '断连时调整终端' }).click();
        await f.page.getByRole('button', { name: '已安排断连调整' }).waitFor();
        const id = [...f.state.processes.keys()][0];
        f.state.authorize = authority.promise;
        f.state.interruptAuthorization!();
        await f.page
          .getByRole('status')
          .filter({ hasText: '终端授权暂时无法验证' })
          .waitFor();
        await expect
          .poll(() =>
            input.evaluate(
              (element) => (element as HTMLTextAreaElement).readOnly,
            ),
          )
          .toBe(true);
        await input.pressSequentially('ignored');
        await expect.poll(() => f.state.connections, { timeout: 5000 }).toBe(2);
        expect(f.state.readyConnections).toBe(1);
        expect(writes()).toBe('before');
        expect(f.state.creates).toBe(1);
        expect([...f.state.processes.keys()]).toEqual([id]);
        expect(
          await f.page
            .getByText('HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE')
            .count(),
        ).toBe(0);

        authority.resolve();
        await expect
          .poll(() =>
            input.evaluate(
              (element) => (element as HTMLTextAreaElement).readOnly,
            ),
          )
          .toBe(false);
        await expect
          .poll(() => f.page.locator('.xterm-rows').textContent())
          .toContain('before');
        await input.pressSequentially('after');
        await expect.poll(writes).toBe('beforeafter');
        expect(f.state.creates).toBe(1);
        expect([...f.state.processes.keys()]).toEqual([id]);
        await expect
          .poll(() => f.page.getByText('终端已连接', { exact: true }).count())
          .toBe(1);
      } catch (error) {
        console.error('Terminal authorization recovery fixture state', {
          streamMode,
          connections: f.state.connections,
          readyConnections: f.state.readyConnections,
          creates: f.state.creates,
          processes: [...f.state.processes.keys()],
          host: f.state.errors,
          body: await f.page.locator('body').innerText(),
        });
        throw error;
      } finally {
        authority.resolve();
        await f.close();
      }
    },
  );

  it('native reconnect reauthorizes an ended carrier and keeps the original process without replay', async () => {
    const f = await fixture();
    try {
      const input = f.page.locator('[data-sidebar-terminal] textarea');
      await expect.poll(() => input.isEditable()).toBe(true);
      await input.pressSequentially('before');
      await expect
        .poll(() =>
          f.state.inputs
            .filter((item) => item.type === 'write')
            .map((item) => item.data)
            .join(''),
        )
        .toBe('before');
      const id = [...f.state.processes.keys()][0];
      f.state.endAuthorization!();
      await f.page.getByText('连接已结束', { exact: true }).waitFor();
      await f.page
        .getByRole('button', { name: '重新连接', exact: true })
        .click();
      await expect.poll(() => input.isEditable()).toBe(true);
      await input.pressSequentially('after');
      await expect
        .poll(() =>
          f.state.inputs
            .filter((item) => item.type === 'write')
            .map((item) => item.data)
            .join(''),
        )
        .toBe('beforeafter');
      expect(f.state.connections).toBe(2);
      expect(f.state.creates).toBe(1);
      expect([...f.state.processes.keys()]).toEqual([id]);
    } finally {
      await f.close();
    }
  });

  it.each(['native reconnect', 'computer refresh'] as const)(
    '%s recovers the transport after Host restart and shows the missing original terminal without creating another shell',
    async (action) => {
      const f = await fixture();
      try {
        const input = f.page.locator('[data-sidebar-terminal] textarea');
        await expect.poll(() => input.isEditable()).toBe(true);
        f.state.processes.clear();
        f.state.endAuthorization!();
        await f.page.getByText('连接已结束', { exact: true }).waitFor();
        await f.page
          .getByRole('button', {
            name: action === 'native reconnect' ? '重新连接' : '刷新电脑状态',
            exact: true,
          })
          .click();
        await f.page
          .getByText('此终端已不存在，请新建终端。', { exact: true })
          .waitFor();
        await f.page
          .getByRole('button', { name: '新建终端', exact: true })
          .waitFor();
        await f.page.getByText('终端已连接', { exact: true }).waitFor();
        expect(f.state.connections).toBe(2);
        expect(f.state.creates).toBe(1);
        expect(f.state.processes.size).toBe(0);
        expect(f.state.inputs.filter((item) => item.type === 'write')).toEqual(
          [],
        );
      } finally {
        await f.close();
      }
    },
  );

  it('fresh recovery keeps a genuinely revoked authorization blocked', async () => {
    const f = await fixture();
    try {
      const input = f.page.locator('[data-sidebar-terminal] textarea');
      await expect.poll(() => input.isEditable()).toBe(true);
      f.state.authorizationRevoked = true;
      f.state.endAuthorization!();
      await f.page.getByText('连接已结束', { exact: true }).waitFor();
      await f.page
        .getByRole('button', { name: '重新验证并连接', exact: true })
        .click();
      await expect.poll(() => f.state.connections).toBe(2);
      await f.page.getByText('连接已结束', { exact: true }).waitFor();
      expect(f.state.readyConnections).toBe(1);
      expect(f.state.creates).toBe(1);
      expect(await input.isEditable()).toBe(false);
      expect(f.state.inputs.filter((item) => item.type === 'write')).toEqual(
        [],
      );
    } finally {
      await f.close();
    }
  });

  it('retains an interrupted close intent and explicitly retries it after fresh authorization', async () => {
    const f = await fixture({ streamMode: 'push' });
    const authority = authorizationGate();
    try {
      const id = [...f.state.processes.keys()][0];
      f.state.holdClose = true;
      await f.page.getByRole('button', { name: '关闭终端标签' }).click();
      await expect.poll(() => f.state.closeRequests).toBe(1);
      f.state.authorize = authority.promise;
      f.state.interruptAuthorization!();
      await f.page
        .getByRole('alert')
        .filter({ hasText: '终端授权暂时无法验证' })
        .waitFor();
      await expect.poll(() => f.state.connections, { timeout: 5000 }).toBe(2);
      expect(f.state.readyConnections).toBe(1);
      expect(f.state.closeRequests).toBe(1);
      expect([...f.state.processes.keys()]).toEqual([id]);
      expect(
        await f.page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.includes('.dsh.terminal.close.v1.'),
            ).length,
        ),
      ).toBe(1);

      f.state.holdClose = false;
      await f.page.getByRole('button', { name: '重试结束' }).click();
      expect(f.state.closeRequests).toBe(1);
      authority.resolve();
      await expect.poll(() => f.state.closes).toBe(1);
      expect(f.state.closeRequests).toBe(2);
      expect(f.state.creates).toBe(1);
      expect(f.state.processes.size).toBe(0);
      await expect.poll(() => f.page.getByRole('alert').count()).toBe(0);
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
      authority.resolve();
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

  it.each(['light', 'dark'] as const)(
    'preserves native missing-terminal button contrast inside the workbench in %s theme',
    async (theme) => {
      const f = await fixture();
      try {
        f.state.processes.clear();
        await f.page.reload();
        await f.page
          .getByRole('alert')
          .filter({ hasText: '此终端已不存在' })
          .waitFor();
        await f.page.emulateMedia({ colorScheme: theme });
        await f.page.evaluate((theme) => {
          document.documentElement.style.colorScheme = theme;
          document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
        }, theme);
        const button = f.page.getByRole('button', {
          name: '新建终端',
          exact: true,
        });
        for (const interaction of ['hover', 'focus'] as const) {
          if (interaction === 'hover') await button.hover();
          else {
            await button.press('Tab');
            await f.page.keyboard.press('Shift+Tab');
            await f.page.mouse.move(0, 0);
          }
          const colors = await button.evaluate((element) => {
            const css = getComputedStyle(element);
            return {
              foreground: css.color,
              background: css.backgroundColor,
              outline: css.outlineStyle,
            };
          });
          expect(
            contrastRatio(colors.foreground, colors.background),
          ).toBeGreaterThanOrEqual(4.5);
          if (interaction === 'focus') expect(colors.outline).not.toBe('none');
          if (process.env.ALLRICE_TERMINAL_UI_SCREENSHOT_DIR)
            await f.page.screenshot({
              path: resolve(
                process.env.ALLRICE_TERMINAL_UI_SCREENSHOT_DIR,
                `terminal-missing-${theme}-${interaction}.png`,
              ),
              fullPage: true,
              style: '[data-test-controls]{display:none!important}',
            });
        }
        expect(f.state.creates).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

  it.each(['light', 'dark'] as const)(
    'launches the detected default from one native guide card in %s theme',
    async (theme) => {
      const f = await fixture({
        guide: true,
        waitForTerminal: false,
        rememberedShell: '/bin/bash',
        shells: [
          { path: '/usr/local/bin/fish', name: 'fish', args: ['-i'] },
          { path: '/bin/bash', name: 'bash', args: ['-i'] },
        ],
      });
      try {
        await f.page
          .locator('[data-terminal-guide] small')
          .filter({ hasText: 'Fixture.local · AI-what' })
          .waitFor();
        await f.page.emulateMedia({ colorScheme: theme });
        await f.page.evaluate((theme) => {
          document.documentElement.style.colorScheme = theme;
          document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
        }, theme);
        const guide = f.page.locator('[data-terminal-guide]');
        const button = guide.getByRole('button', {
          name: '新建终端',
          exact: true,
        });
        expect(await guide.getByRole('button').count()).toBe(1);
        expect(await guide.locator('[aria-haspopup="menu"]').count()).toBe(0);
        expect(f.state.shellRequests).toBe(0);
        expect(f.state.creates).toBe(0);
        const geometry = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const parent = element.parentElement!.getBoundingClientRect();
          return {
            widthGap: parent.width - rect.width,
            heightGap: parent.height - rect.height,
            border: getComputedStyle(element).borderWidth,
          };
        });
        expect(geometry.widthGap).toBeLessThanOrEqual(2);
        expect(geometry.heightGap).toBeLessThanOrEqual(2);
        expect(geometry.border).toBe('0px');
        for (const interaction of ['hover', 'focus'] as const) {
          if (interaction === 'hover') await button.hover();
          else {
            await button.press('Tab');
            await f.page.keyboard.press('Shift+Tab');
            await f.page.mouse.move(0, 0);
          }
          if (interaction === 'focus')
            expect(
              await button.evaluate(
                (element) => getComputedStyle(element).outlineOffset,
              ),
            ).toBe('-2px');
          if (process.env.ALLRICE_TERMINAL_UI_SCREENSHOT_DIR)
            await f.page.screenshot({
              path: resolve(
                process.env.ALLRICE_TERMINAL_UI_SCREENSHOT_DIR,
                `terminal-guide-${theme}-${interaction}.png`,
              ),
              fullPage: true,
              style: '[data-test-controls]{display:none!important}',
            });
        }
        await button.click();
        await expect
          .poll(() =>
            f.page.getByLabel('新终端 Shell', { exact: true }).textContent(),
          )
          .toBe('/usr/local/bin/fish');
        expect(f.state.shellRequests).toBe(1);
        const secondGrant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        await guide
          .getByLabel('终端电脑与文件夹')
          .selectOption(`${target.deviceId}/${secondGrant}`);
        await button.click();
        await expect
          .poll(() => f.page.getByLabel('新终端授权文件夹').textContent())
          .toBe(secondGrant);
        expect(f.state.creates).toBe(0);
        expect(
          await f.page
            .getByRole('button', { name: '普通工作台按钮' })
            .evaluate((element) => getComputedStyle(element).borderWidth),
        ).toBe('1px');
      } finally {
        await f.close();
      }
    },
  );

  it.each(['session', 'inactive'] as const)(
    'cancels a delayed default-shell launch when the guide becomes %s',
    async (change) => {
      const f = await fixture({ guide: true, waitForTerminal: false });
      const shells = authorizationGate();
      try {
        await f.page
          .locator('[data-terminal-guide] small')
          .filter({ hasText: 'Fixture.local' })
          .waitFor();
        f.state.shellsReady = shells.promise;
        const launch = f.page.getByRole('button', {
          name: '新建终端',
          exact: true,
        });
        await launch.click();
        await expect.poll(() => f.state.shellRequests).toBe(1);
        await f.page
          .getByRole('button', {
            name: change === 'session' ? '切换终端会话' : '切换终端入口显示',
          })
          .click();
        await expect.poll(() => launch.getAttribute('aria-busy')).toBe('false');
        if (change === 'inactive')
          await f.page
            .getByRole('button', { name: '切换终端入口显示' })
            .click();
        await launch.click();
        await expect.poll(() => f.state.shellRequests).toBe(2);
        shells.resolve();
        await expect
          .poll(() => f.page.getByLabel('新终端启动次数').textContent())
          .toBe('1');
        expect(
          await f.page
            .getByLabel('新终端 Shell', { exact: true })
            .textContent(),
        ).toBe('/bin/zsh');
        expect(f.state.creates).toBe(0);
      } finally {
        shells.resolve();
        await f.close();
      }
    },
  );

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
