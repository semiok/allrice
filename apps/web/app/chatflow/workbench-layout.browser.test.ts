import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officePreview } from '@allrice/office-runtime';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import {
  WorkbenchArtifactSchema,
  type MessageFeedbackItem,
  McpConnectionSchema,
  type McpConnection,
  OfficeRenderResponseSchema,
  workspaceCapabilityIds,
  type WorkspaceCapability,
  type InteractionStatus,
  type ChatFlowEventEnvelope,
} from '@allrice/contracts';
import type { ArtifactPreview } from '../../lib/chatflow/workbench-model';
import type { QueuedMessage, Message, WorkspaceFile } from './chatflow-types';
import { layoutPreferenceKey } from './use-workbench-layout';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1),
  B = id(2),
  org = id(3),
  workspace = id(4),
  user = id(5),
  run = id(6);
const now = '2026-09-20T00:00:00.000Z';
const report =
  '# COIN / MSTR / CRCL · 合成研究报告\n\n| 标的 | 说明 |\n| --- | --- |\n| COIN | 测试数据，非投资建议 |\n\n' +
  '多步研究结果与引用说明。'.repeat(100);
function session(sessionId: string) {
  return {
    id: sessionId,
    title: sessionId === A ? '研究任务 A' : '研究任务 B',
    employeeAssignmentId: id(7),
    employeeVersionId: id(8),
    visibility: 'private',
    updatedAt: now,
    archivedAt: null,
  };
}
function artifact(n: number, sessionId = A) {
  const artifactId = id(n),
    objectId = id(n + 100);
  return WorkbenchArtifactSchema.parse({
    contractVersion: 1,
    id: artifactId,
    kind: 'document',
    version: {
      id: artifactId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      objectId,
      seriesId: artifactId,
      version: 1,
      parentVersionId: null,
      parentObjectId: null,
      sessionId,
      platformTestRunId: null,
      fileName: `report-${n}.md`,
      format: 'markdown',
      changeSummary: null,
      createdAt: `2026-09-20T00:${String(n).padStart(2, '0')}:00.000Z`,
    },
    object: {
      id: objectId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      key: `organizations/${org}/workspaces/${workspace}/owners/${user}/exports/${objectId}`,
      mediaType: 'text/markdown',
      checksum: `sha256:${'a'.repeat(64)}`,
      sizeBytes: report.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    },
    provenance: {
      kind: 'model_proposal',
      runId: run,
      operationId: null,
      stepId: null,
    },
    execution: null,
    latestVersionId: artifactId,
    stale: false,
  });
}

function navigationHistory(count: number, paragraphs = 90): Message[] {
  return Array.from({ length: count }, (_, i) => [
    {
      id: id(2000 + i * 2),
      role: 'user' as const,
      runId: id(3000 + i),
      status: 'completed' as const,
      content: { text: `第 ${i + 1} 项工作：分析文档` },
      createdAt: now,
    },
    {
      id: id(2001 + i * 2),
      role: 'assistant' as const,
      runId: id(3000 + i),
      status: 'completed' as const,
      content: {
        text: `第 ${i + 1} 项答复\n\n${'已有资料的分析结论。'.repeat(paragraphs)}`,
      },
      createdAt: now,
    },
  ]).flat();
}

suite('MET-147 UX01-A full tenant workbench (synthetic HTTP, no model)', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const root = process.cwd(),
      require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: root,
      entryPoints: ['apps/web/test/met147-workbench-page.tsx'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/unused-met147',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: {
        'process.env.NODE_ENV': '"development"',
        'process.env': '{}',
      },
    });
    const js = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.js'),
    ).contents;
    const css = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.css'),
    ).contents;
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      response.writeHead(200, {
        'content-type':
          path === '/app.js'
            ? 'application/javascript'
            : path === '/app.css'
              ? 'text/css'
              : 'text/html',
      });
      response.end(
        path === '/app.js'
          ? js
          : path === '/app.css'
            ? css
            : '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('No loopback address');
    origin = `http://127.0.0.1:${address.port}`;
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
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  async function fixture(
    options: {
      tenantAdmin?: boolean;
      employeeCount?: number;
      employeeHistory?: boolean;
      width?: number;
      artifacts?: boolean;
      disabled?: boolean;
      noSession?: boolean;
      noStorage?: boolean;
      running?: boolean;
      streamingOutput?: boolean;
      controlledStream?: boolean;
      queue?: boolean;
    } = {},
  ) {
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: 950 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // Loading the development bundle can outlast interaction waits under CI load.
    page.setDefaultNavigationTimeout(15_000);
    const employeeHistorySessions = [
      ...Array.from({ length: 7 }, (_, n) => ({
        ...session(id(600 + n)),
        title: `历史工作 ${n + 1}`,
      })),
      { ...session(B), employeeAssignmentId: id(17) },
      {
        ...session(id(650)),
        employeeAssignmentId: id(99),
        employeeName: '旧员工',
        title: '已撤回员工的工作',
      },
    ];
    const errors: string[] = [],
      writes: string[] = [],
      unexpected: string[] = [];
    const state = {
      messages: null as Message[] | null,
      queue: [] as QueuedMessage[],
      queuedStarted: [] as Message[],
      queueError: false,
      queueDelay: null as Promise<void> | null,
      queueActions: [] as Array<{
        action: string;
        expectedTurnId?: string;
        expectedGeneration?: number;
      }>,
      messageInputs: [] as Array<{ text: string; attachmentIds: string[] }>,
      connections: [] as McpConnection[],
      connectionReads: 0,
      connectionActions: [] as string[],
      readinessError: false,
      readinessWrongScope: false,
      readinessDelay: null as Promise<void> | null,
      readinessRequests: 0,
      canAdminister: false,
      capabilities: workspaceCapabilityIds.map((id): WorkspaceCapability => ({
        id,
        state:
          id === 'report'
            ? 'ready'
            : id === 'local_files'
              ? 'needs_configuration'
              : 'not_released',
        reason:
          id === 'report'
            ? 'ready'
            : id === 'local_files'
              ? 'bridge_missing'
              : 'release_disabled',
        action:
          id === 'report'
            ? 'compose'
            : id === 'local_files'
              ? 'bridge'
              : 'guide',
        target: id === 'local_files' ? 'local' : 'cloud',
        responsibleRole: 'user',
        releaseEnabled: ['report', 'local_files'].includes(id),
        authorization: 'normal_policy',
      })),
      viewer: user,
      preferences: { [user]: options.streamingOutput ?? false } as Record<
        string,
        boolean
      >,
      preferenceError: false,
      preferenceDelay: null as Promise<void> | null,
      workspace,
      omitSessionA: false,
      deepLinkDenied: false,
      items: options.artifacts ? [artifact(10)] : [],
      listError: false,
      artifactReads: 0,
      messageFeedback: [] as MessageFeedbackItem[],
      feedbackError: false,
      feedbackWrites: 0,
      feedbackReview: { status: 'new', note: '' },
      contentError: false,
      officePreview: null as ArtifactPreview | null,
      files: [] as WorkspaceFile[],
      fileReads: 0,
      filePreview: {
        kind: 'text',
        mediaType: 'text/markdown',
        text: '# 上传的文件',
      } as ArtifactPreview,
      fileDelay: null as Promise<void> | null,
      text: report,
      reply: report,
      messageStatus: options.running ? 'pending' : 'completed',
      streamRequests: 0,
      events: [] as ChatFlowEventEnvelope[],
      streamEvents: null as ChatFlowEventEnvelope[] | null,
      employeeName: 'Rice',
      runTimings: [] as NonNullable<InteractionStatus['runTimings']>,
      timingError: false,
      delay: null as null | Promise<void>,
    };
    let finishStream!: () => void;
    const streamGate = new Promise<void>((done) => {
      finishStream = done;
    });
    page.on('pageerror', (e) => errors.push(e.message));
    if (options.controlledStream)
      await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = new URL(String(input), location.origin);
          if (
            !url.pathname.endsWith('/events') ||
            url.searchParams.has('format')
          )
            return originalFetch(input, init);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const push = (event: Event) =>
                controller.enqueue(
                  new TextEncoder().encode(
                    (event as CustomEvent<string>).detail,
                  ),
                );
              window.addEventListener('allrice-test-stream', push);
              document.documentElement.dataset.streamReady = 'true';
              init?.signal?.addEventListener(
                'abort',
                () => {
                  window.removeEventListener('allrice-test-stream', push);
                  controller.close();
                },
                { once: true },
              );
            },
          });
          return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        };
      });
    if (options.noStorage)
      await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw Error('Storage disabled');
          },
        });
      });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      const answer = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      if (path === '/api/v1/me/preferences') {
        const viewerId = state.viewer;
        if (state.preferenceDelay) await state.preferenceDelay;
        if (state.preferenceError)
          return answer({ error: { message: '保存失败，请重试' } }, 503);
        if (route.request().method() === 'PATCH') {
          const body = route.request().postDataJSON();
          expect(Object.keys(body)).toEqual(['streamingOutput']);
          state.preferences[viewerId] = body.streamingOutput;
        }
        return answer({
          viewerId,
          preferences: {
            streamingOutput: state.preferences[viewerId] ?? false,
            updatedAt: now,
          },
        });
      }
      if (path.endsWith('/message-feedback')) {
        if (route.request().method() === 'GET')
          return answer({
            ok: true,
            value: { items: path.includes(A) ? state.messageFeedback : [] },
          });
        if (state.feedbackError) return answer({}, 503);
        state.feedbackWrites++;
        const body = route.request().postDataJSON();
        if (route.request().method() === 'DELETE') {
          state.messageFeedback = [];
          return answer({ ok: true, value: { absent: true } });
        }
        const saved: MessageFeedbackItem = {
          messageId: body.messageId,
          rating: body.rating,
          ...(body.note ? { note: body.note } : {}),
          ...(body.category ? { category: body.category } : {}),
          version: id(950 + state.feedbackWrites),
          createdAt: Date.parse(now),
          updatedAt: Date.parse(now),
        };
        state.messageFeedback = [saved];
        return answer({ ok: true, value: saved });
      }
      if (path.startsWith('/api/v1/admin/tenant-feedback')) {
        const entry = state.messageFeedback[0];
        const row = entry && {
          id: entry.messageId,
          version: entry.version,
          helpful: entry.rating === 'positive',
          reason: entry.note,
          category: entry.category,
          organization_name: '测试租户',
          workspace_name: '工作区',
          actor_name: '测试用户',
          employee_name: 'Office 文档助手',
          employee_version: 1,
          updated_at: now,
          review_status: state.feedbackReview.status,
          review_note: state.feedbackReview.note,
          response_preview: '报告已经完成',
          question: '制作一份报告',
          answer: '报告已经完成',
          model: 'synthetic',
          run_id: run,
          session_id: A,
          run_status: 'succeeded',
        };
        if (route.request().method() === 'PATCH') {
          const body = route.request().postDataJSON();
          state.feedbackReview = { status: body.status, note: body.note };
          return answer({ updated: true });
        }
        if (path.endsWith('/tenant-feedback'))
          return answer({
            items: row ? [row] : [],
            total: row ? 1 : 0,
            pending: state.feedbackReview.status === 'new' ? 1 : 0,
            page: 1,
            organizations: [{ id: org, name: '测试租户' }],
            employees: [{ id: id(7), name: 'Office 文档助手' }],
          });
        return answer({ feedback: row });
      }
      if (
        !options.queue &&
        path.endsWith('/messages') &&
        route.request().method() === 'POST'
      ) {
        const body = route.request().postDataJSON();
        state.messageInputs.push(body);
        return answer({
          run: { id: run },
          delivery: 'immediate',
          fallbackRunId: null,
          created: true,
          userMessage: {
            id: id(300),
            role: 'user',
            content: { text: body.text },
            status: 'completed',
            runId: run,
            createdAt: now,
          },
          assistantMessage: {
            id: id(500),
            role: 'assistant',
            content: { text: '正在处理…' },
            status: 'pending',
            runId: run,
            createdAt: now,
          },
        });
      }
      if (options.queue && route.request().method() === 'POST') {
        if (path.endsWith('/messages')) {
          const body = route.request().postDataJSON();
          state.messageInputs.push(body);
          const messageId = id(300 + state.messageInputs.length);
          const queued: QueuedMessage = {
            id: messageId,
            runId: id(400 + state.messageInputs.length),
            text: body.text,
            attachments: (body.attachmentIds ?? []).map((value: string) => ({
              id: value,
              fileName: 'inputs.txt',
              mediaType: 'text/plain',
              sizeBytes: 10,
            })),
            createdAt: now,
          };
          state.queue.push(queued);
          return answer({
            delivery: 'follow_up',
            fallbackRunId: queued.runId,
            run: { id: queued.runId },
            userMessage: {
              id: messageId,
              role: 'user',
              content: { text: body.text },
              status: 'completed',
              runId: null,
              createdAt: now,
            },
            assistantMessage: {
              id: id(500 + state.messageInputs.length),
              role: 'assistant',
              content: { text: 'Rice 正在处理…' },
              status: 'pending',
              runId: queued.runId,
              createdAt: now,
            },
          });
        }
        if (path.includes('/queued-messages/')) {
          const action = route.request().postDataJSON();
          state.queueActions.push(action);
          if (state.queueDelay) await state.queueDelay;
          if (state.queueError)
            return answer(
              { error: { message: '这条消息已开始处理，不能再从队列修改。' } },
              409,
            );
          state.queue = state.queue.filter(
            (item) => item.id !== path.split('/').at(-1),
          );
          return answer({ ok: true });
        }
      }
      if (path === '/api/v1/connections') {
        if (route.request().method() === 'PATCH') {
          const input = route.request().postDataJSON();
          expect(input.workspaceId).toBe(state.workspace);
          const connection = state.connections.find(
            (c) => c.id === input.connectionId,
          )!;
          state.connectionActions.push(input.action);
          if (input.action === 'disconnect') connection.disconnected = true;
          if (input.action === 'reconnect') connection.disconnected = false;
          if (input.action === 'delete') {
            connection.disconnected = true;
            connection.removed = true;
          }
          return answer({ connection });
        }
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        state.connectionReads++;
        return answer({ connections: state.connections });
      }
      if (route.request().method() !== 'GET') {
        writes.push(path);
        return answer({}, 500);
      }
      if (path === '/api/v1/workspace')
        return answer({
          workspace: {
            organizationId: org,
            workspaceId: state.workspace,
            viewerId: state.viewer,
            preferences: {
              streamingOutput: state.preferences[state.viewer] ?? false,
              updatedAt: now,
            },
            canAdminister: false,
            sessions: options.employeeHistory
              ? employeeHistorySessions
              : options.noSession
                ? []
                : state.omitSessionA
                  ? [session(B)]
                  : [session(A), session(B)],
            sessionModels: [],
            employeeProfiles: options.employeeHistory
              ? [
                  {
                    assignmentId: id(7),
                    employeeId: id(9),
                    name: 'Rice',
                    description: '负责研究、分析与文件交付',
                    identity: {
                      role: '研究助理',
                      mission: '帮助完成研究',
                      workStyle: '按步骤交付',
                      behaviorRules: [],
                      safetyBoundaries: [],
                    },
                    skills: [
                      {
                        id: 'office',
                        name: 'Office',
                        description: '阅读和交付文档',
                      },
                    ],
                    model: {
                      harness: 'dsh',
                      provider: 'codex',
                      model: 'configured-model',
                      reasoningEffort: 'medium',
                    },
                  },
                ]
              : [],
            employees:
              options.employeeCount === 0
                ? []
                : [
                    ...(options.employeeCount === 2
                      ? [
                          {
                            id: id(17),
                            employeeId: id(19),
                            isDefault: false,
                            versions: [],
                            currentVersion: {
                              id: id(18),
                              manifest: {
                                name: 'Office 文档助手',
                                description:
                                  '阅读文档并制作报告、表格与演示文稿。',
                                runtimePolicy: {
                                  harness: 'dsh',
                                  provider: 'codex',
                                },
                              },
                            },
                          },
                        ]
                      : []),
                    {
                      id: id(7),
                      employeeId: id(9),
                      isDefault: true,
                      versions: [],
                      currentVersion: {
                        id: id(8),
                        manifest: {
                          name: state.employeeName,
                          runtimePolicy: { harness: 'dsh', provider: 'codex' },
                        },
                      },
                    },
                  ],
          },
        });
      if (path === '/api/v1/saas/capabilities')
        return answer({
          capabilities: {
            schemaVersion: 1,
            roles: options.tenantAdmin
              ? ['member', 'tenant_admin']
              : ['member'],
            surfaces: ['chatflow'],
            actions: [],
            features: { chatFlowV3: true, nativeHarnessEvents: true },
          },
        });
      if (
        [
          '/api/v1/admin/mcp',
          '/api/v1/admin/local-mcp',
          '/api/v1/admin/browser-control',
          '/api/v1/admin/local-browser',
        ].includes(path)
      ) {
        expect(options.tenantAdmin).toBe(true);
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        return answer({
          enabled: true,
          connections: [],
          employees: [],
          devices: [],
          targets: [],
          members: [],
          grants: [],
          humanCredentialsConfigured: false,
        });
      }
      if (path === '/api/v1/bridge/devices') return answer({ devices: [] });
      if (path === '/api/v1/workspace/monthly-quota') {
        // A completed turn may still have a read in flight for the old scope.
        // Model the server denying it after a workspace switch, rather than
        // throwing inside Playwright's asynchronous route handler.
        if (url.searchParams.get('workspaceId') !== state.workspace)
          return answer({ error: { code: 'authorization_denied' } }, 403);
        return answer({
          organizationId: org,
          workspaceId: state.workspace,
          userId: state.viewer,
          displayName: 'Synthetic member',
          monthlyTokenLimit: 5000000,
          usedTokens: 2824029,
          remainingTokens: 2175971,
          remainingPercent: 43.51942,
          unknownUsageRuns: 0,
          periodStart: now,
          resetsAt: now,
          observedAt: now,
        });
      }
      if (path === '/api/v1/workspace/readiness') {
        state.readinessRequests++;
        const snapshot = {
          schemaVersion: 1,
          organizationId: org,
          workspaceId: state.workspace,
          viewerId: state.readinessWrongScope ? id(99) : state.viewer,
          sessionId: url.searchParams.get('sessionId'),
          employeeVersionId: id(8),
          observedAt: new Date().toISOString(),
          basis: 'next_task',
          canAdminister: state.canAdminister,
          capabilities: structuredClone(state.capabilities),
        };
        if (state.readinessDelay && url.searchParams.get('sessionId') === A)
          await state.readinessDelay;
        return answer(snapshot, state.readinessError ? 503 : 200);
      }
      if (path === '/api/v1/runtime/cloud-operations')
        return answer({ operations: [] });
      if (path === '/api/v1/runtime/assistants')
        return answer({ trees: [], nextCursor: null });
      if (path.endsWith('/interactions'))
        return answer(
          {
            runtime: options.queue
              ? {
                  state: 'running',
                  runId: run,
                  turnId: 'native-turn:1',
                  generation: 3,
                  configChecksum: 'queue-test',
                  currentVersionId: id(8),
                  nextVersionId: null,
                }
              : null,
            pendingActions: [],
            inputs: [],
            runTimings: path.includes(A) ? state.runTimings : [],
          },
          state.timingError ? 503 : 200,
        );
      if (path.endsWith('/timings'))
        return answer(
          { runTimings: path.includes(A) ? state.runTimings : [] },
          state.timingError ? 503 : 200,
        );
      if (path.endsWith('/events')) {
        if (url.searchParams.get('format') === 'json' || !options.running)
          return answer({ events: state.events });
        state.streamRequests++;
        await streamGate;
        return route.fulfill({
          contentType: 'text/event-stream',
          body: (
            state.streamEvents ?? [
              { type: 'assistant.text.delta', payload: { text: report } },
              { type: 'run.succeeded', payload: {} },
            ]
          )
            .map(
              (event, i) =>
                `data: ${JSON.stringify({
                  schemaVersion: 3,
                  eventId: id(200 + i),
                  organizationId: org,
                  workspaceId: workspace,
                  conversationId: null,
                  runId: run,
                  generation: 1,
                  cursor: `${run}:${i + 1}`,
                  sequence: i + 1,
                  harness: 'dsh',
                  occurredAt: now,
                  sourceEvent: null,
                  ...event,
                })}\n\n`,
            )
            .join(''),
        });
      }
      if (path === '/api/dsh-ui/pdf') {
        const require = createRequire(resolve('apps/web/package.json'));
        const file = join(
          dirname(
            require.resolve('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/package.json'),
          ),
          'lib/client.pdf.js',
        );
        return route.fulfill({
          contentType: 'text/javascript',
          body: await readFile(file),
        });
      }
      if (path === '/api/v1/files') {
        state.fileReads++;
        if (state.fileDelay) await state.fileDelay;
        return answer({ files: state.files });
      }
      if (path.startsWith('/api/v1/files/') && path.endsWith('/versions'))
        return answer({
          versions: state.items
            .filter(
              (a) =>
                a.version.seriesId ===
                state.items.find((item) => path.includes(item.object.id))
                  ?.version.seriesId,
            )
            .map((a) => a.version),
        });
      if (path.startsWith('/api/v1/files/') && path.endsWith('/preview'))
        return state.files.some((file) => path.includes(file.id))
          ? answer(state.filePreview)
          : answer({ error: { message: '文件已不存在' } }, 404);
      if (path.endsWith('/artifacts')) {
        state.artifactReads++;
        const items = path.includes(A) ? [...state.items] : [];
        if (state.delay && path.includes(A)) await state.delay;
        return answer(
          { artifacts: items, nextCursor: null },
          state.listError ? 503 : 200,
        );
      }
      if (path.includes('/artifacts/')) {
        const a = state.items.find((item) => path.includes(item.id));
        if (!a) return answer({}, 404);
        if (path.endsWith('/content'))
          return answer(
            state.officePreview ?? {
              kind: 'text',
              mediaType: 'text/markdown',
              text: state.text,
            },
            state.contentError ? 503 : 200,
          );
        return answer({ artifact: a, feedback: [] });
      }
      if (path === `/api/v1/sessions/${A}` && state.deepLinkDenied)
        return answer({ error: { message: 'Not accessible' } }, 403);
      const listedHistory = options.employeeHistory
        ? employeeHistorySessions.find(
            (item) => path === `/api/v1/sessions/${item.id}`,
          )
        : undefined;
      if (
        path === `/api/v1/sessions/${A}` ||
        path === `/api/v1/sessions/${B}` ||
        listedHistory
      )
        return answer({
          history: {
            session: listedHistory ?? session(path.endsWith(A) ? A : B),
            queuedMessages: path.endsWith(A) ? state.queue : [],
            messages: path.endsWith(A)
              ? (state.messages ?? [
                  {
                    id: id(20),
                    role: 'assistant',
                    runId: run,
                    status: state.messageStatus,
                    content: {
                      text:
                        state.messageStatus === 'pending' ? '' : state.reply,
                    },
                    createdAt: now,
                  },
                  ...state.queuedStarted,
                ])
              : [],
            contextStatus: {
              percentage: 0,
              pressureTokens: 0,
              thresholdTokens: 40000,
              compactionDue: false,
            },
            nativeContextStatus: null,
          },
        });
      unexpected.push(path);
      return answer({}, 404);
    });
    await page.goto(
      `${origin}/?session=${options.noSession ? '' : A}${options.disabled ? '&disabled=1' : ''}`,
    );
    await page
      .getByRole('textbox', { name: /^给 .+ 的消息$/ })
      .waitFor()
      .catch(async (error) => {
        console.error(
          'UI mount',
          errors,
          await page.locator('body').innerText(),
        );
        throw error;
      });
    const panel = page.locator('#artifact-workbench:not([aria-hidden="true"])');
    const entry = page.getByRole('button', { name: /▤ 交付成果/ });
    return {
      context,
      page,
      state,
      errors,
      writes,
      unexpected,
      panel,
      entry,
      releaseStream: finishStream,
      finishRun() {
        state.messageStatus = 'completed';
        state.items = [artifact(11)];
        finishStream();
      },
      async fileAction(name: string) {
        await panel
          .getByRole('button', { name: '更多文件操作', exact: true })
          .last()
          .click();
        await page.getByRole('menuitem', { name, exact: true }).click();
      },
      async selectArtifact(n: number) {
        await panel
          .getByRole('button', { name: '更多文件操作', exact: true })
          .last()
          .click();
        await page
          .getByRole('menuitem', { name: '查看所有成果', exact: true })
          .click();
        await panel
          .getByRole('button', { name: new RegExp(`report-${n}\\.md`) })
          .click();
      },
      async reloadList() {
        await entry.click();
        await panel
          .getByRole('button', { name: '更多文件操作', exact: true })
          .last()
          .waitFor();
      },
      async close() {
        finishStream();
        await context.close();
        expect(errors).toEqual([]);
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
      },
    };
  }

  it('native turn navigation previews, jumps and tracks reading position, and hides when the conversation narrows', async () => {
    const f = await fixture();
    try {
      expect(
        await f.page.getByRole('navigation', { name: '轮次导航' }).count(),
      ).toBe(0);
      f.state.messages = navigationHistory(12);
      await f.page.reload();
      const rail = f.page.getByRole('navigation', { name: '轮次导航' });
      await rail.waitFor();
      const first = rail.getByRole('button', {
        name: '跳转到第 1 轮',
        exact: true,
      });
      const scroller = f.page.locator('[data-conversation-scroll]');
      await expect
        .poll(() =>
          rail.locator('[aria-current="true"]').getAttribute('aria-label'),
        )
        .toBe('跳转到第 12 轮');
      await first.hover();
      const tooltip = rail.getByRole('tooltip');
      await tooltip
        .getByText('第 1 项工作：分析文档', { exact: true })
        .waitFor();
      expect(await tooltip.innerText()).toContain('第 1 项答复');
      expect(
        await tooltip.evaluate((node) => getComputedStyle(node).boxShadow),
      ).not.toBe('none');
      expect(
        await tooltip
          .locator('> div')
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('13px');
      await first.click();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      const targetTop = () =>
        f.page
          .locator(`#message-${id(2000)}`)
          .evaluate(
            (node) =>
              node.getBoundingClientRect().top -
              document
                .querySelector('[data-conversation-scroll]')!
                .getBoundingClientRect().top,
          );
      await expect.poll(targetTop).toBeGreaterThanOrEqual(15);
      expect(await targetTop()).toBeLessThan(18);
      const second = rail.getByRole('button', {
        name: '跳转到第 2 轮',
        exact: true,
      });
      await second.focus();
      await tooltip
        .getByText('第 2 项工作：分析文档', { exact: true })
        .waitFor();
      await second.press('Enter');
      await expect.poll(() => second.getAttribute('aria-current')).toBe('true');
      await scroller.evaluate(
        (scroll, targetId) => {
          scroll.scrollTop +=
            document.getElementById(targetId)!.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top;
        },
        `message-${id(2012)}`,
      );
      await expect
        .poll(() =>
          rail.locator('[aria-current="true"]').getAttribute('aria-label'),
        )
        .toBe('跳转到第 7 轮');
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      await expect.poll(() => rail.isVisible()).toBe(false);
      await f.page.setViewportSize({ width: 2200, height: 950 });
      await rail.waitFor();
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      await first.hover();
      expect(
        await tooltip.evaluate((node) => getComputedStyle(node).animationName),
      ).toBe('none');
      await f.page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => rail.isVisible()).toBe(false);
      expect(
        await f.page
          .locator('body')
          .evaluate((body) => body.scrollWidth <= innerWidth),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('native turn rail virtualizes long history and clears previews on session change', async () => {
    const f = await fixture();
    try {
      f.state.messages = navigationHistory(100, 2);
      await f.page.reload();
      const rail = f.page.getByRole('navigation', { name: '轮次导航' });
      const last = rail.getByRole('button', {
        name: '跳转到第 100 轮',
        exact: true,
      });
      await last.waitFor({ timeout: 15_000 });
      expect(await rail.getByRole('button').count()).toBeLessThan(55);
      await rail
        .locator('> div')
        .first()
        .evaluate((node) => {
          node.scrollTop = 0;
        });
      const first = rail.getByRole('button', {
        name: '跳转到第 1 轮',
        exact: true,
      });
      await first.hover();
      await rail.getByRole('tooltip').waitFor();
      await first.click();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      await f.page.getByRole('treeitem', { name: /研究任务 B/ }).click();
      await expect.poll(() => rail.count()).toBe(0);
      expect(await f.page.getByRole('tooltip').count()).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('returning to an old turn holds the reading position when an in-flight answer finishes', async () => {
    const f = await fixture({ running: true });
    try {
      f.state.messages = navigationHistory(5);
      const pending = f.state.messages.at(-1)!;
      pending.runId = run;
      pending.status = 'pending';
      pending.content.text = '';
      f.state.messages.at(-2)!.runId = run;
      await f.page.reload();
      const rail = f.page.getByRole('navigation', { name: '轮次导航' });
      const first = rail.getByRole('button', {
        name: '跳转到第 1 轮',
        exact: true,
      });
      await first.click();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      const scroller = f.page.locator('[data-conversation-scroll]');
      const before = await scroller.evaluate((node) => node.scrollTop);
      pending.status = 'completed';
      pending.content.text = report;
      f.finishRun();
      f.state.items = [];
      await f.page.getByRole('heading', { name: /COIN/ }).waitFor();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      expect(
        Math.abs((await scroller.evaluate((node) => node.scrollTop)) - before),
      ).toBeLessThan(2);
      await f.page
        .getByRole('button', { name: '回到底部', exact: true })
        .click();
      await expect
        .poll(() =>
          rail.locator('[aria-current="true"]').getAttribute('aria-label'),
        )
        .toBe('跳转到第 5 轮');
    } finally {
      await f.close();
    }
  }, 30_000);

  it('native feedback hover, copy, rating dialog, retry, withdrawal and platform follow-up work together', async () => {
    const f = await fixture();
    try {
      const row = f.page.locator(`#message-${id(20)}`);
      const copy = row.getByRole('button', { name: '复制', exact: true });
      await f.page.mouse.move(20, 20);
      await expect
        .poll(() =>
          copy.locator('..').evaluate((n) => getComputedStyle(n).opacity),
        )
        .toBe('0');
      await row.hover();
      await copy.click();
      await row.getByRole('button', { name: '已复制', exact: true }).waitFor();
      expect(await row.getByRole('button', { name: /分支/ }).count()).toBe(0);
      await row
        .getByRole('button', { name: '有问题的回答', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', {
        name: '提交反馈',
        exact: true,
      });
      await dialog.waitFor();
      await dialog
        .getByRole('button', { name: '任务结果', exact: true })
        .click();
      await dialog
        .getByRole('textbox', { name: '反馈详情' })
        .fill('请补充数据来源');
      if (process.env.ALLRICE_FEEDBACK_SCREENSHOT)
        await f.page.screenshot({
          path: process.env.ALLRICE_FEEDBACK_SCREENSHOT + '-dialog.png',
        });
      f.state.feedbackError = true;
      await dialog.getByRole('button', { name: '提交', exact: true }).click();
      await f.page.getByText('反馈保存失败', { exact: true }).waitFor();
      expect(
        await dialog.getByRole('textbox', { name: '反馈详情' }).inputValue(),
      ).toBe('请补充数据来源');
      f.state.feedbackError = false;
      await dialog.getByRole('button', { name: '提交', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      expect(f.state.messageFeedback[0]).toMatchObject({
        rating: 'negative',
        category: 'task-result',
        note: '请补充数据来源',
      });
      await f.page.mouse.move(20, 20);
      await expect
        .poll(() =>
          copy.locator('..').evaluate((n) => getComputedStyle(n).opacity),
        )
        .toBe('1');
      await row.getByRole('button', { name: '取消标记', exact: true }).click();
      await expect.poll(() => f.state.messageFeedback.length).toBe(0);
      await row.getByRole('button', { name: '好的回答', exact: true }).click();
      await dialog.getByRole('button', { name: '提交', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await f.page.goto(`${origin}/?feedback-inbox=1`);
      await f.page.getByRole('button', { name: /测试租户 · 测试用户/ }).click();
      await f.page.getByRole('heading', { name: '对应问题' }).waitFor();
      await f.page.getByText('制作一份报告', { exact: true }).waitFor();
      await f.page
        .getByRole('combobox', { name: '反馈处理状态', exact: true })
        .selectOption('resolved');
      await f.page
        .getByRole('textbox', { name: '处理备注' })
        .fill('已补充来源规则');
      await f.page.getByRole('button', { name: '保存处理记录' }).click();
      await expect
        .poll(() => f.state.feedbackReview)
        .toEqual({ status: 'resolved', note: '已补充来源规则' });
      if (process.env.ALLRICE_FEEDBACK_SCREENSHOT)
        await f.page.screenshot({
          path: process.env.ALLRICE_FEEDBACK_SCREENSHOT + '-inbox.png',
        });
      expect(f.state.messageInputs).toHaveLength(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);

  it('document reader keeps mobile actions visible, uses native menus and preserves exact version downloads', async () => {
    const f = await fixture({ width: 390, artifacts: true });
    try {
      const older = artifact(10),
        latest = artifact(11);
      latest.version.seriesId = older.version.seriesId;
      latest.version.version = 2;
      latest.version.parentVersionId = older.id;
      latest.version.parentObjectId = older.object.id;
      older.stale = true;
      older.latestVersionId = latest.id;
      f.state.items = [latest, older];
      await f.page.reload();
      await f.entry.click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      const download = f.panel.getByRole('link', { name: '下载', exact: true });
      expect(await download.getAttribute('href')).toContain(latest.object.id);
      expect((await download.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      expect(
        await f.panel
          .getByText(/版本与基线标识|历史执行位置|SaaS 文件库|查看原文/)
          .count(),
      ).toBe(0);
      await f.page.waitForFunction(() => {
        const r = document
          .querySelector('#artifact-workbench [aria-label="文件操作"]')!
          .getBoundingClientRect();
        return Math.abs(r.left) < 2 && r.right <= innerWidth + 1;
      });
      await f.page.screenshot({
        path: '.local/reader/mobile.png',
        animations: 'disabled',
      });
      await f.panel
        .getByRole('region', { name: '文件正文', exact: true })
        .evaluate((n) => {
          n.parentElement!.scrollTop = 400;
        });
      expect(await download.isVisible()).toBe(true);
      await f.fileAction('查看源文本');
      await f.panel
        .getByRole('region', { name: '源文本', exact: true })
        .waitFor();
      await f.panel
        .getByRole('button', { name: '更多文件操作', exact: true })
        .click();
      await f.page
        .getByRole('menuitem', { name: '查看预览', exact: true })
        .focus();
      await f.page.keyboard.press('Escape');
      expect(await f.panel.isVisible()).toBe(true);
      await f.panel
        .getByRole('button', { name: '历史版本', exact: true })
        .click();
      await f.page.getByRole('menuitem', { name: /^v1 ·/ }).waitFor();
      await f.page.keyboard.press('Escape');
      expect(await f.panel.isVisible()).toBe(true);
      await f.panel
        .getByRole('button', { name: '历史版本', exact: true })
        .click();
      await f.page.getByRole('menuitem', { name: /^v1 ·/ }).click();
      await expect
        .poll(() =>
          f.panel
            .getByRole('link', { name: '下载', exact: true })
            .getAttribute('href'),
        )
        .toContain(older.object.id);
      await f.panel
        .getByRole('button', { name: '查看最新版本', exact: true })
        .waitFor();
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      await f.page.screenshot({
        path: '.local/reader/desktop.png',
        animations: 'disabled',
      });
    } finally {
      await f.close();
    }
  });

  it('tool search records stay in process files and render readable output with original source links', async () => {
    const f = await fixture();
    try {
      const raw = artifact(10);
      raw.version.fileName = `tool-result-web-search-${raw.object.id}.txt`;
      raw.version.changeSummary = `Tool result web.search; Run ${run}; call call-1`;
      raw.provenance.kind = 'legacy_deliverable';
      f.state.items = [raw];
      f.state.files = [
        {
          id: raw.object.id,
          fileName: raw.version.fileName,
          mediaType: 'text/plain',
          sizeBytes: 120,
          visibility: 'private',
          ownedByMe: true,
          category: 'exports',
          deliverableVersion: 1,
        },
      ];
      f.state.filePreview = {
        kind: 'text',
        mediaType: 'text/plain',
        text: JSON.stringify({
          provider: 'fixture',
          query: '官方公告',
          output:
            '[查看官方公告](https://example.com/news)\n\n已经发布的公告摘录。\n\nRevenue $100 and price $25.',
        }),
      };
      await f.page.reload();
      expect(await f.panel.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      const tree = f.panel.locator('[data-files-state="tree"]');
      await tree.getByRole('button', { name: '交付文件', exact: true }).click();
      expect(await tree.getByRole('button', { name: /搜索资料/ }).count()).toBe(
        0,
      );
      await tree.getByRole('button', { name: '过程资料', exact: true }).click();
      await tree.getByRole('button', { name: /^搜索资料 ·/ }).click();
      await f.panel
        .getByText('已经发布的公告摘录。', { exact: true })
        .waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '查看官方公告', exact: true })
          .getAttribute('href'),
      ).toBe('https://example.com/news');
      expect(await f.panel.getByText(/"provider"/).count()).toBe(0);
      await f.panel
        .getByText('Revenue $100 and price $25.', { exact: true })
        .waitFor();
      expect(await f.panel.locator('.katex').count()).toBe(0);
      await f.fileAction('查看源文本');
      await expect
        .poll(() =>
          f.panel
            .getByRole('region', { name: '源文本', exact: true })
            .innerText(),
        )
        .toContain('provider');
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('href'),
      ).toContain(raw.object.id);
    } finally {
      await f.close();
    }
  });

  it('artifact previews keep file actions and use the chat composer for revision requests', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .isVisible(),
      ).toBe(true);
      expect(await f.panel.getByRole('textbox').count()).toBe(0);
      expect(await f.panel.getByText(/修改记录|让Rice修改/).count()).toBe(0);
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await input.fill('请把 report-10.md 的结论放在开头');
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      expect(await input.inputValue()).toBe('请把 report-10.md 的结论放在开头');
      await input.press('Enter');
      await expect.poll(() => f.state.messageInputs.length).toBe(1);
      expect(f.state.messageInputs[0]?.text).toBe(
        '请把 report-10.md 的结论放在开头',
      );
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('MET160 employee hierarchy keeps historical ownership, supports direct/new picker and employee rail', async () => {
    const f = await fixture({ employeeCount: 2, employeeHistory: true });
    try {
      const rice = f.page.locator('[data-row-key="workspace:' + id(7) + '"]');
      await f.page
        .getByRole('button', { name: '查看Rice详情', exact: true })
        .click();
      const intro = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await intro
        .getByText('负责研究、分析与文件交付', { exact: true })
        .waitFor();
      await intro.getByText('Office', { exact: true }).waitFor();
      await intro.getByRole('button', { name: '关闭', exact: true }).click();

      if ((await rice.getAttribute('aria-expanded')) !== 'true')
        await rice.click();
      await f.page.getByRole('button', { name: /展开其余/ }).click();
      expect(
        await f.page.getByText('历史工作 7', { exact: true }).isVisible(),
      ).toBe(true);
      expect(
        await f.page.getByRole('region', { name: '旧员工（已撤回）' }).count(),
      ).toBe(1);
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      const picker = f.page.getByRole('dialog', { name: '选择 AI 员工' });
      await picker.waitFor();
      await expect
        .poll(() =>
          picker
            .locator('[data-default-employee="true"]')
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-picker.png`,
        });
      await f.page.keyboard.press('1');
      expect(await picker.count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '与 Office 文档助手 工作', exact: true })
          .count(),
      ).toBe(1);
      const officeInput = f.page.getByRole('textbox', {
        name: '给 Office 文档助手 的消息',
      });
      await officeInput.waitFor();
      expect(await officeInput.getAttribute('placeholder')).toBe(
        '告诉 Office 文档助手 你想完成什么工作',
      );
      expect(
        await f.page
          .getByRole('heading', {
            name: '与 Office 文档助手 工作',
            exact: true,
          })
          .count(),
      ).toBe(1);
      expect(
        await f.page
          .getByText('阅读文档并制作报告、表格与演示文稿。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await f.page
          .locator('[data-employee-accent]')
          .getAttribute('data-employee-accent'),
      ).toBe('orange');
      expect(
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).count(),
      ).toBe(0);
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-office-welcome.png`,
        });
      await rice.hover();
      expect(
        await f.page
          .getByRole('button', { name: '与 Rice 新建工作', exact: true })
          .count(),
      ).toBe(0);
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      await picker.getByRole('button', { name: /Rice/ }).click();
      expect(await picker.count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '与 Rice 工作', exact: true })
          .count(),
      ).toBe(1);
      await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
      expect(
        await f.page
          .locator('[data-employee-accent]')
          .getAttribute('data-employee-accent'),
      ).toBe('blue');
      await f.page
        .getByRole('button', { name: '收起侧边栏', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: 'Office 文档助手', exact: true })
        .click();
      expect(
        await f.page
          .getByRole('group', { name: 'Office 文档助手的工作' })
          .isVisible(),
      ).toBe(true);
      expect(
        await f.page
          .getByRole('button', { name: '＋ 新建工作', exact: true })
          .count(),
      ).toBe(0);
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-rail.png`,
        });
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);
  it('MET160 zero and single employee new-work entry never uses an invalid assignment', async () => {
    for (const employeeCount of [0, 1]) {
      const f = await fixture({ employeeCount, noSession: true });
      try {
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        expect(
          await f.page.getByRole('dialog', { name: '选择 AI 员工' }).count(),
        ).toBe(0);
        if (!employeeCount)
          expect(
            await f.page
              .getByText('当前没有可用员工，请先派驻员工。', { exact: true })
              .isVisible(),
          ).toBe(true);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
        expect(
          await f.page
            .getByRole('textbox', {
              name: employeeCount ? '给 Rice 的消息' : '给 AI 员工 的消息',
            })
            .count(),
        ).toBe(1);
      } finally {
        await f.close();
      }
    }
  }, 20_000);

  it.each([390, 1440])(
    'QueueDock persists two sends outside transcript, edits with attachments and revokes on the server at width %i',
    async (width) => {
      const f = await fixture({ running: true, queue: true, width });
      try {
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        await expect.poll(() => f.state.streamRequests).toBe(1);
        expect(
          await f.page
            .getByRole('combobox', { name: '运行中输入意图' })
            .count(),
        ).toBe(0);
        for (const text of ['queued one', 'queued two']) {
          await input.fill(text);
          await input.press('Enter');
          await expect.poll(() => input.isEnabled()).toBe(true);
        }
        await f.page.getByRole('button', { name: /排队消息 · 2/ }).click();
        const dock = f.page.locator('[data-queue-dock]');
        expect(await dock.locator('li').count()).toBe(2);
        if (process.env.ALLRICE_QUEUE_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_QUEUE_SCREENSHOT}-${width}.png`,
          });
        const box = await dock.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(
          await f.page
            .locator('[id^="message-"]')
            .filter({ hasText: 'queued one' })
            .count(),
        ).toBe(0);
        expect(f.state.streamRequests).toBe(1); // No SSE for pending queue Runs.
        f.state.queue[0]!.attachments = [
          {
            id: id(800),
            fileName: 'inputs.txt',
            mediaType: 'text/plain',
            sizeBytes: 10,
          },
        ];
        await f.page.reload();
        await f.page.getByRole('button', { name: /排队消息 · 2/ }).click();
        await dock.getByText(/inputs.txt/).waitFor();
        expect(
          await dock
            .getByRole('button', { name: '立即引导' })
            .first()
            .isDisabled(),
        ).toBe(true);
        await dock.getByRole('button', { name: '重新编辑' }).first().click();
        await expect.poll(() => input.inputValue()).toBe('queued one');
        await expect.poll(() => input.isEnabled()).toBe(true);
        expect(f.state.queue.map((m) => m.text)).toEqual(['queued two']);
        expect(
          await dock.getByRole('button', { name: '重新编辑' }).isDisabled(),
        ).toBe(true); // preserve current draft
        await input.fill('edited with attachment');
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(3);
        expect(f.state.messageInputs[2]!.attachmentIds).toEqual([id(800)]);
        await expect.poll(() => input.isEnabled()).toBe(true);
        const header = dock.getByRole('button', { name: /排队消息 · 2/ });
        if ((await header.getAttribute('aria-expanded')) === 'false')
          await header.click();
        await dock.getByRole('button', { name: '撤回消息' }).first().click();
        await expect.poll(() => f.state.queue.length).toBe(1);
        expect(f.state.queue[0]!.text).toBe('edited with attachment');
        expect(f.state.queueActions.map((a) => a.action)).toEqual([
          'edit',
          'remove',
        ]);
      } finally {
        await f.close();
      }
    },
  );
  it('QueueDock preserves rejected actions and steers once at the exact current turn', async () => {
    const f = await fixture({ running: true, queue: true });
    try {
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await input.fill('correct current task');
      await input.press('Enter');
      const dock = f.page.locator('[data-queue-dock]');
      await dock.getByText('correct current task').waitFor();
      f.state.queueError = true;
      await dock.getByRole('button', { name: '撤回消息' }).click();
      await dock.getByRole('alert').waitFor();
      expect(f.state.queue).toHaveLength(1);
      f.state.queueError = false;
      await dock.getByRole('button', { name: '立即引导' }).click();
      await expect.poll(() => f.state.queue.length).toBe(0);
      expect(f.state.queueActions[1]).toEqual({
        action: 'steer',
        expectedTurnId: 'native-turn:1',
        expectedGeneration: 3,
      });
      expect(f.state.messageInputs).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('QueueDock follows worker FIFO without sending again and cannot restore an edited draft into another session', async () => {
    const f = await fixture({ running: true, queue: true });
    try {
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await input.fill('next real turn');
      await input.press('Enter');
      await f.page
        .locator('[data-queue-dock]')
        .getByText('next real turn')
        .waitFor();
      const item = f.state.queue.shift()!;
      f.state.queuedStarted.push({
        id: item.id,
        role: 'user',
        content: { text: item.text },
        status: 'completed',
        runId: null,
        createdAt: now,
      });
      await expect
        .poll(() => f.page.locator('[data-queue-dock]').count(), {
          timeout: 5000,
        })
        .toBe(0);
      expect(f.state.messageInputs).toHaveLength(1);
      await input.fill('edit delayed');
      await input.press('Enter');
      await f.page
        .locator('[data-queue-dock]')
        .getByText('edit delayed')
        .waitFor();
      let finish!: () => void;
      f.state.queueDelay = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await f.page.getByRole('button', { name: '重新编辑' }).click();
      await f.page.getByText('研究任务 B', { exact: true }).click();
      finish();
      await expect.poll(() => f.state.queue.length).toBe(0);
      expect(await input.inputValue()).toBe('');
      expect(await input.isEnabled()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each([390, 1440])(
    'places the daily mode pill between attachment and visibility controls at width %i',
    async (width) => {
      const f = await fixture({ width });
      try {
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        const mode = f.page.getByRole('combobox', {
          name: '工作模式',
          exact: true,
        });
        await mode.waitFor();
        expect(await mode.inputValue()).toBe('daily');
        expect(await mode.locator('option:disabled').allTextContents()).toEqual(
          ['🎯 深入攻关 · 规划中', '👥 团队协作 · 规划中'],
        );
        expect(
          await f.page.getByText('本次不使用助手', { exact: true }).count(),
        ).toBe(0);
        expect(await f.page.locator('fieldset').count()).toBe(0);
        expect(
          await input.evaluate((element) => element.previousElementSibling),
        ).toBeNull();
        const add = await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .boundingBox();
        const pill = await mode.boundingBox();
        const visibility = await f.page
          .getByRole('combobox', { name: '上传文件可见范围' })
          .boundingBox();
        const textarea = await input.boundingBox();
        expect(add!.x + add!.width).toBeLessThan(pill!.x);
        expect(pill!.x + pill!.width).toBeLessThan(visibility!.x);
        expect(Math.abs(add!.y - pill!.y)).toBeLessThan(2);
        expect(Math.abs(visibility!.y - pill!.y)).toBeLessThan(2);
        expect(pill!.y).toBeGreaterThanOrEqual(textarea!.y + textarea!.height);
        await input.fill('保留问题和键盘操作');
        await mode.focus();
        await f.page.keyboard.press('ArrowDown');
        expect(await mode.inputValue()).toBe('daily');
        expect(await input.inputValue()).toBe('保留问题和键盘操作');
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it('reuses native rows for chronological Chinese steps, retains failures and uses the employee identity', async () => {
    const f = await fixture();
    try {
      f.state.employeeName = 'Office 文档助手';
      f.state.events = Array.from({ length: 10 }, (_, i) => ({
        schemaVersion: 3,
        eventId: id(700 + i),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 1,
        sequence: i + 1,
        cursor: `${run}:${i + 1}`,
        harness: 'dsh',
        occurredAt: now,
        sourceEvent: null,
        type: i === 8 ? 'tool.failed' : 'tool.completed',
        payload: {
          toolCallId: `call-${i}`,
          name: i === 9 ? 'workspace.export.create' : 'market.quote',
          ...(i === 8
            ? { summary: '行情服务超时' }
            : {
                summary:
                  i === 9
                    ? '已生成财报摘要.docx'
                    : `已查询第 ${i + 1} 个标的的行情`,
              }),
        },
      }));
      await f.page.reload();
      const process = f.page.getByRole('region', {
        name: '工作过程',
        exact: true,
      });
      const toggle = process.getByRole('button');
      await expect.poll(() => toggle.innerText()).toContain('1 次未成功');
      expect(await toggle.innerText()).toContain('1 次未成功');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await process.getByRole('list').count()).toBe(0);
      await toggle.focus();
      await f.page.keyboard.press('Enter');
      const groups = process.getByRole('list', { name: '工作步骤' });
      expect(await groups.getByRole('listitem').count()).toBe(10);
      expect(await groups.innerText()).toContain('已查询第 1 个标的的行情');
      expect(await groups.innerText()).toContain('已生成财报摘要.docx');
      expect(await groups.getByRole('button').count()).toBe(0);
      expect(await groups.locator('svg').count()).toBe(10);
      expect(await groups.innerText()).not.toMatch(/累计|已完成|次操作/);
      expect(await groups.innerText()).toContain('行情服务超时');
      expect(
        await groups.evaluate(
          (el) => getComputedStyle(el.parentElement!).maxHeight,
        ),
      ).toBe('360px');
      expect(await f.page.getByLabel('助手任务', { exact: true }).count()).toBe(
        0,
      );
      expect(
        await f.page.locator('[id^="message-"]').last().innerText(),
      ).toContain('Office 文档助手');
      expect(
        await f.page
          .getByRole('textbox', { name: '给 Office 文档助手 的消息' })
          .getAttribute('placeholder'),
      ).toBe('继续和 Office 文档助手 工作…');
      expect(
        await f.page
          .locator('[data-employee-accent]')
          .getAttribute('data-employee-accent'),
      ).toBe('orange');
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-process.png`,
        });
      await toggle.focus();
      await f.page.keyboard.press(' ');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await f.close();
    }
  });

  it('shows the current member monthly balance inside native settings', async () => {
    const f = await fixture();
    try {
      const settings = f.page.getByRole('button', {
        name: '设置',
        exact: true,
      });
      expect(
        await f.page.locator('summary[aria-label="账号月额度"]').count(),
      ).toBe(0);
      await settings.click();
      const quota = f.page.locator('summary[aria-label="账号月额度"]');
      await quota.getByText('Synthetic member', { exact: true }).waitFor();
      await quota.getByText('剩余 43%', { exact: true }).waitFor();
      await f.page.getByText('本月已记录', { exact: false }).waitFor();
      expect(
        await f.page.locator('details').filter({ has: quota }).innerText(),
      ).toContain('5,000,000');
      await f.page.reload();
      await settings.click();
      await quota.getByText('剩余 43%', { exact: true }).waitFor();
    } finally {
      await f.close();
    }
  });

  it.each([
    { width: 390, tenantAdmin: false },
    { width: 1440, tenantAdmin: false },
    { width: 1440, tenantAdmin: true },
  ])(
    'MET159 native settings works without admin configuration, preserves drafts and restores focus (%o)',
    async ({ width, tenantAdmin }) => {
      const f = await fixture({ width, tenantAdmin });
      f.state.connections = [
        McpConnectionSchema.parse({
          id: id(70),
          definitionId: id(71),
          workspaceId: workspace,
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
        }),
      ];
      try {
        const composer = f.page.getByRole('textbox', { name: '消息' });
        await composer.fill('保留聊天草稿');
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const trigger = f.page.getByRole('button', {
          name: '设置',
          exact: true,
        });
        expect(
          await f.page.getByRole('link', { name: 'MCP 连接管理' }).count(),
        ).toBe(0);
        await trigger.click();
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await dialog.getByText('Synthetic member', { exact: true }).waitFor();
        await f.page.screenshot({
          path: `/tmp/met160-settings-account-${width}.png`,
        });
        await dialog
          .getByRole('button', { name: '已连接应用', exact: true })
          .click();
        await dialog.getByText('需要登录', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: '填写连接凭据' }).click();
        const credential = dialog.getByLabel('应用访问令牌');
        await credential.fill('synthetic-unsaved-token');
        await dialog
          .getByRole('button', { name: '账号与用量', exact: true })
          .click();
        await dialog
          .getByRole('button', { name: '我的电脑', exact: true })
          .click();
        await dialog.getByRole('button', { name: '连接与管理电脑' }).waitFor();
        expect(
          await dialog
            .getByRole('button', { name: '云端浏览器', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('button', { name: '本地浏览器', exact: true })
            .count(),
        ).toBe(0);
        await dialog
          .getByRole('button', { name: '已连接应用', exact: true })
          .click();
        expect(await credential.inputValue()).toBe('synthetic-unsaved-token');
        const reads = f.state.connectionReads;
        await f.page.clock.install();
        await f.page.clock.runFor(31_000);
        expect(f.state.connectionReads).toBe(reads);
        await dialog
          .getByRole('button', { name: '断开连接', exact: true })
          .click();
        await dialog.getByText('已断开', { exact: true }).waitFor();
        expect(await credential.count()).toBe(0);
        await dialog
          .getByRole('button', { name: '重新连接', exact: true })
          .click();
        await dialog
          .getByRole('button', { name: '删除连接', exact: true })
          .click();
        await dialog.getByText('还没有连接应用。', { exact: false }).waitFor();
        expect(f.state.connectionActions).toEqual([
          'disconnect',
          'reconnect',
          'delete',
        ]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await f.page.screenshot({
          path: `/tmp/met160-settings-connections-${width}.png`,
        });
        const focusables = dialog.locator(
          'button:not(:disabled):visible,input:not(:disabled):visible',
        );
        await focusables.last().focus();
        await f.page.keyboard.press('Tab');
        expect(
          await dialog.evaluate((e) => e.contains(document.activeElement)),
        ).toBe(true);
        await f.page.keyboard.press('Escape');
        expect(await dialog.count()).toBe(0);
        expect(
          await trigger.evaluate((e) => e === document.activeElement),
        ).toBe(true);
        if (width < 600) {
          expect(
            await f.page.getByRole('dialog', { name: '任务与历史' }).count(),
          ).toBe(1);
          await f.page.keyboard.press('Escape');
        }
        expect(await composer.inputValue()).toBe('保留聊天草稿');
        if (width >= 600)
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .click();
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        await dialog.waitFor();
      } finally {
        await f.close();
      }
    },
  );

  it('MET159 closes personal settings and discards credential drafts when a refreshed workspace changes viewer', async () => {
    const f = await fixture({ running: true });
    try {
      await expect.poll(() => f.state.streamRequests).toBeGreaterThan(0);
      f.state.connections = [
        McpConnectionSchema.parse({
          id: id(70),
          definitionId: id(71),
          workspaceId: workspace,
          name: '上一位用户的应用',
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
        }),
      ];
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      await settings
        .getByRole('button', { name: '已连接应用', exact: true })
        .click();
      await settings.getByRole('button', { name: '填写连接凭据' }).click();
      await settings.getByLabel('应用访问令牌').fill('synthetic-private-draft');
      f.state.viewer = id(50);
      f.state.workspace = id(51);
      f.state.connections = [];
      f.finishRun();
      await expect.poll(() => settings.count()).toBe(0);
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      await settings
        .getByRole('button', { name: '已连接应用', exact: true })
        .click();
      await settings.getByText('还没有连接应用。', { exact: false }).waitFor();
      expect(await settings.getByLabel('应用访问令牌').count()).toBe(0);
      expect(await settings.getByText('上一位用户的应用').count()).toBe(0);
      expect(f.state.connectionActions).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('saves the native streaming switch per account, defaults to unified output and never reveals live text while off', async () => {
    const f = await fixture({ running: true });
    try {
      const event = (
        sequence: number,
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ): ChatFlowEventEnvelope => ({
        schemaVersion: 3,
        eventId: id(850 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 1,
        sequence,
        cursor: `${run}:${sequence}`,
        harness: 'dsh',
        occurredAt: now,
        sourceEvent: null,
        type,
        payload,
      });
      f.state.events = [
        event(1, 'assistant.text.delta', {
          replyId: 'first',
          text: '正在核对本次数据。',
        }),
        event(2, 'tool.started', {
          toolCallId: 'read',
          name: 'read',
          summary: '读取本次资料',
        }),
        event(3, 'assistant.text.delta', {
          replyId: 'final',
          text: '本次核对结果正确。',
        }),
      ];
      f.state.streamEvents = f.state.events;
      f.releaseStream();
      const process = f.page.getByRole('region', {
        name: '工作过程',
        exact: true,
      });
      await process.waitFor();
      expect(
        await f.page.getByText('正在核对本次数据。', { exact: true }).count(),
      ).toBe(0);
      expect(
        await f.page.getByText('本次核对结果正确。', { exact: true }).count(),
      ).toBe(0);
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      const openPreferences = async () => {
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        await settings
          .getByRole('button', { name: '个人偏好', exact: true })
          .click();
        await expect
          .poll(() =>
            settings.getByRole('switch', { name: '流式输出' }).isEnabled(),
          )
          .toBe(true);
      };
      await openPreferences();
      const toggle = settings.getByRole('switch', { name: '流式输出' });
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
      await f.page.screenshot({
        path: '.local/feedback/personal-preferences.png',
      });
      f.state.preferenceError = true;
      await toggle.click();
      await settings.getByRole('alert').waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
      f.state.preferenceError = false;
      await toggle.click();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
      await settings.getByRole('button', { name: '关闭设置' }).click();
      await process.getByText('正在核对本次数据。', { exact: true }).waitFor();
      await f.page.reload();
      await process.getByText('正在核对本次数据。', { exact: true }).waitFor();
      await openPreferences();
      expect(await toggle.getAttribute('aria-checked')).toBe('true');
      await toggle.click();
      await expect
        .poll(() => toggle.getAttribute('aria-checked'))
        .toBe('false');
      await settings.getByRole('button', { name: '关闭设置' }).click();
      expect(
        await f.page.getByText('正在核对本次数据。', { exact: true }).count(),
      ).toBe(0);
      f.state.events.push(
        event(4, 'assistant.text.completed', {
          replyId: 'final',
          text: '本次核对结果正确。',
        }),
      );
      f.state.messageStatus = 'completed';
      await f.page.reload();
      await f.page.getByText('本次核对结果正确。', { exact: true }).waitFor();
      await process.getByRole('button').click();
      expect(
        await f.page.getByText('正在核对本次数据。', { exact: true }).count(),
      ).toBe(0);
      await openPreferences();
      await toggle.click();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
      f.state.viewer = id(975);
      await f.page.reload();
      await openPreferences();
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
    } finally {
      await f.close();
    }
  });

  it('interleaves live public replies with tool steps and restores the same process after reload', async () => {
    const f = await fixture({ running: true, streamingOutput: true });
    try {
      const event = (
        sequence: number,
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ): ChatFlowEventEnvelope => ({
        schemaVersion: 3,
        eventId: id(700 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 1,
        sequence,
        cursor: `${run}:${sequence}`,
        harness: 'dsh',
        occurredAt: now,
        sourceEvent: null,
        type,
        payload,
      });
      f.state.events = [
        event(1, 'assistant.text.delta', {
          replyId: 'first',
          text: '我先检查项目目录。',
        }),
        event(2, 'assistant.text.delta', {
          replyId: 'first',
          text: '我先检查项目目录。',
          textMode: 'replace',
        }),
        event(3, 'tool.started', {
          toolCallId: 'read',
          name: 'read',
          summary: '读取入口文件',
        }),
        event(4, 'tool.completed', {
          toolCallId: 'read',
          name: 'read',
          summary: '已读取入口文件',
        }),
        event(5, 'assistant.text.delta', {
          replyId: 'last',
          text: '入口文件已确认。',
        }),
      ];
      f.state.streamEvents = f.state.events;
      f.releaseStream();
      const process = f.page.getByRole('region', {
        name: '工作过程',
        exact: true,
      });
      await process.getByText('入口文件已确认。', { exact: true }).waitFor();
      expect(
        await f.page.getByText('我先检查项目目录。', { exact: true }).count(),
      ).toBe(1);
      const steps = process.getByRole('region', {
        name: '工作步骤',
        exact: true,
      });
      await steps.getByRole('button').click();
      const text = await process.innerText();
      expect(text.indexOf('我先检查项目目录。')).toBeLessThan(
        text.indexOf('已读取入口文件'),
      );
      expect(text.indexOf('已读取入口文件')).toBeLessThan(
        text.indexOf('入口文件已确认。'),
      );
      expect(await steps.getByRole('button').count()).toBe(1);
      await f.page.screenshot({ path: '.local/feedback/interleaved-live.png' });
      f.state.events.push(
        event(6, 'assistant.text.completed', {
          replyId: 'last',
          text: '入口文件已确认。',
        }),
      );
      f.state.messageStatus = 'completed';
      await f.page.reload();
      const toggle = steps.getByRole('button');
      await toggle.waitFor();
      await f.page.getByText('入口文件已确认。', { exact: true }).waitFor();
      await process.getByText('我先检查项目目录。', { exact: true }).waitFor();
      await toggle.click();
      expect(
        await process
          .getByText('我先检查项目目录。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await process
          .getByText('入口文件已确认。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await f.page.getByText('入口文件已确认。', { exact: true }).count(),
      ).toBe(1);
      expect(
        await process.getByRole('list', { name: '工作步骤' }).count(),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('native streaming preserves settled paragraphs and reading position across deltas and completion', async () => {
    const f = await fixture({
      running: true,
      streamingOutput: true,
      controlledStream: true,
    });
    try {
      await f.page.waitForFunction(
        () => document.documentElement.dataset.streamReady === 'true',
      );
      const push = async (
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ) => {
        const sequence = f.state.events.length + 1;
        const event: ChatFlowEventEnvelope = {
          schemaVersion: 3,
          eventId: id(800 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence,
          cursor: `${run}:${sequence}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type,
          payload,
        };
        f.state.events.push(event);
        await f.page.evaluate(
          (body) =>
            window.dispatchEvent(
              new CustomEvent('allrice-test-stream', { detail: body }),
            ),
          `data: ${JSON.stringify(event)}\n\n`,
        );
      };
      await push('assistant.text.delta', {
        replyId: 'first',
        text: '我先读取资料。',
      });
      await push('tool.completed', {
        toolCallId: 'read',
        name: 'read',
        summary: '已读取报告',
      });
      let text =
        '固定首段。\n\n' +
        Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段分析。`).join(
          '\n\n',
        ) +
        '\n\n正在汇总';
      await push('assistant.text.delta', { replyId: 'last', text });
      const reply = f.page.locator('[data-work-reply="reply:last"]');
      await reply.getByText('固定首段。', { exact: true }).waitFor();
      const firstParagraph = await reply
        .getByText('固定首段。', { exact: true })
        .elementHandle();
      const scroll = f.page.locator('[data-conversation-scroll]');
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      for (let i = 1; i <= 3; i++) {
        const delta = `，追加结果 ${i}`;
        text += delta;
        await push('assistant.text.delta', { replyId: 'last', text: delta });
        await expect.poll(() => reply.innerText()).toContain(delta);
        expect(
          await firstParagraph!.evaluate((element) => element.isConnected),
        ).toBe(true);
        expect(
          await scroll.evaluate((element) => element.scrollTop),
        ).toBeLessThan(20);
      }
      f.state.messageStatus = 'completed';
      f.state.reply = text;
      await push('assistant.text.completed', { replyId: 'last', text });
      await push('run.succeeded', {});
      await expect
        .poll(() =>
          f.page.getByRole('button', { name: '复制', exact: true }).count(),
        )
        .toBe(1);
      expect(
        await firstParagraph!.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(
        await f.page.getByText('固定首段。', { exact: true }).count(),
      ).toBe(1);
      expect(
        await f.page.getByText('我先读取资料。', { exact: true }).isVisible(),
      ).toBe(true);
      expect(
        await scroll.evaluate((element) => element.scrollTop),
      ).toBeLessThan(20);
    } finally {
      await f.close();
    }
  });

  it('ticks elapsed time every second between server samples, including waits, and settles to the final receipt', async () => {
    const f = await fixture({ running: true });
    try {
      f.state.runTimings = [
        {
          runId: run,
          timing: {
            activeMs: 17000,
            waitingMs: 0,
            wallMs: 17000,
            timeoutMs: 3600000,
            remainingMs: 3583000,
            phase: 'active',
            sources: [],
            calls: null,
          },
        },
      ];
      await f.page.clock.install();
      await f.page.reload();
      const timing = f.page.getByLabel('本轮运行时间', { exact: true });
      await timing.waitFor();
      expect(await timing.innerText()).toBe('总耗时 17 秒');
      for (const seconds of [18, 19, 20]) {
        await f.page.clock.runFor(1000);
        await expect
          .poll(() => timing.innerText())
          .toBe(`总耗时 ${seconds} 秒`);
      }
      // Server updates do not reset the display interval or make it run backwards.
      f.state.runTimings[0]!.timing.phase = 'waiting';
      f.state.runTimings[0]!.timing.wallMs = 19000;
      await f.page.clock.runFor(2000);
      await expect.poll(() => timing.innerText()).toBe('总耗时 22 秒');
      expect(f.state.runTimings[0]!.timing.activeMs).toBe(17000);
      f.state.runTimings[0]!.timing.phase = 'terminal';
      f.state.runTimings[0]!.timing.wallMs = 22500;
      await f.page.clock.runFor(2000);
      await expect.poll(() => timing.innerText()).toBe('总耗时 22 秒');
      await f.page.clock.runFor(5000);
      expect(await timing.innerText()).toBe('总耗时 22 秒');
      f.state.runTimings[0]!.timing.phase = 'queued';
      f.state.runTimings[0]!.timing.wallMs = 0;
      await f.page.reload();
      await timing.waitFor();
      await f.page.clock.runFor(3000);
      expect(await timing.innerText()).toBe('总耗时 0 秒');
    } finally {
      await f.close();
    }
  }, 30000);

  it.each([false, true])(
    'shows ordinary task timing on mobile with workbench disabled=%s, refreshes server waits and recovers from a failed read',
    async (disabled) => {
      const f = await fixture({ width: 390, disabled });
      try {
        f.state.runTimings = [
          {
            runId: run,
            timing: {
              activeMs: 12460,
              waitingMs: 10532,
              wallMs: 22992,
              timeoutMs: 3600000,
              remainingMs: 3587540,
              phase: 'waiting',
              sources: [{ scope: 'user', timeoutMs: 3600000 }],
              calls: { modelRequests: 2, toolCalls: 1, pending: 1 },
            },
          },
        ];
        await f.page.reload();
        const timing = f.page.getByLabel('本轮运行时间', { exact: true });
        const process = f.page.getByRole('region', {
          name: '工作过程',
          exact: true,
        });
        await process.getByRole('button').click();
        await timing.waitFor();
        expect(await timing.innerText()).toContain('总耗时 22 秒');
        expect(await process.innerText()).not.toContain('累计等待');
        expect(await timing.count()).toBe(1);
        expect(await process.innerText()).not.toContain('模型请求');
        f.state.runTimings[0]!.timing.waitingMs = 2400000;
        f.state.runTimings[0]!.timing.wallMs = 2412460;
        await expect
          .poll(() => timing.innerText(), { timeout: 5000 })
          .toContain('总耗时 40 分 12 秒');
        expect(await timing.innerText()).toContain('总耗时 40 分 12 秒');
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        f.state.timingError = true;
        await expect.poll(() => timing.count(), { timeout: 5000 }).toBe(0);
        await f.page
          .getByText(disabled ? '运行时间暂不可用' : '交互状态暂不可用', {
            exact: true,
          })
          .waitFor();
        f.state.timingError = false;
        await timing.waitFor();
        await f.page.reload();
        await timing.waitFor();
        expect(await timing.count()).toBe(1);
        await process.getByRole('button').click();
        await timing.waitFor();
        expect(await timing.innerText()).toContain('总耗时 40 分 12 秒');
        f.state.runTimings = [];
        await expect.poll(() => timing.count(), { timeout: 5000 }).toBe(0);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it('MET160 official file tree lazily reads actual files, opens native tabs, refreshes and handles deletion', async () => {
    const f = await fixture();
    try {
      f.state.files = [
        {
          id: id(901),
          fileName: '上传的说明.md',
          mediaType: 'text/markdown',
          sizeBytes: 20,
          visibility: 'private',
          ownedByMe: true,
          category: 'uploads',
          deliverableVersion: null,
        },
      ];
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      const tree = f.panel.locator('[data-files-state="tree"]');
      await tree.waitFor();
      expect(f.state.fileReads).toBe(0);
      await tree.getByRole('button', { name: '上传文件', exact: true }).click();
      await tree
        .getByRole('button', { name: '上传的说明.md', exact: true })
        .click();
      await f.panel
        .getByRole('heading', { name: '上传的文件', exact: true })
        .waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('href'),
      ).toContain(id(901));
      f.state.filePreview = {
        kind: 'text',
        mediaType: 'application/json',
        text: '{"native":true}',
      };
      await f.fileAction('刷新文件');
      await f.panel
        .getByRole('button', { name: '复制文本', exact: true })
        .waitFor();
      await expect
        .poll(() =>
          f.panel
            .getByRole('region', { name: '文件正文', exact: true })
            .innerText(),
        )
        .toContain('native');
      await f.panel.getByRole('tab', { name: /^工作区文件/ }).click();
      expect(
        await tree
          .getByRole('button', { name: '上传的说明.md', exact: true })
          .count(),
      ).toBe(1);
      f.state.files = [];
      await tree.getByRole('button', { name: '重新读取', exact: true }).click();
      await expect
        .poll(() =>
          tree
            .getByRole('button', { name: '上传的说明.md', exact: true })
            .count(),
        )
        .toBe(0);
      await tree.getByRole('button', { name: '交付文件', exact: true }).click();
      await expect
        .poll(() => tree.getByText('空目录', { exact: true }).count())
        .toBe(2);
      await f.panel.getByRole('tab', { name: /^上传的说明/ }).click();
      await f.fileAction('刷新文件');
      await f.panel.getByRole('alert').waitFor();
      await f.page.getByRole('treeitem', { name: /研究任务 B/ }).click();
      expect(await f.panel.count()).toBe(0);
    } finally {
      await f.close();
    }
  }, 20_000);

  it('MET160 keeps the chosen files tab when an artifact list arrives late, and honors explicit reopening', async () => {
    const f = await fixture();
    let release!: () => void;
    f.state.delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.items = [artifact(10)];
    try {
      await f.page.reload();
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      const tree = f.panel.locator('[data-files-state="tree"]');
      await tree.waitFor();
      release();
      await expect.poll(() => f.entry.innerText()).toContain('1');
      expect(await tree.isVisible()).toBe(true);
      await f.entry.click();
      await f.panel.getByRole('tab', { name: /^report-10.md/ }).waitFor();
      expect(await tree.isVisible()).toBe(false);
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      await tree.waitFor();
      await f.entry.click();
      expect(await tree.isVisible()).toBe(false);
    } finally {
      release();
      await f.close();
    }
  });

  it('switches native dock tabs in place without replaying the panel entrance', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      await f.panel.locator('[data-files-state="tree"]').waitFor();
      // The initial panel entrance may finish; tab changes below must not animate.
      await f.page.waitForTimeout(400);
      const offsets = await f.panel.evaluate(async (panel) => {
        const samples: number[] = [];
        for (let i = 0; i < 8; i++) {
          const host = panel.querySelector<HTMLElement>(
            '[data-dockkit-host="dock"]:not([hidden])',
          )!;
          const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
          const target = tabs.find((t) =>
            i % 2 === 0
              ? t.textContent?.includes('report-10')
              : t.textContent?.includes('工作区文件'),
          )!;
          target.click();
          for (let frame = 0; frame < 3; frame++) {
            await new Promise(requestAnimationFrame);
            const active = panel.querySelector<HTMLElement>(
              '[data-dockkit-host="dock"]:not([hidden])',
            )!;
            samples.push(
              active.getBoundingClientRect().left -
                panel.getBoundingClientRect().left,
            );
          }
        }
        return samples;
      });
      expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(1);
      expect(
        await f.panel.locator('[data-files-state="tree"]').isVisible(),
      ).toBe(true);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('honors repeated empty-catalog header switches immediately, including behind a modal and a delayed refresh', async () => {
    const f = await fixture();
    let release = () => {};
    try {
      const files = f.page
        .locator('header')
        .getByRole('button', { name: '工作区文件', exact: true });
      await files.click();
      await f.panel.locator('[data-files-state="tree"]').waitFor();
      await f.page.waitForTimeout(400);
      f.state.delay = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (let i = 0; i < 6; i++) {
        await f.entry.evaluate((button: HTMLButtonElement) => button.click());
        await expect
          .poll(() =>
            f.panel
              .getByRole('tab', { name: /^交付成果/ })
              .getAttribute('aria-selected'),
          )
          .toBe('true');
        expect(
          await f.panel.locator('[data-files-state="tree"]').isVisible(),
        ).toBe(false);
        await files.evaluate((button: HTMLButtonElement) => button.click());
        await expect
          .poll(() =>
            f.panel
              .getByRole('tab', { name: /^工作区文件/ })
              .getAttribute('aria-selected'),
          )
          .toBe('true');
      }
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '能力与环境' }).waitFor();
      release();
      f.state.delay = null;
      expect(await f.page.locator('#artifact-workbench').count()).toBe(1);
      const offsets = await f.panel.evaluate(async (panel) => {
        const samples: number[] = [];
        const end = performance.now() + 450;
        do {
          await new Promise(requestAnimationFrame);
          const hosts = panel.querySelectorAll<HTMLElement>(
            '[data-dockkit-host="dock"]:not([hidden])',
          );
          if (hosts.length !== 1) throw Error('Unexpected duplicate dock');
          samples.push(
            hosts[0]!.getBoundingClientRect().left -
              panel.getBoundingClientRect().left,
          );
        } while (performance.now() < end);
        return samples;
      });
      expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(1);
      expect(
        await f.panel.locator('[data-files-state="tree"]').isVisible(),
      ).toBe(true);
      await f.page
        .getByRole('dialog', { name: '能力与环境' })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await f.entry.click();
      expect(
        await f.panel
          .getByRole('tab', { name: /^交付成果/ })
          .getAttribute('aria-selected'),
      ).toBe('true');
      await files.click();
      expect(await f.page.locator('#artifact-workbench').count()).toBe(1);
      expect(f.errors).toEqual([]);
      expect(f.writes).toEqual([]);
    } finally {
      release();
      await f.close();
    }
  });

  it('MET160 published official PDF chunk renders actual PDF bytes with its bundled worker', async () => {
    const f = await fixture({ artifacts: true });
    try {
      // A real one-page PDF, with offsets computed from its actual object bytes.
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      const content =
        'BT /F1 16 Tf 30 350 Td (Allrice native PDF preview) Tj ET';
      objects.push(
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      );
      let pdf = '%PDF-1.4\n';
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
        .join(
          '\n',
        )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      f.state.officePreview = {
        kind: 'pdf',
        base64: Buffer.from(pdf).toString('base64'),
      };
      await f.page.reload();
      const canvas = f.panel.getByRole('img', {
        name: 'PDF 第 1 页',
        exact: true,
      });
      await canvas.waitFor({ timeout: 15000 });
      await expect
        .poll(() =>
          canvas.evaluate((element) => (element as HTMLCanvasElement).width),
        )
        .toBeGreaterThan(300);
      await f.panel
        .getByText('Allrice native PDF preview', { exact: true })
        .waitFor();
      expect(
        await f.page.evaluate(() => Object.hasOwn(window, '__ModuleLoader__')),
      ).toBe(false);
      await f.page.screenshot({ path: '/tmp/allrice-met160-native-pdf.png' });
    } finally {
      await f.close();
    }
  }, 25_000);

  it
    .skipIf(!process.env.ALLRICE_OFFICE_PREVIEW_DIR)
    .each(['docx', 'xlsx', 'pptx'])(
    'MET160 real %s renderer output opens in native zoom viewport',
    async (format) => {
      const rendered = OfficeRenderResponseSchema.parse(
        JSON.parse(
          await readFile(
            join(process.env.ALLRICE_OFFICE_PREVIEW_DIR!, `${format}.json`),
            'utf8',
          ),
        ),
      );
      const f = await fixture({ artifacts: true });
      try {
        f.state.officePreview = officePreview(rendered);
        await f.page.reload();
        await f.entry.click();
        const preview = f.panel.getByRole('region', {
          name: 'Office 文档预览',
        });
        const page = preview.getByRole('img', { name: 'Office 文档第 1 页' });
        await page.waitFor();
        await expect
          .poll(() =>
            page.evaluate((element: HTMLImageElement) => element.naturalWidth),
          )
          .toBeGreaterThan(500);
        await preview
          .locator('[data-document-zoom-frame]')
          .scrollIntoViewIfNeeded();
        const frame = await preview
          .locator('[data-document-zoom-mode]')
          .boundingBox();
        expect(frame).not.toBeNull();
        await f.page.mouse.move(
          frame!.x + frame!.width / 2,
          frame!.y + frame!.height - 20,
        );
        await preview.getByRole('button', { name: '选择缩放比例' }).click();
        await f.page
          .getByRole('menuitem', { name: '150%', exact: true })
          .click();
        await expect
          .poll(() =>
            preview.getByRole('button', { name: '选择缩放比例' }).innerText(),
          )
          .toContain('150%');
        await preview.getByRole('button', { name: '选择缩放比例' }).click();
        await f.page
          .getByRole('menuitem', { name: '适应宽度', exact: true })
          .click();
        await preview
          .locator('[data-document-zoom-scrollport]')
          .evaluate((element) => {
            element.scrollTop = 0;
            element.scrollLeft = 0;
          });
        await preview.evaluate((element) =>
          element.scrollIntoView({ block: 'start' }),
        );
        await f.page.screenshot({
          path: `/tmp/allrice-met160-native-${format}.png`,
        });
        if (rendered.pages.length > 1) {
          await preview.getByRole('button', { name: '下一页' }).click();
          await preview
            .getByRole('img', { name: 'Office 文档第 2 页' })
            .waitFor();
        }
      } finally {
        await f.close();
      }
    },
    25_000,
  );

  it('shows Office pages and actual formula errors without confusing rendering with layout approval', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
      f.state.officePreview = {
        kind: 'office',
        checksum: `sha256:${'a'.repeat(64)}`,
        format: 'xlsx',
        pageCount: 3,
        pages: [
          { number: 1, base64: png },
          { number: 2, base64: png },
        ],
        formulaCount: 2,
        formulaErrorCount: 1,
        formulas: [
          { sheet: '明细', cell: 'C2', formula: 'B2*2', type: 'n', value: 60 },
          {
            sheet: '明细',
            cell: 'D2',
            formula: '1/0',
            type: 'e',
            value: '#DIV/0!',
          },
        ],
      };
      await f.page.reload();
      await f.entry.click();
      const preview = f.panel.getByRole('region', { name: 'Office 文档预览' });
      await preview.waitFor();
      expect(await preview.innerText()).toContain('发现 1 个错误');
      expect(await preview.innerText()).toContain('展示前 2 页');
      await preview.getByText('查看计算结果', { exact: true }).click();
      expect(await preview.innerText()).toContain('#DIV/0!');
      expect(await preview.innerText()).toContain('60');
      await preview.getByRole('button', { name: '下一页' }).click();
      await preview.getByRole('img', { name: 'Office 文档第 2 页' }).waitFor();
      expect(
        await preview.getByRole('button', { name: '下一页' }).isDisabled(),
      ).toBe(true);
      expect(await preview.innerText()).toContain('请检查分页');
    } finally {
      await f.close();
    }
  });

  it('resolves chat downloads only for this Run’s authenticated artifacts', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const path = `/api/v1/files/${artifact(10).object.id}/download`;
      f.state.reply = `[下载报告](https://allrice.example${path}?name=wrong)\n\n[原始来源](https://example.org/source)`;
      await f.page.reload();
      const link = f.page.getByRole('link', { name: '下载报告', exact: true });
      await expect
        .poll(() => link.getAttribute('href'))
        .toBe(`${origin}${path}?name=report-10.md`);
      // Native Markdown opens HTTP links without navigating away from the chat.
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(
        await f.page
          .getByRole('link', { name: '原始来源', exact: true })
          .getAttribute('href'),
      ).toBe('https://example.org/source');
      // Even a known file in the Session cannot resolve another Run's link.
      f.state.items = [
        {
          ...artifact(10),
          provenance: { ...artifact(10).provenance, runId: id(90) },
        },
      ];
      await f.page.reload();
      await expect
        .poll(() => link.getAttribute('href'))
        .toBe(`https://allrice.example${path}?name=wrong`);
    } finally {
      await f.close();
    }
  });

  it(
    'UX01-B keeps all entries visible, distinguishes release-off and preserves drafts without execution',
    { timeout: 20_000 },
    async () => {
      const f = await fixture();
      try {
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
        });
        await composer.fill('保留我的原始问题');
        await f.page
          .getByRole('button', { name: '能力与环境', exact: true })
          .click();
        const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .waitFor();
        expect(
          await dialog
            .locator('[data-capability]')
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute('data-capability')),
            ),
        ).toEqual([...workspaceCapabilityIds]);
        expect(
          await dialog
            .locator('[data-capability="development"]')
            .getAttribute('data-state'),
        ).toBe('not_released');
        expect(
          await dialog
            .locator('[data-capability="assistants"]')
            .getAttribute('data-state'),
        ).toBe('not_released');
        expect(
          await dialog
            .locator('[data-capability="boost"]')
            .getByRole('button', { name: /准备/ })
            .count(),
        ).toBe(0);
        expect(await dialog.getByRole('link', { name: /配置/ }).count()).toBe(
          0,
        );
        await f.page.screenshot({
          path: '/tmp/met147-capabilities-desktop.png',
        });
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .click();
        expect(await composer.inputValue()).toContain('保留我的原始问题');
        expect(await composer.inputValue()).toContain(
          'workspace.export.create',
        );
        await expect
          .poll(() => composer.evaluate((e) => e === document.activeElement))
          .toBe(true);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('UX01-B bridges missing configuration to the real pairing dialog and refreshes on return', async () => {
    const f = await fixture({ width: 390 });
    try {
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      const card = dialog.locator('[data-capability="local_files"]');
      await card.getByRole('button', { name: '连接与管理电脑' }).click();
      const bridge = f.page.getByRole('dialog', { name: '本地工作区' });
      await bridge.waitFor();
      expect(
        await bridge.getByRole('link', { name: /下载 M 芯片版/ }).count(),
      ).toBe(1);
      const calls = f.state.readinessRequests;
      await f.page.keyboard.press('Escape');
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      await dialog.waitFor();
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await dialog.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      expect(
        await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      await f.page.screenshot({
        path: '/tmp/met147-capabilities-mobile.png',
      });
    } finally {
      await f.close();
    }
  });

  it('checks once on opening and preserves cards while manually refreshing, without polling or focus refresh', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.page.clock.install();
      const entry = f.page.getByRole('button', {
        name: '能力与环境',
        exact: true,
      });
      await entry.click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      const refresh = dialog.getByRole('button', { name: '刷新能力状态' });
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      const local = dialog.locator('[data-capability="local_files"]');
      await local.getByText('查看处理步骤', { exact: true }).click();
      const before = await dialog
        .locator('[data-capability]')
        .allTextContents();
      const calls = f.state.readinessRequests;
      await f.page.clock.runFor(31_000);
      await f.page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await f.page.waitForTimeout(50);
      expect(f.state.readinessRequests).toBe(calls);
      expect(
        await dialog.locator('[data-capability]').allTextContents(),
      ).toEqual(before);

      f.state.readinessDelay = new Promise<void>((done) => {
        release = done;
      });
      await refresh.click();
      await expect.poll(() => f.state.readinessRequests).toBe(calls + 1);
      expect(
        await dialog.locator('[data-capability]').allTextContents(),
      ).toEqual(before);
      expect(
        await local.locator('details').getAttribute('open'),
      ).not.toBeNull();
      expect(
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .isDisabled(),
      ).toBe(true);
      release();
      f.state.readinessDelay = null;
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(
        await local.locator('details').getAttribute('open'),
      ).not.toBeNull();
      await f.page.keyboard.press('Escape');
      await f.page.waitForTimeout(50);
      expect(f.state.readinessRequests).toBe(calls + 1);
      await entry.click();
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(f.state.readinessRequests).toBe(calls + 2);
      expect(f.writes).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it('UX01-B explicitly refreshes after settings, protects members, and never treats errors or wrong scope as ready', async () => {
    const f = await fixture();
    try {
      f.state.capabilities = f.state.capabilities.map((c) =>
        c.id === 'cloud_mcp'
          ? {
              ...c,
              state: 'ready',
              reason: 'connection_on_demand',
              action: 'compose',
              responsibleRole: 'user',
              releaseEnabled: true,
            }
          : c,
      );
      const entry = f.page.getByRole('button', {
        name: '能力与环境',
        exact: true,
      });
      await entry.click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      const mcp = dialog.locator('[data-capability="cloud_mcp"]');
      await mcp.getByRole('button', { name: '准备应用连接任务' }).waitFor();
      expect(await mcp.getByRole('link').count()).toBe(0);
      await mcp
        .getByRole('button', { name: '已连接应用', exact: true })
        .click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      await settings.getByText('还没有连接应用。', { exact: false }).waitFor();
      expect(await dialog.count()).toBe(0);
      await f.page.keyboard.press('Escape');
      await entry.click();
      await mcp.getByRole('button', { name: '准备应用连接任务' }).waitFor();
      f.state.readinessError = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
      f.state.readinessError = false;
      f.state.readinessWrongScope = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  });

  it('UX01-B ignores late readiness from a previous session and recovers after a failed check', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', { name: '能力与环境' });
      await dialog
        .getByRole('button', { name: '准备报告与文件交付任务' })
        .waitFor();
      f.state.readinessDelay = new Promise<void>((done) => {
        release = done;
      });
      const calls = f.state.readinessRequests;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await f.page.keyboard.press('Escape');
      f.state.capabilities = f.state.capabilities.map((c) => ({
        ...c,
        state: 'not_released',
        reason: 'release_disabled',
        action: 'guide',
        releaseEnabled: false,
      }));
      await f.page.getByRole('treeitem', { name: /研究任务 B/ }).click();
      await f.page
        .getByRole('button', { name: '能力与环境', exact: true })
        .click();
      await dialog.getByText(/核对时间/).waitFor();
      release();
      expect(
        await dialog
          .locator('[data-capability="report"]')
          .getAttribute('data-state'),
      ).toBe('not_released');
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
      f.state.readinessError = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      f.state.readinessError = false;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog.getByText(/核对时间/).waitFor();
      expect(
        await dialog
          .locator('[data-capability="report"]')
          .getAttribute('data-state'),
      ).toBe('not_released');
    } finally {
      release?.();
      await f.close();
    }
  });

  it(
    'restores the selected Session after reload and removes stale links for new work',
    { timeout: 20_000 },
    async () => {
      const f = await fixture({ artifacts: true });
      try {
        await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
        await expect
          .poll(() => new URL(f.page.url()).searchParams.get('session'))
          .toBe(B);
        await f.page.reload();
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
        await expect
          .poll(() => f.page.locator('h1').first().textContent())
          .toBe('研究任务 B');
        expect(
          await f.panel.getByRole('heading', { name: /COIN/ }).count(),
        ).toBe(0);
        await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
        await f.page.reload();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        expect(new URL(f.page.url()).searchParams.has('session')).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    'resolves a Session outside the sidebar page only through scoped history (denied=%s)',
    async (denied) => {
      const f = await fixture({ artifacts: true });
      try {
        f.state.omitSessionA = true;
        f.state.deepLinkDenied = denied;
        await f.page.reload();
        await expect
          .poll(() => f.page.locator('h1').first().textContent())
          .toBe(denied ? '研究任务 B' : '研究任务 A');
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(
          denied ? B : A,
        );
        if (denied)
          expect(
            await f.panel.getByRole('heading', { name: /COIN/ }).count(),
          ).toBe(0);
        else await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it(
    'automatically presents a newly completed SSE delivery, but never reopens a panel the user closed',
    { timeout: 20_000 },
    async () => {
      for (const closed of [false, true]) {
        const f = await fixture({ running: true, artifacts: closed });
        try {
          await expect.poll(() => f.state.streamRequests).toBeGreaterThan(0);
          if (closed) {
            await f.panel.waitFor();
            await f.page
              .getByRole('button', { name: '关闭工作台', exact: true })
              .click();
          } else {
            expect(await f.panel.count()).toBe(0);
            expect(await f.entry.count()).toBe(0);
          }
          const composer = f.page.getByRole('textbox', {
            name: '给 Rice 的消息',
          });
          await composer.fill('我的后续问题');
          f.finishRun();
          await f.page.getByText('展开完整回复', { exact: true }).waitFor();
          expect(
            await composer.evaluate((e) => e === document.activeElement),
          ).toBe(true);
          if (closed) {
            expect(await f.panel.count()).toBe(0);
            expect(await f.entry.textContent()).toContain('新成果');
            await f.entry.click();
          }
          await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        } finally {
          await f.close();
        }
      }
    },
  );

  it('slides the native dock with the conversation track, restores cached catalogs and respects reduced motion', async () => {
    const f = await fixture({ artifacts: true });
    let release = () => {};
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      const host = f.panel
        .locator('[data-dockkit-host="dock"]:not([hidden])')
        .first();
      await expect
        .poll(() => host.evaluate((e) => getComputedStyle(e).transform))
        .toBe('none');
      expect(f.state.artifactReads).toBe(1);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      expect(await f.panel.count()).toBe(0);
      await expect
        .poll(() =>
          f.page
            .locator(
              '#artifact-workbench [data-dockkit-host="dock"]:not([hidden])',
            )
            .first()
            .evaluate((e) => getComputedStyle(e).visibility),
        )
        .toBe('hidden');
      // Read every paint, not a screenshot taken after the motion has finished.
      const frames = await f.page.evaluate(async () => {
        const panel = document.querySelector('#artifact-workbench')!;
        const entry = Array.from(
          document.querySelectorAll<HTMLButtonElement>('button'),
        ).find((e) => e.textContent?.includes('▤ 交付成果'))!;
        const samples: Array<{ x: number; width: number; track: number }> = [];
        const start = performance.now();
        entry.click();
        await new Promise<void>((done) => {
          const tick = () => {
            const rect = panel
              .querySelector<HTMLElement>(
                '[data-dockkit-host="dock"]:not([hidden])',
              )!
              .getBoundingClientRect();
            const columns = getComputedStyle(
              document.querySelector('main')!,
            ).gridTemplateColumns.split(' ');
            samples.push({
              x: rect.x,
              width: rect.width,
              track: parseFloat(columns[2]!),
            });
            if (performance.now() - start > 450) done();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return samples;
      });
      const end = frames.at(-1)!;
      expect(frames.some((f) => f.x > end.x + 20 && f.x < 1440 - 20)).toBe(
        true,
      );
      expect(frames.some((f) => f.track > 20 && f.track < end.track - 20)).toBe(
        true,
      );
      expect(
        Math.max(...frames.map((f) => f.width)) -
          Math.min(...frames.map((f) => f.width)),
      ).toBeLessThan(2);
      f.state.delay = new Promise<void>((done) => {
        release = done;
      });
      const bCatalog = f.page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/api/v1/sessions/${B}/artifacts`,
      );
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      await (await bCatalog).finished();
      await expect.poll(() => f.panel.count()).toBe(0);
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      // A's refreshed catalog is blocked. The retained catalog still opens now.
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.count()).toBe(1);
      release();
      f.state.delay = null;
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      expect(
        await host.evaluate((e) => getComputedStyle(e).transitionDuration),
      ).toBe('0s');
    } finally {
      release();
      await f.close();
    }
  });

  it('shows a real report in a persistent third column, leaves composer focus alone and summarizes the center', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getByRole('table').count()).toBe(1);
      expect(
        await f.page.getByText('展开完整回复', { exact: true }).count(),
      ).toBe(1);
      expect(
        await f.page.evaluate(
          () =>
            getComputedStyle(
              document.querySelector('main')!,
            ).gridTemplateColumns.split(' ').length,
        ),
      ).toBe(3);
      const composer = f.page.getByRole('textbox', {
        name: '给 Rice 的消息',
      });
      await composer.fill('继续核对来源');
      await f.page.screenshot({ path: '/tmp/met147-desktop.png' });
      f.state.items.unshift(artifact(11));
      // Trigger the same existing read-only refresh used after a completed turn.
      await f.fileAction('刷新文件');
      await composer.focus();
      await expect
        .poll(() =>
          f.panel
            .locator('[data-document-id]:visible')
            .last()
            .getAttribute('data-document-id'),
        )
        .toBe(id(11));
      expect(await composer.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      expect(await composer.inputValue()).toBe('继续核对来源');
    } finally {
      await f.close();
    }
  });

  it(
    'remembers explicit closure and sidebar preferences per user/workspace, including blocked storage fallback',
    { timeout: 20_000 },
    async () => {
      const f = await fixture({ artifacts: true });
      try {
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.page
          .getByRole('button', { name: '收起侧边栏', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.reload();
        await f.entry.waitFor();
        expect(await f.panel.count()).toBe(0);
        expect(
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .count(),
        ).toBe(1);
        const value = await f.page.evaluate(
          (key) => localStorage.getItem(key),
          layoutPreferenceKey(user, org, workspace)!,
        );
        expect(JSON.parse(value!)).toEqual({
          sidebarCollapsed: true,
          panelOpen: false,
          panelWidth: null,
          sidebarWidth: null,
        });
        f.state.viewer = id(50);
        await f.page.reload();
        await f.panel.waitFor();
        expect(
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .count(),
        ).toBe(1);
        await f.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        f.state.workspace = id(51);
        f.state.items = [];
        await f.page.reload();
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
        expect(await f.panel.count()).toBe(0);
      } finally {
        await f.close();
      }
      const fallback = await fixture({ noStorage: true, artifacts: true });
      try {
        await fallback.panel.waitFor();
        await fallback.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        expect(await fallback.panel.count()).toBe(0);
      } finally {
        await fallback.close();
      }
    },
  );

  it('resizes the employee sidebar with native capture, preserves scoped width and leaves usable conversation space', async () => {
    const f = await fixture({
      artifacts: true,
      employeeCount: 2,
      employeeHistory: true,
    });
    try {
      const sidebar = f.page.locator('#chat-sidebar');
      const splitter = f.page.getByRole('separator', {
        name: '调整员工侧栏宽度',
      });
      const width = async () =>
        Math.round((await sidebar.boundingBox())!.width);
      await splitter.waitFor();
      const composer = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await composer.fill('侧栏拖动不丢草稿');
      async function dragTo(x: number) {
        const box = (await splitter.boundingBox())!;
        await f.page.mouse.move(box.x + box.width / 2, box.y + 150);
        await f.page.mouse.down();
        await f.page.mouse.move(x, box.y + 150, { steps: 8 });
        expect(await f.page.locator('main').getAttribute('data-dragging')).toBe(
          'true',
        );
        await f.page.mouse.up();
      }
      await dragTo(360);
      await expect.poll(width).toBe(360);
      await f.page
        .getByRole('button', { name: '收起侧边栏', exact: true })
        .click();
      await expect.poll(() => splitter.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await expect.poll(width).toBe(360);
      expect(await composer.inputValue()).toBe('侧栏拖动不丢草稿');
      await f.page.reload();
      await splitter.waitFor();
      await expect.poll(width).toBe(360);
      await dragTo(900);
      await expect.poll(width).toBe(420);
      const right = f.page.getByRole('separator', { name: '调整交付成果宽度' });
      await right.focus();
      await f.page.keyboard.press('Shift+ArrowLeft');
      // Reproduce classic Linux scrollbar/embedded-frame space on every host.
      await f.page.addStyleTag({
        content: 'main { width: calc(100% - 8px) !important; }',
      });
      await f.page.setViewportSize({ width: 1101, height: 950 });
      await expect
        .poll(async () =>
          Math.round(
            (await f.page.locator('main > section').boundingBox())!.width,
          ),
        )
        .toBeGreaterThanOrEqual(340);
      await expect.poll(width).toBeLessThan(420);
      const clampedSidebar = await width();
      await splitter.focus();
      await f.page.keyboard.press('ArrowLeft');
      await expect.poll(width).toBe(clampedSidebar - 20);
      await dragTo(100);
      await expect.poll(width).toBe(240);
      await splitter.focus();
      await f.page.keyboard.press('Shift+ArrowRight');
      await expect.poll(width).toBe(340);
      await splitter.dblclick({ position: { x: 4, y: 150 } });
      await expect.poll(width).toBe(240);
      await splitter.focus();
      await f.page.keyboard.press('Shift+ArrowRight');
      await f.page.setViewportSize({ width: 390, height: 844 });
      // matchMedia delivers its change after the viewport command resolves.
      await expect.poll(() => splitter.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '任务与历史' }).waitFor();
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.screenshot({ path: '/tmp/met160-employee-blue-mobile.png' });
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await expect.poll(width).toBe(340);
      await f.page.screenshot({
        path: '/tmp/met160-employee-blue-desktop.png',
      });
      f.state.viewer = id(50);
      await f.page.reload();
      await splitter.waitFor();
      await expect.poll(width).toBe(240);
    } finally {
      await f.close();
    }
  });

  it('aligns 56px headers and resizes deliverables with native capture, limits, reset and preserved drafts', async () => {
    const f = await fixture({ artifacts: true });
    try {
      // Classic scrollbars / embedded frames can make the frame narrower than
      // the viewport. Reset uses 38% of that frame; cap leaves usable chat width.
      await f.page.addStyleTag({
        content: 'main { width: calc(100% - 8px) !important; }',
      });
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      const defaultWidth = Math.round(
        (await f.page.locator('main').boundingBox())!.width * 0.38,
      );
      const splitter = f.page.getByRole('separator', {
        name: '调整交付成果宽度',
      });
      const composer = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await composer.fill('保留我的聊天草稿');
      const headerGeometry = () =>
        f.page.evaluate(() => {
          const left = document
            .querySelector('main > section header')!
            .getBoundingClientRect();
          const right = document
            .querySelector('#artifact-workbench [data-dockkit-strip]')!
            .getBoundingClientRect();
          return {
            left: left.height,
            right: right.height,
            delta: left.bottom - right.bottom,
          };
        });
      expect(await headerGeometry()).toEqual({ left: 56, right: 56, delta: 0 });
      expect(
        await f.panel.getByRole('tab', { name: /^交付成果/ }).count(),
      ).toBe(1);
      expect(await f.entry.textContent()).toMatch(/交付成果.*1/);
      const panelWidth = async () =>
        Math.round((await f.panel.boundingBox())!.width);
      await expect.poll(panelWidth).toBe(defaultWidth);
      async function dragTo(x: number) {
        const box = (await splitter.boundingBox())!;
        await f.page.mouse.move(box.x + box.width / 2, box.y + 100);
        await f.page.mouse.down();
        await f.page.mouse.move(x, box.y + 100, { steps: 8 });
        expect(await f.page.locator('main').getAttribute('data-dragging')).toBe(
          'true',
        );
        await f.page.mouse.up();
        expect(
          await f.page.locator('main').getAttribute('data-dragging'),
        ).toBeNull();
      }
      await dragTo(1400);
      await expect.poll(panelWidth).toBe(340);
      await dragTo(30);
      await expect
        .poll(panelWidth)
        .toBe(
          Math.round((await f.page.locator('main').boundingBox())!.width) -
            240 -
            340,
        );
      expect(await splitter.getAttribute('aria-valuenow')).toBe(
        String(
          Math.round((await f.page.locator('main').boundingBox())!.width) -
            240 -
            340,
        ),
      );
      const center = (await f.page.locator('main > section').boundingBox())!;
      for (const control of [
        f.page.getByRole('button', { name: '添加文件', exact: true }),
        f.page.getByRole('combobox', { name: '工作模式', exact: true }),
        f.page.getByRole('combobox', { name: '上传文件可见范围' }),
        f.page.getByRole('button', { name: '发送', exact: true }),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(center.x);
        expect(box.x + box.width).toBeLessThanOrEqual(center.x + center.width);
      }
      expect(await headerGeometry()).toEqual({ left: 56, right: 56, delta: 0 });
      await splitter.dblclick({ position: { x: 4, y: 100 } });
      await expect.poll(panelWidth).toBe(defaultWidth);
      await splitter.focus();
      await f.page.keyboard.press('ArrowLeft');
      await expect.poll(panelWidth).toBe(defaultWidth + 20);
      await f.page.keyboard.press('Home');
      await expect.poll(panelWidth).toBe(defaultWidth);
      // A canceled gesture must release capture and restore grid transitions.
      const box = (await splitter.boundingBox())!;
      await f.page.mouse.move(box.x + 4, box.y + 100);
      await f.page.mouse.down();
      await f.page.mouse.move(box.x - 50, box.y + 100);
      await splitter.dispatchEvent('pointercancel');
      await f.page.mouse.up();
      expect(
        await f.page.locator('main').getAttribute('data-dragging'),
      ).toBeNull();
      expect(await composer.inputValue()).toBe('保留我的聊天草稿');
      await f.page.screenshot({
        path: '/tmp/allrice-deliverables-desktop.png',
      });
    } finally {
      await f.close();
    }
  });

  it('remembers resized width per viewer, clamps on viewport resize and retains the narrow drawer', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const splitter = f.page.getByRole('separator', {
        name: '调整交付成果宽度',
      });
      await splitter.waitFor();
      const defaultWidth = Math.round(
        (await f.page.locator('main').boundingBox())!.width * 0.38,
      );
      const resizedWidth = String(defaultWidth + 100);
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(String(defaultWidth));
      await splitter.focus();
      await f.page.keyboard.press('Shift+ArrowLeft');
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(resizedWidth);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.entry.click();
      expect(await splitter.getAttribute('aria-valuenow')).toBe(resizedWidth);
      await f.page.reload();
      await splitter.waitFor();
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(resizedWidth);
      const box = (await splitter.boundingBox())!;
      await f.page.mouse.move(box.x + 4, box.y + 100);
      await f.page.mouse.down();
      await f.page.mouse.move(10, box.y + 100, { steps: 6 });
      await f.page.mouse.up();
      await f.page.setViewportSize({ width: 1200, height: 950 });
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(
          String(
            Math.round((await f.page.locator('main').boundingBox())!.width) -
              240 -
              340,
          ),
        );
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(
          String(
            Math.round((await f.page.locator('main').boundingBox())!.width) -
              240 -
              340,
          ),
        );
      await f.page.setViewportSize({ width: 390, height: 950 });
      await expect.poll(() => splitter.count()).toBe(0);
      expect(await f.panel.getAttribute('role')).toBe('dialog');
      await f.page.screenshot({ path: '/tmp/allrice-deliverables-mobile.png' });
      f.state.viewer = id(50);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.page.reload();
      await splitter.waitFor();
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(String(defaultWidth));
    } finally {
      await f.close();
    }
  });

  it('uses a narrow drawer, traps/restores focus, preserves preview state across resize, and has no horizontal overflow', async () => {
    const f = await fixture({ width: 390, artifacts: true });
    try {
      expect(await f.panel.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '任务与历史' }).waitFor();
      const quota = f.page.getByRole('button', { name: '设置', exact: true });
      await quota.focus();
      await f.page.keyboard.press('Tab');
      expect(
        await f.page
          .getByRole('dialog', { name: '任务与历史' })
          .evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      await f.page.keyboard.press('Shift+Tab');
      expect(await quota.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      await f.page.keyboard.press('Escape');
      expect(
        await f.page.getByRole('dialog', { name: '任务与历史' }).count(),
      ).toBe(0);
      await f.entry.click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getAttribute('role')).toBe('dialog');
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await f.panel.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await f.entry.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      expect(await f.panel.count()).toBe(0);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.panel.waitFor();
      await expect
        .poll(() => f.panel.getAttribute('role'))
        .toBe('complementary');
      await f.fileAction('查看源文本');
      const metadata = f.panel.getByRole('region', {
        name: '源文本',
        exact: true,
      });
      await f.page.setViewportSize({ width: 390, height: 844 });
      // Viewport acknowledgement precedes the matchMedia event/React commit.
      // Await the rendered drawer, rather than racing its previous wide role.
      await expect.poll(() => f.panel.getAttribute('role')).toBe('dialog');
      expect(await metadata.isVisible()).toBe(true);
      await f.page.screenshot({ path: '/tmp/met147-mobile.png' });
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await f.panel.count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('MET160 native Dock preserves previews across tabs, split, fullscreen, close and restored layout', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      // Selecting a version pins it while newer artifacts arrive.
      await f.selectArtifact(10);
      await f.fileAction('查看源文本');
      const metadata = f.panel.getByRole('region', {
        name: '源文本',
        exact: true,
      });
      f.state.items.push(artifact(11));
      await f.reloadList();
      await f.panel
        .getByRole('button', { name: '全屏查看', exact: true })
        .click();
      await f.panel
        .getByRole('button', { name: '并排查看', exact: true })
        .click();
      await expect
        .poll(() => f.panel.locator('[data-dockkit-pane]').count())
        .toBe(2);
      await f.panel.getByRole('button', { name: /report-11\.md.*v1/ }).click();
      await expect
        .poll(() => f.panel.locator('[data-document-id]:visible').count())
        .toBe(2);
      // The pane shell mounts before its authenticated preview has returned.
      await f.panel
        .getByRole('region', { name: '文件正文', exact: true })
        .waitFor();
      expect(await metadata.count()).toBe(1);
      expect(
        await f.panel
          .getByRole('region', { name: '文件正文', exact: true })
          .count(),
      ).toBe(1);
      const divider = f.panel.locator('[data-dockkit-divider]');
      const box = (await divider.boundingBox())!;
      await f.page.mouse.move(box.x, box.y + 120);
      await f.page.mouse.down();
      await f.page.mouse.move(box.x + 100, box.y + 120, { steps: 6 });
      await f.page.mouse.up();
      const panes = await f.panel.locator('[data-dockkit-pane]').all();
      expect((await panes[0]!.boundingBox())!.width).toBeGreaterThan(
        (await panes[1]!.boundingBox())!.width,
      );
      await f.panel
        .getByRole('button', { name: '退出全屏', exact: true })
        .click();
      expect(await metadata.count()).toBe(1);
      expect(
        await f.panel
          .getByRole('region', { name: '文件正文', exact: true })
          .count(),
      ).toBe(1);
      await f.panel
        .getByRole('button', { name: '全屏查看', exact: true })
        .click();
      await f.page.screenshot({ path: '/tmp/allrice-met160-dock-split.png' });
      await f.page.reload();
      await expect
        .poll(() => f.panel.locator('[data-dockkit-pane]').count())
        .toBe(2);
      expect(await f.panel.getAttribute('data-fullscreen')).toBe('true');
      await expect
        .poll(() => f.panel.getByRole('heading', { name: /COIN/ }).count())
        .toBe(2);
      await f.panel
        .getByRole('tab', { name: /^report-11.md/ })
        .getByRole('button', { name: '关闭标签', exact: true })
        .click();
      expect(
        await f.panel.getByRole('tab', { name: /^report-11.md/ }).count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('protects explicit version selection on new artifacts, including list failure/retry', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      await f.selectArtifact(10);
      f.state.items.unshift(artifact(11));
      await f.reloadList();
      expect(
        await f.panel
          .locator('[data-document-id]:visible')
          .last()
          .getAttribute('data-document-id'),
      ).toBe(id(10));
      await f.panel.getByRole('button', { name: '查看新成果' }).waitFor();
      expect(
        await f.panel.getByRole('heading', { name: /COIN/ }).isVisible(),
      ).toBe(true);
      f.state.listError = true;
      await f.entry.click();
      await f.panel.getByRole('alert').waitFor();
      expect(
        await f.panel.getByRole('heading', { name: /COIN/ }).isVisible(),
      ).toBe(true);
      f.state.listError = false;
      await f.reloadList();
      await f.panel.getByRole('button', { name: '查看新成果' }).click();
      await expect
        .poll(() =>
          f.panel
            .locator('[data-document-id]:visible')
            .last()
            .getAttribute('data-document-id'),
        )
        .toBe(id(11));
      f.state.items.unshift(artifact(12));
      await f.reloadList();
      expect(
        await f.panel
          .locator('[data-document-id]:visible')
          .last()
          .getAttribute('data-document-id'),
      ).toBe(id(11));
      await f.panel.getByRole('button', { name: '查看新成果' }).waitFor();
    } finally {
      await f.close();
    }
  });

  it('keeps long replies entirely in the transcript and hides the workbench for conversations without artifacts', async () => {
    const f = await fixture();
    try {
      await f.page.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.page.getByRole('table').count()).toBe(1);
      expect(
        await f.page
          .getByText('多步研究结果与引用说明。'.repeat(100), { exact: true })
          .count(),
      ).toBe(1);
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
      expect(await f.panel.count()).toBe(0);
      expect(await f.entry.count()).toBe(0);
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      expect(await f.panel.count()).toBe(0);
      expect(await f.entry.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      expect(await f.panel.count()).toBe(0);
      expect(await f.entry.count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('rejects late cross-session responses and renders content failure/retry without executing HTML or external images', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      let release!: () => void;
      f.state.delay = new Promise<void>((done) => {
        release = done;
      });
      await f.entry.click();
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      await expect.poll(() => f.panel.count()).toBe(0);
      release();
      f.state.delay = null;
      expect(await f.panel.getByRole('heading', { name: /COIN/ }).count()).toBe(
        0,
      );
      f.state.contentError = true;
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .waitFor();
      f.state.contentError = false;
      f.state.text =
        '# Safe report\n<script>window.BAD = true</script>\n\n![tracking](https://example.com/tracker.png)\n\n[bad](javascript:alert(1))';
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .click();
      await f.panel.getByRole('heading', { name: 'Safe report' }).waitFor();
      expect(
        await f.panel
          .locator('img,iframe,script,a[href^="javascript:"]')
          .count(),
      ).toBe(0);
      f.state.text = '较长的安全原文\n'.repeat(4000);
      f.state.items.unshift(artifact(12));
      await f.reloadList();
      const body = f.panel.getByRole('region', {
        name: '文件正文',
        exact: true,
      });
      await body.waitFor();
      const firstLength = (await body.innerText()).length;
      expect(firstLength).toBeLessThan(f.state.text.length);
      await body.getByRole('button', { name: '加载更多内容' }).click();
      expect((await body.innerText()).length).toBeGreaterThan(firstLength);
    } finally {
      await f.close();
    }
  });

  it('keeps the existing feature gate and does not invent artifacts from streaming / failed messages', async () => {
    const off = await fixture({ disabled: true });
    try {
      expect(await off.panel.count()).toBe(0);
      expect(await off.entry.count()).toBe(0);
    } finally {
      await off.close();
    }
    const f = await fixture();
    try {
      f.state.messageStatus = 'pending';
      await f.page.reload();
      await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
      expect(await f.entry.count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
      expect(
        await f.page.getByText('展开完整回复', { exact: true }).count(),
      ).toBe(0);
      f.state.messageStatus = 'failed';
      await f.page.reload();
      await f.page.getByText('这次没有完成。', { exact: true }).waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
});
