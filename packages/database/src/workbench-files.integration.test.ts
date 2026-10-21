import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, WorkbenchFileSharing } from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
  assistantFixture,
} from './assistant-runtime.fixture.ts';
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
  listWorkbenchFileVersions,
  updateWorkbenchFile,
  uploadWorkbenchFile,
} from './workbench-files.ts';
import {
  getReferenceFile,
  listReferenceRevisions,
} from './reference-library.ts';
import { readReferenceSelection } from './reference-runtime.ts';
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
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let platform: RequestContext;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
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
    const storage = () => assistantFixtureStorage(fixture.db);
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
      const synthetic = await assistantFixture(fixture.db),
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
          category: 'exports',
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
