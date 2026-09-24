import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from './identity.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from './tenant-employees.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  getChatSessionHistory,
  sendChatMessage,
} from './workspace/service.ts';
import { prepareEmployeeRunBinding } from './employees/employeehub.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-159 published employee deployments (isolated PostgreSQL; no model)',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (fixture) await fixture.close();
    });
    async function principal(role: 'admin' | 'member' = 'member') {
      const key = randomUUID();
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: `t-${key}`,
          organizationName: 'Synthetic tenant',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic workspace',
          email: `${key}@example.test`,
          displayName: 'Synthetic member',
          role,
        },
        fixture.db,
      );
      const session = await createSession(p.user.id),
        context = await authenticateSession(session.token, {
          organizationId: p.organizationId,
          workspaceId: p.workspaceId,
        });
      if (!context) throw Error('fixture_login');
      return { ...p, session, context };
    }
    async function published() {
      const f = await createEmployeeAdministrationFixture(fixture.db);
      await f.preview();
      expect((await f.publish()).valid).toBe(true);
      return f;
    }
    async function setup() {
      const admin = await principal('admin'),
        tenant = await principal(),
        source = await published();
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
      const list = () =>
        listAdminTenantEmployees(
          admin.context,
          tenant.organizationId,
          tenant.workspaceId,
        );
      const entry = async (id = source.employeeId) =>
        (await list()).employees.find((e) => e.employeeId === id)!;
      const change = async (
        action: 'assign' | 'withdraw' | 'default',
        id = source.employeeId,
      ) => {
        const e = await entry(id);
        return changeAdminTenantEmployee(admin.context, tenant.organizationId, {
          workspaceId: tenant.workspaceId,
          employeeId: id,
          action,
          revisionId:
            action === 'assign' ? e.revisionId : e.deployment!.revisionId,
          expectedVersion: e.deployment?.version ?? null,
        });
      };
      return { admin, tenant, source, list, entry, change };
    }
    it('assigns the exact published package to an ordinary member, creates a usable session and freezes the real execution binding', async () => {
      const f = await setup();
      const before =
        await fixture.db`select * from allrice_memberships where user_id=${f.tenant.user.id}`;
      expect(await f.change('assign')).toEqual({ changed: true });
      const e = await f.entry();
      expect(e.deployment).toMatchObject({
        active: true,
        isDefault: true,
        memberCount: 1,
        toolNames: ['workspace.skill.read'],
      });
      const workspace = await getEmployeeWorkspace(
        f.tenant.context,
        f.tenant.workspaceId,
      );
      expect(workspace.employees).toHaveLength(1);
      const a = workspace.employees[0]!;
      expect(a.isDefault).toBe(true);
      const session = await createChatSession(f.tenant.context, {
        workspaceId: f.tenant.workspaceId,
        employeeAssignmentId: a.id,
        title: 'Synthetic member task',
      });
      const binding = await prepareEmployeeRunBinding({
        context: f.tenant.context,
        workspaceId: f.tenant.workspaceId,
        assignmentId: a.id,
        employeeVersionId: a.currentVersion.id,
        sessionId: session.id,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        promptSnapshot: {
          systemPrompt: '',
          conversation: [],
          memories: [],
          userRequest: 'Read the installed skill',
        },
      });
      expect(binding.nativeSkills.map((s) => s.id)).toContain(f.source.skillId);
      expect(
        binding.executionSnapshot.capabilitySnapshot.bindings.toolNames,
      ).toContain('workspace.skill.read');
      expect(
        await fixture.db`select * from allrice_memberships where user_id=${f.tenant.user.id}`,
      ).toEqual(before);
      const [audit] =
        await fixture.db`select actor_id,organization_id,reason from allrice_audit_events where action='tenant.employee.assign' and organization_id=${f.tenant.organizationId}`;
      expect(audit).toMatchObject({
        actor_id: f.admin.user.id,
        organization_id: f.tenant.organizationId,
        reason: 'tenant_employee_management',
      });
      expect(
        await fixture.db`select id from allrice_memberships where organization_id=${f.tenant.organizationId} and user_id=${f.admin.user.id}`,
      ).toHaveLength(0);
    });
    it('serializes duplicate assignments without new versions, duplicate assignments or audit entries', async () => {
      const f = await setup();
      const e = await f.entry();
      const input = {
        workspaceId: f.tenant.workspaceId,
        employeeId: e.employeeId,
        action: 'assign',
        revisionId: e.revisionId,
        expectedVersion: null,
      };
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          changeAdminTenantEmployee(
            f.admin.context,
            f.tenant.organizationId,
            input,
          ),
        ),
      );
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      const d = (await f.entry()).deployment!;
      expect(
        await fixture.db`select id from allrice_employee_versions where employee_id=${d.tenantEmployeeId}`,
      ).toHaveLength(1);
      expect(
        await fixture.db`select id from allrice_employee_assignments where employee_id=${d.tenantEmployeeId}`,
      ).toHaveLength(1);
      expect(
        await fixture.db`select id from allrice_audit_events where action='tenant.employee.assign' and organization_id=${f.tenant.organizationId}`,
      ).toHaveLength(1);
    });
    it('withdraws the last employee, preserves history and rejects execution without silently provisioning Rice', async () => {
      const f = await setup();
      await f.change('assign');
      const a = (
        await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId)
      ).employees[0]!;
      const session = await createChatSession(f.tenant.context, {
        workspaceId: f.tenant.workspaceId,
        employeeAssignmentId: a.id,
        title: 'Retained history',
      });
      const prior = await f.entry();
      await f.change('withdraw');
      expect(await f.change('withdraw')).toEqual({ changed: false });
      for (let i = 0; i < 2; i++)
        expect(
          (await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId))
            .employees,
        ).toEqual([]);
      expect(
        (
          await getChatSessionHistory(
            f.tenant.context,
            f.tenant.workspaceId,
            session.id,
          )
        ).session.id,
      ).toBe(session.id);
      await expect(
        createChatSession(f.tenant.context, {
          workspaceId: f.tenant.workspaceId,
          title: 'No employee',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        sendChatMessage(f.tenant.context, f.tenant.workspaceId, session.id, {
          text: 'Must not execute',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        changeAdminTenantEmployee(f.admin.context, f.tenant.organizationId, {
          workspaceId: f.tenant.workspaceId,
          employeeId: prior.employeeId,
          action: 'assign',
          revisionId: prior.revisionId,
          expectedVersion: prior.deployment!.version,
        }),
      ).rejects.toMatchObject({ code: 'employee_changed' });
      await f.change('assign');
      expect(
        (await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId))
          .employees[0]!.id,
      ).toBe(a.id);
    });
    it('does not let a stale personal assignment bypass withdrawal or promote a read-only member into execution', async () => {
      const f = await setup();
      await f.change('assign');
      const a = (
        await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId)
      ).employees[0]!;
      const session = await createChatSession(f.tenant.context, {
        workspaceId: f.tenant.workspaceId,
        employeeAssignmentId: a.id,
        title: 'Existing task',
      });
      await fixture.db`update allrice_memberships set role='viewer' where organization_id=${f.tenant.organizationId} and user_id=${f.tenant.user.id}`;
      const viewer = await authenticateSession(f.tenant.session.token, {
        organizationId: f.tenant.organizationId,
        workspaceId: f.tenant.workspaceId,
      });
      await expect(
        sendChatMessage(viewer!, f.tenant.workspaceId, session.id, {
          text: 'Read only must not execute',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'identity_denied' });
      await f.change('withdraw');
      await fixture.db`update allrice_employee_assignments set active=true where id=${a.id}`;
      await fixture.db`update allrice_employees set status='active' where id=${a.employeeId}`;
      expect(
        (await getEmployeeWorkspace(viewer!, f.tenant.workspaceId)).employees,
      ).toHaveLength(0);
      await expect(
        createChatSession(viewer!, {
          workspaceId: f.tenant.workspaceId,
          employeeAssignmentId: a.id,
          title: 'Old assignment',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        await fixture.db`select id from allrice_runs where workspace_id=${f.tenant.workspaceId}`,
      ).toHaveLength(0);
    });
    it('switches the default and falls back on withdrawal without changing another employee or old session ownership', async () => {
      const f = await setup(),
        second = await published();
      await f.change('assign');
      await f.change('assign', second.employeeId);
      const previous = (
        await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId)
      ).employees[0]!;
      const session = await createChatSession(f.tenant.context, {
        workspaceId: f.tenant.workspaceId,
        title: 'Original owner',
      });
      await f.change('default', second.employeeId);
      expect(await f.change('default', second.employeeId)).toEqual({
        changed: false,
      });
      const workspace = await getEmployeeWorkspace(
        f.tenant.context,
        f.tenant.workspaceId,
      );
      expect(workspace.employees.find((e) => e.isDefault)!.employeeId).toBe(
        (await f.entry(second.employeeId)).deployment!.tenantEmployeeId,
      );
      expect(
        (
          await getChatSessionHistory(
            f.tenant.context,
            f.tenant.workspaceId,
            session.id,
          )
        ).session.employeeAssignmentId,
      ).toBe(previous.id);
      await f.change('withdraw', second.employeeId);
      expect((await f.entry()).deployment).toMatchObject({
        active: true,
        isDefault: true,
      });
      expect(
        (await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId))
          .employees,
      ).toHaveLength(1);
    });
    it('rejects cross-tenant targets, ordinary administrators, stale publications and expired management sessions', async () => {
      const f = await setup(),
        other = await principal();
      const e = await f.entry();
      const input = {
        workspaceId: f.tenant.workspaceId,
        employeeId: e.employeeId,
        action: 'assign',
        revisionId: e.revisionId,
        expectedVersion: null,
      };
      await expect(
        changeAdminTenantEmployee(
          f.tenant.context,
          f.tenant.organizationId,
          input,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        changeAdminTenantEmployee(f.admin.context, other.organizationId, input),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        changeAdminTenantEmployee(f.admin.context, f.tenant.organizationId, {
          ...input,
          revisionId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'employee_not_published' });
      await revokeSession(f.admin.session.token);
      await expect(
        changeAdminTenantEmployee(
          f.admin.context,
          f.tenant.organizationId,
          input,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        (
          await getEmployeeWorkspace(other.context, other.workspaceId)
        ).employees.every((a) => a.employeeId !== e.employeeId),
      ).toBe(true);
    });
  },
);
