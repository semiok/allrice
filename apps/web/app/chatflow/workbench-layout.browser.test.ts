import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officePreview } from '@allrice/office-runtime';
import type { CloudOperationView } from '@allrice/database';
import type {
  Browser,
  Locator,
} from '../../../worker/node_modules/playwright-core/index.js';
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
  type EmployeeAccentColor,
} from '@allrice/contracts';
import type { ArtifactPreview } from '../../lib/chatflow/workbench-model';
import type {
  BridgeDevice,
  QueuedMessage,
  Message,
  WorkspaceFile,
  Session,
} from './chatflow-types';
import { layoutPreferenceKey } from './use-workbench-layout';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
async function selectSettings(dialog: Locator, label: string) {
  const mobile = dialog.getByRole('combobox', { name: '设置页面' });
  if (await mobile.isVisible()) await mobile.selectOption({ label });
  else
    await dialog
      .locator('nav')
      .getByRole('button', { name: label, exact: true })
      .click();
}

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
function session(sessionId: string): Session {
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
            : '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>',
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
      settingsEntry?: 'apps' | 'computer' | 'capabilities';
      archiveCount?: number;
      archiveActive?: boolean;
      tenantAdmin?: boolean;
      employeeCount?: number;
      employeeHistory?: boolean;
      employeeHistoryCount?: number;
      officeHistoryCount?: number;
      touch?: boolean;
      employeeColor?: EmployeeAccentColor;
      width?: number;
      artifacts?: boolean;
      disabled?: boolean;
      noSession?: boolean;
      noStorage?: boolean;
      startup?: 'failed' | 'slow';
      running?: boolean;
      streamingOutput?: boolean;
      controlledStream?: boolean;
      queue?: boolean;
    } = {},
  ) {
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: 950 },
      hasTouch: options.touch,
      isMobile: options.touch,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // Loading the development bundle can outlast interaction waits under CI load.
    page.setDefaultNavigationTimeout(15_000);
    const employeeHistorySessions = [
      ...Array.from({ length: options.employeeHistoryCount ?? 7 }, (_, n) => ({
        ...session(id(600 + n)),
        title: `历史工作 ${n + 1}`,
      })),
      ...Array.from({ length: options.officeHistoryCount ?? 1 }, (_, n) => ({
        ...session(n === 0 ? B : id(7000 + n)),
        employeeAssignmentId: id(17),
        ...(n ? { title: `Office 工作 ${n + 1}` } : {}),
      })),
      {
        ...session(id(6750)),
        employeeAssignmentId: id(99),
        employeeName: '旧员工',
        title: '已撤回员工的工作',
      },
    ];
    const errors: string[] = [],
      writes: string[] = [],
      unexpected: string[] = [];
    const state = {
      historyRunning: options.running ?? false,
      bridgeDevices: [] as BridgeDevice[],
      bridgeError: false,
      bridgeSelections: [] as string[],
      archivedIds: new Set<string>(),
      archiveActive: options.archiveActive ?? false,
      archiveError: false,
      sessionListError: false,
      sessionListDelay: null as Promise<void> | null,
      sessionListRequests: 0,
      sessionPageError: false,
      sessionPageDelay: null as Promise<void> | null,
      sessionPageRequests: [] as string[],
      archiveRequests: [] as Array<{
        archived: boolean;
        stopActivity?: boolean;
      }>,
      startupFailure: options.startup === 'failed',
      messages: null as Message[] | null,
      workMethods: [] as NonNullable<Message['workMethods']>,
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
      connectionError: false,
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
      detailReads: {} as Record<string, number>,
      detailStatus: 200,
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
      textPageLines: null as number | null,
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
    const archivedHistory = Array.from(
      { length: options.archiveCount ?? 0 },
      (_, n) => ({
        ...session(id(1600 + n)),
        title: `归档工作 ${n + 1}`,
        archivedAt: now,
      }),
    );
    const withArchive = (item: Session): Session => ({
      ...item,
      ...(options.employeeHistory && item.id === id(600)
        ? { running: state.historyRunning }
        : {}),
      archivedAt: state.archivedIds.has(item.id) ? now : item.archivedAt,
    });
    const sessionList = () =>
      (options.employeeHistory
        ? employeeHistorySessions
        : options.noSession
          ? []
          : state.omitSessionA
            ? [session(B)]
            : [session(A), session(B)]
      ).map(withArchive);
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    if (options.startup === 'slow') await page.clock.install();
    let finishStream!: () => void;
    const streamGate = new Promise<void>((done) => {
      finishStream = done;
    });
    page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
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
          let closed = false;
          let cleanup = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const push = (event: Event) =>
                controller.enqueue(
                  new TextEncoder().encode(
                    (event as CustomEvent<string>).detail,
                  ),
                );
              cleanup = () => {
                closed = true;
                window.removeEventListener('allrice-test-stream', push);
              };
              window.addEventListener('allrice-test-stream', push);
              document.documentElement.dataset.streamReady = 'true';
              init?.signal?.addEventListener(
                'abort',
                () => {
                  if (closed) return;
                  cleanup();
                  controller.close();
                },
                { once: true },
              );
            },
            cancel() {
              cleanup();
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
        if (state.connectionError)
          return answer({ error: { message: 'connection failed' } }, 503);
        return answer({ connections: state.connections });
      }
      if (
        path.startsWith('/api/v1/sessions/') &&
        route.request().method() === 'PATCH' &&
        !path.includes('/queued-messages/')
      ) {
        const body = route.request().postDataJSON();
        state.archiveRequests.push(body);
        if (state.archiveError)
          return answer({ error: { message: '测试：归档暂时失败' } }, 503);
        if (body.archived && state.archiveActive && !body.stopActivity)
          return answer(
            {
              error: {
                code: 'SESSION_ACTIVE',
                activity: [
                  { kind: 'job', items: [{ id: run, label: '正在分析报表' }] },
                ],
              },
            },
            409,
          );
        const target = path.split('/').at(-1)!;
        if (body.archived) state.archivedIds.add(target);
        else state.archivedIds.delete(target);
        return answer({ session: withArchive(session(target)) });
      }
      if (path.endsWith('/workspace-selection')) {
        state.bridgeSelections.push(path);
        return answer({ ok: true });
      }
      if (
        path.startsWith('/api/v1/bridge/grants/') &&
        route.request().method() === 'DELETE'
      ) {
        const grantId = path.split('/').at(-1);
        for (const device of state.bridgeDevices)
          device.folderGrants = device.folderGrants.filter(
            (grant) => grant.id !== grantId,
          );
        return answer({ ok: true });
      }
      if (path === '/api/v1/bridge/pairings')
        return answer({
          pairing: {
            id: id(908),
            code: 'ABCD-1234',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        });
      if (route.request().method() !== 'GET') {
        writes.push(path);
        return answer({}, 500);
      }
      if (path === '/api/v1/sessions' && route.request().method() === 'GET') {
        const filter = url.searchParams.get('archived');
        const records = [...sessionList(), ...archivedHistory].filter(
          (item) =>
            filter === 'true' ||
            (filter === 'only' ? !!item.archivedAt : !item.archivedAt),
        );
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const employeeId = url.searchParams.get('employeeAssignmentId');
        if (!employeeId) {
          state.sessionListRequests++;
          if (state.sessionListDelay) await state.sessionListDelay;
          if (state.sessionListError)
            return answer(
              { error: { message: 'Unknown synthetic route' } },
              503,
            );
        }
        if (employeeId) {
          state.sessionPageRequests.push(employeeId);
          if (state.sessionPageDelay) await state.sessionPageDelay;
          if (state.sessionPageError)
            return answer({ error: { message: '测试：会话加载失败' } }, 503);
        }
        const eligible = records
          .map((item, index) => ({ item, index }))
          .filter(
            ({ item, index }) =>
              index >= offset &&
              (!employeeId || item.employeeAssignmentId === employeeId),
          );
        const visible = eligible.slice(0, 30);
        const groups = new Map<
          string,
          { employeeAssignmentId: string; employeeName: string; count: number }
        >();
        for (const item of records) {
          const group = groups.get(item.employeeAssignmentId) ?? {
            employeeAssignmentId: item.employeeAssignmentId,
            employeeName: item.employeeName ?? 'Rice',
            count: 0,
          };
          group.count++;
          groups.set(item.employeeAssignmentId, group);
        }
        return answer({
          sessions: visible.map(({ item }) => item),
          nextCursor:
            eligible.length > 30 ? String(visible.at(-1)!.index + 1) : null,
          employeeGroups: employeeId ? undefined : [...groups.values()],
        });
      }
      if (path === '/api/v1/workspace' && state.startupFailure)
        return answer(
          { error: { message: 'Service temporarily unavailable' } },
          503,
        );
      if (path === '/api/v1/workspace' && options.startup === 'slow')
        await startupGate;
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
            sessions: sessionList(),
            sessionModels: [],
            employeeProfiles: options.employeeHistory
              ? [
                  {
                    assignmentId: id(7),
                    employeeId: id(9),
                    name: 'Rice',
                    description: '负责研究、分析与文件交付',
                    appearance: { accentColor: options.employeeColor },
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
                          appearance: { accentColor: options.employeeColor },
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
      if (path === '/api/v1/bridge/devices')
        return state.bridgeError
          ? answer({ error: { message: '连接状态刷新失败' } }, 503)
          : answer({ devices: state.bridgeDevices });
      if (path === '/api/v1/bridge/client/releases')
        return answer({
          releases: [
            {
              platform: 'macos-arm64',
              available: true,
              version: '0.6.0-dev.7',
            },
            { platform: 'macos-x64', available: true, version: '0.6.0-dev.7' },
          ],
        });
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
        if (url.searchParams.get('summary') === '1')
          return answer({
            workspaceId: workspace,
            usedBytes: 2147483648,
            limitBytes: null,
          });
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
        if (path.endsWith('/content')) {
          const offset = Number(
            new URL(route.request().url()).searchParams.get('offset') ?? 1,
          );
          const lines = state.text.split('\n');
          const page =
            state.textPageLines === null
              ? null
              : lines.slice(offset - 1, offset - 1 + state.textPageLines);
          return answer(
            state.officePreview ?? {
              kind: 'text',
              mediaType: 'text/markdown',
              text: page ? page.join('\n') : state.text,
              ...(page
                ? {
                    offset,
                    lines: page.length,
                    eof: offset + page.length > lines.length,
                  }
                : {}),
            },
            state.contentError ? 503 : 200,
          );
        }
        state.detailReads[a.id] = (state.detailReads[a.id] ?? 0) + 1;
        if (state.detailStatus !== 200)
          return answer(
            { error: { code: 'ARTIFACT_UNAVAILABLE' } },
            state.detailStatus,
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
            session: withArchive(
              listedHistory ?? session(path.endsWith(A) ? A : B),
            ),
            queuedMessages: path.endsWith(A) ? state.queue : [],
            messages: path.endsWith(A)
              ? (state.messages ?? [
                  {
                    id: id(20),
                    role: 'assistant',
                    runId: run,
                    status: state.messageStatus,
                    workMethods: state.workMethods,
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
      `${origin}/?session=${options.noSession ? '' : A}${options.disabled ? '&disabled=1' : ''}${options.settingsEntry ? `&settings=${options.settingsEntry}` : ''}`,
    );
    await (
      options.startup
        ? page.getByRole('region', { name: '进入工作区', exact: true })
        : page.getByRole('textbox', { name: /^给 .+ 的消息$/ })
    )
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
      releaseStartup,
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
          .getByRole('button', { name: `侧栏预览 report-${n}.md`, exact: true })
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
        releaseStartup();
        finishStream();
        await context.close();
        expect(errors).toEqual([]);
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
      },
    };
  }

  it.each(['failed', 'slow'] as const)(
    'workspace startup recovers from a %s request without an endless loading screen',
    async (startup) => {
      const f = await fixture({ startup });
      try {
        const retry = f.page.getByRole('button', {
          name: '重新连接',
          exact: true,
        });
        if (startup === 'failed') {
          await f.page
            .getByRole('alert')
            .filter({ hasText: '暂时无法进入工作区' })
            .waitFor();
          f.state.startupFailure = false;
          await retry.click();
        } else {
          expect(await retry.count()).toBe(0);
          await f.page.clock.runFor(15_000);
          await f.page
            .getByRole('status')
            .filter({ hasText: '连接用时较长' })
            .waitFor();
          expect(await retry.isVisible()).toBe(true);
          // A delayed response can still finish without a reload or duplicate task.
          f.releaseStartup();
        }
        await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
        expect(
          await f.page.getByRole('region', { name: '进入工作区' }).count(),
        ).toBe(0);
        expect(f.errors).toEqual([]);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'expands native work process downward from the clicked header at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 760,
        streamingOutput: true,
      });
      const operations = Array.from({ length: 4 }, (_, index) => ({
        nativeCallId: `lookup-${index}`,
        snapshot: {
          status: 'succeeded',
          binding: {
            action: 'cloud.mcp.call',
            attempt: { operationId: id(8950 + index) },
          },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: 'mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: {},
          risk: 'read',
        },
        approval: null,
        result: null,
      }));
      try {
        f.state.messages = navigationHistory(2);
        f.state.messages.at(-1)!.runId = run;
        f.state.messages.at(-1)!.content.text = '核对完成。';
        f.state.events = operations.map((operation, index) => ({
          schemaVersion: 3,
          eventId: id(8960 + index),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence: index + 1,
          cursor: `${run}:${index + 1}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type: 'tool.completed',
          payload: {
            toolCallId: operation.nativeCallId,
            name: 'cloud.mcp.call',
          },
        }));
        await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
          route.fulfill({
            json: {
              operations:
                new URL(route.request().url()).searchParams.get('runId') === run
                  ? operations
                  : [],
            },
          }),
        );
        await f.page.reload();
        if (width < 760) {
          const hide = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await hide.isVisible()) await hide.click();
        }
        const process = f.page
          .getByRole('region', { name: '工作过程', exact: true })
          .last();
        const header = process.locator('[data-disclosure-row]').first();
        const cards = process.locator('[id^="operation-"]');
        const scroll = f.page.locator('[data-conversation-scroll]');
        await cards.first().waitFor({ state: 'attached' });
        expect(await header.getAttribute('aria-expanded')).toBe('false');
        const settle = () =>
          f.page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
        const geometry = async () => ({
          top: (await header.boundingBox())!.y,
          scroll: await scroll.evaluate((node) => node.scrollTop),
        });
        for (const input of ['pointer', 'keyboard'] as const) {
          await scroll.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event('scroll'));
          });
          await settle();
          if (input === 'keyboard')
            await header.evaluate((node) =>
              node.focus({ preventScroll: true }),
            );
          const before = await geometry();
          if (input === 'keyboard') await header.press('Enter');
          else if (width < 760)
            await header.getByText('工作过程', { exact: true }).tap();
          else await header.getByText('工作过程', { exact: true }).click();
          await cards.first().waitFor();
          await settle();
          const after = await geometry();
          expect(Math.abs(after.top - before.top)).toBeLessThan(2);
          expect(Math.abs(after.scroll - before.scroll)).toBeLessThan(2);
          expect(await cards.count()).toBe(4);
          expect((await cards.first().boundingBox())!.y).toBeGreaterThan(
            after.top,
          );
          expect(
            (await process.locator('[data-work-reply]').boundingBox())!.y,
          ).toBeGreaterThan((await cards.last().boundingBox())!.y);
          const tools = process.getByRole('button', { name: '工具 · 4 项' });
          const toolsTop = (await tools.boundingBox())!.y;
          await tools.click();
          await process.getByRole('list', { name: '工作步骤' }).waitFor();
          await settle();
          expect(
            Math.abs((await tools.boundingBox())!.y - toolsTop),
          ).toBeLessThan(2);
          await tools.click();
          await header.press('Space');
          await settle();
          expect(Math.abs((await geometry()).top - before.top)).toBeLessThan(2);
        }
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'expands tool details downward without moving the clicked header at %ipx',
    async (width) => {
      const f = await fixture({ width, touch: width < 760 });
      const operations = Array.from({ length: 5 }, (_, index) => ({
        snapshot: {
          status: 'succeeded',
          binding: { attempt: { operationId: id(8900 + index) } },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: 'mcp',
          endpoint: 'https://example.test/mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: { query: 'Existing work' },
          risk: 'read',
        },
        approval: null,
        result: {
          code: 'completed',
          output: 'Existing tool result\n'.repeat(100),
          trusted: false,
        },
      }));
      try {
        f.state.messages = navigationHistory(2);
        f.state.messages.at(-1)!.runId = run;
        f.state.messages.at(-1)!.content.text = '查询完成。';
        await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
          route.fulfill({
            json: {
              operations:
                new URL(route.request().url()).searchParams.get('runId') === run
                  ? operations
                  : [],
            },
          }),
        );
        await f.page.reload();
        if (width < 760) {
          const hide = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await hide.isVisible()) await hide.click();
        }
        const scroll = f.page.locator('[data-conversation-scroll]');
        const card = f.page.locator(`#operation-${id(8900)}`);
        const next = f.page.locator(`#operation-${id(8901)}`);
        const header = card.locator('header');
        const toggle = header.getByRole('button');
        await toggle.waitFor();
        await scroll.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event('scroll'));
        });
        const settle = () =>
          f.page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
        const geometry = async () => ({
          top: (await header.boundingBox())!.y,
          next: (await next.boundingBox())!.y,
          height: (await card.boundingBox())!.height,
          scroll: await scroll.evaluate((node) => node.scrollTop),
        });
        await settle();
        // Starting at the bottom reproduces the resize-follow jump in a finished reply.
        await expect
          .poll(() =>
            scroll.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(2);
        for (const input of ['pointer', 'keyboard'] as const) {
          await scroll.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event('scroll'));
          });
          await settle();
          if (input === 'keyboard')
            await toggle.evaluate((node) =>
              node.focus({ preventScroll: true }),
            );
          const before = await geometry();
          if (input === 'keyboard') await toggle.press('Enter');
          else if (width < 760) await toggle.tap();
          else await toggle.click();
          await settle();
          const after = await geometry();
          expect(after.height).toBeGreaterThan(before.height + 100);
          expect(Math.abs(after.top - before.top)).toBeLessThan(2);
          expect(Math.abs(after.scroll - before.scroll)).toBeLessThan(2);
          expect(
            Math.abs(after.next - before.next - (after.height - before.height)),
          ).toBeLessThan(2);
          await toggle.press('Space');
          await settle();
          expect(Math.abs((await geometry()).top - before.top)).toBeLessThan(2);
        }
        // Reading older content must also keep its position on expansion.
        await scroll.evaluate((node) => {
          node.scrollTop -= 100;
        });
        await settle();
        const before = await geometry();
        await toggle.click();
        await settle();
        expect(Math.abs((await geometry()).top - before.top)).toBeLessThan(2);
        await f.page
          .getByRole('button', { name: '回到底部', exact: true })
          .click();
        await expect
          .poll(() =>
            scroll.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(2);
        // Native parameter/result disclosures follow the same reading behavior.
        const last = f.page.locator(`#operation-${id(8904)}`);
        await last
          .getByRole('button', { name: '查看详情', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '回到底部', exact: true })
          .click();
        await settle();
        const result = last
          .locator('summary')
          .filter({ hasText: '执行返回内容' });
        const resultTop = (await result.boundingBox())!.y;
        const lastHeight = (await last.boundingBox())!.height;
        const scrollTop = await scroll.evaluate((node) => node.scrollTop);
        await result.click();
        await settle();
        expect((await last.boundingBox())!.height).toBeGreaterThan(
          lastHeight + 100,
        );
        expect(
          Math.abs((await result.boundingBox())!.y - resultTop),
        ).toBeLessThan(2);
        expect(
          Math.abs(
            (await scroll.evaluate((node) => node.scrollTop)) - scrollTop,
          ),
        ).toBeLessThan(2);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390, 320])(
    'keeps compact cloud cancellation run-scoped until acknowledged at %ipx',
    async (width) => {
      const f = await fixture({ width, running: true, touch: width < 760 });
      const operation = {
        snapshot: {
          status: 'running',
          binding: { attempt: { operationId: id(8801) } },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: 'mcp',
          endpoint: 'https://example.test/mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: {},
          risk: 'read',
        },
        approval: null,
        result: null,
      } as unknown as CloudOperationView;
      const requests: unknown[] = [];
      let selectedRun = '';
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await f.page.route(
          '**/api/v1/runtime/cloud-operations?**',
          async (route) => {
            const request = route.request();
            const runId = new URL(request.url()).searchParams.get('runId')!;
            selectedRun ||= runId;
            if (request.method() === 'POST') {
              requests.push(request.postDataJSON());
              if (requests.length === 1)
                return route.fulfill({ status: 503, json: {} });
              await pending;
              return route.fulfill({ json: {} });
            }
            return route.fulfill({
              json: { operations: runId === selectedRun ? [operation] : [] },
            });
          },
        );
        await f.page.reload();
        if (width < 760) {
          const collapse = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await collapse.isVisible()) await collapse.click();
        }
        const card = f.page.locator(`#operation-${id(8801)}`);
        const stop = card.getByRole('button', {
          name: '请求停止本轮全部操作',
          exact: true,
        });
        const detail = card.getByRole('button', {
          name: '查看详情',
          exact: true,
        });
        await detail.waitFor();
        const runningHeight = (await card.boundingBox())!.height;
        if (width === 1440) expect(runningHeight).toBeLessThanOrEqual(56);
        const label = card
          .locator('header')
          .getByText('mcp__app__list_pull_requests', { exact: true });
        const labelBox = (await label.boundingBox())!;
        expect(
          await card.locator('header').getByRole('status').innerText(),
        ).toBe('执行中');
        for (const item of [
          label,
          card.locator('header').getByRole('status'),
          detail,
        ]) {
          expect(
            await item.evaluate((node) => ({
              font: getComputedStyle(node).fontSize,
              weight: getComputedStyle(node).fontWeight,
            })),
          ).toEqual({ font: '15px', weight: '400' });
        }
        const detailBox = (await detail.boundingBox())!;
        expect(detailBox.width).toBeLessThanOrEqual(64);
        const cardBox = (await card.boundingBox())!;
        expect(detailBox.x + detailBox.width).toBeLessThan(
          cardBox.x + cardBox.width,
        );
        const content = f.page.locator(
          `[id="${await detail.getAttribute('aria-controls')}"]`,
        );
        // The tool name and unused header space must not expand the receipt.
        await label.click();
        expect(await detail.getAttribute('aria-expanded')).toBe('false');
        const gapX = cardBox.x + 8;
        const gapY = labelBox.y + labelBox.height / 2;
        await f.page.mouse.move(gapX, gapY);
        expect(
          await f.page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest('button, summary') !==
              null,
            { x: gapX, y: gapY },
          ),
        ).toBe(false);
        await f.page.mouse.click(gapX, gapY);
        expect(await content.isVisible()).toBe(false);
        await detail.hover();
        expect(
          await detail.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return node.contains(
              document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              ),
            );
          }),
        ).toBe(true);
        await detail.focus();
        const headerTop = (await card.locator('header').boundingBox())!.y;
        await f.page.keyboard.press('Enter');
        await f.page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        expect(
          Math.abs((await card.locator('header').boundingBox())!.y - headerTop),
        ).toBeLessThan(2);
        const collapse = card.getByRole('button', {
          name: '收起详情',
          exact: true,
        });
        expect(await collapse.getAttribute('aria-expanded')).toBe('true');
        expect(await content.isVisible()).toBe(true);
        await content
          .locator('summary')
          .filter({ hasText: '发送参数' })
          .click();
        expect(await content.getByLabel('MCP 发送参数').isVisible()).toBe(true);
        await collapse.focus();
        await f.page.keyboard.press('Space');
        expect(await detail.getAttribute('aria-expanded')).toBe('false');
        expect((await card.boundingBox())!.height).toBe(runningHeight);
        await detail.click();
        await stop.click();
        await expect.poll(() => requests.length).toBe(1);
        await expect.poll(() => stop.isEnabled()).toBe(true);
        await stop.click();
        const stopping = card.getByRole('button', {
          name: '正在停止本轮全部操作',
          exact: true,
        });
        await stopping.waitFor();
        expect(await stopping.isDisabled()).toBe(true);
        release();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests).toEqual([
          { runId: selectedRun, action: 'cancel' },
          { runId: selectedRun, action: 'cancel' },
        ]);
        // The write acknowledgment alone must not claim that a remote service stopped.
        expect(await stopping.isDisabled()).toBe(true);
        expect(
          await card.locator('header').getByRole('status').innerText(),
        ).toBe('执行中');
        operation.snapshot.status = 'cancel_requested';
        await card
          .getByText('停止意图已记录，结果待确认', { exact: true })
          .waitFor();
        expect(await stopping.isDisabled()).toBe(true);
        // Completion can race with a stop request; display the real result.
        operation.snapshot.status = 'succeeded';
        operation.result = {
          code: 'completed',
          output: 'Done',
          trusted: false,
        };
        await card
          .locator('header')
          .getByText('成功', { exact: true })
          .waitFor();
        expect(await stopping.count()).toBe(0);
        await collapse.click();
        expect((await card.boundingBox())!.height).toBe(runningHeight);
        operation.snapshot.status = 'failed';
        operation.result = {
          code: 'MCP_REQUEST_FAILED',
          output: 'network request failed',
          trusted: false,
        };
        await card
          .locator('header')
          .getByText('失败', { exact: true })
          .waitFor();
        expect((await card.boundingBox())!.height).toBe(runningHeight);
        await detail.click();
        expect(
          await content.getByText('工具：', { exact: false }).isVisible(),
        ).toBe(true);
        await collapse.click();
        operation.snapshot.status = 'unknown';
        await card
          .locator('header')
          .getByText('结果待确认', { exact: true })
          .waitFor();
        expect(
          await card
            .locator('header')
            .getByText('失败', { exact: true })
            .count(),
        ).toBe(0);
        expect(requests).toHaveLength(2);
      } finally {
        release();
        await f.close();
      }
    },
  );

  for (const width of [1440, 390]) {
    it(`returns OAuth to the settings modal, keeps the conversation without local MCP setup at ${width}px`, async () => {
      const f = await fixture({
        width,
        settingsEntry: 'apps',
        tenantAdmin: true,
      });
      try {
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await dialog
          .getByRole('heading', { name: '已连接应用', exact: true })
          .waitFor();
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(A);
        expect(new URL(f.page.url()).searchParams.has('settings')).toBe(false);
        const advanced = dialog.locator('details').filter({
          has: f.page.locator('summary', { hasText: '本地应用高级设置' }),
        });
        expect(await advanced.count()).toBe(0);
        expect(
          await dialog.getByRole('region', { name: '本地 MCP 连接' }).count(),
        ).toBe(0);
        await selectSettings(dialog, '我的电脑');
        await dialog
          .getByRole('button', { name: '连接与管理电脑', exact: true })
          .waitFor();
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await dialog.getByRole('button', { name: '关闭设置' }).click();
        expect(await dialog.count()).toBe(0);
        await f.page.reload();
        await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
        expect(await dialog.count()).toBe(0);
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(A);
        expect(f.errors).toEqual([]);
        expect(f.unexpected).toEqual([]);
        expect(f.writes).toEqual([]);
      } finally {
        await f.context.close();
      }
    });
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

  async function openCapabilities(f: Awaited<ReturnType<typeof fixture>>) {
    const settings = f.page.getByRole('button', { name: '设置', exact: true });
    if (!(await settings.isVisible()))
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
    await settings.click();
    const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
    await selectSettings(dialog, '能力与环境');
    // Expand through the same controls as a user before exercising each action.
    for (const group of await dialog
      .locator('details:has(> summary):has([data-capability])')
      .all()) {
      if ((await group.getAttribute('open')) === null)
        await group.locator(':scope > summary').click();
    }
    for (const card of await dialog.locator('[data-capability]').all()) {
      await card.locator(':scope > summary').click();
    }
  }

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

  it.each([1440, 390])(
    'file copy toolbar seals the top of the reader while scrolling at width %s',
    async (width) => {
      const f = await fixture({ width });
      try {
        f.state.files = [
          {
            id: id(901),
            fileName: '工具记录.txt',
            mediaType: 'text/plain',
            sizeBytes: 18000,
            visibility: 'private',
            ownedByMe: true,
            category: 'uploads',
            deliverableVersion: null,
          },
        ];
        f.state.filePreview = {
          kind: 'text',
          mediaType: 'text/plain',
          text: Array.from(
            { length: 300 },
            (_, n) =>
              `记录 ${n}: timestamp=1781007600, adjustedClose=4.535999774932861`,
          ).join('\n'),
        };
        await f.page
          .getByRole('button', { name: '工作区文件', exact: true })
          .click();
        const tree = f.panel.locator('[data-files-state="tree"]');
        await tree
          .getByRole('button', { name: '上传文件', exact: true })
          .click();
        await tree
          .getByRole('button', { name: '工具记录.txt', exact: true })
          .click();
        const text = f.panel.getByRole('region', {
          name: '文件正文',
          exact: true,
        });
        await text.waitFor();
        const scrollport = text.locator('..');
        await scrollport.evaluate((e) => {
          e.scrollTop = 450;
        });
        const banner = text.locator('.md-code-block > :first-child');
        await expect
          .poll(async () => {
            const [b, s] = await Promise.all([
              banner.boundingBox(),
              scrollport.boundingBox(),
            ]);
            return Math.abs(b!.y - s!.y);
          })
          .toBeLessThanOrEqual(1);
        const toolbar = f.panel.locator('[aria-label="文件操作"]');
        const top = await toolbar.boundingBox(),
          b = await banner.boundingBox();
        expect(b!.y).toBeGreaterThanOrEqual(top!.y + top!.height - 1);
        expect(
          await banner.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return [1, r.width / 2, r.width - 1].every((x) =>
              e.contains(document.elementFromPoint(r.x + x, r.y + 1)),
            );
          }),
        ).toBe(true);
        await f.page.screenshot({
          path: `.local/reader/copy-toolbar-${width}.png`,
          animations: 'disabled',
        });
        await f.page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);
        await banner
          .getByRole('button', { name: '复制文本', exact: true })
          .click();
        await expect
          .poll(() => f.page.evaluate(() => navigator.clipboard.readText()))
          .toBe(f.state.filePreview.text);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

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
      // Dock retains hidden previews; measure the selected version's toolbar.
      // Native Dock adds a 1px divider and a 1px pane border.
      await expect
        .poll(async () => {
          const r = await f.panel
            .locator(
              `[data-document-id="${latest.id}"] [aria-label="文件操作"]`,
            )
            .boundingBox();
          return !!r && r.x >= 0 && r.x <= 2 && r.x + r.width <= 391;
        })
        .toBe(true);
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

  it.each([1440, 390, 320])(
    'compact dialogs preserve selection, connection and folder actions at width %s',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeCount: 2,
        employeeHistory: true,
      });
      try {
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        const picker = f.page.getByRole('dialog', {
          name: '选择 AI 员工',
          exact: true,
        });
        await picker.waitFor();
        const assertFits = async (selector: typeof picker) => {
          const box = await selector.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(
            await selector.evaluate((node) =>
              [...node.querySelectorAll('*')].every(
                (child) =>
                  child.scrollWidth <= child.clientWidth + 1 ||
                  getComputedStyle(child).display === 'inline',
              ),
            ),
          ).toBe(true);
        };
        await assertFits(picker);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-picker-${width}.png`,
          });
        await f.page.keyboard.press('Escape');
        expect(await picker.count()).toBe(0);
        if (width < 600)
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .click();
        f.state.bridgeDevices = [
          {
            id: id(901),
            name: 'M5-Max.local · Rice Bridge',
            platform: 'macos-arm64',
            status: 'online',
            clientVersion: '0.6.0-dev.7',
            lastSeenAt: now,
            folderGrants: [],
          },
        ];
        await f.page
          .getByRole('button', { name: 'Bridge 离线', exact: true })
          .click();
        const computer = f.page.getByRole('dialog', {
          name: '我的电脑',
          exact: true,
        });
        await computer.getByText('尚未选择文件夹', { exact: true }).waitFor();
        expect(
          await computer.getByText('已连接', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await computer
            .getByRole('button', { name: '生成配对码', exact: true })
            .isVisible(),
        ).toBe(false);
        await assertFits(computer);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-empty-${width}.png`,
          });
        await computer
          .getByRole('button', { name: '选择文件夹', exact: true })
          .click();
        await expect
          .poll(() => f.state.bridgeSelections)
          .toEqual([`/api/v1/bridge/devices/${id(901)}/workspace-selection`]);
        f.state.bridgeDevices[0]!.folderGrants = [
          { id: id(902), label: 'AI-what' },
        ];
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer.getByText('AI-what', { exact: true }).waitFor();
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-connected-${width}.png`,
          });
        if (width === 1440 && process.env.ALLRICE_DIALOG_SCREENSHOT) {
          await f.page.evaluate(() =>
            document.body.setAttribute('data-ds-dark-theme', ''),
          );
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-connected-dark.png`,
          });
          await f.page.evaluate(() =>
            document.body.removeAttribute('data-ds-dark-theme'),
          );
        }
        f.state.bridgeError = true;
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer.getByText('待确认', { exact: true }).waitFor();
        expect(
          await computer.getByText('AI-what', { exact: true }).count(),
        ).toBe(0);
        expect(
          await computer
            .getByRole('button', { name: '选择文件夹', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await computer
            .getByRole('button', { name: '断开', exact: true })
            .count(),
        ).toBe(0);
        f.state.bridgeError = false;
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer.getByText('AI-what', { exact: true }).waitFor();
        await computer
          .getByRole('button', { name: '断开', exact: true })
          .click();
        await computer.getByText('尚未选择文件夹', { exact: true }).waitFor();
        expect(f.state.bridgeDevices[0]!.folderGrants).toEqual([]);
        await computer.locator('summary').click();
        await computer
          .getByRole('link', {
            name: '下载 M 芯片版 · v0.6.0-dev.7',
            exact: true,
          })
          .waitFor();
        expect(
          await computer
            .getByRole('link', { name: /下载 Intel/ })
            .getAttribute('href'),
        ).toBe('/api/v1/bridge/client/macos-x64');
        await computer
          .getByRole('button', { name: '生成配对码', exact: true })
          .click();
        await computer.getByText('ABCD1234', { exact: true }).waitFor();
        await assertFits(computer);
        if (width === 1440) {
          await f.context.grantPermissions([
            'clipboard-read',
            'clipboard-write',
          ]);
          await computer
            .getByRole('button', { name: '复制配对码', exact: true })
            .click();
          expect(
            await f.page.evaluate(() => navigator.clipboard.readText()),
          ).toBe('ABCD1234');
        }
        f.state.bridgeDevices[0]!.status = 'offline';
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer.getByText('离线', { exact: true }).waitFor();
        expect(
          await computer.getByText('已是最新版', { exact: true }).count(),
        ).toBe(0);
        expect(
          await computer
            .getByRole('button', { name: '选择文件夹', exact: true })
            .count(),
        ).toBe(0);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-offline-${width}.png`,
          });
        await f.page.keyboard.press('Escape');
        expect(await computer.count()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('uses the published employee color across sidebar, picker, conversation and profile', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeColor: 'violet',
    });
    try {
      const conversation = f.page.locator('[data-employee-accent="violet"]');
      await conversation.waitFor();
      expect(
        await conversation.evaluate((node) =>
          getComputedStyle(node).getPropertyValue('--employee-end').trim(),
        ),
      ).toBe('#8B5CF6');
      expect(await f.page.locator('[data-accent="violet"]').count()).toBe(1);
      expect(
        await f.page
          .locator('[data-accent="violet"]')
          .getByText('R', { exact: true })
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe('rgb(139, 92, 246)');
      await f.page
        .getByRole('button', { name: '查看Rice详情', exact: true })
        .click();
      const details = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await details.locator('[data-employee-accent="violet"]').waitFor();
      expect(
        await details.locator('[data-employee-accent="violet"]').count(),
      ).toBe(1);
      await details.getByRole('button', { name: '关闭', exact: true }).click();
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      const picker = f.page.getByRole('dialog', {
        name: '选择 AI 员工',
        exact: true,
      });
      const rice = picker.getByRole('button', { name: /Rice/ });
      expect(await rice.getAttribute('data-accent')).toBe('violet');
      expect(
        await rice
          .getByText('R', { exact: true })
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe('rgb(139, 92, 246)');
      await rice.click();
      await f.page
        .getByRole('button', { name: '收起侧边栏', exact: true })
        .click();
      expect(
        await f.page
          .getByRole('button', { name: 'Rice', exact: true })
          .getAttribute('data-accent'),
      ).toBe('violet');
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390])(
    'expanded employee sessions scroll in both directions without moving sidebar controls at width %s',
    async (width) => {
      const f = await fixture({
        width,
        touch: width === 390,
        employeeCount: 2,
        employeeHistory: true,
        employeeHistoryCount: 30,
      });
      try {
        await f.page.setViewportSize({ width, height: 620 });
        if (width === 390)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const sidebar = f.page.locator('#chat-sidebar');
        const tree = sidebar.getByRole('tree', {
          name: '员工与工作',
          exact: true,
        });
        const rice = tree.locator('[data-row-key="workspace:' + id(7) + '"]');
        if ((await rice.getAttribute('aria-expanded')) !== 'true')
          await rice.click();
        await sidebar
          .getByRole('region', { name: 'Rice', exact: true })
          .getByRole('button', { name: /展开其余/ })
          .click();
        const office = sidebar.locator(
          '[data-row-key="workspace:' + id(17) + '"]',
        );
        if ((await office.getAttribute('aria-expanded')) !== 'true')
          await office.click();
        await sidebar.getByText('研究任务 B', { exact: true }).waitFor();
        const historical = sidebar.locator(
          '[data-row-key="workspace:' + id(99) + '"]',
        );
        if ((await historical.getAttribute('aria-expanded')) !== 'true')
          await historical.click();
        await sidebar.getByText('已撤回员工的工作', { exact: true }).waitFor();
        const top = sidebar.getByRole('button', {
          name: '新的工作',
          exact: true,
        });
        const settings = sidebar.getByRole('button', {
          name: '设置',
          exact: true,
        });
        const before = {
          top: await top.boundingBox(),
          settings: await settings.boundingBox(),
        };
        // Wait for the mobile drawer to finish entering before choosing touch coordinates.
        await expect
          .poll(() => sidebar.evaluate((n) => n.getBoundingClientRect().left))
          .toBe(0);
        const box = (await tree.boundingBox())!;
        await tree.evaluate((n) => {
          n.scrollTop = 0;
        });
        const initialScroll = await tree.evaluate((n) => n.scrollTop);
        const touchDistance = Math.min(250, box.height * 0.4);
        const x = box.x + box.width / 2,
          y = box.y + box.height * 0.65;
        const cdp =
          width === 390 ? await f.page.context().newCDPSession(f.page) : null;
        const scroll = async (down: boolean) => {
          if (cdp) {
            // Stay inside the tree even when filters shorten a mobile drawer.
            const startY = down ? y : y - touchDistance;
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ x, y: startY }],
            });
            for (let step = 1; step <= 10; step++) {
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                  {
                    x,
                    y: startY + ((down ? -1 : 1) * step * touchDistance) / 10,
                  },
                ],
              });
              await f.page.evaluate(() => new Promise(requestAnimationFrame));
            }
            // Pause the finger before lifting so the assertion does not race a fling.
            await f.page.waitForTimeout(150);
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: [],
            });
          } else {
            await f.page.mouse.move(x, y);
            await f.page.mouse.wheel(0, down ? 350 : -350);
          }
        };
        await scroll(true);
        await expect
          .poll(() => tree.evaluate((n) => n.scrollTop))
          .toBeGreaterThan(initialScroll + touchDistance * 0.5);
        await scroll(false);
        await expect
          .poll(() => tree.evaluate((n) => n.scrollTop))
          .toBeLessThan(initialScroll + 5);
        await sidebar
          .getByText('历史工作 30', { exact: true })
          .scrollIntoViewIfNeeded();
        const last = (await sidebar
          .getByText('历史工作 30', { exact: true })
          .boundingBox())!;
        expect(last.y).toBeGreaterThanOrEqual(box.y);
        expect(last.y + last.height).toBeLessThanOrEqual(
          box.y + box.height + 1,
        );
        expect(await top.boundingBox()).toEqual(before.top);
        expect(await settings.boundingBox()).toEqual(before.settings);
        await sidebar
          .getByRole('button', { name: '收起更多会话', exact: true })
          .click();
        expect(
          await sidebar.getByText('历史工作 30', { exact: true }).count(),
        ).toBe(0);
        await cdp?.detach();
      } finally {
        await f.close();
      }
    },
  );

  it('employee card hover preserves initials and position while highlighting the card', async () => {
    const f = await fixture({ employeeCount: 2, employeeHistory: true });
    try {
      const selected = f.page.locator(
        '[data-row-key^="session:"][aria-selected="true"]',
      );
      const other = f.page
        .locator('[data-row-key^="session:"][aria-selected="false"]')
        .first();
      await selected.waitFor();
      await other.hover();
      await expect
        .poll(() =>
          other.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe('rgb(233, 236, 241)');
      expect(
        await selected.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        ),
      ).toBe('rgb(225, 230, 237)');
      await selected.hover();
      await expect
        .poll(() =>
          selected.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe('rgb(216, 223, 232)');
      await f.page.mouse.move(1000, 900);
      if (process.env.ALLRICE_EMPLOYEE_SCREENSHOT) {
        await f.page.locator('#chat-sidebar').screenshot({
          path: `${process.env.ALLRICE_EMPLOYEE_SCREENSHOT}.png`,
        });
        await f.page.evaluate(() =>
          document.body.setAttribute('data-ds-dark-theme', ''),
        );
        await f.page.locator('#chat-sidebar').screenshot({
          path: `${process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-dark.png`,
        });
        await f.page.evaluate(() =>
          document.body.removeAttribute('data-ds-dark-theme'),
        );
      }
      for (const [employeeId, initial] of [
        [id(7), 'R'],
        [id(17), 'O'],
      ] as const) {
        const row = f.page.locator(`[data-row-key="workspace:${employeeId}"]`);
        const letter = row.getByText(initial, { exact: true });
        const card = row.locator('..').locator('..');
        await f.page.mouse.move(1000, 900);
        await expect.poll(() => letter.isVisible()).toBe(true);
        const before = await letter.boundingBox();
        await expect
          .poll(() => card.evaluate((e) => getComputedStyle(e).backgroundColor))
          .toBe('rgb(240, 242, 245)');
        await row.hover();
        expect(await letter.isVisible()).toBe(true);
        expect(await letter.boundingBox()).toEqual(before);
        await expect
          .poll(() => card.evaluate((e) => getComputedStyle(e).backgroundColor))
          .toBe('rgb(233, 236, 241)');
        expect(await card.evaluate((e) => getComputedStyle(e).boxShadow)).toBe(
          'none',
        );
        const expanded = await row.getAttribute('aria-expanded');
        await row.click();
        await expect
          .poll(() => row.getAttribute('aria-expanded'))
          .toBe(expanded === 'true' ? 'false' : 'true');
        expect(await letter.isVisible()).toBe(true);
      }
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
      await f.page.keyboard.press('2');
      expect(await picker.isVisible()).toBe(true);
      expect(await picker.getByText('快选', { exact: false }).count()).toBe(0);
      await picker.getByRole('button', { name: /Office 文档助手/ }).click();
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
      // The dock renders optimistically before the server accepts the message.
      // Simulate the worker only after the queued send has been acknowledged.
      await expect
        .poll(() => f.state.queue.map((message) => message.text))
        .toEqual(['next real turn']);
      await expect.poll(() => input.isEnabled()).toBe(true);
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

  it.each([320, 390, 1440])(
    'places the daily mode pill between attachment and visibility controls at width %i',
    async (width) => {
      const f = await fixture({ width, touch: width < 760 });
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
        const send = await f.page
          .getByRole('button', { name: '发送', exact: true })
          .boundingBox();
        expect(
          Math.abs(send!.y + send!.height / 2 - pill!.y - pill!.height / 2),
        ).toBeLessThan(2);
        expect(visibility!.x + visibility!.width).toBeLessThan(send!.x);
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

  it('lets an ordinary member control three Bridge capabilities in native settings without flashing the panel', async () => {
    const f = await fixture();
    const device = {
      id: id(950),
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      name: 'Synthetic Mac',
      platform: 'macos-arm64',
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
      status: 'online',
      lastSeenAt: now,
      createdAt: now,
      revokedAt: null,
      folderGrants: [],
    };
    const settings = {
      localCommand: true,
      localBrowser: true,
      development: true,
    };
    let revision = 0,
      pending = false,
      reads = 0;
    const writes: string[] = [];
    const login = {
      grantId: id(951),
      deviceId: device.id,
      enabled: true,
      persistLogin: true,
      profile: { network: 'public_https' },
    };
    const loginWrites: boolean[] = [];
    try {
      await f.page.route('**/api/v1/admin/local-browser**', (route) => {
        if (route.request().method() === 'PATCH') {
          login.persistLogin = route.request().postDataJSON().rememberLogin;
          loginWrites.push(login.persistLogin);
          login.grantId = id(951 + loginWrites.length);
        }
        return route.fulfill({ json: { grants: [login] } });
      });
      await f.page.route('**/api/v1/bridge/devices**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.pathname === '/api/v1/bridge/devices')
          return route.fulfill({ json: { devices: [device] } });
        if (request.method() === 'PATCH') {
          const change = request.postDataJSON() as {
            capability: keyof typeof settings;
            enabled: boolean;
          };
          writes.push(change.capability);
          settings[change.capability] = change.enabled;
          revision++;
          pending = true;
          reads = 0;
        } else if (pending && ++reads >= 1) pending = false;
        return route.fulfill({
          json: {
            device,
            settings,
            revision,
            pending,
            supported: true,
            environment: {
              version: 1,
              clientVersion: '0.6.0-dev.8',
              browserDefaultsVersion: 1,
              paused: false,
              browser: settings.localBrowser ? 'ready' : 'paused',
              sandbox: settings.localCommand ? 'ready' : 'paused',
              preview: 'ready',
              development: settings.development ? 'ready' : 'paused',
              settings,
              settingsRevision: pending ? revision - 1 : revision,
            },
          },
        });
      });
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      await selectSettings(dialog, '我的电脑');
      const browserSwitch = dialog.getByRole('switch', {
        name: '本地独立浏览器',
        exact: true,
      });
      await browserSwitch.waitFor();
      const remember = dialog.getByRole('switch', {
        name: '保留浏览器登录',
        exact: true,
      });
      await remember.waitFor();
      expect(await remember.getAttribute('aria-checked')).toBe('true');
      await remember.click();
      await expect
        .poll(() => remember.getAttribute('aria-checked'))
        .toBe('false');
      await dialog.getByRole('button', { name: '清除浏览器登录' }).click();
      await expect.poll(() => loginWrites.length).toBe(2);
      expect(loginWrites).toEqual([false, false]);
      expect(await dialog.getByRole('switch').count()).toBe(4);
      for (const label of ['本地沙箱命令', '本地独立浏览器', '受控开发协作'])
        expect(
          await dialog
            .getByRole('switch', { name: label, exact: true })
            .getAttribute('aria-checked'),
        ).toBe('true');
      await browserSwitch.evaluate((el) =>
        el.setAttribute('data-retained', 'yes'),
      );
      await browserSwitch.click();
      await dialog.getByText('正在同步到电脑…', { exact: true }).waitFor();
      await expect
        .poll(() => browserSwitch.getAttribute('aria-checked'))
        .toBe('false');
      await dialog.getByText('已连接', { exact: true }).waitFor();
      expect(await browserSwitch.getAttribute('data-retained')).toBe('yes');
      const development = dialog.getByRole('switch', {
        name: '受控开发协作',
        exact: true,
      });
      await development.click();
      await expect
        .poll(() => development.getAttribute('aria-checked'))
        .toBe('false');
      expect(
        await dialog
          .getByRole('switch', { name: '本地沙箱命令', exact: true })
          .getAttribute('aria-checked'),
      ).toBe('true');
      await dialog.getByText('已连接', { exact: true }).waitFor();
      await f.page.screenshot({
        path: '/tmp/allrice-bridge-three-switches.png',
      });
      expect(writes).toEqual(['localBrowser', 'development']);
    } finally {
      await f.close();
    }
  }, 15000);

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
      expect(
        await f.page.getByText('Codex 订阅 · DSH', { exact: true }).count(),
      ).toBe(0);
      await settings.click();
      const quota = f.page.getByRole('region', { name: '账号月额度' });
      await f.page.getByText('Synthetic member', { exact: true }).waitFor();
      await quota.getByText('Codex 订阅 · DSH', { exact: true }).waitFor();
      await quota.getByText(/43%/).waitFor();
      await quota.getByText('2,824,029', { exact: false }).waitFor();
      expect(await quota.innerText()).toContain('5,000,000');
      await f.page
        .getByText('工作区已用 2.00 GiB；未设置额外存储配额。', { exact: true })
        .waitFor();
      await f.page.reload();
      await settings.click();
      await quota.getByText(/43%/).waitFor();
    } finally {
      await f.close();
    }
  });

  it('signs out from account settings only after the logout request succeeds', async () => {
    const f = await fixture();
    let requests = 0;
    try {
      await f.page.route('**/api/v1/auth/logout', async (route) => {
        expect(route.request().method()).toBe('POST');
        requests++;
        await route.fulfill({ status: requests === 1 ? 503 : 204 });
      });
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      const logout = settings.getByRole('button', {
        name: '退出登录',
        exact: true,
      });
      const originalUrl = f.page.url();
      await logout.click();
      await settings
        .getByRole('alert')
        .filter({ hasText: '退出登录失败，请重试。' })
        .waitFor();
      expect(f.page.url()).toBe(originalUrl);
      await logout.click();
      await f.page.waitForURL('**/login');
      expect(requests).toBe(2);
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
        expect(
          await dialog.getByText('平台管理', { exact: true }).count(),
        ).toBe(0);
        expect(
          await dialog.getByRole('link', { name: '打开平台管理' }).count(),
        ).toBe(0);
        await f.page.screenshot({
          path: `/tmp/met160-settings-account-${width}.png`,
        });
        await selectSettings(dialog, '已连接应用');
        await dialog.getByText('需要登录', { exact: true }).waitFor();
        await dialog.getByText('管理连接', { exact: true }).click();
        await dialog.getByRole('button', { name: '填写连接凭据' }).click();
        const credential = dialog.getByLabel('应用访问令牌');
        await credential.fill('synthetic-unsaved-token');
        await selectSettings(dialog, '账号与用量');
        await selectSettings(dialog, '我的电脑');
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
        await selectSettings(dialog, '已连接应用');
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
      await selectSettings(settings, '已连接应用');
      await settings.getByText('管理连接', { exact: true }).click();
      await settings.getByRole('button', { name: '填写连接凭据' }).click();
      await settings.getByLabel('应用访问令牌').fill('synthetic-private-draft');
      f.state.viewer = id(50);
      f.state.workspace = id(51);
      f.state.connections = [];
      f.finishRun();
      await expect.poll(() => settings.count()).toBe(0);
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      await selectSettings(settings, '已连接应用');
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
        await selectSettings(settings, '个人偏好');
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

  it.each([
    [1440, false],
    [1440, true],
    [390, false],
    [390, true],
  ] as const)(
    'shows persisted work methods after %ipx streaming=%s completion and reload',
    async (width, streamingOutput) => {
      const f = await fixture({
        width,
        touch: width === 390,
        running: true,
        streamingOutput,
      });
      try {
        const methods = f.page.getByRole('group', {
          name: '工作方式',
          exact: true,
        });
        expect(await methods.count()).toBe(0);
        f.state.workMethods = [
          'cloud_search',
          'bridge_files',
          'cloud_compute',
          'bridge_browser',
          'cloud_search',
        ];
        f.finishRun();
        await methods.waitFor();
        const reply = f.page.locator(`#message-${id(20)}`);
        await reply.hover();
        expect(
          await methods.getByText('云端-检索', { exact: true }).count(),
        ).toBe(1);
        expect(
          await methods.getByText('Bridge-文件', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await methods.getByText('云端-计算', { exact: true }).count(),
        ).toBe(0);
        const more = methods.getByRole('button', {
          name: '查看全部 4 种工作方式',
        });
        expect(await more.innerText()).toBe('+2');
        if (width === 1440) {
          await more.hover();
          await f.page
            .getByRole('tooltip')
            .getByText(/Bridge-浏览器/)
            .waitFor();
        }
        await more.click();
        expect(
          await methods.getByText('云端-计算', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await methods.getByText('Bridge-浏览器', { exact: true }).isVisible(),
        ).toBe(true);
        await reply.locator('[data-message-actions]').screenshot({
          path: `/tmp/allrice-work-methods-${width}-${streamingOutput}.png`,
        });
        await f.page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);
        await reply.getByRole('button', { name: '复制', exact: true }).click();
        expect(
          await f.page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(f.state.reply);
        expect(
          await reply.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        ).toBe(true);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        await methods
          .getByRole('button', { name: '收起工作方式' })
          .press('Escape');
        expect(await more.getAttribute('aria-expanded')).toBe('false');
        await more.focus();
        await more.press('Enter');
        expect(
          await methods.getByText('Bridge-浏览器', { exact: true }).isVisible(),
        ).toBe(true);
        await f.page.reload();
        await methods.waitFor();
        expect(
          await methods.getByText('云端-检索', { exact: true }).count(),
        ).toBe(1);
        expect(await more.getAttribute('aria-expanded')).toBe('false');
        f.state.workMethods = [];
        await f.page.reload();
        await reply.locator('[data-message-actions]').waitFor();
        expect(await methods.count()).toBe(0);
        expect(f.errors).toEqual([]);
        expect(f.unexpected).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

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
      f.state.runTimings = [
        {
          runId: run,
          timing: {
            activeMs: 53000,
            waitingMs: 0,
            wallMs: 53000,
            timeoutMs: 3600000,
            remainingMs: 3547000,
            sources: [],
            calls: null,
            phase: 'active',
          },
        },
      ];
      f.state.streamEvents = f.state.events;
      f.releaseStream();
      await f.page.reload();
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
      expect(await process.getByText('回复中…', { exact: true }).count()).toBe(
        1,
      );
      const timer = process.getByLabel('本轮运行时间');
      await timer.waitFor();
      const gap = await timer.evaluate((el) => {
        const title = el.previousElementSibling?.previousElementSibling;
        return title
          ? el.getBoundingClientRect().left -
              title.getBoundingClientRect().right
          : -1;
      });
      expect(gap).toBeGreaterThanOrEqual(12);
      // Same partial reply followed by native compaction: one status, never a
      // second turn header inside the streamed body or a stale "replying".
      f.state.events.push(
        event(6, 'harness.native', {
          presentation: 'compaction',
          status: 'started',
          label: '正在整理上下文',
        }),
      );
      await f.page.reload();
      await process.getByText('正在整理上下文…', { exact: true }).waitFor();
      expect(
        await f.page.getByText('正在整理上下文…', { exact: true }).count(),
      ).toBe(1);
      expect(await process.getByText('回复中…', { exact: true }).count()).toBe(
        0,
      );
      await f.page.screenshot({
        path: '/tmp/allrice-native-status-compaction.png',
      });
      f.state.events.pop();
      f.state.events.push(
        event(6, 'assistant.text.completed', {
          replyId: 'last',
          text: '入口文件已确认。',
        }),
      );
      f.state.messageStatus = 'completed';
      f.state.runTimings[0]!.timing.phase = 'terminal';
      await f.page.reload();
      await f.page.getByText('入口文件已确认。', { exact: true }).waitFor();
      expect(
        await process
          .getByText('我先检查项目目录。', { exact: true })
          .isVisible(),
      ).toBe(false);
      await process.getByRole('button', { name: /^工作过程/ }).click();
      await process.getByText('我先检查项目目录。', { exact: true }).waitFor();
      await steps.getByRole('button').click();
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
  }, 30000);

  it('native task plan streams, restores, clears and stays scoped without animating stopped work', async () => {
    const f = await fixture({ running: true, controlledStream: true });
    try {
      const ready = () =>
        f.page.waitForFunction(
          () => document.documentElement.dataset.streamReady === 'true',
        );
      const emit = async (event: ChatFlowEventEnvelope) => {
        await ready();
        await f.page.evaluate(
          (body) =>
            window.dispatchEvent(
              new CustomEvent('allrice-test-stream', { detail: body }),
            ),
          `data: ${JSON.stringify(event)}\n\n`,
        );
      };
      const push = async (
        todos: unknown,
        type: ChatFlowEventEnvelope['type'] = 'harness.native',
      ) => {
        const sequence = f.state.events.length + 1;
        const event: ChatFlowEventEnvelope = {
          schemaVersion: 3,
          eventId: id(8800 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          cursor: `${run}:${sequence}`,
          sequence,
          harness: 'dsh',
          occurredAt: now,
          type,
          sourceEvent: {
            id: `dsh:${sequence}`,
            type: 'todo/write',
            occurredAt: now,
            payload: { todos },
          },
          payload: {
            generation: 1,
            attempt: 1,
            presentation: 'todo',
            label: '任务计划已更新',
          },
        };
        f.state.events.push(event);
        await emit(event);
      };
      const panel = f.page.getByTestId('todo-panel');
      expect(await panel.count()).toBe(0);
      const todos = [
        { content: '核对资料', status: 'completed' },
        { content: '生成演示文件', status: 'in_progress' },
        { content: '检查交付文件', status: 'pending' },
      ];
      await push(todos);
      await panel.waitFor();
      expect(await panel.innerText()).toContain('1 已完成');
      expect(await panel.innerText()).toContain('1 进行中');
      expect(
        await panel.getByRole('button').getAttribute('aria-expanded'),
      ).toBe('false');
      await panel.getByRole('button').click();
      expect(await panel.getByRole('listitem').count()).toBe(3);
      expect(await panel.locator('[data-state="ongoing"]').count()).toBe(1);
      const draft = f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ });
      await draft.fill('保留未发送草稿');
      await push([
        ...todos.slice(0, 2),
        { content: '检查新版文件', status: 'pending' },
      ]);
      await panel.getByText('检查新版文件', { exact: true }).waitFor();
      expect(await draft.inputValue()).toBe('保留未发送草稿');
      expect(
        await draft.evaluate((node) => document.activeElement === node),
      ).toBe(true);
      // Replayed snapshots do not collapse the native panel or duplicate its rows.
      await emit(f.state.events[0]!);
      expect(await panel.getByRole('listitem').count()).toBe(3);
      expect(
        await panel.getByRole('button').getAttribute('aria-expanded'),
      ).toBe('true');
      await f.page.setViewportSize({ width: 390, height: 844 });
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await panel.boundingBox())!.width).toBeGreaterThan(200);
      await f.page.screenshot({ path: '.local/task-plan/mobile.png' });
      await f.page.setViewportSize({ width: 1440, height: 950 });
      f.state.runTimings = [
        {
          runId: run,
          timing: {
            activeMs: 2000,
            waitingMs: 1000,
            wallMs: 3000,
            timeoutMs: 3600000,
            remainingMs: 3598000,
            phase: 'waiting',
            sources: [],
            calls: null,
          },
        },
      ];
      await f.page.reload();
      for (const event of f.state.events) await emit(event);
      await panel.getByRole('button').click();
      await expect.poll(() => panel.innerText()).toContain('等待继续');
      expect(await panel.locator('[data-state="ongoing"]').count()).toBe(0);
      // The authoritative clock can settle before the final SSE receipt arrives.
      f.state.runTimings[0]!.timing.phase = 'terminal';
      await expect
        .poll(() => panel.innerText(), { timeout: 10_000 })
        .toContain('未完成');
      f.state.messageStatus = 'failed';
      await push(undefined, 'run.failed');
      await expect.poll(() => panel.innerText()).toContain('未完成');
      expect(await panel.locator('[data-state="ongoing"]').count()).toBe(0);
      await f.page.reload();
      await panel.getByRole('button').click();
      await panel.getByText('检查新版文件', { exact: true }).waitFor();
      expect(await panel.innerText()).toContain('未完成');
      await f.page.screenshot({ path: '.local/task-plan/stopped.png' });
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      await expect.poll(() => panel.count()).toBe(0);
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      await panel.waitFor();
      // Explicit clearing survives a full history read.
      const last = f.state.events[0]!;
      f.state.events.push({
        ...last,
        eventId: id(8999),
        sequence: 999,
        sourceEvent: { ...last.sourceEvent!, payload: { todos: [] } },
      });
      await f.page.reload();
      await expect.poll(() => panel.count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('keeps native tool summaries and receipt details in reply order without duplicate pending text', async () => {
    const f = await fixture({
      running: true,
      streamingOutput: true,
      controlledStream: true,
    });
    const operations = ['first', 'second'].map((nativeCallId, index) => ({
      nativeCallId,
      createdAt: now,
      snapshot: {
        status: index === 0 ? 'succeeded' : 'running',
        binding: {
          action: 'cloud.mcp.call',
          attempt: { operationId: id(8990 + index) },
        },
      },
      enabled: true,
      mcpAuthorization: { available: true, reason: 'available' },
      proposal: {
        kind: 'mcp',
        endpoint: 'https://example.test/mcp',
        tool: 'mcp__app__list_pull_requests',
        arguments: { page: index + 1 },
        risk: 'read',
      },
      approval: null,
      result: null,
    }));
    try {
      await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
        route.fulfill({ json: { operations } }),
      );
      await f.page.reload();
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
          eventId: id(9100 + sequence),
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
        replyId: 'intro',
        text: '先核对两页记录。',
      });
      await push('tool.completed', {
        toolCallId: 'first',
        name: 'cloud.mcp.call',
        summary: '第一次读取完成',
      });
      await push('assistant.text.delta', {
        replyId: 'middle',
        text: '第一页已核对，再读取第二页。',
      });
      await push('tool.started', {
        toolCallId: 'second',
        name: 'cloud.mcp.call',
      });
      const first = f.page.locator(`#operation-${id(8990)}`),
        second = f.page.locator(`#operation-${id(8991)}`);
      await second.getByText('执行中', { exact: true }).waitFor();
      await push('assistant.text.delta', {
        replyId: 'final',
        text: '两页记录核对结束，最终结论在这里。',
      });
      const final = f.page.locator('[data-work-reply="reply:final"]');
      await final.waitFor();
      const middle = f.page.locator('[data-work-reply="reply:middle"]');
      expect((await first.boundingBox())!.y).toBeLessThan(
        (await middle.boundingBox())!.y,
      );
      expect((await middle.boundingBox())!.y).toBeLessThan(
        (await second.boundingBox())!.y,
      );
      expect((await second.boundingBox())!.y).toBeLessThan(
        (await final.boundingBox())!.y,
      );
      expect(
        await f.page
          .getByRole('region', { name: '工作过程', exact: true })
          .getByText('进行中', { exact: true })
          .count(),
      ).toBe(0);
      const groups = f.page.locator('section[aria-label="工作步骤"]');
      expect(await groups.count()).toBe(2);
      for (const group of await groups.all()) {
        const summary = group.getByRole('button', { name: '工具 · 1 项' });
        await summary.click();
        const steps = group.getByRole('list', { name: '工作步骤' });
        await steps.waitFor();
        expect(await steps.locator('li').count()).toBe(1);
        expect(await steps.getByText('进行中', { exact: true }).count()).toBe(
          0,
        );
      }
      expect(await groups.last().innerText()).toContain('使用已连接的服务');
      await second
        .getByRole('button', { name: '查看详情', exact: true })
        .click();
      expect(
        await second.getByText('发送参数', { exact: true }).isVisible(),
      ).toBe(true);
      operations[1]!.snapshot.status = 'succeeded';
      await push('tool.completed', {
        toolCallId: 'second',
        name: 'cloud.mcp.call',
      });
      f.state.messageStatus = 'completed';
      f.state.reply = '两页记录核对结束，最终结论在这里。';
      await push('assistant.text.completed', {
        replyId: 'final',
        text: f.state.reply,
      });
      await push('run.succeeded', {});
      await f.page.getByRole('button', { name: /工作过程/ }).click();
      await second.waitFor();
      expect((await second.boundingBox())!.y).toBeLessThan(
        (await final.boundingBox())!.y,
      );
      await f.page.screenshot({ path: '/tmp/allrice-timeline-order.png' });
      await f.page.reload();
      await final.waitFor();
      await f.page.getByRole('button', { name: /工作过程/ }).click();
      await second.waitFor();
      expect(await first.count()).toBe(1);
      expect(await second.count()).toBe(1);
      expect(await groups.count()).toBe(2);
      await groups.last().getByRole('button', { name: '工具 · 1 项' }).click();
      expect(
        await groups.last().getByRole('list', { name: '工作步骤' }).isVisible(),
      ).toBe(true);
      expect((await second.boundingBox())!.y).toBeLessThan(
        (await final.boundingBox())!.y,
      );
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
          f.page
            .locator(`#message-${id(20)}`)
            .getByRole('button', { name: '复制', exact: true })
            .count(),
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
      ).toBe(false);
      expect(
        await scroll.evaluate((element) => element.scrollTop),
      ).toBeLessThan(20);
    } finally {
      await f.close();
    }
  });

  it('offers a bounded read retry only after a status read failure and preserves unknown outcomes', async () => {
    const f = await fixture();
    let reads = 0,
      writes = 0,
      failing = true,
      hold = false;
    let finishRead: (() => Promise<void>) | undefined;
    const unknown = {
      nativeCallId: 'missing-result',
      createdAt: now,
      snapshot: {
        status: 'unknown',
        binding: {
          action: 'cloud.mcp.call',
          attempt: { operationId: id(9890) },
        },
      },
      enabled: true,
      mcpAuthorization: { available: true, reason: 'available' },
      proposal: {
        kind: 'mcp',
        endpoint: 'https://example.test/mcp',
        tool: 'mcp__app__list_pull_requests',
        arguments: {},
        risk: 'read',
      },
      approval: null,
      result: null,
    };
    try {
      await f.page.route(
        '**/api/v1/runtime/cloud-operations?**',
        async (route) => {
          if (route.request().method() !== 'GET') {
            writes++;
            return route.abort();
          }
          reads++;
          if (failing) return route.fulfill({ status: 503, json: {} });
          const finish = () =>
            route.fulfill({ json: { operations: [unknown] } });
          if (hold) {
            await new Promise<void>((resolve) => {
              finishRead = async () => {
                await finish();
                resolve();
              };
            });
          } else await finish();
        },
      );
      await f.page.reload();
      const retry = f.page.getByRole('button', { name: '重试读取操作状态' });
      await retry.waitFor();
      const firstReads = reads;
      expect(
        await retry.evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('13px');
      await retry.click();
      await expect.poll(() => reads).toBe(firstReads + 1);
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(
        await f.page.getByText('操作状态读取失败', { exact: true }).isVisible(),
      ).toBe(true);
      failing = false;
      hold = true;
      await retry.click();
      await expect.poll(() => Boolean(finishRead)).toBe(true);
      expect(await retry.isDisabled()).toBe(true);
      expect(await retry.innerText()).toBe('读取中…');
      await finishRead!();
      await f.page
        .getByText('已读取最新状态，结果仍待确认。', { exact: true })
        .waitFor();
      expect(await retry.count()).toBe(0);
      expect(
        await f.page.getByRole('button', { name: '刷新操作状态' }).count(),
      ).toBe(0);
      expect(unknown.snapshot.status).toBe('unknown');
      expect(writes).toBe(0);
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
      expect(await timing.innerText()).toBe('用时 17秒');
      const motion = () =>
        f.page.evaluate(() => {
          const reply = document.querySelector(
            '[data-actions-reveal="hover"]',
          )!;
          const avatar = reply.querySelector('[class*="assistantIdentity"] i')!;
          const header = reply.querySelector(
            '[aria-label="工作过程"] [data-disclosure-row]',
          )!;
          return [avatar, header].map((element) => ({
            name: getComputedStyle(element).animationName,
            duration: getComputedStyle(element).animationDuration,
            opacity: Number(getComputedStyle(element).opacity),
          }));
        });
      const [avatarMotion, headerMotion] = await motion();
      expect(avatarMotion!.name).not.toBe('none');
      expect(headerMotion!.name).toBe('none');
      expect(headerMotion!.opacity).toBe(1);
      expect(
        await f.page
          .locator('[aria-label="工作过程"] [data-text-shimmer="true"]')
          .count(),
      ).toBe(1);
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      expect((await motion()).map((item) => item.name)).toEqual([
        'none',
        'none',
      ]);
      await f.page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const seconds of [18, 19, 20]) {
        await f.page.clock.runFor(1000);
        await expect.poll(() => timing.innerText()).toBe(`用时 ${seconds}秒`);
      }
      // Server updates do not reset the display interval or make it run backwards.
      f.state.runTimings[0]!.timing.phase = 'waiting';
      f.state.runTimings[0]!.timing.wallMs = 19000;
      await f.page.clock.runFor(2000);
      await expect.poll(() => timing.innerText()).toBe('用时 22秒');
      // The local clock can tick before the server phase receipt commits.
      await expect
        .poll(async () => (await motion()).map((item) => item.name))
        .toEqual(['none', 'none']);
      expect(f.state.runTimings[0]!.timing.activeMs).toBe(17000);
      f.state.runTimings[0]!.timing.phase = 'terminal';
      f.state.runTimings[0]!.timing.wallMs = 22500;
      await f.page.clock.runFor(2000);
      await expect.poll(() => timing.innerText()).toBe('用时 22秒');
      await f.page.clock.runFor(5000);
      expect(await timing.innerText()).toBe('用时 22秒');
      f.state.runTimings[0]!.timing.phase = 'queued';
      f.state.runTimings[0]!.timing.wallMs = 0;
      await f.page.reload();
      await timing.waitFor();
      await f.page.clock.runFor(3000);
      expect(await timing.innerText()).toBe('用时 0秒');
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
        await timing.waitFor();
        expect(await process.getByRole('button').count()).toBe(0);
        expect(await process.locator('[aria-expanded]').count()).toBe(0);
        expect(await timing.innerText()).toContain('用时 22秒');
        expect(await process.innerText()).not.toContain('累计等待');
        expect(await timing.count()).toBe(1);
        expect(await process.innerText()).not.toContain('模型请求');
        f.state.runTimings[0]!.timing.waitingMs = 2400000;
        f.state.runTimings[0]!.timing.wallMs = 2412460;
        await expect
          .poll(() => timing.innerText(), { timeout: 5000 })
          .toContain('用时 40分 12秒');
        expect(await timing.innerText()).toContain('用时 40分 12秒');
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
        await timing.waitFor();
        expect(await process.getByRole('button').count()).toBe(0);
        expect(await process.locator('[aria-expanded]').count()).toBe(0);
        expect(await timing.innerText()).toContain('用时 40分 12秒');
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
      await openCapabilities(f);
      await f.page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
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
        .getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: '关闭设置', exact: true })
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
          await preview
            .getByRole('img', { name: 'Office 文档第 2 页' })
            .scrollIntoViewIfNeeded();
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
      expect(await preview.innerText()).toContain('发现 1 个公式错误');
      expect(await preview.innerText()).toContain('展示前 2 页');
      await preview.locator('summary').click();
      expect(await preview.innerText()).toContain('#DIV/0!');
      expect(await preview.innerText()).toContain('60');
      await preview.getByRole('img', { name: 'Office 文档第 2 页' }).waitFor();
      expect(
        await preview.getByRole('button', { name: /上一页|下一页/ }).count(),
      ).toBe(0);
      expect(
        await preview.locator('[data-document-zoom-scrollport]').count(),
      ).toBe(1);
      expect(await preview.innerText()).not.toContain('请检查分页');
    } finally {
      await f.close();
    }
  });

  it.each([
    [1440, false],
    [1440, true],
    [390, false],
    [390, true],
  ] as const)(
    'MET-163 image delivery at %ipx streaming=%s survives reload, previews and downloads',
    async (width, streamingOutput) => {
      const f = await fixture({
        width,
        touch: width === 390,
        running: true,
        streamingOutput,
      });
      try {
        const png = await f.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 800;
          c.height = 800;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, 800, 800);
          ctx.fillStyle = '#ff8a00';
          ctx.beginPath();
          ctx.arc(400, 400, 250, 0, Math.PI * 2);
          ctx.fill();
          // Deterministic texture makes this a realistic multi-MB PNG rather
          // than a tiny solid-color image that misses the old preview limit.
          const pixels = ctx.getImageData(0, 0, 800, 800);
          let seed = 163;
          for (let i = 0; i < pixels.data.length; i++) {
            if (i % 4 === 3) continue;
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[i] = (pixels.data[i]! & 0xf0) | (seed >>> 28);
          }
          ctx.putImageData(pixels, 0, 0);
          return c.toDataURL('image/png').split(',')[1]!;
        });
        expect(Buffer.from(png, 'base64').length).toBeGreaterThan(512_000);
        const img = artifact(10);
        img.version.fileName = '圆形海报.png';
        img.version.format = 'png';
        img.object.mediaType = 'image/png';
        img.object.sizeBytes = Buffer.from(png, 'base64').length;
        img.version.version = 2;
        f.state.officePreview = {
          kind: 'image',
          mediaType: 'image/png',
          base64: png,
        };
        await f.page.route('**/api/v1/files/*/download?*', (route) =>
          route.fulfill({
            contentType: 'image/png',
            headers: {
              'content-disposition':
                "attachment; filename*=UTF-8''" +
                encodeURIComponent(img.version.fileName),
            },
            body: Buffer.from(png, 'base64'),
          }),
        );
        f.state.reply = '已把蓝色圆形修改为橙色，并保留原图版本。';
        f.state.workMethods = ['cloud_images'];
        f.finishRun();
        f.state.items = [img];
        const picture = f.page
          .getByRole('button', { name: '查看图片 圆形海报.png', exact: true })
          .first();
        await picture.waitFor();
        await expect
          .poll(() =>
            picture
              .locator('img')
              .evaluate(
                (i: HTMLImageElement) => i.complete && i.naturalWidth > 0,
              ),
          )
          .toBe(true);
        expect(
          await f.page
            .locator('#message-' + id(20))
            .getByRole('button', { name: '查看图片 圆形海报.png', exact: true })
            .count(),
        ).toBe(1);
        await f.page.locator('#message-' + id(20)).hover();
        expect(
          await f.page
            .getByRole('group', { name: '工作方式', exact: true })
            .innerText(),
        ).toContain('云端-图片');
        expect(
          await f.page
            .locator('body')
            .evaluate((el) => el.scrollWidth <= innerWidth),
        ).toBe(true);
        await picture.click();
        const preview = f.panel.locator('[data-image-preview] img');
        await preview.waitFor();
        const zoomFrame = f.panel.locator('[data-document-zoom-frame]');
        await zoomFrame.scrollIntoViewIfNeeded();
        const bounds = (await zoomFrame.boundingBox())!;
        await f.page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height - 20,
        );
        await f.panel
          .getByRole('button', { name: '放大', exact: true })
          .click();
        expect(
          await f.panel.locator('[data-document-zoom-scrollport]').count(),
        ).toBe(1);
        await f.panel
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.reload();
        await picture.waitFor();
        await picture.scrollIntoViewIfNeeded();
        await f.page.screenshot({
          path: `/tmp/met163-images-${width}-${streamingOutput}.png`,
        });
        const card = f.page
          .locator('[data-presented-file]')
          .filter({ hasText: '圆形海报.png' })
          .first();
        await card
          .getByRole('button', { name: '圆形海报.png 打开方式' })
          .click();
        const downloaded = f.page.waitForEvent('download');
        await f.page
          .getByRole('menuitem', { name: '下载文件', exact: true })
          .click();
        expect((await downloaded).suggestedFilename()).toBe('圆形海报.png');
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it.each([1440, 390])(
    'native delivery cards preview and download at width %i',
    async (width) => {
      const f = await fixture({ artifacts: true, width });
      try {
        const card = f.page
          .locator('[data-presented-file]')
          .filter({ hasText: 'report-10.md' })
          .first();
        await card.waitFor();
        expect(await card.locator('svg').count()).toBeGreaterThan(0);
        const menu = card.getByRole('button', {
          name: 'report-10.md 打开方式',
        });
        await menu.click();
        await f.page
          .getByRole('menuitem', { name: '侧栏预览', exact: true })
          .waitFor();
        await f.page.keyboard.press('Escape');
        await expect
          .poll(() =>
            f.page
              .getByRole('menuitem', { name: '侧栏预览', exact: true })
              .count(),
          )
          .toBe(0);
        await menu.click();
        await f.page
          .getByRole('menuitem', { name: '侧栏预览', exact: true })
          .click();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.panel
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.route('**/api/v1/files/*/download?*', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/markdown',
            headers: {
              'content-disposition': 'attachment; filename="report-10.md"',
            },
            body: report,
          }),
        );
        await menu.click();
        const downloadEvent = f.page.waitForEvent('download');
        await f.page
          .getByRole('menuitem', { name: '下载文件', exact: true })
          .click();
        const download = await downloadEvent;
        expect(download.suggestedFilename()).toBe('report-10.md');
        expect(new URL(download.url()).pathname).toBe(
          `/api/v1/files/${artifact(10).object.id}/download`,
        );
        expect(await f.panel.count()).toBe(0);
        expect(
          await f.page
            .locator('body')
            .evaluate((body) => body.scrollWidth <= innerWidth),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'Office paper canvas scrolls continuously in both themes at width %i',
    async (width) => {
      const f = await fixture({ artifacts: true, width });
      try {
        const png = await f.page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 900;
          canvas.height = 1200;
          const c = canvas.getContext('2d')!;
          c.fillStyle = '#fff';
          c.fillRect(0, 0, 900, 1200);
          c.fillStyle = '#163b65';
          c.font = '40px sans-serif';
          c.fillText('Office document preview', 60, 100);
          return canvas.toDataURL('image/png').split(',')[1]!;
        });
        f.state.officePreview = {
          kind: 'office',
          checksum: `sha256:${'a'.repeat(64)}`,
          format: 'xlsx',
          pageCount: 2,
          pages: [
            { number: 1, base64: png },
            { number: 2, base64: png },
          ],
          formulaCount: 0,
          formulaErrorCount: 0,
          formulas: [],
        };
        await f.page.reload();
        await f.entry.click();
        const preview = f.panel.getByRole('region', {
          name: 'Office 文档预览',
        });
        const second = preview.getByRole('img', { name: 'Office 文档第 2 页' });
        await second.waitFor();
        expect(await preview.locator('summary').count()).toBe(0);
        const scroll = preview.locator('[data-document-zoom-scrollport]');
        const paper = preview.locator('[data-document-zoom-surface]').first();
        await expect
          .poll(() =>
            scroll.evaluate((el) => el.scrollHeight > el.clientHeight),
          )
          .toBe(true);
        expect(
          await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        expect(
          await paper.evaluate((el) => getComputedStyle(el).backgroundColor),
        ).toBe('rgb(255, 255, 255)');
        const canvasColor = () =>
          scroll.evaluate(
            (el) =>
              getComputedStyle(el.parentElement!.parentElement!)
                .backgroundColor,
          );
        const light = await canvasColor();
        expect(light).not.toBe('rgb(255, 255, 255)');
        expect(light).not.toBe('rgba(0, 0, 0, 0)');
        await f.page.evaluate(() =>
          document.body.setAttribute('data-ds-dark-theme', ''),
        );
        expect(await canvasColor()).not.toBe(light);
        await second.scrollIntoViewIfNeeded();
        expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(
          await f.page
            .locator('body')
            .evaluate((body) => body.scrollWidth <= innerWidth),
        ).toBe(true);
        await f.page.screenshot({
          path: `/tmp/allrice-office-continuous-${width}.png`,
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'resolves chat downloads only for this Run’s authenticated artifacts at width %i',
    async (width) => {
      const f = await fixture({ artifacts: true, width });
      try {
        const path = `/api/v1/files/${artifact(10).object.id}/download`;
        f.state.reply = `[下载报告](https://allrice.example${path}?name=wrong)\n\n[下载 report-10.md](/api/v1/files/broken-id?name=wrong)\n\n[原始来源](https://example.org/source)`;
        await f.page.reload();
        const link = f.page.getByRole('link', {
          name: '下载报告',
          exact: true,
        });
        await expect
          .poll(() => link.getAttribute('href'))
          .toBe(`${origin}${path}?name=report-10.md`);
        const repaired = f.page.getByRole('link', {
          name: '下载 report-10.md',
          exact: true,
        });
        expect(await repaired.getAttribute('href')).toBe(
          `${origin}${path}?name=report-10.md`,
        );
        // Native Markdown opens HTTP links without navigating away from the chat.
        expect(await link.getAttribute('target')).toBe('_blank');
        expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(
          await link.evaluate((node) => getComputedStyle(node).color),
        ).toBe('rgb(65, 118, 230)');
        await f.page.evaluate(() =>
          document.body.setAttribute('data-ds-dark-theme', ''),
        );
        expect(
          await link.evaluate((node) => getComputedStyle(node).color),
        ).toBe('rgb(103, 158, 254)');
        await f.page.evaluate(() =>
          document.body.removeAttribute('data-ds-dark-theme'),
        );
        const pageCount = f.page.context().pages().length;
        await link.click();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(
          await f.panel
            .getByRole('link', { name: '下载', exact: true })
            .getAttribute('href'),
        ).toContain(path);
        expect(f.page.context().pages()).toHaveLength(pageCount);
        expect(new URL(f.page.url()).pathname).toBe('/');
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
        expect(await repaired.count()).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

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
        await openCapabilities(f);
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        const glyphs = await dialog
          .locator('nav button svg')
          .evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
        expect(glyphs.length).toBeGreaterThanOrEqual(6);
        expect(new Set(glyphs).size).toBe(glyphs.length);
        expect(
          await f.page
            .locator('header')
            .getByRole('button', { name: '能力与环境', exact: true })
            .count(),
        ).toBe(0);
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .waitFor();
        expect(
          await dialog
            .locator('[data-capability]')
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute('data-capability')),
            ),
        ).toEqual(
          expect.arrayContaining(
            workspaceCapabilityIds.filter((id) => id !== 'local_mcp'),
          ),
        );
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
      await openCapabilities(f);
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const card = dialog.locator('[data-capability="local_files"]');
      await card.getByRole('button', { name: '连接与管理电脑' }).click();
      const bridge = f.page.getByRole('dialog', {
        name: '我的电脑',
        exact: true,
      });
      await bridge.waitFor();
      await bridge.getByRole('link', { name: /下载 M 芯片版/ }).waitFor();
      const calls = f.state.readinessRequests;
      await f.page.keyboard.press('Escape');
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await openCapabilities(f);
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

  it.each([390, 1280])(
    'shows downloadable and installed Bridge versions at width %i and refreshes after an upgrade',
    async (width) => {
      const f = await fixture({ width });
      let installed = '0.6.0-dev.6';
      try {
        await f.page.route('**/api/v1/bridge/devices?*', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              devices: [
                {
                  id: id(500),
                  name: 'Synthetic Mac',
                  platform: 'macos-arm64',
                  status: 'online',
                  clientVersion: installed,
                  lastSeenAt: new Date().toISOString(),
                  folderGrants: [],
                },
              ],
            }),
          }),
        );
        await openCapabilities(f);
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await settings
          .locator('[data-capability="local_files"]')
          .getByRole('button', { name: '连接与管理电脑' })
          .click();
        const dialog = f.page.getByRole('dialog', {
          name: '我的电脑',
          exact: true,
        });
        const download = dialog.getByRole('link', {
          name: '下载 M 芯片版 · v0.6.0-dev.7',
          exact: true,
        });
        await dialog.getByText('v0.6.0-dev.6', { exact: true }).waitFor();
        await dialog.getByText('有新版本', { exact: true }).waitFor();
        expect(await download.isVisible()).toBe(false);
        await dialog.locator('summary').click();
        await download.waitFor();
        expect(await download.getAttribute('href')).toBe(
          '/api/v1/bridge/client/macos-arm64',
        );
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await f.page.screenshot({
          path: `/tmp/bridge-release-versions-${width}.png`,
        });
        installed = '0.6.0-dev.7';
        await dialog
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await dialog.getByText('v0.6.0-dev.7', { exact: true }).waitFor();
        await dialog.getByText('已是最新版', { exact: true }).waitFor();
        expect(
          await dialog.getByText('有新版本', { exact: true }).count(),
        ).toBe(0);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('checks once on opening and preserves cards while manually refreshing, without polling or focus refresh', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.page.clock.install();
      const entry = { click: () => openCapabilities(f) };
      await entry.click();
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
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

  it('keeps online app status in sync alongside five Bridge capabilities without local MCP setup', async () => {
    const f = await fixture();
    try {
      f.state.connections = ['GitHub', 'Linear'].map((name, index) =>
        McpConnectionSchema.parse({
          id: id(70 + index),
          definitionId: id(80 + index),
          workspaceId: workspace,
          name,
          endpoint: `https://${name.toLowerCase()}.example.test/mcp`,
          enabled: true,
          revision: 1,
          credentialConfigured: true,
          credentialReference: 'synthetic',
          managed: true,
          shared: false,
          discoveryState: 'ready',
          discoveryCode: null,
          checkedAt: now,
          tools: [],
        }),
      );
      f.state.capabilities = f.state.capabilities.map((c) =>
        c.id === 'cloud_mcp'
          ? {
              ...c,
              state: 'ready',
              reason: 'ready',
              action: 'compose',
              releaseEnabled: true,
            }
          : c.id === 'local_mcp'
            ? {
                ...c,
                state: 'needs_configuration',
                reason: 'connection_missing',
                action: 'mcp_settings',
                releaseEnabled: true,
              }
            : c,
      );
      await openCapabilities(f);
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const online = dialog.locator('[data-capability="cloud_mcp"]');
      const local = dialog.locator('[data-capability="local_mcp"]');
      const list = online.getByRole('list', { name: '在线应用连接状态' });
      await list.waitFor();
      expect(await list.innerText()).toContain('GitHub');
      expect(await list.innerText()).toContain('Linear');
      expect(await list.getByText('已连接', { exact: true }).count()).toBe(2);
      expect(await local.count()).toBe(0);
      const bridge = dialog.locator('details').filter({
        has: f.page.locator(':scope > summary', { hasText: 'Bridge 能力' }),
      });
      expect(await bridge.locator('[data-capability]').count()).toBe(5);
      expect(await bridge.locator(':scope > summary').innerText()).toContain(
        '5 项',
      );
      await online
        .getByRole('button', { name: '已连接应用', exact: true })
        .click();
      expect(
        await dialog.getByText('本地应用高级设置', { exact: true }).count(),
      ).toBe(0);
      expect(
        await dialog.getByLabel('固定来源与完整文件校验和 JSON').count(),
      ).toBe(0);
      const github = dialog.getByRole('article').filter({
        has: f.page.getByRole('heading', { name: 'GitHub', exact: true }),
      });
      await github.getByText('管理连接', { exact: true }).click();
      await github
        .getByRole('button', { name: '断开连接', exact: true })
        .click();
      await github.getByText('已断开', { exact: true }).waitFor();
      await selectSettings(dialog, '能力与环境');
      await list.getByText('已断开', { exact: true }).waitFor();
      expect(await list.getByText('已连接', { exact: true }).count()).toBe(1);
      expect(await local.count()).toBe(0);
      f.state.connectionError = true;
      await dialog
        .getByRole('button', { name: '刷新能力状态', exact: true })
        .click();
      await online
        .getByText('连接状态暂时无法读取', { exact: false })
        .waitFor();
      expect(await list.count()).toBe(0);
      expect(
        await online.getByText('尚未添加在线应用', { exact: false }).count(),
      ).toBe(0);
      expect(f.state.connectionActions).toEqual(['disconnect']);
      expect(f.state.messageInputs).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
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
      const entry = { click: () => openCapabilities(f) };
      await entry.click();
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const mcp = dialog.locator('[data-capability="cloud_mcp"]');
      await mcp.getByRole('button', { name: '准备在线应用任务' }).waitFor();
      expect(await mcp.getByRole('link').count()).toBe(0);
      await mcp
        .getByRole('button', { name: '已连接应用', exact: true })
        .click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      await settings.getByText('还没有连接应用。', { exact: false }).waitFor();
      expect(
        await dialog.locator('[data-capability="cloud_mcp"]').isVisible(),
      ).toBe(false);
      await f.page.keyboard.press('Escape');
      await entry.click();
      await mcp.getByRole('button', { name: '准备在线应用任务' }).waitFor();
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
      await openCapabilities(f);
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
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
      await openCapabilities(f);
      await dialog.getByText(/更新于/).waitFor();
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
      await dialog.getByText(/更新于/).waitFor();
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
  it.each([false, true])(
    'automatically presents a newly completed SSE delivery with its full answer, but never reopens a panel the user closed (streaming=%s)',
    { timeout: 20_000 },
    async (streamingOutput) => {
      for (const closed of [false, true]) {
        const f = await fixture({
          running: true,
          artifacts: closed,
          streamingOutput,
        });
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
          const transcript = f.page.locator('[data-chat-scroll]');
          await transcript.getByRole('heading', { name: /COIN/ }).waitFor();
          expect(await transcript.getByRole('table').isVisible()).toBe(true);
          expect(
            await transcript
              .getByText('多步研究结果与引用说明。'.repeat(100), {
                exact: true,
              })
              .isVisible(),
          ).toBe(true);
          expect(
            await transcript.getByText('展开完整回复', { exact: true }).count(),
          ).toBe(0);
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

  it.each([false, true])(
    'shows a real report in a persistent third column, leaves composer focus alone and keeps the full historical answer visible (streaming=%s)',
    async (streamingOutput) => {
      const f = await fixture({ artifacts: true, streamingOutput });
      try {
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(await f.panel.getByRole('table').count()).toBe(1);
        expect(
          await f.page.getByText('展开完整回复', { exact: true }).count(),
        ).toBe(0);
        const transcript = f.page.locator('[data-chat-scroll]');
        expect(
          await transcript.getByRole('heading', { name: /COIN/ }).isVisible(),
        ).toBe(true);
        expect(await transcript.getByRole('table').isVisible()).toBe(true);
        expect(
          await transcript
            .getByText('多步研究结果与引用说明。'.repeat(100), { exact: true })
            .isVisible(),
        ).toBe(true);
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
        expect(
          await composer.evaluate((e) => e === document.activeElement),
        ).toBe(true);
        expect(await composer.inputValue()).toBe('继续核对来源');
      } finally {
        await f.close();
      }
    },
  );

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
      await f.panel
        .getByRole('button', { name: '侧栏预览 report-11.md', exact: true })
        .click();
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

  it('does not poll immutable or hidden document tabs and retries genuine load errors', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      f.state.items.push(artifact(11));
      await f.reloadList();
      await f.selectArtifact(11);
      await f.panel
        .locator(`[data-document-id="${id(11)}"]`)
        .getByRole('heading', { name: /COIN/ })
        .waitFor();
      const before = { ...f.state.detailReads };
      // Longer than the previous five-second timer; both visible and hidden reads stay quiet.
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(f.state.detailReads).toEqual(before);
      f.state.detailStatus = 503;
      await f.fileAction('刷新文件');
      await f.panel
        .getByRole('button', { name: '重试加载文件', exact: true })
        .waitFor();
      f.state.detailStatus = 200;
      await f.panel
        .getByRole('button', { name: '重试加载文件', exact: true })
        .click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getByRole('alert').count()).toBe(0);
      f.state.detailStatus = 403;
      await f.fileAction('刷新文件');
      await f.panel.getByRole('alert').waitFor();
      expect(await f.panel.getByRole('heading', { name: /COIN/ }).count()).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  }, 30_000);

  it('clears recovered review refresh errors without removing the loaded preview', async () => {
    const f = await fixture({ artifacts: true });
    try {
      f.state.items[0]!.kind = 'plan';
      await f.page.reload();
      await f.entry.click();
      const heading = f.panel.getByRole('heading', { name: /COIN/ });
      await heading.waitFor();
      f.state.detailStatus = 503;
      await f.panel.getByRole('alert').waitFor({ timeout: 10000 });
      expect(await heading.isVisible()).toBe(true);
      f.state.detailStatus = 200;
      await expect
        .poll(() => f.panel.getByRole('alert').count(), { timeout: 10000 })
        .toBe(0);
      expect(await heading.isVisible()).toBe(true);
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
      // A catalog refresh failure is not a failure of the loaded document.
      await f.fileAction('查看所有成果');
      await f.panel.getByRole('alert').waitFor();
      await f.panel
        .getByRole('button', { name: '侧栏预览 report-10.md', exact: true })
        .click();
      expect(await f.panel.getByRole('alert').count()).toBe(0);
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

  for (const width of [1440, 390])
    it(`selects, removes and sends authorized session references at ${width}px`, async () => {
      const f = await fixture({ width });
      try {
        const sources = [
          session(A),
          { ...session(B), title: '历史财报' },
          { ...session(id(801)), title: '市场研究' },
          { ...session(id(802)), title: '上次汇报' },
          { ...session(id(803)), title: '竞争对手' },
        ];
        await f.page.route('**/api/v1/sessions?**', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ sessions: sources, nextCursor: null }),
          }),
        );
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page.getByRole('menuitem', { name: '引用会话' }).click();
        const picker = f.page.getByRole('dialog', { name: '引用会话' });
        await picker.getByRole('button', { name: /历史财报/ }).click();
        await picker.getByRole('button', { name: /市场研究/ }).click();
        await picker.getByRole('button', { name: /上次汇报/ }).click();
        expect(
          await picker.getByRole('button', { name: /竞争对手/ }).isDisabled(),
        ).toBe(true);
        expect(
          await picker.getByRole('button', { name: /研究任务 A/ }).count(),
        ).toBe(0);
        if (process.env.ALLRICE_SESSION_REFERENCE_SCREENSHOT) {
          await f.page.screenshot({
            path: `${process.env.ALLRICE_SESSION_REFERENCE_SCREENSHOT}-${width}.png`,
          });
        }
        await picker.getByRole('button', { name: '完成', exact: true }).click();
        await f.page
          .getByRole('button', { name: '移除引用：市场研究' })
          .click();
        await f.page
          .getByRole('button', { name: '移除引用：上次汇报' })
          .click();
        const input = f.page.getByRole('textbox', { name: /给 .* 的消息/ });
        await input.fill('请根据引用整理汇报');
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(1);
        expect(f.state.messageInputs[0]).toMatchObject({
          text: '请根据引用整理汇报',
          sessionReferenceIds: [B],
          deliveryMode: 'follow_up',
        });
        await expect
          .poll(() =>
            f.page.getByRole('button', { name: '移除引用：历史财报' }).count(),
          )
          .toBe(0);
        expect(f.errors).toEqual([]);
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

  it('rejects late cross-session responses, isolates unsafe Markdown and reads native text pages', async () => {
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
      let imageRequested = false;
      await f.page.route('https://example.com/tracker.png', async (route) => {
        imageRequested = true;
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            'base64',
          ),
        });
      });
      f.state.text =
        '# Safe report\n<script>window.BAD = true</script>\n\n![tracking](https://example.com/tracker.png)\n\n[bad](javascript:alert(1))';
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .click();
      await f.panel.getByRole('heading', { name: 'Safe report' }).waitFor();
      expect(
        await f.panel.locator('iframe,script,a[href^="javascript:"]').count(),
      ).toBe(0);
      expect(
        await f.page.evaluate(() => Reflect.get(window, 'BAD')),
      ).toBeUndefined();
      await expect.poll(() => imageRequested).toBe(true);
      await expect
        .poll(() =>
          f.panel
            .locator('img[src="https://example.com/tracker.png"]')
            .evaluateAll((images) =>
              images.some(
                (image) => (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      f.state.text = Array.from(
        { length: 6001 },
        (_, i) => `较长的安全原文 ${i}`,
      ).join('\n');
      f.state.textPageLines = 5000;
      f.state.items.unshift(artifact(12));
      await f.reloadList();
      const body = f.panel.getByRole('region', {
        name: '文件正文',
        exact: true,
      });
      await body.waitFor();
      const firstLength = (await body.innerText()).length;
      expect(firstLength).toBeLessThan(f.state.text.length);
      await f.panel.getByRole('button', { name: '加载更多内容' }).click();
      await expect
        .poll(() => body.innerText(), { timeout: 10_000 })
        .toContain('较长的安全原文 6000');
      expect(
        await f.panel.getByRole('button', { name: '加载更多内容' }).count(),
      ).toBe(0);
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
  it('archives with native Undo and restores an archived read-only transcript', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const archiveEntry = f.page.getByRole('button', {
        name: '查看归档',
        exact: true,
      });
      const newWork = f.page.getByRole('button', {
        name: '新的工作',
        exact: true,
      });
      const archiveBox = await archiveEntry.boundingBox();
      const newWorkBox = await newWork.boundingBox();
      expect(archiveBox!.x).toBeGreaterThan(newWorkBox!.x);
      expect(Math.abs(archiveBox!.y - newWorkBox!.y)).toBeLessThan(1);
      expect(await f.page.getByLabel('工作记录筛选').count()).toBe(0);
      expect(
        await f.page.getByRole('button', { name: '返回当前工作' }).count(),
      ).toBe(0);
      if (process.env.ALLRICE_ARCHIVE_SCREENSHOTS === '1')
        await f.page.screenshot({ path: '.local/archive-entry-desktop.png' });
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      await row.hover();
      await row.getByRole('button', { name: '归档会话', exact: true }).click();
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(await row.count()).toBe(0);
      expect(
        await f.page
          .getByRole('heading', { name: 'COIN / MSTR / CRCL · 合成研究报告' })
          .count(),
      ).toBeGreaterThan(0);
      await f.page.getByRole('button', { name: '撤销', exact: true }).click();
      await row.waitFor();
      expect(
        await f.page.getByRole('button', { name: '恢复并继续' }).count(),
      ).toBe(0);
      await row.hover();
      await row.getByRole('button', { name: '归档会话', exact: true }).click();
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      await f.entry.click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('href'),
      ).toContain(artifact(10).object.id);
      await archiveEntry.click();
      await row.waitFor();
      expect(await archiveEntry.getAttribute('aria-pressed')).toBe('true');
      await f.page.getByRole('button', { name: '返回当前工作' }).click();
      await row.waitFor({ state: 'detached' });
      expect(await archiveEntry.getAttribute('aria-pressed')).toBe('false');
      await archiveEntry.click();
      await row.waitFor();
      if (process.env.ALLRICE_ARCHIVE_SCREENSHOTS === '1')
        await f.page.screenshot({ path: '.local/archive-desktop.png' });
      await f.page.reload();
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      await f.page.getByRole('button', { name: '恢复并继续' }).click();
      await row.waitFor();
      expect(f.state.archiveRequests.map((r) => r.archived)).toEqual([
        true,
        false,
        true,
        false,
      ]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  it('uses the native stop-and-archive confirmation, cancel leaves the work running', async () => {
    const f = await fixture({ archiveActive: true });
    try {
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      await row.hover();
      await row.getByRole('button', { name: '归档会话', exact: true }).click();
      const dialog = f.page.getByRole('dialog');
      await dialog.getByText('正在分析报表', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      expect(f.state.archivedIds.size).toBe(0);
      await row.hover();
      await row.getByRole('button', { name: '归档会话', exact: true }).click();
      await dialog
        .getByRole('button', { name: '停止并归档', exact: true })
        .click();
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      expect(f.state.archiveRequests.at(-1)).toEqual({
        archived: true,
        stopActivity: true,
      });
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  it.each([0, 3, 5, 7])(
    'automatically shows up to five employee sessions before offering the rest (%i total)',
    async (total) => {
      const f = await fixture({
        employeeCount: 2,
        employeeHistory: true,
        employeeHistoryCount: 35,
        officeHistoryCount: total,
        running: true,
      });
      try {
        const sidebar = f.page.locator('#chat-sidebar');
        const rice = sidebar.getByRole('region', { name: 'Rice', exact: true });
        const riceRows = rice.locator('[data-row-key^="session:"]');
        await expect.poll(() => riceRows.count()).toBe(5);
        expect(
          await rice.locator(`[data-row-key="session:${id(600)}"]`).count(),
        ).toBe(1);
        f.state.historyRunning = false;
        await f.page.reload();
        await expect.poll(() => riceRows.count()).toBe(5);
        const office = sidebar.getByRole('region', {
          name: 'Office 文档助手',
          exact: true,
        });
        // A first-page failure remains local and must not turn into auto-retry.
        if (total === 7) f.state.sessionPageError = true;
        await office.getByRole('treeitem').first().click();
        if (total === 7) {
          await office.getByRole('alert').waitFor();
          expect(
            f.state.sessionPageRequests.filter((id_) => id_ === id(17)),
          ).toHaveLength(1);
          f.state.sessionPageError = false;
          await office
            .getByRole('button', { name: '加载失败，点击重试' })
            .click();
        }
        const rows = office.locator('[data-row-key^="session:"]');
        await expect.poll(() => rows.count()).toBe(Math.min(5, total));
        if (total > 0)
          await expect
            .poll(() => f.state.sessionPageRequests.includes(id(17)))
            .toBe(true);
        if (total > 5) {
          await office
            .getByRole('button', { name: '展开其余 2 个会话', exact: true })
            .click();
          await expect.poll(() => rows.count()).toBe(7);
          await office
            .getByRole('button', { name: '收起更多会话', exact: true })
            .click();
          await expect.poll(() => rows.count()).toBe(5);
        } else {
          expect(
            await office
              .getByRole('button', { name: /展开其余|展开更多/ })
              .count(),
          ).toBe(0);
        }
      } finally {
        await f.close();
      }
    },
  );

  it('expands older work within its employee, retries locally, and ignores a late page after switching to archives', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeHistoryCount: 65,
    });
    let release!: () => void;
    try {
      const sidebar = f.page.locator('#chat-sidebar');
      const rice = sidebar.getByRole('region', { name: 'Rice', exact: true });
      await rice.getByText('65 个工作', { exact: true }).waitFor();
      expect(
        await sidebar.getByRole('button', { name: '加载更早的工作' }).count(),
      ).toBe(0);
      expect(
        await sidebar.getByText('旧员工（已撤回）', { exact: true }).count(),
      ).toBe(1);
      f.state.sessionPageError = true;
      await rice.getByRole('button', { name: /展开其余/ }).click();
      await rice.getByRole('alert').waitFor();
      expect(
        await rice.getByText('历史工作 1', { exact: true }).isVisible(),
      ).toBe(true);
      f.state.sessionPageError = false;
      await rice.getByRole('button', { name: '加载失败，点击重试' }).click();
      await rice.getByText('历史工作 60', { exact: true }).waitFor();
      await rice.getByRole('button', { name: /展开其余/ }).click();
      await rice.getByText('历史工作 65', { exact: true }).waitFor();
      expect(await rice.getByRole('button', { name: /展开其余/ }).count()).toBe(
        0,
      );
      expect(f.state.sessionPageRequests).toEqual([id(7), id(7), id(7)]);
      const office = sidebar.getByRole('region', {
        name: 'Office 文档助手',
        exact: true,
      });
      f.state.sessionPageDelay = new Promise<void>((done) => {
        release = done;
      });
      await office.getByRole('treeitem').first().click();
      await expect.poll(() => f.state.sessionPageRequests.at(-1)).toBe(id(17));
      await sidebar
        .getByRole('button', { name: '查看归档', exact: true })
        .click();
      await expect
        .poll(() => sidebar.getByText('65 个工作', { exact: true }).count())
        .toBe(0);
      release();
      f.state.sessionPageDelay = null;
      await f.page.waitForTimeout(100);
      expect(
        await sidebar.getByRole('treeitem', { name: /研究任务 B/ }).count(),
      ).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it('keeps loaded employee rows visible through background refresh, failure and archive changes', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeHistoryCount: 35,
      officeHistoryCount: 7,
    });
    let release!: () => void;
    try {
      const sidebar = f.page.locator('#chat-sidebar');
      const office = sidebar.getByRole('region', {
        name: 'Office 文档助手',
        exact: true,
      });
      await office.getByRole('treeitem').first().click();
      const rows = office.locator('[data-row-key^="session:"]');
      await expect.poll(() => rows.count()).toBe(5);
      await office.getByRole('button', { name: '展开其余 2 个会话' }).click();
      await expect.poll(() => rows.count()).toBe(7);
      for (let i = 0; i < 3; i++) {
        f.state.sessionPageDelay = new Promise<void>((done) => {
          release = done;
        });
        const requests = f.state.sessionPageRequests.length;
        await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
          .poll(() => f.state.sessionPageRequests.length)
          .toBeGreaterThan(requests);
        // The global first page contains only Rice. Office must stay mounted
        // while its slower background request is still pending.
        expect(await rows.count()).toBe(7);
        expect(
          await office.getByText('正在加载会话…', { exact: true }).count(),
        ).toBe(0);
        release();
        f.state.sessionPageDelay = null;
        await f.page.waitForTimeout(100);
        expect(await rows.count()).toBe(7);
      }
      f.state.sessionPageError = true;
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sidebar.getByRole('alert').waitFor();
      expect(await rows.count()).toBe(7);
      f.state.sessionPageError = false;
      // Simulate an archive made in another tab. A stable list must still
      // replace stale data and clear it when the employee has no active work.
      f.state.archivedIds.add(B);
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => rows.count()).toBe(6);
      for (let n = 1; n < 7; n++) f.state.archivedIds.add(id(7000 + n));
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => rows.count()).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it.each([1440, 390, 320])(
    'keeps a readable retry notice and cached sessions through failed and successful list refreshes at %ipx',
    async (width) => {
      const f = await fixture({ width, touch: width < 760 });
      let release: (() => void) | undefined;
      try {
        if (width < 760)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const sidebar = f.page.locator('#chat-sidebar');
        const rows = sidebar.locator('[data-row-key^="session:"]');
        await expect.poll(() => rows.count()).toBeGreaterThan(0);
        const ids = await rows.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-row-key')),
        );
        f.state.sessionListError = true;
        await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const notice = sidebar.getByRole('alert', { name: '会话列表状态' });
        await notice.getByText('会话暂未更新', { exact: true }).waitFor();
        expect(await sidebar.getByText('Unknown synthetic route').count()).toBe(
          0,
        );
        expect(await notice.getByText('已保留最近会话').isVisible()).toBe(true);
        const box = await notice.boundingBox();
        const sidebarBox = await sidebar.locator('> div').last().boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(sidebarBox!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          sidebarBox!.x + sidebarBox!.width,
        );
        for (const succeeds of [false, true]) {
          f.state.sessionListError = !succeeds;
          f.state.sessionListDelay = new Promise<void>((done) => {
            release = done;
          });
          const before = await rows.first().boundingBox();
          const requests = f.state.sessionListRequests;
          const retry = notice.getByRole('button', {
            name: '重新加载会话列表',
          });
          if (width < 760)
            expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(
              44,
            );
          await retry.focus();
          await f.page.keyboard.press('Enter');
          await expect
            .poll(() => f.state.sessionListRequests)
            .toBe(requests + 1);
          await notice.getByText('正在更新会话…', { exact: true }).waitFor();
          expect(await retry.isDisabled()).toBe(true);
          expect(
            Math.abs((await rows.first().boundingBox())!.y - before!.y),
          ).toBeLessThan(1);
          expect(
            await rows.evaluateAll((items) =>
              items.map((item) => item.getAttribute('data-row-key')),
            ),
          ).toEqual(ids);
          release!();
          f.state.sessionListDelay = null;
          if (succeeds) await notice.waitFor({ state: 'detached' });
          else {
            await notice.getByText('会话暂未更新', { exact: true }).waitFor();
            expect(await retry.isEnabled()).toBe(true);
          }
        }
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        release?.();
        await f.close();
      }
    },
    30_000,
  );

  it('finds archives beyond the first page and keeps a failed archive visible', async () => {
    const f = await fixture({ archiveCount: 35 });
    try {
      f.state.archiveError = true;
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      await row.hover();
      await row.getByRole('button', { name: '归档会话', exact: true }).click();
      await f.page
        .getByRole('alert')
        .filter({ hasText: '测试：归档暂时失败' })
        .waitFor();
      expect(await row.count()).toBe(1);
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .click();
      const more = f.page.getByRole('button', {
        name: /展开其余.*个会话/,
      });
      // The archive request completes after the filter click; wait for its
      // pagination control instead of skipping expansion during loading.
      await more.first().waitFor();
      await more.first().click();
      await f.page.getByText('归档工作 35', { exact: true }).waitFor();
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  it('exposes native archive actions on touch screens without hover', async () => {
    const f = await fixture({ width: 390, touch: true });
    try {
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      const menu = row.getByRole('button', { name: /会话.*的操作/ });
      await menu.click();
      await f.page
        .getByRole('menuitem', { name: '归档会话', exact: true })
        .click();
      await expect.poll(() => f.state.archivedIds.has(A)).toBe(true);
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .click();
      await row.waitFor();
      if (process.env.ALLRICE_ARCHIVE_SCREENSHOTS === '1')
        await f.page.screenshot({ path: '.local/archive-mobile.png' });
      await row.getByRole('button', { name: '取消归档', exact: true }).click();
      await expect.poll(() => f.state.archivedIds.has(A)).toBe(false);
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
});
