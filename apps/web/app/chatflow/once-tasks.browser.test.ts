/** Real Chrome + React StrictMode, synthetic HTTP only. No DB, auth, Dev or model. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OnceTask } from '@allrice/contracts';
import {
  OnceTaskListQuerySchema,
  OnceTaskListSchema,
  OnceTaskSchema,
} from '@allrice/contracts';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const api = vi.hoisted(() => ({
  context: { marker: 'authenticated-principal' },
  list: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  listOnceTasks: api.list,
  createOnceTask: vi.fn(),
  DataAccessError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  NativeOnceProductError: class extends Error {},
}));
vi.mock('../../lib/identity/session', () => ({ getRequestContext: api.auth }));
vi.mock('../../lib/storage/responses', () => ({
  storageErrorResponse: (error: unknown) =>
    Response.json(
      {},
      {
        status:
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'authentication_required'
            ? 401
            : 400,
      },
    ),
}));
import { GET } from '../api/v1/sessions/[id]/once-tasks/route';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dependencyRoot = process.env.ALLRICE_UI_DEPENDENCY_ROOT || root;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const T = '55555555-5555-4555-8555-555555555555';
const R = '77777777-7777-4777-8777-777777777777';
const RUN = '88888888-8888-4888-8888-888888888888';
const E = '99999999-9999-4999-8999-999999999999';

function task(overrides: Partial<OnceTask> = {}): OnceTask {
  return {
    id: T,
    clientRequestId: R,
    name: '另一对话的任务',
    prompt: '另一对话的任务',
    sessionId: B,
    runAt: '2099-06-10T01:00:00.000Z',
    timezone: 'Asia/Shanghai',
    status: 'pending',
    runId: null,
    errorMessage: null,
    createdAt: '2026-10-20T01:00:00.000Z',
    canCancel: true,
    ...overrides,
  };
}

describe('once task DTO and GET query boundaries', () => {
  it('requires the persisted request identity and pagination outcome', () => {
    expect(
      OnceTaskSchema.safeParse({ ...task(), clientRequestId: undefined })
        .success,
    ).toBe(false);
    expect(
      OnceTaskListSchema.safeParse({ tasks: [task()], enabled: true }).success,
    ).toBe(false);
    expect(
      OnceTaskListSchema.parse({
        tasks: [task()],
        enabled: true,
        nextCursor: null,
      }).tasks,
    ).toHaveLength(1);
  });
  it('keeps each list page bounded to fifty rows', () => {
    expect(
      OnceTaskListSchema.safeParse({
        tasks: Array.from({ length: 51 }, () => task()),
        enabled: true,
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      OnceTaskListSchema.safeParse({
        tasks: Array.from({ length: 50 }, () => task()),
        enabled: true,
        nextCursor: 'opaque-next',
      }).success,
    ).toBe(true);
  });
  it('allows an opaque cursor without decoding or changing its bytes', () => {
    const cursor = 'backend:+/cursor=?&value';
    expect(OnceTaskListQuerySchema.parse({ cursor })).toEqual({ cursor });
    expect(OnceTaskListQuerySchema.parse({ clientRequestId: R })).toEqual({
      clientRequestId: R,
    });
  });
  it.each([
    { clientRequestId: R, cursor: 'opaque-next' },
    { clientRequestId: 'not-a-uuid' },
    { cursor: '' },
    { ownerId: A },
  ])('rejects an invalid or mixed GET query %j', (query) => {
    expect(OnceTaskListQuerySchema.safeParse(query).success).toBe(false);
  });
  it('retains two identical tasks with independent request and task identities', () => {
    const first = task();
    const second = task({ id: A, clientRequestId: B });
    expect(
      OnceTaskListSchema.parse({
        tasks: [first, second],
        enabled: true,
        nextCursor: null,
      }).tasks,
    ).toHaveLength(2);
  });
});

describe('once task GET query wiring with an isolated data layer', () => {
  it.each([
    ['', {}],
    ['?clientRequestId=' + R, { clientRequestId: R }],
    [
      '?cursor=' + encodeURIComponent('opaque:+/cursor?=&'),
      { cursor: 'opaque:+/cursor?=&' },
    ],
  ])(
    'passes the authenticated principal and unmodified query for %s',
    async (search, query) => {
      api.auth.mockResolvedValue(api.context);
      api.list
        .mockReset()
        .mockResolvedValue({ tasks: [], enabled: true, nextCursor: null });
      const response = await GET(
        new Request(
          'http://fixture/api/v1/sessions/' + A + '/once-tasks' + search,
        ),
        { params: Promise.resolve({ id: A }) },
      );
      expect(response.status).toBe(200);
      expect(api.list).toHaveBeenCalledExactlyOnceWith(api.context, A, query);
      expect(await response.json()).toEqual({
        tasks: [],
        enabled: true,
        nextCursor: null,
      });
    },
  );
  it.each([
    '?clientRequestId=' + R + '&cursor=opaque-next',
    '?clientRequestId=' + R + '&clientRequestId=' + R,
    '?cursor=a&cursor=b',
    '?ownerId=' + D,
    '?cursor=',
  ])(
    'rejects ambiguous or unsupported query before the data layer: %s',
    async (search) => {
      api.auth.mockResolvedValue(api.context);
      api.list.mockReset();
      const response = await GET(
        new Request(
          'http://fixture/api/v1/sessions/' + A + '/once-tasks' + search,
        ),
        { params: Promise.resolve({ id: A }) },
      );
      expect(response.status).toBe(400);
      expect(api.list).not.toHaveBeenCalled();
    },
  );
  it('requires authentication before reading tasks', async () => {
    api.auth.mockResolvedValue(null);
    api.list.mockReset();
    const response = await GET(
      new Request('http://fixture/api/v1/sessions/' + A + '/once-tasks'),
      { params: Promise.resolve({ id: A }) },
    );
    expect(response.status).toBe(401);
    expect(api.list).not.toHaveBeenCalled();
  });
});

type State = {
  tasks: Record<string, OnceTask[]>;
  requests: {
    method: string;
    sessionId: string;
    body: string;
    workspace: string;
    clientRequestId: string | null;
    cursor: string | null;
  }[];
  enabled: boolean;
  dropCreate: boolean;
  deferRead: boolean;
  deferCreate: boolean;
  deferExact: boolean;
  exactStatus: number | null;
  hideExact: boolean;
  mismatchExact: 'name' | 'prompt' | 'runAt' | 'timezone' | 'sessionId' | null;
  dropCancel: boolean;
  denyRead: boolean;
  pending: { response: ServerResponse; value: unknown }[];
  created: Map<string, OnceTask>;
};

suite('once task header: scoped UI with synthetic HTTP', () => {
  let browser: Browser;
  let javascript: Uint8Array;
  let stylesheet: Uint8Array;

  beforeAll(async () => {
    const require = createRequire(resolve(dependencyRoot, 'package.json'));
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      stdin: {
        contents: `
          import React, {StrictMode, useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {OnceTasks} from './app/chatflow/once-tasks';
          function Fixture() {
            const [view,setView]=useState({sessionId:'${A}',scope:'org-a/workspace-a/owner-a/ai-a',workspace:'workspace-a'});
            const [opened,setOpened]=useState('');
            return <>
              <button onClick={()=>setView({sessionId:'${A}',scope:'org-a/workspace-a/owner-a/ai-a',workspace:'workspace-a'})}>返回原对话</button>
              <button onClick={()=>setView({sessionId:'${B}',scope:'org-a/workspace-a/owner-a/ai-a',workspace:'workspace-a'})}>切换对话</button>
              <button onClick={()=>setView({sessionId:'${C}',scope:'org-a/workspace-a/owner-a/ai-b',workspace:'workspace-a'})}>切换AI</button>
              <button onClick={()=>setView({sessionId:'${D}',scope:'org-a/workspace-a/owner-b/ai-a',workspace:'workspace-a'})}>切换账号</button>
              <button onClick={()=>setView({sessionId:'${E}',scope:'org-a/workspace-b/owner-a/ai-a',workspace:'workspace-b'})}>切换工作区</button>
              <button onClick={()=>setView({...view,sessionId:null})}>空白对话</button>
              <OnceTasks {...view} headers={{'x-allrice-organization-id':'org-a','x-allrice-workspace-id':view.workspace,'x-test-header':'not-persisted'}} onOpenSession={setOpened}/>
              <output aria-label="已打开会话">{opened}</output>
            </>;
          }
          createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
        `,
        loader: 'tsx',
        resolveDir: resolve(root, 'apps/web'),
      },
      nodePaths: [
        resolve(dependencyRoot, 'apps/web/node_modules'),
        resolve(dependencyRoot, 'node_modules'),
      ],
      // Use the actual new schemas, without building the contracts package.
      alias: {
        '@allrice/contracts': resolve(
          root,
          'packages/contracts/src/native-schedule.ts',
        ),
      },
      bundle: true,
      write: false,
      outdir: '/unused-once-tasks',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    javascript = result.outputFiles.find((file: { path: string }) =>
      file.path.endsWith('.js'),
    ).contents;
    stylesheet = result.outputFiles.find((file: { path: string }) =>
      file.path.endsWith('.css'),
    ).contents;
    const { chromium } = createRequire(
      resolve(dependencyRoot, 'apps/worker/package.json'),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function fixture() {
    const state: State = {
      tasks: { [A]: [task()], [C]: [], [D]: [], [E]: [] },
      requests: [],
      enabled: true,
      dropCreate: false,
      deferRead: false,
      deferCreate: false,
      deferExact: false,
      exactStatus: null,
      hideExact: false,
      mismatchExact: null,
      dropCancel: false,
      denyRead: false,
      pending: [],
      created: new Map(),
    };
    const send = (response: ServerResponse, value: unknown) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(value));
    };
    const interrupt = (response: ServerResponse) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.flushHeaders();
      response.write('{"task":');
      setTimeout(() => response.destroy(), 20);
    };
    const server: Server = createServer((request, response) => {
      void (async () => {
        const requestUrl = new URL(request.url!, 'http://fixture');
        const path = requestUrl.pathname;
        if (path === '/') {
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(
            '<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
          );
          return;
        }
        if (path === '/app.js' || path === '/app.css') {
          response.setHeader(
            'content-type',
            path.endsWith('.js') ? 'text/javascript' : 'text/css',
          );
          response.end(path.endsWith('.js') ? javascript : stylesheet);
          return;
        }
        const match =
          /^\/api\/v1\/sessions\/([^/]+)\/once-tasks(?:\/([^/]+)\/cancel)?$/.exec(
            path,
          );
        if (!match) {
          response.writeHead(404).end();
          return;
        }
        const sessionId = match[1]!;
        const lane = sessionId === B ? A : sessionId;
        const requestId = requestUrl.searchParams.get('clientRequestId');
        const cursor = requestUrl.searchParams.get('cursor');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        state.requests.push({
          method: request.method!,
          sessionId,
          body,
          workspace: String(request.headers['x-allrice-workspace-id'] || ''),
          clientRequestId: requestId,
          cursor,
        });
        if (request.method === 'GET') {
          if (requestId && cursor) {
            response.writeHead(400).end();
            return;
          }
          if (requestId && state.exactStatus !== null) {
            response.writeHead(state.exactStatus).end();
            return;
          }
          if (state.denyRead) {
            response.writeHead(403).end();
            return;
          }
          const all = [...(state.tasks[lane] || [])].sort(
            (a, b) =>
              Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
              b.id.localeCompare(a.id),
          );
          if (requestId) {
            const exact = state.hideExact
              ? []
              : all.filter((item) => item.clientRequestId === requestId);
            const wrong = exact.map((item) => {
              const field = state.mismatchExact;
              if (!field) return item;
              const value =
                field === 'runAt'
                  ? new Date(Date.parse(item.runAt) + 60_000).toISOString()
                  : field === 'timezone'
                    ? item.timezone === 'UTC'
                      ? 'Asia/Shanghai'
                      : 'UTC'
                    : field === 'sessionId'
                      ? C
                      : item[field] + ' changed';
              return { ...item, [field]: value };
            });
            const value = {
              tasks: wrong,
              enabled: state.enabled,
              nextCursor: null,
            };
            if (state.deferExact) state.pending.push({ response, value });
            else send(response, value);
            return;
          }
          if (cursor !== null && !/^opaque-[0-9]+$/.test(cursor)) {
            response.writeHead(400).end();
            return;
          }
          const offset =
            cursor === null ? 0 : Number(cursor.slice('opaque-'.length));
          const value = {
            tasks: all.slice(offset, offset + 50),
            enabled: state.enabled,
            nextCursor:
              offset + 50 < all.length ? 'opaque-' + (offset + 50) : null,
          };
          if (state.deferRead) {
            state.pending.push({ response, value });
            return;
          }
          send(response, value);
          return;
        }
        if (match[2]) {
          const found = state.tasks[lane]?.find((item) => item.id === match[2]);
          if (!found) {
            response.writeHead(404).end();
            return;
          }
          if (found.runId || !found.canCancel) {
            send(response, { task: found });
            return;
          }
          const canceled = {
            ...found,
            status: 'canceled' as const,
            canCancel: false,
          };
          state.tasks[lane] = state.tasks[lane]!.map((item) =>
            item.id === found.id ? canceled : item,
          );
          if (state.dropCancel) {
            state.dropCancel = false;
            interrupt(response);
          } else send(response, { task: canceled });
          return;
        }
        const input = JSON.parse(body);
        let created = state.created.get(input.clientRequestId);
        if (!created) {
          created = task({
            id: randomUUID(),
            clientRequestId: input.clientRequestId,
            name: input.name,
            prompt: input.prompt,
            sessionId,
            runAt: input.runAt,
            timezone: input.timezone,
            status: 'pending',
            runId: null,
            canCancel: true,
            createdAt: new Date().toISOString(),
          });
          state.created.set(input.clientRequestId, created);
          state.tasks[lane] = [...(state.tasks[lane] || []), created];
        }
        if (state.dropCreate) {
          state.dropCreate = false;
          // Commit succeeded but a partially received response cannot be read.
          // Sending headers first also prevents Chrome's transparent stale-
          // connection retry from turning this into a confirmed success.
          interrupt(response);
          return;
        }
        if (state.deferCreate) {
          state.pending.push({ response, value: { task: created } });
          return;
        }
        send(response, { task: created });
      })().catch(() => {
        response.writeHead(500).end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener');
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      timezoneId: 'Asia/Shanghai',
    });
    page.setDefaultTimeout(6_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const release = () => {
      for (const pending of state.pending.splice(0))
        send(pending.response, pending.value);
    };
    return {
      page,
      state,
      errors,
      release,
      async close() {
        release();
        await page.close();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      },
    };
  }

  async function open(page: Page) {
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await page.getByRole('dialog', { name: '定时任务' }).waitFor();
  }

  async function fill(
    page: Page,
    content = '明天整理这段纯文本',
    time = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 16),
  ) {
    await page.getByRole('button', { name: '新建任务' }).click();
    await page.getByLabel('任务内容', { exact: true }).fill(content);
    await page.getByLabel('执行时间', { exact: true }).fill(time);
  }

  const posts = (state: State) =>
    state.requests.filter((item) => item.method === 'POST');
  const exactReads = (state: State) =>
    state.requests.filter(
      (item) => item.method === 'GET' && item.clientRequestId !== null,
    );
  const saved = (page: Page) =>
    page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) =>
        key.startsWith('allrice:once-pending:'),
      ),
    );

  async function confirm(page: Page, kind: 'create' | 'cancel' = 'create') {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).searchParams.has('clientRequestId'),
    );
    await page
      .getByRole('button', {
        name: kind === 'create' ? '确认创建结果' : '确认取消结果',
        exact: true,
      })
      .click();
    await response;
    await expect
      .poll(() =>
        page.getByRole('button', { name: '正在确认…', exact: true }).count(),
      )
      .toBe(0);
  }

  it('creates in this chat, lists the same AI across chats, navigates and retains canceled tasks', async () => {
    const f = await fixture();
    try {
      f.state.tasks[A]!.push(
        task({
          id: RUN,
          clientRequestId: D,
          name: '已有运行的排队任务',
          prompt: '已有运行的排队任务',
          status: 'queued',
          runId: RUN,
          canCancel: false,
        }),
      );
      await open(f.page);
      await f.page.getByText('另一对话的任务', { exact: true }).waitFor();
      const queued = f.page
        .getByRole('listitem')
        .filter({ hasText: '已有运行的排队任务' });
      await queued.getByText('排队中', { exact: true }).waitFor();
      expect(
        await queued
          .getByRole('button', { name: '取消任务', exact: true })
          .count(),
      ).toBe(0);
      await fill(f.page);
      await f.page
        .getByRole('button', { name: '创建任务', exact: true })
        .click();
      await f.page.getByText('定时任务已创建。', { exact: true }).waitFor();
      const request = f.state.requests.find((item) => item.method === 'POST')!;
      expect(request.sessionId).toBe(A);
      expect(request.workspace).toBe('workspace-a');
      const body = JSON.parse(request.body);
      expect(Object.keys(body).sort()).toEqual([
        'clientRequestId',
        'name',
        'prompt',
        'runAt',
        'timezone',
      ]);
      expect(body.prompt).toBe('明天整理这段纯文本');
      expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
      const row = f.page
        .getByRole('listitem')
        .filter({ hasText: '明天整理这段纯文本' });
      await row.getByText('待执行', { exact: true }).waitFor();
      expect(await row.getByText('已完成', { exact: true }).count()).toBe(0);
      await row.getByRole('button', { name: '取消任务', exact: true }).click();
      await row.getByRole('button', { name: '确认取消', exact: true }).click();
      await row.getByText('已取消', { exact: true }).waitFor();
      expect(
        f.state.requests.filter((item) => item.method === 'POST').at(-1)?.body,
      ).toBe('');
      expect(await row.count()).toBe(1);
      expect(
        await row
          .getByRole('button', { name: '取消任务', exact: true })
          .count(),
      ).toBe(0);
      const other = f.page
        .getByRole('listitem')
        .filter({ hasText: '另一对话的任务' });
      await other
        .getByRole('button', { name: '查看原会话', exact: true })
        .click();
      expect(await f.page.getByLabel('已打开会话').textContent()).toBe(B);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('creates a second identical task with a fresh request identity after confirmation', async () => {
    const f = await fixture();
    try {
      await open(f.page);
      const time = new Date(Date.now() + 9 * 60 * 60_000)
        .toISOString()
        .slice(0, 16);
      for (let index = 0; index < 2; index++) {
        await fill(f.page, '相同内容可以再次正常创建', time);
        await f.page
          .getByRole('button', { name: '创建任务', exact: true })
          .click();
        await expect.poll(() => posts(f.state).length).toBe(index + 1);
        await expect
          .poll(() =>
            f.page
              .getByRole('button', { name: '新建任务', exact: true })
              .isEnabled(),
          )
          .toBe(true);
      }
      const [first, second] = posts(f.state).map((item) =>
        JSON.parse(item.body),
      );
      expect(first.clientRequestId).not.toBe(second.clientRequestId);
      expect({ ...first, clientRequestId: undefined }).toEqual({
        ...second,
        clientRequestId: undefined,
      });
      expect(f.state.created.size).toBe(2);
      await expect
        .poll(() =>
          f.page
            .getByRole('listitem')
            .filter({ hasText: '相同内容可以再次正常创建' })
            .count(),
        )
        .toBe(2);
      expect(await saved(f.page)).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('confirms an unknown create only by exact GET and retains it on denial, conflict, absence or mismatched fields', async () => {
    const f = await fixture();
    try {
      f.state.dropCreate = true;
      f.state.exactStatus = 403;
      await open(f.page);
      await fill(f.page, '请求中断也不能重复创建');
      await f.page
        .getByRole('button', { name: '创建任务', exact: true })
        .click();
      await f.page.getByText(/创建结果尚未确认/).waitFor();
      await expect.poll(() => exactReads(f.state).length).toBeGreaterThan(0);
      await f.page
        .getByRole('listitem')
        .filter({ hasText: '请求中断也不能重复创建' })
        .waitFor();
      expect(
        await f.page.getByText('定时任务已创建。', { exact: true }).count(),
      ).toBe(0);
      expect(
        await f.page.getByLabel('任务内容', { exact: true }).isDisabled(),
      ).toBe(true);
      await expect
        .poll(() =>
          f.page
            .getByRole('button', { name: '确认创建结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      const retained = await saved(f.page);
      expect(retained).toHaveLength(1);
      f.state.exactStatus = 409;
      await confirm(f.page);
      expect(await saved(f.page)).toEqual(retained);
      f.state.exactStatus = null;
      f.state.hideExact = true;
      await confirm(f.page);
      expect(await saved(f.page)).toEqual(retained);
      f.state.hideExact = false;
      for (const field of [
        'name',
        'prompt',
        'runAt',
        'timezone',
        'sessionId',
      ] as const) {
        f.state.mismatchExact = field;
        await confirm(f.page);
        expect(await saved(f.page)).toEqual(retained);
      }
      f.state.mismatchExact = null;
      await confirm(f.page);
      await f.page
        .getByText('已确认定时任务已创建。', { exact: true })
        .waitFor();
      expect(posts(f.state)).toHaveLength(1);
      expect(f.state.created.size).toBe(1);
      expect(
        exactReads(f.state).every(
          (item) =>
            item.cursor === null &&
            item.clientRequestId ===
              JSON.parse(posts(f.state)[0]!.body).clientRequestId,
        ),
      ).toBe(true);
      expect(await saved(f.page)).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('restores the necessary request across reload and confirms a task beyond the newest fifty rows', async () => {
    const f = await fixture();
    try {
      f.state.dropCreate = true;
      f.state.exactStatus = 403;
      await open(f.page);
      await fill(f.page, '窗口外的原请求');
      await f.page
        .getByRole('button', { name: '创建任务', exact: true })
        .click();
      await f.page.getByText(/创建结果尚未确认/).waitFor();
      await expect.poll(() => exactReads(f.state).length).toBeGreaterThan(0);
      const entries = await saved(f.page);
      expect(entries).toHaveLength(1);
      const [key, raw] = entries[0]!;
      expect(JSON.parse(key.slice('allrice:once-pending:v1:'.length))).toEqual([
        'org-a',
        'workspace-a',
        'owner-a',
        'ai-a',
        A,
      ]);
      expect(JSON.parse(raw)).toEqual({
        version: 1,
        kind: 'create',
        body: JSON.parse(posts(f.state)[0]!.body),
      });
      expect(raw).not.toMatch(
        /not-persisted|headers|authorization|workspace-a/,
      );
      const created = [...f.state.created.values()][0]!;
      f.state.tasks[A] = [
        ...Array.from({ length: 100 }, (_, index) =>
          task({
            id: randomUUID(),
            clientRequestId: randomUUID(),
            name: '更近的任务 ' + index,
            prompt: '更近的任务 ' + index,
            createdAt: new Date(
              Date.parse(created.createdAt) + index + 1,
            ).toISOString(),
          }),
        ),
        created,
      ];
      await f.page.reload();
      await open(f.page);
      await f.page.getByText('已加载 50 项任务', { exact: true }).waitFor();
      expect(
        await f.page
          .getByRole('listitem')
          .filter({ hasText: '窗口外的原请求' })
          .count(),
      ).toBe(0);
      expect(
        await f.page.getByLabel('任务内容', { exact: true }).inputValue(),
      ).toBe('窗口外的原请求');
      expect(
        await f.page.getByLabel('任务内容', { exact: true }).isDisabled(),
      ).toBe(true);
      await expect
        .poll(() =>
          f.page
            .getByRole('button', { name: '确认创建结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      f.state.exactStatus = null;
      await confirm(f.page);
      await f.page
        .getByText('已确认定时任务已创建。', { exact: true })
        .waitFor();
      await f.page
        .getByRole('listitem')
        .filter({ hasText: '窗口外的原请求' })
        .waitFor();
      expect(posts(f.state)).toHaveLength(1);
      expect(await saved(f.page)).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('loads opaque cursor pages and keeps older pending and terminal tasks available', async () => {
    const f = await fixture();
    try {
      f.state.tasks[A] = Array.from({ length: 120 }, (_, index) =>
        task({
          id: randomUUID(),
          clientRequestId: randomUUID(),
          name: '历史任务 ' + String(index).padStart(3, '0'),
          prompt: '历史任务 ' + index,
          status: index === 110 ? 'pending' : 'succeeded',
          canCancel: index === 110,
          createdAt: new Date(
            Date.UTC(2026, 9, 20, 12) - index * 1000,
          ).toISOString(),
        }),
      );
      await open(f.page);
      await f.page.getByText('已加载 50 项任务', { exact: true }).waitFor();
      for (const count of [100, 120]) {
        await f.page
          .getByRole('button', { name: '加载更多', exact: true })
          .click();
        await f.page
          .getByText('已加载 ' + count + ' 项任务', { exact: true })
          .waitFor();
      }
      expect(
        f.state.requests
          .filter((item) => item.cursor !== null)
          .map((item) => item.cursor),
      ).toEqual(['opaque-50', 'opaque-100']);
      expect(
        await f.page
          .getByRole('button', { name: '加载更多', exact: true })
          .count(),
      ).toBe(0);
      const older = f.page
        .getByRole('listitem')
        .filter({ hasText: '历史任务 110' });
      await older
        .getByRole('button', { name: '取消任务', exact: true })
        .click();
      await older
        .getByRole('button', { name: '确认取消', exact: true })
        .click();
      await older.getByText('已取消', { exact: true }).waitFor();
      await f.page.getByText('已加载 120 项任务', { exact: true }).waitFor();
      await f.page
        .getByRole('listitem')
        .filter({ hasText: '历史任务 119' })
        .getByText('已完成', { exact: true })
        .waitFor();
      expect(posts(f.state)).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('keeps an unknown cancel until a decisive state is read and never repeats its POST', async () => {
    const f = await fixture();
    try {
      f.state.dropCancel = true;
      f.state.exactStatus = 403;
      await open(f.page);
      const row = f.page
        .getByRole('listitem')
        .filter({ hasText: '另一对话的任务' });
      await row.getByRole('button', { name: '取消任务', exact: true }).click();
      await row.getByRole('button', { name: '确认取消', exact: true }).click();
      await f.page.getByText(/取消结果尚未确认/).waitFor();
      await expect
        .poll(() =>
          f.page
            .getByRole('button', { name: '确认取消结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      expect(JSON.parse((await saved(f.page))[0]![1])).toEqual({
        version: 1,
        kind: 'cancel',
        taskId: T,
        clientRequestId: R,
      });
      f.state.exactStatus = null;
      // Readonly pending is not evidence that the cancel committed.
      f.state.tasks[A] = [task({ canCancel: false })];
      await confirm(f.page, 'cancel');
      expect(await saved(f.page)).toHaveLength(1);
      f.state.exactStatus = 409;
      await confirm(f.page, 'cancel');
      expect(await saved(f.page)).toHaveLength(1);
      await f.page.reload();
      await open(f.page);
      await expect
        .poll(() =>
          f.page
            .getByRole('button', { name: '确认取消结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      f.state.tasks[A] = [task({ status: 'canceled', canCancel: false })];
      f.state.exactStatus = null;
      await confirm(f.page, 'cancel');
      await f.page.getByText('任务已取消。', { exact: true }).waitFor();
      expect(posts(f.state)).toHaveLength(1);
      expect(await saved(f.page)).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('aborts and rejects late reads and writes across chat, AI, account and workspace changes', async () => {
    const f = await fixture();
    try {
      // Force transport to finish despite an abort, to exercise the epoch guard.
      await f.page.evaluate(() => {
        const original = window.fetch;
        Object.assign(window, { onceAborts: 0 });
        window.fetch = (input, init) => {
          init?.signal?.addEventListener('abort', () => {
            const state = window as unknown as { onceAborts: number };
            state.onceAborts++;
          });
          return original(input, { ...init, signal: undefined });
        };
      });
      f.state.deferRead = true;
      await open(f.page);
      await expect.poll(() => f.state.pending.length).toBe(1);
      await f.page.getByRole('button', { name: '切换AI', exact: true }).click();
      f.state.deferRead = false;
      f.release();
      await open(f.page);
      await f.page
        .getByText('暂无定时任务，也可以在聊天中让 AI 创建。', { exact: true })
        .waitFor();
      expect(
        await f.page.getByText('另一对话的任务', { exact: true }).count(),
      ).toBe(0);
      await fill(f.page, '旧对话迟到的创建');
      f.state.deferCreate = true;
      await f.page
        .getByRole('button', { name: '创建任务', exact: true })
        .click();
      await expect.poll(() => f.state.pending.length).toBe(1);
      await f.page
        .getByRole('button', { name: '切换账号', exact: true })
        .click();
      f.state.deferCreate = false;
      f.release();
      await open(f.page);
      await f.page
        .getByText('暂无定时任务，也可以在聊天中让 AI 创建。', { exact: true })
        .waitFor();
      expect(
        await f.page.getByText('旧对话迟到的创建', { exact: true }).count(),
      ).toBe(0);
      expect(
        await f.page.getByText('定时任务已创建。', { exact: true }).count(),
      ).toBe(0);
      await f.page
        .getByRole('button', { name: '切换工作区', exact: true })
        .click();
      await open(f.page);
      await f.page
        .getByText('暂无定时任务，也可以在聊天中让 AI 创建。', { exact: true })
        .waitFor();
      expect(f.state.requests.at(-1)?.workspace).toBe('workspace-b');
      expect(
        await f.page
          .getByRole('button', { name: '确认创建结果', exact: true })
          .count(),
      ).toBe(0);
      expect(await saved(f.page)).toHaveLength(1);
      await f.page
        .getByRole('button', { name: '切换对话', exact: true })
        .click();
      await open(f.page);
      await f.page.getByText('另一对话的任务', { exact: true }).waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '确认创建结果', exact: true })
          .count(),
      ).toBe(0);
      await f.page.getByRole('button', { name: '切换AI', exact: true }).click();
      await open(f.page);
      await f.page
        .getByText('已确认定时任务已创建。', { exact: true })
        .waitFor();
      await f.page
        .getByRole('listitem')
        .filter({ hasText: '旧对话迟到的创建' })
        .waitFor();
      expect(posts(f.state)).toHaveLength(1);
      expect(await saved(f.page)).toEqual([]);
      expect(
        await f.page.evaluate(
          () => (window as unknown as { onceAborts: number }).onceAborts,
        ),
      ).toBeGreaterThan(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('retains independent unresolved requests for two accounts in the same tenant', async () => {
    const f = await fixture();
    try {
      f.state.exactStatus = 403;
      for (const account of ['original', 'other']) {
        if (account === 'other')
          await f.page
            .getByRole('button', { name: '切换账号', exact: true })
            .click();
        f.state.dropCreate = true;
        await open(f.page);
        await fill(f.page, '各账号独立的待确认请求');
        await f.page
          .getByRole('button', { name: '创建任务', exact: true })
          .click();
        await f.page.getByText(/创建结果尚未确认/).waitFor();
        await expect
          .poll(() =>
            f.page
              .getByRole('button', { name: '确认创建结果', exact: true })
              .isEnabled(),
          )
          .toBe(true);
      }
      const entries = await saved(f.page);
      expect(entries).toHaveLength(2);
      expect(
        entries.map(([key]) =>
          JSON.parse(key.slice('allrice:once-pending:v1:'.length)),
        ),
      ).toEqual(
        expect.arrayContaining([
          ['org-a', 'workspace-a', 'owner-a', 'ai-a', A],
          ['org-a', 'workspace-a', 'owner-b', 'ai-a', D],
        ]),
      );
      f.state.exactStatus = null;
      await f.page
        .getByRole('button', { name: '返回原对话', exact: true })
        .click();
      await open(f.page);
      await f.page
        .getByText('已确认定时任务已创建。', { exact: true })
        .waitFor();
      const remaining = await saved(f.page);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]![0]).toContain('owner-b');
      expect(posts(f.state)).toHaveLength(2);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('pauses unknown-result reads while hidden and rejects an exact response arriving after it was aborted', async () => {
    const f = await fixture();
    try {
      await f.page.clock.install();
      await f.page.evaluate(() => {
        const original = window.fetch;
        window.fetch = (input, init) =>
          original(input, { ...init, signal: undefined });
      });
      f.state.dropCreate = true;
      f.state.deferExact = true;
      await open(f.page);
      await fill(f.page, '隐藏后的迟到确认');
      await f.page
        .getByRole('button', { name: '创建任务', exact: true })
        .click();
      // The interrupted transport uses a real server timer; let Chrome receive
      // the body failure without advancing the application's polling clock.
      await expect.poll(() => f.state.pending.length).toBe(1);
      await f.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      f.state.deferExact = false;
      f.release();
      await f.page.clock.fastForward(30_000);
      const hidden = f.state.requests.length;
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests).toHaveLength(hidden);
      expect(await saved(f.page)).toHaveLength(1);
      expect(
        await f.page
          .getByText('已确认定时任务已创建。', { exact: true })
          .count(),
      ).toBe(0);
      f.state.exactStatus = 403;
      await f.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => f.state.requests.length).toBeGreaterThan(hidden);
      await expect
        .poll(() =>
          f.page
            .getByRole('button', { name: '确认创建结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      f.state.exactStatus = null;
      await confirm(f.page);
      await f.page
        .getByText('已确认定时任务已创建。', { exact: true })
        .waitFor();
      expect(posts(f.state)).toHaveLength(1);
      expect(await saved(f.page)).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('does not POST when the request cannot be retained in sessionStorage', async () => {
    const f = await fixture();
    try {
      await open(f.page);
      await fill(f.page, '存储失败时不得发出请求');
      await f.page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException('Storage unavailable', 'QuotaExceededError');
        };
      });
      await f.page
        .getByRole('button', { name: '创建任务', exact: true })
        .click();
      await f.page
        .getByText('无法保存本次请求，尚未提交，请恢复会话存储后重试。', {
          exact: true,
        })
        .waitFor();
      expect(posts(f.state)).toHaveLength(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('polls only while expanded and visible, and keeps the mobile popover and Escape focus usable', async () => {
    const f = await fixture();
    try {
      await f.page.clock.install();
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests).toHaveLength(0);
      await open(f.page);
      await f.page.getByText('另一对话的任务', { exact: true }).waitFor();
      const beforePoll = f.state.requests.length;
      await Promise.all([
        f.page.waitForResponse((response) =>
          response.url().endsWith('/once-tasks'),
        ),
        f.page.clock.fastForward(10_000),
      ]);
      expect(f.state.requests.length).toBeGreaterThan(beforePoll);
      const box = await f.page
        .getByRole('dialog', { name: '定时任务' })
        .boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(15);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const hidden = f.state.requests.length;
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests.length).toBe(hidden);
      await f.page.keyboard.press('Escape');
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '定时任务', exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests.length).toBe(hidden);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('distinguishes unsupported, denied and failed states without exposing a completed result', async () => {
    const f = await fixture();
    try {
      f.state.enabled = false;
      f.state.tasks[A] = [
        task({ status: 'succeeded', runId: RUN, canCancel: false }),
      ];
      await open(f.page);
      await f.page
        .getByText('当前会话暂不支持定时任务。', { exact: true })
        .waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '新建任务', exact: true })
          .isDisabled(),
      ).toBe(true);
      await f.page.getByText('另一对话的任务', { exact: true }).waitFor();
      await f.page.getByText('已完成', { exact: true }).waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '查看原会话', exact: true })
          .count(),
      ).toBe(1);
      f.state.enabled = true;
      f.state.tasks[A] = [
        task({
          status: 'failed',
          canCancel: false,
          errorMessage: '执行时未能连接服务',
        }),
      ];
      await f.page
        .getByRole('button', { name: '重新读取', exact: true })
        .click();
      await f.page.getByText('执行失败', { exact: true }).waitFor();
      expect(await f.page.getByText('已完成', { exact: true }).count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '取消任务', exact: true })
          .count(),
      ).toBe(0);
      f.state.denyRead = true;
      await f.page
        .getByRole('button', { name: '重新读取', exact: true })
        .click();
      await f.page
        .getByText('暂时无法查看定时任务，请确认当前会话仍可使用。', {
          exact: true,
        })
        .waitFor();
      expect(
        await f.page.getByText('另一对话的任务', { exact: true }).count(),
      ).toBe(0);
      await f.page
        .getByRole('button', { name: '空白对话', exact: true })
        .click();
      const trigger = f.page.getByRole('button', {
        name: '定时任务',
        exact: true,
      });
      expect(await trigger.isDisabled()).toBe(true);
      expect(await trigger.getAttribute('title')).toContain('先开始当前对话');
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
