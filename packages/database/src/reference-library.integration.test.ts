import {
  captureReferenceSelections,
  retrieveSelectedReferenceKnowledge,
} from './reference-runtime.ts';
import { listKnowledgeSourceFilesForExecution } from './memory/knowledge-retrieval.ts';
import {
  getToolBrokerFile,
  listToolBrokerFiles,
} from './execution/tool-broker.ts';
import { linkWorkspaceFileToSession } from './workspace/service.ts';
import { assistantFixture } from './assistant-runtime.fixture.ts';
import {
  createKnowledgeSource,
  manageEmployeeCapabilities,
} from './capabilities/capability-registry.ts';
import { createStorageMetadata, markStorageReady } from './data.ts';
import type { ExecutionContext } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type {
  RequestContext,
  ReferenceUploadInput,
  SignedAccessGrant,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  authenticatePlatformSession,
} from './identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from './organization-administration.ts';
import { createOrganizationDepartment } from './organization-departments.ts';
import {
  prepareReferenceUpload,
  completeReferenceUpload,
  getReferenceFile,
  listReferenceRevisions,
  changeReference,
  referenceLibraryOptions,
} from './reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
  failReferenceProcessing,
} from './reference-processing.ts';
import {
  getStoredFile,
  prepareStorageDelete,
  completeStorageDelete,
  saveStorageGrant,
  resolveStorageGrant,
} from './data.ts';
import { listWorkspaceFiles } from './workspace/service.ts';
import {
  listCapabilityCatalog,
  publishKnowledgeRevision,
  updateCapabilityStatus,
} from './capabilities/capability-registry.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'fixed reference files share by current ownership, not original Session or workspace',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      admin: RequestContext;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const p = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control Plane',
        email: 'reference-admin@example.test',
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
      await f?.close();
    }, 30000);
    async function setup() {
      const company = await createManagedOrganization(admin, {
        name: 'Reference-' + randomUUID(),
      });
      const d = (
        await createOrganizationDepartment(admin, company.organizationId, {
          name: '财务',
          requestId: randomUUID(),
        })
      ).department;
      const other = (
        await createOrganizationDepartment(admin, company.organizationId, {
          name: '运营',
          requestId: randomUUID(),
        })
      ).department;
      const { created } = await importOrganizationPeople(
        admin,
        company.organizationId,
        {
          people: [
            {
              username: 'ref-' + randomUUID(),
              displayName: '维护',
              departmentId: d.id,
              contentMaintenanceLevel: 'company',
            },
            {
              username: 'ref-' + randomUUID(),
              displayName: '同部',
              departmentId: d.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: 'ref-' + randomUUID(),
              displayName: '他部',
              departmentId: other.id,
              contentMaintenanceLevel: 'department',
            },
          ],
        },
      );
      const users = await Promise.all(
        created.map(async (p) => ({
          ...(await authenticateSession(
            (await createSession(p.userId)).token,
          ))!,
          workspaceId: company.defaultWorkspaceId,
        })),
      );
      return {
        company,
        d,
        other,
        owner: users[0]!,
        reader: users[1]!,
        otherReader: users[2]!,
      };
    }
    const input = (
      context: RequestContext,
      scope: ReferenceUploadInput['scope'] = 'personal',
      extra: Partial<ReferenceUploadInput> = {},
    ): ReferenceUploadInput => ({
      workspaceId: context.workspaceId!,
      requestId: randomUUID(),
      scope,
      fileName: '季度口径.txt',
      purpose: '季度收入按已确认回款统计',
      mediaType: 'text/plain',
      contentBase64: Buffer.from(
        '季度收入按已确认回款统计。预算为一千元。',
      ).toString('base64'),
      ...extra,
    });
    async function upload(c: RequestContext, v = input(c)) {
      const p = await prepareReferenceUpload(c, v);
      await assistantFixtureStorage(f.db).put(
        p.object,
        new Blob([new Uint8Array(p.bytes)]).stream(),
      );
      await completeReferenceUpload(c, v.workspaceId, p.revisionId);
      return p;
    }
    async function act(
      c: RequestContext,
      p: { sourceId: string },
      action: 'retry' | 'archive' | 'restore',
      revision = 1,
    ) {
      return changeReference(c, p.sourceId, {
        workspaceId: c.workspaceId,
        requestId: randomUUID(),
        expectedRevision: revision,
        action,
      });
    }

    it('uploads once, processes the same fixed revision and permits another company workspace to download exact bytes', async () => {
      const a = await setup(),
        v = input(a.owner, 'company'),
        p = await upload(a.owner, v);
      const replay = await prepareReferenceUpload(a.owner, v);
      expect(replay.object.id).toBe(p.object.id);
      expect(replay.alreadyReady).toBe(true);
      const [w] =
        await f.db`insert into allrice_workspaces(organization_id,slug,name) values(${a.company.organizationId},${'other-' + randomUUID()},'Other') returning id`;
      await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${a.company.organizationId},${w!.id},${a.reader.actor.id},'member')`;
      const reader = { ...a.reader, workspaceId: w!.id as string };
      expect(
        (await listReferenceRevisions(reader, reader.workspaceId!)).find(
          (r) => r.revisionId === p.revisionId,
        )?.revisionId,
      ).toBe(p.revisionId);
      const file = await getReferenceFile(
        reader,
        reader.workspaceId!,
        p.revisionId,
      );
      expect(file.object.id).toBe(p.object.id);
      expect(
        await new Response(
          await assistantFixtureStorage(f.db).get(file.object),
        ).text(),
      ).toContain('一千元');
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(p.revisionId);
      await finishReferenceProcessing(claim!, [
        {
          content: '季度收入按已确认回款统计。预算为一千元。',
          start: 0,
          end: 24,
        },
      ]);
      expect(
        (await listReferenceRevisions(reader, reader.workspaceId!))[0]
          ?.processing,
      ).toBe('ready');
      const selected = await f.db.begin((tx) =>
        captureReferenceSelections(reader, [p.revisionId], tx),
      );
      const retrieved = await retrieveSelectedReferenceKnowledge({
        context: reader,
        selections: selected,
        query: '预算',
      });
      expect(retrieved[0]!.content).toContain('一千元');
      expect(retrieved[0]!.citation.reference?.revisionId).toBe(p.revisionId);

      expect(
        (
          await f.db`select count(*)::int n from allrice_knowledge_documents where knowledge_revision_id=${p.revisionId}`
        )[0]?.n,
      ).toBe(1);
      expect(
        (
          await f.db`select count(*)::int n from allrice_runs where organization_id=${a.company.organizationId}`
        )[0]?.n,
      ).toBe(0);
      await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${a.company.organizationId},${w!.id},${a.owner.actor.id},'member')`;
      const updater = { ...a.owner, workspaceId: w!.id as string };
      const later = await upload(
        updater,
        input(updater, 'company', {
          sourceId: p.sourceId,
          expectedRevision: 1,
          contentBase64: Buffer.from('V2_OTHER_WORKSPACE').toString('base64'),
        }),
      );
      const laterClaim = await claimReferenceProcessing();
      expect(laterClaim?.revisionId).toBe(later.revisionId);
      await finishReferenceProcessing(laterClaim!, [
        { content: 'V2_OTHER_WORKSPACE', start: 0, end: 18 },
      ]);
      const [document] =
        await f.db`select storage_object_id from allrice_knowledge_documents where knowledge_revision_id=${later.revisionId}`;
      expect(document!.storage_object_id).toBeNull();
      const laterPins = await f.db.begin((tx) =>
        captureReferenceSelections(a.reader, [later.revisionId], tx),
      );
      expect(
        (
          await retrieveSelectedReferenceKnowledge({
            context: a.reader,
            selections: laterPins,
            query: 'V2',
          })
        )[0]!.content,
      ).toBe('V2_OTHER_WORKSPACE');
    });
    it('publishes platform material only through a current control-plane administrator and shares exact versions across companies', async () => {
      const platform = (await authenticatePlatformSession(
        (await createSession(admin.actor.id)).token,
      ))!;
      expect(platform.memberships).toEqual([]);
      const p = await upload(platform, input(platform, 'platform'));
      expect(
        (await referenceLibraryOptions(platform, platform.workspaceId!))
          .platformMaintainer,
      ).toBe(true);
      const platformClaim = await claimReferenceProcessing();
      expect(platformClaim?.revisionId).toBe(p.revisionId);
      await finishReferenceProcessing(platformClaim!, [
        { content: 'PLATFORM_REFERENCE_93', start: 0, end: 21 },
      ]);
      for (const a of [await setup(), await setup()]) {
        expect(
          (await listReferenceRevisions(a.reader, a.reader.workspaceId!)).find(
            (r) => r.revisionId === p.revisionId,
          )?.canMaintain,
        ).toBe(false);
        expect(
          (
            await getReferenceFile(
              a.reader,
              a.reader.workspaceId!,
              p.revisionId,
            )
          ).object.id,
        ).toBe(p.object.id);
        const pins = await f.db.begin((tx) =>
          captureReferenceSelections(a.reader, [p.revisionId], tx),
        );
        expect(
          (
            await retrieveSelectedReferenceKnowledge({
              context: a.reader,
              selections: pins,
              query: '平台',
            })
          )[0]!.content,
        ).toBe('PLATFORM_REFERENCE_93');
        await expect(
          prepareReferenceUpload(a.owner, input(a.owner, 'platform')),
        ).rejects.toThrow('authorization_denied');
        await expect(act(a.owner, p, 'archive')).rejects.toThrow('not_found');
        const personal = await upload(a.owner);
        await expect(
          getReferenceFile(
            platform,
            platform.workspaceId!,
            personal.revisionId,
          ),
        ).rejects.toThrow('not_found');
      }
      await act(platform, p, 'archive');
      expect(
        (await listReferenceRevisions(platform, platform.workspaceId!)).find(
          (r) => r.revisionId === p.revisionId,
        )?.status,
      ).toBe('archived');
      await act(platform, p, 'restore');
      await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${platform.sessionId}`;
      await expect(act(platform, p, 'archive')).rejects.toThrow('not_found');
    });
    it('rejects private, foreign-department and foreign-company reads and unauthorized shared writes', async () => {
      const a = await setup(),
        foreign = await setup();
      const personal = await upload(a.owner),
        department = await upload(
          a.owner,
          input(a.owner, 'department', { departmentId: a.d.id }),
        );
      for (const [c, p] of [
        [a.reader, personal],
        [a.otherReader, department],
        [foreign.owner, department],
      ] as const) {
        await expect(
          getReferenceFile(c, c.workspaceId!, p.revisionId),
        ).rejects.toThrow('not_found');
        expect(
          (await listReferenceRevisions(c, c.workspaceId!)).some(
            (r) => r.revisionId === p.revisionId,
          ),
        ).toBe(false);
      }
      expect(
        (
          await getReferenceFile(
            a.reader,
            a.reader.workspaceId!,
            department.revisionId,
          )
        ).object.id,
      ).toBe(department.object.id);
      await expect(
        prepareReferenceUpload(a.reader, input(a.reader, 'company')),
      ).rejects.toThrow('authorization_denied');
      await expect(
        prepareReferenceUpload(
          a.otherReader,
          input(a.otherReader, 'department', { departmentId: a.d.id }),
        ),
      ).rejects.toThrow('authorization_denied');
      await expect(
        prepareReferenceUpload(
          a.owner,
          input(a.owner, 'department', { departmentId: foreign.d.id }),
        ),
      ).rejects.toThrow('authorization_denied');
      expect(
        (await referenceLibraryOptions(a.reader, a.reader.workspaceId!))
          .maintenanceLevel,
      ).toBe('personal');
    });
    it('keeps retained objects out of ordinary file/list/delete/sign routes even for the uploader and after deactivation', async () => {
      const a = await setup(),
        p = await upload(a.owner, input(a.owner, 'company'));
      const grant: SignedAccessGrant = {
        objectId: p.object.id,
        subjectId: a.owner.actor.id,
        operation: 'read',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        nonce: randomUUID(),
      };
      await f.db`insert into allrice_storage_access_grants(nonce,object_id,subject_id,operation,expires_at) values(${grant.nonce},${grant.objectId},${grant.subjectId},'read',${grant.expiresAt})`;
      for (const archived of [false, true]) {
        if (archived) await act(a.owner, p, 'archive');
        await expect(getStoredFile(a.owner, p.object.id)).rejects.toThrow(
          'not_found',
        );
        await expect(
          prepareStorageDelete(a.owner, p.object.id),
        ).rejects.toThrow('not_found');
        await expect(
          completeStorageDelete(a.owner, p.object.id),
        ).rejects.toThrow('not_found');
        await expect(saveStorageGrant(a.owner, grant)).rejects.toThrow(
          'not_found',
        );
        await expect(resolveStorageGrant(grant)).rejects.toThrow(
          'grant_invalid',
        );
        expect(
          (await listWorkspaceFiles(a.owner, a.owner.workspaceId!)).some(
            (r) => r.id === p.object.id,
          ),
        ).toBe(false);
      }
      await expect(
        getReferenceFile(a.owner, a.owner.workspaceId!, p.revisionId),
      ).rejects.toThrow('not_found');
    });
    it('does not let old platform-admin capability routes mutate the ownership-governed source', async () => {
      const a = await setup(),
        p = await upload(a.owner);
      const [user] =
        await f.db`select email from allrice_users where id=${a.owner.actor.id}`;
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        'reference-admin@example.test,' + user!.email,
      );
      expect(
        (
          await listCapabilityCatalog(a.owner, a.owner.workspaceId!)
        ).knowledge.some((r) => r.knowledgeSourceId === p.sourceId),
      ).toBe(false);
      await expect(
        updateCapabilityStatus(a.owner, p.sourceId, {
          workspaceId: a.owner.workspaceId,
          kind: 'knowledge',
          status: 'archived',
        }),
      ).rejects.toThrow('not_found');
      await expect(
        publishKnowledgeRevision(a.owner, p.sourceId, {
          workspaceId: a.owner.workspaceId,
          definition: {
            schemaVersion: 1,
            sourceKind: 'workspace_files',
            resourceRef: 'workspace',
            allowedScopes: ['organization'],
          },
          acl: [
            {
              principalType: 'organization',
              principalId: a.company.organizationId,
              permission: 'read',
            },
          ],
        }),
      ).rejects.toThrow('not_found');
    });
    it('rejects retained files through legacy broad Knowledge, bindings, tool readers and attachment linking', async () => {
      const a = await assistantFixture(f.db);
      const c = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.context.workspaceId,
      };
      const [user] =
        await f.db`select email from allrice_users where id=${c.actor.id}`;
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        'reference-admin@example.test,' + user!.email,
      );
      const retained = await upload(c);
      const ordinary = await createStorageMetadata(c, {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        category: 'uploads',
        mediaType: 'text/plain',
        sizeBytes: retained.object.sizeBytes,
        checksum: retained.object.checksum,
        visibility: 'private',
        immutable: false,
        retentionUntil: null,
      });
      await assistantFixtureStorage(f.db).put(
        ordinary.object,
        new Blob([new Uint8Array(retained.bytes)]).stream(),
      );
      await markStorageReady(c, ordinary.object.id);
      const [employee] =
        await f.db`select id from allrice_employees where organization_id=${c.organizationId} limit 1`;
      const legacy = await createKnowledgeSource(c, {
        workspaceId: c.workspaceId,
        slug: 'legacy-workspace',
        name: 'Legacy workspace',
        description: 'Existing wildcard',
        definition: {
          schemaVersion: 1,
          sourceKind: 'workspace_files',
          resourceRef: 'workspace',
          allowedScopes: ['user'],
        },
        acl: [
          {
            principalType: 'user',
            principalId: c.actor.id,
            permission: 'read',
          },
        ],
      });
      await manageEmployeeCapabilities(c, {
        workspaceId: c.workspaceId,
        employeeId: employee!.id,
        knowledgeRevisionIds: [legacy.id],
      });
      await expect(
        manageEmployeeCapabilities(c, {
          workspaceId: c.workspaceId,
          employeeId: employee!.id,
          knowledgeRevisionIds: [retained.revisionId],
        }),
      ).rejects.toThrow('invalid_binding');
      const execution: ExecutionContext = {
        executionId: randomUUID(),
        runId: a.task.runId,
        jobId: a.worker.jobId,
        worker: { id: a.worker.workerId, type: 'worker' },
        delegatedBy: { type: 'user', id: c.actor.id },
        organizationId: c.organizationId,
        workspaceId: c.workspaceId,
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: randomUUID(),
          organizationId: c.organizationId,
          subjectId: c.actor.id,
          version: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          memberships: c.memberships,
          grants: [
            {
              resourceType: 'storage_object',
              action: 'resource:read',
              workspaceId: c.workspaceId,
            },
          ],
        },
      };
      const files = await listKnowledgeSourceFilesForExecution({
        context: execution,
        employeeId: employee!.id,
        knowledgeRevisionIds: [legacy.id],
      });
      expect(files.map((f) => f.object.id)).toContain(ordinary.object.id);
      expect(files.map((f) => f.object.id)).not.toContain(retained.object.id);
      expect(
        (await getToolBrokerFile(execution, ordinary.object.id)).object.id,
      ).toBe(ordinary.object.id);
      await expect(
        getToolBrokerFile(execution, retained.object.id),
      ).rejects.toThrow('not_found');
      expect(
        (await listToolBrokerFiles(execution, 50)).map((f) => f.id),
      ).not.toContain(retained.object.id);
      await expect(
        linkWorkspaceFileToSession({
          context: c,
          workspaceId: c.workspaceId!,
          sessionId: a.task.chatSessionId!,
          objectId: retained.object.id,
        }),
      ).rejects.toThrow('authorization_denied');
    });
    it('does not rewrite v1 when v2 fails, and retry/restart uses the same file and revision', async () => {
      // Finish unrelated saved fixtures to keep the worker queue deterministic.
      for (let n = 0; n < 30; n++) {
        const c = await claimReferenceProcessing();
        if (!c) break;
        await failReferenceProcessing(c, 'controlled');
      }
      const a = await setup(),
        one = await upload(a.owner),
        first = await claimReferenceProcessing();
      expect(first!.revisionId).toBe(one.revisionId);
      await finishReferenceProcessing(first!, [
        { content: '第一版', start: 0, end: 3 },
      ]);
      const two = await upload(
        a.owner,
        input(a.owner, 'personal', {
          sourceId: one.sourceId,
          expectedRevision: 1,
          contentBase64: Buffer.from('第二版').toString('base64'),
        }),
      );
      const failed = await claimReferenceProcessing();
      expect(failed!.revisionId).toBe(two.revisionId);
      await failReferenceProcessing(failed!, 'controlled read failure');
      let history = await listReferenceRevisions(
        a.owner,
        a.owner.workspaceId!,
        one.sourceId,
      );
      expect(history.map((r) => r.processing)).toEqual(['failed', 'ready']);
      await act(a.owner, two, 'retry', 2);
      const expired = await claimReferenceProcessing();
      expect(expired!.object.id).toBe(two.object.id);
      await f.db`update allrice_knowledge_processing set lease_until=clock_timestamp()-interval '1 second' where revision_id=${two.revisionId}`;
      const recovered = await claimReferenceProcessing();
      expect(recovered!.object.id).toBe(two.object.id);
      expect(recovered!.token).not.toBe(expired!.token);
      await expect(
        finishReferenceProcessing(expired!, [
          { content: '不能晚到覆盖', start: 0, end: 6 },
        ]),
      ).rejects.toThrow();
      await finishReferenceProcessing(recovered!, [
        { content: '第二版', start: 0, end: 3 },
      ]);
      history = await listReferenceRevisions(
        a.owner,
        a.owner.workspaceId!,
        one.sourceId,
      );
      expect(history.map((r) => r.processing)).toEqual(['ready', 'ready']);
      const [old] =
        await f.db`select c.content from allrice_knowledge_chunks c join allrice_knowledge_documents d on d.id=c.document_id where d.knowledge_revision_id=${one.revisionId}`;
      expect(old!.content).toBe('第一版');
      expect(
        (await getReferenceFile(a.owner, a.owner.workspaceId!, one.revisionId))
          .object.checksum,
      ).toBe(one.object.checksum);
    });
    it('serializes duplicate uploads and rejects request substitution, stale updates and immutable manifest changes', async () => {
      const a = await setup(),
        v = input(a.owner),
        [p, q] = await Promise.all([
          prepareReferenceUpload(a.owner, v),
          prepareReferenceUpload(a.owner, v),
        ]);
      expect(p.revisionId).toBe(q.revisionId);
      await expect(
        prepareReferenceUpload(a.owner, { ...v, fileName: 'changed.txt' }),
      ).rejects.toThrow('request_conflict');
      await expect(
        prepareReferenceUpload(
          a.owner,
          input(a.owner, 'personal', {
            sourceId: p.sourceId,
            expectedRevision: 2,
          }),
        ),
      ).rejects.toThrow('version_conflict');
      await expect(
        f.db`update allrice_knowledge_revisions set file_name='changed.txt' where id=${p.revisionId}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_knowledge_sources set ownership=${f.db.json({ scope: 'company', organizationId: a.company.organizationId })} where id=${p.sourceId}`,
      ).rejects.toThrow('immutable');
    });
    it('rechecks current department and active identity instead of trusting cached memberships', async () => {
      const a = await setup(),
        p = await upload(
          a.owner,
          input(a.owner, 'department', { departmentId: a.d.id }),
        );
      await getReferenceFile(a.reader, a.reader.workspaceId!, p.revisionId);
      await f.db`update allrice_organization_people set department_id=${a.other.id} where organization_id=${a.company.organizationId} and user_id=${a.reader.actor.id}`;
      await expect(
        getReferenceFile(a.reader, a.reader.workspaceId!, p.revisionId),
      ).rejects.toThrow('not_found');
      await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${a.owner.sessionId}`;
      await expect(
        getReferenceFile(a.owner, a.owner.workspaceId!, p.revisionId),
      ).rejects.toThrow('not_found');
    });
    it('cannot finish an index after archive, or reapply an old archive request after restoration', async () => {
      for (let n = 0; n < 30; n++) {
        const c = await claimReferenceProcessing();
        if (!c) break;
        await failReferenceProcessing(c, 'controlled');
      }
      const a = await setup(),
        p = await upload(a.owner),
        claim = await claimReferenceProcessing();
      expect(claim!.revisionId).toBe(p.revisionId);
      const action = {
        workspaceId: a.owner.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'archive',
      };
      await changeReference(a.owner, p.sourceId, action);
      await expect(
        finishReferenceProcessing(claim!, [
          { content: '不复活', start: 0, end: 3 },
        ]),
      ).rejects.toThrow('资料已停用');
      await failReferenceProcessing(claim!, '资料已停用');
      await act(a.owner, p, 'restore');
      await changeReference(a.owner, p.sourceId, action);
      expect(
        (
          await listReferenceRevisions(
            a.owner,
            a.owner.workspaceId!,
            p.sourceId,
          )
        )[0]!.status,
      ).toBe('active');
      expect(
        (
          await f.db`select count(*)::int n from allrice_knowledge_documents where knowledge_revision_id=${p.revisionId}`
        )[0]!.n,
      ).toBe(0);
    });
  },
);
