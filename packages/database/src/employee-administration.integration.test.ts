import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  employeeToolCatalog,
  assembleEmployeeCapabilities,
  allRiceToolManifest,
  employeeToolConfigurationErrors,
  runtimePolicyActionDecision,
} from '@allrice/contracts';
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
  getPlatformRuntimePolicyControls,
  setPlatformRuntimePolicyControls,
} from './runtime-policy.ts';
import {
  reviewEmployeePublication,
  readPlatformSkillForAdministration,
  listEmployeeToolAvailability,
} from './employee-administration.ts';
import {
  compilePlatformEmployee,
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
  rollbackPlatformEmployee,
} from './employees/platform-employees.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-151 policy and exact employee publication administration', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  async function setup() {
    const f = await createEmployeeAdministrationFixture(fixture.db),
      key = randomUUID();
    const p = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: `admin-${key}`,
        organizationName: 'Synthetic platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: `${key}@example.test`,
        displayName: 'Synthetic administrator',
        role: 'admin',
      },
      fixture.db,
    );
    const session = await createSession(p.user.id),
      context = await authenticateSession(session.token, {
        organizationId: p.organizationId,
        workspaceId: p.workspaceId,
      });
    if (!context) throw Error('fixture_login');
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    const target = {
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
    };
    const read = () =>
      getPlatformRuntimePolicyControls(
        context,
        f.organizationId,
        f.workspaceId,
        fixture.db,
      );
    const write = (
      expectedVersion: number | null,
      rules: { action: string; effect: 'allow' | 'deny' | 'ask' }[] = [
        { action: 'local.process.execute', effect: 'allow' },
      ],
    ) =>
      setPlatformRuntimePolicyControls(
        context,
        target,
        {
          version: (expectedVersion ?? 0) + 1,
          enabled: true,
          mode: 'execute',
          rules,
        },
        expectedVersion,
        'Synthetic reviewed policy',
        fixture.db,
      );
    const review = () =>
      reviewEmployeePublication(
        context,
        f.employeeId,
        [f.workspaceId],
        fixture.db,
      );
    const publish = (r: Awaited<ReturnType<typeof review>>) =>
      publishPlatformEmployee(
        f.employeeId,
        {
          workspaceIds: r.targets.map((t) => t.id),
          expectedRevisionId: r.revisionId,
          expectedPublishedRevisionId: r.publishedRevisionId,
          expectedPackageChecksum: r.packageChecksum,
          policyVersions: r.policyVersions,
        },
        context.actor.id,
        context,
      );
    return { ...f, context, session, target, read, write, review, publish };
  }
  it('publishes selected development tools without a preview, enables matching policy atomically, and preserves immutable tenant bindings', async () => {
    const oldEnvironment = process.env.ALLRICE_ENV;
    process.env.ALLRICE_ENV = 'development';
    try {
      const f = await setup();
      const definition = assembleEmployeeCapabilities(
        {
          ...f.definition,
          capabilities: {
            ...f.definition.capabilities,
            toolNames: [
              'local.process.execute',
              'assistant.delegate',
              'web.search',
              'workspace.skill.read',
            ],
          },
        },
        [],
      );
      const saved = await savePlatformEmployeeDraft(f.employeeId, {
        definition,
        expectedRevisionId: f.revisionId,
      });
      const compilation = await compilePlatformEmployee(f.employeeId);
      expect(compilation.valid).toBe(true);
      await fixture.db`delete from allrice_platform_employee_test_runs where employee_id=${f.employeeId}`;
      await fixture.db`update allrice_provider_status set checked_at=clock_timestamp()-interval '1 hour' where provider='codex'`;
      const before = await f.write(null, [
        { action: 'assistant.delegate', effect: 'deny' },
      ]);
      const review = await f.review();
      expect(review.valid).toBe(true);
      expect(review.policyVersions[f.workspaceId]).toBe(before.version);
      const result = await f.publish(review);
      expect(result.valid).toBe(true);
      const policy = await f.read();
      expect(policy.controls).toMatchObject({ enabled: true, mode: 'execute' });
      expect(
        runtimePolicyActionDecision(policy.controls, 'assistant.delegate')
          .effect,
      ).toBe('allow');
      expect(
        runtimePolicyActionDecision(policy.controls, 'local.process.execute')
          .effect,
      ).toBe('ask');
      const [assigned] =
        await fixture.db`select a.employee_version_id,v.manifest from allrice_employee_assignments a join allrice_employee_versions v on v.id=a.employee_version_id where a.workspace_id=${f.workspaceId} and a.active`;
      expect(assigned?.manifest.capabilityBindings.toolNames).toEqual(
        expect.arrayContaining([
          'local.process.execute',
          'assistant.delegate',
          'web.search',
        ]),
      );
      const [audit] =
        await fixture.db`select count(*)::int n from allrice_platform_employee_audit_events where employee_id=${f.employeeId} and action='employee.capabilities.enabled'`;
      expect(audit?.n).toBe(1);
      expect(saved!.currentDraft!.id).toBe(review.revisionId);
    } finally {
      if (oldEnvironment === undefined) delete process.env.ALLRICE_ENV;
      else process.env.ALLRICE_ENV = oldEnvironment;
    }
  });

  it('uses the canonical Broker catalog and rejects impossible employee tool policies', async () => {
    const f = await setup();
    expect(employeeToolCatalog.map((t) => t.canonicalName)).toEqual(
      allRiceToolManifest.map((t) => t.canonicalName),
    );
    for (const name of [
      'browser.workspace',
      'local.browser.workspace',
      'local.preview.open',
      'assistant.delegate',
      'assistant.message',
      'assistant.report',
      'assistant.stop',
      'local.process.status',
      'local.process.stop',
    ]) {
      const definition = {
        ...f.definition,
        capabilities: {
          ...f.definition.capabilities,
          toolNames: ['workspace.skill.read', name],
        },
        securityPolicy: {
          ...f.definition.securityPolicy,
          bridgeAccess: 'read_write' as const,
          deniedCapabilities: [],
        },
      };
      expect(employeeToolConfigurationErrors(definition), name).toEqual([]);
      await savePlatformEmployeeDraft(f.employeeId, { definition });
      expect((await compilePlatformEmployee(f.employeeId)).valid, name).toBe(
        true,
      );
    }
    const base = {
      ...f.definition,
      capabilities: {
        ...f.definition.capabilities,
        toolNames: ['local.browser.workspace'],
      },
    };
    expect(employeeToolConfigurationErrors(base).join()).toContain(
      'Bridge 已禁用',
    );
    expect(
      employeeToolConfigurationErrors({
        ...base,
        securityPolicy: { ...base.securityPolicy, bridgeAccess: 'read_only' },
      }).join(),
    ).toContain('只读');
    const denied = {
      ...f.definition,
      capabilities: {
        ...f.definition.capabilities,
        toolNames: ['cloud.process.execute'],
      },
      securityPolicy: {
        ...f.definition.securityPolicy,
        deniedCapabilities: ['storage:write' as const],
      },
    };
    expect(employeeToolConfigurationErrors(denied).join()).toContain(
      '已被员工策略禁止',
    );
    expect(
      employeeToolCatalog.some(
        (t) => (t.canonicalName as string) === 'local.fs.changeset',
      ),
    ).toBe(false);
    expect(
      employeeToolConfigurationErrors({
        ...f.definition,
        capabilities: {
          ...f.definition.capabilities,
          toolNames: ['host.shell'],
        },
      }).join(),
    ).toContain('未注册');
  });
  it('creates/version-checks policy atomically, preserves exact approval and audits the actual issuer without tenant membership', async () => {
    const f = await setup();
    expect((await f.read()).version).toBeNull();
    const results = await Promise.allSettled([f.write(null), f.write(null)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'policy_version_conflict' },
    });
    const snapshot = await f.read();
    expect(snapshot.version).toBe(1);
    expect(
      runtimePolicyActionDecision(snapshot.controls, 'local.process.execute')
        .effect,
    ).toBe('ask');
    await f.write(1);
    const audits =
      await fixture.db`select actor_id,organization_id,metadata from allrice_audit_events where resource_id=${f.workspaceId} and action='runtime.policy.updated' order by occurred_at`;
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      actor_id: f.context.actor.id,
      organization_id: f.organizationId,
      metadata: {
        before: { version: 1 },
        after: { version: 2 },
        actorOrganizationId: f.context.organizationId,
      },
    });
    expect(
      await fixture.db`select id from allrice_memberships where user_id=${f.context.actor.id} and organization_id=${f.organizationId}`,
    ).toHaveLength(0);
    await expect(f.write(1)).rejects.toMatchObject({
      code: 'policy_version_conflict',
    });
  });
  it('denies unknown/duplicate actions, foreign targets, tenant admins and revoked platform sessions', async () => {
    const f = await setup();
    await expect(
      f.write(null, [{ action: 'host.shell', effect: 'allow' }]),
    ).rejects.toMatchObject({ code: 'policy_rules_invalid' });
    await expect(
      f.write(null, [
        { action: 'local.fs.read', effect: 'allow' },
        { action: 'local.fs.read', effect: 'allow' },
      ]),
    ).rejects.toMatchObject({ code: 'policy_rules_invalid' });
    await expect(
      setPlatformRuntimePolicyControls(
        f.context,
        { ...f.target, organizationId: f.context.organizationId },
        { version: 1, enabled: true, mode: 'execute', rules: [] },
        null,
        'Wrong scope',
        fixture.db,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const tenantSession = await createSession(f.ownerId),
      tenant = await authenticateSession(tenantSession.token, {
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
      });
    await expect(
      readPlatformSkillForAdministration(tenant!, f.skillId, fixture.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await revokeSession(f.session.token);
    await expect(f.read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(f.write(null)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(
      await fixture.db`select * from allrice_runtime_policy_controls where workspace_id=${f.workspaceId}`,
    ).toHaveLength(0);
  });
  it('reads Skill source without execution; review is read-only and exposes missing prerequisites rather than granting them', async () => {
    const f = await setup();
    const skill = await readPlatformSkillForAdministration(
      f.context,
      f.skillId,
      fixture.db,
    );
    expect(skill).toMatchObject({
      content: '# Synthetic reviewed Skill\n',
      version: '1.0.0',
      reviewStatus: 'reviewed',
      requiredToolRefs: ['workspace.skill.read'],
    });
    expect((await f.review()).valid).toBe(false);
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: {
        ...f.definition,
        capabilities: {
          ...f.definition.capabilities,
          toolNames: ['workspace.skill.read', 'browser.workspace'],
        },
      },
    });
    await f.preview();
    vi.stubEnv('ALLRICE_BROWSER_CONTROL_ENABLED', '0');
    const r = await f.review();
    expect(r.valid).toBe(true);
    expect(r.diff.length).toBeGreaterThan(0);
    expect(r.targets[0]!.actions.every((a) => a.effect === 'deny')).toBe(true);
    expect(r.warnings.join()).toContain('策略禁止');
    expect(r.warnings.join()).toContain('云端执行环境，请在租户管理中配置环境');
    expect(r.policyVersions[f.workspaceId]).toBeNull();
    expect(await f.assigned()).toBe(0);
    expect((await f.read()).controls).toBeNull();
    expect(listEmployeeToolAvailability().map((t) => t.canonicalName)).toEqual(
      employeeToolCatalog.map((t) => t.canonicalName),
    );
  });
  it('publishes the exact reviewed scope and preserves old frozen versions; stale policy/draft/published pointers cannot publish', async () => {
    const f = await setup();
    await f.preview();
    const old = await f.review();
    await f.write(null);
    await expect(f.publish(old)).rejects.toThrow(
      'platform_employee_publish_policy_changed',
    );
    expect(await f.assigned()).toBe(0);
    const r = await f.review();
    expect((await f.publish(r)).valid).toBe(true);
    const frozen = await f.revision(r.revisionId);
    await expect(
      savePlatformEmployeeDraft(f.employeeId, {
        definition: f.definition,
        expectedRevisionId: randomUUID(),
      }),
    ).rejects.toThrow('platform_employee_publish_snapshot_changed');
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: { ...f.definition, systemPrompt: 'Synthetic revision B' },
      expectedRevisionId: r.revisionId,
    });
    await expect(f.publish(r)).rejects.toThrow(
      'platform_employee_publish_snapshot_changed',
    );
    await f.preview();
    const next = await f.review();
    await expect(
      f.publish({ ...next, publishedRevisionId: randomUUID() }),
    ).rejects.toThrow('platform_employee_publish_snapshot_changed');
    expect((await f.publish(next)).valid).toBe(true);
    expect((await f.revision(r.revisionId)).runtime_profile).toEqual(
      frozen.runtime_profile,
    );
    await expect(
      rollbackPlatformEmployee(
        f.employeeId,
        {
          revisionId: r.revisionId,
          reason: 'Synthetic rollback',
          expectedPublishedRevisionId: next.revisionId,
          expectedWorkspaceIds: [randomUUID()],
        },
        f.context.actor.id,
        f.context,
      ),
    ).rejects.toThrow('platform_employee_publish_snapshot_changed');
    const inactiveWorkspaceId = randomUUID();
    await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${inactiveWorkspaceId},${f.organizationId},'inactive-assignment','Former target')`;
    await fixture.db`insert into allrice_platform_employee_tenant_assignments(employee_id,revision_id,organization_id,workspace_id,active) values(${f.employeeId},${r.revisionId},${f.organizationId},${inactiveWorkspaceId},false)`;
    const reverted = await rollbackPlatformEmployee(
      f.employeeId,
      {
        revisionId: r.revisionId,
        reason: 'Synthetic rollback',
        expectedPublishedRevisionId: next.revisionId,
        expectedWorkspaceIds: [f.workspaceId],
      },
      f.context.actor.id,
      f.context,
    );
    expect(reverted.workspaceIds).toEqual([f.workspaceId]);
    expect(
      (
        await fixture.db`select active from allrice_platform_employee_tenant_assignments where workspace_id=${inactiveWorkspaceId} and employee_id=${f.employeeId}`
      )[0]!.active,
    ).toBe(false);
    const [audit] =
      await fixture.db`select details from allrice_platform_employee_audit_events where employee_id=${f.employeeId} and action='employee.rolled_back' order by created_at desc limit 1`;
    expect(audit!.details.revisionId).toBe(r.revisionId);
  });
});
