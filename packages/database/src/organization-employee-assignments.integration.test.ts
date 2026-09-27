import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrganizationAiTarget, RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
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
  updateManagedOrganization,
} from './organization-administration.ts';
import {
  listOrganizationAiAssignments,
  changeOrganizationAiAssignments,
} from './organization-employee-assignments.ts';
import { recordManagedCloudEnvironment } from './tenant-employee-access.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  getChatSessionHistory,
  sendChatMessage,
} from './workspace/service.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import { assembleEmployeeKernel } from '../../../apps/worker/src/employee-kernel.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-161 personal AI assignment and frozen company persona', () => {
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
      email: 'assignment-admin@example.test',
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
  async function setup() {
    const c = await createManagedOrganization(admin, {
      name: '星米科技',
      businessContext: '文创企业',
    });
    const source = await createEmployeeAdministrationFixture(fixture.db);
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const entry = async (target: OrganizationAiTarget = { type: 'all' }) =>
      (
        await listOrganizationAiAssignments(
          admin,
          c.organizationId,
          c.defaultWorkspaceId,
          target,
        )
      ).employees.find((e) => e.employeeId === source.employeeId)!;
    const change = async (
      action: 'include' | 'exclude' | 'inherit' | 'default',
      target: OrganizationAiTarget = { type: 'all' },
      defaultEnabled?: boolean,
    ) => {
      const e = await entry();
      return changeOrganizationAiAssignments(admin, c.organizationId, {
        workspaceId: c.defaultWorkspaceId,
        employeeId: e.employeeId,
        revisionId: e.revisionId,
        expectedVersion: e.deployment?.version ?? null,
        action,
        target,
        ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
      });
    };
    const person = async (name: string, job = '财务') => {
      const username = `person-${randomUUID()}`;
      const p = (
        await importOrganizationPeople(admin, c.organizationId, {
          people: [
            {
              username,
              displayName: name,
              jobTitle: job,
              responsibilities: '供应商对账',
            },
          ],
        })
      ).created[0]!;
      const signed = await login({ username, password: 'admin@321' });
      const context = (await authenticateSession(signed.session.token))!;
      return {
        ...p,
        username,
        context,
        target: { type: 'selected', userIds: [p.userId] } as const,
      };
    };
    return { ...c, source, entry, change, person };
  }
  const selected = (id: string): OrganizationAiTarget => ({
    type: 'selected',
    userIds: [id],
  });
  async function heartbeat() {
    await recordManagedCloudEnvironment(
      {
        workerId: randomUUID(),
        browser: { available: false, profile: null, reason: 'fixture' },
        compute: { available: false, profile: null, reason: 'fixture' },
      },
      fixture.db,
    );
  }
  it('prepares a company roster before hiring, inherits it on account creation, and persists personal exclusions across heartbeat and publication', async () => {
    const f = await setup();
    await f.change('default', { type: 'all' }, true);
    expect(
      await fixture.db`select id from allrice_memberships where organization_id=${f.organizationId}`,
    ).toHaveLength(0);
    const a = await f.person('小雪'),
      b = await f.person('小李');
    const workspace = () =>
      getEmployeeWorkspace(a.context, f.defaultWorkspaceId);
    const original = (await workspace()).employees[0]!;
    expect((await f.entry()).targetAssignedCount).toBe(2);
    await f.change('exclude', selected(a.userId));
    const version = (await f.entry()).deployment!.tenantVersionId;
    await heartbeat();
    expect((await workspace()).employees).toEqual([]);
    expect(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId)).employees,
    ).toHaveLength(1);
    // The existing published package refresh must preserve explicit choices.
    const { materializePlatformEmployeeRevision } =
      await import('./employees/platform-employees.ts');
    await fixture.db.begin(async (tx) =>
      materializePlatformEmployeeRevision(tx, {
        employeeId: f.source.employeeId,
        revision: (await f.source.revision()) as Parameters<
          typeof materializePlatformEmployeeRevision
        >[1]['revision'],
        definition: f.source.definition,
        workspaceIds: [f.defaultWorkspaceId],
        actorLabel: admin.actor.id,
      }),
    );
    await heartbeat();
    expect((await workspace()).employees).toEqual([]);
    expect((await f.entry()).deployment!.tenantVersionId).not.toBe(version);
    await f.change('inherit', selected(a.userId));
    expect((await workspace()).employees[0]!.id).toBe(original.id);
    expect(
      await fixture.db`select id from allrice_employee_versions where employee_id=${original.employeeId}`,
    ).toHaveLength(2);
    expect((await workspace()).employees[0]!.currentVersion.id).toBe(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId))
        .employees[0]!.currentVersion.id,
    );
    expect((await f.entry()).targetAssignedCount).toBe(2);
  });
  it('supports selected/filter/all actions without grants to others and keeps personal additions when company defaults are off', async () => {
    const f = await setup(),
      a = await f.person('财务甲'),
      b = await f.person('销售乙', '销售');
    expect(
      (await getEmployeeWorkspace(a.context, f.defaultWorkspaceId)).employees,
    ).toEqual([]);
    await f.change('include', { type: 'search', search: '财务' });
    expect((await f.entry()).targetAssignedCount).toBe(1);
    expect(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId)).employees,
    ).toEqual([]);
    await f.change('default', { type: 'all' }, true);
    expect((await f.entry()).targetAssignedCount).toBe(2);
    await f.change('default', { type: 'all' }, false);
    expect((await f.entry()).targetAssignedCount).toBe(1);
    expect(
      (await getEmployeeWorkspace(a.context, f.defaultWorkspaceId)).employees,
    ).toHaveLength(1);
    await f.change('exclude', { type: 'all' });
    await heartbeat();
    expect((await f.entry()).targetAssignedCount).toBe(0);
    await f.change('include', selected(b.userId));
    expect((await f.entry()).targetAssignedCount).toBe(1);
  });
  it('withdraws only the selected person, requests cancellation, preserves history and freezes company/person data for each run', async () => {
    const f = await setup(),
      a = await f.person('小雪'),
      b = await f.person('小李', '销售');
    await f.change('default', { type: 'all' }, true);
    const session = await createChatSession(a.context, {
      workspaceId: f.defaultWorkspaceId,
      title: '对账工作',
    });
    const sent = await sendChatMessage(
      a.context,
      f.defaultWorkspaceId,
      session.id,
      { text: '整理对账资料', clientMessageId: randomUUID() },
    );
    const resolve = () =>
      resolveEmployeeExecution({
        organizationId: f.organizationId,
        workspaceId: f.defaultWorkspaceId,
        ownerId: a.userId,
        runId: sent.run.id,
      });
    const first = await resolve();
    expect(first.promptSnapshot.organizationContext).toMatchObject({
      companyName: '星米科技',
      displayName: '小雪',
      jobTitle: '财务',
      userId: a.userId,
    });
    await updateManagedOrganization(admin, f.organizationId, {
      name: '星米集团',
      businessContext: '新业务',
      expectedRevision: 1,
    });
    const p = (
      await listOrganizationPeople(admin, f.organizationId)
    ).people.find((p) => p.userId === a.userId)!;
    await updateOrganizationPerson(admin, f.organizationId, a.userId, {
      username: a.username,
      displayName: '林小雪',
      jobTitle: '财务经理',
      responsibilities: '预算管理',
      expectedVersion: p.version,
    });
    expect((await resolve()).promptSnapshot.organizationContext).toEqual(
      first.promptSnapshot.organizationContext,
    );
    const nextSession = await createChatSession(a.context, {
      workspaceId: f.defaultWorkspaceId,
      title: '新预算',
    });
    const next = await sendChatMessage(
      a.context,
      f.defaultWorkspaceId,
      nextSession.id,
      { text: '整理预算', clientMessageId: randomUUID() },
    );
    const fresh = await resolveEmployeeExecution({
      organizationId: f.organizationId,
      workspaceId: f.defaultWorkspaceId,
      ownerId: a.userId,
      runId: next.run.id,
    });
    expect(fresh.promptSnapshot.organizationContext).toMatchObject({
      companyName: '星米集团',
      displayName: '林小雪',
      jobTitle: '财务经理',
      responsibilities: '预算管理',
    });
    const kernel = assembleEmployeeKernel({
      employeeAssignmentId: nextSession.employeeAssignmentId!,
      employeeVersionId: nextSession.employeeVersionId!,
      sessionId: nextSession.id,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      resolved: fresh,
    });
    expect(kernel.harness).toBe('dsh');
    expect(kernel.systemInstructions).toContain('财务经理');
    expect(kernel.systemInstructions).not.toContain('销售');
    const removed = await f.change('exclude', selected(a.userId));
    expect(removed.cancellationRequestedCount).toBe(2);
    expect(
      (await getChatSessionHistory(a.context, f.defaultWorkspaceId, session.id))
        .session.id,
    ).toBe(session.id);
    await expect(
      sendChatMessage(a.context, f.defaultWorkspaceId, session.id, {
        text: '不能执行',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId)).employees,
    ).toHaveLength(1);
    expect((await resolve()).promptSnapshot.organizationContext).toEqual(
      first.promptSnapshot.organizationContext,
    );
  });
  it('rejects foreign people, ordinary users and stale concurrent changes', async () => {
    const f = await setup(),
      a = await f.person('甲'),
      other = await setup(),
      b = await other.person('乙');
    const e = await f.entry(),
      input = {
        workspaceId: f.defaultWorkspaceId,
        employeeId: e.employeeId,
        revisionId: e.revisionId,
        expectedVersion: null,
        action: 'include',
        target: selected(a.userId),
      };
    await expect(
      changeOrganizationAiAssignments(a.context, f.organizationId, input),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(f.change('include', selected(b.userId))).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        changeOrganizationAiAssignments(admin, f.organizationId, input),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'employee_changed' },
    });
    expect((await f.entry()).targetAssignedCount).toBe(1);
  });
});
