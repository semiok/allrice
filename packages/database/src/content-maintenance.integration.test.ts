import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ContentMaintenanceLevel,
  ContentOwnership,
  RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
  listOrganizationPeople,
  updateOrganizationPerson,
  setOrganizationAccountStatus,
} from './organization-administration.ts';
import {
  createOrganizationDepartment,
  updateOrganizationDepartment,
} from './organization-departments.ts';
import {
  getContentAccess,
  readContentPrincipal,
  requireContentMaintenance,
} from './content-maintenance.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('current cumulative content maintenance authority', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    admin: RequestContext;
  beforeAll(async () => {
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    const p = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Platform',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: 'content-admin@example.test',
      displayName: 'Admin',
      role: 'member',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    admin = (await authenticateSession(
      (await createSession(p.user.id)).token,
    ))!;
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  }, 30000);
  async function setup(
    level: ContentMaintenanceLevel = 'personal',
    assigned = true,
  ) {
    const company = await createManagedOrganization(admin, {
      name: `Content-${randomUUID()}`,
    });
    const department = (
      await createOrganizationDepartment(admin, company.organizationId, {
        name: '财务',
        requestId: randomUUID(),
      })
    ).department;
    const other = (
      await createOrganizationDepartment(admin, company.organizationId, {
        name: '运营',
        requestId: randomUUID(),
      })
    ).department;
    const {
      created: [person],
    } = await importOrganizationPeople(admin, company.organizationId, {
      people: [
        {
          username: `content-${randomUUID()}`,
          displayName: '维护人',
          departmentId: assigned ? department.id : null,
          contentMaintenanceLevel: level,
        },
      ],
    });
    const context = (await authenticateSession(
      (await createSession(person!.userId)).token,
    ))!;
    return { company, department, other, person: person!, context };
  }
  async function update(a: Awaited<ReturnType<typeof setup>>, fields: object) {
    const person = (
      await listOrganizationPeople(admin, a.company.organizationId)
    ).people.find((p) => p.userId === a.person.userId)!;
    return updateOrganizationPerson(
      admin,
      a.company.organizationId,
      person.userId,
      {
        username: person.username,
        displayName: person.displayName,
        expectedVersion: person.version,
        ...fields,
      },
    );
  }
  const own = (a: Awaited<ReturnType<typeof setup>>): ContentOwnership => ({
    scope: 'personal',
    organizationId: a.company.organizationId,
    ownerId: a.person.userId,
  });
  const dept = (
    a: Awaited<ReturnType<typeof setup>>,
    id = a.department.id,
  ): ContentOwnership => ({
    scope: 'department',
    organizationId: a.company.organizationId,
    departmentId: id,
  });
  const company = (a: Awaited<ReturnType<typeof setup>>): ContentOwnership => ({
    scope: 'company',
    organizationId: a.company.organizationId,
  });

  it.each(['personal', 'department', 'company'] as const)(
    '%s accumulates lower content scopes without private/account/platform escalation',
    async (level) => {
      const a = await setup(level);
      expect((await getContentAccess(a.context, own(a))).canMaintain).toBe(
        true,
      );
      expect((await getContentAccess(a.context, dept(a))).canMaintain).toBe(
        level !== 'personal',
      );
      expect(
        (await getContentAccess(a.context, dept(a, a.other.id))).canMaintain,
      ).toBe(level === 'company');
      expect((await getContentAccess(a.context, company(a))).canMaintain).toBe(
        level === 'company',
      );
      expect((await getContentAccess(a.context, company(a))).canRead).toBe(
        true,
      );
      expect(
        await getContentAccess(a.context, {
          ...own(a),
          scope: 'personal',
          organizationId: a.company.organizationId,
          ownerId: randomUUID(),
        }),
      ).toMatchObject({
        canRead: false,
        canMaintain: false,
        readReason: 'private_owner_only',
      });
      expect(
        await getContentAccess(a.context, { scope: 'platform' }),
      ).toMatchObject({
        canRead: true,
        canMaintain: false,
        maintenanceReason: 'platform_read_only',
      });
      await expect(
        importOrganizationPeople(a.context, a.company.organizationId, {
          people: [{ username: 'illegal', displayName: '不得授权' }],
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const p = (await listOrganizationPeople(admin, a.company.organizationId))
        .people[0]!;
      await expect(
        updateOrganizationPerson(
          a.context,
          a.company.organizationId,
          p.userId,
          {
            username: p.username,
            displayName: p.displayName,
            contentMaintenanceLevel: 'company',
            expectedVersion: p.version,
          },
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    },
  );
  it('checks actual department identities; an unassigned person cannot substitute a workspace or another company', async () => {
    const a = await setup('department', false),
      b = await setup();
    expect((await getContentAccess(a.context, dept(a))).canRead).toBe(false);
    await update(a, { contentMaintenanceLevel: 'company' });
    expect((await getContentAccess(a.context, dept(a))).canMaintain).toBe(true);
    expect(
      await getContentAccess(a.context, dept(a, a.company.defaultWorkspaceId)),
    ).toMatchObject({ canRead: false, readReason: 'department_unavailable' });
    expect((await getContentAccess(a.context, dept(b))).readReason).toBe(
      'foreign_company',
    );
    expect(
      (await getContentAccess(a.context, dept(a, b.department.id))).readReason,
    ).toBe('department_unavailable');
    await updateOrganizationDepartment(
      admin,
      a.company.organizationId,
      a.department.id,
      { name: a.department.name, expectedRevision: 1, active: false },
    );
    expect((await getContentAccess(a.context, dept(a))).readReason).toBe(
      'department_unavailable',
    );
  });
  it('rechecks a stale request context after movement and downgrade; omission preserves the stored level', async () => {
    const a = await setup('company');
    const membershipBefore =
      await f.db`select * from allrice_memberships where user_id=${a.person.userId} order by id`;
    const moved = await update(a, { departmentId: a.other.id });
    expect(moved.person.contentMaintenanceLevel).toBe('company');
    expect(
      await f.db`select * from allrice_memberships where user_id=${a.person.userId} order by id`,
    ).toEqual(membershipBefore);
    await update(a, { contentMaintenanceLevel: 'department' });
    expect((await getContentAccess(a.context, dept(a))).canRead).toBe(false);
    expect(
      (await getContentAccess(a.context, dept(a, a.other.id))).canMaintain,
    ).toBe(true);
    expect((await getContentAccess(a.context, company(a))).canMaintain).toBe(
      false,
    );
    await update(a, { contentMaintenanceLevel: 'personal' });
    expect(
      (await getContentAccess(a.context, dept(a, a.other.id))).canMaintain,
    ).toBe(false);
    await expect(
      updateOrganizationPerson(
        admin,
        a.company.organizationId,
        a.person.userId,
        {
          username: moved.person.username,
          displayName: 'Stale',
          expectedVersion: moved.person.version,
          contentMaintenanceLevel: 'company',
        },
      ),
    ).rejects.toMatchObject({ code: 'account_conflict' });
  });
  it('retains legacy defaults and read-only memberships; copied authority claims never grant maintenance', async () => {
    const a = await setup('company');
    await f.db`delete from allrice_organization_people where organization_id=${a.company.organizationId} and user_id=${a.person.userId}`;
    expect((await readContentPrincipal(a.context))?.maintenanceLevel).toBe(
      'personal',
    );
    await update(a, { contentMaintenanceLevel: 'company' });
    await f.db`update allrice_memberships set role='viewer' where user_id=${a.person.userId}`;
    expect(await getContentAccess(a.context, own(a))).toMatchObject({
      canRead: true,
      canMaintain: false,
      maintenanceReason: 'read_only_membership',
    });
    await f.db`update allrice_memberships set active=false where user_id=${a.person.userId}`;
    expect((await getContentAccess(a.context, own(a))).readReason).toBe(
      'inactive_identity',
    );
    const forged = { ...a.context, memberships: admin.memberships };
    expect((await getContentAccess(forged, own(a))).canMaintain).toBe(false);
  });
  it('denies disabled users and revoked sessions across all scopes', async () => {
    const a = await setup('company');
    const p = (await listOrganizationPeople(admin, a.company.organizationId))
      .people[0]!;
    await setOrganizationAccountStatus(
      admin,
      a.company.organizationId,
      p.userId,
      { active: false, expectedVersion: p.version },
    );
    for (const target of [
      own(a),
      dept(a),
      company(a),
      { scope: 'platform' } as const,
    ]) {
      expect((await getContentAccess(a.context, target)).readReason).toBe(
        'inactive_identity',
      );
    }
    const b = await setup('company');
    await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${b.context.sessionId!}`;
    expect((await getContentAccess(b.context, company(b))).canRead).toBe(false);
  });
  it('a write waiting behind a profile change uses the committed lower level', async () => {
    const a = await setup('company');
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const downgrade = f.db.begin(async (tx) => {
      await tx`select id from allrice_users where id=${a.person.userId} for update`;
      await tx`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${a.company.organizationId} and user_id=${a.person.userId}`;
      entered();
      await proceed;
    });
    await held;
    // Preflight can still see the old committed authority. Submission must not.
    expect((await getContentAccess(a.context, company(a))).canMaintain).toBe(
      true,
    );
    const submission = f.db.begin((tx) =>
      requireContentMaintenance(a.context, company(a), tx),
    );
    const denied = expect(submission).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    release();
    await downgrade;
    await denied;
  });
});
