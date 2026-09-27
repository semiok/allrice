import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  login,
} from './identity.ts';
import {
  createManagedOrganization,
  getManagedOrganization,
  listManagedOrganizations,
  updateManagedOrganization,
  importOrganizationPeople,
  listOrganizationPeople,
  updateOrganizationPerson,
  resetOrganizationPassword,
  setOrganizationAccountStatus,
} from './organization-administration.ts';
import type { RequestContext } from '@allrice/contracts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-161 company and employee account administration', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    admin: RequestContext;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const p = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Platform',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: 'fixture-admin@example.test',
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
    if (fixture) await fixture.close();
  });
  async function company() {
    return createManagedOrganization(admin, {
      name: `公司-${randomUUID()}`,
      businessContext: '文创行业',
    });
  }
  async function employee(organizationId: string) {
    const username = `employee-${randomUUID()}`;
    const result = await importOrganizationPeople(admin, organizationId, {
      people: [
        {
          username,
          displayName: '小雪',
          jobTitle: '财务',
          responsibilities: '对账',
        },
      ],
    });
    return { ...result.created[0]!, username };
  }
  it('creates a company with a default workspace and regular accounts without email or per-person domains', async () => {
    const c = await company(),
      e = await employee(c.organizationId);
    const view = await getManagedOrganization(admin, c.organizationId);
    expect(view.organization).toMatchObject({
      defaultWorkspaceId: c.defaultWorkspaceId,
      peopleCount: 1,
      businessContext: '文创行业',
    });
    expect(view.organization.workspaces).toHaveLength(1);
    const [p] = (await listOrganizationPeople(admin, c.organizationId)).people;
    expect(p).toMatchObject({
      email: null,
      displayName: '小雪',
      jobTitle: '财务',
      status: 'active',
    });
    const signed = await login({ username: e.username, password: 'admin@321' });
    const context = (await authenticateSession(signed.session.token))!;
    expect(context.organizationId).toBe(c.organizationId);
    expect(context.memberships).toEqual([
      expect.objectContaining({ role: 'member', workspaceId: null }),
    ]);
    expect(
      (await listManagedOrganizations(admin)).organizations.some(
        (o) => o.slug === 'allrice-platform',
      ),
    ).toBe(false);
    await updateManagedOrganization(admin, c.organizationId, {
      name: '新公司名称',
      businessContext: '新背景',
      expectedRevision: 1,
    });
    await expect(
      updateManagedOrganization(admin, c.organizationId, {
        name: '过期名称',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'organization_conflict' });
    expect(
      (await getManagedOrganization(admin, c.organizationId)).organization
        .revision,
    ).toBe(2);
  });
  it('imports atomically, rejects duplicate case-insensitive names, and never resets an existing password', async () => {
    const c = await company(),
      e = await employee(c.organizationId),
      another = `employee-${randomUUID()}`;
    await resetOrganizationPassword(admin, c.organizationId, e.userId, {
      password: 'private-password',
    });
    await expect(
      importOrganizationPeople(admin, c.organizationId, {
        people: [
          { username: another, displayName: '新增员工' },
          { username: e.username.toUpperCase(), displayName: '冲突员工' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'username_taken' });
    expect(
      await fixture.db`select id from allrice_users where username=${another}`,
    ).toHaveLength(0);
    expect(
      (await login({ username: e.username, password: 'private-password' })).user
        .id,
    ).toBe(e.userId);
    await expect(
      importOrganizationPeople(admin, c.organizationId, {
        people: [{ username: 'admin', displayName: '管理员' }],
      }),
    ).rejects.toMatchObject({ code: 'reserved_username' });
    await expect(
      importOrganizationPeople(admin, c.organizationId, {
        people: [{ username: another, displayName: '管理员', role: 'admin' }],
      }),
    ).rejects.toThrow();
  });
  it('stores names, jobs and responsibilities per company and detects stale profile edits without changing password or user ID', async () => {
    const a = await company(),
      b = await company(),
      e = await employee(a.organizationId);
    await fixture.db`insert into allrice_memberships(organization_id,user_id,role,active) values(${b.organizationId},${e.userId},'member',true)`;
    const p = (await listOrganizationPeople(admin, a.organizationId))
      .people[0]!;
    await updateOrganizationPerson(admin, a.organizationId, e.userId, {
      username: e.username,
      displayName: '李财务',
      jobTitle: '财务经理',
      responsibilities: '预算管理',
      expectedVersion: p.version,
    });
    const other = (await listOrganizationPeople(admin, b.organizationId))
      .people[0]!;
    expect(other).toMatchObject({
      displayName: '小雪',
      jobTitle: '',
      responsibilities: '',
    });
    await expect(
      updateOrganizationPerson(admin, a.organizationId, e.userId, {
        username: e.username,
        displayName: '旧编辑',
        expectedVersion: p.version,
      }),
    ).rejects.toMatchObject({ code: 'account_conflict' });
    expect(
      (
        await listOrganizationPeople(admin, a.organizationId, {
          search: '财务经理',
        })
      ).people[0]?.userId,
    ).toBe(e.userId);
    expect(
      (await login({ username: e.username, password: 'admin@321' })).user.id,
    ).toBe(e.userId);
  });
  it('resets and disables accounts without deleting history or reviving old sessions on re-enable', async () => {
    const c = await company(),
      e = await employee(c.organizationId);
    const old = await login({ username: e.username, password: 'admin@321' });
    await resetOrganizationPassword(admin, c.organizationId, e.userId, {
      password: 'changed-password',
    });
    expect(await authenticateSession(old.session.token)).toBeNull();
    await expect(
      login({ username: e.username, password: 'admin@321' }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    const active = await login({
      username: e.username,
      password: 'changed-password',
    });
    const before = (await listOrganizationPeople(admin, c.organizationId))
      .people[0]!;
    const disabled = await setOrganizationAccountStatus(
      admin,
      c.organizationId,
      e.userId,
      { active: false, expectedVersion: before.version },
    );
    expect(await authenticateSession(active.session.token)).toBeNull();
    await expect(
      login({ username: e.username, password: 'changed-password' }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    await setOrganizationAccountStatus(admin, c.organizationId, e.userId, {
      active: true,
      expectedVersion: disabled.person.version,
    });
    expect(await authenticateSession(active.session.token)).toBeNull();
    expect(
      (await login({ username: e.username, password: 'changed-password' })).user
        .id,
    ).toBe(e.userId);
    const events =
      await fixture.db`select metadata from allrice_audit_events where resource_id=${e.userId}`;
    expect(events.length).toBeGreaterThan(2);
    expect(JSON.stringify(events)).not.toMatch(
      /admin@321|changed-password|scrypt/,
    );
  });
  it('requires current platform authority for all management and protects the platform account', async () => {
    const c = await company(),
      e = await employee(c.organizationId);
    const user = (await authenticateSession(
      (await login({ username: e.username, password: 'admin@321' })).session
        .token,
    ))!;
    await expect(
      createManagedOrganization(user, { name: '越权公司' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      importOrganizationPeople(user, c.organizationId, {
        people: [{ username: 'new-user', displayName: '越权员工' }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      resetOrganizationPassword(user, c.organizationId, e.userId, {}),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await fixture.db`insert into allrice_memberships(organization_id,user_id,role,active) values(${c.organizationId},${admin.actor.id},'member',true)`;
    await expect(
      resetOrganizationPassword(admin, c.organizationId, admin.actor.id, {}),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const b = await company();
    await expect(
      resetOrganizationPassword(admin, b.organizationId, e.userId, {}),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
