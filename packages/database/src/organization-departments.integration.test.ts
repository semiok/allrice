import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
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
  importOrganizationPeople,
  listOrganizationPeople,
  updateOrganizationPerson,
} from './organization-administration.ts';
import {
  createOrganizationDepartment,
  listOrganizationDepartments,
  updateOrganizationDepartment,
} from './organization-departments.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET178 company departments and stable person assignment', () => {
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
      email: 'department-admin@example.test',
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
  }, 30000);
  async function company() {
    return createManagedOrganization(admin, {
      name: `部门测试-${randomUUID()}`,
    });
  }
  async function department(organizationId: string, name = '财务部') {
    return (
      await createOrganizationDepartment(admin, organizationId, {
        name,
        requestId: randomUUID(),
      })
    ).department;
  }
  async function employee(organizationId: string, departmentId?: string) {
    const username = `department-${randomUUID()}`;
    return (
      await importOrganizationPeople(admin, organizationId, {
        people: [
          {
            username,
            displayName: '部门员工',
            ...(departmentId ? { departmentId } : {}),
          },
        ],
      })
    ).created[0]!;
  }
  async function move(
    organizationId: string,
    userId: string,
    departmentId: string | null,
  ) {
    const p = (await listOrganizationPeople(admin, organizationId)).people.find(
      (v) => v.userId === userId,
    )!;
    return updateOrganizationPerson(admin, organizationId, userId, {
      username: p.username,
      displayName: p.displayName,
      jobTitle: p.jobTitle,
      responsibilities: p.responsibilities,
      departmentId,
      expectedVersion: p.version,
    });
  }
  it('keeps departments separate from workspaces and legacy people unassigned', async () => {
    const c = await company(),
      e = await employee(c.organizationId);
    const workspaces =
      await fixture.db`select id from allrice_workspaces where organization_id=${c.organizationId}`;
    const d = await department(c.organizationId);
    expect(d).toMatchObject({
      organizationId: c.organizationId,
      name: '财务部',
      active: true,
      revision: 1,
      peopleCount: 0,
    });
    expect(d.id).not.toBe(c.defaultWorkspaceId);
    expect(
      (await listOrganizationPeople(admin, c.organizationId)).people[0],
    ).toMatchObject({
      userId: e.userId,
      departmentId: null,
      departmentName: null,
    });
    expect(
      await fixture.db`select id from allrice_workspaces where organization_id=${c.organizationId}`,
    ).toEqual(workspaces);
  });
  it('replays the original creation once, rejects changed payload and active duplicate names', async () => {
    const c = await company(),
      requestId = randomUUID(),
      input = { name: ' 财务部 ', requestId };
    const pair = await Promise.all([
      createOrganizationDepartment(admin, c.organizationId, input),
      createOrganizationDepartment(admin, c.organizationId, input),
    ]);
    expect(pair[0].department.id).toBe(pair[1].department.id);
    expect(
      (await listOrganizationDepartments(admin, c.organizationId)).departments,
    ).toHaveLength(1);
    expect(
      await fixture.db`select id from allrice_audit_events where resource_id=${pair[0].department.id} and action='organization.department.created'`,
    ).toHaveLength(1);
    await expect(
      createOrganizationDepartment(admin, c.organizationId, {
        name: '运营部',
        requestId,
      }),
    ).rejects.toMatchObject({ code: 'department_request_conflict' });
    await expect(
      createOrganizationDepartment(admin, c.organizationId, {
        name: '财务部',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'department_name_taken' });
  });
  it('renames with revision checks and preserves creation replay identity', async () => {
    const c = await company(),
      input = { name: '财务部', requestId: randomUUID() };
    const d = (
      await createOrganizationDepartment(admin, c.organizationId, input)
    ).department;
    const result = await updateOrganizationDepartment(
      admin,
      c.organizationId,
      d.id,
      { name: '财务运营部', active: true, expectedRevision: 1 },
    );
    expect(result.department).toMatchObject({
      id: d.id,
      revision: 2,
      name: '财务运营部',
    });
    await expect(
      updateOrganizationDepartment(admin, c.organizationId, d.id, {
        name: '过期名称',
        active: true,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'department_conflict' });
    expect(
      (await createOrganizationDepartment(admin, c.organizationId, input))
        .department.id,
    ).toBe(d.id);
  });
  it('rejects assignment from a different company, including the database foreign key', async () => {
    const a = await company(),
      b = await company(),
      e = await employee(a.organizationId),
      d = await department(b.organizationId);
    await expect(move(a.organizationId, e.userId, d.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      fixture.db`update allrice_organization_people set department_id=${d.id} where organization_id=${a.organizationId} and user_id=${e.userId}`,
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      updateOrganizationDepartment(admin, a.organizationId, d.id, {
        name: '不可改',
        active: false,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('moves one company profile across departments without changing workspace memberships or another company', async () => {
    const a = await company(),
      b = await company(),
      first = await department(a.organizationId),
      second = await department(a.organizationId, '运营部'),
      e = await employee(a.organizationId, first.id);
    await fixture.db`insert into allrice_memberships(organization_id,user_id,role,active) values(${b.organizationId},${e.userId},'member',true)`;
    const membershipBefore =
      await fixture.db`select * from allrice_memberships where user_id=${e.userId} order by id`;
    const old = (await listOrganizationPeople(admin, a.organizationId))
      .people[0]!;
    await move(a.organizationId, e.userId, second.id);
    expect(
      (await listOrganizationPeople(admin, a.organizationId)).people[0],
    ).toMatchObject({ departmentId: second.id, departmentName: '运营部' });
    expect(
      (await listOrganizationPeople(admin, b.organizationId)).people[0],
    ).toMatchObject({ departmentId: null, departmentName: null });
    expect(
      await fixture.db`select * from allrice_memberships where user_id=${e.userId} order by id`,
    ).toEqual(membershipBefore);
    await expect(
      updateOrganizationPerson(admin, a.organizationId, e.userId, {
        username: e.username,
        displayName: '旧编辑',
        departmentId: first.id,
        expectedVersion: old.version,
      }),
    ).rejects.toMatchObject({ code: 'account_conflict' });
  });
  it('preserves assignment when old profile editors omit the new field and allows explicit unassignment', async () => {
    const c = await company(),
      d = await department(c.organizationId),
      e = await employee(c.organizationId, d.id);
    const p = (await listOrganizationPeople(admin, c.organizationId))
      .people[0]!;
    await updateOrganizationPerson(admin, c.organizationId, e.userId, {
      username: e.username,
      displayName: '更新姓名',
      expectedVersion: p.version,
    });
    expect(
      (await listOrganizationPeople(admin, c.organizationId)).people[0]
        ?.departmentId,
    ).toBe(d.id);
    await move(c.organizationId, e.userId, null);
    expect(
      (await listOrganizationPeople(admin, c.organizationId)).people[0]
        ?.departmentId,
    ).toBeNull();
  });
  it('blocks deactivation while referenced, then retains history and rejects new assignment until re-enabled', async () => {
    const c = await company(),
      d = await department(c.organizationId),
      e = await employee(c.organizationId, d.id);
    await expect(
      updateOrganizationDepartment(admin, c.organizationId, d.id, {
        name: d.name,
        active: false,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'department_in_use' });
    await move(c.organizationId, e.userId, null);
    const archived = await updateOrganizationDepartment(
      admin,
      c.organizationId,
      d.id,
      { name: d.name, active: false, expectedRevision: 1 },
    );
    expect(archived.department).toMatchObject({
      id: d.id,
      active: false,
      revision: 2,
    });
    await expect(move(c.organizationId, e.userId, d.id)).rejects.toMatchObject({
      code: 'department_inactive',
    });
    expect(
      (await listOrganizationDepartments(admin, c.organizationId))
        .departments[0]?.id,
    ).toBe(d.id);
    await updateOrganizationDepartment(admin, c.organizationId, d.id, {
      name: d.name,
      active: true,
      expectedRevision: 2,
    });
    await move(c.organizationId, e.userId, d.id);
  });
  it('serializes assignment with deactivation so a newly assigned department cannot be inactive', async () => {
    const c = await company(),
      d = await department(c.organizationId),
      e = await employee(c.organizationId);
    const result = await Promise.allSettled([
      move(c.organizationId, e.userId, d.id),
      updateOrganizationDepartment(admin, c.organizationId, d.id, {
        name: d.name,
        active: false,
        expectedRevision: 1,
      }),
    ]);
    expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const [state] =
      await fixture.db`select p.department_id,d.archived_at from allrice_organization_people p cross join allrice_departments d where p.organization_id=${c.organizationId} and p.user_id=${e.userId} and d.id=${d.id}`;
    expect(state!.department_id !== null && state!.archived_at !== null).toBe(
      false,
    );
  });
  it('denies normal members and stale revoked administrator sessions', async () => {
    const c = await company(),
      e = await employee(c.organizationId),
      signed = await login({
        username: e.username!,
        password: `${e.username}@123`,
      }),
      member = (await authenticateSession(signed.session.token))!;
    await expect(
      listOrganizationDepartments(member, c.organizationId),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      createOrganizationDepartment(member, c.organizationId, {
        name: '越权部门',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const [session] =
      await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${admin.sessionId} returning id`;
    expect(session).toBeTruthy();
    await expect(
      createOrganizationDepartment(admin, c.organizationId, {
        name: '过期登录',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
});
