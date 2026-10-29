import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import type { EmployeeRuntimePackage } from '@allrice/contracts';
import {
  authenticateSession,
  createSession,
  revokeSession,
  getSessionNativeSubagentTarget,
  type NativeSubagentQueryTarget,
} from '@allrice/database';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { nativeBindingDescriptor } from '../../../../packages/database/src/native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import { bindJobNativeSession } from '../../../../packages/database/src/execution/queue.ts';
import * as artifact from '../../src/harness/dsh-native-artifact.ts';
import { readAuthorizedNativeSubagentSummary } from '../../src/harness/native-subagent-query.ts';
import { createNativeRunDiagnosticsHttpHandler } from '../../src/native-run-diagnostics-http.ts';
// This fixture installs test-only delegation to produce native descendants. It
// does not assert delegation is enabled in either production profile.
// @ts-expect-error existing actual Host fixture is JavaScript
import { gate, host, text } from '../native-subagent/fixture.mjs';

const cookie = vi.hoisted(() => ({ token: '' }));
// Only Next's request-local cookie adapter is replaced; Web/Worker auth and
// root resolution run against the isolated database with a real opaque token.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
const { GET } = await import(
  new URL(
    '../../../web/app/api/v1/sessions/[id]/subagents/route.ts',
    import.meta.url,
  ).href
);

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'authorized persisted native summary through the actual Web and Worker entrypoints',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    let directory: string;
    const servers: Server[] = [];
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
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        profile: resolve(
          import.meta.dirname,
          '../../dsh/allrice-restricted.cordis.yml',
        ),
      });
    });
    afterEach(async () => {
      cookie.token = '';
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function chat(persist = true) {
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
      await bindJobNativeSession({
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: runtime!.config_checksum,
          generation: runtime!.thread_generation,
          expectedThreadId: runtime!.thread_id,
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
            model: async () => text('native private child reply'),
            prepare: () =>
              vi.stubEnv('DSH_SESSION_ROOT', descriptor.storageNamespace),
          })
        : null;
      if (h) {
        const activation = await h.spawn();
        await activation.result;
        await h.wait();
        await h.ctx.sessions.flush(h.root.session);
      }
      return { ...f, descriptor, context: context!, token, h };
    }
    type Chat = Awaited<ReturnType<typeof chat>>;
    async function peer(f: Chat) {
      const id = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${id},${`${id}@example.test`},'peer','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${id},'member')`;
    return { ...(await createSession(id)), id };
    }
    async function start(
      f: Chat,
      afterRead?: (signal: AbortSignal) => Promise<void>,
    ) {
      const target = vi.fn(getSessionNativeSubagentTarget);
      const read = vi.fn(
        async (value: NativeSubagentQueryTarget, signal: AbortSignal) => {
          const summary = await readAuthorizedNativeSubagentSummary(
            value,
            signal,
          );
          await afterRead?.(signal);
          return summary;
        },
      );
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
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', base);
      const input = {
        sessionId: f.session,
        organizationId: f.org,
        workspaceId: f.workspace,
      };
      return {
        target,
        read,
        request: (
          body: unknown = input,
          token = f.token,
          signal?: AbortSignal,
          headers = {},
        ) =>
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
    function web(f: Chat, token = f.token, query = '') {
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
    async function files(root: string): Promise<unknown[]> {
      const result: unknown[] = [];
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
    async function writes(f: Chat) {
      return Promise.all([
        fixture.db`select * from allrice_jobs where id=${f.worker.jobId}`,
        fixture.db`select * from allrice_native_session_bindings where context_id=${f.session}`,
        fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`,
      ]);
    }
    async function replacePin(f: Chat, changes: Record<string, unknown>) {
      // Corrupt only this isolated fixture; production pins remain immutable.
      const [pin] =
        await fixture.db`delete from allrice_native_session_bindings where native_session_id=${f.descriptor.nativeSessionId} returning *`;
      await fixture.db`insert into allrice_native_session_bindings select * from jsonb_populate_record(null::allrice_native_session_bindings,${fixture.db.json({ ...pin, ...changes })})`;
    }

    it('returns an authorized persisted prefix beside a resident writer, without owner/close admission or writes', async () => {
      const f = await chat();
      await fixture.db`update allrice_conversation_runtimes set worker_id=null where session_id=${f.session}`;
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
