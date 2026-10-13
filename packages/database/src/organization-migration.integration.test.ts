import { beforeAll, afterAll, it, expect, describe, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  login,
  changePassword,
} from './identity.ts';
import {
  migrateLegacyOrganizationAccounts,
  type LegacyAccountMigration,
} from './organization-migration.ts';
import { requireContentMaintenance } from './content-maintenance.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'unified portal account migration preserves existing company data',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (f) await f.close();
    });
    async function principal(name: string) {
      return ensureBootstrapPortalPrincipal(
        {
          organizationSlug: name,
          organizationName: name,
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: `${name}@example.test`,
          displayName: name,
          role: 'member',
        },
        f.db,
      );
    }
    const manifest = (name: string): LegacyAccountMigration[number] => ({
      email: `${name}@example.test`,
      username: name,
      organizationSlug: name,
      workspaceSlug: 'default',
      kind: 'employee',
    });
    it('previews without modifying accounts, initializes existing IDs once, preserves changed passwords and revoked membership', async () => {
      const snow = await principal('snow'),
        drink = await principal('drink'),
        admin = await principal('admin');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
      const values: LegacyAccountMigration = [
        manifest('snow'),
        manifest('drink'),
        {
          ...manifest('admin'),
          kind: 'platform_admin',
          initialPassword: 'existing-admin-password',
        },
      ];
      const prior = await createSession(snow.user.id);
      const before =
        await f.db`select id,username,password_hash from allrice_users order by id`;
      expect(
        (await migrateLegacyOrganizationAccounts(values)).accounts.every(
          (a) => a.action === 'initialize',
        ),
      ).toBe(true);
      expect(
        await f.db`select id,username,password_hash from allrice_users order by id`,
      ).toEqual(before);
      const dataBefore =
        await f.db`select id,organization_id,workspace_id,user_id,role,active from allrice_memberships order by id`;
      const result = await migrateLegacyOrganizationAccounts(values, true);
      expect(result.accounts.find((a) => a.username === 'snow')).toMatchObject({
        userId: snow.user.id,
        organizationId: snow.organizationId,
        workspaceId: snow.workspaceId,
      });
      expect(
        await f.db`select id,organization_id,workspace_id,user_id,role,active from allrice_memberships order by id`,
      ).toEqual(dataBefore);
      expect(await authenticateSession(prior.token)).toBeNull();
      const signed = await login({ username: 'SNOW', password: 'admin@321' }),
        context = (await authenticateSession(signed.session.token))!;
      expect(context.organizationId).toBe(snow.organizationId);
      expect(
        (await login({ username: 'drink', password: 'admin@321' })).user.id,
      ).toBe(drink.user.id);
      await expect(
        login({ username: 'admin', password: 'admin@321' }),
      ).rejects.toThrow();
      expect(
        (
          await login({
            username: 'admin',
            password: 'existing-admin-password',
          })
        ).user.id,
      ).toBe(admin.user.id);
      await changePassword(context, {
        currentPassword: 'admin@321',
        newPassword: 'changed-by-snow',
      });
      await f.db`update allrice_memberships set active=false where user_id=${drink.user.id}`;
      const after =
        await f.db`select id,username,password_hash from allrice_users order by id`;
      expect(
        (await migrateLegacyOrganizationAccounts(values, true)).accounts.every(
          (a) => a.action === 'preserve',
        ),
      ).toBe(true);
      expect(
        await f.db`select id,username,password_hash from allrice_users order by id`,
      ).toEqual(after);
      expect(
        (await login({ username: 'snow', password: 'changed-by-snow' })).user
          .id,
      ).toBe(snow.user.id);
      await expect(
        login({ username: 'drink', password: 'admin@321' }),
      ).rejects.toThrow();
      expect(await f.db`select id from allrice_users`).toHaveLength(3);
      expect(
        (
          await f.db`select count(*)::int as count from allrice_audit_events where action='organization.login_migrated'`
        )[0]?.count,
      ).toBe(3);
    });
    it('rolls the whole batch back on a collision and never assigns employee defaults to a platform admin', async () => {
      const a = await principal('alpha'),
        b = await principal('beta');
      const old =
        await f.db`select id,username,password_hash from allrice_users order by id`;
      await expect(
        migrateLegacyOrganizationAccounts(
          [manifest('alpha'), { ...manifest('beta'), username: 'snow' }],
          true,
        ),
      ).rejects.toThrow('migration_username_taken');
      expect(
        await f.db`select id,username,password_hash from allrice_users order by id`,
      ).toEqual(old);
      await expect(
        migrateLegacyOrganizationAccounts([manifest('admin')], true),
      ).rejects.toThrow('migration_principal_kind_mismatch');
      await f.db`update allrice_users set status='disabled' where id=${b.user.id}`;
      const result = await migrateLegacyOrganizationAccounts(
        [manifest('beta')],
        true,
      );
      expect(result.accounts[0]?.action).toBe('disabled');
      expect(
        (
          await f.db`select username,status from allrice_users where id=${b.user.id}`
        )[0],
      ).toMatchObject({ username: null, status: 'disabled' });
      expect(
        (
          await f.db`select username from allrice_users where id=${a.user.id}`
        )[0]?.username,
      ).toBeNull();
    });
    it('serializes legacy migration behind a content write without locking its user first', async () => {
      const p = await principal('concurrent');
      // Already-initialized login: this migration must preserve the session.
      await f.db`update allrice_users set username='concurrent' where id=${p.user.id}`;
      const signed = await createSession(p.user.id);
      const context = (await authenticateSession(signed.token))!;
      let migration:
        ReturnType<typeof migrateLegacyOrganizationAccounts> | undefined;
      try {
        await f.db.begin(async (tx) => {
          await tx`set local statement_timeout='3s'`;
          await tx`select id from allrice_organizations where id=${p.organizationId} for share`;
          const [connection] = await tx`select pg_backend_pid() as pid`;
          migration = migrateLegacyOrganizationAccounts(
            [manifest('concurrent')],
            true,
          );
          // Ensure the migration has actually reached the conflicting lock.
          // The write can then acquire its user lock, rather than deadlock.
          await vi.waitFor(
            async () => {
              const blocked =
                await f.db`select pid from pg_stat_activity where ${connection!.pid}::int=any(pg_blocking_pids(pid))`;
              expect(blocked.length).toBeGreaterThan(0);
            },
            { timeout: 3000, interval: 20 },
          );
          await expect(
            requireContentMaintenance(
              context,
              {
                scope: 'personal',
                organizationId: p.organizationId,
                ownerId: p.user.id,
              },
              tx,
            ),
          ).resolves.toMatchObject({ canMaintain: true });
        });
      } finally {
        if (migration) await migration;
      }
      expect(await authenticateSession(signed.token)).not.toBeNull();
      expect(
        (
          await f.db`select managed_employee_roster from allrice_organizations where id=${p.organizationId}`
        )[0]?.managed_employee_roster,
      ).toBe(true);
    });
  },
);
