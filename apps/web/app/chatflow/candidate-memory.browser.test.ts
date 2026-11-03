/** Real cookie auth, memory HTTP routes and isolated PG; only host/transport is
 * synthetic. The separate Worker matrix covers model -> broker -> storage. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, WorkspaceMemorySchema } from '@allrice/contracts';
import type { z } from 'zod';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import {
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createTraceableMemory,
  listWorkspaceMemories,
} from '../../../../packages/database/src/workspace/service.ts';
import { GET as list, POST as create } from '../api/v1/memories/route';
import { POST as promote } from '../api/v1/memories/[id]/promote/route';
import {
  DELETE as discard,
  PATCH as correct,
} from '../api/v1/memories/[id]/route';

const ports = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: ports.cookies }));
const requests = new AsyncLocalStorage<Request>();
type WorkspaceMemory = z.infer<typeof WorkspaceMemorySchema>;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('candidate memory: real auth/API/PG + both product hosts', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let identity: Awaited<ReturnType<typeof createRunAuthorityFixture>>;
  let foreign: Awaited<ReturnType<typeof createRunAuthorityFixture>>;
  let owner: RequestContext, reader: RequestContext;
  let ownerToken: string, readerToken: string, foreignToken: string;
  let otherWorkspace: string, browser: Browser, server: Server, origin: string;
  let candidate: WorkspaceMemory, shared: WorkspaceMemory;
  const failures: string[] = [],
    mutations: string[] = [];
  const screenshots = resolve('.local/quality/candidate-memory-entry');
  let loseAckFor = '',
    failDeleteFor = '';

  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    identity = await createRunAuthorityFixture(f.db);
    foreign = await createRunAuthorityFixture(f.db);
    ownerToken = (await createSession(identity.user)).token;
    foreignToken = (await createSession(foreign.user)).token;
    owner = (await authenticateSession(ownerToken, {
      organizationId: identity.org,
      workspaceId: identity.workspace,
    }))!;
    const readerId = randomUUID();
    await f.db`insert into allrice_users(id,email,display_name,password_hash) values(${readerId},${readerId + '@example.test'},'Reader','not-login')`;
    await f.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${identity.org},${identity.workspace},${readerId},'member')`;
    readerToken = (await createSession(readerId)).token;
    reader = (await authenticateSession(readerToken, {
      organizationId: identity.org,
      workspaceId: identity.workspace,
    }))!;
    otherWorkspace = randomUUID();
    await f.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${otherWorkspace},${identity.org},'other','Other')`;
    await f.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${identity.org},${otherWorkspace},${identity.user},'admin')`;
    candidate = await remember('真实候选：看数据时先看表格，再看文字说明。');
    shared = await createTraceableMemory(reader, {
      workspaceId: identity.workspace,
      content: '他人的工作区可见候选',
      visibility: 'workspace',
      sourceType: 'user',
      sourceLabel: 'fixture',
      lifecycleState: 'candidate',
      memoryClass: 'work_note',
    });
    // Only Next's per-request cookie accessor is adapted to the fixture server.
    // getRequestContext, authenticateSession and scope validation stay real.
    ports.cookies.mockImplementation(async () => ({
      get(name: string) {
        const cookie = requests.getStore()?.headers.get('cookie') ?? '';
        const value = cookie
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(name + '='))
          ?.slice(name.length + 1);
        return value ? { value } : undefined;
      },
    }));
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['apps/web/test/candidate-memory-page.tsx'],
      bundle: true,
      format: 'esm',
      splitting: true,
      platform: 'browser',
      write: false,
      outdir: '/unused-candidate-memory',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      built.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, origin);
        if (url.pathname === '/fixture') {
          const [run] =
            await f.db`select user_message_id,assistant_message_id from allrice_employee_runs where run_id=${identity.rootRunId}`;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              organizationId: identity.org,
              workspaceId: identity.workspace,
              otherWorkspaceId: otherWorkspace,
              runId: identity.rootRunId,
              userMessageId: run!.user_message_id,
              assistantMessageId: run!.assistant_message_id,
              sessionId: identity.session,
              assignmentId: identity.assignment,
              versionId: identity.version,
            }),
          );
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (typeof value === 'string') headers.set(key, value);
          const request = new Request(url, {
            method: req.method,
            headers,
            ...(chunks.length
              ? { body: Buffer.concat(chunks).toString('utf8') }
              : {}),
          });
          const parts = url.pathname.split('/'),
            id = parts[4] ?? '';
          const result = await requests.run(request, async () => {
            // Exercise the real restoreHistory/loadRunTrace client with a
            // disconnected partial SSE view and a complete immutable trace.
            if (
              parts[3] === 'runs' &&
              parts[4] === identity.rootRunId &&
              parts[5] === 'events' &&
              req.method === 'GET'
            ) {
              const event = (
                sequence: number,
                type: 'harness.native' | 'tool.completed',
                payload: Record<string, unknown>,
              ) => ({
                schemaVersion: 3,
                eventId: sequence === 1 ? identity.employee : identity.version,
                organizationId: identity.org,
                workspaceId: identity.workspace,
                conversationId: identity.session,
                runId: identity.rootRunId,
                generation: 1,
                sequence,
                cursor: `${identity.rootRunId}:${sequence}`,
                harness: 'dsh',
                occurredAt: new Date().toISOString(),
                sourceEvent: null,
                type,
                payload,
              });
              const early = event(1, 'harness.native', {
                sourceEventType: 'synthetic-early',
              });
              return url.searchParams.get('format') === 'json'
                ? Response.json({
                    events: [
                      early,
                      event(2, 'tool.completed', {
                        name: 'workspace_memory_remember',
                        toolCallId: 'recovered-remember',
                      }),
                    ],
                  })
                : new Response('data: ' + JSON.stringify(early) + '\n\n', {
                    headers: { 'content-type': 'text/event-stream' },
                  });
            }
            // Unrelated existing transcript host dependency, no operations.
            if (
              url.pathname === '/api/v1/runtime/cloud-operations' &&
              req.method === 'GET'
            )
              return Response.json({ operations: [] });
            if (parts[3] !== 'memories') {
              failures.push(
                'Unexpected API/model request: ' +
                  request.method +
                  ' ' +
                  url.pathname,
              );
              return new Response(null, { status: 404 });
            }
            if (req.method !== 'GET')
              mutations.push(request.method + ' ' + url.pathname);
            if (req.method === 'DELETE' && id === failDeleteFor)
              return Response.json({}, { status: 503 });
            const params = { params: Promise.resolve({ id }) };
            const response = !id
              ? req.method === 'POST'
                ? await create(request)
                : await list(request)
              : req.method === 'DELETE'
                ? await discard(request, params)
                : req.method === 'PATCH'
                  ? await correct(request, params)
                  : await promote(request, params);
            if (id === loseAckFor && parts[5] === 'promote' && response.ok) {
              loseAckFor = '';
              return Response.json({}, { status: 503 });
            }
            return response;
          });
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(Buffer.from(await result.arrayBuffer()));
          return;
        }
        const asset = assets.get(url.pathname);
        res.writeHead(200, {
          'content-type': url.pathname.endsWith('.js')
            ? 'application/javascript'
            : url.pathname.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        });
        res.end(
          asset ??
            '<html data-theme="light" data-ds-theme="light" style="color-scheme:light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/candidate-memory-page.css"></head><body style="margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)"><div id="root"></div><script type="module" src="/candidate-memory-page.js"></script></body></html>',
        );
      } catch (error) {
        failures.push(String(error));
        res.writeHead(500);
        res.end('{}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No fixture port');
    origin = 'http://127.0.0.1:' + address.port;
    const { chromium } = createRequire(
      resolve(process.cwd(), 'apps/worker/package.json'),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    await mkdir(screenshots, { recursive: true });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
    vi.restoreAllMocks();
    await f?.close();
    expect(failures).toEqual([]);
  }, 30000);

  async function remember(content: string, expiresAt: string | null = null) {
    const [run] =
      await f.db`select user_message_id from allrice_employee_runs where run_id=${identity.rootRunId}`;
    return createTraceableMemory(owner, {
      workspaceId: identity.workspace,
      employeeId: identity.employee,
      content,
      visibility: 'private',
      sourceType: 'message',
      sourceId: run!.user_message_id,
      sourceLabel: '模型提取候选',
      confidence: 0.8,
      expiresAt,
      lifecycleState: 'candidate',
      memoryClass: 'user_preference',
    });
  }
  function api(
    path: string,
    init: RequestInit = {},
    token = ownerToken,
    workspace = identity.workspace,
  ) {
    return fetch(
      origin +
        '/api/v1/memories' +
        path +
        (path.includes('?') ? '&' : '?') +
        'workspaceId=' +
        workspace,
      {
        ...init,
        headers: {
          cookie: 'allrice_session=' + token,
          origin,
          'x-allrice-organization-id':
            token === foreignToken ? foreign.org : identity.org,
          'x-allrice-workspace-id': workspace,
          ...Object.fromEntries(new Headers(init.headers)),
        },
      },
    );
  }
  async function open(host = 'chat', theme = 'light', width = 1280) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme === 'dark' ? 'dark' : 'light',
    });
    await context.addCookies([
      { name: 'allrice_session', value: ownerToken, url: origin },
    ]);
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    await page.goto(origin + '/?host=' + host + '&forged-memory=' + shared.id);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.dataset.dsTheme = value;
      document.documentElement.style.colorScheme = value;
      if (value === 'dark')
        document.body.setAttribute('data-ds-dark-theme', '');
      else document.body.removeAttribute('data-ds-dark-theme');
    }, theme);
    if (host === 'management')
      await page.getByRole('button', { name: '个人记忆', exact: true }).click();
    return { page, close: () => context.close() };
  }
  const card = (page: Page, id: string) =>
    page.locator(`[data-memory-id="${id}"]`);
  async function capture(page: Page, name: string) {
    await page.waitForLoadState('networkidle');
    const path = resolve(screenshots, name + '.png');
    await page.screenshot({ path, fullPage: true });
    console.info('CANDIDATE_MEMORY_SCREENSHOT ' + path);
  }
  async function noOverflow(page: Page) {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }

  it('keeps legacy GET visibility, narrows personal/source/run before the 100-row limit, and isolates scope', async () => {
    expect((await (await api('')).json()).memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: candidate.id }),
        expect.objectContaining({ id: shared.id, ownedByMe: false }),
      ]),
    );
    expect(
      (await (await api('?personal=1')).json()).memories.map(
        (m: WorkspaceMemory) => m.id,
      ),
    ).toEqual([candidate.id]);
    const [run] =
      await f.db`select user_message_id from allrice_employee_runs where run_id=${identity.rootRunId}`;
    await f.db`insert into allrice_memories(organization_id,workspace_id,owner_id,content,visibility,source_type,lifecycle_state,memory_class,trust_level,source_label)
      select ${identity.org},${identity.workspace},${identity.user},'Newer unrelated fixture ' || n,'private','user','candidate','work_note','derived','fixture'
      from generate_series(1,105) n`;
    expect(
      (await listWorkspaceMemories(owner, identity.workspace)).some(
        (m) => m.id === candidate.id,
      ),
    ).toBe(false);
    for (const filter of [
      'sourceId=' + run!.user_message_id,
      'runId=' + identity.rootRunId,
    ]) {
      const response = await api('?' + filter);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(
        (await response.json()).memories.map((m: WorkspaceMemory) => m.id),
      ).toEqual([candidate.id]);
    }
    expect(
      (
        await (
          await api('?sourceId=' + run!.user_message_id, {}, readerToken)
        ).json()
      ).memories,
    ).toEqual([]);
    expect(
      (await api('?runId=' + identity.rootRunId, {}, readerToken)).status,
    ).toBe(404);
    expect((await api('?runId=' + foreign.rootRunId)).status).toBe(404);
    expect(
      (await api('?personal=1', {}, foreignToken, identity.workspace)).status,
    ).not.toBe(200);
    expect(
      (
        await api(
          '?sourceId=' + run!.user_message_id,
          {},
          foreignToken,
          foreign.workspace,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await (
          await api(
            '?sourceId=' + run!.user_message_id,
            {},
            foreignToken,
            foreign.workspace,
          )
        ).json()
      ).memories,
    ).toEqual([]);
    await f.db`delete from allrice_memories where source_label='fixture' and owner_id=${identity.user}`;
  });

  it('run binding includes only real adopted steering sources, never unknown or mismatched proof', async () => {
    const followup = randomUUID(),
      message = randomUUID(),
      reply = randomUUID(),
      inputId = randomUUID();
    const turn = 'synthetic-bound-turn';
    await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${followup},${identity.org},${identity.workspace},${identity.user},'succeeded','{}','{}')`;
    await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${message},${identity.org},${identity.workspace},${identity.session},${identity.user},'user','{"text":"追加偏好","citations":[]}'),
        (${reply},${identity.org},${identity.workspace},${identity.session},${identity.user},'assistant','{"text":"","citations":[]}')`;
    await f.db`insert into allrice_conversation_followups(run_id,organization_id,workspace_id,session_id,owner_id,user_message_id,assistant_message_id,client_user_message_id,mode,state)
      values(${followup},${identity.org},${identity.workspace},${identity.session},${identity.user},${message},${reply},${inputId},'follow_up','consumed')`;
    await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      select ${identity.org},${identity.workspace},${identity.rootRunId},coalesce(max(sequence),0)+1,'turn.started',${f.db.json({ turnId: turn, generation: 1 })}
      from allrice_run_events where run_id=${identity.rootRunId}`;
    const [command] =
      await f.db`insert into allrice_conversation_commands(organization_id,workspace_id,session_id,owner_id,followup_run_id,command_type,client_user_message_id,expected_generation,expected_turn_id,message,input_kind,state)
      values(${identity.org},${identity.workspace},${identity.session},${identity.user},${followup},'steer',${inputId},1,${turn},'追加偏好','steer_current','consumed') returning id`;
    const added = await createTraceableMemory(owner, {
      workspaceId: identity.workspace,
      content: '已有追加来源的候选',
      visibility: 'private',
      sourceType: 'message',
      sourceId: message,
      sourceLabel: 'fixture steering source',
      lifecycleState: 'candidate',
      memoryClass: 'user_preference',
    });
    const read = () =>
      listWorkspaceMemories(owner, identity.workspace, undefined, {
        runId: identity.rootRunId,
      });
    expect((await read()).some((m) => m.id === added.id)).toBe(false);
    const proof = {
      status: 'adopted',
      inputId,
      messageId: 'native-input',
      sequence: 9,
      turnId: turn,
      runId: identity.rootRunId,
      checkpoint: 'step_user_message',
    };
    await f.db`update allrice_conversation_commands set native_proof=${f.db.json(proof)} where id=${command!.id}`;
    expect((await read()).some((m) => m.id === added.id)).toBe(true);
    await f.db`update allrice_conversation_commands set native_proof=${f.db.json({ ...proof, runId: foreign.rootRunId })} where id=${command!.id}`;
    expect((await read()).some((m) => m.id === added.id)).toBe(false);
  });

  it('rejects missing cookie, cross-site writes, other owners and foreign orgs; duplicate confirmation adds one revision', async () => {
    const path = '/' + candidate.id + '/promote';
    const write = { method: 'POST' };
    expect(
      (
        await api(path, {
          ...write,
          headers: { cookie: '', authorization: 'Bearer ' + ownerToken },
        })
      ).status,
    ).toBe(401);
    for (const headers of [
      { origin: '' },
      { origin: 'https://other.invalid' },
      { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[])
      expect((await api(path, { ...write, headers })).status).toBe(403);
    for (const [suffix, method] of [
      ['', 'POST'],
      ['/' + candidate.id, 'PATCH'],
      ['/' + candidate.id, 'DELETE'],
    ])
      expect(
        (await api(suffix!, { method, headers: { origin: '' } })).status,
      ).toBe(403);
    expect((await api(path, write, readerToken)).status).toBe(404);
    expect(
      (await api(path, write, foreignToken, foreign.workspace)).status,
    ).toBe(404);
    expect((await api('/' + shared.id, { method: 'DELETE' })).status).toBe(404);
    const responses = await Promise.all([api(path, write), api(path, write)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const rows = await Promise.all(responses.map((r) => r.json()));
    expect(rows.map((r) => r.memory.revision)).toEqual([2, 2]);
    expect(rows[0].memory).toMatchObject({
      id: candidate.id,
      lifecycleState: 'durable',
      trust: 'user_confirmed',
      ownedByMe: true,
    });
    expect(
      await f.db`select revision from allrice_memory_revisions where memory_id=${candidate.id} order by revision`,
    ).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(
      await f.db`select action from allrice_audit_events where resource_id=${candidate.id} and action='memory.promote'`,
    ).toHaveLength(1);
  });

  it.each([
    ['light', 1280],
    ['dark', 320],
  ] as const)(
    'chat shows an empty-body receipt in %s at %ipx, confirms only on click, and can discard',
    async (theme, width) => {
      const pending = await remember(
        '聊天候选 ' + theme + '：' + '较长内容'.repeat(20),
      );
      const dropped = await remember('将放弃的候选 ' + theme);
      const ui = await open('chat', theme, width);
      try {
        await card(ui.page, pending.id)
          .getByRole('button', { name: '确认并记住' })
          .waitFor();
        expect(await card(ui.page, shared.id).count()).toBe(0);
        expect(
          (
            await f.db`select lifecycle_state from allrice_memories where id=${pending.id}`
          )[0]!.lifecycle_state,
        ).toBe('candidate');
        await noOverflow(ui.page);
        await capture(ui.page, theme + '-chat-before');
        const before = mutations.length;
        await card(ui.page, pending.id)
          .getByRole('button', { name: '确认并记住' })
          .click();
        await card(ui.page, pending.id)
          .getByText('长期记忆', { exact: true })
          .waitFor();
        expect(mutations.slice(before)).toEqual([
          'POST /api/v1/memories/' + pending.id + '/promote',
        ]);
        await noOverflow(ui.page);
        await capture(ui.page, theme + '-chat-after');
        await card(ui.page, dropped.id)
          .getByRole('button', { name: '放弃', exact: true })
          .click();
        await card(ui.page, dropped.id).waitFor({ state: 'detached' });
        expect(
          (
            await f.db`select archived_at from allrice_memories where id=${dropped.id}`
          )[0]!.archived_at,
        ).not.toBeNull();
        await ui.page.reload();
        await card(ui.page, pending.id)
          .getByText('长期记忆', { exact: true })
          .waitFor();
        expect(await card(ui.page, dropped.id).count()).toBe(0);
      } finally {
        await ui.close();
      }
    },
  );

  it('management is available with automatic experience disabled and ignores assistant instance filtering', async () => {
    const pending = await remember('个人记忆入口待确认');
    const ui = await open('management', 'dark', 320);
    try {
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住' })
        .waitFor();
      expect(
        await ui.page
          .getByRole('combobox', { name: '经验所属 AllRice 助手' })
          .isDisabled(),
      ).toBe(true);
      expect(await card(ui.page, shared.id).count()).toBe(0);
      await noOverflow(ui.page);
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住' })
        .click();
      await card(ui.page, pending.id)
        .getByText('长期记忆', { exact: true })
        .waitFor();
      await card(ui.page, pending.id)
        .getByRole('button', { name: '删除', exact: true })
        .click();
      await card(ui.page, pending.id).waitFor({ state: 'detached' });
      await ui.page.reload();
      await ui.page
        .getByRole('button', { name: '个人记忆', exact: true })
        .click();
      await ui.page.getByRole('heading', { name: '待你确认' }).waitFor();
      expect(await card(ui.page, pending.id).count()).toBe(0);
    } finally {
      await ui.close();
    }
  });

  it('restores an empty-body memory receipt from a complete trace while retaining the partial live view', async () => {
    const pending = await remember('断线后恢复的真实候选');
    const ui = await open('recovery');
    try {
      const status = ui.page.getByLabel('恢复传输状态');
      await expect
        .poll(() => status.getAttribute('data-live-events'))
        .toBe('1');
      expect(await card(ui.page, pending.id).count()).toBe(0);
      await ui.page.getByRole('button', { name: '恢复已完成历史' }).click();
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住' })
        .waitFor();
      expect(await status.getAttribute('data-live-events')).toBe('1');
      expect(await status.getAttribute('data-trace-state')).toBe('loaded');
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住' })
        .click();
      await card(ui.page, pending.id)
        .getByText('长期记忆', { exact: true })
        .waitFor();
    } finally {
      await ui.close();
    }
  });

  it.each(['future', 'expired'] as const)(
    'shows the existing %s expiry before and after confirmation without extending it',
    async (period) => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const expiresAt =
        period === 'future'
          ? future
          : new Date(Date.now() - 86400000).toISOString();
      const pending = await remember('已有期限的候选 ' + period, future);
      if (period === 'expired') {
        // Reconstruct a legally captured older record in the isolated fixture:
        // expiry stays after capture, while both dates are now in the past.
        const capturedAt = new Date(Date.now() - 2 * 86400000).toISOString();
        await f.db`update allrice_memories set captured_at=${capturedAt},created_at=${capturedAt},updated_at=${capturedAt},expires_at=${expiresAt} where id=${pending.id}`;
        await f.db`update allrice_memory_revisions set changed_at=${capturedAt},expires_at=${expiresAt} where memory_id=${pending.id}`;
      }
      const ui = await open('management');
      try {
        const receipt = card(ui.page, pending.id);
        await receipt
          .getByText('已记为候选，等待你确认', { exact: true })
          .waitFor();
        expect(await receipt.locator('time').getAttribute('datetime')).toBe(
          expiresAt,
        );
        expect(await receipt.textContent()).toContain(
          '确认不会延长有效期；过期后不会用于后续对话。',
        );
        expect(
          await receipt
            .getByText('已记为候选，确认后才生效', { exact: true })
            .count(),
        ).toBe(0);
        await receipt.getByRole('button', { name: '确认并记住' }).click();
        await receipt.getByText('长期记忆', { exact: true }).waitFor();
        expect(await receipt.locator('time').getAttribute('datetime')).toBe(
          expiresAt,
        );
        expect(await receipt.textContent()).toContain(
          '确认不会延长有效期；过期后不会用于后续对话。',
        );
        const [stored] =
          await f.db`select lifecycle_state,expires_at from allrice_memories where id=${pending.id}`;
        expect(stored!.lifecycle_state).toBe('durable');
        expect(stored!.expires_at.toISOString()).toBe(expiresAt);
      } finally {
        await ui.close();
      }
    },
  );

  it.each(['confirm-success', 'discard-failure', 'discard-ack-loss'] as const)(
    'preserves the other in-flight card across a successful background refresh: %s',
    async (mode) => {
      const fast = await remember('快速确认 ' + mode);
      const slow = await remember('等待回执 ' + mode);
      const ui = await open('management');
      let release = () => {};
      if (mode === 'discard-failure') failDeleteFor = slow.id;
      try {
        await card(ui.page, slow.id).waitFor();
        let reached!: () => void;
        const arrived = new Promise<void>((done) => {
          reached = done;
        });
        const blocked = new Promise<void>((done) => {
          release = done;
        });
        const confirming = mode === 'confirm-success';
        await ui.page.route(
          `**/api/v1/memories/${slow.id}${confirming ? '/promote' : ''}?**`,
          async (route) => {
            // Success and lost delete acknowledgement are already committed when
            // the fast card triggers a read; definitive failure stays uncommitted.
            const response =
              mode === 'discard-failure' ? null : await route.fetch();
            reached();
            await blocked;
            if (mode === 'discard-ack-loss')
              return route.fulfill({ status: 503, json: {} });
            return response ? route.fulfill({ response }) : route.continue();
          },
        );
        await card(ui.page, slow.id)
          .getByRole('button', {
            name: confirming ? '确认并记住' : '放弃',
            exact: true,
          })
          .click();
        await arrived;
        const refreshed = ui.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/memories' &&
            response.request().method() === 'GET',
        );
        await card(ui.page, fast.id)
          .getByRole('button', { name: '确认并记住' })
          .click();
        await (await refreshed).finished();
        await ui.page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        expect(await card(ui.page, slow.id).getAttribute('aria-busy')).toBe(
          'true',
        );
        expect(
          await card(ui.page, slow.id)
            .getByRole('button', {
              name: confirming ? '正在确认…' : '正在处理…',
              exact: true,
            })
            .isDisabled(),
        ).toBe(true);
        release();
        if (confirming) {
          await card(ui.page, slow.id)
            .getByText('长期记忆', { exact: true })
            .waitFor();
          expect(
            (
              await f.db`select lifecycle_state from allrice_memories where id=${slow.id}`
            )[0]!.lifecycle_state,
          ).toBe('durable');
        } else {
          const error = card(ui.page, slow.id).getByRole('alert');
          await error.waitFor();
          expect(await error.textContent()).toContain(
            '暂时无法确认操作结果，请重新读取记忆。',
          );
          const [stored] =
            await f.db`select archived_at from allrice_memories where id=${slow.id}`;
          if (mode === 'discard-ack-loss') {
            expect(stored!.archived_at).not.toBeNull();
            await card(ui.page, slow.id)
              .getByRole('button', { name: '重新读取记忆' })
              .click();
            await card(ui.page, slow.id).waitFor({ state: 'detached' });
          } else expect(stored!.archived_at).toBeNull();
        }
        await card(ui.page, fast.id)
          .getByText('长期记忆', { exact: true })
          .waitFor();
      } finally {
        release();
        failDeleteFor = '';
        await ui.close();
      }
    },
  );

  it('keeps candidate on lost confirmation acknowledgement, recovers by rereading, and retains failed discard', async () => {
    const pending = await remember('确认回执丢失的候选');
    const dropped = await remember('放弃失败的候选');
    loseAckFor = pending.id;
    failDeleteFor = dropped.id;
    const ui = await open('chat');
    try {
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住' })
        .click();
      await card(ui.page, pending.id).getByRole('alert').waitFor();
      expect(
        await card(ui.page, pending.id)
          .getByText('已记为候选，确认后才生效', { exact: true })
          .count(),
      ).toBe(1);
      expect(
        await card(ui.page, pending.id)
          .getByText('长期记忆', { exact: true })
          .count(),
      ).toBe(0);
      expect(
        (
          await f.db`select lifecycle_state from allrice_memories where id=${pending.id}`
        )[0]!.lifecycle_state,
      ).toBe('durable');
      await card(ui.page, pending.id)
        .getByRole('button', { name: '重新读取记忆' })
        .click();
      await card(ui.page, pending.id)
        .getByText('长期记忆', { exact: true })
        .waitFor();
      await card(ui.page, pending.id)
        .getByRole('alert')
        .waitFor({ state: 'detached' });
      await card(ui.page, dropped.id)
        .getByRole('button', { name: '放弃', exact: true })
        .click();
      await card(ui.page, dropped.id).getByRole('alert').waitFor();
      expect(
        (
          await f.db`select archived_at from allrice_memories where id=${dropped.id}`
        )[0]!.archived_at,
      ).toBeNull();
      failDeleteFor = '';
      await card(ui.page, dropped.id)
        .getByRole('button', { name: '放弃', exact: true })
        .click();
      await card(ui.page, dropped.id).waitFor({ state: 'detached' });
    } finally {
      loseAckFor = '';
      failDeleteFor = '';
      await ui.close();
    }
  });

  it('offers a retry after the personal-memory read fails', async () => {
    const pending = await remember('读取失败后可重试的候选');
    const ui = await open('management');
    try {
      await card(ui.page, pending.id).waitFor();
      let failOnce = true;
      await ui.page.route('**/api/v1/memories?**', (route) => {
        if (!failOnce) return route.continue();
        failOnce = false;
        return route.fulfill({ status: 503, json: {} });
      });
      await ui.page
        .getByRole('button', { name: '已生效经验', exact: true })
        .click();
      await ui.page
        .getByRole('button', { name: '个人记忆', exact: true })
        .click();
      await ui.page
        .getByRole('alert')
        .getByRole('button', { name: '重新读取记忆' })
        .click();
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住' })
        .waitFor();
    } finally {
      await ui.close();
    }
  });

  it('drops a delayed old workspace read after switching scope', async () => {
    const pending = await remember('旧范围延迟返回不能显示');
    const ui = await open('management');
    let release = () => {};
    try {
      await card(ui.page, pending.id).waitFor();
      let reached!: () => void;
      const blocked = new Promise<void>((done) => {
        release = done;
      });
      const arrived = new Promise<void>((done) => {
        reached = done;
      });
      await ui.page.route('**/api/v1/memories?**', async (route) => {
        if (
          new URL(route.request().url()).searchParams.get('workspaceId') !==
          identity.workspace
        )
          return route.continue();
        const response = await route.fetch();
        reached();
        await blocked;
        await route.fulfill({ response });
      });
      // Reopen the tab to start an old read, then change the actual scope.
      await ui.page
        .getByRole('button', { name: '已生效经验', exact: true })
        .click();
      await ui.page
        .getByRole('button', { name: '个人记忆', exact: true })
        .click();
      await arrived;
      await ui.page.getByRole('button', { name: '切换测试工作区' }).click();
      await ui.page.getByText('暂无待确认的记忆。', { exact: true }).waitFor();
      release();
      await ui.page.unrouteAll({ behavior: 'wait' });
      expect(await card(ui.page, pending.id).count()).toBe(0);
      expect(await ui.page.locator('[data-memory-id]').count()).toBe(0);
    } finally {
      release();
      await ui.close();
    }
  });
});
