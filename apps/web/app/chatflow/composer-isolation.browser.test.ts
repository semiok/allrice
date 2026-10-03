/** Real Chrome + React StrictMode + synthetic loopback HTTP. No DB/auth/model/Bridge. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  workspaceCapabilityIds,
  type TaskSuggestionDisplay,
  type TaskNextSteps,
  type WorkspaceReadiness,
} from '@allrice/contracts';
import type { Attachment, WorkspaceFile } from './chatflow-types';
import { createRequire } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
const nextAssignmentId = '77777777-7777-4777-8777-777777777777';
const nextVersionId = '88888888-8888-4888-8888-888888888888';
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
    const recommendationTimings: {
      chrome: string;
      platform: string;
      viewport: number;
      ms: number | null;
      samples: number;
    }[] = [];
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
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
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
      if (recommendationTimings.length) {
        const directory = resolve(
          root,
          '.local/met168-recommendation-evidence',
        );
        await mkdir(directory, { recursive: true });
        await writeFile(
          resolve(directory, 'click-to-draft.json'),
          JSON.stringify(
            {
              observedAt: new Date().toISOString(),
              headless: true,
              measurements: recommendationTimings,
            },
            null,
            2,
          ) + '\n',
        );
      }
    });

    async function fixture(
      options: {
        uploadPending?: boolean;
        bridgeFiles?: boolean;
        running?: boolean;
        question?: boolean;
        delayHistoryB?: boolean;
        immediateReply?: boolean;
        longHistory?: boolean;
        settled?: 'failed' | 'canceled';
        width?: number;
        workspaceFiles?: WorkspaceFile[];
        taskSuggestions?: TaskSuggestionDisplay[];
        nextSteps?: TaskNextSteps;
        delayNextStepsA?: boolean;
        readiness?: WorkspaceReadiness['capabilities'];
      } = {},
    ) {
      const pending: Pending[] = [];
      const reads: string[] = [];
      const writes: string[] = [];
      const streams = new Set<ServerResponse>();
      const uploaded = new Map<string, Attachment>();
      let nextSteps = options.nextSteps;
      let holdNextReply = false;
      let releaseHeldNextReply: (() => void) | undefined;
      let releaseNextStepsA!: () => void;
      const nextStepsGate = new Promise<void>((done) => {
        releaseNextStepsA = done;
      });
      const fixtureSession = (id: string) => ({
        ...session(id),
        ...(options.nextSteps
          ? { employeeAssignmentId: nextAssignmentId }
          : {}),
      });
      let releaseHistoryB!: () => void;
      const historyBGate = new Promise<void>((done) => {
        releaseHistoryB = done;
      });
      let assistantStatus = 'cancel_requested';
      let showTiming = false;
      const messages: Record<string, ReturnType<typeof message>[]> = {
        [A]: [message('history-a', 'Existing A')],
        [B]: [message('history-b', 'Existing B')],
        [C]: [],
      };
      if (options.longHistory)
        messages[A]!.unshift(
          ...Array.from({ length: 20 }, (_, i) =>
            message('old-' + i, 'Old paragraph. '.repeat(35), 'assistant'),
          ),
        );
      if (options.running || options.settled)
        messages[A]!.push(
          message(
            'assistant-a',
            '',
            'assistant',
            runId,
            options.settled ? 'failed' : 'pending',
          ),
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
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
          });
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
              ...(options.readiness || options.nextSteps
                ? { viewerId: C }
                : {}),
              canAdminister: false,
              sessions: [fixtureSession(A), fixtureSession(B)],
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
                  id: options.nextSteps ? nextAssignmentId : 'employee',
                  employeeId: 'employee',
                  isDefault: true,
                  versions: [],
                  currentVersion: {
                    id: options.nextSteps
                      ? nextVersionId
                      : options.readiness
                        ? C
                        : 'version',
                    taskSuggestions: options.taskSuggestions ?? [],
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
        if (path === '/api/v1/workspace/readiness' && options.readiness) {
          answer(response, {
            schemaVersion: 1,
            organizationId: A,
            workspaceId: B,
            viewerId: C,
            sessionId: url.searchParams.get('sessionId'),
            employeeVersionId: C,
            canAdminister: false,
            observedAt: now,
            basis: 'next_task',
            capabilities: options.readiness,
          });
          return;
        }
        if (path === '/api/v1/bridge/devices') {
          answer(response, {
            devices: options.bridgeFiles
              ? [
                  {
                    id: runId,
                    name: 'Synthetic Mac',
                    status: 'online',
                    folderGrants: [{ id: childId, label: '合成目录' }],
                    readiness: [
                      {
                        capability: 'local.file.select',
                        state: 'ready',
                        reason: 'ready',
                      },
                    ],
                  },
                ]
              : [],
          });
          return;
        }
        if (path === '/api/v1/files') {
          answer(response, {
            files: options.workspaceFiles ?? [
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
        if (path === '/api/v1/sessions' && options.taskSuggestions) {
          answer(response, {
            sessions: [session(A), session(B)],
            nextCursor: null,
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
        if (path.endsWith('/next-steps') && options.nextSteps) {
          const capturedSteps = nextSteps;
          if (holdNextReply && path.includes(`/${A}/`)) {
            holdNextReply = false;
            await new Promise<void>((done) => {
              releaseHeldNextReply = done;
            });
          }
          if (path.includes(`/${A}/`) && options.delayNextStepsA)
            await nextStepsGate;
          if (!capturedSteps) answer(response, { code: 'UNAVAILABLE' }, 503);
          else if (path.includes(`/${A}/`)) answer(response, capturedSteps);
          else
            answer(response, {
              ...capturedSteps,
              scope: {
                ...capturedSteps.scope,
                sessionId: B,
                sourceRunId: null,
              },
              state: 'idle',
              notice: '',
              suggestions: [],
              readableArtifactCount: 0,
            });
          return;
        }
        if (path.endsWith('/interactions')) {
          answer(response, {
            runtime: null,
            pendingActions: [],
            inputs: [],
            runTimings: showTiming
              ? [
                  {
                    runId,
                    timing: {
                      activeMs: 4000,
                      waitingMs: 0,
                      wallMs: 4000,
                      timeoutMs: 0,
                      remainingMs: null,
                      phase: 'active',
                      sources: [],
                      calls: null,
                    },
                  },
                ]
              : [],
          });
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
          if (id === B && options.delayHistoryB) await historyBGate;
          answer(response, {
            history: {
              session: fixtureSession(id),
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
        viewport: { width: options.width ?? 1440, height: 1000 },
        hasTouch: (options.width ?? 1440) < 760,
        ...(process.env.ALLRICE_TEST_DEV_STORAGE_STATE
          ? { storageState: process.env.ALLRICE_TEST_DEV_STORAGE_STATE }
          : {}),
      });
      const page: Page = await context.newPage();
      let closing = false;
      // Real Dev HTML/JS/CSS with only this page's API requests routed to the
      // fixture. No company messages, file uploads, or model runs are created.
      const liveOrigin = process.env.ALLRICE_TEST_DEV_ORIGIN;
      if (liveOrigin) {
        await page.route(`${liveOrigin}/api/v1/**`, async (route) => {
          const url = new URL(route.request().url());
          try {
            const response = await route.fetch({
              url: origin + url.pathname + url.search,
              // The loopback server has no authentication; never forward the
              // real Dev login cookie to a diagnostic transport.
              headers: { 'content-type': 'application/json' },
            });
            await route.fulfill({ response });
          } catch (error) {
            if (!closing) throw error;
          }
        });
      }
      page.setDefaultTimeout(4000);
      // Loading the development bundle can outlast interaction waits under CI load.
      page.setDefaultNavigationTimeout(15_000);
      // These races deliberately leave the current draft/upload. Accept only
      // the new, explicit discard warning; unexpected dialogs remain failures.
      page.on('dialog', async (dialog) => {
        expect(dialog.message()).toBe(
          '当前有尚未发送的消息或附件，切换工作会清空它们。继续吗？',
        );
        await dialog.accept();
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(
          liveOrigin
            ? `${liveOrigin}/chatflow?session=${A}`
            : `${origin}/?session=${A}`,
        );
        if ((options.width ?? 1440) >= 760)
          await page.getByRole('treeitem', { name: /^Session B/ }).waitFor();
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
        releaseNextStepsA,
        setNextSteps(value: TaskNextSteps | undefined) {
          nextSteps = value;
        },
        holdNextStepsReply() {
          holdNextReply = true;
        },
        releaseHeldNextReply() {
          releaseHeldNextReply?.();
        },
        errors,
        releaseHistoryB,
        showTiming() {
          showTiming = true;
        },
        finishRun() {
          for (const item of messages[A]!)
            if (item.runId === runId) {
              item.status = 'failed';
              item.content.text = '';
            }
          for (const response of streams) {
            response.end(
              `data: ${JSON.stringify({ ...event(), eventId: 'event-2', sequence: 2, cursor: `${runId}:2`, type: 'run.canceled', payload: {} })}\n\n`,
            );
          }
        },
        setAssistantStatus(value: string) {
          assistantStatus = value;
        },
        disconnect() {
          for (const response of streams) response.destroy();
        },
        async choose(id: string) {
          await page
            .getByRole('treeitem', {
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
          const sendButton = page.getByRole('button', {
            name: '发送',
            exact: true,
          });
          if (await sendButton.count()) await sendButton.click();
          else
            await page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .press('Enter');
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
            if (p.path === '/api/v1/bridge/files') {
              uploaded.set(C, {
                id: C,
                fileName: 'Bridge 原始资料.xlsx',
                mediaType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                sizeBytes: 8,
              });
              const file = {
                checksum: `sha256:${'a'.repeat(64)}`,
                version: `sha256:${'b'.repeat(64)}`,
                sizeBytes: 8,
                mediaType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              };
              answer(p.response, {
                id: runId,
                status: 'succeeded',
                summary: 'uploaded',
                errorCode: null,
                cancelRequested: false,
                deviceId: runId,
                folderGrantId: childId,
                output: {
                  contractVersion: 1,
                  status: 'uploaded',
                  path: 'Bridge 原始资料.xlsx',
                  file,
                  object: {
                    objectId: C,
                    fileName: 'Bridge 原始资料.xlsx',
                    checksum: file.checksum,
                    sizeBytes: file.sizeBytes,
                    mediaType: file.mediaType,
                    deliverableVersionId: null,
                    deliverableVersion: null,
                  },
                  platformUploaded: true,
                  localSaved: false,
                },
              });
              return;
            }
            if (p.path.endsWith('/attachments')) {
              uploaded.set(C, {
                id: C,
                fileName: String(p.body.fileName),
                mediaType: String(p.body.mediaType),
                sizeBytes: 1,
              });
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
            if (p.path.includes('/cancel')) {
              answer(p.response, { accepted: true });
              return;
            }
            const id = p.path.split('/')[4]!;
            const userMessage = {
              ...message(`user-${index}`, String(p.body.text)),
              attachments: ((p.body.attachmentIds as string[]) ?? []).flatMap(
                (id) => uploaded.get(id) ?? [],
              ),
            };
            const assistantMessage = message(
              `assistant-${index}`,
              options.immediateReply ? '' : 'Synthetic receipt',
              'assistant',
              options.immediateReply ? runId : null,
              options.immediateReply ? 'pending' : 'completed',
            );
            messages[id]?.push(userMessage, assistantMessage);
            answer(p.response, {
              run: { id: runId },
              fallbackRunId: null,
              delivery: options.immediateReply ? 'immediate' : 'follow_up',
              userMessage,
              assistantMessage,
            });
          }
        },
        async close() {
          closing = true;
          releaseHistoryB();
          server.closeAllConnections();
          await page.unrouteAll({ behavior: 'ignoreErrors' });
          await context.close();
          await new Promise<void>((done) => server.close(() => done()));
        },
      };
    }

    async function imageDraft(page: Page) {
      const data = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 320;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffd000';
        ctx.fillRect(0, 0, 640, 320);
        ctx.fillStyle = '#111';
        ctx.fillText('Allrice image send', 20, 50);
        return canvas.toDataURL('image/png');
      });
      await page.locator('input[type=file]').setInputFiles({
        name: 'image-send.png',
        mimeType: 'image/png',
        buffer: Buffer.from(data.split(',')[1]!, 'base64'),
      });
      await expect
        .poll(() =>
          page
            .getByRole('img', { name: 'image-send.png', exact: true })
            .evaluate(
              (img: HTMLImageElement) =>
                img.complete && img.naturalWidth === 640,
            ),
        )
        .toBe(true);
      return data;
    }

    it.each([1440, 390])(
      'hands image previews from composer to transcript without waiting or blank frames at %ipx',
      async (width) => {
        const f = await fixture({
          width,
          uploadPending: true,
          immediateReply: true,
        });
        let release!: () => void;
        const signing = new Promise<void>((resolve) => {
          release = resolve;
        });
        let signs = 0;
        try {
          const data = await imageDraft(f.page);
          const originalPreview = await f.page
            .getByRole('img', { name: 'image-send.png', exact: true })
            .getAttribute('src');
          await f.page.route('**/api/v1/files/*/sign', async (route) => {
            signs++;
            await signing;
            await route.fulfill({ json: { url: data } });
          });
          await f.send('检查图片连续显示');
          await f.waitPending(1);
          const image = f.page
            .locator('[id^="message-"]')
            .getByRole('img', { name: 'image-send.png', exact: true });
          await image.waitFor();
          expect(await image.getAttribute('src')).toBe(originalPreview);
          expect(
            await f.page.getByText('上传中', { exact: true }).count(),
          ).toBe(0);
          expect(
            await f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          ).toBe('');
          const before = await image.boundingBox();
          expect(before!.width / before!.height).toBeCloseTo(2, 1);
          await f.page.evaluate(() => {
            const state = {
              running: true,
              blanks: 0,
              frames: 0,
              failed: [] as unknown[],
            };
            Object.assign(window, { imageSendObservation: state });
            const check = () => {
              if (!state.running) return;
              const img = document.querySelector<HTMLImageElement>(
                '[id^="message-"] img[alt="image-send.png"]',
              );
              state.frames++;
              if (!img || !img.complete || img.naturalWidth !== 640) {
                state.blanks++;
                state.failed.push({
                  src: img?.src,
                  complete: img?.complete,
                  width: img?.naturalWidth,
                  id: img?.closest('[id]')?.id,
                });
              }
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
          await f.respond(0);
          await f.waitPending(2);
          expect(signs).toBe(0);
          await f.respond(1);
          await expect.poll(() => signs).toBe(1);
          expect(await image.getAttribute('src')).toBe(originalPreview);
          expect(
            await f.page.getByText('正在加载图片…', { exact: true }).count(),
          ).toBe(0);
          const admitted = await image.boundingBox();
          expect(admitted!.width).toBe(before!.width);
          expect(admitted!.height).toBe(before!.height);
          release();
          await expect
            .poll(() => image.getAttribute('src'))
            .not.toBe(originalPreview);
          await f.page.waitForFunction(
            () =>
              (
                window as unknown as {
                  imageSendObservation: { frames: number };
                }
              ).imageSendObservation.frames >= 15,
          );
          const observation = await f.page.evaluate(() => {
            const state = (
              window as unknown as {
                imageSendObservation: {
                  running: boolean;
                  blanks: number;
                  frames: number;
                };
              }
            ).imageSendObservation;
            state.running = false;
            return state;
          });
          expect(observation, JSON.stringify(observation)).toMatchObject({
            blanks: 0,
          });
          expect(signs).toBe(1); // acknowledgement + history refresh share the native cache.
          expect(
            f.writes.filter((path) => path.endsWith('/attachments')),
          ).toHaveLength(1);
          expect(
            f.writes.filter((path) => path.endsWith('/messages')),
          ).toHaveLength(1);
          await image.click();
          await f.page.getByRole('dialog', { name: '图片预览' }).waitFor();
          await f.page.keyboard.press('Escape');
          expect(
            await f.page.getByRole('dialog', { name: '图片预览' }).count(),
          ).toBe(0);
          if (width === 390)
            await f.page
              .getByRole('button', { name: '展开侧边栏', exact: true })
              .click();
          await f.choose(B);
          expect(
            await f.page
              .getByRole('img', { name: 'image-send.png', exact: true })
              .count(),
          ).toBe(0);
          expect(f.errors).toEqual([]);
        } finally {
          release();
          await f.close();
        }
      },
      20_000,
    );

    it('restores image and text on upload failure, then retries the attachment', async () => {
      const f = await fixture({ uploadPending: true });
      try {
        await imageDraft(f.page);
        await f.send('上传失败后重试');
        await f.waitPending(1);
        await f.respond(0, false);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('上传失败后重试');
        expect(
          await f.page
            .getByRole('group', { name: '待发送附件' })
            .getByRole('img')
            .evaluate(
              (img: HTMLImageElement) =>
                img.complete && img.naturalWidth === 640,
            ),
        ).toBe(true);
        await f.page.getByRole('button', { name: '重试', exact: true }).click();
        await f.send('上传失败后重试');
        await f.waitPending(2);
        expect(f.pending[1]!.path).toContain('/attachments');
        expect(f.pending[1]!.body.contentBase64).toBe(
          f.pending[0]!.body.contentBase64,
        );
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);

    it('keeps an image submission in the pending queue during upload without creating another assistant turn', async () => {
      const f = await fixture({ running: true, uploadPending: true });
      try {
        await imageDraft(f.page);
        await f.send('图片排到下一轮');
        await f.waitPending(1);
        const queue = f.page.locator('[data-queue-dock]');
        await queue.getByText(/图片排到下一轮/).waitFor();
        expect(
          await f.page.locator('[id^="message-optimistic-user:"]').count(),
        ).toBe(0);
        expect(
          await f.page.locator('[id^="message-optimistic-assistant:"]').count(),
        ).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);

    it('restores an image after failed message admission and retries without uploading it again', async () => {
      const f = await fixture({ uploadPending: true, immediateReply: true });
      try {
        const data = await imageDraft(f.page);
        await f.page.route('**/api/v1/files/*/sign', (route) =>
          route.fulfill({ json: { url: data } }),
        );
        await f.send('保留图片重试');
        await f.waitPending(1);
        await f.respond(0);
        await f.waitPending(2);
        const clientId = f.pending[1]!.body.clientMessageId;
        await f.respond(1, false);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('保留图片重试');
        const rail = f.page.getByRole('group', { name: '待发送附件' });
        expect(
          await rail
            .getByRole('img')
            .evaluate(
              (img: HTMLImageElement) =>
                img.complete && img.naturalWidth === 640,
            ),
        ).toBe(true);
        expect(
          await f.page.locator('[id^="message-optimistic-user:"]').count(),
        ).toBe(0);
        await f.send('保留图片重试');
        await f.waitPending(3);
        expect(f.pending[2]!.path).toContain('/messages');
        expect(f.pending[2]!.body.clientMessageId).toBe(clientId);
        await f.respond(2);
        expect(
          f.writes.filter((path) => path.endsWith('/attachments')),
        ).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);

    it('never displays the previous conversation while loading and switches retained histories without HTTP', async () => {
      const f = await fixture({ delayHistoryB: true });
      try {
        await f.choose(B);
        expect(
          await f.page.getByText('Existing A', { exact: true }).count(),
        ).toBe(0);
        await f.page.getByText('正在加载会话…', { exact: true }).waitFor();
        f.releaseHistoryB();
        await f.page.getByText('Existing B', { exact: true }).waitFor();
        // Both histories are now retained. Even failed refreshes cannot block
        // the first paint or reveal the other conversation's messages.
        await f.page.route(/\/api\/v1\/sessions\/[^/?]+\?/, (route) =>
          route.abort(),
        );
        for (const [title, expected, previous] of [
          ['Session A', 'Existing A', 'Existing B'],
          ['Session B', 'Existing B', 'Existing A'],
        ]) {
          const result = await f.page.evaluate(
            async ({ title, expected, previous }) => {
              const row = Array.from(
                document.querySelectorAll<HTMLElement>('[role=treeitem]'),
              ).find((el) => el.textContent?.includes(title!));
              if (!row) throw Error('Missing session row');
              row.click();
              await new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              );
              return {
                expected: document.body.innerText.includes(expected!),
                previous: document.body.innerText.includes(previous!),
              };
            },
            { title, expected, previous },
          );
          expect(result).toEqual({ expected: true, previous: false });
        }
        expect(
          await f.page.getByText('交互与任务记录', { exact: true }).count(),
        ).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it.each([1440, 390])(
      'keeps Rice identity anchored while the submitted turn receives its first status at %ipx',
      async (width) => {
        const f = await fixture({
          immediateReply: true,
          longHistory: true,
          width,
        });
        try {
          await f.send('A small greeting');
          await f.waitPending(1);
          const identity = () =>
            f.page.locator('[data-working="true"] > div').first();
          const geometry = () =>
            f.page.evaluate(() => {
              const node = document.querySelector('[data-working="true"]')!;
              const identity = node.firstElementChild!;
              const scroll = document.querySelector(
                '[data-conversation-scroll]',
              )!;
              return {
                top: identity.getBoundingClientRect().top,
                height: node.getBoundingClientRect().height,
                scroll: scroll.scrollTop,
                content: node.textContent,
              };
            });
          await identity().waitFor();
          await f.page.waitForTimeout(100);
          const before = await geometry();
          await f.respond(0);
          await f.page.waitForTimeout(500);
          const after = await geometry();

          expect(Math.abs(after.top - before.top)).toBeLessThan(1);
        } finally {
          await f.close();
        }
      },
    );

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

    it.each(['text/csv', 'application/octet-stream', ''])(
      'uploads Chinese CSV bytes and sends its attachment through the actual composer with browser MIME %j',
      async (mimeType) => {
        const f = await fixture({ uploadPending: true });
        const csv = Buffer.from(
          '\uFEFF编号,分类,金额\n00123,办公费用,1250.5\n00456,退款,-200\n00789,缺失,\n',
        );
        try {
          const input = f.page.locator('input[type=file]');
          expect(await input.getAttribute('accept')).toContain('.csv');
          // Playwright's file payload infers text/csv when MIME is empty.
          // Use the browser File API to exercise a genuinely absent MIME.
          const admittedType = await input.evaluate(
            (element, file) => {
              const transfer = new DataTransfer();
              transfer.items.add(
                new File([file.text], file.name, { type: file.mimeType }),
              );
              (element as HTMLInputElement).files = transfer.files;
              const type = transfer.files[0]!.type;
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return type;
            },
            { name: '中文图表 样本.csv', text: csv.toString(), mimeType },
          );
          expect(admittedType).toBe(mimeType);
          expect(f.pending).toHaveLength(0);
          await f.send('请绘制中文费用图表');
          await f.waitPending(1);
          expect(f.pending[0]!.path).toContain('/attachments');
          expect(f.pending[0]!.body.mediaType).toBe('text/csv');
          expect(f.pending[0]!.body.fileName).toBe('中文图表 样本.csv');
          expect(
            Buffer.from(f.pending[0]!.body.contentBase64 as string, 'base64'),
          ).toEqual(csv);
          await f.respond(0);
          await f.waitPending(2);
          expect(f.pending[1]!.path).toContain('/messages');
          expect(f.pending[1]!.body.attachmentIds).toEqual([C]);
          await f.respond(1);
        } finally {
          await f.close();
        }
      },
      15_000,
    );

    it.each([
      { visibility: 'workspace', selectAfterAdding: false },
      { visibility: 'private', selectAfterAdding: false },
      { visibility: 'private', selectAfterAdding: true },
    ] as const)(
      'defaults uploads to workspace and honors $visibility (change after adding: $selectAfterAdding)',
      async ({ visibility, selectAfterAdding }) => {
        const f = await fixture({ uploadPending: true });
        try {
          const scope = f.page.getByRole('combobox', {
            name: '上传文件可见范围',
          });
          expect(await scope.inputValue()).toBe('workspace');
          if (selectAfterAdding) {
            await f.page.locator('input[type=file]').setInputFiles({
              name: 'scope.txt',
              mimeType: 'text/plain',
              buffer: Buffer.from('synthetic visibility check'),
            });
          }
          if (visibility === 'private') await scope.selectOption('private');
          await f.send(
            '请读取附件',
            selectAfterAdding ? undefined : 'scope.txt',
          );
          await f.waitPending(1);
          expect(f.pending[0]!.path).toContain('/attachments');
          expect(f.pending[0]!.body.visibility).toBe(visibility);
          await f.respond(0);
          await f.waitPending(2);
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
    it.each([390, 1440])(
      'keeps the thinking row and composer stable across submit, timing and stop at %spx',
      async (width) => {
        const f = await fixture({ immediateReply: true, width });
        try {
          const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
          await input.fill('在吗');
          await f.page
            .getByRole('button', { name: '发送', exact: true })
            .click();
          await f.waitPending(1);
          const identity = f.page
            .locator('[class*="assistantIdentity"]')
            .last();
          await identity.waitFor();
          const geometry = async () => {
            const composer = await input.locator('..').boundingBox();
            const author = await identity.boundingBox();
            const process = await f.page
              .getByRole('region', { name: '工作过程', exact: true })
              .boundingBox();
            return {
              y: composer!.y,
              height: composer!.height,
              gap: composer!.y - author!.y,
              processHeight: process!.height,
            };
          };
          // Settle the ordinary new-message scroll, then measure only the state transition.
          await f.page.waitForTimeout(350);
          const submitting = await geometry();
          expect(
            await f.page
              .getByRole('button', { name: '停止生成', exact: true })
              .count(),
          ).toBe(0);
          await f.respond(0);
          await f.page
            .getByRole('button', { name: '停止生成', exact: true })
            .waitFor();
          await f.page.waitForTimeout(150);
          const running = await geometry();
          f.showTiming();
          await f.page.getByLabel('本轮运行时间', { exact: true }).waitFor();
          const timed = await geometry();
          if (process.env.ALLRICE_UI_EVIDENCE_DIR)
            await f.page.screenshot({
              path: `${process.env.ALLRICE_UI_EVIDENCE_DIR}/timed-${width}.png`,
            });
          for (const state of [running, timed]) {
            expect(Math.abs(state.y - submitting.y)).toBeLessThanOrEqual(1);
            expect(state.height).toBe(submitting.height);
            expect(Math.abs(state.gap - submitting.gap)).toBeLessThanOrEqual(1);
            expect(state.processHeight).toBe(submitting.processHeight);
          }
          await f.page
            .getByRole('button', { name: '停止生成', exact: true })
            .click();
          await f.waitPending(2);
          expect(
            await f.page
              .getByRole('button', { name: '正在停止', exact: true })
              .isDisabled(),
          ).toBe(true);
          await f.respond(1);
          f.finishRun();
          await f.page
            .getByRole('button', { name: '发送', exact: true })
            .waitFor();
          expect(await f.page.getByText('重新连接并恢复执行记录').count()).toBe(
            0,
          );
          expect(
            await f.page
              .getByRole('link', { name: '经验沉淀', exact: true })
              .count(),
          ).toBe(0);
          expect((await input.locator('..').boundingBox())!.height).toBe(
            submitting.height,
          );
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
      20_000,
    );

    it.each(['failed', 'canceled'] as const)(
      'opens settled %s history without a stop control or reconnect action',
      async (settled) => {
        const f = await fixture({ settled });
        try {
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .fill('尚未发送');
          await f.page.evaluate(() =>
            window.dispatchEvent(new Event('online')),
          );
          await f.page.waitForTimeout(150);
          expect(
            await f.page
              .getByRole('button', { name: '停止生成', exact: true })
              .count(),
          ).toBe(0);
          expect(await f.page.getByText('重新连接并恢复执行记录').count()).toBe(
            0,
          );
          expect(
            f.reads.filter(
              (url) => url.includes('/events') && !url.includes('format=json'),
            ),
          ).toEqual([]);
          expect(f.writes).toEqual([]);
        } finally {
          await f.close();
        }
      },
      15_000,
    );

    const weeklyTask: TaskSuggestionDisplay = {
      id: 'weekly-summary',
      title: '整理周报',
      template: '整理最近 {{days}} 天的工作，输出{{format}}。',
      slots: [
        {
          name: 'days',
          label: '天数',
          defaultValue: '7',
          options: ['7', '30'],
        },
        { name: 'format', label: '用途', defaultValue: '科研👩‍🔬总结' },
      ],
      preparation: ['files'],
    };
    async function selectSuggestion(
      page: Page,
      title: string,
      width = 1440,
      confirm = true,
    ) {
      await page.getByRole('button', { name: '常用任务', exact: true }).click();
      if (width < 760)
        await page
          .getByRole('dialog', { name: '常用任务', exact: true })
          .getByRole('button', { name: new RegExp(`^${title}`) })
          .click();
      else
        await page
          .getByRole('menuitem', { name: new RegExp(`^${title}`) })
          .click();
      if (
        confirm &&
        (await page.getByRole('dialog', { name: title, exact: true }).count())
      )
        await page
          .getByRole('dialog', { name: title, exact: true })
          .getByRole('button', { name: /^(填入输入框|追加到输入框)$/ })
          .click();
    }
    function nextStepsProof(
      title = '检查本轮成果',
      revision = 'a',
    ): TaskNextSteps {
      return {
        contractVersion: 1,
        scope: {
          organizationId: A,
          workspaceId: B,
          viewerId: C,
          sessionId: A,
          employeeAssignmentId: nextAssignmentId,
          employeeVersionId: nextVersionId,
          sourceRunId: runId,
          contextRevision: `sha256:${revision.repeat(64)}`,
        },
        state: 'succeeded',
        readableArtifactCount: 1,
        notice: '',
        suggestions: [
          {
            source: 'context-rule',
            task: {
              id: 'check-current-result',
              title,
              template: '读取这份已有成果，核对异常与依据；先不要修改原件。',
            },
            references: [
              {
                objectId: childId,
                versionId: runId,
                checksum: `sha256:${'c'.repeat(64)}`,
                fileName: '原成果{{参数}}.xlsx',
                mediaType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                sizeBytes: 12,
                visibility: 'private',
              },
            ],
          },
        ],
      };
    }
    const nextRows = (page: Page, width: number, title: string) =>
      width < 760
        ? page
            .getByRole('dialog', { name: '常用任务', exact: true })
            .getByRole('button', { name: new RegExp(`^${title}`) })
        : page.getByRole('menuitem', { name: new RegExp(`^${title}`) });
    it.each([1440, 390])(
      'next-step native menu/modal preserves draft/uploads and references existing bytes without sending at %ipx',
      async (width) => {
        const proof = nextStepsProof(),
          f = await fixture({
            width,
            taskSuggestions: [weeklyTask],
            nextSteps: proof,
            longHistory: true,
          });
        try {
          await expect
            .poll(() => f.reads.some((url) => url.includes('/next-steps')))
            .toBe(true);
          const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
          await input.fill('原草稿👩‍🔬\n保留 {{原文}}');
          await f.page.locator('input[type=file]').setInputFiles({
            name: '未上传.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('original draft attachment'),
          });
          await expect
            .poll(() =>
              f.page.getByTitle('未上传.txt', { exact: true }).count(),
            )
            .toBe(1);
          const scroll = f.page.locator('[data-conversation-scroll]');
          await scroll.evaluate((el) => {
            el.scrollTop = 300;
          });
          await f.page.waitForTimeout(50);
          const originalScroll = await scroll.evaluate((el) => el.scrollTop);
          const originalHeader = await f.page
            .getByRole('heading', { level: 1 })
            .boundingBox();
          await selectSuggestion(f.page, '检查本轮成果', width);
          await expect
            .poll(() => input.inputValue())
            .toBe(
              '原草稿👩‍🔬\n保留 {{原文}}\n\n' +
                proof.suggestions[0]!.task.template +
                '\n\n参考成果："原成果{{参数}}.xlsx"。',
            );
          expect(
            await f.page.getByTitle('未上传.txt', { exact: true }).count(),
          ).toBe(1);
          expect(
            await f.page
              .getByTitle('原成果{{参数}}.xlsx', { exact: true })
              .count(),
          ).toBe(1);
          await expect
            .poll(() => input.evaluate((el) => document.activeElement === el))
            .toBe(true);
          expect(await scroll.evaluate((el) => el.scrollTop)).toBe(
            originalScroll,
          );
          expect(
            await f.page.getByRole('heading', { level: 1 }).boundingBox(),
          ).toEqual(originalHeader);
          expect(f.writes).toEqual([]);
          expect(f.pending).toEqual([]);
          await selectSuggestion(f.page, '检查本轮成果', width);
          expect(
            await f.page
              .getByTitle('原成果{{参数}}.xlsx', { exact: true })
              .count(),
          ).toBe(1);
          expect(f.writes).toEqual([]);
          expect(f.errors).toEqual([]);
          // The original send action remains the only message submission route.
          await input.press('Enter');
          await f.waitPending(1);
          expect(f.pending[0]!.path).toBe(`/api/v1/sessions/${A}/messages`);
          expect(f.pending[0]!.body.attachmentIds).toEqual(
            expect.arrayContaining([childId, C]),
          );
        } finally {
          await f.close();
        }
      },
      15000,
    );
    it('next-step list stays frozen while open and rejects a changed source revision until reopened', async () => {
      const f = await fixture({
        taskSuggestions: [weeklyTask],
        nextSteps: nextStepsProof(),
      });
      try {
        await expect
          .poll(
            () => f.reads.filter((url) => url.includes('/next-steps')).length,
          )
          .toBeGreaterThan(0);
        // First populate the settled hook snapshot without relying on fetch timing.
        const opened = f.page.waitForResponse((response) =>
          response.url().includes('/next-steps'),
        );
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await opened;
        await nextRows(f.page, 1440, '检查本轮成果').waitFor();
        await f.page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await f.page.keyboard.press('Escape');
        const previousReads = f.reads.filter((url) =>
          url.includes('/next-steps'),
        ).length;
        f.holdNextStepsReply();
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await expect
          .poll(
            () => f.reads.filter((url) => url.includes('/next-steps')).length,
          )
          .toBeGreaterThan(previousReads);
        await nextRows(f.page, 1440, '检查本轮成果').waitFor();
        expect(await nextRows(f.page, 1440, '新一轮资料核对').count()).toBe(0);
        // Opening's in-flight response has already captured OLD facts. A click
        // must make a new verification read rather than adopt that old promise.
        f.setNextSteps(nextStepsProof('新一轮资料核对', 'b'));
        await nextRows(f.page, 1440, '检查本轮成果').click();
        await f.page
          .getByText('下一步建议或资料已变化，请关闭后重新打开。', {
            exact: true,
          })
          .waitFor();
        f.releaseHeldNextReply();
        expect(await nextRows(f.page, 1440, '检查本轮成果').count()).toBe(1);
        expect(await nextRows(f.page, 1440, '新一轮资料核对').count()).toBe(0);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('');
        expect(
          await f.page
            .getByTitle('原成果{{参数}}.xlsx', { exact: true })
            .count(),
        ).toBe(0);
        await f.page.keyboard.press('Escape');
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await nextRows(f.page, 1440, '新一轮资料核对').waitFor();
        expect(await nextRows(f.page, 1440, '新一轮资料核对').count()).toBe(1);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15000);
    it('a delayed next-step response cannot leak across Session selection', async () => {
      const f = await fixture({
        taskSuggestions: [weeklyTask],
        nextSteps: nextStepsProof(),
        delayNextStepsA: true,
      });
      try {
        await expect
          .poll(() => f.reads.some((url) => url.includes(`/${A}/next-steps`)))
          .toBe(true);
        await f.choose(B);
        f.releaseNextStepsA();
        await f.page.getByText('Existing B', { exact: true }).waitFor();
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await f.page.getByRole('menuitem', { name: /^整理周报/ }).waitFor();
        expect(await nextRows(f.page, 1440, '检查本轮成果').count()).toBe(0);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('');
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15000);
    it('unknown states stay honest and a failed suggestion refresh retains ordinary task fallback', async () => {
      const proof = {
        ...nextStepsProof(),
        state: 'unknown' as const,
        suggestions: [],
        notice: '执行结果尚未确认，请先核对已执行的操作；不会建议重跑。',
      };
      const f = await fixture({
        taskSuggestions: [weeklyTask],
        nextSteps: proof,
      });
      try {
        await expect
          .poll(() => f.reads.some((url) => url.includes('/next-steps')))
          .toBe(true);
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await f.page.getByText(proof.notice, { exact: true }).waitFor();
        await f.page.keyboard.press('Escape');
        f.setNextSteps(undefined);
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await expect
          .poll(
            () => f.reads.filter((url) => url.includes('/next-steps')).length,
          )
          .toBeGreaterThan(2);
        await f.page.keyboard.press('Escape');
        await selectSuggestion(f.page, weeklyTask.title);
        await expect
          .poll(() =>
            f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          )
          .toBe('整理最近 7 天的工作，输出科研👩‍🔬总结。');
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15000);
    it('next-step responses for another viewer or employee version never appear in the current composer', async () => {
      const proof = nextStepsProof();
      const f = await fixture({
        taskSuggestions: [weeklyTask],
        nextSteps: {
          ...proof,
          scope: { ...proof.scope, viewerId: A, employeeVersionId: childId },
        },
      });
      try {
        await expect
          .poll(() => f.reads.some((url) => url.includes('/next-steps')))
          .toBe(true);
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        await f.page.getByRole('menuitem', { name: /^整理周报/ }).waitFor();
        expect(await nextRows(f.page, 1440, '检查本轮成果').count()).toBe(0);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15000);
    it.each([1440, 390, 320])(
      'common Office tasks use plain labels and preserve editable requirements without sending at %ipx',
      async (width) => {
        const task: TaskSuggestionDisplay = {
          id: 'office-word-report',
          title: '制作 Word 报告',
          description: '运营：根据资料交付可下载的 Word 文件。',
          template: '根据资料撰写{{主题}}的 Word 报告。',
          slots: [{ name: '主题', label: '报告主题', required: true }],
          preparation: ['files'],
        };
        const f = await fixture({ width, taskSuggestions: [task] });
        try {
          const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
          await input.fill('保留原要求 🌾');
          const taskButton = f.page.getByRole('button', {
            name: '常用任务',
            exact: true,
          });
          const taskBox = (await taskButton.boundingBox())!;
          const visibilityBox = (await f.page
            .getByRole('combobox', { name: '上传文件可见范围' })
            .boundingBox())!;
          const sendBox = (await f.page
            .getByRole('button', { name: '发送', exact: true })
            .boundingBox())!;
          const cardBox = (await input.locator('..').boundingBox())!;
          expect(taskBox.x).toBeGreaterThanOrEqual(cardBox.x);
          expect(taskBox.x + taskBox.width).toBeLessThanOrEqual(sendBox.x);
          expect(taskBox.y + taskBox.height).toBeLessThanOrEqual(
            cardBox.y + cardBox.height,
          );
          if (width === 1440) {
            expect(taskBox.x).toBeGreaterThan(
              visibilityBox.x + visibilityBox.width,
            );
            expect(Math.abs(taskBox.y - visibilityBox.y)).toBeLessThan(2);
          }
          await f.page
            .getByRole('button', { name: '常用任务', exact: true })
            .click();
          const list =
            width < 760
              ? f.page.getByRole('dialog', { name: '常用任务', exact: true })
              : f.page.getByRole('menu');
          if (width === 1440) {
            const surface = await list.evaluate((node) => ({
              border: getComputedStyle(node).borderTopWidth,
              shadow: getComputedStyle(node).boxShadow,
            }));
            expect(surface.border).toBe('1px');
            expect(surface.shadow).not.toBe('none');
          }
          expect(await list.textContent()).toContain('写报告（Word）');
          expect(await list.textContent()).not.toContain('运营：');
          expect(
            await list.getByText('选择资料', { exact: true }).count(),
          ).toBe(0);
          await list
            .getByRole(width < 760 ? 'button' : 'menuitem', {
              name: /^写报告（Word）/,
            })
            .click();
          const dialog = f.page.getByRole('dialog', {
            name: '写报告（Word）',
            exact: true,
          });
          await dialog
            .getByRole('button', { name: '选择资料', exact: true })
            .click();
          await dialog
            .getByRole('alert')
            .getByText(/报告主题/)
            .waitFor();
          expect(await input.inputValue()).toBe('保留原要求 🌾');
          await dialog
            .getByRole('textbox', { name: '报告主题', exact: true })
            .fill('季度经营');
          const requirements = dialog.getByRole('textbox', {
            name: '补充要求',
            exact: true,
          });
          await requirements.fill('给总经理看');
          await requirements.press('Enter');
          await requirements.press('End');
          await requirements.type('控制在两页');
          expect(await dialog.count()).toBe(1);
          expect(f.writes).toEqual([]);
          await dialog
            .getByRole('button', { name: '追加到输入框', exact: true })
            .click();
          await expect
            .poll(() => input.inputValue())
            .toBe(
              '保留原要求 🌾\n\n根据资料撰写季度经营的 Word 报告。\n\n补充要求：给总经理看\n控制在两页',
            );
          expect(f.writes).toEqual([]);
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
      20_000,
    );

    it.each([1440, 390])(
      'recommendation fills a default task locally with selection and no request at %ipx',
      async (width) => {
        const f = await fixture({ width, taskSuggestions: [weeklyTask] });
        try {
          const expected = '整理最近 7 天的工作，输出科研👩‍🔬总结。';
          await f.page.evaluate(
            ({ expected }) => {
              const timing = { ms: null as number | null };
              Object.assign(window, { taskDraftTiming: timing });
              document.addEventListener(
                'click',
                (event) => {
                  const button = (event.target as HTMLElement).closest(
                    'button',
                  );
                  if (!button?.textContent?.startsWith('填入输入框')) return;
                  const start = performance.now();
                  const observe = () => {
                    if (
                      document.querySelector<HTMLTextAreaElement>(
                        'textarea[aria-label="给 Rice 的消息"]',
                      )?.value === expected
                    )
                      timing.ms = performance.now() - start;
                    else requestAnimationFrame(observe);
                  };
                  requestAnimationFrame(observe);
                },
                { capture: true, once: false },
              );
            },
            { expected },
          );
          await selectSuggestion(f.page, weeklyTask.title, width);
          const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
          await expect.poll(() => input.inputValue()).toBe(expected);
          expect(
            await input.evaluate((element: HTMLTextAreaElement) =>
              element.value.slice(element.selectionStart, element.selectionEnd),
            ),
          ).toBe('7');
          expect(
            await input.evaluate(
              (element) => document.activeElement === element,
            ),
          ).toBe(true);
          const latency = await f.page.evaluate(
            () =>
              (window as unknown as { taskDraftTiming: { ms: number | null } })
                .taskDraftTiming.ms,
          );
          expect(latency).not.toBeNull();
          recommendationTimings.push({
            chrome: await browser.version(),
            platform: `${process.platform}/${process.arch}`,
            viewport: width,
            ms: latency,
            samples: 1,
          });
          expect(f.writes).toEqual([]);
          expect(f.pending).toEqual([]);
          expect(f.errors).toEqual([]);
          await input.press('Shift+Enter');
          expect(await input.inputValue()).toContain('\n');
          await input.press('Enter');
          await f.waitPending(1);
          expect(f.pending[0]!.path).toBe(`/api/v1/sessions/${A}/messages`);
          expect(f.pending[0]!.body.text).not.toContain('{{');
          expect(f.writes).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
      20_000,
    );

    it('recommendation appends while preserving a real attachment and session reference, including during a running turn', async () => {
      const f = await fixture({ running: true, taskSuggestions: [weeklyTask] });
      try {
        await f.page.locator('input[type=file]').setInputFiles({
          name: 'research.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Synthetic input'),
        });
        await f.page.getByText('research.txt', { exact: true }).waitFor();
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page
          .getByRole('menuitem', { name: '引用会话', exact: true })
          .click();
        const picker = f.page.getByRole('dialog', { name: '引用会话' });
        await picker.getByRole('button', { name: /Session B/ }).click();
        await picker.getByRole('button', { name: '完成', exact: true }).click();
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        const original = '[原文] {{保留}}\n\n已有草稿 🚀';
        await input.fill(original);
        const beforeWrites = [...f.writes];
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        expect(
          await f.page
            .getByText('选择任务，补充需求后发送', { exact: true })
            .count(),
        ).toBe(1);
        await f.page.getByRole('menuitem', { name: /^整理周报/ }).click();
        await f.page
          .getByRole('dialog', { name: weeklyTask.title, exact: true })
          .getByRole('button', { name: '追加到输入框', exact: true })
          .click();
        const expected = `${original}\n\n整理最近 7 天的工作，输出科研👩‍🔬总结。`;
        await expect.poll(() => input.inputValue()).toBe(expected);
        expect(
          await f.page.getByText('research.txt', { exact: true }).count(),
        ).toBe(1);
        expect(
          await f.page
            .getByRole('button', { name: '移除引用：Session B' })
            .count(),
        ).toBe(1);
        expect(f.writes).toEqual(beforeWrites);
        await input.press('Enter');
        await f.waitPending(1);
        expect(f.pending[0]!.body.text).toBe(expected);
        expect(f.pending[0]!.body.attachmentIds).toEqual([C]);
        expect(f.pending[0]!.body.sessionReferenceIds).toEqual([B]);
        expect(f.pending[0]!.body.deliveryMode).toBe('follow_up');
      } finally {
        await f.close();
      }
    }, 20_000);

    it.each([1440, 390])(
      'recommendation parameter Modal protects IME/Enter and restores focus at %ipx',
      async (width) => {
        const task: TaskSuggestionDisplay = {
          id: 'make-plan',
          title: '制定研究计划',
          template: '围绕{{目标}}制定{{days}}天计划，再核对{{目标}}。',
          slots: [
            { name: '目标', label: '研究目标', required: true },
            {
              name: 'days',
              label: '天数',
              defaultValue: '7',
              options: ['7', '30'],
            },
          ],
        };
        const f = await fixture({ width, taskSuggestions: [task] });
        try {
          await selectSuggestion(f.page, task.title, width, false);
          const dialog = f.page.getByRole('dialog', {
            name: task.title,
            exact: true,
          });
          const goal = dialog.getByRole('textbox', {
            name: '研究目标',
            exact: true,
          });
          await goal.evaluate((element) => {
            element.dispatchEvent(
              new CompositionEvent('compositionstart', { bubbles: true }),
            );
            element.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                keyCode: 229,
                isComposing: true,
                bubbles: true,
              }),
            );
            element.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true }),
            );
          });
          await goal.press('Enter');
          expect(await dialog.count()).toBe(1);
          expect(f.writes).toEqual([]);
          await f.page.keyboard.press('Escape');
          await expect.poll(() => dialog.count()).toBe(0);
          expect(
            await f.page
              .getByRole('button', { name: '常用任务', exact: true })
              .evaluate((element) => document.activeElement === element),
          ).toBe(true);
          await selectSuggestion(f.page, task.title, width, false);
          await goal.fill('蛋白质研究 🧬');
          await dialog
            .getByRole('combobox', { name: '天数', exact: true })
            .selectOption('30');
          await dialog
            .getByRole('button', { name: '填入输入框', exact: true })
            .click();
          const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
          await expect
            .poll(() => input.inputValue())
            .toBe('围绕蛋白质研究 🧬制定30天计划，再核对蛋白质研究 🧬。');
          // Draft text commits before the next frame restores its focus/selection.
          await expect
            .poll(() =>
              input.evaluate((element: HTMLTextAreaElement) => ({
                focused: document.activeElement === element,
                selected: element.value.slice(
                  element.selectionStart,
                  element.selectionEnd,
                ),
              })),
            )
            .toEqual({ focused: true, selected: '蛋白质研究 🧬' });
          expect(f.writes).toEqual([]);
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
      20_000,
    );

    it('recommendation preserves scroll/header geometry and closes old parameter state when switching Session', async () => {
      const task: TaskSuggestionDisplay = {
        id: 'plan',
        title: '研究方案',
        template: '研究{{目标}}。',
        slots: [{ name: '目标', label: '目标', required: true }],
      };
      const f = await fixture({ taskSuggestions: [task], longHistory: true });
      try {
        const header = f.page.getByRole('heading', { level: 1 });
        const scroll = f.page.locator('[data-conversation-scroll]');
        await scroll.evaluate((element) => {
          element.scrollTop = 300;
        });
        await f.page.waitForTimeout(50);
        const scrollBefore = await scroll.evaluate(
          (element) => element.scrollTop,
        );
        const before = await header.boundingBox();
        await selectSuggestion(f.page, task.title, 1440, false);
        expect(await header.boundingBox()).toEqual(before);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(
          scrollBefore,
        );
        await f.page
          .getByRole('textbox', { name: '目标', exact: true })
          .fill('旧会话参数');
        await f.page
          .getByRole('treeitem', { name: /^Session B/ })
          .evaluate((element: HTMLElement) => element.click());
        await expect.poll(() => header.textContent()).toContain('Session B');
        expect(
          await f.page.getByRole('dialog', { name: task.title }).count(),
        ).toBe(0);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('');
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);

    it('recommendation exposes real file/Bridge preparation without hiding a task or making a mutation', async () => {
      const task: TaskSuggestionDisplay = {
        id: 'local-project',
        title: '梳理代码',
        template: '只读梳理已选项目目录。',
        readiness: ['local_files'],
        preparation: ['files', 'bridge'],
      };
      const f = await fixture({ taskSuggestions: [task] });
      try {
        await selectSuggestion(f.page, task.title, 1440, false);
        const dialog = f.page.getByRole('dialog', {
          name: task.title,
          exact: true,
        });
        await dialog
          .getByRole('textbox', { name: '补充要求', exact: true })
          .fill('只看 src 目录');
        await dialog
          .getByRole('button', { name: '选择资料', exact: true })
          .click();
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe(`${task.template}\n\n补充要求：只看 src 目录`);
        await f.page
          .getByRole('menuitem', { name: '从工作区添加', exact: true })
          .waitFor();
        expect(
          await f.page
            .getByRole('button', { name: '添加文件', exact: true })
            .evaluate((element) => document.activeElement === element),
        ).toBe(true);
        await f.page.keyboard.press('Escape');
        await selectSuggestion(f.page, task.title, 1440, false);
        await dialog
          .getByRole('button', { name: '连接与管理电脑', exact: true })
          .click();
        await f.page
          .getByRole('dialog', { name: '设置', exact: true })
          .waitFor();
        await f.page
          .getByRole('heading', { name: '连接与管理电脑', exact: true })
          .waitFor();
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);

    it.each([
      { filesReady: true, browserReady: false },
      { filesReady: false, browserReady: true },
    ])(
      'recommendation uses browser preparation with filesReady=$filesReady/browserReady=$browserReady',
      async ({ filesReady, browserReady }) => {
        const task: TaskSuggestionDisplay = {
          id: 'read-browser',
          title: '读取本地页面',
          template: '只读查看本地浏览器中的页面。',
          readiness: ['local_browser'],
          preparation: ['bridge'],
        };
        const readiness: WorkspaceReadiness['capabilities'] =
          workspaceCapabilityIds.map((id) => {
            const state =
              id === 'local_browser' && !browserReady
                ? 'paused'
                : id === 'local_files' && !filesReady
                  ? 'needs_configuration'
                  : 'ready';
            return {
              id,
              state,
              reason:
                state === 'paused'
                  ? 'device_paused'
                  : state === 'needs_configuration'
                    ? 'folder_missing'
                    : 'ready',
              target: 'local',
              responsibleRole: 'user',
              action: 'compose',
              releaseEnabled: true,
              authorization: 'normal_policy',
            };
          });
        const f = await fixture({ taskSuggestions: [task], readiness });
        try {
          await selectSuggestion(f.page, task.title, 1440, false);
          const dialog = f.page.getByRole('dialog', {
            name: task.title,
            exact: true,
          });
          const preparation = dialog.getByRole('button', {
            name: '连接与管理电脑',
            exact: true,
          });
          if (browserReady)
            await expect.poll(() => preparation.count()).toBe(0);
          else {
            // This hint proves that the real readiness response was parsed,
            // rather than passing against the initial unknown state.
            await dialog.getByText(/暂停/).waitFor();
            expect(await preparation.count()).toBe(1);
          }
          await dialog
            .getByRole('button', { name: '填入输入框', exact: true })
            .click();
          expect(
            await f.page
              .getByRole('textbox', { name: '给 Rice 的消息' })
              .inputValue(),
          ).toBe(task.template);
          expect(f.writes).toEqual([]);
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
      15_000,
    );

    it('common tasks shows three initial tasks and keeps all eight stable IDs selectable', async () => {
      const tasks: TaskSuggestionDisplay[] = Array.from(
        { length: 8 },
        (_, index) => ({
          id: index === 7 ? 'more' : `task-${index}`,
          title: index === 7 ? '科研分析' : `任务 ${index + 1}`,
          template: `草稿 ${index + 1}`,
        }),
      );
      const f = await fixture({ taskSuggestions: tasks });
      try {
        await f.page
          .getByRole('button', { name: '常用任务', exact: true })
          .click();
        // Company discovery remains available outside the three common tasks.
        expect(
          await f.page.getByRole('menuitem', { name: /^任务 \d+$/ }).count(),
        ).toBe(3);
        expect(
          await f.page
            .getByRole('menuitem', { name: '公司范本', exact: true })
            .count(),
        ).toBe(1);
        expect(
          await f.page
            .getByRole('menuitem', { name: '科研分析', exact: true })
            .count(),
        ).toBe(0);
        await f.page
          .getByRole('menuitem', { name: '更多任务（5）', exact: true })
          .click();
        expect(
          await f.page.getByRole('menuitem', { name: /^任务 \d+$/ }).count(),
        ).toBe(4);
        expect(
          await f.page
            .getByRole('menuitem', { name: '科研分析', exact: true })
            .count(),
        ).toBe(1);
        await f.page
          .getByRole('menuitem', { name: '科研分析', exact: true })
          .click();
        await f.page
          .getByRole('dialog', { name: '科研分析', exact: true })
          .getByRole('button', { name: '填入输入框', exact: true })
          .click();
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('草稿 8');
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 15_000);

    it('uses an opaque, readable attachment menu with keyboard and outside dismissal', async () => {
      const f = await fixture();
      try {
        const add = f.page.getByRole('button', {
          name: '添加文件',
          exact: true,
        });
        await add.click();
        const menu = f.page.getByRole('menu');
        const item = menu.getByRole('menuitem', {
          name: '从工作区添加',
          exact: true,
        });
        const styles = await item.evaluate((el) => ({
          size: getComputedStyle(el).fontSize,
          height: el.getBoundingClientRect().height,
        }));
        expect(styles).toEqual({ size: '15px', height: 44 });
        for (const selector of [
          '[data-compact=mode]',
          '[data-compact=visibility]',
        ]) {
          expect(
            await f.page.locator(selector).evaluate((el) => ({
              size: getComputedStyle(el).fontSize,
              weight: getComputedStyle(el).fontWeight,
            })),
          ).toEqual({ size: '15px', weight: '400' });
        }
        const surface = await menu.evaluate((el) => ({
          background: getComputedStyle(el).backgroundColor,
          shadow: getComputedStyle(el).boxShadow,
          border: getComputedStyle(el).borderTopWidth,
        }));
        expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(surface.shadow).not.toBe('none');
        expect(surface.border).toBe('1px');
        if (process.env.ALLRICE_UI_EVIDENCE_DIR)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_UI_EVIDENCE_DIR}/attachment-menu.png`,
          });
        await f.page.keyboard.press('Escape');
        expect(await menu.count()).toBe(0);
        expect(await add.evaluate((el) => el === document.activeElement)).toBe(
          true,
        );
        await add.click();
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .click({ position: { x: 500, y: 10 } });
        expect(await menu.count()).toBe(0);
      } finally {
        await f.close();
      }
    }, 15_000);

    const pickerFiles: WorkspaceFile[] = Array.from(
      { length: 28 },
      (_, index) => ({
        id: `workspace-file-${index}`,
        fileName: `tool-result-web-search-${index}-1cd48820-0024-4b22-b75b-46f7c05705c2.txt`,
        mediaType: 'text/plain',
        sizeBytes: 19000,
        ownedByMe: true,
        category: 'exports',
        visibility: 'workspace',
        deliverableVersion: 1,
      }),
    );
    const openPicker = async (page: Page) => {
      await page.getByRole('button', { name: '添加文件', exact: true }).click();
      await page
        .getByRole('menuitem', { name: '从工作区添加', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: '从工作区添加文件',
        exact: true,
      });
      await dialog.waitFor();
      return dialog;
    };

    it.each([1440, 390, 320])(
      'workspace picker keeps selection while searching and its footer visible at %i px',
      async (width) => {
        const f = await fixture({ width, workspaceFiles: pickerFiles });
        try {
          const dialog = await openPicker(f.page);
          const search = dialog.getByRole('searchbox', { name: '搜索文件名' });
          expect(
            await search.evaluate((el) => el === document.activeElement),
          ).toBe(true);
          expect(
            await dialog
              .getByRole('button', { name: '添加到本轮' })
              .isDisabled(),
          ).toBe(true);
          await dialog.getByRole('checkbox').nth(0).check();
          await search.fill('web-search-4-');
          expect(await dialog.getByRole('checkbox').count()).toBe(1);
          await dialog.getByRole('checkbox').check();
          await search.fill('not-a-file');
          expect(await dialog.getByText('没有找到匹配的文件').isVisible()).toBe(
            true,
          );
          expect(await dialog.getByText('已选 2 项').isVisible()).toBe(true);
          await search.fill('');
          expect(await dialog.getByRole('checkbox').nth(0).isChecked()).toBe(
            true,
          );
          expect(await dialog.getByRole('checkbox').nth(4).isChecked()).toBe(
            true,
          );
          const list = dialog.getByRole('list', { name: '工作区文件' });
          const layout = await dialog.evaluate((el) => ({
            left: el.getBoundingClientRect().left,
            right: el.getBoundingClientRect().right,
            bottom: el.getBoundingClientRect().bottom,
            overflow: el.scrollWidth > el.clientWidth,
            background: getComputedStyle(el).backgroundColor,
            footer: el.querySelector('footer')!.getBoundingClientRect().bottom,
            nameSize: getComputedStyle(el.querySelector('[class*=fileName]')!)
              .fontSize,
            nameWeight: getComputedStyle(el.querySelector('[class*=fileName]')!)
              .fontWeight,
          }));
          expect(layout.background).toBe('rgb(255, 255, 255)');
          expect(layout.overflow).toBe(false);
          expect(layout.left).toBeGreaterThanOrEqual(0);
          expect(layout.right).toBeLessThanOrEqual(width);
          expect(layout.footer).toBeLessThanOrEqual(layout.bottom);
          expect(layout.nameSize).toBe('15px');
          expect(layout.nameWeight).toBe('400');
          await list.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          expect(
            await dialog
              .getByRole('button', { name: '添加到本轮' })
              .isVisible(),
          ).toBe(true);
          await list.evaluate((el) => {
            el.scrollTop = 0;
          });
          await dialog
            .getByRole('button', {
              name: `文件详情：${pickerFiles[0]!.fileName}`,
            })
            .click();
          expect(
            await dialog
              .locator('p')
              .getByText(pickerFiles[0]!.fileName, { exact: true })
              .isVisible(),
          ).toBe(true);
          if (process.env.ALLRICE_UI_EVIDENCE_DIR)
            await f.page.screenshot({
              path: `${process.env.ALLRICE_UI_EVIDENCE_DIR}/workspace-picker-${width}.png`,
            });
          await f.page.keyboard.press('Escape');
          expect(await dialog.count()).toBe(0);
          expect(f.writes).toEqual([]);
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
      20000,
    );

    it('batch workspace attachments retain successes and retry only the failed selection', async () => {
      const f = await fixture({
        uploadPending: true,
        workspaceFiles: pickerFiles.slice(0, 2),
      });
      try {
        const dialog = await openPicker(f.page);
        await dialog.getByRole('checkbox').nth(0).check();
        await dialog.getByRole('checkbox').nth(1).check();
        await dialog.getByRole('button', { name: '添加到本轮' }).click();
        await f.waitPending(1);
        expect(
          await dialog.getByRole('button', { name: '正在添加…' }).isDisabled(),
        ).toBe(true);
        await f.respond(0);
        await f.waitPending(2);
        await f.respond(1, false);
        expect(await dialog.getByRole('alert').textContent()).toContain(
          'Synthetic old request failed',
        );
        expect(await dialog.getByRole('checkbox').nth(0).isDisabled()).toBe(
          true,
        );
        expect(await dialog.getByRole('checkbox').nth(1).isChecked()).toBe(
          true,
        );
        expect(await dialog.getByText('已选 1 项').isVisible()).toBe(true);
        await dialog.getByRole('button', { name: '添加到本轮' }).click();
        await f.waitPending(3);
        expect(f.pending.map((p) => p.body.objectId)).toEqual([
          pickerFiles[0]!.id,
          pickerFiles[1]!.id,
          pickerFiles[1]!.id,
        ]);
        await f.respond(2);
        expect(await dialog.count()).toBe(0);
        const reopened = await openPicker(f.page);
        expect(await reopened.getByRole('checkbox').nth(0).isDisabled()).toBe(
          true,
        );
        expect(await reopened.getByRole('checkbox').nth(1).isDisabled()).toBe(
          true,
        );
        expect(
          await reopened
            .getByRole('button', { name: '添加到本轮' })
            .isDisabled(),
        ).toBe(true);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20000);

    it('a new workspace-file batch creates only one session and preserves the selected files', async () => {
      const f = await fixture({
        uploadPending: true,
        workspaceFiles: pickerFiles.slice(0, 2),
      });
      try {
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        const dialog = await openPicker(f.page);
        await dialog.getByRole('checkbox').nth(0).check();
        await dialog.getByRole('checkbox').nth(1).check();
        await dialog.getByRole('button', { name: '添加到本轮' }).click();
        await f.waitPending(1);
        expect(f.pending[0]!.path).toBe('/api/v1/sessions');
        await f.respond(0);
        await f.waitPending(2);
        await f.respond(1);
        await f.waitPending(3);
        await f.respond(2);
        expect(f.writes).toEqual([
          '/api/v1/sessions',
          `/api/v1/sessions/${C}/attachments`,
          `/api/v1/sessions/${C}/attachments`,
        ]);
        expect(await f.page.getByRole('dialog').count()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20000);

    it('workspace file selection survives version history and rejects an oversized batch before writes', async () => {
      const f = await fixture({ workspaceFiles: pickerFiles });
      try {
        await f.page.route('**/files/*/versions?*', (route) =>
          route.fulfill({ json: { versions: [] } }),
        );
        const dialog = await openPicker(f.page);
        await dialog.getByRole('checkbox').nth(0).check();
        await dialog
          .getByRole('button', {
            name: `文件详情：${pickerFiles[0]!.fileName}`,
          })
          .click();
        await dialog.getByRole('button', { name: '查看版本历史' }).click();
        const history = f.page.getByRole('dialog', {
          name: `${pickerFiles[0]!.fileName} 的版本历史`,
        });
        await history
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        expect(await dialog.getByRole('checkbox').nth(0).isChecked()).toBe(
          true,
        );
        await dialog
          .getByRole('button', {
            name: `文件详情：${pickerFiles[0]!.fileName}`,
          })
          .click();
        for (let i = 1; i < 21; i++)
          await dialog.getByRole('checkbox').nth(i).check();
        await dialog.getByRole('button', { name: '添加到本轮' }).click();
        expect(await dialog.getByRole('alert').textContent()).toBe(
          '每条消息最多添加 20 个附件。',
        );
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20000);

    it('late cancellation failure cannot poison another session or claim that work stopped', async () => {
      const f = await fixture({ running: true });
      try {
        await f.page
          .getByRole('button', { name: '停止生成', exact: true })
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
            .getByRole('button', { name: '停止生成', exact: true })
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
          .getByRole('button', { name: '停止生成', exact: true })
          .click();
        await failed;
        await f.page.getByText('Failed to fetch', { exact: true }).waitFor();
        await f.page
          .getByRole('button', { name: '停止生成', exact: true })
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
          .getByRole('region', { name: '工作过程', exact: true })
          .getByRole('button')
          .click();
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
    it('native Bridge upload sends the existing object once and keeps a late upload out of another Session', async () => {
      const f = await fixture({ bridgeFiles: true });
      try {
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page
          .getByRole('menuitem', { name: '通过我的电脑选择文件', exact: true })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.body).toMatchObject({
          action: 'select',
          sessionId: A,
          deviceId: runId,
          folderGrantId: childId,
        });
        await f.respond(0);
        await f.page
          .getByText('Bridge 原始资料.xlsx', { exact: true })
          .waitFor();
        await f.send('Use uploaded original');
        await f.waitPending(2);
        expect(f.pending[1]!.body.attachmentIds).toEqual([C]);
        await f.respond(1);
        expect(f.writes).toEqual([
          '/api/v1/bridge/files',
          `/api/v1/sessions/${A}/messages`,
        ]);
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page
          .getByRole('menuitem', { name: '通过我的电脑选择文件', exact: true })
          .click();
        await f.waitPending(3);
        await f.choose(B);
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .fill('Session B draft');
        await f.respond(2);
        expect(
          await f.page
            .getByText('Bridge 原始资料.xlsx', { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .inputValue(),
        ).toBe('Session B draft');
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Rice 的消息' })
            .isDisabled(),
        ).toBe(false);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20000);
    it('native Bridge import preserves the idempotency key through created Session and a lost response', async () => {
      const f = await fixture({ bridgeFiles: true });
      try {
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page
          .getByRole('menuitem', { name: '通过我的电脑选择文件', exact: true })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.path).toBe('/api/v1/sessions');
        await f.respond(0);
        await f.waitPending(2);
        expect(f.pending[1]!.body.sessionId).toBe(C);
        const key = f.pending[1]!.body.idempotencyKey;
        await f.respond(1, false);
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page
          .getByRole('menuitem', { name: '通过我的电脑选择文件', exact: true })
          .click();
        await f.waitPending(3);
        expect(f.pending[2]!.body.idempotencyKey).toBe(key);
        expect(f.writes.filter((p) => p === '/api/v1/sessions')).toHaveLength(
          1,
        );
        await f.respond(2);
        await f.page
          .getByText('Bridge 原始资料.xlsx', { exact: true })
          .waitFor();
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20000);
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
      const f = await fixture({
        uploadPending: true,
        workspaceFiles: pickerFiles.slice(0, 2),
      });
      try {
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page.getByRole('menuitem', { name: /从工作区添加/ }).click();
        await f.page.getByRole('checkbox').nth(0).check();
        await f.page.getByRole('checkbox').nth(1).check();
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: '添加到本轮', exact: true })
          .click();
        await f.waitPending(1);
        expect(f.pending[0]!.body).toEqual({ objectId: pickerFiles[0]!.id });
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
            .getByText(pickerFiles[0]!.fileName, { exact: true })
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
        expect(
          f.writes.filter((path) => path.endsWith('/attachments')),
        ).toHaveLength(1);
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
        await f.page
          .getByRole('region', { name: '工作过程', exact: true })
          .getByRole('button')
          .click();
        await f.page.getByText(/已请求停止不代表进程已退出/).waitFor();
        await f.page.reload();
        await f.page
          .getByRole('region', { name: '工作过程', exact: true })
          .getByRole('button')
          .click();
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
        await f.page
          .getByRole('region', { name: '工作过程', exact: true })
          .getByRole('button')
          .click();
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
