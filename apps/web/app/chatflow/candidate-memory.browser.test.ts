/** Real cookie auth, v2 memory HTTP routes and isolated PG; only the page/server
 * transport is synthetic. The separate Worker matrix covers model production. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryListSchema,
  EmployeeMemoryWriteResponseSchema,
  type EmployeeMemoryRecord,
  type RequestContext,
  type WorkspaceMemorySchema,
} from '@allrice/contracts';
import type { z } from 'zod';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { seedLegacyEmployeeMemory } from '../../../../packages/database/src/workspace/employee-memory-v1.fixture.ts';
import {
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createTraceableMemory,
  listWorkspaceMemories,
  ensureDefaultEmployee,
} from '../../../../packages/database/src/workspace/service.ts';
import { GET as adminMemories } from '../api/v1/admin/organizations/[organizationId]/employee-memories/route';
import { GET as adminMemoryDetail } from '../api/v1/admin/organizations/[organizationId]/employee-memories/[id]/route';
import { GET as manage } from '../api/v1/memories/manage/route';
import { GET as list, POST as create } from '../api/v1/memories/route';
import { GET as instanceContent } from '../api/v1/employee-instances/[id]/content/route';
import {
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
} from '../../../../packages/database/src/employees/employee-instances.ts';
import { POST as promote } from '../api/v1/memories/[id]/promote/route';
import { POST as pin } from '../api/v1/memories/[id]/pin/route';
import {
  DELETE as discard,
  PATCH as correct,
  GET as getMemory,
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
  let otherInstance: string;
  let otherWorkspace: string, browser: Browser, server: Server, origin: string;
  let candidate: WorkspaceMemory, shared: WorkspaceMemory;
  const failures: string[] = [],
    mutations: string[] = [];
  const screenshots = resolve('.local/quality/candidate-memory-entry');
  let loseAckFor = '',
    failDeleteFor = '';
  let loseNextCreateAck = false;
  const httpWrites: Array<{
    method: string;
    id: string;
    body: Record<string, unknown>;
  }> = [];

  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    identity = await createRunAuthorityFixture(f.db);
    foreign = await createRunAuthorityFixture(f.db);
    await ensureGeneralEmployeeInstance(f.db, foreign.assignment);
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
    const otherOwner = (await authenticateSession(ownerToken, {
      organizationId: identity.org,
      workspaceId: otherWorkspace,
    }))!;
    otherInstance = (await ensureDefaultEmployee(otherOwner, otherWorkspace))!
      .id;
    await ensureGeneralEmployeeInstance(f.db, otherInstance);
    candidate = await remember('真实候选：看数据时先看表格，再看文字说明。');
    const readerAssignment = await ensureDefaultEmployee(
      reader,
      identity.workspace,
    );
    shared = await createTraceableMemory(reader, {
      workspaceId: identity.workspace,
      instanceId: readerAssignment!.id,
      idempotencyKey: randomUUID(),
      content: '他人的工作区可见候选',
      visibility: 'private',
      sourceType: 'user',
      sourceLabel: 'fixture',
      lifecycleState: 'candidate',
      memoryClass: 'work_note',
    });
    await f.db`update allrice_memories set visibility='workspace' where id=${shared.id}`;
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
              ownerId: identity.user,
              organizationId: identity.org,
              workspaceId: identity.workspace,
              otherWorkspaceId: otherWorkspace,
              otherInstanceId: otherInstance,
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
            if (parts[3] === 'employee-instances' && parts[5] === 'content')
              return instanceContent(request, {
                params: Promise.resolve({ id }),
              });
            if (parts[3] === 'admin' && parts[6] === 'employee-memories')
              return request.method === 'GET'
                ? parts[7]
                  ? adminMemoryDetail(request, {
                      params: Promise.resolve({
                        organizationId: parts[5]!,
                        id: parts[7],
                      }),
                    })
                  : adminMemories(request, {
                      params: Promise.resolve({ organizationId: parts[5]! }),
                    })
                : new Response(null, { status: 405 });
            if (parts[3] !== 'memories') {
              failures.push(
                'Unexpected API/model request: ' +
                  request.method +
                  ' ' +
                  url.pathname,
              );
              return new Response(null, { status: 404 });
            }
            if (req.method !== 'GET') {
              mutations.push(request.method + ' ' + url.pathname);
              httpWrites.push({
                method: request.method,
                id,
                body: await request
                  .clone()
                  .json()
                  .catch(() => ({})),
              });
            }
            if (req.method === 'DELETE' && id === failDeleteFor)
              return Response.json({}, { status: 503 });
            const params = { params: Promise.resolve({ id }) };
            const response =
              id === 'manage'
                ? await manage(request)
                : !id
                  ? req.method === 'POST'
                    ? await create(request)
                    : await list(request)
                  : req.method === 'DELETE'
                    ? await discard(request, params)
                    : req.method === 'PATCH'
                      ? await correct(request, params)
                      : req.method === 'GET'
                        ? await getMemory(request, params)
                        : parts[5] === 'pin'
                          ? await pin(request, params)
                          : await promote(request, params);
            if (id === loseAckFor && parts[5] === 'promote' && response.ok) {
              loseAckFor = '';
              return Response.json({}, { status: 503 });
            }
            if (
              !id &&
              req.method === 'POST' &&
              response.ok &&
              loseNextCreateAck
            ) {
              loseNextCreateAck = false;
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

  async function remember(
    content: string,
    expiresAt: string | null = null,
    historicalV1 = false,
  ) {
    const [run] =
      await f.db`select user_message_id from allrice_employee_runs where run_id=${identity.rootRunId}`;
    let sourceId = run!.user_message_id as string;
    if (candidate) {
      // Later independent proposals have fresh human input with a persisted
      // native adoption receipt, so the real Run-scoped card read can see them.
      sourceId = randomUUID();
      const followup = randomUUID(),
        reply = randomUUID(),
        inputId = randomUUID();
      const turn = 'ui-fixture-' + randomUUID();
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${followup},${identity.org},${identity.workspace},${identity.user},'succeeded','{}','{}')`;
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${sourceId},${identity.org},${identity.workspace},${identity.session},${identity.user},'user',${f.db.json({ text: content, citations: [] })}),
          (${reply},${identity.org},${identity.workspace},${identity.session},${identity.user},'assistant','{"text":"","citations":[]}')`;
      await f.db`insert into allrice_conversation_followups(run_id,organization_id,workspace_id,session_id,owner_id,user_message_id,assistant_message_id,client_user_message_id,mode,state)
        values(${followup},${identity.org},${identity.workspace},${identity.session},${identity.user},${sourceId},${reply},${inputId},'follow_up','consumed')`;
      await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        select ${identity.org},${identity.workspace},${identity.rootRunId},coalesce(max(sequence),0)+1,'turn.started',${f.db.json({ turnId: turn, generation: 1 })}
        from allrice_run_events where run_id=${identity.rootRunId}`;
      const proof = {
        status: 'adopted',
        inputId,
        messageId: 'native-input',
        sequence: 9,
        turnId: turn,
        runId: identity.rootRunId,
        checkpoint: 'step_user_message',
      };
      await f.db`insert into allrice_conversation_commands(organization_id,workspace_id,session_id,owner_id,followup_run_id,command_type,client_user_message_id,expected_generation,expected_turn_id,message,input_kind,state,native_proof)
        values(${identity.org},${identity.workspace},${identity.session},${identity.user},${followup},'steer',${inputId},1,${turn},${content},'steer_current','consumed',${f.db.json(proof)})`;
    }
    const input = {
      workspaceId: identity.workspace,
      instanceId: identity.assignment,
      employeeId: identity.employee,
      content,
      visibility: 'private' as const,
      sourceType: 'message' as const,
      sourceId,
      sourceLabel: '模型提取候选',
      confidence: 0.8,
      expiresAt,
      lifecycleState: 'candidate' as const,
      memoryClass: 'user_preference' as const,
    };
    return historicalV1
      ? seedLegacyEmployeeMemory(f.db, owner, input)
      : createTraceableMemory(owner, input);
  }
  function api(
    path: string,
    init: RequestInit = {},
    token = ownerToken,
    workspace = identity.workspace,
    instance: string = token === foreignToken
      ? foreign.assignment
      : identity.assignment,
  ) {
    return fetch(
      origin +
        '/api/v1/memories' +
        path +
        (path.includes('?') ? '&' : '?') +
        'workspaceId=' +
        workspace +
        '&instanceId=' +
        instance,
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
  async function open(
    host = 'chat',
    theme = 'light',
    width = 1280,
    instance?: string,
  ) {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 844 : 1000 },
      colorScheme: theme === 'dark' ? 'dark' : 'light',
    });
    await context.addCookies([
      { name: 'allrice_session', value: ownerToken, url: origin },
    ]);
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    await page.goto(
      origin +
        '/?host=' +
        host +
        '&forged-memory=' +
        shared.id +
        (instance ? '&instance=' + instance : ''),
    );
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.dataset.appearance = value;
      document.documentElement.dataset.dsTheme = value;
      document.documentElement.style.colorScheme = value;
      if (value === 'dark')
        document.body.setAttribute('data-ds-dark-theme', '');
      else document.body.removeAttribute('data-ds-dark-theme');
    }, theme);
    if (host === 'management' && !instance)
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

  it('requires owner/instance scope and narrows source/run before the 100-row limit', async () => {
    expect((await (await api('')).json()).memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: candidate.id })]),
    );
    expect(
      (await (await api('?personal=1')).json()).memories.map(
        (m: WorkspaceMemory) => m.id,
      ),
    ).toEqual([candidate.id]);
    const [run] =
      await f.db`select user_message_id from allrice_employee_runs where run_id=${identity.rootRunId}`;
    await f.db`insert into allrice_memories(organization_id,workspace_id,owner_id,instance_id,content,visibility,source_type,lifecycle_state,memory_class,trust_level,source_label)
      select ${identity.org},${identity.workspace},${identity.user},${identity.assignment},'Newer unrelated fixture ' || n,'private','user','candidate','work_note','derived','fixture'
      from generate_series(1,105) n`;
    expect(
      (
        await listWorkspaceMemories(owner, identity.workspace, undefined, {
          instanceId: identity.assignment,
        })
      ).some((m) => m.id === candidate.id),
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
      (await api('?sourceId=' + run!.user_message_id, {}, readerToken)).status,
    ).toBe(404);
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

  const write = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const exact = (
    row: Pick<EmployeeMemoryRecord, 'revision' | 'pairDigest'>,
    instanceId: string = identity.assignment,
  ) => ({
    instanceId,
    expectedRevision: row.revision,
    pairDigest: row.pairDigest,
    idempotencyKey: randomUUID(),
  });
  async function detail(id: string, instanceId: string = identity.assignment) {
    const response = await api(
      '/' + id,
      {},
      ownerToken,
      identity.workspace,
      instanceId,
    );
    expect(response.status).toBe(200);
    return EmployeeMemoryDetailResponseSchema.parse(await response.json())
      .memory;
  }
  async function collection(instanceId: string = identity.assignment) {
    const response = await api(
      '/manage',
      {},
      ownerToken,
      identity.workspace,
      instanceId,
    );
    expect(response.status).toBe(200);
    return EmployeeMemoryListSchema.parse(await response.json());
  }
  async function createPair(
    instanceId: string,
    summary: string,
    details: string | null = null,
  ) {
    const response = await api(
      '',
      write({
        workspaceId: identity.workspace,
        instanceId,
        summary,
        details,
        idempotencyKey: randomUUID(),
      }),
      ownerToken,
      identity.workspace,
      instanceId,
    );
    expect(response.status).toBe(201);
    return EmployeeMemoryWriteResponseSchema.parse(await response.json())
      .memory;
  }
  async function isolatedInstance() {
    return (
      await createEmployeeInstance(owner, {
        workspaceId: identity.workspace,
        assignmentId: identity.assignment,
        requestId: randomUUID(),
        profile: { name: 'Rice' },
      })
    ).id;
  }
  async function pendingFor(instanceId: string, content: string) {
    return createTraceableMemory(owner, {
      workspaceId: identity.workspace,
      instanceId,
      content,
      sourceType: 'user',
      sourceLabel: 'isolated UI fixture',
      lifecycleState: 'candidate',
      idempotencyKey: randomUUID(),
    });
  }
  const deletion = (page: Page) =>
    page.getByRole('dialog', { name: '确认删除这条记忆？', exact: true });
  const notify = (page: Page) =>
    page.evaluate(
      (scopeId) =>
        window.dispatchEvent(
          new CustomEvent('allrice:memory-changed', { detail: { scopeId } }),
        ),
      identity.workspace,
    );

  it('keeps real cookie/same-origin/owner scope gates and replays one complete-pair confirmation', async () => {
    const row = await detail(candidate.id),
      path = '/' + candidate.id + '/promote';
    const request = write(exact(row));
    expect(
      (
        await api(path, {
          ...request,
          headers: { cookie: '', authorization: 'Bearer ' + ownerToken },
        })
      ).status,
    ).toBe(401);
    for (const headers of [
      { origin: '' },
      { origin: 'https://other.invalid' },
      { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[])
      expect((await api(path, { ...request, headers })).status).toBe(403);
    for (const [suffix, method] of [
      ['', 'POST'],
      ['/' + candidate.id, 'PATCH'],
      ['/' + candidate.id, 'DELETE'],
    ])
      expect(
        (await api(suffix!, { method, headers: { origin: '' } })).status,
      ).toBe(403);
    expect((await api(path, request, readerToken)).status).toBe(403);
    expect(
      (await api(path, request, foreignToken, foreign.workspace)).status,
    ).toBe(403);
    expect(
      (await api('/' + shared.id, { ...request, method: 'DELETE' })).status,
    ).toBe(404);
    const responses = await Promise.all([
      api(path, request),
      api(path, request),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(receipts.map((receipt) => receipt.memory.revision)).toEqual([2, 2]);
    expect(receipts[0]).toMatchObject({
      schemaVersion: 2,
      memory: { id: candidate.id, state: 'active', pairDigest: row.pairDigest },
    });
    expect(receipts[0].memory).not.toHaveProperty('ownedByMe');
    expect(
      await f.db.unsafe(
        'select revision from allrice_memory_revisions where memory_id=$1 order by revision',
        [candidate.id],
      ),
    ).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(
      await f.db.unsafe(
        "select action from allrice_audit_events where resource_id=$1 and action='memory.promote'",
        [candidate.id],
      ),
    ).toHaveLength(1);
  });

  it('keeps the existing chat card complete after a real V2 edit while the v2 sidebar still lists only its summary', async () => {
    const pending = await remember('真实候选来源：月报条件请本人确认');
    const row = await detail(pending.id);
    const pair = {
      summary: '月报可以外发',
      details: '  只发脱敏汇总\n原始名单不得外发  ',
    };
    const response = await api(
      '/' + pending.id,
      write(
        {
          ...exact(row),
          ...pair,
          reason: '本人确认并保存完整条件',
        },
        'PATCH',
      ),
    );
    expect(response.status).toBe(200);
    const edited = EmployeeMemoryWriteResponseSchema.parse(
      await response.json(),
    ).memory;
    const chat = await open('chat');
    try {
      const current = card(chat.page, pending.id);
      await current.waitFor();
      expect(await current.locator('p').first().textContent()).toBe(
        `${pair.summary}\n${pair.details}`,
      );
      const manager = await open(
        'management',
        'light',
        1280,
        identity.assignment,
      );
      try {
        const listed = card(manager.page, pending.id);
        await listed.getByText(pair.summary, { exact: true }).waitFor();
        expect(await listed.textContent()).not.toContain('原始名单不得外发');
        await listed.locator('button').first().click();
        await manager.page
          .getByRole('dialog')
          .getByText(pair.details, { exact: true })
          .waitFor();
        expect((await detail(pending.id)).pairDigest).toBe(edited.pairDigest);
      } finally {
        await manager.close();
      }
    } finally {
      await chat.close();
    }
  });

  it.each([
    ['light', 1440],
    ['dark', 390],
  ] as const)(
    'chat confirms from a real pair and requires a separate delete click at %s/%s',
    async (theme, width) => {
      const pending = await remember(
        '聊天候选：先看表格，再看文字说明。' + theme,
      );
      const dropped = await remember('不再需要的候选 ' + theme);
      const ui = await open('chat', theme, width);
      try {
        await card(ui.page, pending.id)
          .getByRole('button', { name: '确认并记住', exact: true })
          .waitFor();
        expect(await card(ui.page, shared.id).count()).toBe(0);
        expect((await detail(pending.id)).state).toBe('pending');
        const before = httpWrites.length;
        await capture(ui.page, theme + '-chat-before');
        await card(ui.page, pending.id)
          .getByRole('button', { name: '确认并记住', exact: true })
          .click();
        await card(ui.page, pending.id)
          .getByText('长期记忆', { exact: true })
          .waitFor();
        expect(httpWrites.slice(before)).toHaveLength(1);
        expect(httpWrites[before]!.body).toMatchObject({
          expectedRevision: 1,
          pairDigest: expect.stringMatching(/^sha256:/),
        });
        expect(httpWrites[before]!.body).not.toHaveProperty('contentDigest');
        await card(ui.page, dropped.id)
          .getByRole('button', { name: '放弃', exact: true })
          .click();
        await deletion(ui.page).waitFor();
        expect(httpWrites.slice(before)).toHaveLength(1);
        await deletion(ui.page)
          .getByRole('button', { name: '取消', exact: true })
          .click();
        expect(await card(ui.page, dropped.id).count()).toBe(1);
        await card(ui.page, dropped.id)
          .getByRole('button', { name: '放弃', exact: true })
          .click();
        await deletion(ui.page)
          .getByRole('button', { name: '删除', exact: true })
          .click();
        await card(ui.page, dropped.id).waitFor({ state: 'detached' });
        expect(
          (
            await f.db.unsafe(
              'select archived_at from allrice_memories where id=$1',
              [dropped.id],
            )
          )[0]!.archived_at,
        ).not.toBeNull();
        await noOverflow(ui.page);
        await capture(ui.page, theme + '-chat-after');
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

  it('restores a complete trace and confirms the actual candidate without trusting a forged model memory ID', async () => {
    const pending = await remember('断线后恢复的真实候选');
    const ui = await open('recovery');
    try {
      const status = ui.page.getByLabel('恢复传输状态');
      await expect
        .poll(() => status.getAttribute('data-live-events'))
        .toBe('1');
      expect(await card(ui.page, pending.id).count()).toBe(0);
      await ui.page
        .getByRole('button', { name: '恢复已完成历史', exact: true })
        .click();
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住', exact: true })
        .click();
      await card(ui.page, pending.id)
        .getByText('长期记忆', { exact: true })
        .waitFor();
      expect(await status.getAttribute('data-live-events')).toBe('1');
      expect(await status.getAttribute('data-trace-state')).toBe('loaded');
      expect(await card(ui.page, shared.id).count()).toBe(0);
      expect((await detail(pending.id)).state).toBe('active');
    } finally {
      await ui.close();
    }
  });

  it.each(['future', 'expired'] as const)(
    'uses real eligibility for a paired historical %s expiry and removes retired expiry promises',
    async (period) => {
      const pending = await remember('有历史期限的成对候选 ' + period);
      const captured = new Date(Date.now() - 2 * 86400000).toISOString();
      const expiry = new Date(
        Date.now() + (period === 'future' ? 1 : -1) * 86400000,
      ).toISOString();
      await f.db.unsafe(
        'update allrice_memories set captured_at=$2,created_at=$2,updated_at=$2,expires_at=$3 where id=$1',
        [pending.id, captured, expiry],
      );
      await f.db.unsafe(
        'update allrice_memory_revisions set changed_at=$2,expires_at=$3 where memory_id=$1',
        [pending.id, captured, expiry],
      );
      const ui = await open('management');
      try {
        await ui.page
          .getByRole('heading', { name: '测试助手 · 记忆', exact: true })
          .waitFor();
        await ui.page
          .getByText('正在读取记忆…', { exact: true })
          .waitFor({ state: 'hidden' });
        expect(
          await ui.page
            .getByText('确认不会延长有效期', { exact: false })
            .count(),
        ).toBe(0);
        if (period === 'expired')
          expect(await card(ui.page, pending.id).count()).toBe(0);
        else {
          await card(ui.page, pending.id)
            .getByRole('button', { name: '确认', exact: true })
            .click();
          await ui.page
            .getByRole('region', { name: '生效中', exact: true })
            .locator('[data-memory-id="' + pending.id + '"]')
            .waitFor();
          expect(
            (
              await f.db.unsafe(
                'select expires_at,lifecycle_state from allrice_memories where id=$1',
                [pending.id],
              )
            )[0],
          ).toEqual({ expires_at: null, lifecycle_state: 'durable' });
        }
      } finally {
        await ui.close();
      }
    },
  );

  it.each(['confirm-success', 'discard-failure', 'discard-ack-loss'] as const)(
    'preserves a frozen ordinary card across another real view refresh: %s',
    async (mode) => {
      const fast = await remember('另一视图确认 ' + mode),
        slow = await remember('当前视图等待回执 ' + mode);
      const ui = await open('chat');
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
          '**/api/v1/memories/' +
            slow.id +
            (confirming ? '/promote' : '') +
            '?**',
          async (route) => {
            if (route.request().method() === 'GET') return route.continue();
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
        if (!confirming)
          await deletion(ui.page)
            .getByRole('button', { name: '删除', exact: true })
            .click();
        await arrived;
        const other = await detail(fast.id);
        expect(
          (await api('/' + fast.id + '/promote', write(exact(other)))).status,
        ).toBe(200);
        const refreshed = ui.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/memories' &&
            response.request().method() === 'GET',
        );
        await notify(ui.page);
        await (await refreshed).finished();
        await expect
          .poll(() =>
            card(ui.page, fast.id)
              .getByText('长期记忆', { exact: true })
              .count(),
          )
          .toBe(1);
        expect(await card(ui.page, slow.id).getAttribute('aria-busy')).toBe(
          'true',
        );
        release();
        if (confirming) {
          await card(ui.page, slow.id)
            .getByText('长期记忆', { exact: true })
            .waitFor();
          expect((await detail(slow.id)).state).toBe('active');
        } else {
          await deletion(ui.page).getByRole('alert').waitFor();
          expect(
            await deletion(ui.page).getByRole('alert').textContent(),
          ).toContain('暂时无法确认操作结果。');
          await deletion(ui.page)
            .getByRole('button', { name: '取消', exact: true })
            .click();
          const stored = (
            await f.db.unsafe(
              'select archived_at from allrice_memories where id=$1',
              [slow.id],
            )
          )[0]!;
          if (mode === 'discard-ack-loss') {
            expect(stored.archived_at).not.toBeNull();
            await notify(ui.page);
            await card(ui.page, slow.id).waitFor({ state: 'detached' });
          } else expect(stored.archived_at).toBeNull();
        }
      } finally {
        release();
        failDeleteFor = '';
        await ui.close();
      }
    },
  );

  it('refuses a stale card before any write after another owner view saves a different pair', async () => {
    const pending = await remember('月报入口使用原始账单');
    const ui = await open('chat');
    try {
      await card(ui.page, pending.id).waitFor();
      const row = await detail(pending.id);
      const changed = await api(
        '/' + pending.id,
        write(
          {
            ...exact(row),
            summary: '月报使用本人校订的账单',
            details: '  原始附件仍须保留  ',
            reason: '本人编辑',
          },
          'PATCH',
        ),
      );
      expect(changed.status).toBe(200);
      const before = mutations.length;
      await card(ui.page, pending.id)
        .getByRole('button', { name: '确认并记住', exact: true })
        .click();
      await card(ui.page, pending.id)
        .getByText('记忆已变化，请重新读取后再操作。', { exact: false })
        .waitFor();
      expect(mutations.length).toBe(before);
      await card(ui.page, pending.id)
        .getByRole('button', { name: '重新读取记忆', exact: true })
        .click();
      await expect
        .poll(() =>
          card(ui.page, pending.id).locator('p').first().textContent(),
        )
        .toBe('月报使用本人校订的账单\n  原始附件仍须保留  ');
      expect(
        await f.db.unsafe(
          "select id from allrice_audit_events where resource_id=$1 and action='memory.promote'",
          [pending.id],
        ),
      ).toHaveLength(0);
    } finally {
      await ui.close();
    }
  });

  it('replays a lost confirmation with its original key/CAS and preserves failed delete until final confirmation', async () => {
    const pending = await remember('确认回执丢失的候选'),
      dropped = await remember('放弃失败的候选');
    loseAckFor = pending.id;
    failDeleteFor = dropped.id;
    const ui = await open('chat');
    try {
      const before = httpWrites.length;
      const button = card(ui.page, pending.id).getByRole('button', {
        name: '确认并记住',
        exact: true,
      });
      await button.click();
      await card(ui.page, pending.id).getByRole('alert').waitFor();
      expect((await detail(pending.id)).state).toBe('active');
      expect(
        await card(ui.page, pending.id)
          .getByText('长期记忆', { exact: true })
          .count(),
      ).toBe(0);
      await button.click();
      await card(ui.page, pending.id)
        .getByText('长期记忆', { exact: true })
        .waitFor();
      const calls = httpWrites
        .slice(before)
        .filter((item) => item.id === pending.id);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.body).toEqual(calls[1]!.body);
      expect(calls[0]!.body.expectedRevision).toBe(1);
      await card(ui.page, dropped.id)
        .getByRole('button', { name: '放弃', exact: true })
        .click();
      await deletion(ui.page)
        .getByRole('button', { name: '删除', exact: true })
        .click();
      await deletion(ui.page).getByRole('alert').waitFor();
      expect(
        (
          await f.db.unsafe(
            'select archived_at from allrice_memories where id=$1',
            [dropped.id],
          )
        )[0]!.archived_at,
      ).toBeNull();
      failDeleteFor = '';
      await deletion(ui.page)
        .getByRole('button', { name: '删除', exact: true })
        .click();
      await card(ui.page, dropped.id).waitFor({ state: 'detached' });
    } finally {
      loseAckFor = '';
      failDeleteFor = '';
      await ui.close();
    }
  });

  it.each(['success', 'failure'] as const)(
    'does not let an older read %s settle a later unknown mutation',
    async (outcome) => {
      const fast = await remember('较早确认 ' + outcome),
        pending = await remember('较后确认回执未知 ' + outcome);
      const ui = await open('chat');
      let release = () => {};
      loseAckFor = pending.id;
      try {
        await card(ui.page, pending.id).waitFor();
        let reached!: () => void;
        const arrived = new Promise<void>((done) => {
            reached = done;
          }),
          blocked = new Promise<void>((done) => {
            release = done;
          });
        await ui.page.route('**/api/v1/memories?**', async (route) => {
          const response = await route.fetch();
          reached();
          await blocked;
          return outcome === 'success'
            ? route.fulfill({ response })
            : route.fulfill({ status: 503, json: {} });
        });
        await card(ui.page, fast.id)
          .getByRole('button', { name: '确认并记住', exact: true })
          .click();
        await arrived;
        await card(ui.page, pending.id)
          .getByRole('button', { name: '确认并记住', exact: true })
          .click();
        const error = card(ui.page, pending.id).getByRole('alert');
        await error.waitFor();
        const returned = ui.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/memories' &&
            response.request().method() === 'GET',
        );
        release();
        await (await returned).finished();
        await ui.page.unrouteAll({ behavior: 'wait' });
        await ui.page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        expect(await error.count()).toBe(1);
        expect(
          await card(ui.page, pending.id)
            .getByText('长期记忆', { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await ui.page
            .getByRole('alert')
            .filter({ hasText: '记忆读取失败' })
            .count(),
        ).toBe(0);
        await card(ui.page, pending.id)
          .getByRole('button', { name: '重新读取记忆', exact: true })
          .click();
        await card(ui.page, pending.id)
          .getByText('长期记忆', { exact: true })
          .waitFor();
      } finally {
        release();
        loseAckFor = '';
        await ui.close();
      }
    },
  );

  it('keeps an edit snapshot through refresh, rejects its stale CAS, then explicitly rereads without trimming details', async () => {
    const instanceId = await isolatedInstance(),
      original = await createPair(
        instanceId,
        '最初的一句话',
        '  原始说明\n保留尾空白  ',
      );
    const ui = await open('management', 'light', 1440, instanceId);
    try {
      await card(ui.page, original.id).locator('button').click();
      await ui.page
        .getByRole('dialog')
        .getByRole('button', { name: '修改', exact: true })
        .click();
      const form = ui.page.getByRole('form', {
        name: 'Rice · 修改记忆',
        exact: true,
      });
      await form.getByLabel(/一句话/).fill('我正在编辑的草稿');
      const raw = '  第一行\n\n第二行  \n';
      await form.getByLabel(/详细说明/).fill(raw);
      expect(
        (
          await api(
            '/' + original.id,
            write(
              {
                ...exact(original, instanceId),
                summary: '另一窗口已更新',
                details: '另一窗口说明',
                reason: '本人编辑',
              },
              'PATCH',
            ),
            ownerToken,
            identity.workspace,
            instanceId,
          )
        ).status,
      ).toBe(200);
      await notify(ui.page);
      await card(ui.page, original.id)
        .getByText('另一窗口已更新', { exact: true })
        .waitFor();
      expect(await form.getByLabel(/一句话/).inputValue()).toBe(
        '我正在编辑的草稿',
      );
      expect(await form.getByLabel(/详细说明/).inputValue()).toBe(raw);
      const before = httpWrites.length;
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: '记忆已变化' }).waitFor();
      expect(httpWrites[before]!.body).toMatchObject({
        expectedRevision: original.revision,
        pairDigest: original.pairDigest,
        summary: '我正在编辑的草稿',
        details: raw,
      });
      expect((await detail(original.id, instanceId)).summary).toBe(
        '另一窗口已更新',
      );
      await form.getByRole('button', { name: '取消', exact: true }).click();
      await card(ui.page, original.id).locator('button').click();
      await ui.page
        .getByRole('dialog')
        .getByRole('button', { name: '修改', exact: true })
        .click();
      const reread = ui.page.getByRole('form', {
        name: 'Rice · 修改记忆',
        exact: true,
      });
      await reread.getByLabel(/一句话/).fill('本人明确重新保存');
      await reread.getByLabel(/详细说明/).fill(raw);
      await reread.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => ui.page.getByRole('dialog').count()).toBe(0);
      expect(await detail(original.id, instanceId)).toMatchObject({
        summary: '本人明确重新保存',
        details: raw,
        revision: 3,
      });
    } finally {
      await ui.close();
    }
  });

  it('retries a lost create receipt without duplicate rows and keeps success separate from a failed follow-up read', async () => {
    const instanceId = await isolatedInstance();
    const ui = await open('management', 'dark', 390, instanceId);
    try {
      await ui.page
        .getByRole('button', { name: '＋ 新增', exact: true })
        .click();
      const form = ui.page.getByRole('form', {
        name: 'Rice · 新增记忆',
        exact: true,
      });
      await form.getByLabel(/一句话/).fill('每周先做数据核对');
      await form.getByLabel(/详细说明/).fill('  保留原文\n最后一行  ');
      const before = httpWrites.length;
      loseNextCreateAck = true;
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await form
        .getByRole('alert')
        .filter({ hasText: '暂时无法确认保存结果。' })
        .waitFor();
      expect((await collection(instanceId)).counts.active).toBe(1);
      await ui.page.route('**/api/v1/memories/manage?**', (route) =>
        route.fulfill({ status: 503, json: {} }),
      );
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => ui.page.getByRole('dialog').count()).toBe(0);
      await ui.page
        .getByRole('alert')
        .filter({ hasText: '记忆读取失败' })
        .waitFor();
      const calls = httpWrites.slice(before);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.body).toEqual(calls[1]!.body);
      expect((await collection(instanceId)).counts.active).toBe(1);
      await ui.page.unrouteAll({ behavior: 'wait' });
      await ui.page.getByRole('button', { name: '重试', exact: true }).click();
      await ui.page.getByText('每周先做数据核对', { exact: true }).waitFor();
      expect(httpWrites.slice(before)).toHaveLength(2);
    } finally {
      loseNextCreateAck = false;
      await ui.close();
    }
  });

  it('preserves untouched CRLF and surrounding whitespace in a summary-only edit', async () => {
    const instanceId = await isolatedInstance(),
      raw = '  第一行\r\n\r\n第二行  \r\n';
    const saved = await createPair(instanceId, '说明保持原样', raw);
    const ui = await open('management', 'light', 390, instanceId);
    try {
      await card(ui.page, saved.id).locator('button').click();
      await ui.page
        .getByRole('dialog')
        .getByRole('button', { name: '修改', exact: true })
        .click();
      const form = ui.page.getByRole('form', {
        name: 'Rice · 修改记忆',
        exact: true,
      });
      await form.getByLabel(/一句话/).fill('只修改这一句话');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => ui.page.getByRole('dialog').count()).toBe(0);
      expect(await detail(saved.id, instanceId)).toMatchObject({
        summary: '只修改这一句话',
        details: raw,
        revision: 2,
      });
    } finally {
      await ui.close();
    }
  });

  it.each([401, 403, 404, 503])(
    'clears revoked private content for %s while keeping a draft on a network/service read failure',
    async (status) => {
      const instanceId = await isolatedInstance(),
        saved = await createPair(
          instanceId,
          '不可串到另一人的原文',
          '原私密说明',
        );
      const ui = await open('management', 'light', 390, instanceId);
      try {
        await card(ui.page, saved.id).locator('button').click();
        await ui.page
          .getByRole('dialog')
          .getByRole('button', { name: '修改', exact: true })
          .click();
        const form = ui.page.getByRole('form', {
          name: 'Rice · 修改记忆',
          exact: true,
        });
        await form.getByLabel(/详细说明/).fill('尚未提交的私密草稿');
        await ui.page.route('**/api/v1/memories/manage?**', (route) =>
          route.fulfill({ status, json: {} }),
        );
        await notify(ui.page);
        await ui.page
          .getByRole('region', { name: '个人记忆', exact: true })
          .getByRole('alert')
          .waitFor();
        if (status === 503) {
          expect(await form.getByLabel(/详细说明/).inputValue()).toBe(
            '尚未提交的私密草稿',
          );
          expect(
            await form
              .getByRole('button', { name: '保存', exact: true })
              .isDisabled(),
          ).toBe(true);
          await ui.page.unrouteAll({ behavior: 'wait' });
          await form.getByRole('button', { name: '重试', exact: true }).click();
          await expect
            .poll(() =>
              form
                .getByRole('button', { name: '保存', exact: true })
                .isEnabled(),
            )
            .toBe(true);
          expect(await form.getByLabel(/详细说明/).inputValue()).toBe(
            '尚未提交的私密草稿',
          );
        } else {
          expect(await ui.page.getByRole('dialog').count()).toBe(0);
          expect(
            await ui.page
              .getByText('尚未提交的私密草稿', { exact: true })
              .count(),
          ).toBe(0);
          expect(await card(ui.page, saved.id).count()).toBe(0);
        }
        expect((await detail(saved.id, instanceId)).details).toBe('原私密说明');
      } finally {
        await ui.close();
      }
    },
  );

  it('discards a delayed old-scope list and closes its portal when the actual host scope changes', async () => {
    const pending = await remember('旧范围的内容不能显示');
    const ui = await open('management');
    let release = () => {};
    try {
      await card(ui.page, pending.id).waitFor();
      let reached!: () => void;
      const arrived = new Promise<void>((done) => {
          reached = done;
        }),
        blocked = new Promise<void>((done) => {
          release = done;
        });
      await ui.page.route('**/api/v1/memories/manage?**', async (route) => {
        if (
          new URL(route.request().url()).searchParams.get('workspaceId') !==
          identity.workspace
        )
          return route.continue();
        const response = await route.fetch();
        reached();
        await blocked;
        return route.fulfill({ response });
      });
      await notify(ui.page);
      await arrived;
      await ui.page
        .getByRole('button', { name: '切换测试工作区', exact: true })
        .click();
      await ui.page.getByText('还没有记忆', { exact: true }).waitFor();
      release();
      await ui.page.unrouteAll({ behavior: 'wait' });
      expect(await card(ui.page, pending.id).count()).toBe(0);
      expect(await ui.page.getByRole('dialog').count()).toBe(0);
    } finally {
      release();
      await ui.close();
    }
  });

  it('does not silently fall back to a v1 full-content editor or mutate a historical record', async () => {
    const instanceId = await isolatedInstance();
    const legacy = await seedLegacyEmployeeMemory(f.db, owner, {
      workspaceId: identity.workspace,
      instanceId,
      sourceType: 'user',
      content: '历史v1整段内容只能按明确迁移合同处理',
    });
    const before = await f.db.unsafe(
      'select revision,content,summary,details from allrice_memories where id=$1',
      [legacy.id],
    );
    const ui = await open('management', 'light', 1440, instanceId);
    try {
      await ui.page
        .getByRole('alert')
        .filter({ hasText: '记忆读取失败' })
        .waitFor();
      expect(
        await ui.page
          .getByRole('button', { name: '＋ 新增', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(await ui.page.getByRole('textbox').count()).toBe(0);
      expect(
        await f.db.unsafe(
          'select revision,content,summary,details from allrice_memories where id=$1',
          [legacy.id],
        ),
      ).toEqual(before);
    } finally {
      await ui.close();
    }
  });

  it('keeps administrator list/detail on the independently audited scope without owner mutations', async () => {
    const raw = '  管理员读取的详细说明\n原文末尾空白  ';
    const memory = await createPair(
      identity.assignment,
      '管理员查看的一句话',
      raw,
    );
    const denied = await open('admin');
    try {
      await denied.page.getByRole('alert').waitFor();
      expect(
        await denied.page.getByText(memory.summary, { exact: true }).count(),
      ).toBe(0);
    } finally {
      await denied.close();
    }
    const user = (
      await f.db.unsafe('select email from allrice_users where id=$1', [
        identity.user,
      ])
    )[0]!;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', user.email);
    const ui = await open('admin', 'dark', 390);
    try {
      const article = ui.page
        .locator('article')
        .filter({ hasText: memory.summary });
      await article.waitFor();
      await f.db.unsafe(
        'update allrice_employee_assignments set active=false where id=$1',
        [identity.assignment],
      );
      expect((await api('/' + memory.id)).status).not.toBe(200);
      await article.getByRole('button', { name: '查看', exact: true }).click();
      await expect
        .poll(() =>
          ui.page.getByRole('dialog').locator('p').last().textContent(),
        )
        .toBe(raw);
      expect(
        await ui.page
          .getByRole('button', { name: /^(修改|确认|删除|保存|＋ 新增)$/ })
          .count(),
      ).toBe(0);
      expect(await ui.page.locator('a[href]').count()).toBe(0);
      const audits = await f.db.unsafe(
        "select resource_type,resource_id,metadata from allrice_audit_events where action='employee_memory.admin_read' and organization_id=$1 and workspace_id=$2 and actor_id=$3 and resource_id in ($4,$5) order by resource_type,resource_id",
        [
          identity.org,
          identity.workspace,
          identity.user,
          identity.assignment,
          memory.id,
        ],
      );
      const auditScope = {
        ownerId: identity.user,
        instanceId: identity.assignment,
        schemaVersion: 2,
      };
      expect(audits).toEqual([
        {
          resource_type: 'employee_instance',
          resource_id: identity.assignment,
          metadata: {
            ...auditScope,
            returnedCount: await ui.page.locator('article').count(),
          },
        },
        {
          resource_type: 'memory',
          resource_id: memory.id,
          metadata: { ...auditScope, returnedCount: 1, memoryId: memory.id },
        },
      ]);
      expect(JSON.stringify(audits)).not.toContain(raw);
      await noOverflow(ui.page);
      await capture(ui.page, 'v10-admin-read-only');
    } finally {
      await f.db.unsafe(
        'update allrice_employee_assignments set active=true where id=$1',
        [identity.assignment],
      );
      await ui.close();
      vi.unstubAllEnvs();
    }
  });

  it.each([401, 403, 404, 503])(
    'clears cached administrator scope after detail %s and retains lawful context for 5xx',
    async (status) => {
      const raw = '管理员读取后仍须按真实失权边界清理的说明';
      const memory = await createPair(
        identity.assignment,
        '管理员详情读取边界 ' + status,
        raw,
      );
      const user = (
        await f.db.unsafe('select email from allrice_users where id=$1', [
          identity.user,
        ])
      )[0]!;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', user.email);
      const ui = await open('admin');
      const detailPath = `/api/v1/admin/organizations/${identity.org}/employee-memories/${memory.id}`;
      const detailMatcher = (url: URL) => url.pathname === detailPath;
      try {
        const article = ui.page
          .locator('article')
          .filter({ hasText: memory.summary });
        await article.waitFor();
        if (status === 401) await ui.page.context().clearCookies();
        else if (status === 403)
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
        else if (status === 404)
          expect(
            (await api('/' + memory.id, write(exact(memory), 'DELETE'))).status,
          ).toBe(204);
        else {
          await article
            .getByRole('button', { name: '查看', exact: true })
            .click();
          await ui.page
            .getByRole('dialog')
            .getByText(raw, { exact: true })
            .waitFor();
          await ui.page
            .getByRole('dialog')
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          // Transport failure injection only; all successful reads use real routes.
          await ui.page.route(detailMatcher, (route) =>
            route.fulfill({ status: 503, body: '{}' }),
          );
        }
        const before = mutations.length;
        const response = ui.page.waitForResponse(
          (value) => new URL(value.url()).pathname === detailPath,
        );
        await article
          .getByRole('button', { name: '查看', exact: true })
          .click();
        expect((await response).status()).toBe(status);
        await ui.page.getByRole('alert').waitFor();
        if (status === 503) {
          expect(await article.count()).toBe(1);
          expect(await ui.page.getByRole('dialog').count()).toBe(1);
          await ui.page.unroute(detailMatcher);
          await ui.page
            .getByRole('dialog')
            .getByRole('button', { name: '重新读取', exact: true })
            .click();
          await ui.page
            .getByRole('dialog')
            .getByText(raw, { exact: true })
            .waitFor();
        } else {
          expect(await ui.page.locator('article').count()).toBe(0);
          expect(await ui.page.getByRole('dialog').count()).toBe(0);
          expect(
            await ui.page.getByText(memory.summary, { exact: true }).count(),
          ).toBe(0);
          expect(await ui.page.getByText(raw, { exact: true }).count()).toBe(0);
        }
        expect(mutations.length).toBe(before);
      } finally {
        await ui.close();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
    ['dark', 390],
  ] as const)(
    'runs the 17 approved v10 states against real scoped APIs at %s/%s',
    async (theme, width) => {
      const instanceId = await isolatedInstance();
      const active: EmployeeMemoryRecord[] = [];
      active.push(await createPair(instanceId, '回复先给结论，300 字以内'));
      active.push(
        await createPair(
          instanceId,
          '报价规则：含税、PDF、文件名带客户和日期',
          '1. 报价一律含税。\n2. 金额超过 5 万先发给我看，再发客户。',
        ),
      );
      active.push(
        await createPair(instanceId, '公众号固定周二、周四 20:00 发布'),
      );
      active.push(
        await createPair(instanceId, '对外统一写“AllRice”，不写“All Rice”'),
      );
      active.push(
        await createPair(instanceId, '财务数据以每月 5 号的对账表为准'),
      );
      const pending = await Promise.all(
        [
          '周报统一用表格，先写结论再写数据',
          '给客户发邮件前先让我看',
          '项目风险每周五汇总',
        ].map((summary) => pendingFor(instanceId, summary)),
      );
      const ui = await open('management', theme, width, instanceId);
      const shot = async (state: string) => {
        await noOverflow(ui.page);
        await capture(ui.page, 'v10-' + state + '-' + width + '-' + theme);
      };
      const manager = ui.page.getByRole('region', {
        name: '个人记忆',
        exact: true,
      });
      const dialog = () => ui.page.getByRole('dialog').first();
      try {
        await card(ui.page, pending[0]!.id).waitFor();
        expect(
          await manager
            .getByRole('region', { name: '待确认', exact: true })
            .locator('[data-memory-id]')
            .count(),
        ).toBe(3);
        expect(
          await manager
            .getByRole('region', { name: '生效中', exact: true })
            .locator('[data-memory-id]')
            .count(),
        ).toBe(5);
        await shot('list');
        await card(ui.page, pending[0]!.id)
          .getByRole('button', { name: '确认', exact: true })
          .click();
        await expect
          .poll(() =>
            manager
              .getByRole('region', { name: '生效中', exact: true })
              .locator('[data-memory-id]')
              .count(),
          )
          .toBe(6);
        expect(
          await manager
            .getByRole('region', { name: '生效中', exact: true })
            .locator('[data-memory-id]')
            .first()
            .getAttribute('data-memory-id'),
        ).toBe(pending[0]!.id);
        expect(await ui.page.getByRole('dialog').count()).toBe(0);
        expect(await ui.page.getByRole('status').count()).toBe(0);
        await shot('confirmed');
        await card(ui.page, active[1]!.id).locator('button').click();
        await dialog()
          .getByText(
            '1. 报价一律含税。\n2. 金额超过 5 万先发给我看，再发客户。',
            { exact: true },
          )
          .waitFor();
        expect(
          await dialog()
            .getByText(/^生效于 \d{2}-\d{2}$/)
            .count(),
        ).toBe(1);
        await shot('active-details');
        const activeDelete = dialog().getByRole('button', {
          name: '删除',
          exact: true,
        });
        let before = httpWrites.length;
        await activeDelete.click();
        await shot('delete-active');
        expect(httpWrites.length).toBe(before);
        await ui.page.keyboard.press('Escape');
        expect(
          await activeDelete.evaluate(
            (node) => node === document.activeElement,
          ),
        ).toBe(true);
        await dialog()
          .getByRole('button', { name: '修改', exact: true })
          .click();
        await shot('edit-active');
        await dialog()
          .getByRole('button', { name: '取消', exact: true })
          .click();
        await card(ui.page, active[0]!.id).locator('button').click();
        await dialog().getByText('没有详细说明', { exact: true }).waitFor();
        await shot('active-empty');
        await ui.page.keyboard.press('Escape');
        await card(ui.page, pending[1]!.id).locator('button').first().click();
        await dialog()
          .getByRole('button', { name: '修改', exact: true })
          .waitFor();
        expect(
          await dialog()
            .getByText(/^添加于 今天 \d{2}:\d{2}$/)
            .count(),
        ).toBe(1);
        await shot('pending');
        const pendingDelete = dialog().getByRole('button', {
          name: '删除',
          exact: true,
        });
        before = httpWrites.length;
        await pendingDelete.click();
        await shot('delete-pending');
        expect(httpWrites.length).toBe(before);
        await deletion(ui.page)
          .getByRole('button', { name: '取消', exact: true })
          .click();
        expect(
          await pendingDelete.evaluate(
            (node) => node === document.activeElement,
          ),
        ).toBe(true);
        await dialog()
          .getByRole('button', { name: '修改', exact: true })
          .click();
        await shot('edit');
        expect(
          await dialog()
            .getByRole('button', { name: '保存', exact: true })
            .isEnabled(),
        ).toBe(true);
        await dialog()
          .getByRole('button', { name: '取消', exact: true })
          .click();
        const rowDelete = card(ui.page, pending[2]!.id).getByRole('button', {
          name: /^删除/,
        });
        before = httpWrites.length;
        await rowDelete.click();
        await shot('delete-row');
        expect(httpWrites.length).toBe(before);
        await deletion(ui.page)
          .locator('..')
          .locator(':scope > [aria-hidden="true"]')
          .click({ position: { x: 4, y: 4 } });
        expect(
          await rowDelete.evaluate((node) => node === document.activeElement),
        ).toBe(true);
        await manager
          .getByRole('button', { name: '＋ 新增', exact: true })
          .click();
        let form = ui.page.getByRole('form', {
          name: 'Rice · 新增记忆',
          exact: true,
        });
        expect(
          await form
            .getByRole('button', { name: '保存', exact: true })
            .isDisabled(),
        ).toBe(true);
        await shot('new');
        const raw = '  两栏说明\n\n最后一行  \n';
        await form.getByLabel(/一句话/).fill('😀'.repeat(40));
        await form.getByLabel(/详细说明/).fill(raw);
        expect(
          await form.getByText('40 / 40 字', { exact: true }).count(),
        ).toBe(1);
        await shot('new-filled');
        await form.getByLabel(/一句话/).fill('😀'.repeat(41));
        expect(
          await form
            .getByRole('button', { name: '保存', exact: true })
            .isDisabled(),
        ).toBe(true);
        await form.getByLabel(/一句话/).fill('本人新增：说明保留原文');
        await form.getByRole('button', { name: '保存', exact: true }).click();
        await expect.poll(() => ui.page.getByRole('dialog').count()).toBe(0);
        const added = (await collection(instanceId)).active.find(
          (row) => row.summary === '本人新增：说明保留原文',
        )!;
        expect((await detail(added.id, instanceId)).details).toBe(raw);
        for (
          let count = (await collection(instanceId)).counts.active;
          count < 99;
          count++
        )
          await createPair(instanceId, '容量行为验证 ' + count);
        await notify(ui.page);
        await expect
          .poll(() =>
            manager
              .getByRole('region', { name: '生效中', exact: true })
              .locator('[data-memory-id]')
              .count(),
          )
          .toBe(99);
        await manager
          .getByRole('button', { name: '＋ 新增', exact: true })
          .click();
        form = ui.page.getByRole('form', {
          name: 'Rice · 新增记忆',
          exact: true,
        });
        await form.getByLabel(/一句话/).fill('满额时保留的草稿');
        await createPair(instanceId, '另一视图占用第100个名额');
        await form.getByRole('button', { name: '保存', exact: true }).click();
        await form
          .getByRole('alert')
          .filter({ hasText: '记忆已满（100 / 100）' })
          .waitFor();
        expect(await form.getByLabel(/一句话/).inputValue()).toBe(
          '满额时保留的草稿',
        );
        expect(
          await form
            .getByRole('button', { name: '保存', exact: true })
            .isDisabled(),
        ).toBe(true);
        await form.getByRole('button', { name: '取消', exact: true }).click();
        expect(
          await manager
            .getByRole('region', { name: '生效中', exact: true })
            .locator('[data-memory-id]')
            .count(),
        ).toBe(100);
        expect(
          await manager
            .getByRole('button', { name: '＋ 新增', exact: true })
            .isDisabled(),
        ).toBe(true);
        expect(
          await card(ui.page, pending[1]!.id)
            .getByRole('button', { name: '确认', exact: true })
            .isDisabled(),
        ).toBe(true);
        await shot('full');
        await card(ui.page, pending[1]!.id).locator('button').first().click();
        expect(
          await dialog()
            .getByRole('button', { name: '确认', exact: true })
            .isDisabled(),
        ).toBe(true);
        await shot('full-pending');
        await dialog()
          .getByRole('button', { name: '修改', exact: true })
          .click();
        expect(
          await dialog()
            .getByRole('button', { name: '保存', exact: true })
            .isDisabled(),
        ).toBe(true);
        await shot('full-edit-pending');
        await dialog()
          .getByRole('button', { name: '取消', exact: true })
          .click();
        await card(ui.page, active[1]!.id).locator('button').click();
        await dialog()
          .getByRole('button', { name: '修改', exact: true })
          .click();
        expect(
          await dialog()
            .getByRole('button', { name: '保存', exact: true })
            .isEnabled(),
        ).toBe(true);
        await shot('full-edit-active');
        await dialog()
          .getByLabel(/详细说明/)
          .fill('');
        await dialog()
          .getByRole('button', { name: '保存', exact: true })
          .click();
        await expect.poll(() => ui.page.getByRole('dialog').count()).toBe(0);
        expect((await detail(active[1]!.id, instanceId)).details).toBeNull();
        expect((await collection(instanceId)).counts.active).toBe(100);
        await card(ui.page, active[0]!.id).locator('button').click();
        await dialog()
          .getByRole('button', { name: '删除', exact: true })
          .click();
        await deletion(ui.page)
          .getByRole('button', { name: '删除', exact: true })
          .click();
        await expect.poll(() => ui.page.getByRole('dialog').count()).toBe(0);
        expect((await collection(instanceId)).counts.active).toBe(99);
        expect(
          await manager
            .getByRole('button', { name: '＋ 新增', exact: true })
            .isEnabled(),
        ).toBe(true);
        await card(ui.page, pending[1]!.id)
          .getByRole('button', { name: '确认', exact: true })
          .click();
        await expect
          .poll(async () => (await collection(instanceId)).counts.active)
          .toBe(100);
        await expect
          .poll(() =>
            manager
              .getByRole('region', { name: '生效中', exact: true })
              .locator('[data-memory-id]')
              .count(),
          )
          .toBe(100);
        const remaining = await collection(instanceId);
        for (const row of [...remaining.active, ...remaining.pending])
          expect(
            (
              await api(
                '/' + row.id,
                write(exact(row, instanceId), 'DELETE'),
                ownerToken,
                identity.workspace,
                instanceId,
              )
            ).status,
          ).toBe(204);
        await notify(ui.page);
        await manager.getByText('还没有记忆', { exact: true }).waitFor();
        expect(
          await manager
            .getByText(
              '聊天里提到的习惯和规则，Rice 会记下来等你确认；也可以直接新增。',
              { exact: true },
            )
            .count(),
        ).toBe(1);
        await shot('empty');
      } finally {
        await ui.close();
      }
    },
    180_000,
  );
});
