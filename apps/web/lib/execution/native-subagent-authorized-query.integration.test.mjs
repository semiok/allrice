/* global process, Request, fetch, AbortController, TextDecoder, console */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocket } from 'ws';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  authenticateSession,
  createSession,
  revokeSession,
  getSessionNativeSubagentTarget,
} from '@allrice/database';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { nativeBindingDescriptor } from '../../../../packages/database/src/native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import { bindJobNativeSession } from '../../../../packages/database/src/execution/queue.ts';
import * as artifact from '../../../worker/src/harness/dsh-native-artifact.ts';
import { readAuthorizedNativeSubagentSummary } from '../../../worker/src/harness/native-subagent-query.ts';
import { getHarnessRouter } from '../../../worker/src/harness/router.ts';
import { DshProtocolClient } from '../../../worker/src/harness/dsh-protocol-client.ts';
import { createNativeRunDiagnosticsHttpHandler } from '../../../worker/src/native-run-diagnostics-http.ts';
// This fixture installs test-only delegation to produce native descendants. It
// does not assert delegation is enabled in either production profile.
import {
  gate,
  hold,
  host,
  text,
} from '../../../worker/test/native-subagent/fixture.mjs';
const cookie = vi.hoisted(() => ({ token: '' }));
// Only Next's request-local cookie adapter is replaced; Web/Worker auth and
// root resolution run against the isolated database with a real opaque token.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
import { GET } from '../../app/api/v1/sessions/[id]/subagents/route';
import { AllRiceHttpServer } from '../../server.mjs';
import { createNativeSubagentFollowGateway } from '../../server/native-subagent-follow.mjs';
import { createSseDataConsumer } from '../../app/chatflow/sse-data-consumer';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'authorized persisted native summary through the actual Web and Worker entrypoints',
  () => {
    let fixture;
    let runtimePackage;
    let directory;
    const servers = [];
    const residents = [];
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      directory = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-query-authority-')),
      );
      const employee = await createEmployeeAdministrationFixture(fixture.db);
      runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...employee.definition,
          capabilities: {
            ...employee.definition.capabilities,
            nativeSkillIds: [],
          },
        },
        skills: [],
      });
      vi.spyOn(artifact, 'currentDshNativeLaunch');
    }, 120000);
    beforeEach(() => {
      for (const [key, value] of Object.entries({
        ALLRICE_ASSISTANTS_ENABLED: '1',
        ALLRICE_RUNTIME_POLICY_ENABLED: '1',
        ALLRICE_DSH_NATIVE_ARTIFACT_ID: 'sha256:' + 'c'.repeat(64),
        ALLRICE_DSH_RUNTIME_ROOT: directory,
        ALLRICE_PORTAL_AUTH_ENABLED: '0',
        ALLRICE_LOCAL_PORTAL: 'unified',
      }))
        vi.stubEnv(key, value);
      // Artifact verification is independently covered by dsh-native-artifact.
      // Substitute only the approved launch location with this same-generation
      // checkout; the reader module and all its public DSH services are real.
      vi.mocked(artifact.currentDshNativeLaunch).mockReturnValue({
        artifactId: 'sha256:' + 'b'.repeat(64),
        generation: 'dsh-0.2.1-rc.2-687f282',
        version: '0.2.1-rc.2',
        command: process.execPath,
        args: [
          resolve(
            import.meta.dirname,
            '../../../worker/dsh/allrice-jsonrpc-runtime.mjs',
          ),
        ],
        profile: resolve(
          import.meta.dirname,
          '../../../worker/dsh/allrice-restricted.cordis.yml',
        ),
      });
    });
    afterEach(async () => {
      cookie.token = '';
      for (const [pool, runtime] of residents.splice(0))
        await pool.closeOwned(runtime);
      for (const server of servers.splice(0)) {
        await server.nativeFollowGateway?.close();
        server.closeAllConnections();
        await new Promise((done) => server.close(() => done()));
      }
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function chat(
      persist = true,
      model = async () => text('native private child reply'),
      spawn = true,
      options = {},
    ) {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        runtimePackage,
        businessCreationOrigin: true,
      });
      await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
      const [runtime] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const descriptor = nativeBindingDescriptor({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        contextKey: f.session,
      });
      descriptor.storageNamespace = join(
        directory,
        f.org,
        f.workspace,
        f.user,
        f.session,
        'sessions',
      );
      const bound = await bindJobNativeSession({
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: runtime.config_checksum,
          generation: runtime.thread_generation,
          expectedThreadId: runtime.thread_id,
        },
        descriptor,
      });
      const { token } = await createSession(f.user);
      const context = await authenticateSession(token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      const listeners = new Set(),
        failures = new Set();
      const h = persist
        ? await host({
            ...options,
            rootId: descriptor.nativeSessionId,
            model,
            onNotification: (notice) => {
              for (const listener of listeners) listener(notice);
            },
            prepare: () =>
              vi.stubEnv('DSH_SESSION_ROOT', descriptor.storageNamespace),
          })
        : null;
      if (h && spawn) {
        const activation = await h.spawn();
        await activation.result;
        await h.wait();
        await h.ctx.sessions.flush(h.root.session);
      }
      return {
        ...f,
        descriptor,
        bound,
        context: context,
        token,
        h,
        listeners,
        failures,
      };
    }
    async function hotHost(f) {
      const target = await getSessionNativeSubagentTarget(
        f.context,
        f.workspace,
        f.session,
      );
      const pool = Reflect.get(
        getHarnessRouter().resolve('dsh'),
        'runtimePool',
      );
      // Only the stdio transport is in-process; the production pool, Host,
      // native status/query and both authenticated HTTP entrypoints are real.
      const runtime = {
        id: randomUUID(),
        sessionId: f.descriptor.nativeSessionId,
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        productSessionId: f.session,
        nativePin: f.bound.binding,
        nativeGeneration: target.generation,
        nativeTools: [],
        lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
        client: {
          processState: () => ({ state: 'running' }),
          nativeSubagentSummary:
            DshProtocolClient.prototype.nativeSubagentSummary.bind({
              request: (method, params) =>
                f.h.server.handleRequest(method, params),
            }),
          nativeSubagentSnapshot:
            DshProtocolClient.prototype.nativeSubagentSnapshot.bind({
              request: (method, params) =>
                f.h.server.handleRequest(method, params),
            }),
          subscribe: (listener) => {
            f.listeners.add(listener);
            return () => f.listeners.delete(listener);
          },
          onFailure: (listener) => {
            f.failures.add(listener);
            return () => f.failures.delete(listener);
          },
          close: () => f.h.server.closeRoot(f.h.root.id),
        },
      };
      Reflect.get(pool, 'runtimes').set(runtime.sessionId, runtime);
      residents.push([pool, runtime]);
      return { pool, runtime };
    }
    async function peer(f) {
      const id = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${id},${`${id}@example.test`},'peer','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${id},'member')`;
      return { ...(await createSession(id)), id };
    }
    async function start(f, afterRead, authenticate) {
      const target = vi.fn(getSessionNativeSubagentTarget);
      const read = vi.fn(async (value, signal, liveOnly) => {
        const summary = await readAuthorizedNativeSubagentSummary(
          value,
          signal,
          liveOnly,
        );
        await afterRead?.(signal);
        return summary;
      });
      const handler = createNativeRunDiagnosticsHttpHandler(
        authenticate ? { authenticate } : undefined,
        {
          target,
          read,
        },
      );
      const server = createServer(async (req, res) => {
        if (!(await handler(req, res))) {
          res.writeHead(404);
          res.end();
        }
      });
      servers.push(server);
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const base = `http://127.0.0.1:${server.address().port}`;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', base);
      const input = {
        sessionId: f.session,
        organizationId: f.org,
        workspaceId: f.workspace,
      };
      return {
        target,
        read,
        request: (body = input, token = f.token, signal, headers = {}) =>
          fetch(base + '/internal/native-subagent-summary', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              ...headers,
            },
            body: JSON.stringify(body),
            signal,
          }),
        input,
      };
    }
    function web(f, token = f.token, query = '', signal) {
      cookie.token = token;
      return GET(
        new Request(
          `http://localhost/api/v1/sessions/${f.session}/subagents?workspaceId=${f.workspace}${query}`,
          {
            signal,
            headers: {
              host: 'localhost',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': f.workspace,
            },
          },
        ),
        { params: Promise.resolve({ id: f.session }) },
      );
    }
    async function files(root) {
      const result = [];
      for (const name of (await readdir(root)).sort()) {
        const path = join(root, name),
          info = await stat(path);
        result.push([
          path,
          info.mtimeMs,
          info.isDirectory()
            ? await files(path)
            : createHash('sha256')
                .update(await readFile(path))
                .digest('hex'),
        ]);
      }
      return result;
    }
    async function writes(f) {
      return Promise.all([
        fixture.db`select * from allrice_jobs where id=${f.worker.jobId}`,
        fixture.db`select * from allrice_native_session_bindings where context_id=${f.session}`,
        fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`,
      ]);
    }
    async function replacePin(f, changes) {
      // Corrupt only this isolated fixture; production pins remain immutable.
      const [pin] =
        await fixture.db`delete from allrice_native_session_bindings where native_session_id=${f.descriptor.nativeSessionId} returning *`;
      await fixture.db`insert into allrice_native_session_bindings select * from jsonb_populate_record(null::allrice_native_session_bindings,${fixture.db.json({ ...pin, ...changes })})`;
    }
    function consume(response) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const reader = response.body.getReader(),
        decoder = new TextDecoder(),
        events = [];
      let buffered = '',
        detail;
      return {
        events,
        reader,
        detail: () => detail,
        async until(predicate) {
          while (true) {
            const boundary = buffered.indexOf('\n\n');
            if (boundary < 0) {
              const part = await reader.read();
              if (part.done)
                throw Error(
                  `closed before event: ${events.map((e) => e.type)}`,
                );
              buffered += decoder.decode(part.value, { stream: true });
              continue;
            }
            const packet = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            if (!packet.startsWith('data: ')) continue;
            const event = JSON.parse(packet.slice(6));
            events.push(event);
            if (event.type === 'snapshot')
              detail = { kind: 'hot', ...event.snapshot };
            if (event.type === 'display') {
              expect(detail).toMatchObject({
                kind: 'hot',
                rootId: event.rootId,
                childId: event.childId,
                hostEpoch: event.hostEpoch,
                stream: { instanceId: event.display.instanceId },
              });
              detail.stream = event.display;
            }
            // A summary cut replaces the hot detail view; it never appends another
            // copy of the final assistant row or interprets active:null as final.
            if (event.type === 'summary')
              detail = {
                kind: 'summary',
                child: event.summary?.descendants.find(
                  (row) => row.id === event.childId,
                ),
              };
            if (event.type === 'clear') detail = undefined;
            if (predicate(event)) return event;
          }
        },
      };
    }
    it.each(['summary-response', 'final-authorization'])(
      'continues A/B/C on one address when B starts during %s',
      async (window) => {
        const ready = [gate(), gate(), gate()],
          finish = [gate(), gate(), gate()],
          cut = gate(),
          release = gate();
        let selectedSession,
          attempt = 0;
        const f = await chat(true, undefined, false, {
          stream: async function* (request) {
            selectedSession ??= request.sessionId;
            const n = request.sessionId === selectedSession ? attempt++ : -1;
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield {
              type: 'text-delta',
              index: 0,
              text: n < 0 ? 'root acknowledged' : ['A', 'B', 'C'][n],
            };
            if (n >= 0) {
              ready[n].resolve();
              await hold(request.signal, finish[n]);
            }
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        });
        const a = await f.h.spawn(f.h.root, 'A', { delivery: 'caller' });
        await ready[0].promise;
        const { runtime } = await hotHost(f);
        const api = await start(f, async () => {
          if (window === 'summary-response') {
            cut.resolve();
            await release.promise;
          }
        });
        const originalTarget = api.target.getMockImplementation();
        let gated = false;
        api.target.mockImplementation(async (...args) => {
          const value = await originalTarget(...args);
          if (
            window === 'final-authorization' &&
            api.read.mock.calls.length &&
            !gated
          ) {
            gated = true;
            cut.resolve();
            await release.promise;
          }
          return value;
        });
        const abort = new AbortController();
        try {
          const consumer = consume(
            await web(
              f,
              f.token,
              `&follow=true&childId=${a.childId}`,
              abort.signal,
            ),
          );
          const initial = await consumer.until((e) => e.type === 'snapshot');
          finish[0].resolve();
          await a.result;
          await cut.promise;
          await f.h.ctx.subagents.sendMessage(f.h.root, a.childId, text('B'), {
            signal: abort.signal,
          });
          await ready[1].promise;
          expect(f.h.ctx.agents.get(a.childId)?.status).toBe('running');
          release.resolve();
          // A fresh native cut may precede its first text; its safe replacement
          // must then reach the same consumer, without waiting for another cut.
          await consumer.until(
            () => consumer.detail()?.stream?.active?.text === 'B',
          );
          const second = consumer.detail();
          expect(second.stream.instanceId).not.toBe(
            initial.snapshot.stream.instanceId,
          );
          expect(f.listeners.size).toBe(1);
          expect(consumer.detail().stream.active.text).toBe('B');
          finish[1].resolve();
          await f.h.wait();
          const settled = await consumer.until(
            (e) =>
              e.type === 'summary' &&
              e.summary?.descendants.some(
                (r) => r.id === a.childId && r.lastReply === 'B',
              ),
          );
          expect(
            settled.summary.descendants.find((r) => r.id === a.childId)
              .observation.source,
          ).toBe('prepared');
          expect(f.h.ctx.agents.get(a.childId)).toBeUndefined();
          const filesBefore = await files(f.descriptor.storageNamespace),
            sqlBefore = await writes(f),
            calls = f.h.calls.length,
            activity = runtime.lastActivityAt;
          await delay(50);
          expect(api.read).toHaveBeenCalledTimes(2);
          expect(await files(f.descriptor.storageNamespace)).toEqual(
            filesBefore,
          );
          expect(await writes(f)).toEqual(sqlBefore);
          expect(f.h.calls).toHaveLength(calls);
          expect(runtime.lastActivityAt).toBe(activity);
          await f.h.ctx.subagents.sendMessage(f.h.root, a.childId, text('C'), {
            signal: abort.signal,
          });
          await ready[2].promise;
          await consumer.until(
            () => consumer.detail()?.stream?.active?.text === 'C',
          );
          const third = consumer.detail();
          expect(third.stream.instanceId).not.toBe(second.stream.instanceId);
          expect(consumer.detail().stream.active.text).toBe('C');
          expect(f.listeners.size).toBe(1);
          expect(
            consumer.events.filter((e) => e.type === 'summary'),
          ).toHaveLength(2);
          expect(
            consumer.events.some(
              (e) =>
                e.type === 'terminal' ||
                (e.type === 'clear' && e.reason === 'unavailable'),
            ),
          ).toBe(false);
          console.log(
            'SESSION_FOLLOW_ABC',
            JSON.stringify({
              window,
              types: consumer.events.map((e) => e.type),
              snapshots: consumer.events
                .filter((e) => e.type === 'snapshot')
                .map((e) => e.snapshot.stream.active?.text),
              displays: consumer.events
                .filter((e) => e.type === 'display')
                .map((e) => e.display.active?.text),
              reads: api.read.mock.calls.length,
              listeners: f.listeners.size,
            }),
          );
          await consumer.reader.cancel();
          await vi.waitFor(() => expect(f.listeners.size).toBe(0));
        } finally {
          abort.abort();
          release.resolve();
          for (const end of finish) end.resolve();
          await a.result;
          await f.h.wait();
        }
      },
      30_000,
    );

    it('retains a nested selected address after a cold directory cut and a short native reactivation', async () => {
      const parentReady = gate(),
        parentEnd = gate(),
        childReady = gate(),
        childEnd = gate();
      const f = await chat(true, undefined, false, {
        depth: 2,
        stream: async function* (request, n) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield {
            type: 'text-delta',
            index: 0,
            text: n === 1 ? 'parent' : n === 2 ? 'nested A' : 'nested B',
          };
          if (n === 1) {
            parentReady.resolve();
            await hold(request.signal, parentEnd);
          } else if (n === 2) {
            childReady.resolve();
            await hold(request.signal, childEnd);
          }
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const parent = await f.h.spawn(f.h.root, 'parent', {
        delivery: 'caller',
      });
      await parentReady.promise;
      const parentAgent = f.h.ctx.agents.get(parent.childId),
        child = await f.h.spawn(parentAgent, 'nested A', {
          delivery: 'caller',
        });
      await childReady.promise;
      await hotHost(f);
      const api = await start(f),
        abort = new AbortController();
      try {
        const consumer = consume(
          await web(
            f,
            f.token,
            `&follow=true&childId=${child.childId}`,
            abort.signal,
          ),
        );
        await consumer.until((e) => e.type === 'snapshot');
        childEnd.resolve();
        await child.result;
        await consumer.until((e) => e.type === 'summary');
        await f.h.ctx.subagents.sendMessage(
          f.h.root,
          parent.childId,
          text('parent remains working'),
          { signal: abort.signal },
        );
        await consumer.until(
          (e) =>
            e.type === 'directory' &&
            e.summary.descendants.some(
              (r) => r.id === child.childId && r.kind === 'diagnostic',
            ),
        );
        expect(f.listeners.size).toBe(1);
        await f.h.ctx.subagents.sendMessage(
          parentAgent,
          child.childId,
          text('short continuation'),
          { signal: abort.signal },
        );
        const second = await consumer.until(
          (e) =>
            e.type === 'summary' &&
            e.summary?.descendants.some(
              (r) => r.id === child.childId && r.lastReply === 'nested B',
            ),
        );
        expect(
          second.summary.descendants.find((r) => r.id === child.childId),
        ).toMatchObject({
          parentId: parent.childId,
          running: null,
          observation: { source: 'prepared' },
          lastReply: 'nested B',
        });
        expect(consumer.detail()).toMatchObject({
          kind: 'summary',
          child: { lastReply: 'nested B' },
        });
        expect(api.read).toHaveBeenCalledTimes(2);
        expect(f.listeners.size).toBe(1);
        expect(
          consumer.events.some(
            (e) => e.type === 'clear' && e.reason === 'unavailable',
          ),
        ).toBe(false);
        console.log(
          'SESSION_FOLLOW_NESTED_SHORT',
          JSON.stringify({
            types: consumer.events.map((e) => e.type),
            reads: api.read.mock.calls.length,
            listeners: f.listeners.size,
          }),
        );
      } finally {
        abort.abort();
        childEnd.resolve();
        parentEnd.resolve();
        await child.result;
        await parent.result;
        await f.h.wait();
      }
    }, 30_000);

    it.each([
      ['a', 'b', 'b', 'ab', 'ab'],
      ['ab', '', 'b', 'ab', 'abb'],
      ['<thi', 'nk>PRIVATE_THINK', 'nk>PRIVATE_THINK</think>safe', '', 'safe'],
      [
        '<allrice_tool_call>PRIVATE_COMMAND',
        '',
        '</allrice_tool_call>',
        '',
        '',
      ],
    ])(
      'follows real authorized mid-attempt replacements and one safe prepared final: %s / %s',
      async (left, right, ending, before, after) => {
        const entered = gate(),
          release = gate(),
          updated = gate(),
          finish = gate();
        const f = await chat(true, undefined, false, {
          stream: async function* (request) {
            yield { type: 'text-delta', index: 0, text: left };
            yield { type: 'text-delta', index: 1, text: right };
            entered.resolve();
            await hold(request.signal, release);
            yield {
              type: 'block-end',
              index: 1,
              block: { type: 'text', text: ending },
            };
            updated.resolve();
            await hold(request.signal, finish);
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        });
        const activation = await f.h.spawn(f.h.root, 'opened detail', {
          delivery: 'caller',
        });
        const controller = new AbortController();
        try {
          await entered.promise;
          const { pool, runtime } = await hotHost(f);
          const original = runtime.client.nativeSubagentSnapshot;
          let first = true;
          runtime.client.nativeSubagentSnapshot = async (...args) => {
            const cut = await original(...args);
            if (first) {
              first = false;
              release.resolve();
              await updated.promise;
            }
            return cut;
          };
          const api = await start(f, () => {
            expect(f.h.ctx.agents.get(activation.childId)).toBeUndefined();
            expect(f.h.ctx.sessions.get(activation.childId)).toBeUndefined();
          });
          await f.h.ctx.sessions.flush(f.h.root.session);
          await f.h.ctx.sessions.flush(
            f.h.ctx.agents.get(activation.childId).session,
          );
          const storage = await files(f.descriptor.storageNamespace),
            sql = await writes(f),
            calls = f.h.calls.length,
            activity = runtime.lastActivityAt;
          const spies = ['acquire', 'lease', 'touch'].map((key) =>
            vi.spyOn(pool, key),
          );
          const consumer = consume(
            await web(
              f,
              f.token,
              `&follow=true&childId=${activation.childId}`,
              controller.signal,
            ),
          );
          const initial = await consumer.until((e) => e.type === 'snapshot');
          expect(initial.snapshot.stream.active.text).toBe(before);
          await consumer.until(
            (e) =>
              e.type === 'display' &&
              e.display.revision > initial.snapshot.stream.revision,
          );
          expect(consumer.detail().stream.active.text).toBe(after);
          expect(await files(f.descriptor.storageNamespace)).toEqual(storage);
          expect(await writes(f)).toEqual(sql);
          expect(runtime.lastActivityAt).toBe(activity);
          expect(f.h.calls).toHaveLength(calls);
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
          finish.resolve();
          await activation.result;
          await consumer.until((e) => e.type === 'summary');
          expect(consumer.detail()).toMatchObject({
            kind: 'summary',
            child: {
              mode: 'continuable',
              activity: 'inactive',
              running: null,
              observation: { source: 'prepared' },
              lastReply: after || null,
            },
          });
          expect(
            consumer.events.filter((e) => e.type === 'summary'),
          ).toHaveLength(1);
          expect(api.read).toHaveBeenCalledOnce();
          expect(api.read.mock.calls[0][2]).toBe(false);
          expect(JSON.stringify(consumer.events)).not.toMatch(
            /PRIVATE|<think>|allrice_tool_call|"frame"|"chunk"|"records"|argumentsDelta/,
          );
          expect(f.listeners.size).toBe(1);
          expect(f.failures.size).toBe(1);
          await consumer.reader.cancel();
          await vi.waitFor(() => {
            expect(f.listeners.size).toBe(0);
            expect(f.failures.size).toBe(0);
          });
        } finally {
          controller.abort();
          release.resolve();
          finish.resolve();
          await activation.result;
        }
      },
      30_000,
    );
    it('does not query target after an expired authorization returns late', async () => {
      const f = await chat();
      await hotHost(f);
      const authenticate = vi.fn(authenticateSession);
      const api = await start(f, undefined, authenticate);
      const abort = new AbortController(),
        entered = gate(),
        release = gate();
      const consumer = consume(
        await web(f, f.token, '&follow=true', abort.signal),
      );
      await consumer.until((e) => e.type === 'directory');
      const originalTimeout = globalThis.setTimeout;
      let deadline;
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn, ms, ...args) => {
          if (ms === 10_000) deadline = fn;
          return originalTimeout(fn, ms, ...args);
        });
      authenticate.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return f.context;
      });
      try {
        // Only notification invalidation is controlled; the HTTP gate and real target reader run unchanged.
        for (const listener of f.listeners)
          listener({
            method: 'session.status',
            params: { sessionId: f.h.root.id },
          });
        await entered.promise;
        const calls = api.target.mock.calls.length;
        deadline();
        expect(await consumer.until((e) => e.type === 'clear')).toEqual({
          type: 'clear',
          reason: 'unavailable',
        });
        expect((await consumer.reader.read()).done).toBe(true);
        expect(f.listeners.size).toBe(0);
        release.resolve();
        await new Promise((resolve) => originalTimeout(resolve, 0));
        expect(api.target).toHaveBeenCalledTimes(calls);
      } finally {
        timer.mockRestore();
        release.resolve();
        abort.abort();
      }
    }, 30_000);

    it('blind HTTP: nested child finished during the initial cut reaches a safe summary, not clear/unavailable', async () => {
      const pReady = gate(),
        gReady = gate(),
        pEnd = gate(),
        gEnd = gate(),
        cut = gate(),
        release = gate();
      const f = await chat(
        true,
        async (request, n) => {
          if (n === 1) {
            pReady.resolve();
            await hold(request.signal, pEnd);
          } else {
            gReady.resolve();
            await hold(request.signal, gEnd);
          }
          return text('nested safe final');
        },
        false,
        { depth: 2 },
      );
      const p = await f.h.spawn(f.h.root, 'parent', { delivery: 'caller' });
      await pReady.promise;
      const g = await f.h.spawn(f.h.ctx.agents.get(p.childId), 'nested', {
        delivery: 'caller',
      });
      await gReady.promise;
      const { runtime } = await hotHost(f),
        api = await start(f),
        abort = new AbortController();
      const original = runtime.client.nativeSubagentSummary;
      let first = true;
      runtime.client.nativeSubagentSummary = async (...args) => {
        const value = await original(...args);
        if (first) {
          first = false;
          cut.resolve();
          await release.promise;
        }
        return value;
      };
      try {
        const opening = web(
          f,
          f.token,
          `&follow=true&childId=${g.childId}`,
          abort.signal,
        );
        await cut.promise;
        gEnd.resolve();
        await g.result;
        release.resolve();
        const consumer = consume(await opening);
        const final = await consumer.until(
          (e) => e.type === 'summary' || e.type === 'clear',
        );
        console.log(
          'BLIND_NESTED_HTTP',
          JSON.stringify({
            types: consumer.events.map((e) => e.type),
            finishedSeen: f.h.notices.some(
              (n) =>
                n.method === 'subagent.finished' &&
                n.params.childSessionId === g.childId,
            ),
            preparedReads: api.read.mock.calls.length,
          }),
        );
        expect(final.type).toBe('summary');
        expect(
          final.summary.descendants.find((r) => r.id === g.childId).lastReply,
        ).toBe('nested safe final');
      } finally {
        abort.abort();
        release.resolve();
        gEnd.resolve();
        pEnd.resolve();
        await g.result;
        await p.result;
      }
    }, 30000);
    it('blind HTTP: a newer active instance survives the preceding activation finished notification', async () => {
      const readyA = gate(),
        readyB = gate(),
        endA = gate(),
        updateB = gate(),
        endB = gate(),
        snapshotEntered = gate(),
        snapshotRelease = gate();
      const f = await chat(true, undefined, false, {
        stream: async function* (request, n) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield {
            type: 'text-delta',
            index: 0,
            text: n === 1 ? 'first' : 'second',
          };
          if (n === 1) {
            readyA.resolve();
            await hold(request.signal, endA);
          } else if (n === 2) {
            readyB.resolve();
            await hold(request.signal, updateB);
            yield { type: 'text-delta', index: 0, text: ' update' };
            await hold(request.signal, endB);
          }
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const a = await f.h.spawn(f.h.root, 'first', { delivery: 'caller' });
      await readyA.promise;
      const { runtime } = await hotHost(f);
      await start(f);
      const abort = new AbortController();
      const original = runtime.client.nativeSubagentSnapshot;
      let first = true;
      runtime.client.nativeSubagentSnapshot = async (...args) => {
        if (first) {
          first = false;
          snapshotEntered.resolve();
          await snapshotRelease.promise;
        }
        return original(...args);
      };
      try {
        const consumer = consume(
          await web(
            f,
            f.token,
            `&follow=true&childId=${a.childId}`,
            abort.signal,
          ),
        );
        await snapshotEntered.promise;
        endA.resolve();
        await a.result;
        await f.h.ctx.subagents.sendMessage(
          f.h.root,
          a.childId,
          text('continue'),
          { signal: new AbortController().signal },
        );
        await readyB.promise;
        snapshotRelease.resolve();
        const snapshot = await consumer.until((e) => e.type === 'snapshot');
        expect(snapshot.snapshot.stream.active.text).toBe('second');
        updateB.resolve();
        const next = await consumer.until(
          (e) =>
            e.type === 'display' || e.type === 'summary' || e.type === 'clear',
        );
        console.log(
          'BLIND_REACTIVATION_HTTP',
          JSON.stringify({
            types: consumer.events.map((e) => e.type),
            running: f.h.ctx.agents.get(a.childId)?.status,
            terminalRow: next.summary?.descendants.find(
              (r) => r.id === a.childId,
            ),
          }),
        );
        expect(next.type).toBe('display');
        expect(next.display.active.text).toBe('second update');
      } finally {
        abort.abort();
        snapshotRelease.resolve();
        endA.resolve();
        updateB.resolve();
        endB.resolve();
        await a.result;
        await f.h.wait();
      }
    }, 30000);
    it('“只有本人能看，离开即断开”：real WS upgrade preserves Web/Worker authorization and generation revocation', async () => {
      const f = await chat();
      await hotHost(f);
      const api = await start(f),
        other = await peer(f),
        otherTenant = await chat(false);
      const server = new AllRiceHttpServer(),
        clients = [];
      server.on('upgrade', (_request, socket) => socket.destroy());
      server.on('request', async (req, res) => {
        const abort = new AbortController();
        res.once('close', () => abort.abort());
        cookie.token =
          req.headers.cookie?.match(/allrice_session=([^;]+)/)?.[1] ?? '';
        try {
          const result = await GET(
            new Request(`http://${req.headers.host}${req.url}`, {
              headers: req.headers,
              signal: abort.signal,
            }),
            { params: Promise.resolve({ id: f.session }) },
          );
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.flushHeaders();
          if (result.body) await pipeline(Readable.fromWeb(result.body), res);
          else res.end();
        } catch {
          res.destroy();
        }
      });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      servers.push(server);
      const origin = `http://127.0.0.1:${server.address().port}`;
      server.nativeFollowGateway = createNativeSubagentFollowGateway({
        port: server.address().port,
      });
      const connect = (
        token = f.token,
        workspace = f.workspace,
        source = origin,
        organization = f.org,
      ) => {
        const ws = new WebSocket(
          origin.replace('http:', 'ws:') +
            `/api/v1/sessions/${f.session}/subagents?workspaceId=${workspace}&organizationId=${organization}&follow=true&liveOnly=true`,
          {
            headers: {
              origin: source,
              ...(token ? { cookie: `allrice_session=${token}` } : {}),
            },
          },
        );
        ws.on('error', () => {});
        clients.push(ws);
        return ws;
      };
      try {
        for (const [token, workspace, source, organization] of [
          ['', f.workspace, origin],
          [other.token, f.workspace, origin],
          [f.token, randomUUID(), origin],
          [f.token, otherTenant.workspace, origin, otherTenant.org],
          [f.token, f.workspace, 'https://other.example'],
        ]) {
          const ws = connect(token, workspace, source, organization);
          const [, denied] = await once(ws, 'unexpected-response');
          expect([401, 403, 404]).toContain(denied.statusCode);
          ws.terminate();
        }
        expect(f.listeners.size).toBe(0);
        const ws = connect(),
          events = [],
          parse = createSseDataConsumer();
        ws.on('message', (bytes) => {
          for (const value of parse(bytes)) events.push(JSON.parse(value));
        });
        await vi.waitFor(() =>
          expect(events.some((e) => e.type === 'directory')).toBe(true),
        );
        expect(f.listeners.size).toBe(1);
        expect(api.read).not.toHaveBeenCalled();
        const closed = once(ws, 'close');
        await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
        for (const listener of f.listeners)
          listener({
            method: 'session.status',
            params: { sessionId: f.h.root.id },
          });
        await closed;
        expect(events.at(-1)).toEqual({ type: 'clear', reason: 'unavailable' });
        expect(
          events.filter((event) => event.type === 'directory'),
        ).toHaveLength(1);
        expect(f.listeners.size).toBe(0);
      } finally {
        for (const ws of clients) ws.terminate();
        await server.nativeFollowGateway.close();
      }
    }, 30_000);
    it('reconnects to the existing safe baseline, isolates children, and clears after real token revocation', async () => {
      const entered = gate(),
        finish = gate();
      let count = 0;
      const f = await chat(true, undefined, false, {
        stream: async function* (request) {
          yield {
            type: 'text-delta',
            index: 0,
            text: `safe:${request.sessionId}`,
          };
          if (++count === 2) entered.resolve();
          await hold(request.signal, finish);
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const a = await f.h.spawn(f.h.root, 'A', { delivery: 'caller' }),
        b = await f.h.spawn(f.h.root, 'B', { delivery: 'caller' });
      const controllers = [new AbortController(), new AbortController()];
      try {
        await entered.promise;
        await hotHost(f);
        const api = await start(f);
        const first = consume(
          await web(
            f,
            f.token,
            `&follow=true&childId=${a.childId}`,
            controllers[0].signal,
          ),
        );
        const baseline = await first.until((e) => e.type === 'snapshot');
        expect(baseline.snapshot.stream.active.text).toBe(`safe:${a.childId}`);
        expect(
          JSON.stringify(first.events.filter((e) => e.type !== 'directory')),
        ).not.toContain(`safe:${b.childId}`);
        controllers[0].abort();
        await vi.waitFor(() => expect(f.listeners.size).toBe(0));
        const second = consume(
          await web(
            f,
            f.token,
            `&follow=true&childId=${a.childId}`,
            controllers[1].signal,
          ),
        );
        expect(
          (await second.until((e) => e.type === 'snapshot')).snapshot.stream,
        ).toEqual(baseline.snapshot.stream);
        await revokeSession(f.token);
        for (const listener of f.listeners)
          listener({
            method: 'session.status',
            params: { sessionId: f.h.root.id },
          });
        expect(await second.until((e) => e.type === 'clear')).toEqual({
          type: 'clear',
          reason: 'unavailable',
        });
        expect((await second.reader.read()).done).toBe(true);
        expect(api.read).not.toHaveBeenCalled();
        expect(f.listeners.size).toBe(0);
      } finally {
        for (const c of controllers) c.abort();
        finish.resolve();
        await Promise.all([a.result, b.result]);
      }
    }, 30_000);
    it('keeps prepared replies in the full directory while a sibling runs and after both settle', async () => {
      // User intent: 打开已完成甲和运行中乙的目录，结束后仍能看各自摘要。
      const entered = gate(),
        finish = gate();
      const f = await chat(
        true,
        async (request, n) => {
          if (n === 2) {
            entered.resolve();
            await hold(request.signal, finish);
          }
          return text(n === 1 ? '21' : '55');
        },
        false,
      );
      const a = await f.h.spawn(f.h.root, '甲', { delivery: 'caller' });
      await a.result;
      const b = await f.h.spawn(f.h.root, '乙', { delivery: 'caller' });
      const abort = new AbortController();
      try {
        await entered.promise;
        const { pool, runtime } = await hotHost(f),
          api = await start(f);
        const spies = ['acquire', 'lease', 'touch'].map((key) =>
          vi.spyOn(pool, key),
        );
        const create = vi.spyOn(f.h.ctx.sessions, 'create'),
          activity = runtime.lastActivityAt,
          sql = await writes(f);
        const expectedA = {
          kind: 'child',
          id: a.childId,
          label: '甲',
          lastReply: '21',
          running: null,
          activity: 'inactive',
          observation: { source: 'prepared' },
        };
        const point = await (await web(f)).json();
        expect(api.read).toHaveBeenCalledTimes(1);
        expect(api.read.mock.calls[0][2]).toBeUndefined();
        api.read.mockClear();
        const stream = consume(
          await web(f, f.token, '&follow=true', abort.signal),
        );
        const first = await stream.until((e) => e.type === 'directory');
        expect(first.summary).toEqual(point.summary);
        expect(first.summary.root.source).toBe('live');
        expect(first.summary.descendants).toMatchObject([
          expectedA,
          { id: b.childId, label: '乙', running: true },
        ]);
        finish.resolve();
        await b.result;
        const final = await stream.until(
          (e) =>
            e.type === 'directory' &&
            e.summary.descendants.some(
              (row) =>
                row.kind === 'child' &&
                row.id === b.childId &&
                row.lastReply === '55' &&
                row.activity === 'inactive' &&
                row.observation.source === 'prepared',
            ),
        );
        expect(final.summary.descendants).toMatchObject([
          expectedA,
          {
            kind: 'child',
            id: b.childId,
            label: '乙',
            lastReply: '55',
            running: null,
            activity: 'inactive',
            observation: { source: 'prepared' },
          },
        ]);
        await stream.reader.cancel();
        const stored = await files(f.descriptor.storageNamespace);
        const reopened = consume(
          await web(f, f.token, '&follow=true', abort.signal),
        );
        expect(
          (await reopened.until((e) => e.type === 'directory')).summary,
        ).toEqual(final.summary);
        expect(await files(f.descriptor.storageNamespace)).toEqual(stored);
        expect(await writes(f)).toEqual(sql);
        expect(f.h.ctx.sessions.get(a.childId)).toBeUndefined();
        expect(f.h.ctx.sessions.get(b.childId)).toBeUndefined();
        expect(f.h.calls).toHaveLength(2);
        expect(create).not.toHaveBeenCalled();
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(runtime.lastActivityAt).toBe(activity);
        expect(api.read).toHaveBeenCalled();
        expect(api.read.mock.calls.every((args) => args[2] === false)).toBe(
          true,
        );
        await reopened.reader.cancel();
      } finally {
        abort.abort();
        finish.resolve();
        await b.result;
      }
    }, 30_000);
    it('keeps explicit directory probes liveOnly, rejects foreign children/owners, and clears a changed runtime owner', async () => {
      const f = await chat();
      const { pool, runtime } = await hotHost(f),
        api = await start(f),
        controller = new AbortController();
      const original = runtime.client.nativeSubagentSummary;
      const summary = vi
        .spyOn(runtime.client, 'nativeSubagentSummary')
        .mockImplementation((...args) => original(...args));
      const observe = vi.spyOn(f.h.ctx.sessionQuery, 'observeSession');
      try {
        const response = consume(
          await web(
            f,
            f.token,
            '&follow=true&liveOnly=true',
            controller.signal,
          ),
        );
        const initial = await response.until((e) => e.type === 'directory');
        const cold = initial.summary.descendants[0];
        expect(cold.kind).toBe('diagnostic');
        expect(observe.mock.calls.every(([id]) => id === f.h.root.id)).toBe(
          true,
        );
        const unauthorized = await peer(f);
        expect((await web(f, unauthorized.token, '&follow=true')).status).toBe(
          403,
        );
        const foreign = consume(
          await web(f, f.token, '&follow=true&childId=foreign'),
        );
        await foreign.until((e) => e.type === 'clear');
        expect(
          foreign.events.some(
            (e) => e.type === 'snapshot' || e.type === 'display',
          ),
        ).toBe(false);
        Reflect.get(pool, 'runtimes').set(runtime.sessionId, {
          ...runtime,
          id: randomUUID(),
        });
        for (const listener of f.listeners)
          listener({
            method: 'session.status',
            params: { sessionId: f.h.root.id },
          });
        await response.until((e) => e.type === 'clear');
        expect((await response.reader.read()).done).toBe(true);
        expect(summary.mock.calls.every((args) => args[1] === true)).toBe(true);
        expect(api.read).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        Reflect.get(pool, 'runtimes').set(runtime.sessionId, runtime);
      }
      await pool.closeOwned(runtime);
      const afterClose = await files(f.descriptor.storageNamespace);
      const coldResponse = await web(f, f.token, '&follow=true');
      expect(coldResponse.status).toBe(503);
      expect(await files(f.descriptor.storageNamespace)).toEqual(afterClose);
      expect(api.read).not.toHaveBeenCalled();
    }, 30_000);
    it.each([true, false])(
      'rejects changed namespace/distribution and clears a business generation switch (liveOnly=%s)',
      async (liveOnly) => {
        const f = await chat(),
          { runtime } = await hotHost(f),
          api = await start(f),
          controller = new AbortController();
        const summary = vi.spyOn(runtime.client, 'nativeSubagentSummary');
        const query = `&follow=true${liveOnly ? '&liveOnly=true' : ''}`;
        const launch = artifact.currentDshNativeLaunch('restricted');
        vi.stubEnv('ALLRICE_DSH_RUNTIME_ROOT', join(directory, 'other'));
        expect((await web(f, f.token, query)).status).toBe(503);
        vi.stubEnv('ALLRICE_DSH_RUNTIME_ROOT', directory);
        vi.mocked(artifact.currentDshNativeLaunch).mockReturnValue({
          ...launch,
          generation: 'another-generation',
        });
        expect((await web(f, f.token, query)).status).toBe(503);
        expect(summary).not.toHaveBeenCalled();
        expect(f.listeners.size).toBe(0);
        vi.mocked(artifact.currentDshNativeLaunch).mockReturnValue(launch);
        try {
          const consumer = consume(
            await web(f, f.token, query, controller.signal),
          );
          await consumer.until((e) => e.type === 'directory');
          await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
          for (const listener of f.listeners)
            listener({
              method: 'session.status',
              params: { sessionId: f.h.root.id },
            });
          await consumer.until((e) => e.type === 'clear');
          expect((await consumer.reader.read()).done).toBe(true);
          expect(f.listeners.size).toBe(0);
          expect(
            consumer.events.filter((event) => event.type === 'directory'),
          ).toHaveLength(1);
          if (liveOnly) expect(api.read).not.toHaveBeenCalled();
          else
            expect(api.read.mock.calls.every((args) => args[2] === false)).toBe(
              true,
            );
        } finally {
          controller.abort();
        }
      },
      30_000,
    );
    it('cancels a blocked real HTTP writer on bounded notification overflow without touching Host execution', async () => {
      const f = await chat(),
        { runtime } = await hotHost(f),
        api = await start(f),
        controller = new AbortController();
      const original = ServerResponse.prototype.write,
        blocked = gate();
      let block = true;
      const write = vi
        .spyOn(ServerResponse.prototype, 'write')
        .mockImplementation(function (chunk, ...args) {
          const result = original.call(this, chunk, ...args);
          // Only the socket's drain signal is held; the authorized Worker HTTP
          // response, Node once/drain cancellation and Web body remain real.
          if (
            block &&
            typeof chunk === 'string' &&
            chunk.startsWith('data: ')
          ) {
            block = false;
            blocked.resolve();
            return false;
          }
          return result;
        });
      try {
        const consumer = consume(
          await web(
            f,
            f.token,
            '&follow=true&liveOnly=true',
            controller.signal,
          ),
        );
        await blocked.promise;
        await consumer.until((e) => e.type === 'directory');
        const activity = runtime.lastActivityAt,
          calls = f.h.calls.length;
        for (let i = 0; i < 129; i++)
          for (const listener of f.listeners)
            listener({
              method: 'session.status',
              params: { sessionId: f.h.root.id },
            });
        await consumer.until((e) => e.type === 'clear');
        expect((await consumer.reader.read()).done).toBe(true);
        expect(f.listeners.size).toBe(0);
        expect(f.failures.size).toBe(0);
        expect(api.read).not.toHaveBeenCalled();
        expect(runtime.lastActivityAt).toBe(activity);
        expect(f.h.calls).toHaveLength(calls);
      } finally {
        write.mockRestore();
        controller.abort();
      }
    }, 30_000);
    it('returns an authorized persisted prefix beside a resident writer, without owner/close admission or writes', async () => {
      const f = await chat();
      await fixture.db`update allrice_conversation_runtimes set state='idle',worker_id=null,active_run_id=null,active_turn_id=null where session_id=${f.session}`;
      const api = await start(f),
        before = await files(f.descriptor.storageNamespace),
        sql = await writes(f),
        calls = f.h.calls.length;
      const response = await web(f);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body.summary).toMatchObject({
        rootId: f.descriptor.nativeSessionId,
        root: { source: 'prepared' },
        descendants: [
          {
            kind: 'child',
            activity: 'unknown',
            running: null,
            observation: { source: 'prepared' },
            lastReply: 'native private child reply',
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain(directory);
      expect(api.target).toHaveBeenCalledTimes(2);
      expect(await files(f.descriptor.storageNamespace)).toEqual(before);
      expect(await writes(f)).toEqual(sql);
      expect(f.h.calls).toHaveLength(calls);
      expect(f.h.ctx.agents.get(f.descriptor.nativeSessionId)).toBe(f.h.root);
    });
    it('shows actual native running then resident idle through Web GET, and falls back to unknown after cooling without reads waking work', async () => {
      // User intent: 看看我的子智能体各自在做什么。
      const entered = gate(),
        release = gate();
      const f = await chat(
        true,
        async (request) => {
          if (request.sessionId !== f.descriptor.nativeSessionId) {
            entered.resolve();
            await hold(request.signal, release);
          }
          return text('parent answer');
        },
        false,
      );
      const activation = await f.h.spawn(f.h.root, '只读检查任务');
      await entered.promise;
      const child = f.h.ctx.agents.get(activation.childId);
      const { pool, runtime } = await hotHost(f);
      await start(f);
      const beforeActivity = runtime.lastActivityAt;
      const live = await web(f, f.token, '&liveOnly=true');
      expect(live.status).toBe(200);
      expect((await live.json()).summary.descendants[0]).toMatchObject({
        running: true,
        task: '只读检查任务',
        observation: { source: 'live' },
      });
      f.h.inject(child, '下个 step 再处理');
      await f.h.ctx.subagents.interruptByParent(
        child.id,
        f.h.root.id,
        'continuable',
      );
      await child.whenIdle();
      await f.h.wait();
      for (const session of f.h.ctx.sessions.list())
        await f.h.ctx.sessions.flush(session);
      const beforeFiles = await files(f.descriptor.storageNamespace),
        beforeSql = await writes(f),
        calls = f.h.calls.length;
      const beforeHosts = pool.inventory().map((row) => row.id);
      const idle = await web(f);
      expect(idle.status).toBe(200);
      expect((await idle.json()).summary.descendants[0]).toMatchObject({
        activity: 'running',
        running: false,
        task: '只读检查任务',
      });
      expect(runtime.lastActivityAt).toBe(beforeActivity);
      expect(pool.inventory().map((row) => row.id)).toEqual(beforeHosts);
      expect(await files(f.descriptor.storageNamespace)).toEqual(beforeFiles);
      expect(await writes(f)).toEqual(beforeSql);
      expect(f.h.calls).toHaveLength(calls);
      await pool.reclaimIdle();
      expect(pool.get(runtime.sessionId)).toBeUndefined();
      const cold = await web(f);
      expect(cold.status).toBe(200);
      expect((await cold.json()).summary).toMatchObject({
        root: { source: 'prepared' },
        descendants: [
          { running: null, activity: 'unknown', task: '只读检查任务' },
        ],
      });
      expect(f.h.calls).toHaveLength(calls);
    });
    it('does not read unloaded child JSONL during a real hot liveOnly GET, and retains the unknown branch', async () => {
      // Independent Astra P2 reproduction: normal child completion unloads it
      // while its root Host stays resident. No query/native read mocks.
      const f = await chat();
      const { runtime } = await hotHost(f);
      expect(
        f.h.ctx.sessions.list().map((session) => String(session.id)),
      ).toEqual([f.descriptor.nativeSessionId]);
      const open = vi.spyOn(f.h.ctx.sessionPersistence, 'open');
      const storedStat = vi.spyOn(f.h.ctx.sessionPersistence, 'stat');
      const before = runtime.lastActivityAt;
      await start(f);
      try {
        const response = await web(f, f.token, '&liveOnly=true');
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.summary).toMatchObject({
          root: { source: 'live' },
          descendants: [
            { kind: 'diagnostic', depth: 1, reason: 'unavailable' },
          ],
        });
        expect(body.summary.descendants).toHaveLength(1);
        expect(runtime.lastActivityAt).toBe(before);
        expect(
          open.mock.calls.filter((call) => call[1] === 'read'),
        ).toHaveLength(0);
        expect(storedStat).not.toHaveBeenCalled();
        const full = await web(f);
        expect(full.status).toBe(200);
        expect((await full.json()).summary.descendants).toMatchObject([
          {
            kind: 'child',
            running: null,
            observation: { source: 'prepared' },
            lastReply: 'native private child reply',
          },
        ]);
        expect(
          open.mock.calls.filter((call) => call[1] === 'read'),
        ).toHaveLength(1);
        expect(storedStat).toHaveBeenCalled();
      } finally {
        open.mockRestore();
        storedStat.mockRestore();
      }
    });
    it('uses liveOnly as a local probe without reading or creating an absent journal; default reads still fail', async () => {
      const f = await chat(false);
      await start(f);
      expect(await (await web(f, f.token, '&liveOnly=true')).json()).toEqual({
        summary: null,
      });
      await expect(stat(f.descriptor.storageNamespace)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await web(f)).status).toBe(503);
      expect((await web(f, f.token, '&liveOnly=false')).status).toBe(400);
    });
    it('does not hide a mismatched local owner or old generation as a successful empty liveOnly probe', async () => {
      const f = await chat();
      const { runtime } = await hotHost(f);
      await start(f);
      for (const key of ['ownerId', 'nativeGeneration']) {
        const old = runtime[key];
        runtime[key] = key === 'nativeGeneration' ? old + 1 : randomUUID();
        expect((await web(f, f.token, '&liveOnly=true')).status).toBe(503);
        runtime[key] = old;
      }
      const live = await web(f, f.token, '&liveOnly=true');
      expect(live.status).toBe(200);
      expect((await live.json()).summary.root.source).toBe('live');
    });
    it('rejects anonymous, same-tenant peer, foreign tenant and workspace before reading', async () => {
      const f = await chat(false),
        other = await chat(false),
        p = await peer(f),
        api = await start(f);
      expect((await web(f, '')).status).toBe(401);
      expect((await web(f, p.token)).status).toBe(403);
      expect((await api.request(undefined, p.token)).status).toBe(404);
      expect((await api.request(undefined, other.token)).status).toBe(404);
      expect(
        (await api.request({ ...api.input, workspaceId: other.workspace }))
          .status,
      ).toBe(404);
      expect(api.read).not.toHaveBeenCalled();
    });
    it('rejects caller-selected native identities, paths, packages, Worker addresses and browser Origin', async () => {
      const f = await chat(false),
        api = await start(f);
      for (const field of [
        'nativeSessionId',
        'storageNamespace',
        'artifactId',
        'workerUrl',
      ]) {
        expect(
          (await api.request({ ...api.input, [field]: '/foreign' })).status,
        ).toBe(400);
        expect((await web(f, f.token, `&${field}=foreign`)).status).toBe(400);
      }
      expect(
        (
          await api.request(undefined, f.token, undefined, {
            origin: 'https://foreign.example',
          })
        ).status,
      ).toBe(404);
      expect(api.target).not.toHaveBeenCalled();
      expect(api.read).not.toHaveBeenCalled();
    });
    it.each([
      'logout',
      'membership',
      'owner',
      'archive',
      'generation',
      'thread',
      'pin',
    ])('suppresses a real completed read after %s changes', async (change) => {
      const f = await chat(),
        p = await peer(f);
      const api = await start(f, async () => {
        if (change === 'logout') await revokeSession(f.token);
        if (change === 'membership')
          await fixture.db`update allrice_memberships set active=false where user_id=${f.user}`;
        if (change === 'owner')
          await fixture.db`update allrice_chat_sessions set owner_id=${p.id} where id=${f.session}`;
        if (change === 'archive')
          await fixture.db`update allrice_chat_sessions set archived_at=now() where id=${f.session}`;
        if (change === 'generation')
          await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
        if (change === 'thread')
          await fixture.db`update allrice_conversation_runtimes set thread_id=${'dsh-' + randomUUID()} where session_id=${f.session}`;
        if (change === 'pin')
          await replacePin(f, {
            artifact_id: 'sha256:' + 'd'.repeat(64),
            artifact_manifest_digest: 'sha256:' + 'd'.repeat(64),
          });
      });
      const response = await web(f);
      expect(response.status).toBe(
        change === 'logout'
          ? 401
          : ['membership', 'owner', 'archive'].includes(change)
            ? 404
            : 503,
      );
      expect(await response.text()).not.toContain('native private child reply');
      expect(api.read).toHaveBeenCalledTimes(1);
    });
    it.each(['namespace', 'scope', 'origin', 'generation', 'missing'])(
      'does not fall back for an invalid %s pin/root',
      async (change) => {
        const f = await chat(false);
        if (change === 'namespace')
          await replacePin(f, {
            storage_namespace:
              '/other-root' +
              f.descriptor.storageNamespace.slice(directory.length),
          });
        if (change === 'scope')
          await replacePin(f, { context_id: randomUUID() });
        if (change === 'origin')
          await replacePin(f, {
            root_origin_digest: 'sha256:' + '0'.repeat(64),
          });
        if (change === 'generation')
          await replacePin(f, { distribution_generation: 'dsh-other' });
        if (change === 'missing')
          await fixture.db`delete from allrice_native_session_bindings where native_session_id=${f.descriptor.nativeSessionId}`;
        const api = await start(f),
          response = await api.request();
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('summary');
        if (change !== 'namespace') expect(api.read).not.toHaveBeenCalled();
      },
    );
    it('does not create a missing native namespace or return an empty tree', async () => {
      const f = await chat(false),
        api = await start(f),
        sql = await writes(f);
      expect((await api.request()).status).toBe(503);
      await expect(stat(f.descriptor.storageNamespace)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await writes(f)).toEqual(sql);
    });
    it('returns unavailable for a malformed native root catalog, preserving the source bytes', async () => {
      const f = await chat(false);
      const h = await host({
        prepare: () => {
          vi.stubEnv('DSH_SESSION_ROOT', f.descriptor.storageNamespace);
        },
      });
      // Malformed fixture through the public Session append/flush API, without
      // an Agent for that root, JSONL paths or changes to the native parser.
      const root = h.ctx.sessions.create(f.descriptor.nativeSessionId, {
        meta: { createdAt: 1, cwd: h.directory },
      });
      root.append('subagent/catalog', { bad: true });
      const writer = await h.ctx.sessionPersistence.create(root.header);
      try {
        await writer.append(root.snapshotEvents());
        await writer.flush();
      } finally {
        await writer.close();
      }
      const before = await files(f.descriptor.storageNamespace),
        api = await start(f);
      const response = await api.request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('native private child reply');
      expect(await files(f.descriptor.storageNamespace)).toEqual(before);
    });
    it('rejects a missing approved reader instead of starting a Host or returning empty state', async () => {
      const f = await chat(false),
        api = await start(f);
      vi.mocked(artifact.currentDshNativeLaunch).mockImplementation(() => {
        throw Error('DSH_NATIVE_ARTIFACT_NOT_INSTALLED');
      });
      expect((await api.request()).status).toBe(503);
      await expect(stat(f.descriptor.storageNamespace)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('propagates an HTTP disconnect to the read and finishes without publishing its result', async () => {
      const f = await chat();
      const started = gate(),
        aborted = gate();
      const api = await start(f, async (signal) => {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        started.resolve();
        await aborted.promise;
        signal.throwIfAborted();
      });
      const controller = new AbortController(),
        pending = api.request(undefined, f.token, controller.signal);
      const rejected = expect(pending).rejects.toBeDefined();
      await started.promise;
      controller.abort();
      await rejected;
      await aborted.promise;
      expect(api.read).toHaveBeenCalledTimes(1);
    });
  },
);
