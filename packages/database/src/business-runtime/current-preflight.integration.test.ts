/** Real isolated PG/authentication/source composition. No native process or B. */
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
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
import type {
  EmployeeBusinessTargetProjection,
  RequestContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import * as builds from '../service-build-identity.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../identity.ts';
import {
  createChatSession,
  ensureDefaultEmployee,
} from '../workspace/service.ts';
import {
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
  updateEmployeeInstance,
} from '../employees/employee-instances.ts';
import { getEffectiveEmployeeContent } from '../employees/employee-content.ts';
import {
  updateDEntryReleasePolicy,
  dEntryReleasePolicyKey,
} from '../d-entry-release-policy.ts';
import { authorizeFixturePlatformAdministrator } from '../platform-authority.fixture.ts';
import { createBusinessRuntimeCaller } from './caller-transaction.ts';
import { EmployeeBusinessCurrentUnavailable } from './current-preflight.ts';
import { createWorkerCurrentBusinessRuntime } from '../../../../apps/worker/src/business-runtime/current-producer.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

suite(
  'real current business preflight through the production caller factory',
  () => {
    let db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    const pending: Promise<unknown>[] = [];
    const releases: (() => void)[] = [];
    const caller = createBusinessRuntimeCaller();
    const track = <T>(promise: Promise<T>) => {
      pending.push(promise);
      void promise.catch(() => {});
      return promise;
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      db = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
    }, 120000);
    beforeEach(async () => {
      vi.spyOn(client, 'getDatabase').mockReturnValue(db.db);
      await db.db`delete from allrice_settings where scope_type='system' and key=${dEntryReleasePolicyKey}`;
    });
    afterEach(async () => {
      for (const release of releases.splice(0)) release();
      await Promise.allSettled(pending.splice(0));
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      try {
        if (db)
          expect(await db.close()).toMatchObject({
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30000);

    async function setup() {
      const key = randomUUID();
      const principal = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: `current-${key}`,
          organizationName: 'Current reader fixture',
          workspaceSlug: 'work',
          workspaceName: 'Work',
          email: `${key}@example.test`,
          displayName: 'Current owner',
          role: 'member',
        },
        db.db,
      );
      const login = await createSession(principal.user.id);
      const authenticated = await authenticateSession(login.token);
      if (!authenticated) throw Error('real fixture login required');
      const context: RequestContext = {
        ...authenticated,
        workspaceId: principal.workspaceId,
      };
      const assigned = await ensureDefaultEmployee(
        context,
        principal.workspaceId,
      );
      if (!assigned) throw Error('original assigned employee required');
      await ensureGeneralEmployeeInstance(db.db, assigned.id);
      const instance = await getEmployeeInstance(context, assigned.id);
      const target: EmployeeBusinessTargetProjection = {
        workspaceId: principal.workspaceId,
        employeeInstanceId: instance.id,
        threadId: null,
        access: 'management',
        module: { kind: 'builtin', moduleId: 'employee-memory' },
      };
      return { context, login, assigned, instance, target };
    }
    async function thread(
      f: Awaited<ReturnType<typeof setup>>,
      generation: '3.x' | '4.0',
    ) {
      return createChatSession(
        f.context,
        {
          workspaceId: f.target.workspaceId,
          employeeInstanceId: f.instance.id,
          title: 'Current reader fixture only',
        },
        { executionGeneration: generation },
      );
    }
    async function enable(f: Awaited<ReturnType<typeof setup>>) {
      await authorizeFixturePlatformAdministrator(db.db, f.context.actor.id);
      await updateDEntryReleasePolicy(f.context, {
        revision: 'fixture-request-not-authority',
        defaultGeneration: '3.x',
        selections: [
          {
            organizationId: f.context.organizationId,
            personId: f.context.actor.id,
            employeeInstanceId: f.instance.id,
            generation: '4.0',
          },
        ],
      });
    }
    function holdBuild() {
      const entered = gate<void>();
      const source =
        gate<Awaited<ReturnType<typeof builds.readServiceBuildIdentity>>>();
      releases.push(() => source.resolve(null));
      vi.spyOn(builds, 'readServiceBuildIdentity').mockImplementationOnce(
        async () => {
          entered.resolve();
          return source.promise;
        },
      );
      return { entered, source };
    }

    it.each([
      'deliverables',
      'enterprise-materials',
      'employee-memory',
      'capabilities',
    ] as const)(
      'reads real assignment/current configuration for builtin %s without B, modulebinding or execute rollout',
      async (moduleId) => {
        const f = await setup();
        const target = {
          ...f.target,
          module: { kind: 'builtin' as const, moduleId },
        };
        const expected = await getEffectiveEmployeeContent(
          f.context,
          f.instance.id,
        );
        const result = await caller.readEmployeeBusinessCurrentPreflight(
          f.context,
          target,
        );
        expect(result.projection.scope.employeeId).toBe(f.assigned.employeeId);
        expect(result.projection.scope.employeeInstanceId).toBe(f.instance.id);
        expect(result.currentConfiguration).toEqual(expected);
        expect(JSON.parse(result.projection.identityRevisionRef)).toEqual({
          instanceRevision: f.instance.revision,
          employeeVersionId: f.instance.source.employeeVersionId,
        });
        expect(result.projection.module).toMatchObject({
          kind: 'builtin',
          moduleId,
          applicationModules: { policy: 'all-enabled' },
        });
        expect(result.projection).not.toHaveProperty('b');
        expect(result.projection.module).not.toHaveProperty('binding');
        expect(result.projection.module).not.toHaveProperty('configDigest');
        const [counts] = await db.db`select
        (select count(*)::int from allrice_employee_module_bindings where instance_id=${f.instance.id}) bindings,
        (select count(*)::int from allrice_employee_runs where employee_assignment_id=${f.instance.assignmentId}) runs,
        (select count(*)::int from allrice_chat_sessions where employee_assignment_id=${f.instance.assignmentId}) threads`;
        expect(counts).toEqual({ bindings: 0, runs: 0, threads: 0 });
        await expect(
          caller.readEmployeeBusinessCurrentPreflight(f.context, {
            ...target,
            threadId: randomUUID(),
            access: 'execute',
          }),
        ).rejects.toBeDefined();
      },
    );

    it('preserves owner cold history after archive/assignment withdrawal and does not load management config', async () => {
      const f = await setup(),
        session = await thread(f, '3.x');
      await db.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${session.id}`;
      await db.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.instance.id}`;
      await db.db`update allrice_employee_assignments set active=false where id=${f.instance.assignmentId}`;
      const result = await caller.readEmployeeBusinessCurrentPreflight(
        f.context,
        {
          ...f.target,
          access: 'history',
          threadId: session.id,
        },
      );
      expect(result.projection).toMatchObject({
        access: 'history',
        executionGeneration: null,
        scope: { employeeId: f.assigned.employeeId },
      });
      expect(result.currentConfiguration).toBeNull();
      await expect(
        caller.readEmployeeBusinessCurrentPreflight(f.context, f.target),
      ).rejects.toBeDefined();
      await expect(
        caller.readEmployeeBusinessCurrentPreflight(f.context, {
          ...f.target,
          access: 'execute',
          threadId: session.id,
        }),
      ).rejects.toBeDefined();
    });

    it('the actual Worker consumer retains default-off and the immutable thread generation gate', async () => {
      const f = await setup(),
        four = await thread(f, '4.0'),
        legacy = await thread(f, '3.x');
      const runtime = createWorkerCurrentBusinessRuntime();
      const select = {
        workspaceId: f.target.workspaceId,
        employeeInstanceId: f.instance.id,
      };
      await expect(
        runtime.identity(f.context, { ...select, threadId: four.id }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await enable(f);
      expect(
        await runtime.identity(f.context, { ...select, threadId: four.id }),
      ).toMatchObject({ threadId: four.id });
      expect((await runtime.identity(f.context, select)).threadId).toBeNull();
      await expect(
        runtime.identity(f.context, { ...select, threadId: legacy.id }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const [unchanged] =
        await db.db`select execution_generation,d_entry_native_root,native_root_origin
      from allrice_chat_sessions where id=${four.id}`;
      expect(unchanged).toEqual({
        execution_generation: '4.0',
        d_entry_native_root: null,
        native_root_origin: null,
      });
      const [sessions] =
        await db.db`select count(*)::int n from allrice_chat_sessions
      where employee_assignment_id=${f.instance.assignmentId}`;
      expect(sessions?.n).toBe(2);
    });

    it('rejects cross-tenant/owner targets and a stale membership snapshot', async () => {
      const f = await setup(),
        other = await setup();
      await expect(
        caller.readEmployeeBusinessCurrentPreflight(f.context, other.target),
      ).rejects.toBeDefined();
      await db.db`update allrice_memberships set active=false where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
      await expect(
        caller.readEmployeeBusinessCurrentPreflight(f.context, f.target),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });

    it('rechecks real membership after pending static policy without trusting a previously authenticated context', async () => {
      const f = await setup(),
        held = holdBuild();
      const outcome = track(
        caller.readEmployeeBusinessCurrentPreflight(f.context, f.target),
      );
      try {
        await held.entered.promise;
        await db.db`update allrice_memberships set active=false where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
        held.source.resolve(null);
        await expect(outcome).rejects.toMatchObject({
          code: 'authorization_denied',
        });
      } finally {
        held.source.resolve(null);
        await Promise.allSettled([outcome]);
      }
    });

    it('rechecks real login revocation after pending policy', async () => {
      const f = await setup(),
        held = holdBuild();
      const outcome = track(
        caller.readEmployeeBusinessCurrentPreflight(f.context, f.target),
      );
      try {
        await held.entered.promise;
        await revokeSession(f.login.token);
        held.source.resolve(null);
        await expect(outcome).rejects.toMatchObject({
          code: 'authorization_denied',
        });

        it('does not retain a writer transaction or current-authority row locks across the static policy await', async () => {
          const f = await setup(),
            held = holdBuild();
          const outcome = track(
            caller.readEmployeeBusinessCurrentPreflight(f.context, f.target),
          );
          try {
            await held.entered.promise;
            // Immediate lock acquisition on a different real transaction proves the
            // preflight is not a retained writer fence. No delay/lock timeout probe.
            await db.db.begin(async (tx) => {
              await tx`select id from allrice_organizations where id=${f.context.organizationId} for update nowait`;
              await tx`select id from allrice_workspaces where id=${f.target.workspaceId} for update nowait`;
              await tx`select id from allrice_users where id=${f.context.actor.id} for update nowait`;
              await tx`select id from allrice_sessions where id=${f.context.sessionId} for update nowait`;
              await tx`select id from allrice_memberships where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id} for update nowait`;
              await tx`select id from allrice_employee_assignments where id=${f.instance.assignmentId} for update nowait`;
              await tx`select id from allrice_employee_instances where id=${f.instance.id} for update nowait`;
            });
          } finally {
            held.source.resolve(null);
            await Promise.allSettled([outcome]);
          }
          expect((await outcome).projection.access).toBe('management');
        });
      } finally {
        held.source.resolve(null);
        await Promise.allSettled([outcome]);
      }
    });

    it('rejects a real instance revision change across the policy read', async () => {
      const f = await setup(),
        held = holdBuild();
      const outcome = track(
        caller.readEmployeeBusinessCurrentPreflight(f.context, f.target),
      );
      try {
        await held.entered.promise;
        await updateEmployeeInstance(f.context, f.instance.id, {
          workspaceId: f.target.workspaceId,
          expectedRevision: f.instance.revision,
          requestId: randomUUID(),
          profile: {
            ...f.instance.profile,
            expressionStyle: 'Changed during preflight',
          },
        });
        held.source.resolve(null);
        await expect(outcome).rejects.toMatchObject({
          code: 'authorization_denied',
        });
      } finally {
        held.source.resolve(null);
        await Promise.allSettled([outcome]);
      }
    });

    it('joins the actual pending policy Promise before rejecting cancellation and permits a later valid request', async () => {
      const f = await setup(),
        held = holdBuild(),
        stop = new AbortController();
      const reason = Error('original request ended');
      let settled = false;
      const outcome = track(
        caller
          .readEmployeeBusinessCurrentPreflight(
            f.context,
            f.target,
            stop.signal,
          )
          .then(
            () => ({ error: null }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          }),
      );
      try {
        await held.entered.promise;
        stop.abort(reason);
        await turn();
        expect(settled).toBe(false);
      } finally {
        held.source.resolve(null);
        await outcome;
      }
      expect(await outcome).toEqual({ error: reason });
      expect(
        (await caller.readEmployeeBusinessCurrentPreflight(f.context, f.target))
          .projection.access,
      ).toBe('management');
    });

    it('refuses a nonbuiltin required action with no original binding/config source instead of manufacturing a config digest', async () => {
      const f = await setup();
      await expect(
        caller.readEmployeeBusinessCurrentPreflight(f.context, {
          ...f.target,
          module: {
            kind: 'required',
            release: {
              moduleId: 'brand-media',
              contractVersion: 1,
              contentVersion: '1.0.0',
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
        }),
      ).rejects.toBeInstanceOf(EmployeeBusinessCurrentUnavailable);
      expect(
        (await caller.readEmployeeBusinessCurrentPreflight(f.context, f.target))
          .currentConfiguration,
      ).not.toBeNull();
    });
  },
);
