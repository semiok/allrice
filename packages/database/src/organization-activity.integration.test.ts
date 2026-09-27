import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, describe, vi } from 'vitest';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  revokeSession,
} from './identity.ts';
import {
  listOrganizationActivityOverview,
  listOrganizationActivityPeople,
  listOrganizationActivityRuns,
} from './organization-activity.ts';
import { inspectTenantRun } from './tenant-validation.ts';
import { inspectTenantRunArtifacts } from './artifact-review.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'company activity uses existing scoped records (isolated PostgreSQL)',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let a: Awaited<ReturnType<typeof tenantValidationFixture>>, b: typeof a;
    let admin: NonNullable<Awaited<ReturnType<typeof authenticateSession>>>;
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
          email: 'activity-admin@example.test',
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
      if (f) await f.close();
    });
    it('aggregates actual states, reasons and authoritative time without advancing or creating clocks', async () => {
      const policy = resolveTaskRuntimePolicy([]);
      await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy,active_ms,waiting_ms,phase,changed_at) values(${a.task.runId},${a.target.organizationId},${a.target.workspaceId},${f.db.json({ ...policy })},120000,60000,'waiting',clock_timestamp()-interval '30 seconds')`;
      await f.db`insert into allrice_task_questions(run_id,question_id,pending) values(${a.task.runId},'question',true)`;
      const before =
        await f.db`select * from allrice_task_clocks order by run_id`;
      const overview = await listOrganizationActivityOverview(admin);
      expect(
        overview.organizations.find((o) => o.id === a.target.organizationId)
          ?.counts,
      ).toMatchObject({ waiting: 1, running: 0 });
      expect(
        overview.organizations.find((o) => o.id === b.target.organizationId)
          ?.counts,
      ).toMatchObject({ waiting: 0, running: 1 });
      const people = await listOrganizationActivityPeople(
        admin,
        a.target.organizationId,
      );
      expect(people.people).toHaveLength(1);
      expect(people.people[0]).toMatchObject({
        userId: a.target.subjectId,
        counts: { waiting: 1 },
        computerCount: 0,
        applicationCount: 0,
      });
      const runs = await listOrganizationActivityRuns(
        admin,
        a.target.organizationId,
        a.target.subjectId,
        { status: 'waiting' },
      );
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]).toMatchObject({
        id: a.task.runId,
        status: 'waiting',
        stage: '等待员工回复',
        timing: { activeMs: 120000 },
      });
      expect(runs.runs[0]!.timing!.waitingMs).toBeGreaterThanOrEqual(90000);
      expect(
        await f.db`select * from allrice_task_clocks order by run_id`,
      ).toEqual(before);
      expect(JSON.stringify({ overview, people, runs })).not.toMatch(
        /PRIVATE_TEST_SECRET|NEVER_EXPOSE_RAW_SNAPSHOT/,
      );
      await f.db`update allrice_runs set state='succeeded',completed_at=now() where id=${a.task.runId}`;
      expect(
        (
          await listOrganizationActivityRuns(
            admin,
            a.target.organizationId,
            a.target.subjectId,
          )
        ).runs[0]?.status,
      ).toBe('succeeded');
      await f.db`update allrice_runs set completed_at=now()-interval '8 days' where id=${a.task.runId}`;
      expect(
        (await listOrganizationActivityPeople(admin, a.target.organizationId))
          .people[0]?.counts.succeeded,
      ).toBe(0);
      expect(
        (
          await listOrganizationActivityRuns(
            admin,
            a.target.organizationId,
            a.target.subjectId,
          )
        ).runs,
      ).toHaveLength(1);
    });
    it('keeps history inspectable after employee disable, without admitting foreign users, cursors or ordinary viewers', async () => {
      await f.db`update allrice_users set status='disabled' where id=${a.target.subjectId}`;
      await f.db`update allrice_memberships set active=false where user_id=${a.target.subjectId}`;
      expect(
        (
          await listOrganizationActivityRuns(
            admin,
            a.target.organizationId,
            a.target.subjectId,
          )
        ).runs[0]?.id,
      ).toBe(a.task.runId);
      expect(
        (await inspectTenantRun(admin, a.target, a.task.runId, f.db)).run.id,
      ).toBe(a.task.runId);
      expect(
        (
          await inspectTenantRunArtifacts(
            admin,
            a.target,
            a.task.runId,
            a.artifact.artifactId,
            f.db,
          )
        ).artifacts,
      ).toHaveLength(1);
      await expect(
        listOrganizationActivityRuns(
          admin,
          a.target.organizationId,
          b.target.subjectId,
        ),
      ).rejects.toThrow('not_found');
      await expect(
        listOrganizationActivityRuns(
          admin,
          a.target.organizationId,
          a.target.subjectId,
          { before: b.task.runId },
        ),
      ).rejects.toThrow('not_found');
      await expect(
        inspectTenantRunArtifacts(
          admin,
          a.target,
          a.task.runId,
          b.artifact.artifactId,
          f.db,
        ),
      ).rejects.toThrow('artifact_not_found');
      const member = (await authenticateSession(
        (await createSession(b.target.subjectId)).token,
      ))!;
      await expect(listOrganizationActivityOverview(member)).rejects.toThrow();
      await expect(
        inspectTenantRun(member, a.target, a.task.runId, f.db),
      ).rejects.toThrow();
      const session = await createSession(admin.actor.id),
        stale = (await authenticateSession(session.token))!;
      await revokeSession(session.token);
      await expect(
        listOrganizationActivityRuns(
          stale,
          a.target.organizationId,
          a.target.subjectId,
        ),
      ).rejects.toThrow();
    });
    it('pages tied timestamps without duplicates and omits archived sessions', async () => {
      // Existing frozen execution snapshots remain untouched; create independent Runs/messages.
      const stamp = new Date('2026-01-01T00:00:00Z');
      for (let i = 0; i < 51; i++) {
        const run = randomUUID(),
          answer = randomUUID(),
          question = randomUUID();
        await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,created_at) values(${run},${b.target.organizationId},${b.target.workspaceId},${b.target.subjectId},'succeeded',${stamp})`;
        await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${answer},${b.target.organizationId},${b.target.workspaceId},${b.task.chatSessionId},${b.target.subjectId},'assistant','{"text":"test","citations":[]}'),(${question},${b.target.organizationId},${b.target.workspaceId},${b.task.chatSessionId},${b.target.subjectId},'user','{"text":"test","citations":[]}')`;
        await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot) select ${run},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${question},${answer},provider_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${b.task.runId}`;
      }
      const page1 = await listOrganizationActivityRuns(
        admin,
        b.target.organizationId,
        b.target.subjectId,
      );
      expect(page1.runs).toHaveLength(50);
      const page2 = await listOrganizationActivityRuns(
        admin,
        b.target.organizationId,
        b.target.subjectId,
        { before: page1.nextCursor },
      );
      expect(page2.runs).toHaveLength(2);
      expect(
        new Set([...page1.runs, ...page2.runs].map((r) => r.id)).size,
      ).toBe(52);
      expect(page2.nextCursor).toBeNull();
      await f.db`update allrice_chat_sessions set archived_at=now() where id=${b.task.chatSessionId}`;
      expect(
        (
          await listOrganizationActivityRuns(
            admin,
            b.target.organizationId,
            b.target.subjectId,
          )
        ).runs,
      ).toHaveLength(0);
    });
  },
);
