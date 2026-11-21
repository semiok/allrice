import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { EmployeeRuntimePackage, StoragePort } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { nativeBindingDescriptor } from '../../../../packages/database/src/native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import {
  createSession,
  authenticateSession,
  revokeSession,
} from '../../../../packages/database/src/identity.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  createChatSession,
  getSessionExecutionGeneration,
  sendChatMessage,
  updateChatSession,
  linkFileToSession,
  linkWorkspaceFileToSession,
} from '../../../../packages/database/src/workspace/service.ts';
import { initializeNativeOncePartition } from '../../../../packages/database/src/native-schedule-once-product.ts';
import { initializeNativeRecurringPartition } from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import { prepareAutomationConversation } from '../../../../packages/database/src/automation-conversation.ts';
import { readScheduleTarget } from '../../../../packages/database/src/native-schedule-authority.ts';
import {
  claimNextJob,
  startClaimedJob,
  prepareJobNativeSession,
  bindJobNativeSession,
} from '../../../../packages/database/src/execution/queue.ts';
import { acquireConversationRuntime } from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import { enqueueNativeSubagentControl } from '../../../../packages/database/src/conversation/native-subagent-control.ts';
import { updateQueuedMessage } from '../../../../packages/database/src/conversation/queued-messages.ts';
import { GET } from '../../app/api/v1/d-entry/identity/route';
import { POST } from '../../app/api/v1/d-entry/admission/route';
import { POST as createNativeRoot } from '../../app/api/v1/d-entry/native-root/route';
import { PATCH } from '../../app/api/v1/sessions/[id]/route';
import {
  POST as uploadAttachment,
  PUT as attachWorkspaceFile,
} from '../../app/api/v1/sessions/[id]/attachments/route';
import { POST as createOnceTask } from '../../app/api/v1/sessions/[id]/once-tasks/route';
import { POST as cancelOnceTask } from '../../app/api/v1/sessions/[id]/once-tasks/[taskId]/cancel/route';
import { POST as createRecurringTask } from '../../app/api/v1/sessions/[id]/schedule-tasks/route';
import { resolveDEntryAdmission } from '../d-entry/admission';
import { resolveDEntryIdentity } from '../d-entry/identity';
import {
  dEntryReleasePolicyKey,
  readDEntryReleasePolicy,
  updateDEntryReleasePolicy,
  getDEntryNativeRootPin,
  ensureDEntryNativeRoot,
  requireDEntryNativeIdentity,
  createDEntryAuthorityFeed,
  watchDEntryNativeAuthority,
} from '@allrice/database';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  WebSocket,
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../../../worker/src/d-entry/native-entry.fixture';
import { dEntryHttpDefaults } from '../../../worker/src/d-entry/http';

const cookie = vi.hoisted(() => ({
  token: '',
  storage: null as StoragePort | null,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
vi.mock('../storage/runtime', () => ({
  getStorageAdapter: () => cookie.storage!,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-271 real cookie/DB owner admission and immutable product writer',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', process.env.ALLRICE_TEST_DATABASE_URL!);
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      cookie.storage = runtimeFixtureStorage(fixture.db);
      for (const kind of ['once', 'recurring'] as const) {
        const reference = {
          artifactId: 'sha256:' + 'a'.repeat(64),
          profileId: `allrice-${kind}-control-v1`,
          storageId: 'synthetic-sql-only',
          stateRoot: fixture.storageRoot,
        };
        vi.stubEnv(`ALLRICE_NATIVE_${kind.toUpperCase()}_ENABLED`, '1');
        vi.stubEnv(
          `ALLRICE_NATIVE_${kind.toUpperCase()}_REFERENCE`,
          JSON.stringify(reference),
        );
        await (
          kind === 'once'
            ? initializeNativeOncePartition
            : initializeNativeRecurringPartition
        )(reference);
      }
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
    }, 120000);
    beforeEach(() => {
      cookie.token = '';
    });
    afterAll(async () => {
      cookie.token = '';
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    async function setup(executionGeneration?: '4.0') {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        executionGeneration,
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
      if (!context) throw Error('synthetic_cookie_login_failed');
      cookie.token = login.token;
      return {
        ...f,
        login,
        context,
        selection: {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          threadId: f.session,
        },
      };
    }
    type Fixture = Awaited<ReturnType<typeof setup>>;
    function request(
      f: Fixture,
      post = false,
      selection: Record<string, string> = f.selection,
    ) {
      return new Request(
        `https://allrice.test/api/v1/d-entry/${post ? 'admission' : 'identity'}${post ? '' : '?' + new URLSearchParams(selection)}`,
        {
          method: post ? 'POST' : 'GET',
          headers: {
            host: 'allrice.test',
            origin: 'https://allrice.test',
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
          ...(post ? { body: JSON.stringify(selection) } : {}),
        },
      );
    }
    function legacyRequest(
      f: Fixture,
      sessionId: string,
      path: string,
      method: string,
      body: unknown,
    ) {
      return new Request(
        `https://allrice.test/api/v1/sessions/${sessionId}${path}?workspaceId=${f.workspace}`,
        {
          method,
          headers: {
            host: 'allrice.test',
            origin: 'https://allrice.test',
            'content-type': 'application/json',
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
          body: JSON.stringify(body),
        },
      );
    }
    function rootRequest(
      f: Pick<Fixture, 'org' | 'workspace'>,
      selection: Awaited<ReturnType<typeof enabledFour>>['selection'],
    ) {
      return new Request('https://allrice.test/api/v1/d-entry/native-root', {
        method: 'POST',
        headers: {
          host: 'allrice.test',
          origin: 'https://allrice.test',
          'x-allrice-organization-id': f.org,
          'x-allrice-workspace-id': f.workspace,
        },
        body: JSON.stringify({ selection }),
      });
    }
    const route = (id: string) => ({ params: Promise.resolve({ id }) });
    async function four(
      f: Pick<Fixture, 'context' | 'workspace' | 'assignment'>,
    ) {
      return createChatSession(
        f.context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          title: 'Only the 4.0 writer may continue this thread',
        },
        { executionGeneration: '4.0' },
      );
    }
    async function enabledFour() {
      const f = await setup(),
        thread = await four(f);
      const selection = { ...f.selection, threadId: thread.id };
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const policy = await updateDEntryReleasePolicy(f.context, {
        revision: 'not-a-published-revision',
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
      const identity = await requireDEntryNativeIdentity(f.context, selection);
      return { ...f, thread, selection, identity, policy };
    }
    const clearPublished =
      () => fixture.db`delete from allrice_settings where scope_type='system'
      and scope_id is null and key=${dEntryReleasePolicyKey}`;
    function creation(
      f: Awaited<ReturnType<typeof enabledFour>>,
      nativeSessionId = 'dsh-host-created-root',
    ) {
      return {
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
          rosterDigest: 'sql-host-receipt-double',
        },
      };
    }

    async function probeRootFromOtherProcess(
      f: Awaited<ReturnType<typeof enabledFour>>,
      host: ReturnType<typeof creation>['host'],
    ) {
      const [scope] = await fixture.db`select current_schema() schema`;
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      url.searchParams.set('options', `-csearch_path=${scope!.schema}`);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
        const { ensureDEntryNativeRoot } = await import(process.env.MET271_ROOT_MODULE);
        const { closeDatabase } = await import(process.env.MET271_CLIENT_MODULE);
        const { context, selection, identity, host, operationId } = JSON.parse(process.env.MET271_ROOT_INPUT);
        let calls = 0;
        try {
          const pin = await ensureDEntryNativeRoot(context, selection, identity, {
            operationId, host, signal: new AbortController().signal,
            async create() { calls++; throw Error('unexpected native replay'); },
          });
          console.log(JSON.stringify({ calls, root: pin.rootNativeSessionId }));
        } catch (error) { console.log(JSON.stringify({ calls, error: error.message })); }
        finally { await closeDatabase(); }
      `,
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            MET271_ROOT_MODULE: new URL(
              '../../../../packages/database/src/d-entry-native-root.ts',
              import.meta.url,
            ).href,
            MET271_CLIENT_MODULE: new URL(
              '../../../../packages/database/src/core/client.ts',
              import.meta.url,
            ).href,
            MET271_ROOT_INPUT: JSON.stringify({
              context: f.context,
              selection: f.selection,
              identity: f.identity,
              host,
              operationId: randomUUID(),
            }),
          },
        },
      );
      return JSON.parse(stdout.trim()) as {
        calls: number;
        error?: string;
        root?: string;
      };
    }

    it('persists only host creation provenance, scopes duplicate ids, and keeps the root stable across ordinary lease restarts', async () => {
      const f = await enabledFour(),
        fact = creation(f),
        create = vi.fn(async () => fact),
        signal = new AbortController().signal;
      try {
        const pin = await ensureDEntryNativeRoot(
          f.context,
          f.selection,
          f.identity,
          { operationId: randomUUID(), host: fact.host, signal, create },
        );
        const read = await getDEntryNativeRootPin(f.context, f.selection);
        expect(read).toEqual(pin);
        const restartedHost = {
          ...fact.host,
          binding: {
            ...fact.host.binding,
            instanceId: randomUUID(),
            leaseEpoch: 2,
          },
          bindingRef: randomUUID(),
        };
        const afterRestart = vi.fn(async () => ({
          ...fact,
          host: restartedHost,
        }));
        expect(
          await ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: restartedHost,
            signal,
            create: afterRestart,
          }),
        ).toEqual(pin);
        expect(afterRestart).not.toHaveBeenCalled();
        const [row] =
          await fixture.db`select native_root_origin,d_entry_native_root from allrice_chat_sessions where id=${f.thread.id}`;
        expect(row!.native_root_origin).toBeNull();
        expect(row!.d_entry_native_root).toMatchObject({
          identity: f.identity,
          host: fact.host,
          releaseRevision: f.policy.revision,
        });
        await expect(
          fixture.db`update allrice_chat_sessions set d_entry_native_root=null where id=${f.thread.id}`,
        ).rejects.toThrow('D entry native root is immutable');
        const second = await four(f),
          secondSelection = { ...f.selection, threadId: second.id };
        const secondIdentity = await requireDEntryNativeIdentity(
          f.context,
          secondSelection,
        );
        await expect(
          ensureDEntryNativeRoot(f.context, secondSelection, secondIdentity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: async () => fact,
          }),
        ).rejects.toMatchObject({ code: '23505' });
        const neverReplay = vi.fn(async () => fact);
        await expect(
          ensureDEntryNativeRoot(f.context, secondSelection, secondIdentity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: neverReplay,
          }),
        ).rejects.toThrow('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
        expect(neverReplay).not.toHaveBeenCalled();
        // Same native id in a different persistent VM namespace is legal; it
        // never changes the original thread's root or temporary owner lease.
        const third = await four(f),
          thirdSelection = { ...f.selection, threadId: third.id },
          thirdIdentity = await requireDEntryNativeIdentity(
            f.context,
            thirdSelection,
          );
        const otherVm = {
          ...fact,
          host: {
            ...fact.host,
            binding: { ...fact.host.binding, vmId: randomUUID() },
          },
        };
        await ensureDEntryNativeRoot(f.context, thirdSelection, thirdIdentity, {
          operationId: randomUUID(),
          host: otherVm.host,
          signal,
          create: async () => otherVm,
        });
        const [legacy] =
          await fixture.db`select count(*)::int n from allrice_native_session_bindings where context_id in (${f.thread.id},${second.id})`;
        const [runs] =
          await fixture.db`select count(*)::int n from allrice_employee_runs where session_id in (${f.thread.id},${second.id})`;
        expect(legacy!.n).toBe(0);
        expect(runs!.n).toBe(0);
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        await clearPublished();
      }
    });

    // Fault injection is ONLY at the caller's transaction-ACK boundary. The
    // transactions/claims/pins below are real PG facts, not an in-memory store.
    for (const lostAt of ['claim-ack', 'native-reply', 'pin-ack'] as const)
      it(`retains durable at-most-once facts after ${lostAt}, without creating again on a second connection/request`, async () => {
        const f = await enabledFour(),
          fact = creation(f),
          operationId = randomUUID(),
          signal = new AbortController().signal,
          unknown = Error(`injected ${lostAt} lost`);
        let commits = 0;
        const lostCommit =
          lostAt === 'claim-ack' ? 1 : lostAt === 'pin-ack' ? 2 : 0;
        const actual = fixture.db;
        const withLostAck = new Proxy(actual, {
          get(target, key, receiver) {
            if (key !== 'begin') return Reflect.get(target, key, receiver);
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.begin, target, args);
              if (++commits === lostCommit) throw unknown;
              return result;
            };
          },
        });
        const create = vi.fn(async () => {
          if (lostAt === 'native-reply') throw unknown;
          return fact;
        });
        try {
          vi.mocked(client.getDatabase).mockReturnValue(withLostAck);
          await expect(
            ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
              operationId,
              host: fact.host,
              signal,
              create,
            }),
          ).rejects.toBe(unknown);
          vi.mocked(client.getDatabase).mockReturnValue(actual);
          const [row] =
            await actual`select d_entry_native_root_claim,d_entry_native_root
            from allrice_chat_sessions where id=${f.thread.id}`;
          expect(row!.d_entry_native_root_claim).toMatchObject({
            operationId,
            identity: f.identity,
            host: fact.host,
          });
          expect(create).toHaveBeenCalledTimes(lostAt === 'claim-ack' ? 0 : 1);
          const again = vi.fn(async () => fact);
          for (const nextOperation of [operationId, randomUUID()]) {
            const next = ensureDEntryNativeRoot(
              f.context,
              f.selection,
              f.identity,
              {
                operationId: nextOperation,
                host: fact.host,
                signal,
                create: again,
              },
            );
            if (lostAt === 'pin-ack') {
              expect(row!.d_entry_native_root).not.toBeNull();
              expect(await next).toEqual(
                await getDEntryNativeRootPin(f.context, f.selection),
              );
            } else {
              expect(row!.d_entry_native_root).toBeNull();
              await expect(next).rejects.toThrow(
                'D_ENTRY_ROOT_CREATION_UNCONFIRMED',
              );
              await expect(
                getDEntryNativeRootPin(f.context, f.selection),
              ).rejects.toThrow('NATIVE_QUERY_BINDING_UNAVAILABLE');
            }
          }
          expect(again).not.toHaveBeenCalled();
          const otherProcess = await probeRootFromOtherProcess(f, fact.host);
          expect(otherProcess.calls).toBe(0);
          expect(otherProcess).toMatchObject(
            lostAt === 'pin-ack'
              ? { root: fact.nativeSessionId }
              : { error: 'D_ENTRY_ROOT_CREATION_UNCONFIRMED' },
          );
          await expect(actual`update allrice_chat_sessions set d_entry_native_root_claim=
            jsonb_set(d_entry_native_root_claim,'{operationId}',${actual.json(randomUUID())}) where id=${f.thread.id}`).rejects.toThrow(
            'D entry native creation claim is immutable',
          );
        } finally {
          vi.mocked(client.getDatabase).mockReturnValue(actual);
          await clearPublished();
        }
      });

    it('serializes real root creators without duplicate dispatch and rechecks a committed member downgrade before the final pin', async () => {
      const f = await enabledFour(),
        fact = creation(f),
        signal = new AbortController().signal;
      const entered = deferred<void>(),
        release = deferred<void>();
      let pending: Promise<unknown> | undefined;
      try {
        pending = ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
          operationId: randomUUID(),
          host: fact.host,
          signal,
          create: async () => {
            entered.resolve();
            await release.promise;
            return fact;
          },
        });
        void pending.catch(() => {});
        await entered.promise;
        const competing = vi.fn(async () => fact);
        await expect(
          ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: competing,
          }),
        ).rejects.toThrow('D_ENTRY_ROOT_CREATION_BUSY');
        expect(competing).not.toHaveBeenCalled();
        await fixture.db`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
        release.resolve();
        await expect(pending).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        const [row] =
          await fixture.db`select d_entry_native_root,native_root_origin from allrice_chat_sessions where id=${f.thread.id}`;
        expect(row).toMatchObject({
          d_entry_native_root: null,
          native_root_origin: null,
        });
        // The create really ran, but current authority denied the final write.
        // Its immutable dispatch fact survives the released connection gate.
        await fixture.db`update allrice_memberships set role='member' where user_id=${f.user} and organization_id=${f.org}`;
        const replay = vi.fn(async () => fact);
        await expect(
          ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: replay,
          }),
        ).rejects.toThrow('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
        expect(replay).not.toHaveBeenCalled();
        await fixture.db`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
        expect(
          await resolveDEntryIdentity(f.context, f.selection, 'history'),
        ).toMatchObject({ threadId: f.thread.id });
      } finally {
        release.resolve();
        await pending?.catch(() => {});
        await clearPublished();
      }
    });

    it('uses the real PG commit notification, discards rolled-back revocation, and closes the subscribe-before-recheck gap', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      let watcher:
        Awaited<ReturnType<typeof watchDEntryNativeAuthority>> | undefined;
      try {
        watcher = await watchDEntryNativeAuthority(
          f.context,
          f.selection,
          f.identity,
          new AbortController().signal,
          feed,
        );
        await expect(
          fixture.db.begin(async (tx) => {
            await tx`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
            expect(watcher!.revoked.aborted).toBe(false);
            throw Error('rollback-revocation');
          }),
        ).rejects.toThrow('rollback-revocation');
        expect(watcher.revoked.aborted).toBe(false);
        const revoked = new Promise<void>((resolve) =>
          watcher!.revoked.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        await fixture.db.begin(async (tx) => {
          await tx`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
          expect(watcher!.revoked.aborted).toBe(false); // No pre-commit invalidation.
        });
        await revoked;
        expect(watcher.revoked.reason).toMatchObject({
          code: 'authorization_denied',
        });
        await watcher.close();
        watcher = undefined;
        await fixture.db`update allrice_memberships set role='member' where user_id=${f.user} and organization_id=${f.org}`;
        const duringSubscribe = {
          ...feed,
          async subscribe(...args: Parameters<typeof feed.subscribe>) {
            const detach = await feed.subscribe(...args);
            await fixture.db`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
            return detach;
          },
        };
        await expect(
          watchDEntryNativeAuthority(
            f.context,
            f.selection,
            f.identity,
            new AbortController().signal,
            duringSubscribe,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        await watcher?.close();
        await feed.close();
        await clearPublished();
      }
    });

    it('rechecks release/employee changes and expires at the real login deadline; notification disconnect aborts idle consumers', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      let watcher:
        Awaited<ReturnType<typeof watchDEntryNativeAuthority>> | undefined;
      const open = () =>
        watchDEntryNativeAuthority(
          f.context,
          f.selection,
          f.identity,
          new AbortController().signal,
          feed,
        );
      const abortOf = (watch: NonNullable<typeof watcher>) =>
        new Promise<void>((resolve) => {
          if (watch.revoked.aborted) resolve();
          else
            watch.revoked.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
      try {
        watcher = await open();
        const releaseRevoked = abortOf(watcher);
        await updateDEntryReleasePolicy(f.context, {
          ...f.policy,
          selections: [],
        });
        await releaseRevoked;
        await watcher.close();
        await updateDEntryReleasePolicy(f.context, f.policy);
        watcher = await open();
        const employeeRevoked = abortOf(watcher);
        await fixture.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.assignment}`;
        await employeeRevoked;
        await watcher.close();
        await fixture.db`update allrice_employee_instances set archived_at=null where id=${f.assignment}`;
        // A real expires_at update (not a fabricated authenticatedAt/TTL) must
        // move the deadline of an already open subscription.
        watcher = await open();
        const expired = abortOf(watcher);
        await fixture.db`update allrice_sessions set expires_at=clock_timestamp()+interval '1 second' where id=${f.login.id}`;
        await expired;
        expect(watcher.revoked.reason).toMatchObject({
          code: 'authentication_required',
        });
        await watcher.close();
        const login = await createSession(f.user),
          context = (await authenticateSession(login.token, {
            organizationId: f.org,
            workspaceId: f.workspace,
          }))!;
        watcher = await watchDEntryNativeAuthority(
          context,
          f.selection,
          f.identity,
          new AbortController().signal,
          feed,
        );
        await feed.close();
        expect(watcher.revoked.aborted).toBe(true);
        expect(
          await resolveDEntryIdentity(context, f.selection, 'history'),
        ).toMatchObject({ threadId: f.thread.id });
      } finally {
        await watcher?.close();
        await feed.close();
        await clearPublished();
      }
    });

    it('drives the real original-Bearer HTTP root producer and current PG revocation with only native/admission ports doubled', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      const native = nativeEntryFixture({
        context: f.context,
        identity: f.identity,
      });
      native.rootCreate.mockResolvedValue({
        ok: true,
        value: { sessionId: native.catalog.items[0]!.sessionId },
      });
      const pinCommitted = deferred<void>(),
        letReply = deferred<void>();
      let rootReplies = 0;
      const server = await nativeEntryServer(native, {
        ...dEntryHttpDefaults,
        owners: native.deps.owners,
        data: native.deps.data,
        async ensureRoot(...args) {
          const pin = await ensureDEntryNativeRoot(...args);
          if (++rootReplies === 1) {
            pinCommitted.resolve();
            await letReply.promise;
          }
          return pin;
        },
        watch: (context, selection, identity, signal) =>
          watchDEntryNativeAuthority(
            context,
            selection,
            identity,
            signal,
            feed,
          ),
      });
      const headers = { authorization: `Bearer ${f.login.token}` };
      const previousWorkerUrl = process.env.ALLRICE_WORKER_INTERNAL_URL;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', server.origin);
      try {
        const loseReply = new AbortController();
        const lostResponse = fetch(
          `${server.origin}/internal/d-entry/native-root`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(server.body),
            signal: loseReply.signal,
          },
        );
        void lostResponse.catch(() => {});
        await pinCommitted.promise;
        // Durable SQL success and a browser receiving its ACK are distinct.
        loseReply.abort();
        letReply.resolve();
        await expect(lostResponse).rejects.toThrow();
        // Real Web cookie/BFF -> original Bearer -> real Worker auth/SQL.
        const created = await createNativeRoot(rootRequest(f, f.selection));
        expect(created.status).toBe(200);
        expect(await created.json()).toMatchObject({
          rootNativeSessionId: 'dsh-root',
        });
        expect(
          (await getDEntryNativeRootPin(f.context, f.selection)).vmId,
        ).toBe(native.binding.vmId);
        expect(native.rootCreate).toHaveBeenCalledTimes(1);
        expect(
          (await server.request('native-root', server.body, headers)).status,
        ).toBe(200);
        expect(native.rootCreate).toHaveBeenCalledTimes(1); // Existing pin never redispatches create.
        const response = await server.request(
          'native-resource',
          { ...server.body, nativeSessionId: 'dsh-grandchild' },
          headers,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          rootNativeSessionId: 'dsh-root',
          parentNativeSessionId: 'dsh-child',
        });
        const peer = new WebSocket(
          server.origin.replace('http:', 'ws:') +
            '/internal/d-entry/native-mux?' +
            new URLSearchParams({ organizationId: f.org, ...f.selection }),
          { headers },
        );
        peer.on('error', () => {});
        try {
          await once(peer, 'open');
          const closed = once(peer, 'close');
          await revokeSession(f.login.token); // Real cross-connection PG commit, no fake AbortController.
          await closed;
          await native.muxClosed.promise;
          expect(peer.readyState).toBe(WebSocket.CLOSED);
        } finally {
          peer.terminate();
        }
        expect(
          (await server.request('native-owner', server.body, headers)).status,
        ).toBe(401);
      } finally {
        letReply.resolve();
        await server.close();
        await feed.close();
        await clearPublished();
        if (previousWorkerUrl === undefined)
          delete process.env.ALLRICE_WORKER_INTERNAL_URL;
        else process.env.ALLRICE_WORKER_INTERNAL_URL = previousWorkerUrl;
      }
    });

    it('keeps published 4.0 policy from bypassing missing production owners on direct HTTP/internal/WS entry', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      const native = nativeEntryFixture({
        context: f.context,
        identity: f.identity,
      });
      const server = await nativeEntryServer(native, {
        ...dEntryHttpDefaults,
        watch: (context, selection, identity, signal) =>
          watchDEntryNativeAuthority(
            context,
            selection,
            identity,
            signal,
            feed,
          ),
      });
      const headers = { authorization: `Bearer ${f.login.token}` };
      const previousWorkerUrl = process.env.ALLRICE_WORKER_INTERNAL_URL;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', server.origin);
      let peer: WebSocket | undefined;
      try {
        expect(
          (await createNativeRoot(rootRequest(f, f.selection))).status,
        ).toBe(503);
        expect((await readDEntryReleasePolicy()).selections).toContainEqual(
          expect.objectContaining({ personId: f.user, generation: '4.0' }),
        );
        for (const [path, body] of [
          ['native-owner', server.body],
          ['native-root', server.body],
          [
            'native-resource',
            { ...server.body, nativeSessionId: 'guest-root' },
          ],
          [
            'native-rpc',
            {
              ...server.body,
              endpoint: 'session/cancel',
              payload: { args: { request: { sessionId: 'guest-root' } } },
            },
          ],
        ] as const)
          expect((await server.request(path, body, headers)).status).toBe(503);
        peer = new WebSocket(
          server.origin.replace('http:', 'ws:') +
            '/internal/d-entry/native-mux?' +
            new URLSearchParams({ organizationId: f.org, ...f.selection }),
          { headers },
        );
        peer.on('error', () => {});
        const [upgrade, rejected] = await once(peer, 'unexpected-response');
        expect(rejected.statusCode).toBe(503);
        rejected.resume();
        upgrade.destroy();
        const [row] =
          await fixture.db`select d_entry_native_root_claim,d_entry_native_root from allrice_chat_sessions where id=${f.thread.id}`;
        expect(row).toMatchObject({
          d_entry_native_root_claim: null,
          d_entry_native_root: null,
        });
        expect(native.rootCreate).not.toHaveBeenCalled();
        expect(native.data.acquireRpc).not.toHaveBeenCalled();
        expect(native.data.acquireMux).not.toHaveBeenCalled();
      } finally {
        peer?.terminate();
        await server.close();
        await feed.close();
        await clearPublished();
        if (previousWorkerUrl === undefined)
          delete process.env.ALLRICE_WORKER_INTERNAL_URL;
        else process.env.ALLRICE_WORKER_INTERNAL_URL = previousWorkerUrl;
      }
    });

    it('uses the administrator email acquired under the publication locks, with zero setting/audit after a concurrent email revocation', async () => {
      const f = await setup();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const held = deferred<number>(),
        release = deferred<void>();
      let publish: Promise<unknown> | undefined;
      const revoke = fixture.db.begin(async (tx) => {
        await tx`select id from allrice_users where id=${f.user} for update`;
        const [backend] = await tx`select pg_backend_pid() pid`;
        held.resolve(backend!.pid);
        await release.promise;
        await tx`update allrice_users set email=${`revoked-${randomUUID()}@example.invalid`} where id=${f.user}`;
      });
      try {
        const blocker = await held.promise;
        publish = updateDEntryReleasePolicy(f.context, {
          revision: 'not-authority',
          defaultGeneration: '3.x',
          selections: [],
        });
        void publish.catch(() => {});
        await expect
          .poll(async () => {
            const [wait] =
              await fixture.db`select exists(select 1 from pg_stat_activity a
            where ${blocker}::integer=any(pg_blocking_pids(a.pid))
              and a.query like '%for share of s,u%') blocked`;
            return wait!.blocked;
          })
          .toBe(true);
        release.resolve();
        await revoke;
        await expect(publish).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        const [settings] =
          await fixture.db`select count(*)::int n from allrice_settings where key=${dEntryReleasePolicyKey}`;
        const [audit] =
          await fixture.db`select count(*)::int n from allrice_audit_events
          where actor_id=${f.user} and action='d_entry_release.update'`;
        expect(settings!.n).toBe(0);
        expect(audit!.n).toBe(0);
      } finally {
        release.resolve();
        await Promise.allSettled([revoke, publish]);
      }
    });
    it('maps the real login cookie to current person/employee/root without starting a VM', async () => {
      const f = await setup();
      const req = request(f);
      req.headers.set('x-allrice-person-id', randomUUID());
      const response = await GET(req);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        identity: {
          organizationId: f.org,
          personId: f.user,
          employeeInstanceId: f.assignment,
          threadId: f.session,
        },
      });
      expect(response.headers.get('cache-control')).toContain('no-store');
      const admission = await POST(request(f, true));
      expect(admission.status).toBe(200);
      expect(await admission.json()).toMatchObject({
        executionGeneration: '3.x',
        policyRevision: 'unpublished',
      });
    });
    it('uses shared platform publication, defaults off, and never manufactures a 4.0 root pin or fallback', async () => {
      const f = await setup();
      const thread = await four(f);
      const selection = { ...f.selection, threadId: thread.id };
      const policy = {
        revision: 'caller-revision-is-not-authority',
        defaultGeneration: '3.x' as const,
        selections: [
          {
            organizationId: f.org,
            personId: f.user,
            employeeInstanceId: f.assignment,
            generation: '4.0' as const,
          },
        ],
      };
      expect(await readDEntryReleasePolicy()).toEqual({
        revision: 'unpublished',
        defaultGeneration: '3.x',
        selections: [],
      });
      expect((await POST(request(f, true, selection))).status).toBe(403);
      await expect(
        updateDEntryReleasePolicy(f.context, policy),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await expect(
          updateDEntryReleasePolicy(f.context, {
            ...policy,
            defaultGeneration: '4.0',
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        const published = await updateDEntryReleasePolicy(f.context, policy);
        expect(published.revision).not.toBe(policy.revision);
        expect(await readDEntryReleasePolicy()).toEqual(published);
        const [setting] =
          await fixture.db`select value from allrice_settings where scope_type='system'
          and scope_id is null and key=${dEntryReleasePolicyKey}`;
        expect(setting?.value).toEqual(published);
        // An existing 3.x writer stays 3.x. An opted-in 4.0 writer has no fake
        // native transport; exact routing is still a real owner dependency.
        expect(await (await POST(request(f, true))).json()).toMatchObject({
          executionGeneration: '3.x',
        });
        const unavailable = await POST(request(f, true, selection));
        expect(unavailable.status).toBe(503);
        expect((await unavailable.json()).error.code).toBe(
          'DEPENDENCY_UNAVAILABLE',
        );
        await expect(
          getDEntryNativeRootPin(f.context, selection),
        ).rejects.toThrow('NATIVE_QUERY_BINDING_UNAVAILABLE');
        const [unchanged] =
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${thread.id}`;
        expect(unchanged?.native_root_origin).toBeNull();
        const [count] =
          await fixture.db`select count(*)::int n from allrice_native_session_bindings where context_kind='chat' and context_id=${thread.id}`;
        expect(count?.n).toBe(0);
        await updateDEntryReleasePolicy(f.context, {
          ...policy,
          selections: [],
        });
        expect((await POST(request(f, true, selection))).status).toBe(403);
        expect((await GET(request(f, false, selection))).status).toBe(200);
        await revokeSession(f.login.token);
        await expect(
          updateDEntryReleasePolicy(f.context, policy),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        await fixture.db`delete from allrice_settings where scope_type='system' and scope_id is null and key=${dEntryReleasePolicyKey}`;
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });
    it('rejects a foreign tenant/person and rechecks cookie and membership revocation', async () => {
      const f = await setup(),
        other = await setup();
      cookie.token = f.login.token;
      const foreignTenant = request(f);
      foreignTenant.headers.set('x-allrice-organization-id', other.org);
      expect((await GET(foreignTenant)).status).toBe(403);
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${other.user},'member')`;
      cookie.token = other.login.token;
      expect([403, 404]).toContain((await GET(request(f))).status);
      cookie.token = f.login.token;
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      expect((await GET(request(f))).status).toBe(403);
      await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
      await revokeSession(f.login.token);
      expect((await GET(request(f))).status).toBe(401);
    });
    it('keeps owner history after assignment withdrawal/archival and refuses continuation', async () => {
      const f = await setup();
      await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      expect((await GET(request(f))).status).toBe(200);
      expect((await POST(request(f, true))).status).toBe(403);
    });
    it('rechecks current writable authority for an already logged-in member downgraded to viewer, including new threads', async () => {
      const f = await setup(),
        thread = await four(f);
      const existing = { ...f.selection, threadId: thread.id };
      const newThread = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const policy = {
        revision: 'synthetic-approved-policy',
        defaultGeneration: '3.x' as const,
        selections: [
          {
            organizationId: f.org,
            personId: f.user,
            employeeInstanceId: f.assignment,
            generation: '4.0' as const,
          },
        ],
      };
      for (const selection of [existing, newThread])
        expect(
          (await resolveDEntryAdmission(f.context, selection, policy))
            .executionGeneration,
        ).toBe('4.0');
      await fixture.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
      expect(
        f.context.memberships.find((m) => m.id === f.membership)?.role,
      ).toBe('member');
      const fresh = await authenticateSession(f.login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      expect(fresh?.memberships.find((m) => m.id === f.membership)?.role).toBe(
        'viewer',
      );
      const [assignment] =
        await fixture.db`select active from allrice_employee_assignments where id=${f.assignment}`;
      expect(assignment!.active).toBe(true);
      for (const selection of [existing, newThread]) {
        await expect(
          resolveDEntryAdmission(f.context, selection, policy),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect((await POST(request(f, true, selection))).status).toBe(403);
      }
      expect((await GET(request(f, false, existing))).status).toBe(200);
      await expect(
        resolveDEntryIdentity(f.context, existing, 'history'),
      ).resolves.toMatchObject({ threadId: thread.id });
    });
    it('rejects 4.0 legacy PATCH before metadata and message visibility writes, preserving 3.x updates and history', async () => {
      const f = await setup(),
        thread = await four(f),
        messageId = randomUUID();
      await fixture.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${messageId},${f.org},${f.workspace},${thread.id},${f.user},'user','{"text":"synthetic history","citations":[]}')`;
      const snapshot =
        () => fixture.db`select s.title,s.visibility,s.archived_at,s.pinned_at,s.updated_at,m.visibility message_visibility
        from allrice_chat_sessions s join allrice_messages m on m.session_id=s.id where s.id=${thread.id}`;
      const before = await snapshot();
      for (const patch of [
        { title: 'No legacy rename' },
        { visibility: 'workspace' },
        { archived: true, stopActivity: true },
        { pinned: true },
      ]) {
        expect(
          (
            await PATCH(
              legacyRequest(f, thread.id, '', 'PATCH', patch),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        await expect(
          updateChatSession(f.context, f.workspace, thread.id, patch),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      }
      expect(await snapshot()).toEqual(before);
      expect(
        (await GET(request(f, false, { ...f.selection, threadId: thread.id })))
          .status,
      ).toBe(200);
      const legacy = await createChatSession(f.context, {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      });
      await fixture.db`insert into allrice_messages(organization_id,workspace_id,session_id,owner_id,role,content)
        values(${f.org},${f.workspace},${legacy.id},${f.user},'user','{"text":"legacy history","citations":[]}')`;
      const changed = await PATCH(
        legacyRequest(f, legacy.id, '', 'PATCH', {
          title: 'Legacy rename',
          visibility: 'workspace',
          pinned: true,
        }),
        route(legacy.id),
      );
      expect(changed.status).toBe(200);
      expect((await changed.json()).session).toMatchObject({
        title: 'Legacy rename',
        visibility: 'workspace',
      });
      const [message] =
        await fixture.db`select visibility from allrice_messages where session_id=${legacy.id}`;
      expect(message!.visibility).toBe('workspace');
      expect(
        (
          await PATCH(
            legacyRequest(f, legacy.id, '', 'PATCH', { archived: true }),
            route(legacy.id),
          )
        ).status,
      ).toBe(200);
    });
    it('rejects 4.0 legacy uploads before bytes or metadata, and guards both final file link services while preserving 3.x', async () => {
      const f = await setup(),
        thread = await four(f);
      const content = {
        fileName: 'synthetic.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('isolated fixture bytes').toString('base64'),
      };
      const put = vi.spyOn(cookie.storage!, 'put');
      try {
        const uploaded = await uploadAttachment(
          legacyRequest(f, f.session, '/attachments', 'POST', content),
          route(f.session),
        );
        expect(uploaded.status).toBe(201);
        const objectId = (await uploaded.json()).attachment.id as string;
        expect(put).toHaveBeenCalledTimes(1);
        const legacy = await createChatSession(f.context, {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
        });
        expect(
          (
            await attachWorkspaceFile(
              legacyRequest(f, legacy.id, '/attachments', 'PUT', { objectId }),
              route(legacy.id),
            )
          ).status,
        ).toBe(200);
        put.mockClear();
        const counts = () => fixture.db`select
          (select count(*)::int from allrice_storage_objects where organization_id=${f.org}) objects,
          (select count(*)::int from allrice_file_references where organization_id=${f.org}) links`;
        const before = await counts();
        expect(
          (
            await uploadAttachment(
              legacyRequest(f, thread.id, '/attachments', 'POST', content),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await attachWorkspaceFile(
              legacyRequest(f, thread.id, '/attachments', 'PUT', { objectId }),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        await expect(
          linkFileToSession({
            context: f.context,
            workspaceId: f.workspace,
            sessionId: thread.id,
            objectId,
            fileName: content.fileName,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          linkWorkspaceFileToSession({
            context: f.context,
            workspaceId: f.workspace,
            sessionId: thread.id,
            objectId,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(put).not.toHaveBeenCalled();
        expect(await counts()).toEqual(before);
        const [linked] =
          await fixture.db`select count(*)::int count from allrice_file_references where session_id=${thread.id}`;
        expect(linked!.count).toBe(0);
      } finally {
        put.mockRestore();
      }
    });
    it('rejects 4.0 once/recurring new_each_run at real routes and before creating a fresh 3.x target', async () => {
      const f = await setup(),
        thread = await four(f);
      const task = {
        name: 'Synthetic only',
        prompt: 'No native execution',
        conversationMode: 'new_each_run' as const,
      };
      const once = {
        ...task,
        clientRequestId: randomUUID(),
        runAt: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'UTC',
      };
      const recurring = {
        ...task,
        clientRequestId: randomUUID(),
        rule: { kind: 'every', seconds: 3600 },
      };
      const counts = () => fixture.db`select
        (select count(*)::int from allrice_automations where organization_id=${f.org}) clocks,
        (select count(*)::int from allrice_native_once_controls where immutable_control->>'organizationId'=${f.org}) once_controls,
        (select count(*)::int from allrice_native_recurring_controls where immutable_identity->>'organizationId'=${f.org}) recurring_controls,
        (select count(*)::int from allrice_chat_sessions where organization_id=${f.org} and execution_generation='3.x') legacy_threads,
        (select count(*)::int from allrice_automation_runs where organization_id=${f.org}) automation_runs,
        (select count(*)::int from allrice_jobs where organization_id=${f.org}) jobs`;
      const before = await counts();
      expect(
        (
          await createOnceTask(
            legacyRequest(f, thread.id, '/once-tasks', 'POST', once),
            route(thread.id),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await createRecurringTask(
            legacyRequest(f, thread.id, '/schedule-tasks', 'POST', recurring),
            route(thread.id),
          )
        ).status,
      ).toBe(403);
      const scope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
      };
      await expect(
        fixture.db.begin(async (tx) =>
          prepareAutomationConversation(
            tx,
            f.context,
            scope,
            {
              id: randomUUID(),
              name: task.name,
              revision: 1,
              session_id: thread.id,
              employee_assignment_id: f.assignment,
              conversation_mode: 'new_each_run',
            },
            await readScheduleTarget(tx, scope, thread.id),
            { kind: 'manual', requestId: randomUUID() },
          ),
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await counts()).toEqual(before);
      const legacyOnce = await createOnceTask(
        legacyRequest(f, f.session, '/once-tasks', 'POST', once),
        route(f.session),
      );
      expect(legacyOnce.status).toBe(201);
      const taskId = (await legacyOnce.json()).task.id as string;
      expect(
        (
          await createRecurringTask(
            legacyRequest(f, f.session, '/schedule-tasks', 'POST', recurring),
            route(f.session),
          )
        ).status,
      ).toBe(201);
      const [after] = await counts();
      expect(after).toMatchObject({
        clocks: 2,
        once_controls: 1,
        recurring_controls: 1,
        legacy_threads: 1,
        automation_runs: 0,
        jobs: before[0]!.jobs,
      });
      const [controlBefore] =
        await fixture.db`select snapshot,snapshot_version from allrice_native_once_controls where automation_id=${taskId}`;
      expect(
        (
          await cancelOnceTask(
            legacyRequest(
              f,
              thread.id,
              `/once-tasks/${taskId}/cancel`,
              'POST',
              {},
            ),
            { params: Promise.resolve({ id: thread.id, taskId }) },
          )
        ).status,
      ).toBe(403);
      const [controlAfter] =
        await fixture.db`select snapshot,snapshot_version from allrice_native_once_controls where automation_id=${taskId}`;
      expect(controlAfter).toEqual(controlBefore);
    });
    it('pins old and new threads permanently and never creates a 3.x native origin for 4.0', async () => {
      const f = await setup(),
        thread = await four(f);
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, f.session),
      ).toBe('3.x');
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, thread.id),
      ).toBe('4.0');
      const [row] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${thread.id}`;
      expect(row!.native_root_origin).toBeNull();
      await expect(
        fixture.db`update allrice_chat_sessions set execution_generation='3.x' where id=${thread.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        createChatSession(
          f.context,
          { workspaceId: f.workspace, employeeInstanceId: f.assignment },
          { sessionId: thread.id },
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('serializes competing 3.x/4.0 creations at the same actual thread identity', async () => {
      const f = await setup(),
        id = randomUUID();
      const input = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const results = await Promise.allSettled([
        createChatSession(f.context, input, {
          sessionId: id,
          executionGeneration: '3.x',
        }),
        createChatSession(f.context, input, {
          sessionId: id,
          executionGeneration: '4.0',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'authorization_denied',
      });
      const [row] =
        await fixture.db`select count(*)::int count from allrice_chat_sessions where id=${id}`;
      expect(row!.count).toBe(1);
    });
    it('rejects legacy send, queue edit, child prompt and native acquire on a 4.0 thread before writes', async () => {
      const f = await setup(),
        thread = await four(f);
      await expect(
        sendChatMessage(f.context, f.workspace, thread.id, {
          clientMessageId: randomUUID(),
          text: '请在这条4.0线程继续处理，不能交给3.x执行。',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        updateQueuedMessage(f.context, f.workspace, thread.id, randomUUID(), {
          action: 'edit',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        enqueueNativeSubagentControl(f.context, thread.id, {
          rootRunId: f.rootRunId,
          generation: 0,
          input: {
            requestId: randomUUID(),
            kind: 'prompt',
            mode: 'continuable',
            parentSessionId: 'native-root',
            childSessionId: 'native-child',
            delivery: 'queue',
            content: [{ type: 'text', text: '网页不直接向子会话发言' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        acquireConversationRuntime({
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: thread.id,
          runId: f.rootRunId,
          workerId: f.worker.workerId,
          configChecksum: 'sha256:' + 'a'.repeat(64),
          compactThresholdTokens: 10000,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_messages where session_id=${thread.id}) messages,
      (select count(*)::int from allrice_conversation_runtimes where session_id=${thread.id}) runtimes,
      (select count(*)::int from allrice_conversation_commands where session_id=${thread.id}) commands`;
      expect(counts).toMatchObject({ messages: 0, runtimes: 0, commands: 0 });
    });
    it('filters 4.0 from the real legacy claim and rechecks forged claimed/bind attempts', async () => {
      // Freeze the inconsistent legacy queue at first INSERT; existing Run
      // snapshots and Session writer pins remain immutable in this test too.
      const f = await setup('4.0');
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, f.session),
      ).toBe('4.0');
      const evidence = () => fixture.db`select
        (select to_jsonb(er) from allrice_employee_runs er where run_id=${f.rootRunId}) employee_run,
        (select to_jsonb(r) from allrice_conversation_runtimes r where session_id=${f.session}) runtime,
        (select count(*)::int from allrice_messages where session_id=${f.session}) messages,
        (select count(*)::int from allrice_native_session_bindings where context_kind='chat' and context_id=${f.session}) bindings,
        (select count(*)::int from allrice_run_events where run_id=${f.rootRunId}) events`;
      const before = await evidence();
      const job = () =>
        fixture.db`select status,worker_id,lease_token,lease_expires_at,attempt from allrice_jobs where id=${f.worker.jobId}`;
      await fixture.db`update allrice_jobs set status='queued',available_at=clock_timestamp()-interval '1 second',attempt=1 where id=${f.worker.jobId}`;
      const queued = await job();
      expect(await claimNextJob(randomUUID(), 60000)).toBeNull();
      expect(await job()).toEqual(queued);
      await fixture.db`update allrice_jobs set status='claimed',lease_expires_at=clock_timestamp()+interval '5 minutes' where id=${f.worker.jobId}`;
      const claimed = await job();
      await expect(
        startClaimedJob(f.worker.workerId, f.worker.jobId, f.worker.leaseToken),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await job()).toEqual(claimed);
      await fixture.db`update allrice_jobs set status='running' where id=${f.worker.jobId}`;
      const running = await job();
      const lease = {
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat' as const,
          id: f.session,
          configChecksum: 'sha256:' + 'a'.repeat(64),
          generation: 0,
          expectedThreadId: null,
        },
      };
      await expect(
        prepareJobNativeSession({
          ...lease,
          nativeSessionId: 'dsh-' + f.session,
          storageContextKey: f.session,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        bindJobNativeSession({
          ...lease,
          descriptor: nativeBindingDescriptor({
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            contextKey: f.session,
          }),
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await job()).toEqual(running);
      expect(await evidence()).toEqual(before);
    });
  },
);
