import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
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
} from './organization-administration.ts';
import {
  listOrganizationAiAssignments,
  changeOrganizationAiAssignments,
} from './organization-employee-assignments.ts';
import {
  publishPlatformEmployee,
  compilePlatformEmployee,
  savePlatformEmployeeDraft,
  rollbackPlatformEmployee,
  getPlatformEmployee,
} from './employees/platform-employees.ts';
import { reviewEmployeePublication } from './employee-administration.ts';
import {
  createChatSession,
  sendChatMessage,
  getEmployeeWorkspace,
} from './workspace/service.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-161 global publication from actual assignments', () => {
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
      email: 'publication-admin@example.test',
      displayName: 'Admin',
      role: 'member',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    vi.stubEnv('ALLRICE_ENV', 'development');
    admin = (await authenticateSession(
      (await createSession(p.user.id)).token,
    ))!;
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  async function source() {
    const f = await createEmployeeAdministrationFixture(fixture.db);
    const result = await publishPlatformEmployee(
      f.employeeId,
      { scope: 'assigned' },
      admin.actor.id,
      admin,
    );
    if (!result.receipt || !result.workspaceIds)
      throw Error('fixture_catalog_failed');
    expect(result.receipt).toMatchObject({ companyCount: 0, peopleCount: 0 });
    expect(await f.assigned()).toBe(0);
    return f;
  }
  async function company(employeeId: string, name: string) {
    const c = await createManagedOrganization(admin, { name });
    const username = `publication-${randomUUID()}`;
    const p = (
      await importOrganizationPeople(admin, c.organizationId, {
        people: [{ username, displayName: name, jobTitle: '运营' }],
      })
    ).created[0]!;
    const context = (await authenticateSession(
      (await login({ username, password: 'admin@321' })).session.token,
    ))!;
    const change = async (action: 'include' | 'exclude') => {
      const e = (
        await listOrganizationAiAssignments(
          admin,
          c.organizationId,
          c.defaultWorkspaceId,
        )
      ).employees.find((e) => e.employeeId === employeeId)!;
      return changeOrganizationAiAssignments(admin, c.organizationId, {
        workspaceId: c.defaultWorkspaceId,
        employeeId,
        revisionId: e.revisionId,
        expectedVersion: e.deployment?.version ?? null,
        action,
        target: { type: 'selected', userIds: [p.userId] },
      });
    };
    await change('include');
    return { ...c, ...p, name, context, change };
  }
  async function reviewed(employeeId: string) {
    await compilePlatformEmployee(employeeId, admin.actor.id);
    const review = await reviewEmployeePublication(admin, employeeId);
    expect(review.valid).toBe(true);
    return {
      scope: 'assigned',
      expectedRevisionId: review.revisionId,
      expectedPublishedRevisionId: review.publishedRevisionId,
      expectedPackageChecksum: review.packageChecksum,
      policyVersions: review.policyVersions,
    };
  }
  it('first publishes to the catalog, updates all assigned companies, keeps running snapshots and old-chat next turns consistent, and preserves exclusions through rollback', async () => {
    const f = await source(),
      a = await company(f.employeeId, '甲公司'),
      b = await company(f.employeeId, '乙公司');
    const original = (
      await getEmployeeWorkspace(a.context, a.defaultWorkspaceId)
    ).employees[0]!;
    const running = await createChatSession(a.context, {
      workspaceId: a.defaultWorkspaceId,
      title: '运行中',
    });
    const idle = await createChatSession(a.context, {
      workspaceId: a.defaultWorkspaceId,
      title: '旧会话下一轮',
    });
    const sent = await sendChatMessage(
      a.context,
      a.defaultWorkspaceId,
      running.id,
      { text: '旧版任务', clientMessageId: randomUUID() },
    );
    const resolve = () =>
      resolveEmployeeExecution({
        organizationId: a.organizationId,
        workspaceId: a.defaultWorkspaceId,
        ownerId: a.userId,
        runId: sent.run.id,
      });
    const frozen = await resolve();
    await b.change('exclude');
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: {
        ...f.definition,
        systemPrompt: 'Updated global instructions.',
      },
    });
    const review = await reviewed(f.employeeId);
    const result = await publishPlatformEmployee(
      f.employeeId,
      review,
      admin.actor.id,
      admin,
    );
    if (!result.receipt || !result.workspaceIds)
      throw Error('publication_failed');
    expect(result.receipt).toMatchObject({ companyCount: 2, peopleCount: 1 });
    expect(result.workspaceIds.sort()).toEqual(
      [a.defaultWorkspaceId, b.defaultWorkspaceId].sort(),
    );
    expect(await f.assigned()).toBe(2); // The fixture's unrelated source workspace was not assigned.
    expect(await resolve()).toEqual(frozen);
    const next = await sendChatMessage(
      a.context,
      a.defaultWorkspaceId,
      idle.id,
      { text: '新一轮', clientMessageId: randomUUID() },
    );
    const fresh = await resolveEmployeeExecution({
      organizationId: a.organizationId,
      workspaceId: a.defaultWorkspaceId,
      ownerId: a.userId,
      runId: next.run.id,
    });
    expect(fresh.promptSnapshot.systemPrompt).toContain(
      'Updated global instructions.',
    );
    expect(
      (await getEmployeeWorkspace(b.context, b.defaultWorkspaceId)).employees,
    ).toEqual([]);
    const rollback = await rollbackPlatformEmployee(
      f.employeeId,
      {
        revisionId: f.revisionId,
        expectedPublishedRevisionId: result.revisionId,
        reason: '验收全局回退',
      },
      admin.actor.id,
      admin,
    );
    expect(rollback.receipt.peopleCount).toBe(1);
    expect(
      (await getEmployeeWorkspace(a.context, a.defaultWorkspaceId))
        .employees[0]!.id,
    ).toBe(original.id);
    expect(
      (await getEmployeeWorkspace(b.context, b.defaultWorkspaceId)).employees,
    ).toEqual([]);
    expect(await resolve()).toEqual(frozen);
    const [audit] =
      await fixture.db`select details from allrice_platform_employee_audit_events where employee_id=${f.employeeId} and action='employee.published' order by created_at desc limit 1`;
    expect(audit!.details.receipt.peopleCount).toBe(1);
  });
  it('rolls back the entire batch when a target fails, reports its company and retries without losing personal choices', async () => {
    const f = await source(),
      a = await company(f.employeeId, '故障甲'),
      b = await company(f.employeeId, '故障乙');
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: { ...f.definition, name: '第二版' },
    });
    const input = await reviewed(f.employeeId);
    const ids = [a.defaultWorkspaceId, b.defaultWorkspaceId].sort(),
      failed = [a, b].find((c) => c.defaultWorkspaceId === ids[1])!;
    const previous =
      await fixture.db`select id,revision_id,tenant_employee_version_id from allrice_platform_employee_tenant_assignments where employee_id=${f.employeeId} order by id`;
    const versions =
      await fixture.db`select v.id from allrice_employee_versions v join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=v.employee_id where d.employee_id=${f.employeeId} order by v.id`;
    await fixture.db`insert into allrice_runtime_metadata(key,value) values('publication-fixture-failure',${fixture.db.json({ workspaceId: failed.defaultWorkspaceId })})`;
    await fixture.db
      .unsafe(`create function reject_publication_fixture() returns trigger language plpgsql as $$ begin
      if exists(select 1 from allrice_runtime_metadata where key='publication-fixture-failure' and value->>'workspaceId'=new.workspace_id::text) then raise exception 'synthetic write failure'; end if;
      return new; end $$;
      create trigger reject_publication_fixture before insert on allrice_employee_versions for each row execute function reject_publication_fixture();`);
    try {
      await expect(
        publishPlatformEmployee(f.employeeId, input, admin.actor.id, admin),
      ).rejects.toMatchObject({
        code: 'employee_publication_target_failed',
        workspaceId: failed.defaultWorkspaceId,
        organizationName: failed.name,
      });
      expect(
        (await getPlatformEmployee(f.employeeId))!.currentPublished!.id,
      ).toBe(f.revisionId);
      expect(
        await fixture.db`select id,revision_id,tenant_employee_version_id from allrice_platform_employee_tenant_assignments where employee_id=${f.employeeId} order by id`,
      ).toEqual(previous);
      expect(
        await fixture.db`select v.id from allrice_employee_versions v join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=v.employee_id where d.employee_id=${f.employeeId} order by v.id`,
      ).toEqual(versions);
    } finally {
      await fixture.db.unsafe(
        'drop trigger reject_publication_fixture on allrice_employee_versions; drop function reject_publication_fixture();',
      );
    }
    const retry = await publishPlatformEmployee(
      f.employeeId,
      input,
      admin.actor.id,
      admin,
    );
    if (!retry.receipt || !retry.workspaceIds) throw Error('retry_failed');
    expect(retry.receipt).toMatchObject({ companyCount: 2, peopleCount: 2 });
  });
  it('rejects an outdated review after roster changes and never revives a withdrawn deployment', async () => {
    const f = await source(),
      a = await company(f.employeeId, '并发公司');
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: { ...f.definition, name: '并发新版' },
    });
    const input = await reviewed(f.employeeId);
    const { changeAdminTenantEmployee } = await import('./tenant-employees.ts');
    const e = (
      await listOrganizationAiAssignments(
        admin,
        a.organizationId,
        a.defaultWorkspaceId,
      )
    ).employees.find((e) => e.employeeId === f.employeeId)!;
    await changeAdminTenantEmployee(admin, a.organizationId, {
      workspaceId: a.defaultWorkspaceId,
      employeeId: f.employeeId,
      revisionId: e.deployment!.revisionId,
      expectedVersion: e.deployment!.version,
      action: 'withdraw',
    });
    await expect(
      publishPlatformEmployee(f.employeeId, input, admin.actor.id, admin),
    ).rejects.toThrow('platform_employee_publish_policy_changed');
    const result = await publishPlatformEmployee(
      f.employeeId,
      await reviewed(f.employeeId),
      admin.actor.id,
      admin,
    );
    if (!result.receipt || !result.workspaceIds) throw Error('catalog_failed');
    expect(result.receipt.companyCount).toBe(0);
    expect(
      (await getEmployeeWorkspace(a.context, a.defaultWorkspaceId)).employees,
    ).toEqual([]);
    const rollback = await rollbackPlatformEmployee(
      f.employeeId,
      { revisionId: f.revisionId, reason: '空配发回退' },
      admin.actor.id,
      admin,
    );
    expect(rollback.workspaceIds).toEqual([]);
  });
  it('keeps explicit company execution pauses during a global update', async () => {
    const f = await source(),
      a = await company(f.employeeId, '暂停公司');
    await fixture.db`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
      values(${a.organizationId},${a.defaultWorkspaceId},1,'{"version":1,"enabled":false,"mode":"plan_only","rules":[{"action":"assistant.delegate","effect":"deny"}]}')
      on conflict(organization_id,workspace_id) do update set controls=excluded.controls,version=excluded.version`;
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: { ...f.definition, name: '暂停期间更新' },
    });
    const result = await publishPlatformEmployee(
      f.employeeId,
      await reviewed(f.employeeId),
      admin.actor.id,
      admin,
    );
    expect(result.valid).toBe(true);
    const [policy] =
      await fixture.db`select controls from allrice_runtime_policy_controls where organization_id=${a.organizationId} and workspace_id=${a.defaultWorkspaceId}`;
    expect(policy!.controls).toMatchObject({
      enabled: false,
      mode: 'plan_only',
      rules: expect.arrayContaining([
        { action: 'assistant.delegate', effect: 'deny' },
      ]),
    });
  });
});
