/** Actual clock header + React StrictMode + Chrome; synthetic HTTP only. */
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChangeRecurringTaskInputSchema,
  CreateRecurringTaskInputSchema,
  type CreateRecurringTaskInput,
  type RecurringOccurrence,
  type RecurringTask,
  type RecurringTaskOperation,
} from '@allrice/contracts';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dependencyRoot = process.env.ALLRICE_UI_DEPENDENCY_ROOT || root;
const ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const AI = '44444444-4444-4444-8444-444444444444';
const CHAT = '55555555-5555-4555-8555-555555555555';
const OTHER_VIEWER = '66666666-6666-4666-8666-666666666666';
const OTHER_AI = '77777777-7777-4777-8777-777777777777';
const OTHER_WORKSPACE = '88888888-8888-4888-8888-888888888888';
const OTHER_CHAT = '99999999-9999-4999-8999-999999999999';
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEXT = '2099-01-01T01:30:00.000Z';
const savedPrefix = 'allrice:recurring-pending:v1:';

function task(patch: Partial<RecurringTask> = {}): RecurringTask {
  return {
    id: TASK,
    clientRequestId: REQUEST,
    sessionId: CHAT,
    name: '已有周期任务',
    prompt: '整理会话进展',
    rule: { kind: 'every', seconds: 60 },
    revision: 1,
    status: 'enabled',
    nextRunAt: NEXT,
    errorMessage: null,
    createdAt: '2026-10-20T01:00:00.000Z',
    updatedAt: '2026-10-20T01:00:00.000Z',
    canManage: true,
    latestOccurrence: null,
    ...patch,
  };
}
const lane = (viewer = VIEWER, workspace = WORKSPACE, session = CHAT) =>
  [viewer, workspace, session].join('/');
type Phase =
  'list' | 'history' | 'create' | 'change' | 'exact-create' | 'exact-change';
type RecordedRequest = {
  method: string;
  sessionId: string;
  viewer: string;
  workspace: string;
  taskId: string | null;
  clientRequestId: string | null;
  operationId: string | null;
  cursor: string | null;
  body: string;
  persisted: [string, string][];
};
type State = {
  tasks: Map<string, RecurringTask[]>;
  creates: Map<string, CreateRecurringTaskInput>;
  operations: Map<string, RecurringTaskOperation>;
  occurrences: Map<string, RecurringOccurrence[]>;
  requests: RecordedRequest[];
  enabled: boolean;
  canManage: boolean;
  dropCreate: boolean;
  dropChange: boolean;
  exactCreateStatus: number | null;
  exactChangeStatus: number | null;
  mismatchCreate: boolean;
  mismatchOperation: boolean;
  defer: Set<Phase>;
  pending: {
    phase: Phase;
    response: ServerResponse;
    value: unknown;
    status: number;
  }[];
};

suite('recurring tasks through the actual clock header', () => {
  let browser: Browser;
  let javascript: Uint8Array;
  let stylesheet: Uint8Array;

  beforeAll(async () => {
    const require = createRequire(resolve(dependencyRoot, 'package.json'));
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const output = await build({
      stdin: {
        contents: `
        import React,{StrictMode,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {OnceTasks} from './app/chatflow/once-tasks';
        const original={viewer:'${VIEWER}',workspace:'${WORKSPACE}',ai:'${AI}',sessionId:'${CHAT}'};
        function Fixture(){
          const [view,setView]=useState(original),[opened,setOpened]=useState('');
          const headers={'x-allrice-organization-id':'${ORG}','x-allrice-workspace-id':view.workspace,
            'x-test-viewer':view.viewer,'x-test-credential':'never-persist-fixture'};
          return <>
            <button onClick={()=>setView(original)}>原账号</button>
            <button onClick={()=>setView({...original,viewer:'${OTHER_VIEWER}',sessionId:'${OTHER_CHAT}'})}>另一账号</button>
            <button onClick={()=>setView({...original,ai:'${OTHER_AI}',sessionId:'${OTHER_CHAT}'})}>另一AI</button>
            <button onClick={()=>setView({...original,workspace:'${OTHER_WORKSPACE}',sessionId:'${OTHER_CHAT}'})}>另一工作区</button>
            <button onClick={()=>setView({...original,sessionId:'${OTHER_CHAT}'})}>另一聊天</button>
            <OnceTasks sessionId={view.sessionId} scope={['${ORG}',view.workspace,view.viewer,view.ai].join('/')}
              headers={headers} onOpenSession={setOpened}/>
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
      alias: {
        '@allrice/contracts': resolve(root, 'packages/contracts/src/index.ts'),
      },
      bundle: true,
      write: false,
      outdir: '/unused-recurring-tasks',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    javascript = output.outputFiles.find((file: { path: string }) =>
      file.path.endsWith('.js'),
    ).contents;
    stylesheet = output.outputFiles.find((file: { path: string }) =>
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

  async function fixture(width = 1_280) {
    const state: State = {
      tasks: new Map([[lane(), [task()]]]),
      creates: new Map(),
      operations: new Map(),
      occurrences: new Map(),
      requests: [],
      enabled: true,
      canManage: true,
      dropCreate: false,
      dropChange: false,
      exactCreateStatus: null,
      exactChangeStatus: null,
      mismatchCreate: false,
      mismatchOperation: false,
      defer: new Set(),
      pending: [],
    };
    const send = (response: ServerResponse, value: unknown, status = 200) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const emit = (
      phase: Phase,
      response: ServerResponse,
      value: unknown,
      status = 200,
    ) => {
      if (state.defer.has(phase))
        state.pending.push({ phase, response, value, status });
      else send(response, value, status);
    };
    const interrupt = (response: ServerResponse) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.flushHeaders();
      response.write('{"unconfirmed":');
      setTimeout(() => response.destroy(), 20);
    };
    const dto = (value: RecurringTask) => ({
      ...value,
      canManage: value.canManage && state.canManage,
    });
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url!, 'http://fixture');
        if (url.pathname === '/') {
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
          });
          response.end(
            '<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
          );
          return;
        }
        if (url.pathname === '/app.js' || url.pathname === '/app.css') {
          response.writeHead(200, {
            'content-type': url.pathname.endsWith('.js')
              ? 'text/javascript'
              : 'text/css',
          });
          response.end(url.pathname.endsWith('.js') ? javascript : stylesheet);
          return;
        }
        if (/\/once-tasks$/.test(url.pathname)) {
          send(response, { tasks: [], enabled: true, nextCursor: null });
          return;
        }
        const match =
          /^\/api\/v1\/sessions\/([^/]+)\/schedule-tasks(?:\/([^/]+))?$/.exec(
            url.pathname,
          );
        if (!match) {
          send(response, {}, 404);
          return;
        }
        const sessionId = match[1]!,
          taskId = match[2] ?? null;
        const viewer = String(request.headers['x-test-viewer'] || '');
        const workspace = String(
          request.headers['x-allrice-workspace-id'] || '',
        );
        const key = lane(viewer, workspace, sessionId),
          values = state.tasks.get(key) ?? [];
        const clientRequestId = url.searchParams.get('clientRequestId'),
          operationId = url.searchParams.get('operationId'),
          cursor = url.searchParams.get('cursor');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const persisted =
          request.method === 'POST' || request.method === 'PATCH'
            ? await saved(page)
            : [];
        state.requests.push({
          method: request.method!,
          sessionId,
          viewer,
          workspace,
          taskId,
          clientRequestId,
          operationId,
          cursor,
          body,
          persisted,
        });
        if (request.method === 'GET') {
          if ((clientRequestId || operationId) && cursor) {
            send(response, {}, 400);
            return;
          }
          if (clientRequestId) {
            if (state.exactCreateStatus !== null) {
              send(response, {}, state.exactCreateStatus);
              return;
            }
            const found = values.find(
              (value) => value.clientRequestId === clientRequestId,
            );
            const original =
              state.creates.get(key + '/' + clientRequestId) ?? null;
            const originalRequest =
              original && state.mismatchCreate
                ? { ...original, prompt: original.prompt + ' changed' }
                : original;
            emit('exact-create', response, {
              tasks: found ? [dto(found)] : [],
              request: originalRequest,
              enabled: state.enabled,
              nextCursor: null,
            });
            return;
          }
          if (taskId) {
            const found = values.find((value) => value.id === taskId);
            if (!found) {
              send(response, {}, 404);
              return;
            }
            if (operationId) {
              if (state.exactChangeStatus !== null) {
                send(response, {}, state.exactChangeStatus);
                return;
              }
              const stored = state.operations.get(key + '/' + operationId);
              const operation = stored
                ? {
                    ...stored,
                    task: dto(found),
                    request: state.mismatchOperation
                      ? {
                          ...stored.request,
                          expectedRevision: stored.request.expectedRevision + 1,
                        }
                      : stored.request,
                  }
                : null;
              emit('exact-change', response, { operation });
              return;
            }
            const offset =
              cursor === null
                ? 0
                : Number(/^history-(\d+)$/.exec(cursor)?.[1] ?? NaN);
            if (!Number.isSafeInteger(offset)) {
              send(response, {}, 400);
              return;
            }
            const records = state.occurrences.get(taskId) ?? [];
            emit('history', response, {
              task: dto(found),
              occurrences: records.slice(offset, offset + 50),
              nextCursor:
                offset + 50 < records.length
                  ? 'history-' + (offset + 50)
                  : null,
            });
            return;
          }
          const offset =
            cursor === null
              ? 0
              : Number(/^list-(\d+)$/.exec(cursor)?.[1] ?? NaN);
          if (!Number.isSafeInteger(offset)) {
            send(response, {}, 400);
            return;
          }
          const ordered = [...values].sort(
            (a, b) =>
              Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
              b.id.localeCompare(a.id),
          );
          emit('list', response, {
            tasks: ordered.slice(offset, offset + 50).map(dto),
            request: null,
            enabled: state.enabled,
            nextCursor:
              offset + 50 < ordered.length ? 'list-' + (offset + 50) : null,
          });
          return;
        }
        if (request.method === 'POST' && !taskId) {
          const input = CreateRecurringTaskInputSchema.parse(JSON.parse(body));
          const created = task({
            id: randomUUID(),
            clientRequestId: input.clientRequestId,
            sessionId,
            name: input.name,
            prompt: input.prompt,
            rule: input.rule,
            createdAt: new Date().toISOString(),
          });
          state.creates.set(
            key + '/' + input.clientRequestId,
            structuredClone(input),
          );
          state.tasks.set(key, [created, ...values]);
          if (state.dropCreate) {
            state.dropCreate = false;
            interrupt(response);
          } else emit('create', response, { task: dto(created) }, 201);
          return;
        }
        if (request.method === 'PATCH' && taskId) {
          const input = ChangeRecurringTaskInputSchema.parse(JSON.parse(body)),
            found = values.find((value) => value.id === taskId);
          if (!found) {
            send(response, {}, 404);
            return;
          }
          const rejected = found.revision !== input.expectedRevision;
          let changed = found;
          if (!rejected) {
            changed = {
              ...found,
              revision: found.revision + 1,
              updatedAt: new Date().toISOString(),
              ...(input.action === 'update'
                ? { name: input.name, prompt: input.prompt, rule: input.rule }
                : {}),
              ...(input.action === 'pause'
                ? { status: 'paused' as const, nextRunAt: null }
                : {}),
              ...(input.action === 'resume'
                ? { status: 'enabled' as const, nextRunAt: NEXT }
                : {}),
              ...(input.action === 'delete'
                ? {
                    status: 'deleted' as const,
                    nextRunAt: null,
                    canManage: false,
                  }
                : {}),
            };
            state.tasks.set(
              key,
              values.map((value) => (value.id === taskId ? changed : value)),
            );
          }
          const operation: RecurringTaskOperation = {
            operationId: input.operationId,
            taskId,
            request: input,
            status: rejected ? 'rejected' : 'applied',
            errorMessage: rejected ? '任务已被其他页面更新。' : null,
            task: dto(changed),
          };
          state.operations.set(key + '/' + input.operationId, operation);
          if (state.dropChange) {
            state.dropChange = false;
            interrupt(response);
          } else emit('change', response, { operation }, rejected ? 409 : 200);
          return;
        }
        send(response, {}, 405);
      })().catch(() => {
        if (!response.headersSent)
          send(response, { error: 'synthetic_fixture_rejected' }, 500);
        else response.destroy();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener');
    const page = await browser.newPage({
      viewport: { width, height: width < 500 ? 844 : 900 },
      timezoneId: 'Asia/Shanghai',
    });
    page.setDefaultTimeout(6_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const release = (phase?: Phase) => {
      const waiting = state.pending.splice(0);
      for (const item of waiting) {
        if (!phase || item.phase === phase)
          send(item.response, item.value, item.status);
        else state.pending.push(item);
      }
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

  const panel = (page: Page) => page.locator('section[aria-label="周期任务"]');
  const cards = (page: Page) => panel(page).locator(':scope > ul > li');
  const card = (page: Page, name = '已有周期任务') =>
    cards(page).filter({ has: page.getByText(name, { exact: true }) });
  const writes = (state: State, method?: 'POST' | 'PATCH') =>
    state.requests.filter((value) =>
      method
        ? value.method === method
        : ['POST', 'PATCH'].includes(value.method),
    );
  const exact = (state: State) =>
    state.requests.filter(
      (value) =>
        value.method === 'GET' && (value.clientRequestId || value.operationId),
    );
  const saved = (page: Page) =>
    page.evaluate(
      (prefix) =>
        Object.entries(sessionStorage).filter(([key]) =>
          key.startsWith(prefix),
        ),
      savedPrefix,
    );

  async function open(page: Page) {
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
    await page.getByRole('dialog', { name: '定时任务', exact: true }).waitFor();
    await page.getByRole('button', { name: '周期', exact: true }).click();
    await panel(page).waitFor();
  }
  async function fill(page: Page, name = '新周期任务', daily = false) {
    await panel(page)
      .getByRole('button', { name: '新建周期任务', exact: true })
      .click();
    const form = panel(page).getByRole('form', {
      name: '创建周期任务',
      exact: true,
    });
    await form.getByLabel('名称', { exact: true }).fill(name);
    await form.getByLabel('执行内容', { exact: true }).fill('只整理本会话进展');
    if (daily) {
      await form
        .getByRole('combobox', { name: /执行周期/ })
        .selectOption('daily');
      await form.getByLabel('每天时间', { exact: true }).fill('09:30');
      await form
        .getByLabel('IANA时区', { exact: true })
        .fill('America/New_York');
    } else await form.getByLabel('间隔分钟', { exact: true }).fill('2');
    return form;
  }
  async function confirmRead(page: Page) {
    const response = page.waitForResponse(
      (value) =>
        value.request().method() === 'GET' &&
        /schedule-tasks/.test(value.url()) &&
        (new URL(value.url()).searchParams.has('clientRequestId') ||
          new URL(value.url()).searchParams.has('operationId')),
    );
    await panel(page)
      .getByRole('button', { name: '按原请求读取结果', exact: true })
      .click();
    await response;
    await expect
      .poll(() =>
        panel(page)
          .getByRole('button', { name: '正在读取…', exact: true })
          .count(),
      )
      .toBe(0);
  }
  async function action(
    page: Page,
    name: '暂停' | '恢复' | '删除',
    title = '已有周期任务',
  ) {
    await card(page, title).getByRole('button', { name, exact: true }).click();
    await card(page, title)
      .getByRole('button', { name: '确认' + name, exact: true })
      .click();
  }
  async function ignoreAbort(page: Page) {
    await page.evaluate(() => {
      const original = window.fetch;
      Object.assign(window, { recurringAborts: 0 });
      window.fetch = (input, init) => {
        init?.signal?.addEventListener('abort', () => {
          (window as unknown as { recurringAborts: number }).recurringAborts++;
        });
        return original(input, { ...init, signal: undefined });
      };
    });
  }

  it.each([1280, 390])(
    'creates monthly from the minute form and edits an existing seconds rule with exact CAS at %s px',
    async (width) => {
      const f = await fixture(width);
      try {
        const name = '新建月末报表',
          original =
            '核对本月报表，分别列出金额和异常。\n保留每条原始要求；最后给出汇总。',
          existing = task({
            id: randomUUID(),
            clientRequestId: randomUUID(),
            name: '既有月末核对',
            prompt: original,
            revision: 7,
            rule: {
              kind: 'monthly',
              monthDay: 31,
              time: '02:30:17',
              timezone: 'America/New_York',
            },
          }),
          queued: RecurringOccurrence = {
            id: randomUUID(),
            taskId: existing.id,
            revision: 7,
            scheduledAt: '2026-09-30T06:30:17.000Z',
            status: 'queued',
            runId: randomUUID(),
            errorMessage: null,
          },
          canceled: RecurringOccurrence = {
            id: randomUUID(),
            taskId: existing.id,
            revision: 6,
            scheduledAt: '2026-08-31T06:30:17.000Z',
            status: 'not_executed',
            runId: null,
            errorMessage: '该期已取消，未产生执行。',
          };
        f.state.tasks.set(lane(), [existing, task()]);
        f.state.occurrences.set(existing.id, [queued, canceled]);
        await open(f.page);
        const form = await fill(f.page, name);
        // A controlled textarea's existing text participates in its wrapping
        // label text. Scope the unique content field to this actual form.
        expect(await form.locator('textarea').count()).toBe(1);
        await form.locator('textarea').fill(original);
        await form
          .getByRole('combobox', { name: /执行周期/ })
          .selectOption('monthly');
        await form.getByLabel('每月日期', { exact: true }).fill('31');
        await form.getByLabel('执行时间', { exact: true }).fill('02:30');
        await form
          .getByLabel('IANA时区', { exact: true })
          .fill('America/New_York');
        await form
          .getByText(
            '按所选时区执行；不存在的日期按当月最后一天。夏令时缺失时间顺延，重复时间只执行一次；停机后只处理最近一期。',
            { exact: true },
          )
          .waitFor();
        await form.getByRole('button', { name: '创建', exact: true }).click();
        const created = card(f.page, name);
        await created
          .getByText('每月31日 02:30 · America/New_York · 版本 1', {
            exact: true,
          })
          .waitFor();
        expect(await created.locator('p[title]').getAttribute('title')).toBe(
          original,
        );
        expect(writes(f.state, 'POST')).toHaveLength(1);
        const createRequest = writes(f.state, 'POST')[0]!,
          createInput = CreateRecurringTaskInputSchema.parse(
            JSON.parse(createRequest.body),
          );
        // The actual create form selects minutes. Nonzero seconds below belong
        // to an existing server rule; this path does not claim seconds creation.
        expect(createInput).toEqual({
          clientRequestId: createInput.clientRequestId,
          name,
          prompt: original,
          rule: {
            kind: 'monthly',
            monthDay: 31,
            time: '02:30:00',
            timezone: 'America/New_York',
          },
        });
        expect(JSON.parse(createRequest.persisted[0]![1]).body).toEqual(
          createInput,
        );
        expect(
          f.state.creates.get(lane() + '/' + createInput.clientRequestId),
        ).toEqual(createInput);
        const row = card(f.page, existing.name);
        await row
          .getByText('每月31日 02:30:17 · America/New_York · 版本 7', {
            exact: true,
          })
          .waitFor();
        await row.getByRole('button', { name: '编辑', exact: true }).click();
        const edit = panel(f.page).getByRole('form', {
            name: '编辑周期任务',
            exact: true,
          }),
          frequency = edit.getByRole('combobox', { name: /执行周期/ });
        await edit.getByText('编辑 · 版本 7', { exact: true }).waitFor();
        expect(await frequency.inputValue()).toBe('monthly');
        expect(
          await edit.getByLabel('每月日期', { exact: true }).inputValue(),
        ).toBe('31');
        expect(
          await edit.getByLabel('执行时间', { exact: true }).inputValue(),
        ).toBe('02:30');
        expect(
          await edit.getByLabel('IANA时区', { exact: true }).inputValue(),
        ).toBe('America/New_York');
        expect(await edit.locator('textarea').inputValue()).toBe(original);
        await edit
          .getByText(
            '修改影响之后的期次，已排队任务可继续。原时间含秒，未修改分钟时保留原秒数。',
            { exact: true },
          )
          .waitFor();
        // Playwright retargets a labeled option to the select for isDisabled.
        // Inspect the native option state, preserving every family restriction.
        expect(await frequency.isEnabled()).toBe(true);
        expect(
          await frequency.evaluate((select) => {
            if (!(select instanceof HTMLSelectElement))
              throw Error('expected monthly select');
            return [...select.options].map((option) => ({
              value: option.value,
              disabled: option.disabled,
            }));
          }),
        ).toEqual([
          { value: 'every', disabled: true },
          { value: 'daily', disabled: true },
          { value: 'weekly', disabled: true },
          { value: 'monthly', disabled: false },
        ]);
        expect(await frequency.inputValue()).toBe('monthly');
        await edit.getByLabel('每月日期', { exact: true }).fill('30');
        await edit
          .getByRole('button', { name: '保存修改', exact: true })
          .click();
        await row
          .getByText('每月30日 02:30:17 · America/New_York · 版本 8', {
            exact: true,
          })
          .waitFor();
        expect(writes(f.state, 'PATCH')).toHaveLength(1);
        const changeRequest = writes(f.state, 'PATCH')[0]!,
          changeInput = ChangeRecurringTaskInputSchema.parse(
            JSON.parse(changeRequest.body),
          );
        expect(changeRequest.taskId).toBe(existing.id);
        expect(changeInput).toEqual({
          operationId: changeInput.operationId,
          expectedRevision: 7,
          action: 'update',
          name: existing.name,
          prompt: original,
          rule: {
            kind: 'monthly',
            monthDay: 30,
            time: '02:30:17',
            timezone: 'America/New_York',
          },
        });
        expect(JSON.parse(changeRequest.persisted[0]![1]).body).toEqual(
          changeInput,
        );
        expect(
          f.state.operations.get(lane() + '/' + changeInput.operationId),
        ).toMatchObject({
          request: changeInput,
          status: 'applied',
          task: {
            revision: 8,
            prompt: original,
            rule: {
              kind: 'monthly',
              monthDay: 30,
              time: '02:30:17',
              timezone: 'America/New_York',
            },
          },
        });
        expect(await row.locator('p[title]').getAttribute('title')).toBe(
          original,
        );
        await row
          .getByRole('button', { name: '执行记录', exact: true })
          .click();
        const history = f.page.getByRole('region', {
          name: '周期任务执行记录',
          exact: true,
        });
        await history
          .getByText(existing.name + '的执行记录', { exact: true })
          .waitFor();
        await history.getByText('排队中', { exact: true }).waitFor();
        await history.getByText('任务版本 7', { exact: true }).waitFor();
        await history.getByText('未执行', { exact: true }).waitFor();
        await history.getByText('任务版本 6', { exact: true }).waitFor();
        await history
          .getByText(canceled.errorMessage!, { exact: true })
          .waitFor();
        await history
          .locator(`time[datetime="${queued.scheduledAt}"]`)
          .waitFor();
        expect(f.state.occurrences.get(existing.id)).toEqual([
          queued,
          canceled,
        ]);
        await history
          .getByRole('button', { name: '关闭记录', exact: true })
          .click();
        await card(f.page)
          .getByRole('button', { name: '编辑', exact: true })
          .click();
        const fixedEdit = panel(f.page).getByRole('form', {
            name: '编辑周期任务',
            exact: true,
          }),
          fixedFrequency = fixedEdit.getByRole('combobox', {
            name: /执行周期/,
          });
        expect(await fixedFrequency.inputValue()).toBe('every');
        expect(await fixedFrequency.isEnabled()).toBe(true);
        expect(
          await fixedFrequency.evaluate((select) => {
            if (!(select instanceof HTMLSelectElement))
              throw Error('expected fixed select');
            return [...select.options].map((option) => ({
              value: option.value,
              disabled: option.disabled,
            }));
          }),
        ).toEqual([
          { value: 'every', disabled: false },
          { value: 'daily', disabled: false },
          { value: 'weekly', disabled: false },
          { value: 'monthly', disabled: true },
        ]);
        await fixedFrequency.selectOption('weekly');
        expect(await fixedFrequency.inputValue()).toBe('weekly');
        await fixedEdit
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        // A later server revision rejects a deliberate stale monthly edit. The
        // user must make a new decision; the UI must not silently retry it.
        f.state.defer.add('list');
        await row.getByRole('button', { name: '编辑', exact: true }).click();
        const staleEdit = panel(f.page).getByRole('form', {
          name: '编辑周期任务',
          exact: true,
        });
        await staleEdit.getByText('编辑 · 版本 8', { exact: true }).waitFor();
        await staleEdit.getByLabel('每月日期', { exact: true }).fill('29');
        const current = f.state.tasks
            .get(lane())!
            .find((value) => value.id === existing.id)!,
          externalPrompt = original + '\n另一页面已补充核对要求。';
        f.state.tasks.set(
          lane(),
          f.state.tasks
            .get(lane())!
            .map((value) =>
              value.id === existing.id
                ? { ...current, revision: 9, prompt: externalPrompt }
                : value,
            ),
        );
        await staleEdit
          .getByRole('button', { name: '保存修改', exact: true })
          .click();
        await panel(f.page)
          .getByText(/当前版本为 9.*重新选择/)
          .waitFor();
        await row
          .getByText('每月30日 02:30:17 · America/New_York · 版本 9', {
            exact: true,
          })
          .waitFor();
        expect(await row.locator('p[title]').getAttribute('title')).toBe(
          externalPrompt,
        );
        expect(await staleEdit.count()).toBe(0);
        const staleInput = ChangeRecurringTaskInputSchema.parse(
          JSON.parse(writes(f.state, 'PATCH')[1]!.body),
        );
        expect(staleInput).toEqual({
          operationId: staleInput.operationId,
          expectedRevision: 8,
          action: 'update',
          name: existing.name,
          prompt: original,
          rule: {
            kind: 'monthly',
            monthDay: 29,
            time: '02:30:17',
            timezone: 'America/New_York',
          },
        });
        expect(staleInput.operationId).not.toBe(changeInput.operationId);
        expect(
          f.state.operations.get(lane() + '/' + staleInput.operationId),
        ).toMatchObject({
          request: staleInput,
          status: 'rejected',
          task: { revision: 9, prompt: externalPrompt, rule: { monthDay: 30 } },
        });
        expect(writes(f.state, 'POST')).toHaveLength(1);
        expect(writes(f.state, 'PATCH')).toHaveLength(2);
        expect(
          writes(f.state).every(
            (request) =>
              request.sessionId === CHAT &&
              request.workspace === WORKSPACE &&
              request.viewer === VIEWER,
          ),
        ).toBe(true);
        expect(await saved(f.page)).toEqual([]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    20_000,
  );

  it.each([1280, 390])(
    'creates and edits a weekly rule without losing weekdays or exposing another scope at %s px',
    async (width) => {
      const f = await fixture(width);
      try {
        await open(f.page);
        const form = await fill(f.page, '每周核对');
        await form
          .getByRole('combobox', { name: /执行周期/ })
          .selectOption('weekly');
        await form.getByLabel('执行时间', { exact: true }).fill('09:30');
        await form
          .getByLabel('IANA时区', { exact: true })
          .fill('Asia/Shanghai');
        await form.getByLabel('周三', { exact: true }).check();
        await form.getByRole('button', { name: '创建', exact: true }).click();
        const row = card(f.page, '每周核对');
        await row
          .getByText('每周一、三 09:30 · Asia/Shanghai · 版本 1', {
            exact: true,
          })
          .waitFor();
        const body = CreateRecurringTaskInputSchema.parse(
          JSON.parse(writes(f.state, 'POST')[0]!.body),
        );
        expect(body.rule).toEqual({
          kind: 'weekly',
          weekdays: [1, 3],
          time: '09:30:00',
          timezone: 'Asia/Shanghai',
        });
        await row.getByRole('button', { name: '编辑', exact: true }).click();
        const edit = panel(f.page).getByRole('form', {
          name: '编辑周期任务',
          exact: true,
        });
        expect(await edit.getByLabel('周一', { exact: true }).isChecked()).toBe(
          true,
        );
        expect(await edit.getByLabel('周三', { exact: true }).isChecked()).toBe(
          true,
        );
        await edit.getByLabel('周一', { exact: true }).uncheck();
        await edit.getByLabel('周日', { exact: true }).check();
        await edit
          .getByRole('button', { name: '保存修改', exact: true })
          .click();
        await row
          .getByText('每周三、日 09:30 · Asia/Shanghai · 版本 2', {
            exact: true,
          })
          .waitFor();
        const changed = ChangeRecurringTaskInputSchema.parse(
          JSON.parse(writes(f.state, 'PATCH')[0]!.body),
        );
        expect(changed).toMatchObject({
          action: 'update',
          expectedRevision: 1,
          rule: { kind: 'weekly', weekdays: [3, 7] },
        });
        expect(
          writes(f.state).every(
            (request) =>
              request.sessionId === CHAT && request.viewer === VIEWER,
          ),
        ).toBe(true);
        expect(await saved(f.page)).toEqual([]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    20_000,
  );

  it.each([
    { width: 1280, daily: false },
    { width: 1280, daily: true },
    { width: 390, daily: false },
    { width: 390, daily: true },
  ])(
    'creates an explicit rule through the clock tab at $width px',
    async ({ width, daily }) => {
      const f = await fixture(width);
      try {
        await open(f.page);
        const form = await fill(f.page, '页面周期任务', daily);
        await form.getByRole('button', { name: '创建', exact: true }).click();
        await panel(f.page)
          .getByText('周期任务已创建。', { exact: true })
          .waitFor();
        const submitted = writes(f.state, 'POST')[0]!;
        const body = CreateRecurringTaskInputSchema.parse(
          JSON.parse(submitted.body),
        );
        expect(body.rule).toEqual(
          daily
            ? { kind: 'daily', time: '09:30:00', timezone: 'America/New_York' }
            : { kind: 'every', seconds: 120 },
        );
        expect(submitted.sessionId).toBe(CHAT);
        expect(submitted.persisted).toHaveLength(1);
        const [key, raw] = submitted.persisted[0]!;
        expect(JSON.parse(key.slice(savedPrefix.length))).toEqual([
          ORG,
          WORKSPACE,
          VIEWER,
          AI,
          CHAT,
        ]);
        expect(JSON.parse(raw).body).toEqual(body);
        expect(raw).not.toMatch(/never-persist-fixture|headers|authorization/i);
        await card(f.page, '页面周期任务')
          .locator(`time[datetime="${NEXT}"]`)
          .waitFor();
        expect(await saved(f.page)).toEqual([]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await card(f.page, '页面周期任务')
          .getByRole('button', { name: '查看会话', exact: true })
          .click();
        expect(await f.page.getByLabel('已打开会话').textContent()).toBe(CHAT);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    20_000,
  );

  it('edits, pauses, resumes and deletes while retaining queued history and server revision decisions', async () => {
    const f = await fixture();
    try {
      f.state.occurrences.set(TASK, [
        {
          id: randomUUID(),
          taskId: TASK,
          revision: 1,
          scheduledAt: '2026-10-20T02:00:00.000Z',
          status: 'queued',
          runId: randomUUID(),
          errorMessage: null,
        },
        {
          id: randomUUID(),
          taskId: TASK,
          revision: 1,
          scheduledAt: '2026-10-20T01:00:00.000Z',
          status: 'not_executed',
          runId: null,
          errorMessage: '本期暂停，未执行。',
        },
      ]);
      await open(f.page);
      await card(f.page)
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      const edit = panel(f.page).getByRole('form', {
        name: '编辑周期任务',
        exact: true,
      });
      await edit.getByLabel('名称', { exact: true }).fill('修改后的周期');
      await edit.getByLabel('间隔分钟', { exact: true }).fill('2');
      await edit.getByRole('button', { name: '保存修改', exact: true }).click();
      await card(f.page, '修改后的周期')
        .getByText('每 2 分钟 · 版本 2', { exact: true })
        .waitFor();
      await action(f.page, '暂停', '修改后的周期');
      await card(f.page, '修改后的周期')
        .getByText('已暂停', { exact: true })
        .first()
        .waitFor();
      await action(f.page, '恢复', '修改后的周期');
      await card(f.page, '修改后的周期')
        .getByText('已启用', { exact: true })
        .waitFor();
      await card(f.page, '修改后的周期')
        .getByRole('button', { name: '执行记录', exact: true })
        .click();
      const history = f.page.getByRole('region', {
        name: '周期任务执行记录',
        exact: true,
      });
      await history.getByText('排队中', { exact: true }).waitFor();
      await history.getByText('未执行', { exact: true }).waitFor();
      await action(f.page, '删除', '修改后的周期');
      await card(f.page, '修改后的周期')
        .getByText('已删除', { exact: true })
        .waitFor();
      expect(
        await card(f.page, '修改后的周期')
          .getByRole('button', { name: '编辑', exact: true })
          .count(),
      ).toBe(0);
      await history
        .getByRole('button', { name: '刷新记录', exact: true })
        .click();
      await history.getByText('排队中', { exact: true }).waitFor();
      const changes = writes(f.state, 'PATCH').map((value) =>
        ChangeRecurringTaskInputSchema.parse(JSON.parse(value.body)),
      );
      expect(
        changes.map((value) => [value.action, value.expectedRevision]),
      ).toEqual([
        ['update', 1],
        ['pause', 2],
        ['resume', 3],
        ['delete', 4],
      ]);
      expect(new Set(changes.map((value) => value.operationId)).size).toBe(4);
      for (const write of writes(f.state))
        expect(JSON.parse(write.persisted[0]![1]).body).toEqual(
          JSON.parse(write.body),
        );
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);

  it('restores an unknown create beyond fifty rows and confirms the original input after the task is edited elsewhere', async () => {
    const f = await fixture();
    try {
      f.state.dropCreate = true;
      f.state.exactCreateStatus = 403;
      await open(f.page);
      await (
        await fill(f.page, '原创建请求')
      )
        .getByRole('button', { name: '创建', exact: true })
        .click();
      await expect.poll(() => exact(f.state).length).toBeGreaterThan(0);
      await expect
        .poll(() =>
          panel(f.page)
            .getByRole('button', { name: '按原请求读取结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      const retained = await saved(f.page);
      expect(retained).toHaveLength(1);
      const created = f.state.tasks.get(lane())![0]!;
      f.state.tasks.set(lane(), [
        ...Array.from({ length: 100 }, (_, index) =>
          task({
            id: randomUUID(),
            clientRequestId: randomUUID(),
            name: '更新列表项' + index,
            createdAt: new Date(
              Date.parse(created.createdAt) + index + 1,
            ).toISOString(),
          }),
        ),
        {
          ...created,
          name: '另一页面已编辑',
          prompt: '新执行内容',
          rule: { kind: 'every', seconds: 300 },
          revision: 3,
        },
      ]);
      await f.page.reload();
      await open(f.page);
      await expect.poll(() => cards(f.page).count()).toBe(50);
      expect(await card(f.page, '原创建请求').count()).toBe(0);
      expect(await saved(f.page)).toEqual(retained);
      f.state.exactCreateStatus = 409;
      await confirmRead(f.page);
      expect(await saved(f.page)).toEqual(retained);
      f.state.exactCreateStatus = null;
      f.state.mismatchCreate = true;
      await confirmRead(f.page);
      expect(await saved(f.page)).toEqual(retained);
      f.state.mismatchCreate = false;
      await confirmRead(f.page);
      await panel(f.page)
        .getByText('周期任务已创建。', { exact: true })
        .waitFor();
      await card(f.page, '另一页面已编辑').waitFor();
      expect(await saved(f.page)).toEqual([]);
      expect(writes(f.state, 'POST')).toHaveLength(1);
      expect(
        exact(f.state).every(
          (value) =>
            value.clientRequestId === created.clientRequestId &&
            value.cursor === null,
        ),
      ).toBe(true);
      // A separate deliberate user action may create identical original content.
      await (
        await fill(f.page, '原创建请求')
      )
        .getByRole('button', { name: '创建', exact: true })
        .click();
      await expect.poll(() => writes(f.state, 'POST').length).toBe(2);
      await expect.poll(() => saved(f.page)).toEqual([]);
      const [first, second] = writes(f.state, 'POST').map((value) =>
        JSON.parse(value.body),
      );
      expect(first.clientRequestId).not.toBe(second.clientRequestId);
      expect({ ...first, clientRequestId: null }).toEqual({
        ...second,
        clientRequestId: null,
      });
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);

  it('keeps a lost management ACK unknown until the exact request matches, and makes revision conflicts a new user decision', async () => {
    const f = await fixture();
    try {
      f.state.dropChange = true;
      f.state.exactChangeStatus = 403;
      await open(f.page);
      await action(f.page, '暂停');
      await expect.poll(() => exact(f.state).length).toBeGreaterThan(0);
      await expect
        .poll(() =>
          panel(f.page)
            .getByRole('button', { name: '按原请求读取结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      const retained = await saved(f.page);
      expect(retained).toHaveLength(1);
      f.state.exactChangeStatus = null;
      f.state.mismatchOperation = true;
      await confirmRead(f.page);
      expect(await saved(f.page)).toEqual(retained);
      f.state.mismatchOperation = false;
      f.state.exactChangeStatus = 409;
      await confirmRead(f.page);
      expect(await saved(f.page)).toEqual(retained);
      f.state.exactChangeStatus = null;
      await confirmRead(f.page);
      await panel(f.page).getByText('操作已应用。', { exact: true }).waitFor();
      expect(writes(f.state, 'PATCH')).toHaveLength(1);
      expect(await saved(f.page)).toEqual([]);
      const original = JSON.parse(writes(f.state, 'PATCH')[0]!.body);
      expect(
        exact(f.state).every(
          (value) =>
            value.operationId === original.operationId && value.cursor === null,
        ),
      ).toBe(true);
      await card(f.page)
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      const edit = panel(f.page).getByRole('form', {
        name: '编辑周期任务',
        exact: true,
      });
      await edit.getByLabel('名称', { exact: true }).fill('不应自动重试的修改');
      f.state.tasks.set(lane(), [task({ revision: 5, status: 'paused' })]);
      await edit.getByRole('button', { name: '保存修改', exact: true }).click();
      await panel(f.page)
        .getByText(/当前版本为 5.*重新选择/)
        .waitFor();
      expect(await edit.count()).toBe(0);
      expect(await saved(f.page)).toEqual([]);
      expect(writes(f.state, 'PATCH')).toHaveLength(2);
      expect(await card(f.page, '不应自动重试的修改').count()).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);

  it('does not poll on keystrokes, pauses hidden or closed polling, and ignores a late aborted exact reply', async () => {
    const f = await fixture();
    try {
      await f.page.clock.install();
      await ignoreAbort(f.page);
      await open(f.page);
      const form = await fill(f.page, '隐藏中的原请求');
      const reads = f.state.requests.length;
      await form.getByLabel('名称', { exact: true }).pressSequentially('输入');
      expect(f.state.requests).toHaveLength(reads);
      f.state.dropCreate = true;
      f.state.defer.add('exact-create');
      await form.getByRole('button', { name: '创建', exact: true }).click();
      await expect
        .poll(
          () =>
            f.state.pending.filter((value) => value.phase === 'exact-create')
              .length,
        )
        .toBe(1);
      await f.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      f.state.defer.delete('exact-create');
      f.release('exact-create');
      await f.page.clock.fastForward(30_000);
      const hidden = f.state.requests.length;
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests).toHaveLength(hidden);
      expect(await saved(f.page)).toHaveLength(1);
      expect(
        await panel(f.page)
          .getByText('周期任务已创建。', { exact: true })
          .count(),
      ).toBe(0);
      f.state.exactCreateStatus = 403;
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
          panel(f.page)
            .getByRole('button', { name: '按原请求读取结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          panel(f.page)
            .getByRole('button', { name: '刷新列表', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      const visibleReads = f.state.requests.length;
      await f.page.clock.fastForward(10_001);
      await expect.poll(() => f.state.requests.length).toBe(visibleReads + 2);
      await f.page.getByRole('button', { name: '一次性', exact: true }).click();
      const onceTabReads = f.state.requests.length;
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests).toHaveLength(onceTabReads);
      expect(await saved(f.page)).toHaveLength(1);
      await f.page.getByRole('button', { name: '周期', exact: true }).click();
      await expect
        .poll(() =>
          panel(f.page)
            .getByRole('button', { name: '按原请求读取结果', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      await f.page
        .getByRole('button', { name: '关闭定时任务', exact: true })
        .click();
      const closed = f.state.requests.length;
      await f.page.clock.fastForward(30_000);
      expect(f.state.requests).toHaveLength(closed);
      expect(await saved(f.page)).toHaveLength(1);
      f.state.exactCreateStatus = null;
      await open(f.page);
      await panel(f.page)
        .getByText('周期任务已创建。', { exact: true })
        .waitFor();
      expect(writes(f.state, 'POST')).toHaveLength(1);
      expect(await saved(f.page)).toEqual([]);
      expect(
        await f.page.evaluate(
          () =>
            (window as unknown as { recurringAborts: number }).recurringAborts,
        ),
      ).toBeGreaterThan(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);

  it('isolates late list and write responses across account, AI, workspace and chat scopes', async () => {
    const f = await fixture();
    try {
      await ignoreAbort(f.page);
      f.state.defer.add('list');
      await open(f.page);
      await expect
        .poll(
          () =>
            f.state.pending.filter((value) => value.phase === 'list').length,
        )
        .toBeGreaterThan(0);
      await f.page
        .getByRole('button', { name: '另一账号', exact: true })
        .click();
      f.state.defer.delete('list');
      f.release('list');
      await open(f.page);
      await panel(f.page).getByText('暂无周期任务', { exact: true }).waitFor();
      expect(await card(f.page).count()).toBe(0);
      f.state.defer.add('create');
      await (
        await fill(f.page, '另一账号的迟到创建')
      )
        .getByRole('button', { name: '创建', exact: true })
        .click();
      await expect
        .poll(
          () =>
            f.state.pending.filter((value) => value.phase === 'create').length,
        )
        .toBe(1);
      await f.page.getByRole('button', { name: '另一AI', exact: true }).click();
      f.state.defer.delete('create');
      f.release('create');
      await open(f.page);
      await panel(f.page).getByText('暂无周期任务', { exact: true }).waitFor();
      expect(await card(f.page, '另一账号的迟到创建').count()).toBe(0);
      expect(
        await panel(f.page)
          .getByText('周期任务已创建。', { exact: true })
          .count(),
      ).toBe(0);
      for (const name of ['另一工作区', '另一聊天']) {
        await f.page.getByRole('button', { name, exact: true }).click();
        await open(f.page);
        await panel(f.page)
          .getByText('暂无周期任务', { exact: true })
          .waitFor();
        expect(
          await panel(f.page).getByText('请求待确认', { exact: true }).count(),
        ).toBe(0);
      }
      const entries = await saved(f.page);
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0]![0].slice(savedPrefix.length))).toEqual([
        ORG,
        WORKSPACE,
        OTHER_VIEWER,
        AI,
        OTHER_CHAT,
      ]);
      await f.page
        .getByRole('button', { name: '另一账号', exact: true })
        .click();
      await open(f.page);
      await panel(f.page)
        .getByText('周期任务已创建。', { exact: true })
        .waitFor();
      await card(f.page, '另一账号的迟到创建').waitFor();
      expect(await saved(f.page)).toEqual([]);
      expect(writes(f.state, 'POST')).toHaveLength(1);
      expect(
        exact(f.state).every(
          (value) =>
            value.viewer === OTHER_VIEWER && value.sessionId === OTHER_CHAT,
        ),
      ).toBe(true);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);

  it('paginates task and occurrence history while readonly tasks remain viewable', async () => {
    const f = await fixture(390);
    try {
      f.state.enabled = false;
      f.state.canManage = false;
      const values = Array.from({ length: 120 }, (_, index) =>
        task({
          id: index === 119 ? TASK : randomUUID(),
          clientRequestId: randomUUID(),
          name: '历史周期 ' + String(index).padStart(3, '0'),
          createdAt: new Date(
            Date.UTC(2026, 9, 20, 12) - index * 1000,
          ).toISOString(),
        }),
      );
      f.state.tasks.set(lane(), values);
      f.state.occurrences.set(
        TASK,
        Array.from({ length: 115 }, (_, index) => ({
          id: randomUUID(),
          taskId: TASK,
          revision: 1,
          scheduledAt: new Date(
            Date.UTC(2026, 9, 20, 12) - index * 60_000,
          ).toISOString(),
          status: index === 114 ? 'not_executed' : 'succeeded',
          runId: index === 114 ? null : randomUUID(),
          errorMessage: null,
        })),
      );
      await open(f.page);
      await expect.poll(() => cards(f.page).count()).toBe(50);
      expect(
        await panel(f.page)
          .getByRole('button', { name: '新建周期任务', exact: true })
          .isDisabled(),
      ).toBe(true);
      for (const count of [100, 120]) {
        await panel(f.page)
          .getByRole('button', { name: '加载更多任务', exact: true })
          .click();
        await expect.poll(() => cards(f.page).count()).toBe(count);
      }
      expect(
        await panel(f.page)
          .getByRole('button', { name: '编辑', exact: true })
          .count(),
      ).toBe(0);
      await card(f.page, '历史周期 119')
        .getByRole('button', { name: '执行记录', exact: true })
        .click();
      const history = f.page.getByRole('region', {
        name: '周期任务执行记录',
        exact: true,
      });
      await expect.poll(() => history.getByRole('listitem').count()).toBe(50);
      for (const count of [100, 115]) {
        await history
          .getByRole('button', { name: '加载更多记录', exact: true })
          .click();
        await expect
          .poll(() => history.getByRole('listitem').count())
          .toBe(count);
      }
      await history.getByText('未执行', { exact: true }).waitFor();
      expect(
        f.state.requests
          .filter((value) => value.cursor)
          .map((value) => value.cursor),
      ).toEqual(['list-50', 'list-100', 'history-50', 'history-100']);
      expect(writes(f.state)).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);
});
