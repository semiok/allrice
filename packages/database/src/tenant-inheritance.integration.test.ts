import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  CloudExecutionProfileSchema,
  BrowserProfileSchema,
  runtimePolicyActionDecision,
  type RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  createInvitation,
  acceptInvitation,
} from './identity.ts';
import {
  savePlatformEmployeeDraft,
  compilePlatformEmployee,
} from './employees/platform-employees.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from './tenant-employees.ts';
import {
  listAdminTenantMembers,
  updateAdminTenantMember,
} from './tenant-administration.ts';
import { recordManagedCloudEnvironment } from './tenant-employee-access.ts';
import {
  getEmployeeWorkspace,
  createChatSession,
  sendChatMessage,
  getChatSessionHistory,
} from './workspace/service.ts';
import { getWorkspaceReadiness } from './workspace-readiness.ts';
import { claimNextJob, startClaimedJob } from './execution/queue.ts';
import { acquireConversationRuntime } from './conversation/conversation-runtime.ts';
import {
  createBrowserWorkspace,
  revokeBrowserControlGrant,
} from './browser-control.ts';
import { createCloudCommandOperation } from './cloud-execution.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-159 continuous member inheritance and automatic cloud access (isolated PostgreSQL)',
  () => {
    let fdb: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeEach(async () => {
      fdb = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fdb.db);
      vi.stubEnv('ALLRICE_ENV', 'development');
    }, 120000);
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fdb?.close();
    });
    async function principal() {
      const key = randomUUID();
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 't-' + key,
          organizationName: 'Synthetic tenant',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic workspace',
          email: key + '@example.test',
          displayName: 'Synthetic administrator',
          role: 'admin',
        },
        fdb.db,
      );
      const login = await createSession(p.user.id),
        context = await authenticateSession(login.token, {
          organizationId: p.organizationId,
          workspaceId: p.workspaceId,
        });
      return { ...p, context: context! };
    }
    async function setup() {
      const admin = await principal(),
        tenant = await principal(),
        source = await createEmployeeAdministrationFixture(fdb.db);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
      const tools = [
        'workspace.skill.read',
        'cloud.process.execute',
        'browser.workspace',
        'assistant.delegate',
        'assistant.report',
      ];
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: { ...source.definition.capabilities, toolNames: tools },
        },
      });
      expect((await compilePlatformEmployee(source.employeeId)).valid).toBe(
        true,
      );
      expect((await source.publish()).valid).toBe(true);
      async function change(
        action: 'assign' | 'withdraw' | 'default',
        workspaceId = tenant.workspaceId,
      ) {
        const entry = (
          await listAdminTenantEmployees(
            admin.context,
            tenant.organizationId,
            workspaceId,
          )
        ).employees.find((e) => e.employeeId === source.employeeId)!;
        return changeAdminTenantEmployee(admin.context, tenant.organizationId, {
          workspaceId,
          employeeId: source.employeeId,
          action,
          revisionId:
            action === 'assign'
              ? entry.revisionId
              : entry.deployment!.revisionId,
          expectedVersion: entry.deployment?.version ?? null,
        });
      }
      await change('assign');
      async function join(
        role: 'member' | 'viewer' = 'member',
        workspaceId: string | null = tenant.workspaceId,
      ) {
        const invite = await createInvitation(tenant.context, {
          workspaceId,
          role,
          email: randomUUID() + '@example.test',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        });
        const user = await acceptInvitation({
          token: invite.token,
          displayName: 'New ordinary member',
          password: randomUUID(),
        });
        const login = await createSession(user.id),
          context = await authenticateSession(login.token, {
            organizationId: tenant.organizationId,
            workspaceId: tenant.workspaceId,
          });
        return { user, context: context! };
      }
      async function memberChange(
        subjectId: string,
        active: boolean,
        role: 'member' | 'viewer' = 'member',
      ) {
        const row = (
          await listAdminTenantMembers(
            admin.context,
            tenant.organizationId,
            null,
          )
        ).members.find((m) => m.userId === subjectId)!;
        return updateAdminTenantMember(
          admin.context,
          tenant.organizationId,
          row.id,
          {
            workspaceId: row.workspaceId,
            expectedVersion: row.version,
            active,
            role,
          },
        );
      }
      return { admin, tenant, source, change, join, memberChange };
    }
    const profile = CloudExecutionProfileSchema.parse({
      ...Object.fromEntries(
        Object.entries(CloudExecutionProfileSchema.shape)
          .filter(([k]) => k !== 'maximumConcurrency')
          .map(([k, s]) => [k, 'value' in s ? s.value : undefined]),
      ),
      maximumConcurrency: 1,
    });
    const browserProfile = BrowserProfileSchema.parse({
      version: 1,
      network: 'public_https',
      origins: [],
      allowHumanCredentials: true,
      allowDownloads: true,
      allowUploads: true,
    });
    const report = (workerId = randomUUID(), browser = true, compute = true) =>
      recordManagedCloudEnvironment(
        {
          workerId,
          browser: {
            available: browser,
            profile: browserProfile,
            reason: browser ? null : 'probe_failed',
          },
          compute: {
            available: compute,
            profile,
            reason: compute ? null : 'probe_failed',
          },
        },
        fdb.db,
      );
    async function workspace(context: RequestContext) {
      return getEmployeeWorkspace(context, context.workspaceId!);
    }

    it('invitation acceptance inherits exact published assignments and default without republishing; reads are idempotent', async () => {
      const f = await setup();
      await report();
      const joined = await f.join();
      const before =
        await fdb.db`select id from allrice_employee_versions where workspace_id=${f.tenant.workspaceId}`;
      const w = await workspace(joined.context);
      expect(w.employees).toHaveLength(1);
      expect(w.employees[0]!.isDefault).toBe(true);
      const old = (await workspace(f.tenant.context)).employees[0]!;
      expect(w.employees[0]!.currentVersion.id).toBe(old.currentVersion.id);
      const session = await createChatSession(joined.context, {
        workspaceId: f.tenant.workspaceId,
        title: 'New member task',
      });
      const sent = await sendChatMessage(
        joined.context,
        f.tenant.workspaceId,
        session.id,
        {
          text: 'Use the assigned employee',
          deliveryMode: 'follow_up',
          clientMessageId: randomUUID(),
          assistantPreference: { mode: 'daily', allowAssistants: true },
        },
      );
      const [run] =
        await fdb.db`select input from allrice_runs where id=${sent.run.id}`;
      expect(run!.input.assistantConfiguration).toMatchObject({
        allowAssistants: true,
        mode: 'daily',
      });
      const [frozen] =
        await fdb.db`select execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      expect(
        frozen!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
      ).toEqual(
        expect.arrayContaining([
          'browser.workspace',
          'cloud.process.execute',
          'assistant.delegate',
        ]),
      );
      expect(joined.context.memberships.every((m) => m.role === 'member')).toBe(
        true,
      );
      await workspace(joined.context);
      await report();
      expect(
        await fdb.db`select id from allrice_employee_versions where workspace_id=${f.tenant.workspaceId}`,
      ).toEqual(before);
      expect((await workspace(joined.context)).employees[0]!.id).toBe(
        w.employees[0]!.id,
      );
      expect(
        await fdb.db`select id from allrice_cloud_execution_grants where owner_id=${joined.user.id}`,
      ).toHaveLength(1);
      expect(
        await fdb.db`select id from allrice_browser_control_grants where owner_id=${joined.user.id}`,
      ).toHaveLength(1);
    });

    it('current membership controls execution; demotion/removal preserve history and explicit reactivation reuses the assignment', async () => {
      const f = await setup(),
        joined = await f.join();
      const w = await workspace(joined.context),
        id = w.employees[0]!.id;
      const session = await createChatSession(joined.context, {
        workspaceId: f.tenant.workspaceId,
        title: 'Retained conversation',
      });
      await f.memberChange(joined.user.id, true, 'viewer');
      expect((await workspace(joined.context)).employees).toEqual([]);
      expect(
        (
          await getChatSessionHistory(
            joined.context,
            f.tenant.workspaceId,
            session.id,
          )
        ).session.id,
      ).toBe(session.id);
      await expect(
        sendChatMessage(joined.context, f.tenant.workspaceId, session.id, {
          text: 'Must not execute',
          clientMessageId: randomUUID(),
        }),
      ).rejects.toBeDefined();
      await f.memberChange(joined.user.id, false);
      await expect(workspace(joined.context)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await f.memberChange(joined.user.id, true);
      expect((await workspace(joined.context)).employees[0]!.id).toBe(id);
      const viewer = await f.join('viewer');
      expect((await workspace(viewer.context)).employees).toHaveLength(0);
      expect(
        await fdb.db`select id from allrice_cloud_execution_grants where owner_id=${viewer.user.id}`,
      ).toHaveLength(0);
    });

    it('workspace-scoped and organization-scoped invitations inherit only their effective scope', async () => {
      const f = await setup();
      const second = randomUUID();
      await fdb.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${second},${f.tenant.organizationId},'second','Second workspace')`;
      await f.change('assign', second);
      const scoped = await f.join(),
        wide = await f.join('member', null);
      await expect(
        getEmployeeWorkspace(scoped.context, second),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        (await getEmployeeWorkspace(wide.context, second)).employees,
      ).toHaveLength(1);
      const other = await principal();
      await expect(
        getEmployeeWorkspace(
          { ...wide.context, organizationId: other.organizationId },
          other.workspaceId,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });

    it('public browser and compute grants are usable by a newly joined ordinary member through real queue and frozen bindings', async () => {
      const f = await setup();
      await report();
      const joined = await f.join();
      const session = await createChatSession(joined.context, {
        workspaceId: f.tenant.workspaceId,
        title: 'Cloud task',
      });
      const sent = await sendChatMessage(
        joined.context,
        f.tenant.workspaceId,
        session.id,
        { text: 'Inspect public data', clientMessageId: randomUUID() },
      );
      const worker = randomUUID(),
        job = await claimNextJob(worker, 300000);
      const execution = (await startClaimedJob(
        worker,
        job!.id,
        job!.lease!.token,
      ))!;
      expect(execution.context.runId).toBe(sent.run.id);
      const [version] =
        await fdb.db`select v.config_checksum from allrice_employee_versions v where id=${session.employeeVersionId}`;
      await acquireConversationRuntime({
        organizationId: f.tenant.organizationId,
        workspaceId: f.tenant.workspaceId,
        sessionId: session.id,
        ownerId: joined.user.id,
        runId: sent.run.id,
        workerId: worker,
        configChecksum: version!.config_checksum,
        compactThresholdTokens: 10000,
      });
      const browser = await createBrowserWorkspace(
        {
          context: execution.context,
          callId: randomUUID(),
          url: 'https://example.org/',
          jobAttempt: job!.attempt,
          jobLeaseToken: job!.lease!.token,
        },
        fdb.db,
      );
      expect(browser.profile.network).toBe('public_https');
      const cloud = await createCloudCommandOperation(
        {
          context: execution.context,
          callId: randomUUID(),
          arguments: { script: 'console.log(2+2)' },
        },
        fdb.db,
      );
      expect(cloud.snapshot.binding.execution.grantId).toBeTruthy();
      const readiness = await getWorkspaceReadiness(
        joined.context,
        f.tenant.workspaceId,
        null,
      );
      expect(
        readiness.capabilities.find((c) => c.id === 'cloud_browser')?.state,
      ).toBe('ready');
      expect(
        readiness.capabilities.find((c) => c.id === 'cloud_command')?.state,
      ).toBe('ready');
      await expect(
        createBrowserWorkspace(
          {
            context: execution.context,
            callId: randomUUID(),
            url: 'https://127.0.0.1/',
            jobAttempt: job!.attempt,
            jobLeaseToken: job!.lease!.token,
          },
          fdb.db,
        ),
      ).rejects.toMatchObject({ code: 'browser_origin_denied' });
    });

    it('explicit cloud revocation and policy pause survive preparation and new member events; withdrawn employees do not return', async () => {
      const f = await setup();
      await report();
      const joined = await f.join();
      const [g] =
        await fdb.db`select id,version from allrice_browser_control_grants where owner_id=${joined.user.id}`;
      await revokeBrowserControlGrant(f.admin.context, g!.id, fdb.db, {
        organizationId: f.tenant.organizationId,
        workspaceId: f.tenant.workspaceId,
        subjectId: joined.user.id,
        issuer: f.admin.context,
        reason: 'Explicit disconnect',
        expectedVersion: g!.version,
      });
      await fdb.db`update allrice_runtime_policy_controls set controls=jsonb_set(controls,'{enabled}','false') where workspace_id=${f.tenant.workspaceId}`;
      await report();
      await f.join();
      await report();
      expect(
        await fdb.db`select id from allrice_browser_control_grants where owner_id=${joined.user.id}`,
      ).toHaveLength(1);
      const [policy] =
        await fdb.db`select controls from allrice_runtime_policy_controls where workspace_id=${f.tenant.workspaceId}`;
      expect(policy!.controls.enabled).toBe(false);
      await f.change('withdraw');
      await report();
      const later = await f.join();
      expect((await workspace(later.context)).employees).toEqual([]);
      expect((await workspace(joined.context)).employees).toEqual([]);
    });

    it('real capability reports determine readiness independently and expired evidence is unavailable', async () => {
      const f = await setup();
      await report(undefined, false, true);
      const joined = await f.join();
      const [compute] =
        await fdb.db`select id from allrice_cloud_execution_grants where owner_id=${joined.user.id}`;
      expect(compute).toBeTruthy();
      expect(
        await fdb.db`select id from allrice_browser_control_grants where owner_id=${joined.user.id}`,
      ).toHaveLength(0);
      const notReady = await getWorkspaceReadiness(
        joined.context,
        f.tenant.workspaceId,
        null,
      );
      expect(
        notReady.capabilities.find((c) => c.id === 'cloud_browser')?.state,
      ).not.toBe('ready');
      await report();
      expect(
        await fdb.db`select id from allrice_browser_control_grants where owner_id=${joined.user.id}`,
      ).toHaveLength(1);
      // Health preparation must preserve the existing target's delivery capabilities.
      await fdb.db`update allrice_execution_targets set capabilities='["browser.navigate","browser.download","artifacts.write"]' where workspace_id=${f.tenant.workspaceId} and capabilities ? 'browser.navigate'`;
      await report();
      const [browserTarget] =
        await fdb.db`select capabilities from allrice_execution_targets where workspace_id=${f.tenant.workspaceId} and capabilities ? 'browser.navigate'`;
      expect(browserTarget!.capabilities).toEqual([
        'browser.navigate',
        'browser.download',
        'artifacts.write',
      ]);
      const [controls] =
        await fdb.db`select controls from allrice_runtime_policy_controls where workspace_id=${f.tenant.workspaceId}`;
      expect(
        runtimePolicyActionDecision(controls!.controls, 'assistant.delegate')
          .effect,
      ).toBe('allow');
      await fdb.db`update allrice_execution_targets set last_heartbeat_at=clock_timestamp()-interval '3 minutes' where workspace_id=${f.tenant.workspaceId}`;
      const expired = await getWorkspaceReadiness(
        joined.context,
        f.tenant.workspaceId,
        null,
      );
      expect(
        expired.capabilities.find((c) => c.id === 'cloud_browser')?.state,
      ).not.toBe('ready');
      expect(
        expired.capabilities.find((c) => c.id === 'cloud_command')?.state,
      ).not.toBe('ready');
    });
  },
);
