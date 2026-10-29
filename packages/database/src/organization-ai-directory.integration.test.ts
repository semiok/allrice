import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { createOrganizationAiDirectoryFixture } from './organization-ai-directory.fixture.ts';
import {
  getOrganizationAiReferenceFile,
  getOrganizationAiSharedDetails,
  listOrganizationAiDirectory,
  listOrganizationPersonAiInstances,
} from './organization-ai-directory.ts';
import { getEmployeeDetails } from './employees/employee-content.ts';
import {
  listOrganizationPeople,
  updateOrganizationPerson,
} from './organization-administration.ts';
import { changeReference } from './reference-library.ts';
import {
  listPlatformEmployeeHistoryDirectory,
  readPlatformEmployeeHistory,
  readPlatformEmployeeHistoryRevision,
} from './platform-employee-history.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { changeAdminTenantEmployee } from './tenant-employees.ts';
import { getEmployeeWorkspace } from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'organization AI directory: actual state and shared-only administration',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
      admin: RequestContext;
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const p = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'directory-admin@example.test',
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
      await fixture?.close();
    }, 30000);
    const setup = () => createOrganizationAiDirectoryFixture(fixture.db, admin);
    type Setup = Awaited<ReturnType<typeof setup>>;
    const details = (s: Setup, context = admin) =>
      getOrganizationAiSharedDetails(
        context,
        s.company.organizationId,
        s.owner.actor.id,
        s.custom.id,
      );

    it('filters people, counts and instance pages by actual source version and general/custom kind', async () => {
      const s = await setup();
      const second = await createEmployeeAdministrationFixture(fixture.db, {
        name: '另一个来源模板',
      });
      await second.preview();
      expect((await second.publish()).valid).toBe(true);
      await changeAdminTenantEmployee(admin, s.company.organizationId, {
        workspaceId: s.workspaceId,
        employeeId: second.employeeId,
        revisionId: second.revisionId,
        action: 'assign',
        expectedVersion: null,
      });
      for (const context of s.contexts)
        await getEmployeeWorkspace(context, s.workspaceId);
      const filter = {
        sourceTemplate: s.publication.employeeId,
        kind: 'custom' as const,
      };
      const directory = await listOrganizationAiDirectory(
        admin,
        s.company.organizationId,
        filter,
      );
      expect(directory.totals).toMatchObject({
        people: 1,
        general: 0,
        custom: 1,
        pendingAssignments: 0,
      });
      const instances = await listOrganizationPersonAiInstances(
        admin,
        s.company.organizationId,
        s.owner.actor.id,
        filter,
      );
      expect(instances.instances.map((i) => i.id)).toEqual([s.custom.id]);
      expect(instances.person.counts).toEqual(directory.people[0]!.counts);
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            sourceTemplate: second.employeeId,
          })
        ).totals,
      ).toMatchObject({ people: 3, general: 3, custom: 0 });
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            sourceTemplate: randomUUID(),
          })
        ).totals.people,
      ).toBe(0);
      await fixture.db`update allrice_employee_instances set archived_at=now() where id=${s.custom.id}`;
      expect(
        (
          await listOrganizationAiDirectory(
            admin,
            s.company.organizationId,
            filter,
          )
        ).totals,
      ).toMatchObject({ people: 1, custom: 0, archived: 1 });
      await fixture.db`delete from allrice_employee_version_sources where employee_version_id=${s.general.source.employeeVersionId}`;
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            sourceTemplate: s.publication.employeeId,
          })
        ).totals.people,
      ).toBe(0);
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            sourceTemplate: 'legacy',
          })
        ).totals,
      ).toMatchObject({ people: 3, general: 3, archived: 1 });
      const legacy = await listOrganizationPersonAiInstances(
        admin,
        s.company.organizationId,
        s.owner.actor.id,
        { sourceTemplate: 'legacy' },
      );
      expect(legacy.instances).toHaveLength(2);
      expect(
        legacy.instances.every((i) => i.source.kind === 'tenant_version'),
      ).toBe(true);
    });

    it('reads saved and archived template history without replacing frozen skills or changing assignments', async () => {
      const s = await setup(),
        original = await s.publication.revision();
      const before =
        await fixture.db`select to_jsonb(d) as value from allrice_platform_employee_tenant_assignments d where employee_id=${s.publication.employeeId} order by id`;
      await s.publication.catalog(s.publication.b);
      await fixture.db`update allrice_platform_employees set status='archived' where id=${s.publication.employeeId}`;
      const catalog = await listPlatformEmployeeHistoryDirectory(admin, {
        search: s.publication.definition.name,
      });
      expect(
        catalog.employees.find((e) => e.id === s.publication.employeeId)
          ?.status,
      ).toBe('archived');
      const history = await readPlatformEmployeeHistory(
        admin,
        s.publication.employeeId,
      );
      expect(history.revisions[0]?.id).toBe(s.publication.revisionId);
      const saved = await readPlatformEmployeeHistoryRevision(
        admin,
        s.publication.employeeId,
        s.publication.revisionId,
      );
      expect(saved.definition).toEqual(original.definition);
      expect(saved.runtimeProfile).toEqual(original.runtime_profile);
      expect(
        saved.runtimeProfile?.runtimePackage?.skills[0]?.bundle?.version,
      ).toBe('1.0.0');
      expect(saved.checksum).toBe(original.checksum);
      expect(
        await fixture.db`select to_jsonb(d) as value from allrice_platform_employee_tenant_assignments d where employee_id=${s.publication.employeeId} order by id`,
      ).toEqual(before);
      await expect(
        readPlatformEmployeeHistoryRevision(
          admin,
          randomUUID(),
          s.publication.revisionId,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      for (const read of [
        () => listPlatformEmployeeHistoryDirectory(s.owner),
        () => readPlatformEmployeeHistory(s.owner, s.publication.employeeId),
        () =>
          readPlatformEmployeeHistoryRevision(
            s.owner,
            s.publication.employeeId,
            s.publication.revisionId,
          ),
      ])
        await expect(read()).rejects.toMatchObject({
          code: 'authorization_denied',
        });
    });

    it('paginates historical revisions without duplicates and rejects a revoked administrator session', async () => {
      const s = await setup();
      for (let revision = 2; revision <= 53; revision++)
        await fixture.db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum)
        select ${randomUUID()},employee_id,${revision},'draft',definition,checksum from allrice_platform_employee_revisions where id=${s.publication.revisionId}`;
      const first = await readPlatformEmployeeHistory(
          admin,
          s.publication.employeeId,
        ),
        second = await readPlatformEmployeeHistory(
          admin,
          s.publication.employeeId,
          { before: first.nextBefore },
        );
      expect(first.revisions).toHaveLength(50);
      expect(second.revisions).toHaveLength(3);
      expect(
        new Set([...first.revisions, ...second.revisions].map((r) => r.id))
          .size,
      ).toBe(53);
      expect(first.revisions[0]?.revision).toBe(53);
      expect(second.revisions.at(-1)?.id).toBe(s.publication.revisionId);
      const context = (await authenticateSession(
        (await createSession(admin.actor.id)).token,
      ))!;
      await fixture.db`update allrice_sessions set revoked_at=now() where id=${context.sessionId}`;
      await expect(
        readPlatformEmployeeHistoryRevision(
          context,
          s.publication.employeeId,
          s.publication.revisionId,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });

    it('counts actual instances once and never includes private profiles or source names in directory metadata', async () => {
      const s = await setup();
      await fixture.db`insert into allrice_memberships(organization_id,user_id,role) values(${s.company.organizationId},${s.owner.actor.id},'member') on conflict do nothing`;
      const directory = await listOrganizationAiDirectory(
        admin,
        s.company.organizationId,
      );
      expect(directory.totals).toEqual({
        people: 3,
        general: 3,
        custom: 1,
        inactive: 0,
        archived: 0,
        pendingAssignments: 0,
      });
      const personal = await listOrganizationPersonAiInstances(
        admin,
        s.company.organizationId,
        s.owner.actor.id,
      );
      expect(personal.instances).toHaveLength(2);
      expect(
        personal.instances.find((i) => i.id === s.custom.id),
      ).toMatchObject({
        kind: 'custom',
        state: 'active',
        source: { employeeVersionId: s.custom.source.employeeVersionId },
      });
      expect(JSON.stringify({ directory, personal })).not.toMatch(
        /PRIVATE_|CANDIDATE_/,
      );
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            departmentId: 'unassigned',
          })
        ).totals.people,
      ).toBe(1);
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            search: '研究员',
          })
        ).totals.custom,
      ).toBe(1);
    });

    it('reads current shared publications without tenant membership or personal/candidate disclosure', async () => {
      const s = await setup();
      expect(
        await fixture.db`select id from allrice_memberships where organization_id=${s.company.organizationId} and user_id=${admin.actor.id}`,
      ).toHaveLength(0);
      const result = await details(s);
      expect(result.visibility).toBe('shared_only');
      expect(result.experienceSummary?.counts).toEqual({
        pendingSources: 0,
        awaitingValidation: 0,
        adoptedTotal: 0,
      });
      expect(Object.keys(result.experienceSummary!).sort()).toEqual([
        'counts',
        'enabled',
        'policy',
        'schedule',
      ]);
      expect(JSON.stringify(result.experienceSummary)).not.toMatch(
        /sourceIds|sourceExcerpt|skillDependencies|PRIVATE_|CANDIDATE_/,
      );
      const text = JSON.stringify(result);
      expect(text).toContain('公司共享场景');
      expect(text).toContain('科研共享场景');
      expect(text).not.toMatch(/PRIVATE_|CANDIDATE_|财务共享场景/);
      expect(result.details.profile.expressionStyle).toBeUndefined();
      expect(result.details.profile.personalFields).toEqual([]);
      expect(result.details.profile.canMaintainPersonal).toBe(false);
      expect(result.details.content.layers).toHaveLength(2);
      expect(
        result.details.content.layers.every(
          (l) =>
            l.candidate === null &&
            l.validation === null &&
            !l.access.canMaintain,
        ),
      ).toBe(true);
      expect(
        result.details.content.sources.every((source) => !source.canMaintain),
      ).toBe(true);
      const owner = await getEmployeeDetails(s.owner, s.custom.id);
      expect(owner.profile.name).toBe('PRIVATE_NAME_SENTINEL');
      expect(JSON.stringify(owner)).toContain('PRIVATE_SCENE_SENTINEL');
      await expect(
        getEmployeeDetails(
          {
            ...admin,
            organizationId: s.company.organizationId,
            workspaceId: s.workspaceId,
          },
          s.custom.id,
        ),
      ).rejects.toBeDefined();
    });

    it('updates the department view through the existing person editor without changing private content', async () => {
      const s = await setup();
      const person = (
        await listOrganizationPeople(admin, s.company.organizationId)
      ).people.find((p) => p.userId === s.owner.actor.id)!;
      await updateOrganizationPerson(
        admin,
        s.company.organizationId,
        person.userId,
        {
          username: person.username,
          displayName: person.displayName,
          jobTitle: person.jobTitle,
          responsibilities: person.responsibilities,
          expectedVersion: person.version,
          departmentId: s.finance.id,
        },
      );
      const result = JSON.stringify(await details(s));
      expect(result).toContain('财务共享场景');
      expect(result).not.toContain('科研共享场景');
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            departmentId: s.research.id,
          })
        ).totals.people,
      ).toBe(0);
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            departmentId: s.finance.id,
          })
        ).totals.people,
      ).toBe(2);
      expect(
        (await getEmployeeDetails(s.owner, s.custom.id)).profile.name,
      ).toBe('PRIVATE_NAME_SENTINEL');
    });

    it('requires an active exact shared reference, preserves its version and denies private/unreferenced files', async () => {
      const s = await setup();
      const read = (revisionId: string) =>
        getOrganizationAiReferenceFile(
          admin,
          s.company.organizationId,
          s.owner.actor.id,
          s.custom.id,
          revisionId,
        );
      expect((await read(s.sharedFile.revisionId)).object.id).toBe(
        s.sharedFile.object.id,
      );
      await expect(read(s.privateFile.revisionId)).rejects.toMatchObject({
        code: 'not_found',
      });
      const second = await s.upload(
        'company',
        '共享资料-v2.txt',
        s.sharedFile.sourceId,
      );
      await expect(read(second.revisionId)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect((await read(s.sharedFile.revisionId)).fileName).toBe(
        '共享资料-v1.txt',
      );
      await changeReference(s.owner, s.sharedFile.sourceId, {
        workspaceId: s.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 2,
        action: 'archive',
      });
      await expect(read(s.sharedFile.revisionId)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(JSON.stringify(await details(s))).not.toContain('共享资料-v1.txt');
    });

    it('rejects ordinary accounts, foreign lineage and revoked administrator sessions', async () => {
      const s = await setup();
      await expect(details(s, s.owner)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        getOrganizationAiSharedDetails(
          admin,
          s.company.organizationId,
          s.people[1]!.userId,
          s.custom.id,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        getOrganizationAiSharedDetails(
          admin,
          randomUUID(),
          s.owner.actor.id,
          s.custom.id,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      const session = (await authenticateSession(
        (await createSession(admin.actor.id)).token,
      ))!;
      await fixture.db`update allrice_sessions set revoked_at=now() where id=${session.sessionId}`;
      await expect(details(s, session)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        listOrganizationAiDirectory(session, s.company.organizationId),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });

    it('keeps archived, withdrawn and inactive histories separate from current usable counts', async () => {
      const s = await setup();
      await fixture.db`update allrice_employee_instances set archived_at=now() where id=${s.custom.id}`;
      expect(
        (await listOrganizationAiDirectory(admin, s.company.organizationId))
          .totals,
      ).toMatchObject({ general: 3, custom: 0, archived: 1 });
      await fixture.db`update allrice_employee_assignments set active=false where id=${s.general.assignmentId}`;
      expect(
        (
          await listOrganizationPersonAiInstances(
            admin,
            s.company.organizationId,
            s.owner.actor.id,
          )
        ).instances
          .map((i) => i.state)
          .sort(),
      ).toEqual(['archived', 'assignment_unavailable']);
      await expect(details(s)).rejects.toMatchObject({ code: 'not_found' });
      await fixture.db`update allrice_users set status='disabled' where id=${s.people[1]!.userId}`;
      const totals = (
        await listOrganizationAiDirectory(admin, s.company.organizationId)
      ).totals;
      expect(totals).toMatchObject({
        people: 3,
        general: 1,
        custom: 0,
        inactive: 2,
        archived: 1,
      });
    });

    it('reports pending general instances without creating them during a GET', async () => {
      const s = await setup();
      const userId = randomUUID(),
        assignmentId = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${userId},${userId + '@example.test'},'尚无实例','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${s.company.organizationId},${s.workspaceId},${userId},'member')`;
      await fixture.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,user_id,employee_id,employee_version_id)
      select ${assignmentId},organization_id,workspace_id,${userId},employee_id,employee_version_id from allrice_employee_assignments where id=${s.general.assignmentId}`;
      const totals = (
        await listOrganizationAiDirectory(admin, s.company.organizationId)
      ).totals;
      expect(totals).toMatchObject({ general: 3, pendingAssignments: 1 });
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            sourceTemplate: s.publication.employeeId,
            kind: 'general',
          })
        ).totals,
      ).toMatchObject({
        people: 4,
        general: 3,
        custom: 0,
        pendingAssignments: 1,
      });
      expect(
        (
          await listOrganizationAiDirectory(admin, s.company.organizationId, {
            sourceTemplate: s.publication.employeeId,
            kind: 'custom',
          })
        ).totals,
      ).toMatchObject({
        people: 1,
        general: 0,
        custom: 1,
        pendingAssignments: 0,
      });
      expect(
        (
          await listOrganizationPersonAiInstances(
            admin,
            s.company.organizationId,
            userId,
          )
        ).instances,
      ).toEqual([]);
      expect(
        await fixture.db`select id from allrice_employee_instances where assignment_id=${assignmentId}`,
      ).toHaveLength(0);
    });

    it('paginates people while totals cover the full filter and does not invent missing assignments', async () => {
      const s = await setup();
      for (let n = 0; n < 51; n++) {
        const id = randomUUID();
        await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${id},${id + '@example.test'},'分页员工','not-login')`;
        await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${s.company.organizationId},${s.workspaceId},${id},'member')`;
      }
      const first = await listOrganizationAiDirectory(
        admin,
        s.company.organizationId,
      );
      const next = await listOrganizationAiDirectory(
        admin,
        s.company.organizationId,
        { after: first.nextCursor! },
      );
      expect(first.people).toHaveLength(50);
      expect(next.people).toHaveLength(4);
      expect(first.totals.people).toBe(54);
      expect(next.totals).toEqual(first.totals);
      expect(
        new Set([...first.people, ...next.people].map((p) => p.userId)).size,
      ).toBe(54);
    });
  },
);
