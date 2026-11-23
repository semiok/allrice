import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
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
import type * as Database from '@allrice/database';
import {
  authenticateSession,
  createSession,
  revokeSession,
  createChatSession,
  ensureGeneralEmployeeInstance,
  ensureDEntryNativeRoot,
  updateDEntryReleasePolicy,
  getDEntryHistoryRootPin,
  closeDEntryAuthorityFeeds,
  requireDEntryNativeIdentity,
  DataAccessError,
  type DEntryAuthoritySubscription,
} from '@allrice/database';
import {
  HostHistorySnapshotSchema,
  makeObjectKey,
  type EmployeeRuntimePackage,
  type HostHistoryBinding,
  type StorageObject,
} from '@allrice/contracts';
import {
  HostHistoryStore,
  HostHistorySourceStore,
  LocalStorageAdapter,
  hostHistoryDigest,
  type HostHistorySource,
} from '@allrice/storage';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import { createDEntryHistoryRouteHandlers } from './history-authority';
import { createColdHistorySource } from './history-source';
import type { DEntryNativeResource } from './native-resource';
import { GET as historyGET } from '../../app/api/v1/d-entry/history/route';
import { GET as downloadGET } from '../../app/api/v1/d-entry/history/download/route';
import { POST as liveAdmission } from '../../app/api/v1/d-entry/admission/route';

const trace = vi.hoisted(() => ({
  token: '',
  calls: [] as number[],
  subscriptions: [] as Array<
    DEntryAuthoritySubscription & { close: ReturnType<typeof vi.fn> }
  >,
  beforeWatch: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && trace.token
        ? { value: trace.token }
        : undefined,
  }),
}));
vi.mock('@allrice/database', async (original) => {
  const actual = await original<typeof Database>();
  return {
    ...actual,
    async watchDEntryHistoryAuthority(
      ...args: Parameters<typeof actual.watchDEntryHistoryAuthority>
    ) {
      trace.calls.push(args.length);
      await trace.beforeWatch?.();
      // Actual owner, actual default PG LISTEN feed, no injected test feed.
      const subscription = await actual.watchDEntryHistoryAuthority(...args);
      const tracked = {
        revoked: subscription.revoked,
        expiresAt: subscription.expiresAt,
        close: vi.fn(async () => {
          await subscription.close();
        }),
      };
      trace.subscriptions.push(tracked);
      return tracked;
    },
  };
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'MET274 real 271 cookie/PG authority with explicit 273 projection substitutes',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', process.env.ALLRICE_TEST_DATABASE_URL!);
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        `sha256:${'a'.repeat(64)}`,
      );
      fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const source = await createEmployeeAdministrationFixture(fixture.db);
      runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            nativeSkillIds: [],
          },
        },
        skills: [],
      });
    }, 120000); // Existing isolated migration fixture setup budget, not a test timeout change.
    beforeEach(() => {
      trace.token = '';
      trace.calls = [];
      trace.subscriptions = [];
      trace.beforeWatch = undefined;
    });
    afterEach(async () => {
      await Promise.all(
        trace.subscriptions.map((subscription) => subscription.close()),
      );
      await closeDEntryAuthorityFeeds();
      trace.beforeWatch = undefined;
      trace.token = '';
    });
    afterAll(async () => {
      await closeDEntryAuthorityFeeds();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });

    /** Fixture setup alone may call existing owner writers to establish test
     * data. The production consumer imports only root-read/watch and types/errors.
     * No copied claim/pin SQL, native runtime producer or physical VM is used. */
    async function setup(
      rootState: 'bound' | 'missing' | 'claim-only' = 'bound',
    ) {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        runtimePackage,
        toolNames: runtimePackage.runtimeManifest.toolNames,
        allowedTools: runtimePackage.runtimeManifest.toolNames,
        runtimePolicy: {
          harness: 'dsh',
          provider: runtimePackage.runtimeManifest.provider,
          model: runtimePackage.runtimeManifest.model,
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic-never-resolved',
          baseUrl: null,
        },
      });
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('fixture login unavailable');
      trace.token = login.token;
      const thread = await createChatSession(
        context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          title: '关机后读历史，不继续旧执行',
        },
        { executionGeneration: '4.0' },
      );
      const selection = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
        threadId: thread.id,
      };
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      await updateDEntryReleasePolicy(context, {
        revision: 'fixture-enable',
        defaultGeneration: '3.x',
        selections: [
          {
            organizationId: f.org,
            personId: f.user,
            employeeInstanceId: f.assignment,
            generation: '4.0',
          },
        ],
      });
      const identity = await requireDEntryNativeIdentity(context, selection);
      const nativeSessionId = `fixture-root-${randomUUID()}`;
      const fact = {
        nativeSessionId,
        host: {
          binding: {
            organizationId: f.org,
            personId: f.user,
            vmId: randomUUID(),
            instanceId: randomUUID(),
            leaseEpoch: 1,
          },
          bindingRef: randomUUID(),
          rosterDigest: 'fixture-native-create-receipt',
        },
      };
      const create = vi.fn(async () => {
        if (rootState === 'claim-only')
          throw Error('fixture-lost-native-reply');
        return fact;
      });
      if (rootState !== 'missing') {
        const operation = ensureDEntryNativeRoot(context, selection, identity, {
          operationId: randomUUID(),
          host: fact.host,
          signal: new AbortController().signal,
          create,
        });
        if (rootState === 'claim-only')
          await expect(operation).rejects.toThrow('fixture-lost-native-reply');
        else await operation;
      }
      const binding: HostHistoryBinding = {
        ...selection,
        organizationId: f.org,
        personId: f.user,
        nativeInstanceRef: 'TEST-273-COLD-INSTANCE',
        nativeProfileRef: 'TEST-273-PROFILE',
        nativeSessionId,
        rootNativeSessionId: nativeSessionId,
        parentNativeSessionId: null,
        configurationRef: 'TEST-273-RECORDED-CONFIG',
        configurationDigest: hostHistoryDigest('test-config-pin'),
        executionGeneration: '4.0',
      };
      const bytes = new TextEncoder().encode(
        'persistent attachment test bytes',
      );
      const object: StorageObject = {
        id: randomUUID(),
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        key: '',
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        sizeBytes: bytes.length,
        mediaType: 'text/plain',
        immutable: true,
        deletedAt: null,
        retentionUntil: null,
      };
      object.key = makeObjectKey({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        category: 'exports',
        objectId: object.id,
      });
      const header = {
        id: nativeSessionId,
        version: 4 as const,
        createdAt: 1,
        isSeeded: false,
      };
      const snapshot = HostHistorySnapshotSchema.parse({
        schemaVersion: 1,
        binding,
        source: {
          dshVersion: '0.2.1-rc.2',
          sessionFormatVersion: 4,
          headerHash: hostHistoryDigest(header),
          inheritedEventCount: 0,
          throughSeq: 4,
          eventHashes: Array.from({ length: 5 }, (_, i) =>
            hostHistoryDigest(i),
          ),
        },
        entries: [
          {
            kind: 'message',
            seq: 1,
            time: 1,
            role: 'user',
            text: '关机后读历史，不继续旧执行',
            interrupted: false,
          },
          {
            kind: 'tool',
            seq: 2,
            time: 2,
            callId: 'old-execution-call',
            name: 'business_publish',
            arguments: '{}',
            outcome: 'outcome-unknown',
            result: {
              seq: 3,
              text: 'Unverified external outcome',
              isError: true,
              errorCode: 'TOOL_OUTCOME_UNKNOWN',
            },
          },
          { kind: 'turn-end', seq: 4, time: 4, turn: 1, reason: 'interrupted' },
        ],
        attachments: [
          {
            sourceSeq: 3,
            objectId: object.id,
            checksum: object.checksum,
            sizeBytes: bytes.length,
            mediaType: object.mediaType,
            fileName: 'receipt.txt',
          },
        ],
        lastTurn: { startSeq: 0, endSeq: 4, reason: 'interrupted' },
      });
      const root = join(fixture.storageRoot, 'history', randomUUID());
      const store = new HostHistoryStore(root);
      const digest = await store.publish(
        snapshot,
        new AbortController().signal,
      );
      const storage = new LocalStorageAdapter(fixture.storageRoot);
      await storage.put(object, new Blob([bytes]).stream());
      // Explicit object-ACL contract substitute; 271 authority is not object ACL.
      const objectRevoked = new AbortController();
      const owner = {
        object,
        revoked: objectRevoked.signal,
        reauthorize: async () => object,
        open: vi.fn(async () => storage.get(object)),
        close: vi.fn(async () => undefined),
      };
      const files = {
        spoolDirectory: join(fixture.storageRoot, 'spool'),
        acquire: async () => owner,
      };
      const sources = new HostHistorySourceStore(root, store);
      const pin = await getDEntryHistoryRootPin(context, selection);
      const manifest: HostHistorySource | null = pin && {
        schemaVersion: 1 as const,
        key: {
          ...selection,
          organizationId: f.org,
          personId: f.user,
          rootNativeSessionId: pin.rootNativeSessionId,
          rootOriginDigest: pin.rootOriginDigest,
          rootBindingRef: pin.rootBindingRef,
          vmId: pin.vmId,
        },
        sessions: [{ binding, snapshotDigest: digest, header }],
        edges: [],
      };
      if (manifest)
        await sources.publish(manifest, new AbortController().signal);
      const bind =
        vi.fn<(resource: DEntryNativeResource, signal: AbortSignal) => void>();
      function makeColdSource(
        input: Omit<Parameters<typeof createColdHistorySource>[0], 'sources'>,
        currentSources = sources,
      ) {
        const cold = createColdHistorySource({
          sources: currentSources,
          ...input,
        });
        return {
          ...cold,
          binding(resource: DEntryNativeResource, active: AbortSignal) {
            bind(resource, active);
            return cold.binding(resource, active);
          },
          close: vi.fn(() => cold.close()),
        };
      }
      const scopes: ReturnType<typeof makeColdSource>[] = [];
      const createColdSource = vi.fn(
        (...args: Parameters<typeof makeColdSource>) => {
          const cold = makeColdSource(...args);
          scopes.push(cold);
          return cold;
        },
      );
      const ports = { createColdSource, files };
      const request = (download = false, signal?: AbortSignal) =>
        new Request(
          `https://allrice.test/api/v1/d-entry/history${download ? '/download' : ''}?${new URLSearchParams(
            {
              ...selection,
              nativeSessionId,
              ...(download
                ? { objectId: object.id, snapshotDigest: digest }
                : { limit: '1' }),
            },
          )}`,
          {
            signal,
            headers: {
              host: 'allrice.test',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': f.workspace,
            },
          },
        );
      return {
        ...f,
        context,
        login,
        thread,
        selection,
        identity,
        create,
        binding,
        ports,
        createColdSource,
        scopes,
        sources,
        manifest,
        snapshot,
        bind,
        store,
        root,
        digest,
        request,
        bytes,
        owner,
      };
    }

    it('“关机后读历史，不继续旧执行” authenticates the actual cookie and reads persistent paginated projection with formal root/watch', async () => {
      const f = await setup();
      const pin = await getDEntryHistoryRootPin(f.context, f.selection);
      const reopened = new HostHistorySourceStore(
        f.root,
        new HostHistoryStore(f.root),
      );
      const handlers = createDEntryHistoryRouteHandlers({
        ...f.ports,
        createColdSource: (input) => f.createColdSource(input, reopened),
      });
      const first = await handlers.history(f.request());
      expect(first.status).toBe(200);
      const page = await first.json();
      expect(page.snapshotDigest).toBe(f.digest);
      expect(page.nextCursor).not.toBeNull();
      const url = new URL(f.request().url);
      for (const [key, value] of Object.entries(page.nextCursor))
        url.searchParams.set(key, String(value));
      url.searchParams.set('limit', '100');
      const second = await handlers.history(
        new Request(url, { headers: f.request().headers }),
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        snapshotDigest: f.digest,
        notice: 'interrupted',
        externalEffects: 'unverified',
        entries: expect.arrayContaining([
          expect.objectContaining({ kind: 'tool', outcome: 'outcome-unknown' }),
        ]),
      });
      expect(await getDEntryHistoryRootPin(f.context, f.selection)).toEqual(
        pin,
      );
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(trace.calls).toEqual([4, 4]);
      expect(
        trace.subscriptions.every(
          (subscription) => subscription.close.mock.calls.length === 1,
        ),
      ).toBe(true);
    });

    it('keeps archived/withdrawn/viewer/rollout-off history readable while native execution admission still denies', async () => {
      const f = await setup();
      await updateDEntryReleasePolicy(f.context, {
        revision: 'fixture-off',
        defaultGeneration: '3.x',
        selections: [],
      });
      await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      await fixture.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.assignment}`;
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.thread.id}`;
      await fixture.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
      expect(
        (await createDEntryHistoryRouteHandlers(f.ports).history(f.request()))
          .status,
      ).toBe(200);
      const live = new Request(
        'https://allrice.test/api/v1/d-entry/admission',
        {
          method: 'POST',
          headers: f.request().headers,
          body: JSON.stringify(f.selection),
        },
      );
      expect((await liveAdmission(live)).status).toBe(403);
      expect(f.create).toHaveBeenCalledTimes(1);
    });

    it.each(['missing', 'claim-only'] as const)(
      'does not wake/create/repair/replay a %s root',
      async (state) => {
        const f = await setup(state);
        const calls = f.create.mock.calls.length;
        for (let i = 0; i < 2; i++)
          expect((await historyGET(f.request())).status).toBe(404);
        expect(
          await getDEntryHistoryRootPin(f.context, f.selection),
        ).toBeNull();
        expect(f.create).toHaveBeenCalledTimes(calls);
        expect(trace.calls).toEqual([]);
      },
    );

    it('requires current login/workspace authority and makes missing273 explicit on the actual GET routes', async () => {
      const f = await setup();
      for (const [get, download] of [
        [historyGET, false],
        [downloadGET, true],
      ] as const) {
        const response = await get(f.request(download));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: expect.stringContaining('MET-273'),
          },
        });
      }
      const other = await setup();
      trace.token = f.login.token;
      const forged = new Request(other.request().url, {
        headers: f.request().headers,
      });
      expect((await historyGET(forged)).status).toBe(403);
      trace.token = '';
      expect((await historyGET(f.request())).status).toBe(401);
      expect(f.create).toHaveBeenCalledTimes(1);
    });

    it('rechecks a revocation committed between root lookup and watch initialization and cleans partial setup', async () => {
      const f = await setup();
      trace.beforeWatch = async () => {
        await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      };
      expect(
        (await createDEntryHistoryRouteHandlers(f.ports).history(f.request()))
          .status,
      ).toBe(403);
      expect(trace.calls).toEqual([4]);
      expect(trace.subscriptions).toEqual([]);
      expect(f.bind).not.toHaveBeenCalled();
    });

    for (const loss of [
      'user',
      'login',
      'membership',
      'workspace',
      'revision',
    ] as const)
      it(`propagates real current ${loss} NOTIFY to a pending history read and joins before denial`, async () => {
        const f = await setup(),
          entered = gate(),
          drained = gate();
        const read = f.store.read.bind(f.store);
        vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => {
          const value = await read(...args);
          entered.release();
          await drained.promise;
          return value;
        });
        const cancel = new AbortController();
        let settled = false;
        const pending = createDEntryHistoryRouteHandlers(f.ports).history(
          f.request(false, cancel.signal),
        );
        void pending.then(() => {
          settled = true;
        });
        try {
          await entered.promise;
          const subscription = trace.subscriptions.at(-1)!;
          const revoked = once(subscription.revoked, 'abort');
          await {
            user: () =>
              fixture.db`update allrice_users set status='disabled' where id=${f.user}`,
            login: () => revokeSession(f.login.token),
            membership: () =>
              fixture.db`update allrice_memberships set active=false where id=${f.membership}`,
            workspace: () =>
              fixture.db`update allrice_workspaces set archived_at=clock_timestamp() where id=${f.workspace}`,
            revision: () =>
              fixture.db`update allrice_employee_instances set revision=revision+1 where id=${f.assignment}`,
          }[loss]();
          await revoked;
          await turn();
          expect(settled).toBe(false);
          expect(subscription.close).not.toHaveBeenCalled();
        } finally {
          cancel.abort(new DataAccessError('authorization_denied'));
          drained.release();
          await Promise.allSettled([pending]);
        }
        expect((await pending).status).toBe(403);
        expect(trace.subscriptions.at(-1)!.close).toHaveBeenCalledTimes(1);
        expect(f.create).toHaveBeenCalledTimes(1);
      });

    it('joins the actual history subscription on request cancellation during a pending projection read', async () => {
      const f = await setup(),
        entered = gate(),
        drained = gate();
      const read = f.store.read.bind(f.store);
      vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => {
        const value = await read(...args);
        entered.release();
        await drained.promise;
        return value;
      });
      const cancel = new AbortController();
      let settled = false;
      const pending = createDEntryHistoryRouteHandlers(f.ports).history(
        f.request(false, cancel.signal),
      );
      void pending.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        cancel.abort(new DataAccessError('authorization_denied'));
        await turn();
        expect(settled).toBe(false);
      } finally {
        cancel.abort(new DataAccessError('authorization_denied'));
        drained.release();
        await Promise.allSettled([pending]);
      }
      expect((await pending).status).toBe(403);
      expect(trace.subscriptions.at(-1)!.close).toHaveBeenCalledTimes(1);
    });

    it.each(['eof', 'cancel', 'membership-revoke'] as const)(
      'joins real history authority at attachment body %s without treating it as object ACL',
      async (mode) => {
        const f = await setup();
        const response = await createDEntryHistoryRouteHandlers(
          f.ports,
        ).download(f.request(true));
        expect(response.status).toBe(200);
        const subscription = trace.subscriptions.at(-1)!;
        expect(subscription.close).not.toHaveBeenCalled();
        if (mode === 'eof')
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes);
        else if (mode === 'cancel') await response.body!.cancel();
        else {
          const revoked = once(subscription.revoked, 'abort');
          await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
          await revoked;
          await expect(response.arrayBuffer()).rejects.toMatchObject({
            code: 'authorization_denied',
          });
        }
        expect(subscription.close).toHaveBeenCalledTimes(1);
        expect(f.owner.close).toHaveBeenCalledTimes(1);
        expect(f.create).toHaveBeenCalledTimes(1);
      },
    );

    it('pins one committed cut during the request and reopens only committed old cursors', async () => {
      const f = await setup(),
        entered = gate(),
        released = gate();
      if (!f.manifest) throw new Error('Fixture committed manifest missing');
      const create = f.createColdSource.getMockImplementation()!;
      f.createColdSource.mockImplementationOnce((...args) => {
        const cold = create(...args);
        const read = cold.store.read.bind(cold.store);
        vi.spyOn(cold.store, 'read').mockImplementationOnce(async (...args) => {
          const value = await read(...args);
          entered.release();
          await released.promise;
          return value;
        });
        return cold;
      });
      const handlers = createDEntryHistoryRouteHandlers(f.ports);
      const pending = handlers.history(f.request());
      const next = structuredClone(f.snapshot);
      next.source.throughSeq += 1;
      next.source.eventHashes.push(hostHistoryDigest('next event'));
      let nextDigest: string | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error(
              'History settled before the committed-read barrier',
            );
          }),
        ]);
        nextDigest = await f.store.publish(next, new AbortController().signal);
        const manifest = structuredClone(f.manifest);
        manifest.sessions[0]!.snapshotDigest = nextDigest;
        await f.sources.publish(manifest, new AbortController().signal);
      } finally {
        released.release();
        await Promise.allSettled([pending]);
      }
      const first = await pending;
      expect(first.status).toBe(200);
      const oldPage = await first.json();
      expect(oldPage.snapshotDigest).toBe(f.digest);
      expect(oldPage.nextCursor).not.toBeNull();
      const cursor = new URL(f.request().url);
      for (const [key, value] of Object.entries(oldPage.nextCursor))
        cursor.searchParams.set(key, String(value));
      const continued = await handlers.history(
        new Request(cursor, { headers: f.request().headers }),
      );
      expect(continued.status).toBe(200);
      expect((await continued.json()).snapshotDigest).toBe(f.digest);
      const fresh = await handlers.history(f.request());
      expect(fresh.status).toBe(200);
      expect((await fresh.json()).snapshotDigest).toBe(nextDigest);
      const downloaded = await handlers.download(f.request(true));
      expect(downloaded.status).toBe(200);
      await expect(downloaded.arrayBuffer()).resolves.toEqual(f.bytes.buffer);
      next.source.throughSeq += 1;
      next.source.eventHashes.push(hostHistoryDigest('uncommitted event'));
      const uncommitted = await f.store.publish(
        next,
        new AbortController().signal,
      );
      for (const download of [false, true]) {
        const url = new URL(f.request(download).url);
        url.searchParams.set('snapshotDigest', uncommitted);
        const response = await (
          download ? handlers.download : handlers.history
        )(new Request(url, { headers: f.request().headers }));
        expect(response.status).toBe(409);
      }
      expect(f.owner.close).toHaveBeenCalledTimes(1);
      expect(f.scopes.every((cold) => cold.close.mock.calls.length === 1)).toBe(
        true,
      );
      expect(
        trace.subscriptions.every(
          (watch) => watch.close.mock.calls.length === 1,
        ),
      ).toBe(true);
      expect(f.create).toHaveBeenCalledTimes(1);
    });

    it('authorizes a cold child only through the same committed parent catalog', async () => {
      const f = await setup();
      if (!f.manifest) throw new Error('Fixture committed manifest missing');
      const childId = `child-${randomUUID()}`;
      const childHeader = {
        id: childId,
        version: 4 as const,
        createdAt: 5,
        isSeeded: false,
      };
      const event = {
        type: 'subagent/catalog' as const,
        seq: 5,
        time: 5,
        data: {
          version: 0 as const,
          childId,
          childCreatedAt: 5,
          mode: 'one-shot' as const,
        },
      };
      const parent = structuredClone(f.snapshot);
      parent.source.throughSeq = 5;
      parent.source.eventHashes.push(hostHistoryDigest(event));
      const child = HostHistorySnapshotSchema.parse({
        ...f.snapshot,
        binding: {
          ...f.binding,
          nativeSessionId: childId,
          parentNativeSessionId: f.binding.nativeSessionId,
        },
        source: {
          ...f.snapshot.source,
          headerHash: hostHistoryDigest(childHeader),
          throughSeq: -1,
          eventHashes: [],
        },
        entries: [],
        attachments: [],
        lastTurn: { startSeq: null, endSeq: null, reason: null },
      });
      const manifest = structuredClone(f.manifest);
      manifest.sessions[0]!.snapshotDigest = await f.store.publish(
        parent,
        new AbortController().signal,
      );
      const childDigest = await f.store.publish(
        child,
        new AbortController().signal,
      );
      manifest.sessions.push({
        binding: child.binding,
        snapshotDigest: childDigest,
        header: childHeader,
      });
      manifest.edges.push({
        parentNativeSessionId: f.binding.nativeSessionId,
        childNativeSessionId: childId,
        parentEvent: event,
      });
      await f.sources.publish(manifest, new AbortController().signal);
      const url = new URL(f.request().url);
      url.searchParams.set('nativeSessionId', childId);
      const response = await createDEntryHistoryRouteHandlers(f.ports).history(
        new Request(url, { headers: f.request().headers }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).snapshotDigest).toBe(childDigest);
      url.searchParams.set('nativeSessionId', 'unrecorded-child');
      expect(
        (
          await createDEntryHistoryRouteHandlers(f.ports).history(
            new Request(url, { headers: f.request().headers }),
          )
        ).status,
      ).toBe(404);
      expect(f.scopes.every((cold) => cold.close.mock.calls.length === 1)).toBe(
        true,
      );
      expect(f.create).toHaveBeenCalledTimes(1);
    });

    it('keeps attachment access unavailable without a real object ACL owner', async () => {
      const f = await setup();
      const response = await createDEntryHistoryRouteHandlers({
        createColdSource: f.createColdSource,
      }).download(f.request(true));
      expect(response.status).toBe(503);
      expect(f.scopes).toHaveLength(1);
      expect(f.scopes[0]!.close).toHaveBeenCalledTimes(1);
      expect(trace.subscriptions.at(-1)!.close).toHaveBeenCalledTimes(1);
      expect(f.owner.open).not.toHaveBeenCalled();
      expect(f.owner.close).not.toHaveBeenCalled();
    });

    it('joins both real owners when an unconsumed download is aborted', async () => {
      const f = await setup(),
        closing = gate(),
        released = gate();
      const create = f.createColdSource.getMockImplementation()!;
      f.createColdSource.mockImplementationOnce((...args) => {
        const cold = create(...args);
        const close = cold.close.getMockImplementation()!;
        cold.close.mockImplementationOnce(async () => {
          closing.release();
          await released.promise;
          await close();
        });
        return cold;
      });
      const cancel = new AbortController();
      const reason = new DataAccessError('authorization_denied');
      let body:
        Promise<{ value: ArrayBuffer } | { error: unknown }> | undefined;
      let response: Response | undefined;
      let settled = false;
      try {
        response = await createDEntryHistoryRouteHandlers(f.ports).download(
          f.request(true, cancel.signal),
        );
        expect(response.status).toBe(200);
        expect(response.bodyUsed).toBe(false);
        cancel.abort(reason);
        body = response.arrayBuffer().then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        await Promise.race([
          closing.promise,
          body.then(() => {
            throw new Error(
              'Download settled before the authority close barrier',
            );
          }),
        ]);
        await turn();
        expect(settled).toBe(false);
      } finally {
        cancel.abort(reason);
        released.release();
        await Promise.allSettled([
          body,
          (async () => {
            if (response?.body && !response.bodyUsed && !response.body.locked)
              await response.body.cancel();
          })(),
        ]);
      }
      expect(await body).toMatchObject({
        error: { code: 'authorization_denied' },
      });
      expect(f.scopes[0]!.close).toHaveBeenCalledTimes(1);
      expect(trace.subscriptions.at(-1)!.close).toHaveBeenCalledTimes(1);
      expect(f.owner.close).toHaveBeenCalledTimes(1);
    });
  },
);
