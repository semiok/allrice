import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RouteDecisionSchema } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from './identity.ts';
import { createManagedOrganization } from './organization-administration.ts';
import { listOrganizationActivityRuns } from './organization-activity.ts';
import { inspectTenantRun } from './tenant-validation.ts';
import { readOrganizationDashboard } from './organization-dashboard.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'company dashboard reads formal scoped facts (isolated PostgreSQL)',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let a: Awaited<ReturnType<typeof tenantValidationFixture>>, b: typeof a;
    let admin: NonNullable<Awaited<ReturnType<typeof authenticateSession>>>;
    const now = new Date(),
      from = new Date(now.getTime() - 3600000),
      to = new Date(now.getTime() + 3600000);
    const range = {
      range: 'custom',
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: 'Asia/Shanghai',
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'allrice-platform',
          organizationName: 'Platform',
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: 'dashboard-admin@example.test',
          displayName: 'Admin',
          role: 'member',
        },
        f.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      admin = (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
      a = await tenantValidationFixture(f.db);
      b = await tenantValidationFixture(f.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    });
    async function run(
      state: string,
      createdAt: Date,
      completedAt: Date | null,
    ) {
      const id = randomUUID(),
        question = randomUUID(),
        answer = randomUUID();
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,created_at,completed_at)
      values(${id},${a.target.organizationId},${a.target.workspaceId},${a.target.subjectId},${state},${createdAt},${completedAt})`;
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${question},${a.target.organizationId},${a.target.workspaceId},${a.task.chatSessionId},${a.target.subjectId},'user','{"text":"Synthetic task","citations":[]}'),
      (${answer},${a.target.organizationId},${a.target.workspaceId},${a.task.chatSessionId},${a.target.subjectId},'assistant','{"text":"Synthetic result","citations":[]}')`;
      await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot)
      select ${id},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${question},${answer},provider_snapshot,prompt_snapshot
      from allrice_employee_runs where run_id=${a.task.runId}`;
      return id;
    }
    it('uses started/completed time separately, includes archived and former staff, and preserves root Runs with assistants enabled', async () => {
      await f.db`update allrice_runs set state='succeeded',completed_at=${now} where id=${a.task.runId}`;
      const old = new Date(now.getTime() - 20 * 86400000);
      await run('failed', old, now);
      await run('canceled', now, now);
      const queue = await run('queued', old, null);
      await run('waiting_approval', now, null);
      await run('succeeded', to, to);
      await f.db`update allrice_chat_sessions set archived_at=now() where id=${a.task.chatSessionId}`;
      await f.db`update allrice_users set status='disabled' where id=${a.target.subjectId}`;
      await f.db`update allrice_memberships set active=false where user_id=${a.target.subjectId}`;
      const snapshot =
        await f.db`select run_id,prompt_snapshot,provider_snapshot from allrice_employee_runs order by run_id`;
      const overview = await readOrganizationDashboard(
        admin,
        a.target.organizationId,
        range,
      );
      expect(overview.work).toEqual({
        started: 3,
        completed: 1,
        failed: 1,
        canceled: 1,
        current: { running: 0, waiting: 1, queued: 1 },
      });
      expect(overview.people).toMatchObject({
        activeEmployees: 0,
        inactiveEmployees: 1,
        activeParticipants: 0,
        historicalParticipants: 1,
      });
      expect(overview.deliverables.availableSeries).toBe(1);
      expect(
        (await inspectTenantRun(admin, a.target, a.task.runId, f.db)).artifacts,
      ).toHaveLength(1);
      expect(overview.usage).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        recordedCostCents: null,
      });
      expect(
        (
          await listOrganizationActivityRuns(
            admin,
            a.target.organizationId,
            null,
            { ...range, measure: 'started' },
          )
        ).runs,
      ).toHaveLength(3);
      const current = await listOrganizationActivityRuns(
        admin,
        a.target.organizationId,
        null,
        { ...range, measure: 'current' },
      );
      expect(current.runs).toHaveLength(2);
      expect(current.runs.some((r) => r.id === queue)).toBe(true);
      expect(
        current.runs.every(
          (r) => r.sessionArchived && r.ownerId === a.target.subjectId,
        ),
      ).toBe(true);
      expect(
        (
          await listOrganizationActivityRuns(
            admin,
            a.target.organizationId,
            a.target.subjectId,
            { ...range, measure: 'completed' },
          )
        ).runs,
      ).toHaveLength(3);
      expect(overview.filters.employees).toHaveLength(1);
      expect(
        await f.db`select run_id,prompt_snapshot,provider_snapshot from allrice_employee_runs order by run_id`,
      ).toEqual(snapshot);
      expect(
        (await readOrganizationDashboard(admin, b.target.organizationId, range))
          .work,
      ).toMatchObject({ started: 1, completed: 0, current: { running: 1 } });
      expect(JSON.stringify(overview)).not.toMatch(
        /PRIVATE_TEST_SECRET|NEVER_EXPOSE_RAW_SNAPSHOT/,
      );
    });
    it('distinguishes unknown zero placeholders, known zero and recorded positive tokens without counting cache twice', async () => {
      const [employee] =
        await f.db`select employee_id from allrice_employee_versions where id=${a.versionId}`;
      const decision = await recordRouteDecision(
        RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId: a.task.runId,
          organizationId: a.target.organizationId,
          workspaceId: a.target.workspaceId,
          actorId: a.target.subjectId,
          employeeId: employee!.employee_id,
          inputChecksum: `sha256:${'3'.repeat(64)}`,
          candidates: [],
          selectedKind: 'direct',
          selectedCandidateId: 'synthetic',
          harness: 'dsh',
          provider: 'synthetic',
          model: 'never-called',
          generation: 1,
          attempt: 1,
          reasonCodes: ['direct_no_capability_match'],
          createdAt: now.toISOString(),
        }),
        f.db,
      );
      const outcome = {
        decisionId: decision.id,
        status: 'succeeded' as const,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: null,
        cacheUsageKnown: false,
        usageComplete: false,
        errorCode: null,
        failureCategory: null,
        completedAt: now.toISOString(),
      };
      const complete = (value: typeof outcome) =>
        completeRouteDecision(
          {
            organizationId: a.target.organizationId,
            workspaceId: a.target.workspaceId,
            outcome: value,
          },
          f.db,
        );
      await complete(outcome);
      expect(
        (await readOrganizationDashboard(admin, a.target.organizationId, range))
          .usage,
      ).toMatchObject({
        receiptCount: 1,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        incompleteReceipts: 1,
        unknownCostReceipts: 1,
        terminalRuns: 3,
        terminalRunsWithReceipts: 1,
      });
      await complete({
        ...outcome,
        decisionId: (
          await recordRouteDecision(
            { ...decision, id: randomUUID(), attempt: 2 },
            f.db,
          )
        ).id,
        cacheUsageKnown: true,
        usageComplete: true,
      });
      expect(
        (await readOrganizationDashboard(admin, a.target.organizationId, range))
          .usage,
      ).toMatchObject({
        receiptCount: 2,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        incompleteReceipts: 1,
      });
      await complete({
        ...outcome,
        decisionId: (
          await recordRouteDecision(
            { ...decision, id: randomUUID(), attempt: 3 },
            f.db,
          )
        ).id,
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 20,
      });
      expect(
        (await readOrganizationDashboard(admin, a.target.organizationId, range))
          .usage,
      ).toMatchObject({
        receiptCount: 3,
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 25,
        incompleteReceipts: 2,
        currency: null,
      });
    });
    it('keeps empty companies honest and enforces current administrator authority, company targets and cursor scope', async () => {
      const empty = await createManagedOrganization(admin, {
        name: 'Synthetic empty company',
      });
      const overview = await readOrganizationDashboard(
        admin,
        empty.organizationId,
        range,
      );
      expect(overview.people.activeEmployees).toBe(0);
      expect(overview.deliverables.availableSeries).toBe(0);
      expect(overview.work.started).toBe(0);
      expect(overview.usage.inputTokens).toBeNull();
      await expect(
        readOrganizationDashboard(admin, a.target.organizationId, {
          ...range,
          userId: b.target.subjectId,
        }),
      ).rejects.toThrow('not_found');
      await expect(
        listOrganizationActivityRuns(admin, a.target.organizationId, null, {
          ...range,
          before: b.task.runId,
        }),
      ).rejects.toThrow('not_found');
      await expect(
        readOrganizationDashboard(admin, admin.organizationId, range),
      ).rejects.toThrow();
      const member = (await authenticateSession(
        (await createSession(b.target.subjectId)).token,
      ))!;
      await expect(
        readOrganizationDashboard(member, a.target.organizationId, range),
      ).rejects.toThrow();
      const session = await createSession(admin.actor.id),
        stale = (await authenticateSession(session.token))!;
      await revokeSession(session.token);
      await expect(
        readOrganizationDashboard(stale, a.target.organizationId, range),
      ).rejects.toThrow();
    });
  },
);
