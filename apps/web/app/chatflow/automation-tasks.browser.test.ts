/** Real React/Chrome interaction; synthetic HTTP only. SQL authority is tested separately. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangeRecurringTaskInputSchema } from '@allrice/contracts';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import type {
  AutomationCatalogTask,
  ChangeRecurringTaskInput,
  RecurringTaskOperation,
  ManualAutomationRunInput,
  RunSnapshot,
} from '@allrice/contracts';
import { stopOccurrenceStorageKey } from './stop-occurrence-intent';
import { manualRunStorageKey } from './manual-run-intent';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const ORG = '11111111-1111-4111-8111-111111111111',
  WORKSPACE = '22222222-2222-4222-8222-222222222222',
  VIEWER = '33333333-3333-4333-8333-333333333333',
  EMPLOYEE = '44444444-4444-4444-8444-444444444444',
  CHAT = '55555555-5555-4555-8555-555555555555',
  TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  OCCURRENCE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  OTHER_ORG = '66666666-6666-4666-8666-666666666666',
  OTHER_WORKSPACE = '77777777-7777-4777-8777-777777777777',
  OTHER_VIEWER = '88888888-8888-4888-8888-888888888888',
  OTHER_TASK = '99999999-9999-4999-8999-999999999999',
  OTHER_OCCURRENCE = 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  OTHER_RUN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const entry = (): AutomationCatalogTask => ({
  id: TASK,
  name: '喝水',
  prompt: '提醒用户：该喝水啦',
  employeeId: EMPLOYEE,
  employeeName: 'Rice',
  sessionId: CHAT,
  sessionTitle: '喝水安排',
  sourceArchived: false,
  createdAt: '2026-10-21T01:00:00.000Z',
  nextRunAt: '2099-01-01T01:00:00.000Z',
  canStop: true,
  revision: 1,
  definition: {
    kind: 'recurring',
    task: {
      id: TASK,
      name: '喝水',
      prompt: '提醒用户：该喝水啦',
      sessionId: CHAT,
      clientRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      rule: { kind: 'every', seconds: 120 },
      revision: 1,
      status: 'enabled',
      nextRunAt: '2099-01-01T01:00:00.000Z',
      errorMessage: null,
      createdAt: '2026-10-21T01:00:00.000Z',
      updatedAt: '2026-10-21T01:00:00.000Z',
      canManage: true,
      latestOccurrence: null,
    },
  },
});
suite(
  'unified automation catalog and right task editor',
  { timeout: 30000 },
  () => {
    let browser: Browser,
      origin: string,
      server: ReturnType<typeof createServer>,
      javascript: Uint8Array,
      stylesheet: Uint8Array;
    beforeAll(async () => {
      const require = createRequire(resolve(root, 'package.json'));
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const output = await build({
        stdin: {
          contents: `
      import React,{StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';
      import {AutomationTaskList,AutomationTaskDetail,AutomationTaskCard} from './app/chatflow/automation-tasks';
      import {AutomationTrigger} from './app/chatflow/automation-trigger';
      function Fixture(){const [selected,setSelected]=useState(null),[opened,setOpened]=useState(''),[hide,setHide]=useState(false),[mode,setMode]=useState('list');
        const [identity,setIdentity]=useState({organizationId:'${ORG}',workspaceId:'${WORKSPACE}',viewerId:'${VIEWER}',taskId:null});
        const scope=[identity.organizationId,identity.workspaceId,identity.viewerId].join('/'),headers={'x-fixture-organization':identity.organizationId,'x-fixture-viewer':identity.viewerId,'x-test-secret':'never-persist'};
        return <><button onClick={()=>setHide(v=>!v)}>显示或隐藏右栏</button><button onClick={()=>setMode('list')}>返回任务列表</button>
        <button onClick={()=>setIdentity(v=>({...v,organizationId:'${OTHER_ORG}'}))}>切换组织</button>
        <button onClick={()=>setIdentity(v=>({...v,workspaceId:'${OTHER_WORKSPACE}'}))}>切换工作区</button>
        <button onClick={()=>setIdentity(v=>({...v,viewerId:'${OTHER_VIEWER}'}))}>切换用户</button>
        <button onClick={()=>setIdentity(v=>({...v,taskId:'${OTHER_TASK}'}))}>切换任务</button>
        <div style={{display:'flex',height:'calc(100vh - 50px)',minWidth:0}}>
          {mode==='list'&&<div className="list"><AutomationTaskList workspaceId={identity.workspaceId} scope={scope} headers={headers} employees={[{id:'${EMPLOYEE}',name:'Rice'}]} selectedId={selected?.id} onSelect={setSelected} onNew={()=>setMode('new')}/></div>}
          {mode==='new'&&<p>说明时间和工作内容，创建新的任务</p>}
          {selected&&!hide&&<aside className="detail"><AutomationTaskDetail taskId={identity.taskId??selected.id} active={!hide} workspaceId={identity.workspaceId} scope={scope} headers={headers} onOpenSession={setOpened}/></aside>}
        </div><output aria-label="原会话">{opened}</output>
        </>;
      } createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
    `,
          loader: 'tsx',
          resolveDir: resolve(root, 'apps/web'),
        },
        bundle: true,
        write: false,
        outdir: '/unused-automation-ui',
        format: 'iife',
        platform: 'browser',
        jsx: 'automatic',
        alias: {
          '@allrice/contracts': resolve(
            root,
            'packages/contracts/src/index.ts',
          ),
        },
        nodePaths: [
          resolve(root, 'apps/web/node_modules'),
          resolve(root, 'node_modules'),
        ],
        define: {
          'process.env.NODE_ENV': '"development"',
          'process.env': '{}',
        },
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      });
      javascript = output.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('.js'),
      ).contents;
      stylesheet = output.outputFiles.find((f: { path: string }) =>
        f.path.endsWith('.css'),
      ).contents;
      server = createServer((request, response) => {
        if (request.url === '/app.js') {
          response.setHeader('content-type', 'application/javascript');
          response.end(javascript);
          return;
        }
        if (request.url === '/app.css') {
          response.setHeader('content-type', 'text/css');
          response.end(stylesheet);
          return;
        }
        response.setHeader('content-type', 'text/html');
        response.end(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>:root{--dsw-alias-label-primary:#20242d;--dsw-alias-label-secondary:#606775;--dsw-alias-label-tertiary:#7c8390;--dsw-alias-bg-base:#fff;--dsw-alias-border-l3:#d9dde4;--dsw-alias-border-l4:#eceef3;--dsw-alias-state-business-primary:#3478ef;--dsw-alias-interactive-bg-hover:#f3f5f8}*{box-sizing:border-box}body{margin:0;font-family:system-ui}button,input,select{font:inherit}.list{flex:1;min-width:0;display:flex}.detail{width:440px;min-width:0;border-left:1px solid #ddd}@media(max-width:760px){body:has(.detail) .list{display:none}.detail{width:100%}}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      origin =
        'http://127.0.0.1:' + (server.address() as { port: number }).port;
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
      await new Promise<void>((r) => server?.close(() => r()));
    });
    async function fixture(
      width = 1280,
      options: {
        running?: boolean;
        storageFailure?: boolean;
        manual?: boolean;
      } = {},
    ) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        task = entry(),
        requests: Array<{
          method: string;
          operationId: string | null;
          body: unknown;
          url: string;
          principalScope: string;
        }> = [],
        operations = new Map<string, RecurringTaskOperation>();
      task.canRunNow = options.manual === true;
      const manualReceipts = new Map<
        string,
        ReturnType<typeof manualReceipt>
      >();
      function manualReceipt(input: ManualAutomationRunInput) {
        const now = '2026-10-22T01:00:00.000Z';
        return {
          source: 'manual',
          taskId: TASK,
          request: input,
          requestDigest: 'sha256:' + 'a'.repeat(64),
          automationRunId: OCCURRENCE,
          requestedAt: now,
          sessionId: CHAT,
          run: {
            id: RUN,
            organizationId: ORG,
            workspaceId: WORKSPACE,
            ownerId: VIEWER,
            status: 'queued',
            cancelRequestedAt: null,
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now,
            job: {
              id: OTHER_RUN,
              organizationId: ORG,
              workspaceId: WORKSPACE,
              ownerId: VIEWER,
              status: 'queued',
              idempotencyKey: 'employee-message:' + OCCURRENCE,
              priority: 0,
              attempt: 0,
              maxAttempts: 2,
              availableAt: now,
              timeoutAt: now,
              payload: {
                schemaVersion: 1,
                type: 'allrice.employee.run',
                input: {},
              },
              lease: null,
            },
          },
        };
      }
      const state = {
        dropAck: false,
        mismatch: false,
        dropStopAck: false,
        holdStop: null as 'POST' | 'GET' | null,
        stopRequested: false,
        stopTerminal: false,
        newerHistory: false,
        dropManualAck: false,
        holdManual: null as 'POST' | 'GET' | null,
      };
      const heldStops: Array<{ method: string; respond: () => Promise<void> }> =
        [];
      const heldManual: Array<{ respond: () => Promise<void> }> = [];
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // A real browser and real component, with no request outside this fixture.
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin
          ? route.fallback()
          : route.abort('blockedbyclient'),
      );
      if (options.storageFailure)
        await page.addInitScript(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (this === window.sessionStorage)
              throw new DOMException(
                'fixture storage unavailable',
                'QuotaExceededError',
              );
            original.call(this, key, value);
          };
        });
      await page.route('**/api/v1/scheduled-tasks**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          operationId = url.searchParams.get('operationId');
        requests.push({
          method: request.method(),
          operationId,
          body: request.postDataJSON(),
          url: request.url(),
          principalScope: [
            request.headers()['x-fixture-organization'],
            url.searchParams.get('workspaceId'),
            request.headers()['x-fixture-viewer'],
          ].join('/'),
        });
        if (url.pathname.endsWith('/run')) {
          const id =
            request.method() === 'POST'
              ? (request.postDataJSON() as ManualAutomationRunInput).requestId
              : url.searchParams.get('requestId')!;
          if (request.method() === 'POST')
            manualReceipts.set(
              id,
              manualReceipt(request.postDataJSON() as ManualAutomationRunInput),
            );
          const reply = manualReceipts.get(id),
            respond = () =>
              route.fulfill({
                status: reply ? 202 : 404,
                json: reply ?? { error: 'not_found' },
              });
          if (state.holdManual === request.method()) {
            heldManual.push({ respond });
            return;
          }
          if (request.method() === 'POST' && state.dropManualAck) {
            state.dropManualAck = false;
            await route.abort();
            return;
          }
          await respond();
          return;
        }
        if (url.pathname.endsWith('/stop-occurrence')) {
          if (request.method() === 'POST') state.stopRequested = true;
          const exact =
            request.method() === 'POST'
              ? (request.postDataJSON() as {
                  occurrenceId: string;
                  runId: string;
                })
              : {
                  occurrenceId: url.searchParams.get('occurrenceId')!,
                  runId: url.searchParams.get('runId')!,
                };
          const now = '2026-10-22T01:00:00.000Z';
          const run: RunSnapshot = {
            id: exact.runId,
            organizationId: ORG,
            workspaceId: WORKSPACE,
            ownerId: VIEWER,
            status: state.stopTerminal ? 'canceled' : 'running',
            job: {
              id: OTHER_RUN,
              organizationId: ORG,
              workspaceId: WORKSPACE,
              ownerId: VIEWER,
              status: state.stopTerminal ? 'canceled' : 'running',
              idempotencyKey: 'exact-browser-occurrence',
              priority: 0,
              attempt: 1,
              maxAttempts: 1,
              availableAt: now,
              timeoutAt: now,
              payload: { schemaVersion: 1, type: 'employee.chat', input: {} },
              lease: null,
            },
            cancelRequestedAt: state.stopRequested ? now : null,
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          };
          const reply = {
            taskId: TASK,
            occurrenceId: exact.occurrenceId,
            run,
            canStop: false,
          };
          const respond = () => route.fulfill({ json: reply });
          if (state.holdStop === request.method()) {
            heldStops.push({ method: request.method(), respond });
            return;
          }
          if (request.method() === 'POST' && state.dropStopAck) {
            state.dropStopAck = false;
            await route.abort();
            return;
          }
          await respond();
          return;
        }
        const foreignScope =
          request.headers()['x-fixture-organization'] !== ORG ||
          request.headers()['x-fixture-viewer'] !== VIEWER ||
          url.searchParams.get('workspaceId') !== WORKSPACE;
        if (foreignScope) {
          await route.fulfill({
            status: url.pathname === '/api/v1/scheduled-tasks' ? 200 : 404,
            json:
              url.pathname === '/api/v1/scheduled-tasks'
                ? { tasks: [], nextCursor: null }
                : { message: '当前范围没有该任务。' },
          });
          return;
        }
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON() as ChangeRecurringTaskInput;
          if (task.definition.kind === 'legacy') {
            if (!['pause', 'delete'].includes(body.action))
              return route.fulfill({
                status: 410,
                json: { message: '历史定时任务只读' },
              });
            if (body.expectedRevision !== task.definition.revision)
              return route.fulfill({
                status: 409,
                json: { message: '版本冲突' },
              });
            task.definition.revision++;
            task.revision = task.definition.revision;
            task.definition.status =
              body.action === 'delete' ? 'deleted' : 'paused';
            task.nextRunAt = null;
            if (body.action === 'delete') task.canStop = false;
            return route.fulfill({ json: { task: structuredClone(task) } });
          }
          if (task.definition.kind !== 'recurring')
            throw new Error('fixture kind');
          const current = task.definition.task;
          const rejected = body.expectedRevision !== current.revision;
          if (!rejected) {
            current.revision++;
            task.revision = current.revision;
            if (body.action === 'update') {
              current.name = body.name;
              current.prompt = body.prompt;
              current.rule = body.rule;
              if (body.conversationMode !== undefined)
                current.conversationMode = body.conversationMode;
              task.name = body.name;
              task.prompt = body.prompt;
            } else if (body.action === 'conversation')
              current.conversationMode = body.conversationMode;
            else if (body.action === 'pause') current.status = 'paused';
            else if (body.action === 'resume') current.status = 'enabled';
            else {
              current.status = 'deleted';
              current.canManage = false;
              task.canStop = false;
            }
          }
          const operation: RecurringTaskOperation = {
            operationId: body.operationId,
            taskId: TASK,
            request: body,
            status: rejected ? 'rejected' : 'applied',
            errorMessage: rejected ? '已被其他页面修改' : null,
            task: structuredClone(current),
          };
          operations.set(body.operationId, operation);
          if (state.dropAck) {
            state.dropAck = false;
            await route.abort();
            return;
          }
          await route.fulfill({
            status: rejected ? 409 : 200,
            json: { operation },
          });
          return;
        }
        if (operationId) {
          const operation = operations.get(operationId);
          await route.fulfill({
            json: {
              operation:
                operation && state.mismatch
                  ? {
                      ...operation,
                      request: { ...operation.request, expectedRevision: 999 },
                    }
                  : (operation ?? null),
            },
          });
          return;
        }
        if (url.pathname.endsWith(TASK) || url.pathname.endsWith(OTHER_TASK)) {
          const displayed = structuredClone(task);
          if (url.pathname.endsWith(OTHER_TASK)) {
            displayed.id = OTHER_TASK;
            displayed.name = '另一个任务';
            if (displayed.definition.kind === 'recurring')
              displayed.definition.task.id = OTHER_TASK;
          }
          const differentHistory =
            state.newerHistory || displayed.id === OTHER_TASK;
          await route.fulfill({
            json: {
              task: displayed,
              occurrences: [
                {
                  id: differentHistory ? OTHER_OCCURRENCE : OCCURRENCE,
                  taskId: displayed.id,
                  revision: 1,
                  scheduledAt: '2026-10-21T01:00:00.000Z',
                  status: options.running ? 'running' : 'succeeded',
                  runId: differentHistory ? OTHER_RUN : RUN,
                  sessionId: CHAT,
                  errorMessage: null,
                },
              ],
              nextCursor: null,
            },
          });
          return;
        }
        const filter = url.searchParams.get('query') ?? '';
        await route.fulfill({
          json: {
            tasks:
              task.name.includes(filter) &&
              (task.definition.kind === 'recurring'
                ? task.definition.task.status !== 'deleted'
                : task.definition.kind === 'legacy' &&
                  task.definition.status !== 'deleted')
                ? [task]
                : [],
            nextCursor: null,
          },
        });
      });
      await page.goto(origin);
      await page.getByRole('button', { name: /喝水/ }).waitFor();
      const open = async () => {
        await page.getByRole('button', { name: /喝水/ }).click();
        await page
          .getByRole('textbox', { name: '任务名称', exact: true })
          .waitFor();
      };
      return {
        page,
        task,
        requests,
        state,
        errors,
        heldStops,
        heldManual,
        manualRequests: (method?: string) =>
          requests.filter(
            (r) =>
              new URL(r.url).pathname.endsWith('/run') &&
              (!method || r.method === method),
          ),
        open,
        history: async () => {
          await open();
          await page.getByRole('tab', { name: '任务运行记录' }).click();
          await page
            .getByRole('button', { name: '停止本轮', exact: true })
            .waitFor();
        },
        submitStop: async () => {
          await page
            .getByRole('button', { name: '停止本轮', exact: true })
            .click();
          await page
            .getByRole('button', { name: '确认停止本轮', exact: true })
            .click();
        },
        stopRequests: (method?: string) =>
          requests.filter(
            (r) =>
              new URL(r.url).pathname.endsWith('/stop-occurrence') &&
              (!method || r.method === method),
          ),
        close: () => page.close(),
      };
    }
    it.each([1440, 390])(
      'shows legacy history read-only, allows pause/delete, and never resumes or starts work at %ipx',
      async (width) => {
        const f = await fixture(width);
        f.task.definition = {
          kind: 'legacy',
          schedule: {
            frequency: 'daily',
            time: '09:00',
            timezone: 'Asia/Shanghai',
          },
          status: 'enabled',
          revision: 1,
          canManage: false,
        };
        try {
          await f.page.getByRole('button', { name: /喝水/ }).click();
          await f.page
            .getByText(
              '历史任务支持查看、暂停和删除。后续执行请在对话中创建新任务。',
              { exact: true },
            )
            .waitFor();
          expect(
            await f.page
              .getByRole('textbox', { name: '任务名称', exact: true })
              .count(),
          ).toBe(0);
          expect(
            await f.page
              .getByRole('button', { name: '保存修改', exact: true })
              .count(),
          ).toBe(0);
          expect(
            await f.page
              .getByRole('button', { name: '恢复任务', exact: true })
              .count(),
          ).toBe(0);
          await f.page
            .getByRole('button', { name: '暂停任务', exact: true })
            .click();
          await f.page.getByText('设置已更新。', { exact: true }).waitFor();
          expect(f.task.definition.status).toBe('paused');
          expect(
            await f.page
              .getByRole('button', { name: '恢复任务', exact: true })
              .count(),
          ).toBe(0);
          await f.page
            .getByRole('button', { name: '删除任务', exact: true })
            .click();
          await f.page
            .getByRole('button', { name: '确认删除', exact: true })
            .click();
          await expect
            .poll(
              () =>
                f.task.definition.kind === 'legacy' && f.task.definition.status,
            )
            .toBe('deleted');
          expect(
            f.requests.filter((r) => r.method === 'PATCH').map((r) => r.body),
          ).toEqual([
            { action: 'pause', expectedRevision: 1 },
            { action: 'delete', expectedRevision: 2 },
          ]);
          expect(f.requests.filter((r) => r.method === 'POST')).toEqual([]);
          expect(f.errors).toEqual([]);
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
    it.each([1280, 390])(
      'edits a weekly rule in the unified right panel, preserves seconds and discards unsaved days at %ipx',
      async (width) => {
        const f = await fixture(width);
        try {
          if (f.task.definition.kind !== 'recurring')
            throw Error('fixture kind');
          f.task.definition.task.rule = {
            kind: 'weekly',
            weekdays: [1, 3],
            time: '09:30:05',
            timezone: 'Asia/Shanghai',
          };
          await f.open();
          expect(
            await f.page
              .getByRole('combobox', { name: '重复', exact: true })
              .inputValue(),
          ).toBe('weekly');
          expect(
            await f.page.getByLabel('周一', { exact: true }).isChecked(),
          ).toBe(true);
          expect(
            await f.page.getByLabel('周三', { exact: true }).isChecked(),
          ).toBe(true);
          await f.page.getByLabel('周一', { exact: true }).uncheck();
          await f.page.getByLabel('周日', { exact: true }).check();
          await f.page
            .getByRole('button', { name: '显示或隐藏右栏', exact: true })
            .click();
          await f.page
            .getByRole('button', { name: '显示或隐藏右栏', exact: true })
            .click();
          expect(
            await f.page.getByLabel('周一', { exact: true }).isChecked(),
          ).toBe(true);
          expect(
            await f.page.getByLabel('周日', { exact: true }).isChecked(),
          ).toBe(false);
          expect(
            f.requests.filter((request) => request.method === 'PATCH'),
          ).toHaveLength(0);
          await f.page.getByLabel('周一', { exact: true }).uncheck();
          await f.page.getByLabel('周日', { exact: true }).check();
          await f.page
            .getByRole('button', { name: '保存修改', exact: true })
            .click();
          await f.page.getByText('设置已更新。', { exact: true }).waitFor();
          expect(
            f.requests.filter((request) => request.method === 'PATCH'),
          ).toEqual([
            expect.objectContaining({
              body: expect.objectContaining({
                expectedRevision: 1,
                action: 'update',
                rule: {
                  kind: 'weekly',
                  weekdays: [3, 7],
                  time: '09:30:05',
                  timezone: 'Asia/Shanghai',
                },
              }),
            }),
          ]);
          await f.page.reload();
          await f.open();
          expect(
            await f.page.getByLabel('周三', { exact: true }).isChecked(),
          ).toBe(true);
          expect(
            await f.page.getByLabel('周日', { exact: true }).isChecked(),
          ).toBe(true);
          expect(
            await f.page.getByLabel('周一', { exact: true }).isChecked(),
          ).toBe(false);
          expect(f.task.definition.task.rule.time).toBe('09:30:05');
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
    );
    it.each([1440, 390])(
      'changes only the conversation mode in the unified editor and retains its source, clock and history at %ipx',
      async (width) => {
        const f = await fixture(width);
        try {
          if (f.task.definition.kind !== 'recurring')
            throw Error('fixture kind');
          const before = structuredClone(f.task.definition.task),
            sourceSession = f.task.sessionId;
          await f.open();
          await f.page
            .getByRole('combobox', { name: '在哪个对话里执行', exact: true })
            .selectOption('new_each_run');
          await f.page
            .getByRole('button', { name: '保存修改', exact: true })
            .click();
          await f.page.getByText('设置已更新。', { exact: true }).waitFor();
          const writes = f.requests.filter((r) => r.method === 'PATCH');
          expect(writes).toHaveLength(1);
          const input = ChangeRecurringTaskInputSchema.parse(writes[0]!.body);
          expect(input).toEqual({
            operationId: input.operationId,
            expectedRevision: before.revision,
            action: 'conversation',
            conversationMode: 'new_each_run',
          });
          expect(f.task.sessionId).toBe(sourceSession);
          expect(f.task.definition.task).toEqual({
            ...before,
            revision: before.revision + 1,
            conversationMode: 'new_each_run',
          });
          await f.page.reload();
          await f.open();
          expect(
            await f.page
              .getByRole('combobox', { name: '在哪个对话里执行', exact: true })
              .inputValue(),
          ).toBe('new_each_run');
          expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(
            1,
          );
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([1440, 390])(
      'reads and edits monthly in the unified right panel with exact CAS and unchanged history at %ipx',
      async (width) => {
        const f = await fixture(width);
        try {
          if (f.task.definition.kind !== 'recurring')
            throw Error('fixture kind');
          const current = f.task.definition.task;
          current.rule = {
            kind: 'monthly',
            monthDay: 31,
            time: '02:30:17',
            timezone: 'America/New_York',
          };
          current.revision = 7;
          f.task.revision = 7;
          const original = structuredClone(current);
          // Refresh the list too: the initial fixture loads before this rule is set.
          await f.page.reload();
          await f.page
            .getByText('每月 31 日 02:30:17 · America/New_York', {
              exact: true,
            })
            .waitFor();
          const isDetailRead = (response: {
            url(): string;
            request(): { method(): string };
          }) => {
            const url = new URL(response.url());
            return (
              response.request().method() === 'GET' &&
              url.pathname === '/api/v1/scheduled-tasks/' + TASK &&
              !url.searchParams.has('operationId')
            );
          };
          const beforeRead = f.page.waitForResponse(isDetailRead);
          await f.open();
          const before = await (await beforeRead).json();
          const detail = f.page.getByRole('region', {
              name: '自动化任务详情：喝水',
              exact: true,
            }),
            frequency = detail.getByRole('combobox', {
              name: '重复',
              exact: true,
            });
          expect(await frequency.inputValue()).toBe('monthly');
          expect(await frequency.isEnabled()).toBe(true);
          // isDisabled on a labeled option can retarget to its select in PW.
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
          expect(
            await detail.getByLabel('每月日期', { exact: true }).inputValue(),
          ).toBe('31');
          expect(
            await detail.getByLabel('执行时间', { exact: true }).inputValue(),
          ).toBe('02:30');
          expect(
            await detail.getByLabel('时区', { exact: true }).inputValue(),
          ).toBe('America/New_York');
          await detail
            .getByText(
              /不存在的日期按当月最后一天；夏令时缺失时间顺延，重复时间只执行一次；停机后只处理最近一期。原时间含秒，未修改分钟时保留原秒数。/,
            )
            .waitFor();
          expect(before.occurrences).toEqual([
            {
              id: OCCURRENCE,
              taskId: TASK,
              revision: 1,
              scheduledAt: '2026-10-21T01:00:00.000Z',
              status: 'succeeded',
              runId: RUN,
              sessionId: CHAT,
              errorMessage: null,
            },
          ]);
          await detail.getByRole('tab', { name: '任务运行记录' }).click();
          await detail.getByText('已完成', { exact: true }).waitFor();
          const historyText = await detail.locator('article').innerText();
          await detail.getByRole('tab', { name: '规则', exact: true }).click();
          await detail.getByLabel('每月日期', { exact: true }).fill('30');
          const afterRead = f.page.waitForResponse(isDetailRead);
          await detail
            .getByRole('button', { name: '保存修改', exact: true })
            .click();
          await detail.getByText('设置已更新。', { exact: true }).waitFor();
          const after = await (await afterRead).json(),
            edits = f.requests.filter((request) => request.method === 'PATCH');
          expect(edits).toHaveLength(1);
          const edit = edits[0]!,
            input = ChangeRecurringTaskInputSchema.parse(edit.body),
            editUrl = new URL(edit.url);
          expect(editUrl.pathname).toBe('/api/v1/scheduled-tasks/' + TASK);
          expect(editUrl.searchParams.get('workspaceId')).toBe(WORKSPACE);
          expect(edit.principalScope).toBe([ORG, WORKSPACE, VIEWER].join('/'));
          expect(input).toEqual({
            operationId: input.operationId,
            expectedRevision: 7,
            action: 'update',
            name: original.name,
            prompt: original.prompt,
            conversationMode: 'reuse',
            rule: {
              kind: 'monthly',
              monthDay: 30,
              time: '02:30:17',
              timezone: 'America/New_York',
            },
          });
          expect(after.task.id).toBe(TASK);
          expect(after.task.sessionId).toBe(CHAT);
          expect(after.task.definition.task.clientRequestId).toBe(
            original.clientRequestId,
          );
          expect(after.task.definition.task.revision).toBe(8);
          expect(after.occurrences).toEqual(before.occurrences);
          await f.page.reload();
          await f.page
            .getByText('每月 30 日 02:30:17 · America/New_York', {
              exact: true,
            })
            .waitFor();
          await f.open();
          expect(
            await detail.getByLabel('每月日期', { exact: true }).inputValue(),
          ).toBe('30');
          expect(await frequency.inputValue()).toBe('monthly');
          await detail.getByRole('tab', { name: '任务运行记录' }).click();
          await detail.getByText('已完成', { exact: true }).waitFor();
          expect(await detail.locator('article').innerText()).toBe(historyText);
          await detail
            .getByRole('button', { name: '查看本轮结果 ↗', exact: true })
            .click();
          expect(await f.page.getByLabel('原会话').textContent()).toBe(CHAT);
          expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(
            1,
          );
          expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
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
    );
    it.each([1280, 390])(
      'supports catalog, saved edits, history and original chat at %ipx',
      async (width) => {
        const f = await fixture(width);
        try {
          await f.open();
          expect(
            await f.page
              .getByRole('spinbutton', { name: '重复间隔（分钟）' })
              .inputValue(),
          ).toBe('2');
          await f.page
            .getByRole('textbox', { name: '工作内容', exact: true })
            .fill('提醒用户喝水，不要重复创建任务');
          await f.page
            .getByRole('button', { name: '保存修改', exact: true })
            .click();
          await f.page.getByText('设置已更新。', { exact: true }).waitFor();
          expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(
            1,
          );
          await f.page.getByRole('tab', { name: '任务运行记录' }).click();
          await f.page.getByRole('button', { name: '查看本轮结果 ↗' }).click();
          expect(await f.page.getByLabel('原会话').textContent()).toBe(CHAT);
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it('recovers a lost write acknowledgement from the exact receipt, without repeating PATCH', async () => {
      const f = await fixture();
      try {
        await f.open();
        f.state.dropAck = true;
        await f.page
          .getByRole('button', { name: '暂停任务', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '恢复任务', exact: true })
          .waitFor();
        expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
        expect(f.requests.some((r) => r.operationId !== null)).toBe(true);
        const raw = await f.page.evaluate(() => JSON.stringify(sessionStorage));
        expect(raw).not.toMatch(/never-persist|headers|credential/);
        await f.page.reload();
        await f.open();
        expect(
          await f.page
            .getByRole('button', { name: '恢复任务', exact: true })
            .count(),
        ).toBe(1);
        expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
    it('does not treat a mismatched receipt as success and retains it across remount', async () => {
      const f = await fixture();
      try {
        await f.open();
        f.state.dropAck = true;
        f.state.mismatch = true;
        await f.page
          .getByRole('button', { name: '暂停任务', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '检查操作结果', exact: true })
          .waitFor();
        await f.page.reload();
        await f.open();
        await f.page
          .getByRole('button', { name: '检查操作结果', exact: true })
          .waitFor();
        expect(
          await f.page
            .getByRole('button', { name: '恢复任务', exact: true })
            .isDisabled(),
        ).toBe(true);
        expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
        f.state.mismatch = false;
        await f.page
          .getByRole('button', { name: '检查操作结果', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '恢复任务', exact: true })
          .waitFor();
        await expect
          .poll(() =>
            f.page
              .getByRole('button', { name: '恢复任务', exact: true })
              .isEnabled(),
          )
          .toBe(true);
      } finally {
        await f.close();
      }
    });
    it('confirms deletion and removes it from the catalog without executing work', async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page
          .getByRole('button', { name: '删除任务', exact: true })
          .click();
        expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
        await f.page
          .getByRole('button', { name: '确认删除', exact: true })
          .click();
        await f.page.getByText('设置已更新。', { exact: true }).waitFor();
        await f.page.getByRole('button', { name: '显示或隐藏右栏' }).click();
        await f.page.getByText('还没有自动化任务', { exact: true }).waitFor();
        expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
    it('sends zero stop POSTs when this component cannot persist its exact target', async () => {
      const f = await fixture(1280, { running: true, storageFailure: true });
      try {
        await f.history();
        await f.submitStop();
        await f.page.getByText(/浏览器没能记下这次请求/).waitFor();
        expect(f.stopRequests('POST')).toEqual([]);
        expect(f.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
        expect(
          await f.page
            .getByRole('button', { name: '停止本轮', exact: true })
            .isDisabled(),
        ).toBe(true);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('restores the original stop as GET-only even when a different occurrence now appears in history', async () => {
      const f = await fixture(1280, { running: true });
      try {
        await f.history();
        // History mounting does not fan out into per-Run reads or polling.
        expect(f.stopRequests()).toEqual([]);
        f.state.dropStopAck = true;
        await f.submitStop();
        const check = f.page.getByRole('button', {
          name: '检查本轮停止结果',
          exact: true,
        });
        await expect.poll(() => check.isEnabled()).toBe(true);
        expect(f.stopRequests('POST')).toHaveLength(1);
        const saved = await f.page.evaluate(() =>
          JSON.stringify(sessionStorage),
        );
        expect(saved).toContain(OCCURRENCE);
        expect(saved).toContain(RUN);
        expect(saved).not.toMatch(/never-persist|headers|credential/);
        f.state.newerHistory = true;
        await f.page.reload();
        await f.history();
        await check.waitFor();
        expect(f.stopRequests('POST')).toHaveLength(1);
        expect(f.stopRequests('GET')).toHaveLength(0);
        expect(
          await f.page
            .getByRole('button', { name: '停止本轮', exact: true })
            .isDisabled(),
        ).toBe(true);
        await check.click();
        await f.page
          .getByText(
            '已请求停止本轮，等待执行退出。可检查本轮结果；未来计划仍按原设置执行。',
            { exact: true },
          )
          .waitFor();
        expect(f.stopRequests('POST')).toHaveLength(1);
        const reads = f.stopRequests('GET');
        expect(reads).toHaveLength(1);
        expect(Object.fromEntries(new URL(reads[0]!.url).searchParams)).toEqual(
          { workspaceId: WORKSPACE, occurrenceId: OCCURRENCE, runId: RUN },
        );
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('keeps stop occurrence distinct from future plan pause and delete controls', async () => {
      const f = await fixture(1280, { running: true });
      try {
        await f.history();
        const originalPlan = structuredClone(f.task);
        await f.submitStop();
        await f.page
          .getByText(
            '已请求停止本轮，等待执行退出。可检查本轮结果；未来计划仍按原设置执行。',
            { exact: true },
          )
          .waitFor();
        expect(f.stopRequests('POST').map((r) => r.body)).toEqual([
          { occurrenceId: OCCURRENCE, runId: RUN },
        ]);
        expect(f.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
        expect(f.task).toEqual(originalPlan);
        await f.page.getByRole('tab', { name: '规则', exact: true }).click();
        await f.page
          .getByRole('button', { name: '暂停任务', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '恢复任务', exact: true })
          .waitFor();
        await f.page
          .getByRole('button', { name: '删除任务', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '确认删除', exact: true })
          .click();
        await expect
          .poll(
            () =>
              f.task.definition.kind === 'recurring' &&
              f.task.definition.task.status,
          )
          .toBe('deleted');
        expect(
          f.requests
            .filter((r) => r.method === 'PATCH')
            .map((r) => (r.body as ChangeRecurringTaskInput).action),
        ).toEqual(['pause', 'delete']);
        expect(f.stopRequests('POST')).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('creates one explicit manual Run from a paused plan without PATCH or future-time changes', async () => {
      const f = await fixture(1280, { manual: true });
      try {
        if (f.task.definition.kind !== 'recurring') throw Error('fixture kind');
        f.task.definition.task.status = 'paused';
        const before = structuredClone(f.task);
        await f.open();
        await f.page
          .getByRole('button', { name: '立即执行', exact: true })
          .click();
        await f.page
          .getByText(
            '已创建本次立即执行，可在运行记录查看结果。原定计划保持不变。',
            { exact: true },
          )
          .waitFor();
        expect(f.manualRequests('POST')).toHaveLength(1);
        expect(f.manualRequests('POST')[0]!.body).toMatchObject({
          requestId: expect.any(String),
          expectedRevision: 1,
        });
        expect(f.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
        expect(f.task).toEqual(before);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('sends zero manual POST when session storage cannot persist the request', async () => {
      const f = await fixture(1280, { manual: true, storageFailure: true });
      try {
        await f.open();
        await f.page
          .getByRole('button', { name: '立即执行', exact: true })
          .click();
        await f.page.getByText(/浏览器没能记下这次请求/).waitFor();
        expect(f.manualRequests()).toHaveLength(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('restores a lost manual ACK as user-triggered GET of the original request despite a later plan revision', async () => {
      const f = await fixture(1280, { manual: true });
      try {
        await f.open();
        f.state.dropManualAck = true;
        await f.page
          .getByRole('button', { name: '立即执行', exact: true })
          .click();
        const check = () =>
          f.page.getByRole('button', { name: '检查立即执行结果', exact: true });
        await expect.poll(() => check().isEnabled()).toBe(true);
        const original = f.manualRequests('POST')[0]!
            .body as ManualAutomationRunInput,
          key = manualRunStorageKey(
            [ORG, WORKSPACE, VIEWER].join('/'),
            WORKSPACE,
            TASK,
          );
        const saved = await f.page.evaluate(
          (k) => sessionStorage.getItem(k),
          key,
        );
        expect(saved).not.toContain('never-persist');
        f.task.revision = 9;
        if (f.task.definition.kind === 'recurring')
          f.task.definition.task.revision = 9;
        await f.page
          .getByRole('button', { name: '显示或隐藏右栏', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '显示或隐藏右栏', exact: true })
          .click();
        await check().waitFor();
        expect(f.manualRequests('POST')).toHaveLength(1);
        expect(f.manualRequests('GET')).toHaveLength(0);
        await check().click();
        await f.page
          .getByText(
            '已创建本次立即执行，可在运行记录查看结果。原定计划保持不变。',
            { exact: true },
          )
          .waitFor();
        expect(f.manualRequests('POST')).toHaveLength(1);
        expect(f.manualRequests('GET')).toHaveLength(1);
        expect(
          new URL(f.manualRequests('GET')[0]!.url).searchParams.get(
            'requestId',
          ),
        ).toBe(original.requestId);
        expect(original.expectedRevision).toBe(1);
        expect(
          await f.page.evaluate((k) => sessionStorage.getItem(k), key),
        ).toBeNull();
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    const scopeChanges = [
      {
        label: '组织',
        organizationId: OTHER_ORG,
        workspaceId: WORKSPACE,
        viewerId: VIEWER,
        taskId: TASK,
      },
      {
        label: '工作区',
        organizationId: ORG,
        workspaceId: OTHER_WORKSPACE,
        viewerId: VIEWER,
        taskId: TASK,
      },
      {
        label: '用户',
        organizationId: ORG,
        workspaceId: WORKSPACE,
        viewerId: OTHER_VIEWER,
        taskId: TASK,
      },
      {
        label: '任务',
        organizationId: ORG,
        workspaceId: WORKSPACE,
        viewerId: VIEWER,
        taskId: OTHER_TASK,
      },
    ];
    it.each(scopeChanges)(
      'ignores an old in-flight stop POST after changing $label',
      async (change) => {
        const f = await fixture(1280, { running: true });
        try {
          await f.history();
          f.state.holdStop = 'POST';
          f.state.stopTerminal = true;
          await f.submitStop();
          await expect.poll(() => f.heldStops.length).toBe(1);
          await verifyOldResponseIsolation(f, change);
          expect(f.stopRequests('POST')).toHaveLength(1);
          expect(f.stopRequests('GET')).toHaveLength(0);
        } finally {
          await f.close();
        }
      },
    );
    it.each(scopeChanges)(
      'ignores an old in-flight exact readback GET after changing $label',
      async (change) => {
        const f = await fixture(1280, { running: true });
        try {
          await f.history();
          f.state.dropStopAck = true;
          await f.submitStop();
          const check = f.page.getByRole('button', {
            name: '检查本轮停止结果',
            exact: true,
          });
          await expect.poll(() => check.isEnabled()).toBe(true);
          f.state.holdStop = 'GET';
          f.state.stopTerminal = true;
          await check.click();
          await expect.poll(() => f.heldStops.length).toBe(1);
          await verifyOldResponseIsolation(f, change);
          expect(f.stopRequests('POST')).toHaveLength(1);
          expect(f.stopRequests('GET')).toHaveLength(1);
          const target = new URL(f.stopRequests('GET')[0]!.url);
          expect(target.searchParams.get('occurrenceId')).toBe(OCCURRENCE);
          expect(target.searchParams.get('runId')).toBe(RUN);
        } finally {
          await f.close();
        }
      },
    );
    it.each(
      scopeChanges.flatMap((change) =>
        ['POST', 'GET'].map((method) => ({ ...change, method })),
      ),
    )(
      'ignores an old manual $method response after changing $label',
      async (change) => {
        const f = await fixture(1280, { manual: true });
        try {
          await f.open();
          if (change.method === 'GET') f.state.dropManualAck = true;
          else f.state.holdManual = 'POST';
          await f.page
            .getByRole('button', { name: '立即执行', exact: true })
            .click();
          if (change.method === 'GET') {
            const check = f.page.getByRole('button', {
              name: '检查立即执行结果',
              exact: true,
            });
            await expect.poll(() => check.isEnabled()).toBe(true);
            f.state.holdManual = 'GET';
            await check.click();
          }
          await expect.poll(() => f.heldManual.length).toBe(1);
          const oldScope = [ORG, WORKSPACE, VIEWER].join('/'),
            key = manualRunStorageKey(oldScope, WORKSPACE, TASK),
            saved = await f.page.evaluate(
              (k) => sessionStorage.getItem(k),
              key,
            );
          expect(saved).not.toBeNull();
          await f.page
            .getByRole('button', { name: '切换' + change.label, exact: true })
            .click();
          if (change.taskId === OTHER_TASK)
            await f.page
              .getByRole('heading', { name: '另一个任务', exact: true })
              .waitFor();
          else
            await f.page
              .getByText('当前范围没有该任务。', { exact: true })
              .waitFor();
          const oldReads = () =>
              f.requests.filter(
                (r) =>
                  r.method === 'GET' &&
                  r.principalScope === oldScope &&
                  new URL(r.url).pathname === `/api/v1/scheduled-tasks/${TASK}`,
              ).length,
            before = oldReads(),
            delivered = f.page.waitForResponse(
              (r) => r.url() === f.manualRequests().at(-1)!.url,
            );
          await f.heldManual[0]!.respond();
          await (await delivered).finished();
          await f.page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
          );
          expect(
            await f.page
              .getByText(
                '已创建本次立即执行，可在运行记录查看结果。原定计划保持不变。',
                { exact: true },
              )
              .count(),
          ).toBe(0);
          expect(
            await f.page
              .getByRole('button', { name: '检查立即执行结果', exact: true })
              .count(),
          ).toBe(0);
          expect(
            await f.page.evaluate((k) => sessionStorage.getItem(k), key),
          ).toBe(saved);
          expect(
            await f.page.evaluate(
              (k) => sessionStorage.getItem(k),
              manualRunStorageKey(
                [
                  change.organizationId,
                  change.workspaceId,
                  change.viewerId,
                ].join('/'),
                change.workspaceId,
                change.taskId,
              ),
            ),
          ).toBeNull();
          expect(oldReads()).toBe(before);
          expect(f.manualRequests('POST')).toHaveLength(1);
          expect(f.manualRequests('GET')).toHaveLength(
            change.method === 'GET' ? 1 : 0,
          );
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    async function verifyOldResponseIsolation(
      f: Awaited<ReturnType<typeof fixture>>,
      change: (typeof scopeChanges)[number],
    ) {
      const oldScope = [ORG, WORKSPACE, VIEWER].join('/');
      const oldKey = stopOccurrenceStorageKey(oldScope, WORKSPACE, TASK);
      const saved = await f.page.evaluate(
        (key) => sessionStorage.getItem(key),
        oldKey,
      );
      expect(saved).not.toBeNull();
      await f.page
        .getByRole('button', { name: '切换' + change.label, exact: true })
        .click();
      if (change.taskId === OTHER_TASK)
        await f.page
          .getByRole('heading', { name: '另一个任务', exact: true })
          .waitFor();
      else
        await f.page
          .getByText('当前范围没有该任务。', { exact: true })
          .waitFor();
      const oldHistoryReads = () =>
        f.requests.filter(
          (r) =>
            r.method === 'GET' &&
            r.principalScope === oldScope &&
            new URL(r.url).pathname === `/api/v1/scheduled-tasks/${TASK}`,
        ).length;
      const before = oldHistoryReads();
      const delivered = f.page.waitForResponse(
        (response) => response.url() === f.stopRequests().at(-1)!.url,
      );
      await f.heldStops[0]!.respond();
      await (await delivered).finished();
      await f.page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      expect(
        await f.page
          .getByText('本轮已取消。未来计划仍按原设置执行。', { exact: true })
          .count(),
      ).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '检查本轮停止结果', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await f.page.evaluate((key) => sessionStorage.getItem(key), oldKey),
      ).toBe(saved);
      const currentKey = stopOccurrenceStorageKey(
        [change.organizationId, change.workspaceId, change.viewerId].join('/'),
        change.workspaceId,
        change.taskId,
      );
      expect(
        await f.page.evaluate((key) => sessionStorage.getItem(key), currentKey),
      ).toBeNull();
      expect(oldHistoryReads()).toBe(before);
      expect(f.errors).toEqual([]);
    }
  },
);
