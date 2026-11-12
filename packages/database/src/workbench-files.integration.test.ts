import { randomUUID } from 'node:crypto';
import { allocateWorkbenchFileName } from './workbench-file-name.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, WorkbenchFileSharing } from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
  runtimeTaskFixture,
} from './runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from './identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from './organization-administration.ts';
import { createOrganizationDepartment } from './organization-departments.ts';
import {
  captureWorkbenchFileReference,
  readWorkbenchFile,
  readWorkbenchFileCatalog,
  readWorkbenchDeliverables,
  listWorkbenchFileVersions,
  updateWorkbenchFile,
  uploadWorkbenchFile,
  setWorkbenchFileFavorite,
} from './workbench-files.ts';
import {
  getReferenceFile,
  prepareReferenceUpload,
  listReferenceRevisions,
} from './reference-library.ts';
import { readReferenceSelection } from './reference-runtime.ts';
import { listWorkspaceFiles } from './workspace/service.ts';
import {
  getStoredFile,
  createStorageMetadata,
  markStorageReady,
  saveStorageGrant,
  resolveStorageGrant,
} from './data.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'unified workbench files use live authority without sharing their source chat',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let platform: RequestContext;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control plane',
        email: 'workbench-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      platform = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30000);
    async function setup() {
      const company = await createManagedOrganization(platform, {
        name: 'Files ' + randomUUID(),
      });
      const departments = await Promise.all(
        ['内容', '运营', '财务'].map((name) =>
          createOrganizationDepartment(platform, company.organizationId, {
            name,
            requestId: randomUUID(),
          }),
        ),
      );
      const { created } = await importOrganizationPeople(
        platform,
        company.organizationId,
        {
          people: [
            {
              username: 'file-' + randomUUID(),
              displayName: 'Owner',
              departmentId: departments[0]!.department.id,
              contentMaintenanceLevel: 'company',
            },
            {
              username: 'file-' + randomUUID(),
              displayName: 'Company maintainer',
              departmentId: departments[2]!.department.id,
              contentMaintenanceLevel: 'company',
            },
            {
              username: 'file-' + randomUUID(),
              displayName: 'Reader A',
              departmentId: departments[0]!.department.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: 'file-' + randomUUID(),
              displayName: 'Reader B',
              departmentId: departments[1]!.department.id,
              contentMaintenanceLevel: 'department',
            },
            {
              username: 'file-' + randomUUID(),
              displayName: 'Excluded',
              departmentId: departments[2]!.department.id,
              contentMaintenanceLevel: 'personal',
            },
          ],
        },
      );
      const people = await Promise.all(
        created.map(async (person) => ({
          ...(await authenticateSession(
            (await createSession(person.userId)).token,
          ))!,
          workspaceId: company.defaultWorkspaceId,
        })),
      );
      return {
        owner: people[0]!,
        maintainer: people[1]!,
        a: people[2]!,
        b: people[3]!,
        excluded: people[4]!,
        departments: departments.map((d) => d.department.id),
        company,
      };
    }
    function uploadInput(
      context: RequestContext,
      sharing?: WorkbenchFileSharing,
    ) {
      return {
        workspaceId: context.workspaceId!,
        requestId: randomUUID(),
        fileName: '收入口径.txt',
        mediaType: 'text/plain',
        contentBase64:
          Buffer.from('按已经确认的回款统计收入。').toString('base64'),
        ...(sharing ? { sharing } : {}),
      };
    }
    const storage = () => runtimeFixtureStorage(fixture.db);
    it('lists my actual uploads and every business object, filters before paging, and keeps cursor authority private', async () => {
      const synthetic = await runtimeTaskFixture(fixture.db);
      const owner = {
        ...(await authenticateSession(
          (await createSession(synthetic.context.actor.id)).token,
        ))!,
        workspaceId: synthetic.context.workspaceId!,
      };
      await fixture.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level)
        values (${owner.organizationId},${owner.actor.id},'Owner','company')`;
      const [session] = await fixture.db<
        { employee_assignment_id: string }[]
      >`select employee_assignment_id from allrice_chat_sessions where id=${synthetic.task.chatSessionId}`;
      const first = await synthetic.artifact(
        synthetic.task.runId,
        'First complete file',
      );
      const second = await synthetic.artifact(
        synthetic.task.runId,
        'Second complete file',
      );
      const [v1] = await fixture.db<
        { object_id: string; series_id: string }[]
      >`select object_id,series_id from allrice_deliverable_versions where id=${first.artifactId}`;
      await fixture.db`update allrice_deliverable_versions set series_id=${v1!.series_id},version=2,parent_version_id=${first.artifactId} where id=${second.artifactId}`;
      await fixture.db`update allrice_storage_objects set created_at='2020-01-01T00:00:00Z' where id in (select object_id from allrice_deliverable_versions where id in (${first.artifactId},${second.artifactId}))`;
      const uploads: string[] = [];
      for (let n = 0; n < 52; n++) {
        const file = await uploadWorkbenchFile(
          owner,
          { ...uploadInput(owner), fileName: `本人上传-${n}.txt` },
          storage(),
        );
        uploads.push(file.objectId);
      }
      // A genuine historical direct upload need not have any conversation.
      const direct = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
        category: 'upload',
        objectId: uploads[0],
      });
      expect(direct.files[0]).toMatchObject({
        origin: 'user-upload',
        sources: [],
        category: 'upload',
        ownedByMe: true,
      });
      // Tied timestamps exercise the object-ID tie breaker over multiple pages.
      await fixture.db`update allrice_storage_objects set created_at='2026-01-01T00:00:00Z' where id in ${fixture.db(uploads)}`;
      const page = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
      });
      expect(page.files).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      expect(page.employees).toEqual([
        { id: session!.employee_assignment_id, name: 'P25 Fixture' },
      ]);
      const tail = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
        cursor: page.nextCursor,
      });
      expect(tail.files).toHaveLength(4);
      expect(tail.nextCursor).toBeNull();
      expect(
        new Set([...page.files, ...tail.files].map((file) => file.objectId))
          .size,
      ).toBe(54);
      const business = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
        employeeInstanceId: session!.employee_assignment_id,
        category: 'artifact',
      });
      expect(business.files).toHaveLength(2);
      expect(business.files.every((file) => file.favorite === false)).toBe(
        true,
      );
      expect(new Set(business.files.map((file) => file.artifact!.id))).toEqual(
        new Set([first.artifactId, second.artifactId]),
      );
      expect(business.files[0]).toMatchObject({
        origin: 'business-deliverable',
        sources: [
          {
            sessionId: synthetic.task.chatSessionId,
            sessionTitle: 'Synthetic runtime session',
            employeeInstanceId: session!.employee_assignment_id,
            employeeName: 'P25 Fixture',
          },
        ],
      });
      expect(
        (
          await readWorkbenchDeliverables(owner, {
            workspaceId: owner.workspaceId,
            employeeInstanceId: randomUUID(),
          })
        ).files,
      ).toEqual([]);
      expect(
        (
          await readWorkbenchDeliverables(owner, {
            workspaceId: owner.workspaceId,
            query: '本人上传-51',
          })
        ).files.map((file) => file.objectId),
      ).toEqual([uploads[51]]);
      // A single upload may genuinely belong to work with two employees.
      const employeeId = randomUUID(),
        versionId = randomUUID(),
        assignmentId = randomUUID(),
        sessionId = randomUUID();
      await fixture.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
        values(${employeeId},${owner.organizationId},${owner.workspaceId},${'second-' + employeeId},'Second Fixture')`;
      await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        select ${versionId},organization_id,workspace_id,${employeeId},1,'Second Fixture',model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot
        from allrice_employee_versions where id=(select employee_version_id from allrice_chat_sessions where id=${synthetic.task.chatSessionId})`;
      await fixture.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
        values(${assignmentId},${owner.organizationId},${owner.workspaceId},${employeeId},${versionId},${owner.actor.id},false)`;
      await fixture.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${sessionId},${owner.organizationId},${owner.workspaceId},${owner.actor.id},'Second employee work',${assignmentId},${versionId})`;
      const { linkFileToSession } = await import('./workspace/service.ts');
      for (const source of [sessionId, synthetic.task.chatSessionId])
        await linkFileToSession({
          context: owner,
          workspaceId: owner.workspaceId,
          sessionId: source,
          objectId: uploads[0]!,
          fileName: '跨员工上传.txt',
        });
      for (const employeeInstanceId of [
        assignmentId,
        session!.employee_assignment_id,
      ]) {
        const employeeFiles = await readWorkbenchDeliverables(owner, {
          workspaceId: owner.workspaceId,
          employeeInstanceId,
          category: 'upload',
        });
        expect(employeeFiles.files.map((file) => file.objectId)).toEqual([
          uploads[0],
        ]);
        expect(
          new Set(
            employeeFiles.files[0]!.sources.map(
              (source) => source.employeeInstanceId,
            ),
          ),
        ).toEqual(new Set([assignmentId, session!.employee_assignment_id]));
        expect(employeeFiles.employees).toContainEqual({
          id: assignmentId,
          name: 'Second Fixture',
        });
      }
      // Its existing shared-directory consumer still collapses a series.
      const acrossEmployees = await fixture.db.begin(async (tx) => {
        await lockWorkspaceStorageQuota(
          tx,
          owner.organizationId,
          owner.workspaceId,
        );
        const names = [];
        for (const requested of ['本人上传-0.txt', '本人上传-51.txt'])
          names.push(
            await allocateWorkbenchFileName(
              tx,
              {
                organizationId: owner.organizationId,
                workspaceId: owner.workspaceId,
                ownerId: owner.actor.id,
              },
              randomUUID(),
              requested,
            ),
          );
        return names;
      });
      expect(acrossEmployees).toEqual([
        '本人上传-0（2）.txt',
        '本人上传-51（2）.txt',
      ]);
      const legacy = await readWorkbenchFileCatalog(owner, {
        workspaceId: owner.workspaceId,
      });
      expect(legacy.files.filter((file) => file.artifact)).toHaveLength(1);
      // Favorites are object preferences, never series/name aliases. Seed the
      // larger relation set only to exercise filtering before the 50-row limit.
      await fixture.db`insert into allrice_workbench_file_favorites(organization_id,workspace_id,user_id,object_id)
        select organization_id,workspace_id,owner_id,id from allrice_storage_objects
        where id in ${fixture.db([...uploads, ...business.files.map((file) => file.objectId)])}`;
      const favorites = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
        category: 'favorite',
        employeeInstanceId: randomUUID(),
      });
      expect(favorites.files).toHaveLength(50);
      expect(favorites.files.every((file) => file.favorite)).toBe(true);
      const favoriteTail = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
        category: 'favorite',
        employeeInstanceId: assignmentId,
        cursor: favorites.nextCursor,
      });
      expect(
        new Set(
          [...favorites.files, ...favoriteTail.files].map(
            (file) => file.objectId,
          ),
        ).size,
      ).toBe(54);
      expect(favoriteTail.files.filter((file) => file.artifact)).toHaveLength(
        2,
      );
      expect(
        (
          await readWorkbenchDeliverables(owner, {
            workspaceId: owner.workspaceId,
            category: 'favorite',
            query: '本人上传-51',
            employeeInstanceId: randomUUID(),
          })
        ).files.map((file) => file.objectId),
      ).toEqual([uploads[51]]);
      await Promise.all(
        [true, true].map((favorite) =>
          setWorkbenchFileFavorite(owner, uploads[0]!, { favorite }),
        ),
      );
      expect(
        await fixture.db`select 1 from allrice_workbench_file_favorites where object_id=${uploads[0]!}`,
      ).toHaveLength(1);
      await setWorkbenchFileFavorite(owner, uploads[0]!, { favorite: false });
      await setWorkbenchFileFavorite(owner, uploads[0]!, { favorite: false });
      expect(
        (
          await readWorkbenchDeliverables(owner, {
            workspaceId: owner.workspaceId,
            objectId: uploads[0],
          })
        ).files[0]!.favorite,
      ).toBe(false);
      const other = await runtimeTaskFixture(fixture.db);
      await expect(
        readWorkbenchDeliverables(other.context, {
          workspaceId: owner.workspaceId,
          objectId: uploads[0],
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        readWorkbenchDeliverables(owner, {
          workspaceId: owner.workspaceId,
          cursor: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    }, 30000);
    it('favorites use the current owner and live authority, never shared maintenance or a stored preference as access', async () => {
      const t = await setup();
      // Create a genuinely authorized shared original, then exercise favorite
      // writes after its owner returns to personal maintenance authority.
      await fixture.db`update allrice_organization_people set content_maintenance_level='company' where organization_id=${t.a.organizationId} and user_id=${t.a.actor.id}`;
      const file = await uploadWorkbenchFile(
        t.a,
        uploadInput(t.a, { scope: 'company', departmentIds: [] }),
        storage(),
      );
      const duplicate = await uploadWorkbenchFile(
        t.a,
        uploadInput(t.a),
        storage(),
      );
      await fixture.db`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${t.a.organizationId} and user_id=${t.a.actor.id}`;
      const [stored, duplicateStored] = await Promise.all(
        [file, duplicate].map(({ objectId }) =>
          readWorkbenchFile(t.a, objectId),
        ),
      );
      if (!stored || !duplicateStored)
        throw Error('Both uploaded originals must remain readable.');
      expect(stored.row.file_name).toBe(duplicateStored.row.file_name);
      const names = await fixture.db.begin(async (tx) => {
        await lockWorkspaceStorageQuota(
          tx,
          t.a.organizationId,
          t.a.workspaceId!,
        );
        return Promise.all(
          [t.a, t.b].map((current) =>
            allocateWorkbenchFileName(
              tx,
              {
                organizationId: current.organizationId,
                workspaceId: current.workspaceId!,
                ownerId: current.actor.id,
              },
              randomUUID(),
              stored.row.file_name,
            ),
          ),
        );
      });
      expect(names).toEqual(['收入口径（2）.txt', '收入口径.txt']);
      await setWorkbenchFileFavorite(t.a, file.objectId, { favorite: true });
      await setWorkbenchFileFavorite(t.a, duplicate.objectId, {
        favorite: true,
      });
      expect(
        (
          await readWorkbenchDeliverables(t.a, {
            workspaceId: t.a.workspaceId,
            category: 'favorite',
          })
        ).files
          .map((row) => row.objectId)
          .sort(),
      ).toEqual([file.objectId, duplicate.objectId].sort());
      expect(
        (await readWorkbenchFile(t.maintainer, file.objectId)).canMaintain,
      ).toBe(true);
      const foreign = await setup();
      for (const current of [
        t.maintainer,
        t.b,
        foreign.owner,
        { ...t.a, workspaceId: randomUUID() },
      ]) {
        await expect(
          setWorkbenchFileFavorite(current, file.objectId, { favorite: true }),
        ).rejects.toThrow();
        await expect(
          setWorkbenchFileFavorite(current, file.objectId, { favorite: false }),
        ).rejects.toThrow();
      }
      expect(
        await fixture.db`select user_id from allrice_workbench_file_favorites where object_id=${file.objectId}`,
      ).toEqual([{ user_id: t.a.actor.id }]);
      // Even a residual relation does not authorize a nonowner or expose a name.
      await fixture.db`insert into allrice_workbench_file_favorites(organization_id,workspace_id,user_id,object_id)
        values(${t.a.organizationId},${t.a.workspaceId},${t.maintainer.actor.id},${file.objectId})`;
      expect(
        (
          await readWorkbenchDeliverables(t.maintainer, {
            workspaceId: t.maintainer.workspaceId,
            category: 'favorite',
          })
        ).files,
      ).toEqual([]);
      await expect(
        readWorkbenchDeliverables(t.maintainer, {
          workspaceId: t.maintainer.workspaceId,
          objectId: file.objectId,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    }, 30000);
    it.each(['membership', 'revoked-session', 'expired-session'] as const)(
      'rechecks %s before even removing a personal favorite',
      async (reason) => {
        const t = await setup(),
          file = await uploadWorkbenchFile(t.a, uploadInput(t.a), storage());
        await setWorkbenchFileFavorite(t.a, file.objectId, { favorite: true });
        if (reason === 'membership')
          await fixture.db`update allrice_memberships set active=false where user_id=${t.a.actor.id}`;
        if (reason === 'revoked-session')
          await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${t.a.sessionId!}`;
        if (reason === 'expired-session')
          await fixture.db`update allrice_sessions set expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day' where id=${t.a.sessionId!}`;
        await expect(
          setWorkbenchFileFavorite(t.a, file.objectId, { favorite: false }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(
          await fixture.db`select user_id from allrice_workbench_file_favorites where object_id=${file.objectId}`,
        ).toEqual([{ user_id: t.a.actor.id }]);
        await expect(
          readWorkbenchDeliverables(t.a, {
            workspaceId: t.a.workspaceId,
            category: 'favorite',
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      },
      30000,
    );
    it('never treats shared maintenance access or worker intermediate bytes as my uploads', async () => {
      const t = await setup();
      const shared = await uploadWorkbenchFile(
        t.owner,
        uploadInput(t.owner, { scope: 'company', departmentIds: [] }),
        storage(),
      );
      expect(
        (await readWorkbenchFile(t.maintainer, shared.objectId)).canMaintain,
      ).toBe(true);
      const directory = await readWorkbenchDeliverables(t.maintainer, {
        workspaceId: t.maintainer.workspaceId,
      });
      expect(directory.files).toEqual([]);
      expect(directory.employees).toEqual([]);
      await expect(
        readWorkbenchDeliverables(t.maintainer, {
          workspaceId: t.maintainer.workspaceId,
          objectId: shared.objectId,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        readWorkbenchDeliverables(t.maintainer, {
          workspaceId: t.maintainer.workspaceId,
          cursor: shared.objectId,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const synthetic = await runtimeTaskFixture(fixture.db);
      const owner = {
        ...(await authenticateSession(
          (await createSession(synthetic.context.actor.id)).token,
        ))!,
        workspaceId: synthetic.context.workspaceId!,
      };
      await fixture.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level) values (${owner.organizationId},${owner.actor.id},'Owner','personal')`;
      await synthetic.artifact(
        synthetic.task.runId,
        'Command output',
        undefined,
        {
          kind: 'command_output',
        },
      );
      await synthetic.artifact(
        synthetic.task.runId,
        'Project snapshot',
        undefined,
        {
          provenanceKind: 'project_snapshot',
        },
      );
      const loose = randomUUID();
      await createStorageMetadata(owner, {
        id: loose,
        workspaceId: owner.workspaceId,
        category: 'uploads',
        mediaType: 'text/plain',
        sizeBytes: 1,
        checksum: `sha256:${'a'.repeat(64)}`,
        visibility: 'private',
        retentionUntil: null,
        immutable: true,
      });
      await markStorageReady(owner, loose);
      expect(
        (
          await readWorkbenchDeliverables(owner, {
            workspaceId: owner.workspaceId,
          })
        ).files,
      ).toEqual([]);
      await expect(
        readWorkbenchDeliverables(owner, {
          workspaceId: owner.workspaceId,
          objectId: loose,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const uploaded = await uploadWorkbenchFile(
        owner,
        uploadInput(owner),
        storage(),
      );
      const { linkFileToSession } = await import('./workspace/service.ts');
      await linkFileToSession({
        context: owner,
        workspaceId: owner.workspaceId,
        sessionId: synthetic.task.chatSessionId,
        objectId: uploaded.objectId,
        fileName: '对话上传.txt',
      });
      const own = await readWorkbenchDeliverables(owner, {
        workspaceId: owner.workspaceId,
      });
      expect(own.files).toHaveLength(1);
      expect(own.files[0]).toMatchObject({
        objectId: uploaded.objectId,
        origin: 'user-upload',
        sources: [{ sessionId: synthetic.task.chatSessionId }],
      });
      // A retained reference is not a second upload, even when owned by me.
      await captureWorkbenchFileReference(
        owner,
        owner.workspaceId,
        uploaded.objectId,
        randomUUID(),
        storage(),
      );
      expect(
        (
          await readWorkbenchDeliverables(owner, {
            workspaceId: owner.workspaceId,
          })
        ).files.map((file) => file.objectId),
      ).toEqual([uploaded.objectId]);
    }, 30000);
    function change(
      context: RequestContext,
      id: string,
      expectedRevision: number,
      extra: Record<string, unknown>,
      requestId = randomUUID(),
    ) {
      return updateWorkbenchFile(
        context,
        id,
        {
          workspaceId: context.workspaceId,
          requestId,
          expectedRevision,
          ...extra,
        },
        storage(),
      );
    }
    it('defaults uploads to private; a company role cannot discover, preview or privatize others files', async () => {
      const t = await setup(),
        input = uploadInput(t.owner),
        file = await uploadWorkbenchFile(t.owner, input, storage());
      expect(
        (await listWorkspaceFiles(t.owner, t.owner.workspaceId!)).find(
          (item) => item.id === file.objectId,
        )?.fileName,
      ).toBe(input.fileName);
      expect(
        (await readWorkbenchFile(t.owner, file.objectId)).policy?.scope,
      ).toBe('personal');
      await expect(
        readWorkbenchFile(t.maintainer, file.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (
          await readWorkbenchFileCatalog(t.maintainer, {
            workspaceId: t.owner.workspaceId!,
          })
        ).files,
      ).toEqual([]);
      await expect(
        change(t.maintainer, file.objectId, 1, {
          sharing: { scope: 'personal', departmentIds: [] },
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (await uploadWorkbenchFile(t.owner, input, storage())).objectId,
      ).toBe(file.objectId);
      await expect(
        uploadWorkbenchFile(
          t.owner,
          { ...input, fileName: '不同文件.txt' },
          storage(),
        ),
      ).rejects.toMatchObject({ code: 'request_conflict' });
    });
    it('shares with multiple selected departments, keeps ownership in My files, and denies unrelated departments', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      await change(t.owner, file.objectId, 1, {
        sharing: {
          scope: 'departments',
          departmentIds: t.departments.slice(0, 2),
        },
      });
      for (const reader of [t.a, t.b, t.maintainer])
        expect((await readWorkbenchFile(reader, file.objectId)).object.id).toBe(
          file.objectId,
        );
      await expect(
        readWorkbenchFile(t.excluded, file.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
      const catalog = await readWorkbenchFileCatalog(t.owner, {
        workspaceId: t.owner.workspaceId!,
        scope: 'my',
      });
      expect(catalog.files.map((f) => f.objectId)).toContain(file.objectId);
      expect(catalog.files[0]?.sharing.departmentNames).toHaveLength(2);
      await expect(
        change(t.b, file.objectId, 2, {
          sharing: { scope: 'departments', departmentIds: [t.departments[1]!] },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await change(t.owner, file.objectId, 2, {
        sharing: { scope: 'company', departmentIds: [] },
      });
      expect(
        (await readWorkbenchFile(t.excluded, file.objectId)).canMaintain,
      ).toBe(false);
      await expect(
        change(t.maintainer, file.objectId, 3, {
          sharing: { scope: 'personal', departmentIds: [] },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('uses compare-and-swap and exact request receipts for concurrent sharing changes', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      const requestId = randomUUID(),
        input = { sharing: { scope: 'company', departmentIds: [] } };
      expect(
        (await change(t.owner, file.objectId, 1, input, requestId)).revision,
      ).toBe(2);
      expect(
        (await change(t.owner, file.objectId, 1, input, requestId)).revision,
      ).toBe(2);
      await expect(
        change(
          t.owner,
          file.objectId,
          1,
          { sharing: { scope: 'personal', departmentIds: [] } },
          requestId,
        ),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      const attempts = await Promise.allSettled([
        change(t.owner, file.objectId, 2, {
          sharing: { scope: 'personal', departmentIds: [] },
        }),
        change(t.owner, file.objectId, 2, {
          sharing: { scope: 'departments', departmentIds: [t.departments[0]!] },
        }),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        attempts
          .filter((r) => r.status === 'rejected')
          .map((r) => (r.status === 'rejected' ? r.reason.code : null)),
      ).toEqual(['version_conflict']);
    });
    it('allows a read-only recipient to create a fixed task reference, then revokes that copy with original file permissions', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner, { scope: 'company', departmentIds: [] }),
          storage(),
        );
      const requestId = randomUUID();
      const ref = await captureWorkbenchFileReference(
        t.a,
        t.a.workspaceId!,
        file.objectId,
        requestId,
        storage(),
      );
      expect(ref.ownership).toMatchObject({
        scope: 'personal',
        ownerId: t.owner.actor.id,
      });
      const { getContentAccess } = await import('./content-maintenance.ts');
      expect(
        (await getContentAccess(t.a, ref.ownership, fixture.db)).canRead,
      ).toBe(false);
      expect(
        (
          await captureWorkbenchFileReference(
            t.a,
            t.a.workspaceId!,
            file.objectId,
            requestId,
            storage(),
          )
        ).revisionId,
      ).toBe(ref.revisionId);
      const bytes = await getReferenceFile(
        t.a,
        t.a.workspaceId!,
        ref.revisionId,
      );
      expect(bytes.object.id).not.toBe(file.objectId);
      expect(await new Response(await storage().get(bytes.object)).text()).toBe(
        '按已经确认的回款统计收入。',
      );
      expect(
        (await listReferenceRevisions(t.a, t.a.workspaceId!)).some(
          (r) => r.sourceId === ref.sourceId,
        ),
      ).toBe(false);
      await fixture.db`update allrice_knowledge_processing set state='ready' where revision_id=${ref.revisionId}`;
      expect(
        (
          await fixture.db.begin((tx) =>
            readReferenceSelection(t.a, ref.revisionId, tx, true),
          )
        ).selection.revisionId,
      ).toBe(ref.revisionId);
      await change(t.owner, file.objectId, 1, {
        sharing: { scope: 'personal', departmentIds: [] },
      });
      await expect(getStoredFile(t.a, file.objectId)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        getReferenceFile(t.a, t.a.workspaceId!, ref.revisionId),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        fixture.db.begin((tx) =>
          readReferenceSelection(t.a, ref.revisionId, tx, true),
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      expect(await new Response(await storage().get(bytes.object)).text()).toBe(
        '按已经确认的回款统计收入。',
      );
    });
    it('never turns a retained copy into an independently editable file or source, even for a company maintainer', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner, { scope: 'company', departmentIds: [] }),
          storage(),
        );
      const reference = await captureWorkbenchFileReference(
        t.maintainer,
        t.maintainer.workspaceId!,
        file.objectId,
        randomUUID(),
        storage(),
      );
      const copy = await getReferenceFile(
        t.maintainer,
        t.maintainer.workspaceId!,
        reference.revisionId,
      );
      await expect(
        readWorkbenchFile(t.maintainer, copy.object.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        change(t.maintainer, copy.object.id, 0, {
          sharing: { scope: 'personal', departmentIds: [] },
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        prepareReferenceUpload(t.owner, {
          workspaceId: t.owner.workspaceId,
          requestId: randomUUID(),
          sourceId: reference.sourceId,
          expectedRevision: 1,
          scope: 'personal',
          fileName: '替换的内容.txt',
          mediaType: 'text/plain',
          contentBase64: Buffer.from('different bytes').toString('base64'),
        }),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      expect(
        (await readWorkbenchFile(t.maintainer, file.objectId)).canMaintain,
      ).toBe(true);
    });
    it('revokes prior signed URLs and rechecks membership for newly issued grants', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner, { scope: 'company', departmentIds: [] }),
          storage(),
        );
      const grant = {
        objectId: file.objectId,
        subjectId: t.a.actor.id,
        operation: 'read' as const,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: randomUUID(),
      };
      await saveStorageGrant(t.a, grant);
      expect((await resolveStorageGrant(grant)).object.id).toBe(file.objectId);
      await change(t.owner, file.objectId, 1, {
        sharing: { scope: 'personal', departmentIds: [] },
      });
      await expect(resolveStorageGrant(grant)).rejects.toMatchObject({
        code: 'grant_invalid',
      });
      await change(t.owner, file.objectId, 2, {
        sharing: { scope: 'company', departmentIds: [] },
      });
      const next = { ...grant, nonce: randomUUID() };
      await saveStorageGrant(t.a, next);
      await fixture.db`update allrice_memberships set active=false where user_id=${t.a.actor.id}`;
      await expect(resolveStorageGrant(next)).rejects.toMatchObject({
        code: 'grant_invalid',
      });
    });
    it('holds no outer transaction during snapshot IO and rejects authority withdrawn before reservation', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      const original = storage();
      const delayed = new Proxy(original, {
        get(target, property) {
          if (property === 'get')
            return async (...args: Parameters<typeof original.get>) => {
              entered();
              await gate;
              return original.get(...args);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const saving = updateWorkbenchFile(
        t.owner,
        file.objectId,
        {
          workspaceId: t.owner.workspaceId,
          requestId: randomUUID(),
          expectedRevision: 1,
          isReference: true,
        },
        delayed,
      );
      await started;
      try {
        await fixture.db`update allrice_memberships set active=false where user_id=${t.owner.actor.id}`;
      } finally {
        release();
      }
      await expect(saving).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      const [policy] =
        await fixture.db`select revision,reference_enabled from allrice_workbench_file_policies where object_id=${file.objectId}`;
      expect(policy).toMatchObject({ revision: 1, reference_enabled: false });
    });
    it('shares a deliverable series without exposing its private chat and retains exact old reference bytes across replacement', async () => {
      const synthetic = await runtimeTaskFixture(fixture.db),
        owner = {
          ...(await authenticateSession(
            (await createSession(synthetic.context.actor.id)).token,
          ))!,
          workspaceId: synthetic.context.workspaceId!,
        };
      await fixture.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level)
      values (${owner.organizationId},${owner.actor.id},'Owner','company')`;
      const readerId = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values (${readerId},${readerId + '@example.test'},'Reader','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values (${owner.organizationId},${owner.workspaceId},${readerId},'member')`;
      const reader = {
        ...(await authenticateSession((await createSession(readerId)).token))!,
        workspaceId: owner.workspaceId,
      };
      const files = [];
      for (const text of [
        'Version one original bytes',
        'Version two changed bytes',
      ]) {
        const bytes = Buffer.from(text),
          id = randomUUID();
        const { createHash } = await import('node:crypto');
        const prepared = await createStorageMetadata(owner, {
          id,
          workspaceId: owner.workspaceId,
          category: 'artifacts',
          mediaType: 'text/plain',
          sizeBytes: bytes.length,
          checksum:
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          visibility: 'private',
          immutable: true,
          retentionUntil: null,
        });
        await storage().put(
          prepared.object,
          new Blob([new Uint8Array(bytes)]).stream(),
        );
        await markStorageReady(owner, id);
        files.push(id);
      }
      const seriesId = randomUUID(),
        v1 = randomUUID(),
        v2 = randomUUID();
      await fixture.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
      values (${v1},${owner.organizationId},${owner.workspaceId},${owner.actor.id},${files[0]!},${seriesId},1,${synthetic.task.chatSessionId},'Report.txt','text')`;
      await fixture.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,parent_version_id,session_id,file_name,format)
      values (${v2},${owner.organizationId},${owner.workspaceId},${owner.actor.id},${files[1]!},${seriesId},2,${v1},${synthetic.task.chatSessionId},'Report.txt','text')`;
      await change(owner, files[0]!, 0, {
        sharing: { scope: 'company', departmentIds: [] },
        isReference: true,
      });
      const shared = await readWorkbenchFileCatalog(reader, {
        workspaceId: reader.workspaceId,
      });
      expect(shared.files).toHaveLength(1);
      expect(shared.files[0]).toMatchObject({
        objectId: files[1],
        artifact: null,
        sessionIds: [],
      });
      const originalRef = shared.files[0]!.reference!;
      expect(originalRef.checksum).not.toBe(shared.files[0]!.checksum);
      const versions = await listWorkbenchFileVersions(reader, files[1]!);
      expect(versions.map((v) => v.objectId)).toEqual([files[1], files[0]]);
      expect(versions[0]).not.toHaveProperty('sessionId');
      await expect(
        readWorkbenchFileCatalog(reader, {
          workspaceId: reader.workspaceId,
          sessionId: synthetic.task.chatSessionId,
        }),
      ).rejects.toMatchObject({ code: 'artifact_not_found' });
      await change(owner, files[1]!, 1, { isReference: true });
      const latest = (
        await readWorkbenchFileCatalog(reader, {
          workspaceId: reader.workspaceId,
        })
      ).files[0]!;
      expect(latest.reference!.checksum).toBe(latest.checksum);
      expect(latest.reference!.sourceId).not.toBe(originalRef.sourceId);
      const old = await getReferenceFile(
        reader,
        reader.workspaceId,
        originalRef.revisionId,
      );
      expect(await new Response(await storage().get(old.object)).text()).toBe(
        'Version one original bytes',
      );
      expect(
        await listReferenceRevisions(reader, reader.workspaceId),
      ).toHaveLength(1);
      const changes = await Promise.allSettled([
        change(owner, files[0]!, 2, {
          sharing: { scope: 'personal', departmentIds: [] },
        }),
        change(owner, files[1]!, 2, {
          sharing: { scope: 'company', departmentIds: [] },
        }),
      ]);
      expect(
        changes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        changes
          .filter((result) => result.status === 'rejected')
          .map((result) =>
            result.status === 'rejected' ? result.reason.code : null,
          ),
      ).toEqual(['version_conflict']);
      const [session] =
        await fixture.db`select visibility from allrice_chat_sessions where id=${synthetic.task.chatSessionId}`;
      expect(session?.visibility).toBe('private');
    });
    it('keeps one canonical long-term reference and stops library inclusion when unmarked', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner, { scope: 'company', departmentIds: [] }),
          storage(),
        );
      await change(t.owner, file.objectId, 1, { isReference: true });
      const catalog = await readWorkbenchFileCatalog(t.a, {
        workspaceId: t.a.workspaceId!,
      });
      expect(catalog.files).toHaveLength(1);
      expect(catalog.files[0]).toMatchObject({
        objectId: file.objectId,
        isReference: true,
        reference: { revision: 1 },
      });
      expect(await listReferenceRevisions(t.a, t.a.workspaceId!)).toHaveLength(
        1,
      );
      await change(t.owner, file.objectId, 2, { isReference: false });
      expect(await listReferenceRevisions(t.a, t.a.workspaceId!)).toHaveLength(
        0,
      );
      expect((await readWorkbenchFile(t.a, file.objectId)).object.id).toBe(
        file.objectId,
      );
    });
    it('resolves revoked memberships and archived department targets from live rows, not browser memberships', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner, {
            scope: 'departments',
            departmentIds: [t.departments[0]!],
          }),
          storage(),
        );
      await fixture.db`update allrice_memberships set active=false where user_id=${t.a.actor.id}`;
      await expect(readWorkbenchFile(t.a, file.objectId)).rejects.toMatchObject(
        { code: 'authorization_denied' },
      );
      await fixture.db`update allrice_departments set archived_at=clock_timestamp() where id=${t.departments[0]!}`;
      await expect(
        readWorkbenchFile(t.maintainer, file.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        change(t.owner, file.objectId, 1, {
          sharing: { scope: 'departments', departmentIds: [t.departments[0]!] },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await change(t.owner, file.objectId, 1, {
        sharing: { scope: 'company', departmentIds: [] },
      });
      expect(
        (await readWorkbenchFile(t.maintainer, file.objectId)).object.id,
      ).toBe(file.objectId);
    });
  },
);
