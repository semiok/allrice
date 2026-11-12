import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ReferenceAudience,
  RequestContext,
  StoragePort,
  SignedAccessGrant,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from './organization-administration.ts';
import { createOrganizationDepartment } from './organization-departments.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from './tenant-employees.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import {
  createStorageMetadata,
  markStorageReady,
  getStoredFile,
  prepareStorageDelete,
  resolveStorageGrant,
  saveStorageGrant,
} from './data.ts';
import { markFinalDeliveryRootLocked } from './final-delivery-commit.ts';
import { readFinalDeliveryReferences } from './final-delivery-references.ts';
import { appendJobEvent } from './execution/queue.ts';
import {
  publishReference,
  changeReferencePublication,
  listReferencePublications,
  getReferenceFile,
  prepareReferenceUpload,
  changeReference,
} from './reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from './reference-processing.ts';
import {
  assertReferenceSelections,
  captureReferenceSelections,
  hasRevokedReferencePublicationHistory,
} from './reference-runtime.ts';
import { readWorkbenchFile, updateWorkbenchFile } from './workbench-files.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
  getChatSessionHistory,
} from './workspace/service.ts';
import {
  acquireConversationRuntime,
  releaseConversationRuntime,
} from './conversation/conversation-runtime.ts';
import {
  prepareEmployeeContentContext,
  assertEmployeeContentContext,
  loadEmployeeRuntimeReferences,
  assertEmployeeContentReferenceMessages,
} from './employees/employee-runtime-content.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';

const browser = vi.hoisted(() => ({
  context: null as RequestContext | null,
  storage: null as StoragePort | null,
}));
vi.mock('../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
vi.mock('../../../apps/web/lib/storage/runtime', () => ({
  getStorageAdapter: () => browser.storage!,
}));

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-247 new publication: member publishing, live audience and irreversible withdrawal',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let admin: RequestContext;
    let employee: Awaited<
      ReturnType<typeof createEmployeeAdministrationFixture>
    >;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      browser.storage = runtimeFixtureStorage(f.db);
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'publication-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      admin = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
      employee = await createEmployeeAdministrationFixture(f.db);
      await employee.preview();
      expect((await employee.publish()).valid).toBe(true);
    }, 120000);
    afterAll(async () => {
      browser.context = null;
      browser.storage = null;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);

    async function setup() {
      const company = await createManagedOrganization(admin, {
        name: 'Publication-' + randomUUID(),
      });
      const departments = [];
      for (const name of ['Owner team', 'Finance', 'Operations'])
        departments.push(
          (
            await createOrganizationDepartment(admin, company.organizationId, {
              name,
              requestId: randomUUID(),
            })
          ).department,
        );
      const people = (
        await importOrganizationPeople(admin, company.organizationId, {
          people: [
            {
              username: 'publisher-' + randomUUID(),
              displayName: 'Publisher',
              departmentId: departments[0]!.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: 'finance-' + randomUUID(),
              displayName: 'Finance reader',
              departmentId: departments[1]!.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: 'operations-' + randomUUID(),
              displayName: 'Operations reader',
              departmentId: departments[2]!.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: 'maintainer-' + randomUUID(),
              displayName: 'Company maintainer',
              departmentId: departments[0]!.id,
              contentMaintenanceLevel: 'company',
            },
          ],
        })
      ).created;
      const users = await Promise.all(
        people.map(
          async (person) =>
            (await authenticateSession(
              (await createSession(person.userId)).token,
              {
                organizationId: company.organizationId,
                workspaceId: company.defaultWorkspaceId,
              },
            ))!,
        ),
      );
      return {
        company,
        departments,
        owner: users[0]!,
        finance: users[1]!,
        operations: users[2]!,
        maintainer: users[3]!,
      };
    }
    const upload = (
      context: RequestContext,
      audience: ReferenceAudience = { scope: 'company', departmentIds: [] },
    ) => ({
      workspaceId: context.workspaceId!,
      requestId: randomUUID(),
      origin: 'upload' as const,
      audience,
      fileName: '已确认口径.txt',
      purpose: '核对预算金额',
      mediaType: 'text/plain',
      contentBase64: Buffer.from('预算金额为873元。').toString('base64'),
    });
    const file = (reader: RequestContext, revisionId: string) =>
      getReferenceFile(reader, reader.workspaceId!, revisionId);
    const change = (
      context: RequestContext,
      sourceId: string,
      action: 'revoke' | 'delete' | 'audience',
      expectedRevision = 1,
      audience?: ReferenceAudience,
      requestId = randomUUID(),
    ) =>
      changeReferencePublication(context, sourceId, {
        workspaceId: context.workspaceId,
        requestId,
        expectedRevision,
        action,
        ...(audience ? { audience } : {}),
      });
    async function ready(revisionId: string) {
      // Drain exact pending records through the existing real processor API;
      // no schema fixture fabricates ready state or retrieval receipts.
      for (;;) {
        const claim = await claimReferenceProcessing();
        if (!claim) throw Error('Expected pending reference');
        const content = (
          await readArtifactBytes(browser.storage!, claim.object)
        ).toString('utf8');
        await finishReferenceProcessing(claim, [
          { content, start: 0, end: content.length },
        ]);
        if (claim.revisionId === revisionId) return;
      }
    }
    async function httpUpload(
      context: RequestContext,
      input = upload(context),
    ) {
      browser.context = context;
      const route =
        await import('../../../apps/web/app/api/v1/references/publications/route.ts');
      const response = await route.POST(
        new Request('https://example.test/api/v1/references/publications', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://example.test',
          },
          body: JSON.stringify(input),
        }),
      );
      expect(response.status).toBe(201);
      return (await response.json()) as {
        sourceId: string;
        revisionId: string;
      };
    }

    it('“把这份口径发布给财务和运营” uses the real HTTP command; an ordinary member may choose both other departments without approval', async () => {
      const s = await setup();
      const input = upload(s.owner, {
        scope: 'departments',
        departmentIds: [s.departments[2]!.id, s.departments[1]!.id],
      });
      const published = await httpUpload(s.owner, input);
      expect(await httpUpload(s.owner, input)).toEqual(published);
      for (const reader of [s.owner, s.finance, s.operations])
        expect((await file(reader, published.revisionId)).sourceId).toBe(
          published.sourceId,
        );
      await expect(
        file(s.maintainer, published.revisionId),
      ).rejects.toMatchObject({ code: 'not_found' });
      const list = await listReferencePublications(
        s.finance,
        s.finance.workspaceId!,
      );
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        sourceId: published.sourceId,
        canMaintain: false,
        origin: null,
        publication: {
          publisherId: s.owner.actor.id,
          publisherName: 'Publisher',
          audience: {
            scope: 'departments',
            departmentIds: [s.departments[1]!.id, s.departments[2]!.id].sort(),
          },
        },
      });
      expect(
        await listReferencePublications(
          s.maintainer,
          s.maintainer.workspaceId!,
        ),
      ).toEqual([]);
      browser.context = s.owner;
      const route =
        await import('../../../apps/web/app/api/v1/references/publications/route.ts');
      const options = await (
        await route.GET(
          new Request(
            `https://example.test/api/v1/references/publications?workspaceId=${s.owner.workspaceId}`,
          ),
        )
      ).json();
      expect(options.options.departments).toHaveLength(3);
      const crossOrigin = await route.POST(
        new Request('https://example.test/api/v1/references/publications', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://untrusted.example.test',
          },
          body: JSON.stringify({ ...input, requestId: randomUUID() }),
        }),
      );
      expect(crossOrigin.status).toBe(403);
      expect(await crossOrigin.text()).not.toContain(input.fileName);
      await expect(
        change(s.finance, published.sourceId, 'delete'),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        change(s.maintainer, published.sourceId, 'delete'),
      ).rejects.toMatchObject({ code: 'not_found' });
    }, 120000);

    it.each(['personal', 'company'] as const)(
      'allows an ordinary member to publish %s and checks current membership instead of caller role claims',
      async (scope) => {
        const s = await setup(),
          foreign = await setup();
        const published = await httpUpload(
          s.owner,
          upload(s.owner, { scope, departmentIds: [] }),
        );
        if (scope === 'company')
          expect((await file(s.finance, published.revisionId)).sourceId).toBe(
            published.sourceId,
          );
        else
          await expect(
            file(s.maintainer, published.revisionId),
          ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          file(foreign.owner, published.revisionId),
        ).rejects.toMatchObject({ code: 'not_found' });
        await f.db`update allrice_memberships set role='viewer' where user_id=${s.owner.actor.id} and organization_id=${s.owner.organizationId}`;
        await expect(
          publishReference(s.owner, upload(s.owner), browser.storage!),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          change(s.owner, published.sourceId, 'delete'),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await f.db`update allrice_memberships set active=false where user_id=${s.finance.actor.id} and organization_id=${s.finance.organizationId}`;
        await expect(
          file(s.finance, published.revisionId),
        ).rejects.toMatchObject({ code: 'not_found' });
      },
      120000,
    );

    it('updates only the retained audience; preserved readers keep exact pins, removed/moved/archived departments lose every read', async () => {
      const s = await setup();
      const published = await httpUpload(
        s.owner,
        upload(s.owner, {
          scope: 'departments',
          departmentIds: [s.departments[1]!.id, s.departments[2]!.id],
        }),
      );
      await ready(published.revisionId);
      const pins = await f.db.begin((tx) =>
        captureReferenceSelections(s.operations, [published.revisionId], tx),
      );
      const retained = await file(s.owner, published.revisionId);
      const actionId = randomUUID();
      const audience: ReferenceAudience = {
        scope: 'departments',
        departmentIds: [s.departments[2]!.id],
      };
      await change(
        s.owner,
        published.sourceId,
        'audience',
        1,
        audience,
        actionId,
      );
      expect(
        await change(
          s.owner,
          published.sourceId,
          'audience',
          1,
          audience,
          actionId,
        ),
      ).toEqual({ sourceId: published.sourceId });
      expect(
        await f.db.begin((tx) =>
          assertReferenceSelections(s.operations, pins, tx, true),
        ),
      ).toEqual(pins);
      expect((await file(s.operations, published.revisionId)).object.id).toBe(
        retained.object.id,
      );
      for (const read of [
        () => file(s.finance, published.revisionId),
        () => readWorkbenchFile(s.finance, retained.object.id),
      ])
        await expect(read()).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        change(s.owner, published.sourceId, 'audience', 1, {
          scope: 'company',
          departmentIds: [],
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      await f.db`update allrice_organization_people set department_id=${s.departments[0]!.id} where organization_id=${s.owner.organizationId} and user_id=${s.operations.actor.id}`;
      await expect(
        file(s.operations, published.revisionId),
      ).rejects.toMatchObject({ code: 'not_found' });
      await f.db`update allrice_departments set archived_at=clock_timestamp() where id=${s.departments[2]!.id}`;
      expect((await file(s.owner, published.revisionId)).object.id).toBe(
        retained.object.id,
      );
      await expect(
        change(s.owner, published.sourceId, 'audience', 2, audience),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const foreign = await setup();
      await expect(
        publishReference(
          s.owner,
          upload(s.owner, {
            scope: 'departments',
            departmentIds: [foreign.departments[0]!.id],
          }),
          browser.storage!,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }, 120000);

    it('copies an exact owned delivery once, leaves its original intact, and a new explicit publication after revoke has a new source identity', async () => {
      const a = await tenantValidationFixture(f.db);
      const owner = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.context.workspaceId,
      };
      const original = await getWorkbenchArtifact(
        owner,
        a.task.chatSessionId!,
        a.artifact.artifactId,
        f.db,
      );
      const [organization] =
        await f.db`select slug,name from allrice_organizations where id=${owner.organizationId}`;
      const readerPrincipal = await ensureBootstrapPortalPrincipal({
        organizationSlug: organization!.slug,
        organizationName: organization!.name,
        workspaceSlug: 'test',
        workspaceName: 'P25 fixture',
        email: randomUUID() + '@example.test',
        displayName: 'Read-only source user',
        role: 'member',
      });
      const reader = (await authenticateSession(
        (await createSession(readerPrincipal.user.id)).token,
        {
          organizationId: owner.organizationId,
          workspaceId: owner.workspaceId,
        },
      ))!;
      await f.db`insert into allrice_workbench_file_policies(object_id,organization_id,workspace_id,owner_id,file_name,scope)
        values(${original.object.id},${owner.organizationId},${owner.workspaceId},${owner.actor.id},'evidence.txt','company')`;
      expect(
        (await readWorkbenchFile(reader, original.object.id)).canMaintain,
      ).toBe(false);
      await expect(
        publishReference(
          reader,
          {
            workspaceId: reader.workspaceId,
            requestId: randomUUID(),
            origin: 'file',
            objectId: original.object.id,
            purpose: '',
            audience: { scope: 'company', departmentIds: [] },
          },
          browser.storage!,
        ),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      const input = {
        workspaceId: owner.workspaceId!,
        requestId: randomUUID(),
        origin: 'file' as const,
        objectId: original.object.id,
        purpose: 'Fixed source',
        audience: { scope: 'company' as const, departmentIds: [] },
      };
      const [one, duplicate] = await Promise.all([
        publishReference(owner, input, browser.storage!),
        publishReference(
          owner,
          { ...input, requestId: randomUUID() },
          browser.storage!,
        ),
      ]);
      expect(duplicate).toEqual(one);
      const retained = await file(owner, one.revisionId);
      expect(retained.object.id).not.toBe(original.object.id);
      expect(
        await readArtifactBytes(browser.storage!, retained.object),
      ).toEqual(await readArtifactBytes(browser.storage!, original.object));
      expect(
        await f.db`select source_id from allrice_workbench_reference_bindings where source_id=${one.sourceId}`,
      ).toHaveLength(0);
      await f.db`update allrice_storage_objects set visibility='private',state='deleted',deleted_at=clock_timestamp() where id=${original.object.id}`;
      expect((await file(owner, one.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
      expect(await publishReference(owner, input, browser.storage!)).toEqual(
        one,
      );
      await f.db`update allrice_storage_objects set state='ready',deleted_at=null where id=${original.object.id}`;
      await expect(change(owner, one.sourceId, 'delete')).rejects.toMatchObject(
        { code: 'source_unavailable' },
      );
      await change(owner, one.sourceId, 'revoke');
      expect(
        await readArtifactBytes(browser.storage!, original.object),
      ).toEqual(await readArtifactBytes(browser.storage!, retained.object));
      expect(await publishReference(owner, input, browser.storage!)).toEqual(
        one,
      );
      const republished = await publishReference(
        owner,
        { ...input, requestId: randomUUID() },
        browser.storage!,
      );
      expect(republished.sourceId).not.toBe(one.sourceId);
      await expect(file(owner, one.revisionId)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect((await file(owner, republished.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
      const [row] =
        await f.db`select status from allrice_knowledge_sources where id=${one.sourceId}`;
      expect(row!.status).toBe('archived');
      await change(owner, republished.sourceId, 'revoke');
      const interruptedInput = { ...input, requestId: randomUUID() };
      const underlying = browser.storage!;
      const lostAcknowledgement: StoragePort = {
        get: underlying.get.bind(underlying),
        exists: underlying.exists.bind(underlying),
        delete: underlying.delete.bind(underlying),
        put: async (object, stream) => {
          await underlying.put(object, stream);
          throw Error('SYNTHETIC_REFERENCE_PUT_ACK_LOST');
        },
      };
      await expect(
        publishReference(owner, interruptedInput, lostAcknowledgement),
      ).rejects.toThrow('SYNTHETIC_REFERENCE_PUT_ACK_LOST');
      const [interrupted] =
        await f.db`select r.id,s.id as source_id,o.state from allrice_knowledge_save_requests request
        join allrice_knowledge_revisions r on r.id=request.revision_id
        join allrice_knowledge_sources s on s.id=r.knowledge_source_id
        join allrice_storage_objects o on o.id=r.file_object_id where request.request_id=${interruptedInput.requestId}`;
      expect(interrupted!.state).toBe('pending');
      await f.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${original.object.id}`;
      const recovered = await publishReference(
        owner,
        interruptedInput,
        underlying,
      );
      expect(recovered).toEqual({
        sourceId: interrupted!.source_id,
        revisionId: interrupted!.id,
      });
      expect((await file(owner, recovered.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
    }, 120000);

    it('direct-upload delete closes preview/download, ordinary file/old mutation/grant bypasses, while preserving the immutable request receipt', async () => {
      const s = await setup(),
        input = upload(s.owner);
      const published = await httpUpload(s.owner, input);
      const retained = await file(s.owner, published.revisionId);
      await expect(
        prepareReferenceUpload(s.owner, {
          workspaceId: s.owner.workspaceId,
          requestId: randomUUID(),
          sourceId: published.sourceId,
          expectedRevision: 1,
          scope: 'personal',
          fileName: 'replacement.txt',
          purpose: '',
          mediaType: 'text/plain',
          contentBase64: input.contentBase64,
        }),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(
        updateWorkbenchFile(
          s.owner,
          retained.object.id,
          {
            workspaceId: s.owner.workspaceId,
            requestId: randomUUID(),
            expectedRevision: 1,
            sharing: { scope: 'personal', departmentIds: [] },
          },
          browser.storage!,
        ),
      ).rejects.toMatchObject({ code: 'invalid_file' });
      await expect(
        change(s.owner, published.sourceId, 'revoke'),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      const grant: SignedAccessGrant = {
        objectId: retained.object.id,
        subjectId: s.owner.actor.id,
        operation: 'read',
        nonce: randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      await expect(saveStorageGrant(s.owner, grant)).rejects.toMatchObject({
        code: 'not_found',
      });
      await f.db`insert into allrice_storage_access_grants(nonce,object_id,subject_id,operation,expires_at)
      values(${grant.nonce},${grant.objectId},${grant.subjectId},'read',${grant.expiresAt})`;
      await expect(resolveStorageGrant(grant)).rejects.toMatchObject({
        code: 'grant_invalid',
      });
      await expect(
        getStoredFile(s.owner, retained.object.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        prepareStorageDelete(s.owner, retained.object.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      browser.context = s.finance;
      const download =
        await import('../../../apps/web/app/api/v1/references/revisions/[id]/download/route.ts');
      const preview =
        await import('../../../apps/web/app/api/v1/references/revisions/[id]/preview/route.ts');
      const route = { params: Promise.resolve({ id: published.revisionId }) };
      const request = () =>
        new Request(
          `https://example.test/api/v1/references/revisions/${published.revisionId}/download?workspaceId=${s.finance.workspaceId}`,
        );
      expect(await (await download.GET(request(), route)).text()).toBe(
        '预算金额为873元。',
      );
      expect((await preview.GET(request(), route)).status).toBe(200);
      await change(s.owner, published.sourceId, 'delete');
      for (const get of [download.GET, preview.GET]) {
        const response = await get(request(), route);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(input.fileName);
      }
      await expect(
        readWorkbenchFile(s.owner, retained.object.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        await listReferencePublications(s.owner, s.owner.workspaceId!),
      ).toEqual([]);
      expect(await publishReference(s.owner, input, browser.storage!)).toEqual(
        published,
      );
      await expect(
        changeReference(s.owner, published.sourceId, {
          workspaceId: s.owner.workspaceId,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'restore',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        f.db`update allrice_knowledge_sources set status='active' where id=${published.sourceId}`,
      ).rejects.toThrow('cannot be restored');
      const [fact] =
        await f.db`select input from allrice_knowledge_reference_actions where source_id=${published.sourceId}`;
      expect(fact!.input.action).toBe('delete');
    }, 120000);

    async function runtimeRun(
      s: Awaited<ReturnType<typeof setup>>,
      referenceIds: string[] = [],
      sessionId?: string,
      imports: string[] = [],
    ) {
      const catalog = (
        await listAdminTenantEmployees(
          admin,
          s.owner.organizationId,
          s.owner.workspaceId!,
        )
      ).employees.find((item) => item.employeeId === employee.employeeId)!;
      if (!catalog.deployment)
        await changeAdminTenantEmployee(admin, s.owner.organizationId, {
          workspaceId: s.owner.workspaceId,
          employeeId: employee.employeeId,
          action: 'assign',
          revisionId: catalog.revisionId,
          expectedVersion: null,
        });
      const assigned = (
        await getEmployeeWorkspace(s.owner, s.owner.workspaceId!)
      ).employees.find((item) => item.employeeKey === employee.definition.key)!;
      const session = sessionId
        ? { id: sessionId }
        : await createChatSession(s.owner, {
            workspaceId: s.owner.workspaceId,
            employeeAssignmentId: assigned.id,
            title: '按资料核对预算',
          });
      const sent = await sendChatMessage(
        s.owner,
        s.owner.workspaceId!,
        session.id,
        {
          clientMessageId: randomUUID(),
          text: '请按资料核对预算金额',
          sessionReferenceIds: imports,
          ...(referenceIds.length
            ? { referenceRevisionIds: referenceIds }
            : {}),
          ...(referenceIds.length || imports.length
            ? { deliveryMode: 'follow_up' }
            : {}),
        },
      );
      const scope = {
        organizationId: s.owner.organizationId,
        workspaceId: s.owner.workspaceId!,
        ownerId: s.owner.actor.id,
        sessionId: session.id,
        runId: sent.run.id,
      };
      const execution = await resolveEmployeeExecution(scope);
      const runtime = await prepareEmployeeContentContext(scope);
      expect(runtime).not.toBeNull();
      return { scope, sent, execution, runtime: runtime! };
    }
    async function lease(run: Awaited<ReturnType<typeof runtimeRun>>) {
      const worker = {
        workerId: randomUUID(),
        jobId: '',
        leaseToken: randomUUID(),
      };
      const [job] =
        await f.db`update allrice_jobs set status='running',worker_id=${worker.workerId},lease_token=${worker.leaseToken},
      claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '10 minutes'
      where run_id=${run.scope.runId} returning id`;
      worker.jobId = job!.id;
      await f.db`update allrice_runs set state='running',started_at=clock_timestamp() where id=${run.scope.runId}`;
      await f.db`update allrice_employee_runs set status='running',started_at=clock_timestamp() where run_id=${run.scope.runId}`;
      await acquireConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        configChecksum: `sha256:${'c'.repeat(64)}`,
        compactThresholdTokens: 40000,
      });
      return worker;
    }
    async function finish(
      run: Awaited<ReturnType<typeof runtimeRun>>,
      worker?: { workerId: string },
    ) {
      if (worker)
        await releaseConversationRuntime({
          ...run.scope,
          workerId: worker.workerId,
          outcome: 'idle',
        });
      await f.db`update allrice_jobs set status='canceled',completed_at=clock_timestamp() where run_id=${run.scope.runId}`;
      await f.db`update allrice_runs set state='canceled',completed_at=clock_timestamp() where id=${run.scope.runId}`;
      await f.db`update allrice_employee_runs set status='canceled',completed_at=clock_timestamp() where run_id=${run.scope.runId}`;
    }

    it('new fixed file publications are authorized inputs and never mint parent authority over their original delivery', async () => {
      const s = await setup(),
        sourceRun = await runtimeRun(s);
      const body = Buffer.from('预算金额为873元。');
      const original = await createStorageMetadata(s.owner, {
        id: randomUUID(),
        workspaceId: s.owner.workspaceId,
        category: 'exports',
        mediaType: 'text/plain',
        sizeBytes: body.length,
        checksum: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        visibility: 'private',
        retentionUntil: null,
        immutable: true,
      });
      await browser.storage!.put(
        original.object,
        new Blob([new Uint8Array(body)]).stream(),
      );
      await markStorageReady(s.owner, original.object.id);
      const artifactId = randomUUID();
      await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
        values(${artifactId},${s.owner.organizationId},${s.owner.workspaceId},${s.owner.actor.id},${original.object.id},${randomUUID()},1,${sourceRun.scope.sessionId},'预算.txt','text')`;
      await f.db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
        values(${artifactId},${s.owner.organizationId},${s.owner.workspaceId},${s.owner.actor.id},${sourceRun.scope.runId},'document',
          ${f.db.json({ kind: 'tool_result', runId: sourceRun.scope.runId, operationId: null, stepId: null })},${randomUUID()},${original.object.checksum})`;
      await finish(sourceRun);
      const publication = await publishReference(
        s.owner,
        {
          workspaceId: s.owner.workspaceId,
          requestId: randomUUID(),
          origin: 'file',
          objectId: original.object.id,
          purpose: '',
          audience: { scope: 'company', departmentIds: [] },
        },
        browser.storage!,
      );
      await ready(publication.revisionId);
      const consumer = await runtimeRun(
        s,
        [publication.revisionId],
        sourceRun.scope.sessionId,
      );
      await f.db`update allrice_runs set state='running' where id=${consumer.scope.runId}`;
      const parents = await f.db.begin(async (tx) => {
        await tx`select id from allrice_runs where id=${consumer.scope.runId} for update`;
        markFinalDeliveryRootLocked(tx, consumer.scope.runId);
        return readFinalDeliveryReferences({
          transaction: tx,
          task: {
            scope: {
              organizationId: s.owner.organizationId,
              workspaceId: s.owner.workspaceId!,
              projectId: null,
            },
            runId: consumer.scope.runId,
            rootRunId: consumer.scope.runId,
            parentRunId: null,
            chatSessionId: consumer.scope.sessionId,
            frozenConfiguration: {
              employeeVersionId: null,
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
        });
      });
      expect(parents).toEqual([]);
      await finish(consumer);
    }, 120000);

    it('Q8: real concurrent withdrawal seals batched visible text while native drain and usage receipts remain writable', async () => {
      const s = await setup(),
        published = await httpUpload(s.owner);
      await ready(published.revisionId);
      const run = await runtimeRun(s, [published.revisionId]),
        worker = await lease(run);
      expect(
        await loadEmployeeRuntimeReferences(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).toHaveLength(1);
      await appendJobEvent({
        ...worker,
        type: 'assistant.text.delta',
        payload: { source: 'dsh', text: 'VISIBLE_BEFORE_WITHDRAWAL' },
      });
      function gate<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      }
      const locked = gate<number>(),
        release = gate<void>();
      const holder = f.db.begin(async (tx) => {
        await tx`select id from allrice_knowledge_sources where id=${published.sourceId} for share`;
        const [pid] = await tx`select pg_backend_pid() id`;
        locked.resolve(pid!.id);
        await release.promise;
      });
      const holderPid = await locked.promise;
      const withdrawing = change(s.owner, published.sourceId, 'delete').then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      let writing: Promise<unknown> | undefined;
      try {
        await expect
          .poll(
            async () =>
              (
                await f.db`select count(*)::int n from pg_stat_activity
          where ${holderPid}::int=any(pg_blocking_pids(pid))`
              )[0]!.n,
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        writing = appendJobEvent({
          ...worker,
          type: 'assistant.text.delta',
          payload: { source: 'dsh', text: 'VISIBLE_AFTER_WITHDRAWAL' },
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        // Observe the real publication gate waiting behind the queued writer,
        // rather than assuming a sleep establishes PostgreSQL lock order.
        await expect
          .poll(
            async () =>
              (
                await f.db`select count(*)::int n from pg_stat_activity
          where application_name=current_setting('application_name') and wait_event_type='Lock'
            and query like '%with recursive dependencies%'`
              )[0]!.n,
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
      } finally {
        release.resolve();
        await holder;
      }
      expect(await withdrawing).toEqual({
        result: { sourceId: published.sourceId },
      });
      expect(await writing).toMatchObject({
        error: { code: 'EMPLOYEE_CONTENT_UNAVAILABLE' },
      });
      await expect(
        appendJobEvent({
          ...worker,
          type: 'assistant.text.completed',
          payload: { source: 'dsh', text: 'COMPLETED_AFTER_WITHDRAWAL' },
        }),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      expect(
        await f.db`select id from allrice_run_events where run_id=${run.scope.runId}
        and payload->>'text' in ('VISIBLE_AFTER_WITHDRAWAL','COMPLETED_AFTER_WITHDRAWAL')`,
      ).toHaveLength(0);
      await appendJobEvent({
        ...worker,
        type: 'usage.updated',
        payload: {
          source: 'dsh',
          usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 7 },
        },
      });
      await appendJobEvent({
        ...worker,
        type: 'harness.native',
        payload: {
          source: 'dsh',
          nativeType: 'session/stopped',
          nativePayload: {},
        },
      });
      expect(
        await f.db`select id from allrice_run_events where run_id=${run.scope.runId}
        and event_type in ('usage.updated','harness.native')`,
      ).toHaveLength(2);
      await finish(run, worker);
    }, 120000);

    it('Q8: actual read receipts block dispatch, cold recovery, continuation and imported generations permanently after delete; selecting a draft alone does not', async () => {
      const s = await setup(),
        published = await httpUpload(s.owner);
      await ready(published.revisionId);
      const source = await runtimeRun(s, [published.revisionId]);
      expect(
        await hasRevokedReferencePublicationHistory(
          s.owner,
          source.scope.sessionId,
        ),
      ).toBe(false);
      const worker = await lease(source);
      const results = await loadEmployeeRuntimeReferences(
        source.scope,
        source.runtime.generationId,
        worker,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toBe('预算金额为873元。');
      const [proof] =
        await f.db`select reference_reads from allrice_employee_runs where run_id=${source.scope.runId}`;
      expect(proof!.reference_reads).toHaveLength(1);
      await finish(source, worker);
      await f.db`update allrice_messages set status='completed',content=${f.db.json({ text: '按企业资料得出预算金额873元。', citations: [] })}
      where id=${source.sent.assistantMessage.id}`;
      const imported = await runtimeRun(s, [], undefined, [
        source.scope.sessionId,
      ]);
      await finish(imported);
      await change(s.owner, published.sourceId, 'audience', 1, {
        scope: 'personal',
        departmentIds: [],
      });
      // This publisher kept access; an audience edit is neither a new immutable
      // pin nor a withdrawal fact, and must not seal every reader's history.
      await assertEmployeeContentContext(
        source.scope,
        source.runtime.generationId,
      );
      expect(
        await hasRevokedReferencePublicationHistory(
          s.owner,
          source.scope.sessionId,
        ),
      ).toBe(false);
      const merelySelected = await runtimeRun(s, [published.revisionId]);
      await finish(merelySelected);
      await change(s.owner, published.sourceId, 'delete', 2);
      expect(
        await hasRevokedReferencePublicationHistory(
          s.owner,
          source.scope.sessionId,
        ),
      ).toBe(true);
      expect(
        await hasRevokedReferencePublicationHistory(
          s.owner,
          imported.scope.sessionId,
        ),
      ).toBe(true);
      expect(
        await hasRevokedReferencePublicationHistory(
          s.owner,
          merelySelected.scope.sessionId,
        ),
      ).toBe(false);
      const newPublication = await httpUpload(s.owner);
      expect(newPublication.sourceId).not.toBe(published.sourceId);
      for (const run of [source, imported]) {
        await expect(
          assertEmployeeContentContext(run.scope, run.runtime.generationId),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        await expect(
          prepareEmployeeContentContext(run.scope),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        const [before] =
          await f.db`select count(*)::int n from allrice_messages where session_id=${run.scope.sessionId}`;
        await expect(
          sendChatMessage(s.owner, s.owner.workspaceId!, run.scope.sessionId, {
            clientMessageId: randomUUID(),
            text: '请继续',
          }),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        const [after] =
          await f.db`select count(*)::int n from allrice_messages where session_id=${run.scope.sessionId}`;
        expect(after!.n).toBe(before!.n);
      }
      await expect(
        assertEmployeeContentReferenceMessages(
          s.owner,
          source.scope.sessionId,
          [source.sent.assistantMessage.id],
          f.db,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      expect(
        (
          await getChatSessionHistory(
            s.owner,
            s.owner.workspaceId!,
            source.scope.sessionId,
          )
        ).messages.length,
      ).toBeGreaterThan(0);
    }, 120000);
  },
);
