/** Real isolated DB/session/271 readers; no Host, native job, B or model starts. */
import { randomUUID } from 'node:crypto';
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
import type { RequestContext } from '@allrice/contracts';
import * as client from '../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../packages/database/src/runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../../../packages/database/src/identity.ts';
import { ensureDefaultEmployee } from '../../../packages/database/src/workspace/service.ts';
import {
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
  updateEmployeeInstance,
} from '../../../packages/database/src/employees/employee-instances.ts';
import { resolveDEntryIdentity } from '../../../packages/database/src/d-entry.ts';
import {
  dEntryReleasePolicyKey,
  updateDEntryReleasePolicy,
} from '../../../packages/database/src/d-entry-release-policy.ts';
import { authorizeFixturePlatformAdministrator } from '../../../packages/database/src/platform-authority.fixture.ts';
import { createProductionPersonVmAuthority } from '../src/person-vm/production-authority.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const signal = () => new AbortController().signal;
suite(
  'production person VM authority with original current database owners',
  () => {
    let db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    const owners: ReturnType<typeof createProductionPersonVmAuthority>[] = [];
    const owner = () => {
      const value = createProductionPersonVmAuthority();
      owners.push(value);
      return value;
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
      await Promise.all(owners.splice(0).map((value) => value.close()));
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
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: `vm-authority-${key}`,
          organizationName: 'VM authority source test',
          workspaceSlug: 'work',
          workspaceName: 'Work',
          email: `${key}@example.test`,
          displayName: 'Current owner',
          role: 'member',
        },
        db.db,
      );
      const login = await createSession(p.user.id);
      const authenticated = await authenticateSession(login.token);
      if (!authenticated) throw Error('original real session required');
      const context: RequestContext = {
        ...authenticated,
        workspaceId: p.workspaceId,
      };
      const assigned = await ensureDefaultEmployee(context, p.workspaceId);
      if (!assigned) throw Error('original real assignment required');
      await ensureGeneralEmployeeInstance(db.db, assigned.id);
      const instance = await getEmployeeInstance(context, assigned.id);
      const identity = await resolveDEntryIdentity(
        context,
        { workspaceId: p.workspaceId, employeeInstanceId: instance.id },
        'history',
      );
      return { context, login, instance, identity };
    }
    async function enable(f: Awaited<ReturnType<typeof setup>>) {
      await authorizeFixturePlatformAdministrator(db.db, f.context.actor.id);
      await updateDEntryReleasePolicy(f.context, {
        revision: 'synthetic-request-not-authority',
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
    it('reads current self metadata while DB rollout remains off and starts nothing', async () => {
      const f = await setup(),
        vm = owner(),
        work = vi.fn();
      await expect(
        vm.authority.authorize(f.context, 'read', signal()),
      ).resolves.toEqual({
        personId: f.context.actor.id,
        organizationId: f.context.organizationId,
      });
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), work),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(work).not.toHaveBeenCalled();
    });
    it('uses an explicitly published exact selection for create/start without B or VM', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      await vm.withCurrentSelection(
        f.context,
        f.identity,
        signal(),
        async () => {
          for (const action of ['create', 'start'] as const)
            await expect(
              vm.authority.authorize(f.context, action, signal()),
            ).resolves.toEqual({
              personId: f.context.actor.id,
              organizationId: f.context.organizationId,
            });
        },
      );
      await expect(
        vm.authority.authorize(f.context, 'start', signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    });
    it('uses the verified selector for null-workspace current checks without overriding a conflicting scope or revoked membership', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      await db.db`update allrice_memberships set workspace_id=${f.identity.workspaceId} where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
      const unscoped = await authenticateSession(f.login.token);
      if (!unscoped) throw Error('original unscoped session required');
      expect(unscoped.workspaceId).toBeNull();
      expect(unscoped.memberships.length).toBeGreaterThan(0);
      expect(
        unscoped.memberships.every(
          (membership) => membership.workspaceId === f.identity.workspaceId,
        ),
      ).toBe(true);
      await expect(
        vm.withCurrentSelection(unscoped, f.identity, signal(), async () => {
          await vm.authority.authorize(unscoped, 'create', signal());
          await vm.authority.authorize(unscoped, 'start', signal());
          return 'current workspace-only member';
        }),
      ).resolves.toBe('current workspace-only member');
      expect(unscoped.workspaceId).toBeNull();
      const work = vi.fn();
      await expect(
        vm.withCurrentSelection(
          { ...unscoped, workspaceId: randomUUID() },
          f.identity,
          signal(),
          work,
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(work).not.toHaveBeenCalled();
      await db.db`update allrice_memberships set active=false where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
      await expect(
        vm.withCurrentSelection(unscoped, f.identity, signal(), work),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(work).not.toHaveBeenCalled();
    });
    it('does not reuse a revoked session from a still-valid RC snapshot', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      await vm.authority.authorize(f.context, 'read', signal());
      await revokeSession(f.login.token);
      await expect(
        vm.authority.authorize(f.context, 'read', signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), vi.fn()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('rejects membership removal independently of the old RC memberships', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      expect(f.context.memberships.length).toBeGreaterThan(0);
      await db.db`update allrice_memberships set active=false where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
      await expect(
        vm.authority.authorize(f.context, 'read', signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), vi.fn()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('preserves metadata reads for viewers but never upgrades them to execution', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      await db.db`update allrice_memberships set role='viewer' where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
      await expect(
        vm.authority.authorize(f.context, 'read', signal()),
      ).resolves.toMatchObject({ personId: f.context.actor.id });
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), vi.fn()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('rechecks published policy after work and discards a result on withdrawal', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      const work = vi.fn(async () => {
        await db.db`delete from allrice_settings where scope_type='system' and key=${dEntryReleasePolicyKey}`;
        return 'private native-operation result';
      });
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), work),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(work).toHaveBeenCalledOnce();
    });
    it('rechecks current membership for a later callback within the same operation', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), async () => {
          await vm.authority.authorize(f.context, 'create', signal());
          await db.db`update allrice_memberships set active=false where organization_id=${f.context.organizationId} and user_id=${f.context.actor.id}`;
          await vm.authority.authorize(f.context, 'start', signal());
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('does not carry the old revision across a real instance update', async () => {
      const f = await setup(),
        vm = owner();
      await enable(f);
      await expect(
        vm.withCurrentSelection(f.context, f.identity, signal(), async () => {
          await updateEmployeeInstance(f.context, f.instance.id, {
            profile: {
              expressionStyle:
                f.instance.profile.expressionStyle === 'concise'
                  ? 'structured'
                  : 'concise',
            },
          });
          return 'old revision result';
        }),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    });
    it('rejects cross-tenant metadata without trusting the supplied organization', async () => {
      const f = await setup(),
        other = await setup();
      await expect(
        owner().authority.authorize(
          { ...f.context, organizationId: other.context.organizationId },
          'read',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    });
  },
);
