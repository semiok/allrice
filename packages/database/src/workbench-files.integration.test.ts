import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  readPathSignal,
  scheduleReadPathQuery,
} from './read-path-races.fixture.ts';
import { legacyReferenceFixture } from './legacy-reference.fixture.ts';
import { allocateWorkbenchFileName } from './workbench-file-name.ts';
import { createDeliverablesPort } from './deliverables-port.ts';
import { createEnterpriseMaterialsPort } from './enterprise-materials-port.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from './reference-processing.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type {
  RequestContext,
  StoragePort,
  WorkbenchFileSharing,
} from '@allrice/contracts';
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
  uploadWorkbenchFile,
  setWorkbenchFileFavorite,
} from './workbench-files.ts';
import {
  getReferenceFile,
  prepareReferenceUpload,
  listReferenceRevisions,
  publishReference,
  referenceSourceAccess,
} from './reference-library.ts';
import { readReferenceSelection } from './reference-runtime.ts';
import { listWorkspaceFiles } from './workspace/service.ts';
import {
  DataAccessError,
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
    function uploadInput(context: RequestContext) {
      return {
        workspaceId: context.workspaceId!,
        requestId: randomUUID(),
        fileName: '收入口径.txt',
        mediaType: 'text/plain',
        contentBase64:
          Buffer.from('按已经确认的回款统计收入。').toString('base64'),
      };
    }
    const storage = () => runtimeFixtureStorage(fixture.db);
    function boundStorage(actual: StoragePort): StoragePort {
      return {
        put: actual.put.bind(actual),
        get: actual.get.bind(actual),
        delete: actual.delete.bind(actual),
        exists: actual.exists.bind(actual),
      };
    }
    async function seedLegacySharing(
      objectId: string,
      sharing: WorkbenchFileSharing,
    ) {
      // Historical data only: the public sharing/update write API is retired.
      await fixture.db`update allrice_workbench_file_policies
        set scope=${sharing.scope},department_ids=${sharing.departmentIds}
        where object_id=${objectId}`;
    }
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
        expect(employeeFiles.files[0]!.fileName).toBe('跨员工上传.txt');
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
      // The legacy catalog still collapses a series.
      const acrossEmployees = await fixture.db.begin(async (tx) => {
        await lockWorkspaceStorageQuota(
          tx,
          owner.organizationId,
          owner.workspaceId,
        );
        const names = [];
        for (const requested of ['跨员工上传.txt', '本人上传-51.txt'])
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
        '跨员工上传（2）.txt',
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
      const file = await uploadWorkbenchFile(t.a, uploadInput(t.a), storage());
      await seedLegacySharing(file.objectId, {
        scope: 'company',
        departmentIds: [],
      });
      const duplicate = await uploadWorkbenchFile(
        t.a,
        uploadInput(t.a),
        storage(),
      );
      const [stored, duplicateStored] = await Promise.all(
        [file, duplicate].map(({ objectId }) =>
          readWorkbenchFile(t.a, objectId),
        ),
      );
      if (!stored || !duplicateStored)
        throw Error('Both uploaded originals must remain readable.');
      expect([stored.row.file_name, duplicateStored.row.file_name]).toEqual([
        '收入口径.txt',
        '收入口径（2）.txt',
      ]);
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
      expect(names).toEqual(['收入口径（3）.txt', '收入口径.txt']);
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
      await expect(
        readWorkbenchFile(t.maintainer, file.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
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
    it('never treats legacy company sharing or worker intermediate bytes as my uploads', async () => {
      const t = await setup();
      const shared = await uploadWorkbenchFile(
        t.owner,
        uploadInput(t.owner),
        storage(),
      );
      await seedLegacySharing(shared.objectId, {
        scope: 'company',
        departmentIds: [],
      });
      await expect(
        readWorkbenchFile(t.maintainer, shared.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
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
    it('defaults uploads to personal; a company role cannot discover or read another original', async () => {
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
        getStoredFile(t.maintainer, file.objectId),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
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
    it('saves each new same-name upload independently, reserves pending names and replays the original request', async () => {
      const t = await setup();
      const firstInput = uploadInput(t.owner);
      const secondInput = {
        ...firstInput,
        requestId: randomUUID(),
        contentBase64: Buffer.from('第二份独立文件。').toString('base64'),
      };
      const actualStorage = storage();
      let releaseFirst!: () => void;
      let firstPutStarted!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const started = new Promise<void>((resolve) => {
        firstPutStarted = resolve;
      });
      const first = uploadWorkbenchFile(t.owner, firstInput, {
        ...boundStorage(actualStorage),
        async put(object, content) {
          firstPutStarted();
          await held;
          await actualStorage.put(object, content);
        },
      });
      try {
        await started;
        const second = await uploadWorkbenchFile(
          t.owner,
          secondInput,
          actualStorage,
        );
        const secondFile = await readWorkbenchFile(t.owner, second.objectId);
        expect(secondFile.row.file_name).toBe('收入口径（2）.txt');
        releaseFirst();
        const original = await first;
        expect(original.objectId).not.toBe(second.objectId);
        expect(
          (await readWorkbenchFile(t.owner, original.objectId)).row.file_name,
        ).toBe('收入口径.txt');
        expect(
          await uploadWorkbenchFile(t.owner, firstInput, actualStorage),
        ).toEqual(original);
        const third = await uploadWorkbenchFile(
          t.owner,
          { ...firstInput, requestId: randomUUID() },
          actualStorage,
        );
        expect(
          (await readWorkbenchFile(t.owner, third.objectId)).row.file_name,
        ).toBe('收入口径（3）.txt');
        const catalog = await readWorkbenchDeliverables(t.owner, {
          workspaceId: t.owner.workspaceId,
          query: '收入口径',
        });
        expect(catalog.files.map((file) => file.objectId).sort()).toEqual(
          [original.objectId, second.objectId, third.objectId].sort(),
        );
        for (const [saved, value] of [
          [original, firstInput],
          [second, secondInput],
        ] as const) {
          const file = await readWorkbenchFile(t.owner, saved.objectId);
          const stream = await actualStorage.get(file.object);
          expect(await new Response(stream).text()).toBe(
            Buffer.from(value.contentBase64, 'base64').toString('utf8'),
          );
          await expect(
            readWorkbenchFile(t.maintainer, saved.objectId),
          ).rejects.toMatchObject({ code: 'not_found' });
        }
      } finally {
        releaseFirst();
        await first;
      }
    }, 30000);
    it('uses the personal business Port for my files, favorites across employees and exact verified text', async () => {
      const t = await setup();
      // Explicit 273 qualification substitute; real membership/resource ACLs
      // still run in the owner. This does not bind a production employee.
      const testQualification = vi.fn(async () => {});
      const port = createDeliverablesPort({
        storage: storage(),
        requireCurrentAccess: testQualification,
      });
      const signal = new AbortController().signal;
      const input = uploadInput(t.owner);
      const original = await port.upload(t.owner, input, signal);
      expect(await port.upload(t.owner, input, signal)).toEqual(original);
      const next = await port.upload(
        t.owner,
        { ...input, requestId: randomUUID() },
        signal,
      );
      expect(next.objectId).not.toBe(original.objectId);
      await port.favorite(
        t.owner,
        { target: original, body: { favorite: true } },
        signal,
      );
      await port.favorite(
        t.owner,
        { target: original, body: { favorite: true } },
        signal,
      );
      const favorites = await port.list(
        t.owner,
        {
          workspaceId: t.owner.workspaceId!,
          category: 'favorite',
          employeeInstanceId: randomUUID(),
        },
        signal,
      );
      expect(favorites.files.map((file) => file.objectId)).toEqual([
        original.objectId,
      ]);
      expect(favorites.files[0]!.fileName).toBe('收入口径.txt');
      const file = await readWorkbenchFile(t.owner, original.objectId);
      const exact = {
        objectId: original.objectId,
        checksum: file.object.checksum,
      };
      const text = await port.readExact(
        t.owner,
        { ...exact, offset: 2, limit: 5 },
        signal,
      );
      expect(text).toMatchObject({
        id: original.objectId,
        checksum: file.object.checksum,
        content: '按已经确认的回款统计收入。'.slice(2, 7),
        offset: 2,
        nextOffset: 7,
        truncated: true,
      });
      const resource = await port.authorizedResource(t.owner, exact, signal);
      expect(Object.keys(resource).sort()).toEqual([
        'fileName',
        'mediaType',
        'open',
        'sizeBytes',
        'source',
      ]);
      expect(await new Response(await resource.open(signal)).text()).toBe(
        '按已经确认的回款统计收入。',
      );
      await expect(
        port.readExact(
          t.owner,
          { ...exact, checksum: `sha256:${'0'.repeat(64)}` },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        port.authorizedResource(t.maintainer, exact, signal),
      ).rejects.toMatchObject({ code: 'not_found' });
      await port.favorite(
        t.owner,
        { target: original, body: { favorite: false } },
        signal,
      );
      expect(
        (
          await port.list(
            t.owner,
            { workspaceId: t.owner.workspaceId!, category: 'favorite' },
            signal,
          )
        ).files,
      ).toEqual([]);
      expect(testQualification).toHaveBeenCalled();
      const unbound = createDeliverablesPort({ storage: storage() });
      await expect(
        unbound.list(t.owner, { workspaceId: t.owner.workspaceId! }, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }, 30000);
    it('does not return corrupt bytes or a new stream segment after qualification is revoked, and joins cancellation', async () => {
      const t = await setup();
      const actualStorage = storage();
      const uploaded = await uploadWorkbenchFile(
        t.owner,
        uploadInput(t.owner),
        actualStorage,
      );
      const stored = await readWorkbenchFile(t.owner, uploaded.objectId);
      const input = {
        objectId: uploaded.objectId,
        checksum: stored.object.checksum,
      };
      const signal = new AbortController().signal;
      let enabled = true;
      const testQualification = async () => {
        if (!enabled) throw new DataAccessError('authorization_denied');
      };
      const corrupt = createDeliverablesPort({
        requireCurrentAccess: testQualification,
        storage: {
          ...boundStorage(actualStorage),
          async get() {
            return new Blob(['corrupt']).stream();
          },
        },
      });
      await expect(
        corrupt.readExact(t.owner, input, signal),
      ).rejects.toMatchObject({ code: 'TOOL_FILE_CHECKSUM_MISMATCH' });
      const upstreamCanceled = vi.fn(async () => {});
      const port = createDeliverablesPort({
        requireCurrentAccess: testQualification,
        storage: {
          ...boundStorage(actualStorage),
          async get() {
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode('按'));
              },
              cancel: upstreamCanceled,
            });
          },
        },
      });
      const resource = await port.authorizedResource(t.owner, input, signal);
      const stream = await resource.open(signal);
      enabled = false;
      await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      expect(upstreamCanceled).toHaveBeenCalledTimes(1);
      enabled = true;
      const cancellation = new AbortController();
      const nextResource = await port.authorizedResource(
        t.owner,
        input,
        cancellation.signal,
      );
      const nextStream = await nextResource.open(cancellation.signal);
      let releaseCancel!: () => void;
      let cancelStarted!: () => void;
      const cancelFinished = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      const cancelEntered = new Promise<void>((resolve) => {
        cancelStarted = resolve;
      });
      upstreamCanceled.mockImplementationOnce(async () => {
        cancelStarted();
        await cancelFinished;
      });
      cancellation.abort(new Error('native request canceled'));
      let settled = false;
      const read = new Response(nextStream).arrayBuffer();
      void read.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await cancelEntered;
        await Promise.resolve();
        expect(settled).toBe(false);
      } finally {
        releaseCancel();
        await expect(read).rejects.toThrow('native request canceled');
      }
      expect(upstreamCanceled).toHaveBeenCalledTimes(2);
    }, 30000);
    it.each([false, true])(
      'ends reader.closed after abort without a rescue read (paused=%s)',
      async (paused) => {
        const t = await setup();
        const actualStorage = storage();
        const uploaded = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          actualStorage,
        );
        const source = {
          ...uploaded,
          checksum: (await readWorkbenchFile(t.owner, uploaded.objectId)).object
            .checksum,
        };
        const cancelEntered = readPathSignal();
        const cancelGate = readPathSignal();
        const upstreamPull = vi.fn(
          (value: ReadableStreamDefaultController<Uint8Array>) => {
            value.enqueue(new TextEncoder().encode('按'));
          },
        );
        const upstreamCancel = vi.fn(async () => {
          cancelEntered.resolve();
          await cancelGate.promise;
        });
        const upstream = new ReadableStream<Uint8Array>(
          { pull: upstreamPull, cancel: upstreamCancel },
          { highWaterMark: 0 },
        );
        const port = createDeliverablesPort({
          // Explicit qualification substitute; real owner/membership SQL runs.
          requireCurrentAccess: async () => {},
          storage: {
            ...boundStorage(actualStorage),
            get: async () => upstream,
          },
        });
        const cancellation = new AbortController();
        const resource = await port.authorizedResource(
          t.owner,
          source,
          cancellation.signal,
        );
        const reader = (await resource.open(cancellation.signal)).getReader();
        let settled = false;
        const closed = reader.closed.then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        const reason = new Error('native request canceled while paused');
        try {
          if (paused)
            expect(await reader.read()).toEqual({
              done: false,
              value: new TextEncoder().encode('按'),
            });
          cancellation.abort(reason);
          await cancelEntered.promise;
          await nextTurn();
          expect(settled).toBe(false);
          expect(upstream.locked).toBe(true);
          cancelGate.resolve();
          expect(await closed).toBe(reason);
          expect(upstream.locked).toBe(false);
          expect(upstreamCancel).toHaveBeenCalledTimes(1);
          expect(upstreamCancel).toHaveBeenCalledWith(reason);
          expect(upstreamPull).toHaveBeenCalledTimes(paused ? 1 : 0);
        } finally {
          cancelGate.resolve();
          await closed;
          reader.releaseLock();
        }
      },
      30000,
    );
    it.each(['qualification', 'owner'] as const)(
      'consumer cancel joins the in-flight %s boundary and starts no later read',
      async (boundary) => {
        const t = await setup();
        const actualStorage = storage();
        const uploaded = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          actualStorage,
        );
        const source = {
          ...uploaded,
          checksum: (await readWorkbenchFile(t.owner, uploaded.objectId)).object
            .checksum,
        };
        const entered = readPathSignal();
        const gate = readPathSignal();
        const cancelEntered = readPathSignal();
        const cancelGate = readPathSignal();
        let armed = false;
        let qualifications = 0;
        let queries = 0;
        let principalReads = 0;
        let boundaryFinished = false;
        const upstreamPull = vi.fn();
        const upstreamCancel = vi.fn(async () => {
          cancelEntered.resolve();
          await cancelGate.promise;
        });
        const upstream = new ReadableStream<Uint8Array>(
          { pull: upstreamPull, cancel: upstreamCancel },
          { highWaterMark: 0 },
        );
        const port = createDeliverablesPort({
          requireCurrentAccess: async () => {
            // Explicit 273 substitute, not a production qualification binding.
            if (!armed) return;
            qualifications++;
            if (boundary === 'qualification') {
              entered.resolve();
              await gate.promise;
              boundaryFinished = true;
            }
          },
          storage: {
            ...boundStorage(actualStorage),
            get: async () => upstream,
          },
        });
        const signal = new AbortController().signal;
        const resource = await port.authorizedResource(t.owner, source, signal);
        const reader = (await resource.open(signal)).getReader();
        const observed = new Proxy(fixture.db, {
          apply(target, self, args: unknown[]) {
            const query = Reflect.apply(target, self, args);
            const [strings] = args;
            if (!Array.isArray(strings) || !('raw' in strings)) return query;
            return scheduleReadPathQuery(
              query,
              strings.join(' ? '),
              async (statement, execute) => {
                queries++;
                const result = await execute(); // Actual PostgreSQL, no fake row.
                // For a ready personal upload, the fourth principal query is
                // the last owner read. Hold its real result delivery, not SQL
                // cancellation or a second source of resource authority.
                if (
                  boundary === 'owner' &&
                  statement.startsWith(
                    'select d.id as department_id,coalesce(',
                  ) &&
                  ++principalReads === 4
                ) {
                  entered.resolve();
                  await gate.promise;
                  boundaryFinished = true;
                }
                return result;
              },
            );
          },
          get: (target, key) => Reflect.get(target, key, target),
        });
        vi.mocked(client.getDatabase).mockReturnValue(observed);
        armed = true;
        const reading = reader.read();
        let canceled: Promise<void> | undefined;
        try {
          await entered.promise;
          const queriesAtCancel = queries;
          const reason = new Error('consumer canceled an in-flight owner read');
          let settled = false;
          canceled = reader.cancel(reason).then(() => {
            settled = true;
          });
          await cancelEntered.promise;
          cancelGate.resolve();
          await nextTurn();
          expect(settled).toBe(false);
          expect(boundaryFinished).toBe(false);
          expect(upstream.locked).toBe(true);
          gate.resolve();
          await canceled;
          expect(boundaryFinished).toBe(true);
          expect(qualifications).toBe(1);
          expect(queries).toBe(queriesAtCancel);
          if (boundary === 'qualification') expect(queries).toBe(0);
          else expect(principalReads).toBe(4);
          expect(upstreamPull).not.toHaveBeenCalled();
          expect(upstreamCancel).toHaveBeenCalledTimes(1);
          expect(upstreamCancel).toHaveBeenCalledWith(reason);
          expect(upstream.locked).toBe(false);
          expect(await reading).toEqual({ done: true, value: undefined });
        } finally {
          gate.resolve();
          cancelGate.resolve();
          await Promise.allSettled([reading, canceled]);
          vi.mocked(client.getDatabase).mockReturnValue(fixture.db);
          reader.releaseLock();
        }
      },
      30000,
    );
    it.each(['signal', 'consumer'] as const)(
      'retains the original %s cancel reason and upstream cleanup failure',
      async (entry) => {
        const t = await setup();
        const actualStorage = storage();
        const uploaded = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          actualStorage,
        );
        const source = {
          ...uploaded,
          checksum: (await readWorkbenchFile(t.owner, uploaded.objectId)).object
            .checksum,
        };
        const cancelEntered = readPathSignal();
        const cancelGate = readPathSignal();
        const cleanup = new Error('upstream cancellation failed');
        const upstreamCancel = vi.fn(async () => {
          cancelEntered.resolve();
          await cancelGate.promise;
          throw cleanup;
        });
        const upstream = new ReadableStream<Uint8Array>(
          { cancel: upstreamCancel },
          { highWaterMark: 0 },
        );
        const port = createDeliverablesPort({
          requireCurrentAccess: async () => {}, // Explicit qualification substitute.
          storage: {
            ...boundStorage(actualStorage),
            get: async () => upstream,
          },
        });
        const cancellation = new AbortController();
        const resource = await port.authorizedResource(
          t.owner,
          source,
          cancellation.signal,
        );
        const reader = (await resource.open(cancellation.signal)).getReader();
        // Signal termination is observed only through closed, never a rescue read.
        const closed = reader.closed.then(
          () => undefined,
          (error: unknown) => error,
        );
        const reason = new Error('original native cancellation');
        let outcome: Promise<unknown>;
        if (entry === 'signal') {
          cancellation.abort(reason);
          outcome = closed;
        } else
          outcome = reader.cancel(reason).then(
            () => undefined,
            (error: unknown) => error,
          );
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });
        try {
          await cancelEntered.promise;
          if (entry === 'consumer')
            cancellation.abort(
              new Error('later signal must not replace reason'),
            );
          await nextTurn();
          expect(settled).toBe(false);
          expect(upstream.locked).toBe(true);
          cancelGate.resolve();
          expect(await outcome).toBeInstanceOf(AggregateError);
          expect(await outcome).toMatchObject({
            cause: reason,
            errors: [reason, cleanup],
          });
          expect(upstreamCancel).toHaveBeenCalledTimes(1);
          expect(upstreamCancel).toHaveBeenCalledWith(reason);
          expect(upstream.locked).toBe(false);
        } finally {
          cancelGate.resolve();
          await outcome;
          reader.releaseLock();
        }
      },
      30000,
    );
    it('uses the materials Port for independent saves and current personal, department and company publication queries', async () => {
      const t = await setup();
      const actualStorage = storage();
      // Explicit qualification substitute only. Audience, live memberships,
      // publisher maintenance and exact selection remain real owner checks.
      const port = createEnterpriseMaterialsPort({
        storage: actualStorage,
        requireCurrentAccess: async () => {},
      });
      const signal = new AbortController().signal;
      const input = {
        ...uploadInput(t.owner),
        scope: 'personal' as const,
        purpose: '本人的固定资料',
      };
      const first = await port.save(t.owner, input, signal);
      expect(await port.save(t.owner, input, signal)).toEqual(first);
      const second = await port.save(
        t.owner,
        { ...input, requestId: randomUUID() },
        signal,
      );
      expect(second.sourceId).not.toBe(first.sourceId);
      expect(second.revisionId).not.toBe(first.revisionId);
      const firstFile = await getReferenceFile(
        t.owner,
        t.owner.workspaceId!,
        first.revisionId,
      );
      const secondFile = await getReferenceFile(
        t.owner,
        t.owner.workspaceId!,
        second.revisionId,
      );
      expect([firstFile.fileName, secondFile.fileName]).toEqual([
        '收入口径.txt',
        '收入口径（2）.txt',
      ]);
      expect(
        (
          await port.listCurrent(
            t.owner,
            { workspaceId: t.owner.workspaceId! },
            signal,
          )
        ).references
          .map((file) => file.revisionId)
          .sort(),
      ).toEqual([first.revisionId, second.revisionId].sort());
      expect(
        await new Response(await actualStorage.get(firstFile.object)).text(),
      ).toBe('按已经确认的回款统计收入。');
      const replacement = {
        ...input,
        sourceId: first.sourceId,
        expectedRevision: 1,
      };
      await expect(port.save(t.owner, replacement, signal)).rejects.toThrow();
      await expect(
        port.save(
          t.owner,
          {
            ...input,
            contentBase64: Buffer.from('改变原请求').toString('base64'),
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      const companyText = '验收全文中的回款出处。';
      const published = await port.publishUpload(
        t.owner,
        {
          ...uploadInput(t.owner),
          fileName: '公司固定资料.txt',
          origin: 'upload',
          contentBase64: Buffer.from(companyText).toString('base64'),
          audience: { scope: 'company', departmentIds: [] },
        },
        signal,
      );
      const pending = await port.query(
        t.a,
        { sourceId: published.sourceId },
        signal,
      );
      expect(pending.references.map((file) => file.revisionId)).toEqual([
        published.revisionId,
      ]);
      expect(pending.fullTextCoverage).toEqual({ ready: 0, unavailable: 1 });
      await fixture.db`update allrice_knowledge_processing set updated_at='2000-01-01' where revision_id=${published.revisionId}`;
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(published.revisionId);
      await finishReferenceProcessing(
        claim!,
        [{ content: companyText, start: 0, end: companyText.length }],
        {
          text: companyText,
          kind: 'text',
          warnings: [],
          units: [{ label: '正文', start: 0, end: companyText.length }],
        },
      );
      const found = await port.query(
        t.a,
        { query: '回款出处', sourceId: published.sourceId },
        signal,
      );
      expect(found.fullTextCoverage).toEqual({ ready: 1, unavailable: 0 });
      expect(found.matches).toEqual([
        {
          revisionId: published.revisionId,
          content: '回款出处。',
          start: 6,
          end: 11,
          locations: [{ unit: 0, label: '正文', start: 0, end: 11 }],
          warnings: [],
        },
      ]);
      const selected = await port.captureSelection(
        t.a,
        { workspaceId: t.a.workspaceId!, revisionId: published.revisionId },
        signal,
      );
      expect(selected.selection).toMatchObject({
        sourceId: published.sourceId,
        revisionId: published.revisionId,
        checksum: claim!.object.checksum,
      });
      const publishedFile = await getReferenceFile(
        t.a,
        t.a.workspaceId!,
        published.revisionId,
      );
      expect(publishedFile.sourceId).toBe(published.sourceId);
      expect(publishedFile.object.checksum).toBe(selected.selection.checksum);
      expect(
        await new Response(
          await actualStorage.get(publishedFile.object),
        ).text(),
      ).toBe(companyText);
      const department = await port.publishUpload(
        t.owner,
        {
          ...uploadInput(t.owner),
          fileName: '部门固定资料.txt',
          origin: 'upload',
          audience: {
            scope: 'departments',
            departmentIds: [t.departments[0]!],
          },
        },
        signal,
      );
      const personal = await port.publishUpload(
        t.owner,
        {
          ...uploadInput(t.owner),
          fileName: '个人固定资料.txt',
          origin: 'upload',
          audience: { scope: 'personal', departmentIds: [] },
        },
        signal,
      );
      expect(
        (await port.query(t.a, { sourceId: department.sourceId }, signal))
          .references,
      ).toHaveLength(1);
      expect(
        (await port.query(t.b, { sourceId: department.sourceId }, signal))
          .references,
      ).toEqual([]);
      expect(
        (await port.query(t.a, { sourceId: personal.sourceId }, signal))
          .references,
      ).toEqual([]);
      await expect(
        port.changePublication(
          t.a,
          {
            target: { sourceId: published.sourceId },
            body: {
              workspaceId: t.a.workspaceId!,
              requestId: randomUUID(),
              expectedRevision: 1,
              action: 'delete',
            },
          },
          signal,
        ),
      ).rejects.toThrow();
      const changed = {
        target: { sourceId: published.sourceId },
        body: {
          workspaceId: t.owner.workspaceId!,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'audience' as const,
          audience: { scope: 'personal' as const, departmentIds: [] },
        },
      };
      await port.changePublication(t.owner, changed, signal);
      expect(
        (await port.query(t.a, { sourceId: published.sourceId }, signal))
          .references,
      ).toEqual([]);
      await expect(
        port.changePublication(
          t.owner,
          { ...changed, body: { ...changed.body, requestId: randomUUID() } },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      await expect(
        port.captureSelection(
          t.a,
          { workspaceId: t.a.workspaceId!, revisionId: published.revisionId },
          signal,
        ),
      ).rejects.toThrow();
      const unbound = createEnterpriseMaterialsPort({ storage: actualStorage });
      await expect(unbound.query(t.owner, {}, signal)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
    }, 30000);
    it.each(['departments', 'company'] as const)(
      'keeps a legacy %s original owner-only without migrating its policy',
      async (scope) => {
        const t = await setup(),
          file = await uploadWorkbenchFile(
            t.owner,
            uploadInput(t.owner),
            storage(),
          );
        const sharing = {
          scope,
          departmentIds:
            scope === 'departments' ? t.departments.slice(0, 2) : [],
        };
        await seedLegacySharing(file.objectId, sharing);
        expect(
          (await readWorkbenchFile(t.owner, file.objectId)).canMaintain,
        ).toBe(true);
        const own = await getStoredFile(t.owner, file.objectId);
        expect(await new Response(await storage().get(own.object)).text()).toBe(
          '按已经确认的回款统计收入。',
        );
        const catalog = await readWorkbenchFileCatalog(t.owner, {
          workspaceId: t.owner.workspaceId!,
          scope: 'my',
        });
        expect(catalog.files.map((file) => file.objectId)).toEqual([
          file.objectId,
        ]);
        expect(catalog.files[0]!.sharing).toMatchObject(sharing);
        expect(catalog.files[0]!.sharing.departmentNames).toHaveLength(
          sharing.departmentIds.length,
        );
        for (const reader of [t.a, t.b, t.maintainer, t.excluded]) {
          await expect(
            readWorkbenchFile(reader, file.objectId),
          ).rejects.toMatchObject({ code: 'not_found' });
          await expect(
            getStoredFile(reader, file.objectId),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          expect(
            (
              await readWorkbenchFileCatalog(reader, {
                workspaceId: reader.workspaceId!,
              })
            ).files,
          ).toEqual([]);
        }
        const [legacy] =
          await fixture.db`select scope,department_ids,revision from allrice_workbench_file_policies where object_id=${file.objectId}`;
        expect(legacy).toMatchObject({
          scope,
          department_ids: sharing.departmentIds,
          revision: 1,
        });
      },
    );
    it.each(['workspace', 'organization'] as const)(
      'filters no-policy legacy %s originals before catalog pagination and denies borrowed cursors',
      async (visibility) => {
        const t = await setup(),
          legacy = await uploadWorkbenchFile(
            t.owner,
            uploadInput(t.owner),
            storage(),
          ),
          mine = await uploadWorkbenchFile(t.a, uploadInput(t.a), storage());
        await fixture.db`delete from allrice_workbench_file_policies where object_id=${legacy.objectId}`;
        await fixture.db`update allrice_storage_objects set visibility=${visibility} where id=${legacy.objectId}`;
        // Old ready metadata is enough to exercise the pre-ACL 201-row limit.
        // None of these other-owner candidates may reach a byte read.
        await fixture.db`insert into allrice_storage_objects
          (id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,immutable,state,created_at)
          select ids.id,o.organization_id,o.workspace_id,o.owner_id,
            'organizations/'||o.organization_id::text||'/workspaces/'||o.workspace_id::text||'/owners/'||o.owner_id::text||'/uploads/'||ids.id::text,
            o.category,o.media_type,o.size_bytes,o.checksum,o.visibility,o.immutable,'ready','2030-01-01T00:00:00Z'
          from allrice_storage_objects o cross join (select gen_random_uuid() as id from generate_series(1,201)) ids
          where o.id=${legacy.objectId}`;
        expect(
          (await readWorkbenchFile(t.owner, legacy.objectId)).object.id,
        ).toBe(legacy.objectId);
        const own = await getStoredFile(t.owner, legacy.objectId);
        expect(await new Response(await storage().get(own.object)).text()).toBe(
          '按已经确认的回款统计收入。',
        );
        await expect(
          readWorkbenchFile(t.a, legacy.objectId),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(getStoredFile(t.a, legacy.objectId)).rejects.toMatchObject(
          { code: 'authorization_denied' },
        );
        const catalog = await readWorkbenchFileCatalog(t.a, {
          workspaceId: t.a.workspaceId!,
        });
        expect(catalog.files.map((file) => file.objectId)).toEqual([
          mine.objectId,
        ]);
        expect(catalog.truncated).toBe(false);
        const personal = await readWorkbenchDeliverables(t.a, {
          workspaceId: t.a.workspaceId!,
        });
        expect(personal.files.map((file) => file.objectId)).toEqual([
          mine.objectId,
        ]);
        expect(personal.nextCursor).toBeNull();
        for (const locator of [
          { objectId: legacy.objectId },
          { cursor: legacy.objectId },
        ])
          await expect(
            readWorkbenchDeliverables(t.a, {
              workspaceId: t.a.workspaceId!,
              ...locator,
            }),
          ).rejects.toMatchObject({ code: 'not_found' });
        expect(
          await fixture.db`select 1 from allrice_workbench_file_policies where object_id=${legacy.objectId}`,
        ).toHaveLength(0);
      },
    );
    it('rejects retired upload sharing/reference mutations without changing legacy policy or receipts', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        ),
        requestId = randomUUID(),
        inputDigest = `sha256:${'a'.repeat(64)}`;
      await seedLegacySharing(file.objectId, {
        scope: 'company',
        departmentIds: [],
      });
      await fixture.db`update allrice_workbench_file_policies set revision=7 where object_id=${file.objectId}`;
      await fixture.db`insert into allrice_workbench_file_mutations
        (organization_id,actor_id,request_id,object_id,input_digest,result_revision)
        values(${t.owner.organizationId},${t.owner.actor.id},${requestId},${file.objectId},${inputDigest},7)`;
      const before =
        await fixture.db`select id from allrice_storage_objects where organization_id=${t.owner.organizationId} order by id`;
      const put = vi.spyOn(storage(), 'put');
      try {
        const attempts = await Promise.allSettled(
          [
            { sharing: { scope: 'personal', departmentIds: [] } },
            { sharing: { scope: 'company', departmentIds: [] } },
            {
              sharing: {
                scope: 'departments',
                departmentIds: [t.departments[0]!],
              },
            },
            { isReference: true },
            { isReference: false },
            { expectedRevision: 7, role: 'admin' },
            { ownerId: t.maintainer.actor.id },
          ].map((retired) =>
            uploadWorkbenchFile(
              t.owner,
              { ...uploadInput(t.owner), requestId, ...retired },
              storage(),
            ),
          ),
        );
        expect(
          attempts.every(
            (result) =>
              result.status === 'rejected' && result.reason.name === 'ZodError',
          ),
        ).toBe(true);
        expect(put).not.toHaveBeenCalled();
      } finally {
        put.mockRestore();
      }
      expect(
        await fixture.db`select id from allrice_storage_objects where organization_id=${t.owner.organizationId} order by id`,
      ).toEqual(before);
      expect(
        await fixture.db`select scope,revision,reference_enabled from allrice_workbench_file_policies where object_id=${file.objectId}`,
      ).toEqual([{ scope: 'company', revision: 7, reference_enabled: false }]);
      expect(
        await fixture.db`select object_id,input_digest,result_revision from allrice_workbench_file_mutations where organization_id=${t.owner.organizationId} and actor_id=${t.owner.actor.id} and request_id=${requestId}`,
      ).toEqual([
        {
          object_id: file.objectId,
          input_digest: inputDigest,
          result_revision: 7,
        },
      ]);
    });
    it('keeps personal exact task references and revokes new reads when the original owner loses membership', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      await seedLegacySharing(file.objectId, {
        scope: 'company',
        departmentIds: [],
      });
      await expect(
        captureWorkbenchFileReference(
          t.a,
          t.a.workspaceId!,
          file.objectId,
          randomUUID(),
          storage(),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      const requestId = randomUUID();
      const ref = await captureWorkbenchFileReference(
        t.owner,
        t.owner.workspaceId!,
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
        (await getContentAccess(t.owner, ref.ownership, fixture.db)).canRead,
      ).toBe(true);
      expect(
        (await getContentAccess(t.a, ref.ownership, fixture.db)).canRead,
      ).toBe(false);
      expect(
        (
          await captureWorkbenchFileReference(
            t.owner,
            t.owner.workspaceId!,
            file.objectId,
            requestId,
            storage(),
          )
        ).revisionId,
      ).toBe(ref.revisionId);
      const bytes = await getReferenceFile(
        t.owner,
        t.owner.workspaceId!,
        ref.revisionId,
      );
      expect(bytes.object.id).not.toBe(file.objectId);
      expect(await new Response(await storage().get(bytes.object)).text()).toBe(
        '按已经确认的回款统计收入。',
      );
      expect(
        (await listReferenceRevisions(t.owner, t.owner.workspaceId!)).some(
          (r) => r.sourceId === ref.sourceId,
        ),
      ).toBe(false);
      await fixture.db`update allrice_knowledge_processing set state='ready' where revision_id=${ref.revisionId}`;
      expect(
        (
          await fixture.db.begin((tx) =>
            readReferenceSelection(t.owner, ref.revisionId, tx, true),
          )
        ).selection.revisionId,
      ).toBe(ref.revisionId);
      await fixture.db`update allrice_memberships set active=false where user_id=${t.owner.actor.id}`;
      await expect(getStoredFile(t.owner, file.objectId)).rejects.toMatchObject(
        { code: 'authorization_denied' },
      );
      await expect(
        getReferenceFile(t.owner, t.owner.workspaceId!, ref.revisionId),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        fixture.db.begin((tx) =>
          readReferenceSelection(t.owner, ref.revisionId, tx, true),
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      expect(await new Response(await storage().get(bytes.object)).text()).toBe(
        '按已经确认的回款统计收入。',
      );
    });
    it('uses the original owner rather than a legacy retained-copy creator and never exposes an editable copy', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      await seedLegacySharing(file.objectId, {
        scope: 'company',
        departmentIds: [],
      });
      // Historical recipient ownership is fixed at first INSERT. The retained
      // copy remains immutable; its exact origin binding decides current access.
      const original = await readWorkbenchFile(t.owner, file.objectId);
      const bytes = Buffer.from(
        await new Response(await storage().get(original.object)).arrayBuffer(),
      );
      const reference = await legacyReferenceFixture(
        t.maintainer,
        {
          workspaceId: t.maintainer.workspaceId,
          requestId: randomUUID(),
          scope: 'personal',
          fileName: original.row.file_name,
          mediaType: original.object.mediaType,
          contentBase64: bytes.toString('base64'),
        },
        fixture.db,
      );
      await storage().put(
        reference.object,
        new Blob([new Uint8Array(reference.bytes)]).stream(),
      );
      await fixture.db`update allrice_storage_objects set state='ready' where id=${reference.object.id}`;
      await fixture.db`insert into allrice_workbench_reference_bindings(source_id,origin_object_id,organization_id)
        values(${reference.sourceId},${file.objectId},${t.owner.organizationId})`;
      const copy = await getReferenceFile(
        t.owner,
        t.owner.workspaceId!,
        reference.revisionId,
      );
      await expect(
        getReferenceFile(
          t.maintainer,
          t.maintainer.workspaceId!,
          reference.revisionId,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (
          await listReferenceRevisions(
            t.owner,
            t.owner.workspaceId!,
            reference.sourceId,
          )
        ).map((r) => r.revisionId),
      ).toEqual([reference.revisionId]);
      expect(
        await listReferenceRevisions(
          t.maintainer,
          t.maintainer.workspaceId!,
          reference.sourceId,
        ),
      ).toEqual([]);
      for (const current of [t.owner, t.maintainer]) {
        await expect(
          readWorkbenchFile(current, copy.object.id),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          getStoredFile(current, copy.object.id),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
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
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        (await readWorkbenchFile(t.owner, file.objectId)).canMaintain,
      ).toBe(true);
      await expect(
        readWorkbenchFile(t.maintainer, file.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(await new Response(await storage().get(copy.object)).text()).toBe(
        '按已经确认的回款统计收入。',
      );
    });
    it('invalidates old recipient grants and requires the current owner identity and membership for signed reads', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      await seedLegacySharing(file.objectId, {
        scope: 'company',
        departmentIds: [],
      });
      const legacy = {
        objectId: file.objectId,
        subjectId: t.a.actor.id,
        operation: 'read' as const,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: randomUUID(),
      };
      await fixture.db`insert into allrice_storage_access_grants(nonce,object_id,subject_id,operation,expires_at)
        values(${legacy.nonce},${legacy.objectId},${legacy.subjectId},${legacy.operation},${legacy.expiresAt})`;
      await expect(
        resolveStorageGrant(legacy, async () => t.a),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      await expect(
        saveStorageGrant(t.a, { ...legacy, nonce: randomUUID() }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        saveStorageGrant(t.owner, { ...legacy, nonce: randomUUID() }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const grant = {
        ...legacy,
        subjectId: t.owner.actor.id,
        nonce: randomUUID(),
      };
      await saveStorageGrant(t.owner, grant);
      const currentOwner = vi.fn(async () => t.owner);
      expect((await resolveStorageGrant(grant, currentOwner)).object.id).toBe(
        file.objectId,
      );
      expect(currentOwner).toHaveBeenCalledWith({
        organizationId: t.owner.organizationId,
        workspaceId: t.owner.workspaceId,
      });
      await expect(
        resolveStorageGrant(grant, async () => t.a),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      await expect(
        resolveStorageGrant(grant, async () => null),
      ).rejects.toMatchObject({ code: 'authentication_required' });
      await fixture.db`update allrice_memberships set active=false where user_id=${t.owner.actor.id}`;
      await expect(
        resolveStorageGrant(grant, currentOwner),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      await expect(
        saveStorageGrant(t.owner, { ...grant, nonce: randomUUID() }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('does not exempt legacy memory objects from owner-only storage and grant authority', async () => {
      const t = await setup();
      const bytes = Buffer.from('private memory bytes');
      const { createHash } = await import('node:crypto');
      const prepared = await createStorageMetadata(t.owner, {
        id: randomUUID(),
        workspaceId: t.owner.workspaceId,
        category: 'memory',
        mediaType: 'text/plain',
        sizeBytes: bytes.length,
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        visibility: 'organization',
        immutable: true,
        retentionUntil: null,
      });
      await storage().put(
        prepared.object,
        new Blob([new Uint8Array(bytes)]).stream(),
      );
      await markStorageReady(t.owner, prepared.object.id);
      const grant = {
        objectId: prepared.object.id,
        subjectId: t.owner.actor.id,
        operation: 'read' as const,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: randomUUID(),
      };
      await saveStorageGrant(t.owner, grant);
      const resolved = await resolveStorageGrant(grant, async () => t.owner);
      expect(
        await new Response(await storage().get(resolved.object)).text(),
      ).toBe('private memory bytes');
      await expect(
        getStoredFile(t.maintainer, prepared.object.id),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        resolveStorageGrant(grant, async () => t.maintainer),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      await expect(
        saveStorageGrant(t.maintainer, {
          ...grant,
          subjectId: t.maintainer.actor.id,
          nonce: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
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
      const saving = captureWorkbenchFileReference(
        t.owner,
        t.owner.workspaceId!,
        file.objectId,
        randomUUID(),
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
      expect(
        await fixture.db`select 1 from allrice_workbench_reference_bindings where origin_object_id=${file.objectId}`,
      ).toHaveLength(0);
    });
    it('keeps read-only owner series history and exact old snapshot bytes without exposing its private chat', async () => {
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
      const originalRef = await captureWorkbenchFileReference(
        owner,
        owner.workspaceId,
        files[0]!,
        randomUUID(),
        storage(),
      );
      await fixture.db`insert into allrice_workbench_file_policies
        (object_id,organization_id,workspace_id,owner_id,series_id,file_name,scope,reference_source_id,reference_enabled)
        values (${files[0]!},${owner.organizationId},${owner.workspaceId},${owner.actor.id},${seriesId},'Report.txt','company',${originalRef.sourceId},true)`;
      const catalog = await readWorkbenchFileCatalog(owner, {
        workspaceId: owner.workspaceId,
      });
      expect(catalog.files).toHaveLength(1);
      expect(catalog.files[0]).toMatchObject({
        objectId: files[1],
        sessionIds: [],
        artifact: { id: v2 },
        reference: { revisionId: originalRef.revisionId },
      });
      expect(originalRef.checksum).not.toBe(catalog.files[0]!.checksum);
      expect(
        (
          await readWorkbenchFileCatalog(reader, {
            workspaceId: reader.workspaceId,
          })
        ).files,
      ).toEqual([]);
      const versions = await listWorkbenchFileVersions(owner, files[1]!);
      expect(versions.map((v) => v.objectId)).toEqual([files[1], files[0]]);
      expect(versions[0]).not.toHaveProperty('sessionId');
      await expect(
        listWorkbenchFileVersions(reader, files[1]!),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        readWorkbenchFileCatalog(reader, {
          workspaceId: reader.workspaceId,
          sessionId: synthetic.task.chatSessionId,
        }),
      ).rejects.toMatchObject({ code: 'artifact_not_found' });
      const replacement = await captureWorkbenchFileReference(
        owner,
        owner.workspaceId,
        files[1]!,
        randomUUID(),
        storage(),
      );
      await fixture.db`update allrice_workbench_file_policies set reference_source_id=${replacement.sourceId},revision=2 where object_id=${files[0]!}`;
      const latest = (
        await readWorkbenchFileCatalog(owner, {
          workspaceId: owner.workspaceId,
        })
      ).files[0]!;
      expect(latest.reference!.checksum).toBe(latest.checksum);
      expect(latest.reference!.sourceId).not.toBe(originalRef.sourceId);
      const old = await getReferenceFile(
        owner,
        owner.workspaceId,
        originalRef.revisionId,
      );
      expect(await new Response(await storage().get(old.object)).text()).toBe(
        'Version one original bytes',
      );
      const newest = await getReferenceFile(
        owner,
        owner.workspaceId,
        replacement.revisionId,
      );
      expect(
        await new Response(await storage().get(newest.object)).text(),
      ).toBe('Version two changed bytes');
      await expect(
        getReferenceFile(reader, reader.workspaceId, originalRef.revisionId),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        await listReferenceRevisions(owner, owner.workspaceId),
      ).toHaveLength(1);
      expect(
        await fixture.db`select id from allrice_deliverable_versions where series_id=${seriesId}`,
      ).toHaveLength(2);
      const [session] =
        await fixture.db`select visibility from allrice_chat_sessions where id=${synthetic.task.chatSessionId}`;
      expect(session?.visibility).toBe('private');
    });
    it('keeps canonical personal snapshots and legacy library flags without granting colleagues original access', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      const ref = await captureWorkbenchFileReference(
        t.owner,
        t.owner.workspaceId!,
        file.objectId,
        randomUUID(),
        storage(),
      );
      await fixture.db`update allrice_workbench_file_policies set scope='company',reference_enabled=true,reference_source_id=${ref.sourceId},revision=2 where object_id=${file.objectId}`;
      const catalog = await readWorkbenchFileCatalog(t.owner, {
        workspaceId: t.owner.workspaceId!,
      });
      expect(catalog.files).toHaveLength(1);
      expect(catalog.files[0]).toMatchObject({
        objectId: file.objectId,
        isReference: true,
        reference: { revision: 1 },
      });
      expect(
        (
          await captureWorkbenchFileReference(
            t.owner,
            t.owner.workspaceId!,
            file.objectId,
            randomUUID(),
            storage(),
          )
        ).revisionId,
      ).toBe(ref.revisionId);
      expect(
        await fixture.db`select id from allrice_knowledge_revisions where knowledge_source_id=${ref.sourceId}`,
      ).toHaveLength(1);
      expect(
        await listReferenceRevisions(t.owner, t.owner.workspaceId!),
      ).toHaveLength(1);
      expect(await listReferenceRevisions(t.a, t.a.workspaceId!)).toHaveLength(
        0,
      );
      expect(
        (await readWorkbenchFileCatalog(t.a, { workspaceId: t.a.workspaceId! }))
          .files,
      ).toEqual([]);
      // This models historical unmarked rows; it is not an exposed write API.
      await fixture.db`update allrice_workbench_file_policies set reference_enabled=false where object_id=${file.objectId}`;
      expect(
        await listReferenceRevisions(t.owner, t.owner.workspaceId!),
      ).toHaveLength(0);
      expect((await readWorkbenchFile(t.owner, file.objectId)).object.id).toBe(
        file.objectId,
      );
      expect(
        (await getReferenceFile(t.owner, t.owner.workspaceId!, ref.revisionId))
          .object.id,
      ).not.toBe(file.objectId);
      await expect(readWorkbenchFile(t.a, file.objectId)).rejects.toMatchObject(
        { code: 'not_found' },
      );
    });
    it('uses current owner membership while archived legacy department targets never authorize another reader', async () => {
      const t = await setup(),
        file = await uploadWorkbenchFile(
          t.owner,
          uploadInput(t.owner),
          storage(),
        );
      await seedLegacySharing(file.objectId, {
        scope: 'departments',
        departmentIds: [t.departments[0]!],
      });
      await fixture.db`update allrice_memberships set active=false where user_id=${t.a.actor.id}`;
      await expect(readWorkbenchFile(t.a, file.objectId)).rejects.toMatchObject(
        { code: 'authorization_denied' },
      );
      await fixture.db`update allrice_departments set archived_at=clock_timestamp() where id=${t.departments[0]!}`;
      await expect(
        readWorkbenchFile(t.maintainer, file.objectId),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect((await readWorkbenchFile(t.owner, file.objectId)).object.id).toBe(
        file.objectId,
      );
      await fixture.db`update allrice_memberships set active=false where user_id=${t.owner.actor.id}`;
      await expect(
        readWorkbenchFile(t.owner, file.objectId),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it.each(['company', 'departments'] as const)(
      'preserves new retained publication %s audience while its original stays personal',
      async (scope) => {
        const t = await setup(),
          file = await uploadWorkbenchFile(
            t.owner,
            uploadInput(t.owner),
            storage(),
          );
        const publication = await publishReference(
          t.owner,
          {
            workspaceId: t.owner.workspaceId,
            requestId: randomUUID(),
            origin: 'file',
            objectId: file.objectId,
            purpose: '确认后的收入统计口径',
            audience: {
              scope,
              departmentIds: scope === 'departments' ? [t.departments[0]!] : [],
            },
          },
          storage(),
        );
        const retained = await getReferenceFile(
          t.a,
          t.a.workspaceId!,
          publication.revisionId,
        );
        expect(retained.object.id).not.toBe(file.objectId);
        expect(
          await new Response(await storage().get(retained.object)).text(),
        ).toBe('按已经确认的回款统计收入。');
        expect(
          (await referenceSourceAccess(t.owner, publication.sourceId)).access
            .canMaintain,
        ).toBe(true);
        expect(
          (await referenceSourceAccess(t.a, publication.sourceId)).access
            .canMaintain,
        ).toBe(false);
        if (scope === 'company') {
          expect(
            (
              await getReferenceFile(
                t.maintainer,
                t.maintainer.workspaceId!,
                publication.revisionId,
              )
            ).object.id,
          ).toBe(retained.object.id);
          expect(
            (await referenceSourceAccess(t.maintainer, publication.sourceId))
              .access.canMaintain,
          ).toBe(false);
        } else {
          for (const excluded of [t.b, t.maintainer])
            await expect(
              getReferenceFile(
                excluded,
                excluded.workspaceId!,
                publication.revisionId,
              ),
            ).rejects.toMatchObject({ code: 'not_found' });
        }
        await expect(
          readWorkbenchFile(t.a, file.objectId),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(getStoredFile(t.a, file.objectId)).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        await expect(
          getStoredFile(t.owner, retained.object.id),
        ).rejects.toMatchObject({ code: 'not_found' });
        await fixture.db`update allrice_memberships set active=false where user_id=${t.a.actor.id}`;
        await expect(
          getReferenceFile(t.a, t.a.workspaceId!, publication.revisionId),
        ).rejects.toMatchObject({ code: 'not_found' });
        expect(
          (
            await getReferenceFile(
              t.owner,
              t.owner.workspaceId!,
              publication.revisionId,
            )
          ).object.id,
        ).toBe(retained.object.id);
      },
    );
  },
);
