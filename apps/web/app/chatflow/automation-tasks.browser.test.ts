/** Real React/Chrome interaction; synthetic HTTP only. SQL authority is tested separately. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import type {
  AutomationCatalogTask,
  ChangeRecurringTaskInput,
  RecurringTaskOperation,
} from '@allrice/contracts';

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
  TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
      const scope='${ORG}/${WORKSPACE}/${VIEWER}',headers={'x-fixture-viewer':'${VIEWER}','x-test-secret':'never-persist'};
      function Fixture(){const [selected,setSelected]=useState(null),[opened,setOpened]=useState(''),[hide,setHide]=useState(false),[mode,setMode]=useState('list');
        return <><button onClick={()=>setHide(v=>!v)}>显示或隐藏右栏</button><button onClick={()=>setMode('list')}>返回任务列表</button>
        <div style={{display:'flex',height:'calc(100vh - 50px)',minWidth:0}}>
          {mode==='list'&&<div className="list"><AutomationTaskList workspaceId="${WORKSPACE}" scope={scope} headers={headers} employees={[{id:'${EMPLOYEE}',name:'Rice'}]} selectedId={selected?.id} onSelect={setSelected} onNew={()=>setMode('new')}/></div>}
          {mode==='new'&&<p>说明时间和工作内容，创建新的任务</p>}
          {selected&&!hide&&<aside className="detail"><AutomationTaskDetail taskId={selected.id} active={!hide} workspaceId="${WORKSPACE}" scope={scope} headers={headers} onOpenSession={setOpened}/></aside>}
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
    async function fixture(width = 1280) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        task = entry(),
        requests: Array<{
          method: string;
          operationId: string | null;
          body: unknown;
        }> = [],
        operations = new Map<string, RecurringTaskOperation>();
      const state = { dropAck: false, mismatch: false };
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/api/v1/scheduled-tasks**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          operationId = url.searchParams.get('operationId');
        requests.push({
          method: request.method(),
          operationId,
          body: request.postDataJSON(),
        });
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON() as ChangeRecurringTaskInput;
          if (task.definition.kind !== 'recurring')
            throw new Error('fixture kind');
          const current = task.definition.task;
          const rejected = body.expectedRevision !== current.revision;
          if (!rejected) {
            current.revision++;
            if (body.action === 'update') {
              current.name = body.name;
              current.prompt = body.prompt;
              current.rule = body.rule;
              task.name = body.name;
              task.prompt = body.prompt;
            } else if (body.action === 'pause') current.status = 'paused';
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
        if (url.pathname.endsWith(TASK)) {
          await route.fulfill({
            json: {
              task,
              occurrences: [
                {
                  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  taskId: TASK,
                  revision: 1,
                  scheduledAt: '2026-10-21T01:00:00.000Z',
                  status: 'succeeded',
                  runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
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
              task.definition.kind === 'recurring' &&
              task.definition.task.status !== 'deleted'
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
        open,
        close: () => page.close(),
      };
    }
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
        await f.page
          .getByText('没有匹配的自动化任务', { exact: true })
          .waitFor();
        expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  },
);
