import { mutateCompanyAsset } from './company-assets.ts';
import { assistantFixtureStorage } from './assistant-runtime.fixture.ts';
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
import {
  archivePlatformEmployee,
  savePlatformEmployeeDraft,
  publishPlatformEmployee,
} from './employees/platform-employees.ts';
import { listOrganizationAiAssignments } from './organization-employee-assignments.ts';

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
    it('captures current company rules on each formal input in the same Session and retries the original Run unchanged', async () => {
      const f = await setup();
      await f.change('assign');
      const assignment = (
        await getEmployeeWorkspace(f.tenant.context, f.tenant.workspaceId)
      ).employees[0]!;
      const session = await createChatSession(f.tenant.context, {
        workspaceId: f.tenant.workspaceId,
        employeeAssignmentId: assignment.id,
        title: 'Company rules across turns',
      });
      const ruleContent = {
        kind: 'rule',
        title: 'Current reply marker',
        body: 'Include CURRENT-V1.',
        category: '',
        appliesToEmployeeIds: [],
        taskKeywords: [],
        slots: [],
      };
      const mutate = (value: unknown) =>
        mutateCompanyAsset(
          f.admin.context,
          f.tenant.organizationId,
          value,
          assistantFixtureStorage(fixture.db),
          true,
          fixture.db,
        );
      let rule = await mutate({
        operation: 'save',
        assetId: randomUUID(),
        expectedRevision: 0,
        content: ruleContent,
      });
      rule = await mutate({
        operation: 'publish',
        assetId: rule.id,
        expectedRevision: rule.revision,
      });
      const input = {
        clientMessageId: randomUUID(),
        text: 'Check company marker',
        deliveryMode: 'follow_up',
      };
      const first = await sendChatMessage(
        f.tenant.context,
        f.tenant.workspaceId,
        session.id,
        input,
      );
      const [frozen] =
        await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${first.run.id}`;
      expect(
        frozen!.prompt_snapshot.companyAssets.rules[0].revision.content.body,
      ).toBe('Include CURRENT-V1.');
      rule = await mutate({
        operation: 'save',
        assetId: rule.id,
        expectedRevision: rule.revision,
        content: { ...ruleContent, body: 'Include CURRENT-V2.' },
      });
      rule = await mutate({
        operation: 'publish',
        assetId: rule.id,
        expectedRevision: rule.revision,
      });
      expect(
        (
          await sendChatMessage(
            f.tenant.context,
            f.tenant.workspaceId,
            session.id,
            input,
          )
        ).run.id,
      ).toBe(first.run.id);
      const second = await sendChatMessage(
        f.tenant.context,
        f.tenant.workspaceId,
        session.id,
        { ...input, clientMessageId: randomUUID(), text: 'New marker task' },
      );
      const [current] =
        await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${second.run.id}`;
      expect(
        current!.prompt_snapshot.companyAssets.rules[0].revision.content.body,
      ).toBe('Include CURRENT-V2.');
      await mutate({
        operation: 'pause',
        assetId: rule.id,
        expectedRevision: rule.revision,
      });
      const third = await sendChatMessage(
        f.tenant.context,
        f.tenant.workspaceId,
        session.id,
        { ...input, clientMessageId: randomUUID(), text: 'Paused marker task' },
      );
      const [paused] =
        await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${third.run.id}`;
      expect(paused!.prompt_snapshot.companyAssets.rules).toEqual([]);
      expect(
        (
          await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${first.run.id}`
        )[0]!.prompt_snapshot,
      ).toEqual(frozen!.prompt_snapshot);
    });

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

    it('publishes task metadata through all assignments and uses the same effective version on the next real send without changing old frozen Runs', async () => {
      const f = await setup();
      await f.change('assign');
      const before = await getEmployeeWorkspace(
        f.tenant.context,
        f.tenant.workspaceId,
      );
      const assignment = before.employees[0]!;
      const session = await createChatSession(f.tenant.context, {
        workspaceId: f.tenant.workspaceId,
        employeeAssignmentId: assignment.id,
        title: 'Recommendation publication',
      });
      const old = await sendChatMessage(
        f.tenant.context,
        f.tenant.workspaceId,
        session.id,
        {
          text: 'Original task',
          clientMessageId: randomUUID(),
          deliveryMode: 'follow_up',
        },
      );
      const [frozenRun] =
        await fixture.db`select employee_version_id, execution_snapshot, prompt_snapshot from allrice_employee_runs where run_id=${old.run!.id}`;
      const [frozenVersion] =
        await fixture.db`select manifest, config_checksum from allrice_employee_versions where id=${assignment.currentVersion.id}`;
      const tasks = [
        {
          id: 'review-installed-skill',
          title: '检查已装配资料',
          template: '整理最近 {{days}} 天的资料。',
          slots: [{ name: 'days', label: '天数', defaultValue: '7' }],
          requires: {
            toolNames: ['workspace.skill.read'],
            nativeSkillIds: [f.source.skillId],
          },
          preparation: ['files' as const],
        },
      ];
      const saved = await savePlatformEmployeeDraft(f.source.employeeId, {
        definition: { ...f.source.definition, taskSuggestions: tasks },
        expectedRevisionId: f.source.revisionId,
      });
      await f.source.preview();
      const publication = await publishPlatformEmployee(f.source.employeeId, {
        scope: 'assigned',
        expectedRevisionId: saved!.currentDraft!.id,
      });
      expect(publication.valid).toBe(true);
      expect(publication.workspaceIds).toEqual(
        expect.arrayContaining([f.source.workspaceId, f.tenant.workspaceId]),
      );
      // Exercise a historical Session that still carries its original pin.
      await fixture.db`update allrice_chat_sessions set employee_version_id=${assignment.currentVersion.id} where id=${session.id}`;
      const workspace = await getEmployeeWorkspace(
        f.tenant.context,
        f.tenant.workspaceId,
      );
      const effective = workspace.employees[0]!.currentVersion;
      expect(effective.id).not.toBe(assignment.currentVersion.id);
      expect(effective.taskSuggestions).toEqual([
        {
          id: tasks[0]!.id,
          title: tasks[0]!.title,
          template: tasks[0]!.template,
          slots: tasks[0]!.slots,
          preparation: ['files'],
        },
      ]);
      expect(effective.manifest).not.toHaveProperty('taskSuggestions');
      expect(
        workspace.sessions.find((item) => item.id === session.id)!
          .employeeVersionId,
      ).toBe(assignment.currentVersion.id);
      expect(
        (
          await fixture.db`select employee_version_id from allrice_chat_sessions where id=${session.id}`
        )[0]!.employee_version_id,
      ).toBe(assignment.currentVersion.id);
      expect(
        (
          await fixture.db`select employee_version_id, execution_snapshot, prompt_snapshot from allrice_employee_runs where run_id=${old.run!.id}`
        )[0],
      ).toEqual(frozenRun);
      expect(
        (
          await fixture.db`select manifest, config_checksum from allrice_employee_versions where id=${assignment.currentVersion.id}`
        )[0],
      ).toEqual(frozenVersion);
      const sent = await sendChatMessage(
        f.tenant.context,
        f.tenant.workspaceId,
        session.id,
        {
          text: '整理最近 7 天的资料。',
          clientMessageId: randomUUID(),
          deliveryMode: 'follow_up',
        },
      );
      const [next] =
        await fixture.db`select employee_version_id, execution_snapshot, prompt_snapshot from allrice_employee_runs where run_id=${sent.run!.id}`;
      expect(next!.employee_version_id).toBe(effective.id);
      expect(next!.execution_snapshot.employee.versionId).toBe(effective.id);
      expect(next!.prompt_snapshot.systemPrompt).not.toContain(
        'review-installed-skill',
      );
      const other = await principal();
      expect(
        (await getEmployeeWorkspace(other.context, other.workspaceId)).employees
          .flatMap((employee) => employee.currentVersion.taskSuggestions ?? [])
          .some((task) => task.id === 'review-installed-skill'),
      ).toBe(false);
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
      await archivePlatformEmployee(
        f.source.employeeId,
        { reason: 'Retire the acceptance employee' },
        f.admin.user.id,
      );
      expect((await f.list()).employees.map((e) => e.employeeId)).not.toContain(
        f.source.employeeId,
      );
      const catalog = await listOrganizationAiAssignments(
        f.admin.context,
        f.tenant.organizationId,
        f.tenant.workspaceId,
      );
      expect(catalog.employees.map((e) => e.employeeId)).not.toContain(
        f.source.employeeId,
      );
      expect(
        (
          await getChatSessionHistory(
            f.tenant.context,
            f.tenant.workspaceId,
            session.id,
          )
        ).session.employeeAssignmentId,
      ).toBe(a.id);
      expect(
        await fixture.db`select id from allrice_employee_assignments where id=${a.id}`,
      ).toHaveLength(1);
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
