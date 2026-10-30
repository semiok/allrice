/* global process, Request, fetch, AbortController */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
      const h = persist
        ? await host({
            rootId: descriptor.nativeSessionId,
            model,
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
      return { ...f, descriptor, bound, context: context, token, h };
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
    async function start(f, afterRead) {
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
      const handler = createNativeRunDiagnosticsHttpHandler(undefined, {
        target,
        read,
      });
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
    function web(f, token = f.token, query = '') {
      cookie.token = token;
      return GET(
        new Request(
          `http://localhost/api/v1/sessions/${f.session}/subagents?workspaceId=${f.workspace}${query}`,
          {
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
