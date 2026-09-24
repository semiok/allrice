/** Real Chrome + React StrictMode + synthetic loopback HTTP. No DB/auth/model/Bridge. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type {
  Browser,
  BrowserContext,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const childId = '55555555-5555-4555-8555-555555555555';
const now = '2026-09-14T00:00:00.000Z';
type Pending = {
  path: string;
  body: Record<string, unknown>;
  response: ServerResponse;
};
function session(id: string) {
  return {
    id,
    title: id === A ? 'Session A' : id === B ? 'Session B' : 'Created Session',
    employeeAssignmentId: 'employee',
    employeeVersionId: 'version',
    visibility: 'private',
    updatedAt: now,
    archivedAt: null,
  };
}
function message(
  id: string,
  text: string,
  role = 'user',
  run: string | null = null,
  status = 'completed',
) {
  return { id, role, content: { text }, runId: run, status, createdAt: now };
}
function tree(status = 'cancel_requested') {
  return {
    rootRunId: runId,
    configuration: {
      mode: 'daily',
      allowAssistants: true,
      maxConcurrent: 2,
      maxDepth: 1,
      maxChildren: 4,
    },
    cancelRequested: false,
    instances: [
      {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nativeSessionId: runId,
        label: 'Rice',
        depth: 0,
        status: 'running',
        allowedTools: [],
        artifactNamespace: 'root',
        cancelRequestedAt: null,
        stoppedAt: null,
      },
      {
        runId: childId,
        parentRunId: runId,
        rootRunId: runId,
        nativeSessionId: childId,
        label: '资料核对',
        depth: 1,
        status,
        allowedTools: [],
        artifactNamespace: 'child',
        cancelRequestedAt: now,
        stoppedAt: status === 'canceled' ? now : null,
      },
    ],
    messages: [],
    results: [],
    budgets: [],
  };
}
function event(question = false) {
  return {
    schemaVersion: 3,
    eventId: 'event-1',
    organizationId: A,
    workspaceId: B,
    conversationId: null,
    runId,
    generation: 1,
    cursor: `${runId}:1`,
    sequence: 1,
    harness: 'dsh',
    type: 'harness.native',
    occurredAt: now,
    sourceEvent: question
      ? {
          type: 'session/user-question',
          payload: {
            questionId: 'question-1',
            questions: [
              {
                id: 'q1',
                question: '确认范围？',
                header: '范围',
                options: [{ label: '只读检查', description: '不修改文件' }],
                multiSelect: false,
              },
            ],
          },
        }
      : null,
    payload: question
      ? { turnId: 'turn-1' }
      : { presentation: 'think', label: '正在处理', status: 'started' },
  };
}

suite(
  'P26 composer ownership in real React/Chrome (synthetic HTTP only)',
  () => {
    let browser: Browser;
    let javascript: Uint8Array;
    let css: Uint8Array;
    beforeAll(async () => {
      const build = createRequire(require.resolve('tsx'))('esbuild').build;
      const baseline = process.env.ALLRICE_P26_BASELINE === '1';
      const result = await build({
        absWorkingDir: root,
        entryPoints: ['apps/web/test/p26-composer-page.tsx'],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false,
        outdir: '/unused-p26-output',
        jsx: 'automatic',
        define: {
          'process.env.NODE_ENV': '"development"',
          'process.env': '{}',
        },
        plugins: baseline
          ? [
              {
                name: 'unchanged-main-baseline',
                setup(build: {
                  onLoad: (
                    input: { filter: RegExp },
                    load: (args: { path: string }) => unknown,
                  ) => void;
                }) {
                  build.onLoad(
                    {
                      filter:
                        /\/chatflow\/(chatflow-client|use-session|use-attachments|session-selection|assistant-run-panel|use-assistant-session)\.(tsx|ts)$/,
                    },
                    ({ path }) => ({
                      contents: execFileSync(
                        'git',
                        [
                          'show',
                          `5d246ba7a85b5640121cbcc8dc1336f52d0a74df:${path.slice(root.length + 1)}`,
                        ],
                        { cwd: root, encoding: 'utf8' },
                      ),
                      loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
                      resolveDir: resolve(path, '..'),
                    }),
                  );
                },
              },
            ]
          : [],
      });
      javascript = result.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('.js'),
      ).contents;
      css = result.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('.css'),
      ).contents;
      const { chromium } = createRequire(
        resolve(root, 'apps/worker/package.json'),
      )('playwright-core');
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      });
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
    });

    async function fixture(
      options: {
        uploadPending?: boolean;
        running?: boolean;
        question?: boolean;
      } = {},
    ) {
      const pending: Pending[] = [];
      const reads: string[] = [];
      const writes: string[] = [];
      const streams = new Set<ServerResponse>();
      let assistantStatus = 'cancel_requested';
      const messages: Record<string, ReturnType<typeof message>[]> = {
        [A]: [message('history-a', 'Existing A')],
        [B]: [message('history-b', 'Existing B')],
        [C]: [],
      };
      if (options.running)
        messages[A]!.push(
          message('assistant-a', '', 'assistant', runId, 'pending'),
        );
      const answer = (
        response: ServerResponse,
        data: unknown,
        status = 200,
      ) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      const server = createServer(async (request, response) => {
        const url = new URL(request.url!, 'http://localhost');
        const path = url.pathname;
        if (path === '/') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
          );
          return;
        }
        if (path === '/fixture.js' || path === '/fixture.css') {
          response.writeHead(200, {
            'content-type': path.endsWith('.js')
              ? 'application/javascript'
              : 'text/css',
          });
          response.end(path.endsWith('.js') ? javascript : css);
          return;
        }
        if (path === '/favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method !== 'GET') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          writes.push(path);
          if (path.endsWith('/attachments') && !options.uploadPending) {
            answer(response, {
              attachment: {
                id: C,
                fileName: body.fileName,
                mediaType: body.mediaType,
                sizeBytes: 1,
              },
            });
            return;
          }
          pending.push({ path, body, response });
          return;
        }
        reads.push(request.url!);
        if (path === '/api/v1/workspace') {
          answer(response, {
            workspace: {
              organizationId: A,
              workspaceId: B,
              canAdminister: false,
              sessions: [session(A), session(B)],
              sessionModels: [A, B].map((sessionId) => ({
                sessionId,
                harness: 'dsh',
                provider: 'gemini',
                model: 'synthetic',
                reasoningEffort: 'high',
              })),
              employeeProfiles: [],
              employees: [
                {
                  id: 'employee',
                  employeeId: 'employee',
                  isDefault: true,
                  versions: [],
                  currentVersion: {
                    id: 'version',
                    manifest: {
                      name: 'Rice',
                      runtimePolicy: { harness: 'dsh', provider: 'gemini' },
                      capabilityBindings: { toolNames: ['assistant.delegate'] },
                    },
                  },
                },
              ],
            },
          });
          return;
        }
        if (path === '/api/v1/saas/capabilities') {
          answer(response, {
            capabilities: {
              schemaVersion: 1,
              roles: ['member'],
              surfaces: ['chatflow'],
              actions: [],
              features: { chatFlowV3: true, nativeHarnessEvents: true },
            },
          });
          return;
        }
        if (path === '/api/v1/bridge/devices') {
          answer(response, { devices: [] });
          return;
        }
        if (path === '/api/v1/files') {
          answer(response, {
            files: [
              {
                id: C,
                fileName: 'workspace-source.txt',
                mediaType: 'text/plain',
                sizeBytes: 1,
                category: 'uploads',
                visibility: 'private',
                deliverableVersion: null,
              },
            ],
          });
          return;
        }
        if (path === '/api/v1/runtime/assistants') {
          answer(
            response,
            url.searchParams.has('runId')
              ? { tree: tree(assistantStatus) }
              : {
                  trees:
                    options.running && url.searchParams.get('sessionId') === A
                      ? [tree(assistantStatus)]
                      : [],
                  nextCursor: null,
                },
          );
          return;
        }
        if (path.endsWith('/artifacts')) {
          answer(response, { artifacts: [], nextCursor: null });
          return;
        }
        if (path.endsWith('/interactions')) {
          answer(response, { runtime: null, pendingActions: [], inputs: [] });
          return;
        }
        if (path.endsWith('/timings')) {
          answer(response, { runTimings: [] });
          return;
        }
        if (path.endsWith('/events')) {
          if (url.searchParams.get('format') === 'json') {
            answer(response, { events: [] });
            return;
          }
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
          });
          response.write(
            `data: ${JSON.stringify(event(options.question))}\n\n`,
          );
          streams.add(response);
          response.on('close', () => streams.delete(response));
          return;
        }
        const id = path.split('/').at(-1)!;
        if (messages[id]) {
          answer(response, {
            history: {
              session: session(id),
              messages: messages[id],
              contextStatus: {
                percentage: 0,
                pressureTokens: 0,
                thresholdTokens: 40000,
                compactionDue: false,
              },
              nativeContextStatus: null,
            },
          });
          return;
        }
        if (path === '/api/v1/runtime/cloud-operations') {
          answer(response, { operations: [] });
          return;
        }
        answer(
          response,
          { error: { message: 'Unknown synthetic route' } },
          404,
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('Loopback fixture not listening');
      const origin = `http://127.0.0.1:${address.port}`;
      const context: BrowserContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const page: Page = await context.newPage();
      page.setDefaultTimeout(4000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}/?session=${A}`);
        await page.getByRole('button', { name: /^Session B/ }).waitFor();
        // Sidebar readiness precedes History: uploading into the temporary
        // empty-state composer can race its replacement by the active composer.
        await page.getByText('Existing A', { exact: true }).waitFor();
      } catch (cause) {
        const diagnostic = {
          errors,
          reads,
          text: await page.locator('body').innerText(),
        };
        await context.close();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        throw new Error(
          `Synthetic fixture failed: ${JSON.stringify(diagnostic)}`,
          { cause },
        );
      }
      return {
        page,
        context,
        pending,
        reads,
        writes,
        errors,
        setAssistantStatus(value: string) {
          assistantStatus = value;
        },
        disconnect() {
          for (const response of streams) response.destroy();
        },
        async choose(id: string) {
          await page
            .getByRole('button', {
              name: id === A ? /^Session A/ : /^Session B/,
            })
            .click();
          await expect
            .poll(() => page.getByRole('heading', { level: 1 }).textContent())
            .toContain(id === A ? 'Session A' : 'Session B');
        },
        async send(text: string, attachment?: string) {
          if (attachment)
            await page.locator('input[type=file]').setInputFiles({
              name: attachment,
              mimeType: 'text/plain',
              buffer: Buffer.from('test'),
            });
          await page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .fill(text);
          await page.getByRole('button', { name: '发送', exact: true }).click();
        },
        async waitPending(count: number) {
          await expect
            .poll(() => pending.length, { timeout: 5000 })
            .toBe(count);
        },
        async respond(index: number, ok = true) {
          const p = pending[index]!;
          const received = page.waitForResponse(
            (response) =>
              response.request().method() !== 'GET' &&
              new URL(response.url()).pathname === p.path &&
              response.request().postData() === JSON.stringify(p.body),
          );
          reply();
          await received;
          // Wait past body parsing, promise continuations and React's commit. An
          // assertion against an already-visible draft must not race the reply.
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
          );
          function reply() {
            if (!ok) {
              answer(
                p.response,
                { error: { message: 'Synthetic old request failed' } },
                503,
              );
              return;
            }
            if (p.path === '/api/v1/sessions') {
              answer(p.response, { session: session(C) });
              return;
            }
            if (p.path.endsWith('/attachments')) {
              answer(p.response, {
                attachment: {
                  id: C,
                  fileName: p.body.fileName,
                  mediaType: p.body.mediaType,
                  sizeBytes: 1,
                },
              });
              return;
            }
            if (p.body.userQuestionAnswer) {
              answer(p.response, {
                run: { id: runId },
                delivery: 'steer_pending',
              });
              return;
            }
            const id = p.path.split('/')[4]!;
            const userMessage = message(`user-${index}`, String(p.body.text));
            const assistantMessage = message(
              `assistant-${index}`,
              'Synthetic receipt',
              'assistant',
            );
            messages[id]?.push(userMessage, assistantMessage);
            answer(p.response, {
              run: { id: runId },
              fallbackRunId: null,
              delivery: 'follow_up',
              userMessage,
              assistantMessage,
            });
          }
        },
        async close() {
          await context.close();
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      };
    }

    it('late successful A POST preserves B draft/attachments and never cancels or resumes A', async () => {
      const f = await fixture();
      try {
        await f.send('A submitted', 'A.txt');
        await f.waitPending(1);
        await f.choose(B);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('B untouched');
        await f.page.locator('input[type=file]').setInputFiles({
          name: 'B.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('new'),
        });
        await f.respond(0);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          )
          .toBe('B untouched');
        await f.page.getByText('B.txt', { exact: true }).waitFor();
        expect(f.reads.some((url) => url.includes(`${runId}/events`))).toBe(
          false,
        );
        expect(f.writes.some((url) => url.endsWith('/cancel'))).toBe(false);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('late failed A POST cannot clear the busy owner or show errors while B is sending', async () => {
      const f = await fixture();
      try {
        await f.send('A submitted');
        await f.waitPending(1);
        await f.choose(B);
        await f.send('B submitted', 'B.txt');
        await f.waitPending(2);
        await f.respond(0, false);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .isDisabled(),
          )
          .toBe(true);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('');
        expect(
          await f.page.getByText('Synthetic old request failed').count(),
        ).toBe(0);
        await f.page.getByText('B.txt', { exact: true }).waitFor();
        await f.respond(1, false);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .isDisabled(),
          )
          .toBe(false);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('B submitted');
      } finally {
        await f.close();
      }
    }, 15_000);
    it('returning A→B→A never restores the old failed draft over a newer A draft', async () => {
      const f = await fixture();
      try {
        await f.send('A submitted');
        await f.waitPending(1);
        await f.choose(B);
        await f.choose(A);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('New A draft');
        await f.respond(0, false);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          )
          .toBe('New A draft');
        expect(
          await f.page.getByText('Synthetic old request failed').count(),
        ).toBe(0);
      } finally {
        await f.close();
      }
    }, 15_000);
    it.each([
      [
        'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      [
        'xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      [
        'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ],
    ])(
      'uploads %s Office attachments through the actual composer when browser MIME is generic',
      async (extension, mediaType) => {
        const f = await fixture({ uploadPending: true });
        try {
          const input = f.page.locator('input[type=file]');
          expect(await input.getAttribute('accept')).toContain(`.${extension}`);
          await input.setInputFiles({
            name: `template.${extension}`,
            mimeType: 'application/octet-stream',
            buffer: Buffer.from('synthetic binary'),
          });
          await f.send('请读取附件');
          await f.waitPending(1);
          expect(f.pending[0]!.path).toContain('/attachments');
          expect(f.pending[0]!.body.mediaType).toBe(mediaType);
          await f.respond(0);
          await f.waitPending(2);
          expect(f.pending[1]!.body.attachmentIds).toEqual([C]);
          await f.respond(1);
        } finally {
          await f.close();
        }
      },
      15_000,
    );

    it('navigation during attachment persistence does not submit the departed draft', async () => {
      const f = await fixture({ uploadPending: true });
      try {
        await f.send('Not yet submitted', 'old.txt');
        await f.waitPending(1);
        expect(f.pending[0]!.path).toContain('/attachments');
        await f.choose(B);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('B draft');
        await f.respond(0);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          )
          .toBe('B draft');
        expect(f.writes.filter((url) => url.endsWith('/messages'))).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('another New click invalidates a pending create without canceling the created server session', async () => {
      const f = await fixture();
      try {
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        await f.send('Create old task');
        await f.waitPending(1);
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('Keep new draft');
        await f.respond(0);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          )
          .toBe('Keep new draft');
        expect(f.writes).toEqual(['/api/v1/sessions']);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('late cancellation failure cannot poison another session or claim that work stopped', async () => {
      const f = await fixture({ running: true });
      try {
        await f.page
          .getByRole('button', { name: '停止本轮', exact: true })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.path).toContain(`${runId}/cancel`);
        await f.choose(B);
        await f.respond(0, false);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('B unchanged');
        expect(
          await f.page.getByText('Synthetic old request failed').count(),
        ).toBe(0);
        expect(
          await f.page
            .getByRole('button', { name: '停止本轮', exact: true })
            .count(),
        ).toBe(0);
        expect(f.writes).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('a network-failed cancellation is handled without an unhandled rejection or a fabricated stop (injected transport abort)', async () => {
      const f = await fixture({ running: true });
      try {
        await f.page.route(/\/api\/v1\/runs\/[^/]+\/cancel\?/, (route) =>
          route.abort('internetdisconnected'),
        );
        const failed = f.page.waitForEvent('requestfailed', (request) =>
          request.url().includes(`${runId}/cancel`),
        );
        await f.page
          .getByRole('button', { name: '停止本轮', exact: true })
          .click();
        await failed;
        await f.page.getByText('Failed to fetch', { exact: true }).waitFor();
        await f.page
          .getByRole('button', { name: '停止本轮', exact: true })
          .waitFor();
        expect(f.errors).toEqual([]);
        expect(f.writes).toHaveLength(0);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('a late assistant stop acknowledgement cannot refresh a different session after its panel unmounts', async () => {
      const f = await fixture({ running: true });
      try {
        await f.page
          .getByRole('button', {
            name: '取消整项任务（含所有助手）',
            exact: true,
          })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.body.action).toBe('cancel_root');
        await f.choose(B);
        const readsB = () =>
          f.reads.filter(
            (url) =>
              url.includes('/runtime/assistants?') &&
              url.includes(`sessionId=${B}`),
          ).length;
        await expect.poll(readsB).toBeGreaterThan(0);
        const before = readsB();
        await f.respond(0);
        expect(readsB()).toBe(before);
        expect(f.writes).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('late question failure cannot corrupt the new session draft or leave its composer busy', async () => {
      const f = await fixture({ running: true, question: true });
      try {
        await f.page.getByRole('radio', { name: /只读检查/ }).click();
        await f.page
          .getByRole('button', { name: '提交并继续', exact: true })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.body.userQuestionAnswer).toMatchObject({
          questionId: 'question-1',
        });
        await f.choose(B);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('B question-independent draft');
        await f.respond(0, false);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('B question-independent draft');
        expect(
          await f.page.getByText('Synthetic old request failed').count(),
        ).toBe(0);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .isDisabled(),
        ).toBe(false);
        expect(f.writes).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('a normally-created session adopts the sending owner and submits its first attachment/message once', async () => {
      const f = await fixture();
      try {
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        await f.send('First created task', 'first.txt');
        await f.waitPending(1);
        expect(f.pending[0]!.path).toBe('/api/v1/sessions');
        await f.respond(0);
        await f.waitPending(2);
        expect(f.pending[1]!.path).toBe(`/api/v1/sessions/${C}/messages`);
        expect(f.pending[1]!.body.attachmentIds).toEqual([C]);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .isDisabled(),
        ).toBe(true);
        await f.respond(1);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .isDisabled(),
        ).toBe(false);
        expect(
          await f.page.getByText('first.txt', { exact: true }).count(),
        ).toBe(0);
        expect(f.writes).toEqual([
          '/api/v1/sessions',
          `/api/v1/sessions/${C}/attachments`,
          `/api/v1/sessions/${C}/messages`,
        ]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('a late workspace-file attachment cannot enter the next session or clear its sending owner', async () => {
      const f = await fixture({ uploadPending: true });
      try {
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page.getByRole('menuitem', { name: /从工作区添加/ }).click();
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: '添加', exact: true })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.body).toEqual({ objectId: C });
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        await f.choose(B);
        await f.send('B owns current send');
        await f.waitPending(2);
        await f.respond(0);
        expect(
          await f.page
            .getByText('workspace-source.txt', { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .isDisabled(),
        ).toBe(true);
        await f.respond(1, false);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('B owns current send');
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('a late accepted question does not restart the departed stream or refresh another session', async () => {
      const f = await fixture({ running: true, question: true });
      try {
        await f.page.getByRole('radio', { name: /只读检查/ }).click();
        await f.page
          .getByRole('button', { name: '提交并继续', exact: true })
          .click();
        await f.waitPending(1);
        await f.choose(B);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('B keeps working');
        const oldStreams = f.reads.filter((url) =>
          url.includes(`${runId}/events`),
        ).length;
        await f.respond(0);
        expect(
          f.reads.filter((url) => url.includes(`${runId}/events`)),
        ).toHaveLength(oldStreams);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('B keeps working');
        expect(f.writes).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);
    it('real reload and offline→online restore persisted assistant status without inventing a stop ACK', async () => {
      const f = await fixture({ running: true });
      try {
        await f.page.getByText(/已请求停止不代表进程已退出/).waitFor();
        await f.page.reload();
        await f.page.getByText(/已请求停止不代表进程已退出/).waitFor();
        await f.context.setOffline(true);
        f.disconnect();
        const failedRead = await f.page.waitForEvent(
          'requestfailed',
          (request) => request.url().includes('/runtime/assistants'),
        );
        expect(failedRead.failure()).not.toBeNull();
        expect(
          await f.page.getByText(/已请求停止不代表进程已退出/).count(),
        ).toBe(1);
        f.setAssistantStatus('canceled');
        await f.context.setOffline(false);
        await expect
          .poll(() => f.page.getByText(/已请求停止不代表进程已退出/).count(), {
            timeout: 12_000,
          })
          .toBe(0);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20_000);
    it('an expanded assistant panel recovers after exhausting offline retries, with an authoritative stop ACK', async () => {
      const f = await fixture({ running: true });
      try {
        await f.page.getByText(/已请求停止不代表进程已退出/).waitFor();
        await f.page.getByText('分工、结果与消耗', { exact: true }).click();
        await expect
          .poll(
            () =>
              f.reads.filter(
                (url) =>
                  url.includes('/runtime/assistants?') &&
                  url.includes(`runId=${runId}`),
              ).length,
          )
          .toBeGreaterThan(0);
        const failedDetails: string[] = [];
        f.page.on('requestfailed', (request) => {
          if (
            request.url().includes(`runId=${runId}`) &&
            request.url().includes('/runtime/assistants?')
          )
            failedDetails.push(request.url());
        });
        await f.context.setOffline(true);
        f.disconnect();
        await expect
          .poll(() => failedDetails.length, { timeout: 15000 })
          .toBeGreaterThanOrEqual(3);
        expect(await f.page.getByText(/执行端已确认停止/).count()).toBe(0);
        f.setAssistantStatus('canceled');
        await f.context.setOffline(false);
        await f.page.getByText(/执行端已确认停止/).waitFor({ timeout: 7000 });
        expect(
          await f.page.getByText(/已请求停止不代表进程已退出/).count(),
        ).toBe(0);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 30_000);
  },
);
