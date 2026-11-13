import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  HarnessEvent,
  ReferenceAudience,
  RequestContext,
  StoragePort,
  SignedAccessGrant,
} from '@allrice/contracts';
import {
  methodActivationQuestionPrefix,
  UserQuestionRequestSchema,
} from '@allrice/contracts';
import * as client from '../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../packages/database/src/employee-administration.fixture.ts';
import { tenantValidationFixture } from '../../../packages/database/src/tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../../../packages/database/src/identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from '../../../packages/database/src/organization-administration.ts';
import { createOrganizationDepartment } from '../../../packages/database/src/organization-departments.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../../../packages/database/src/tenant-employees.ts';
import {
  getWorkbenchArtifact,
  readArtifactBytes,
} from '../../../packages/database/src/artifact-review.ts';
import {
  createStorageMetadata,
  markStorageReady,
  getStoredFile,
  prepareStorageDelete,
  resolveStorageGrant,
  saveStorageGrant,
} from '../../../packages/database/src/data.ts';
import { markFinalDeliveryRootLocked } from '../../../packages/database/src/final-delivery-commit.ts';
import { readFinalDeliveryReferences } from '../../../packages/database/src/final-delivery-references.ts';
import {
  appendJobEvent,
  completeJob,
  cancelRun,
  failJob,
  heartbeatJob,
  finishJobDrain,
} from '../../../packages/database/src/execution/queue.ts';
import { createRuntimeOperationLedger } from '../../../packages/database/src/runtime-ledger/ledger.ts';
import { HarnessEventBatcher } from '../../../apps/worker/src/harness/delta-batcher.ts';
import { normalizeHarnessRunEvent } from '../../../apps/worker/src/harness/runtime-contract.ts';
import {
  nativeEventView,
  nativeContextView,
} from '../../../apps/worker/src/harness/dsh/event-projector.ts';
import {
  publishReference,
  changeReferencePublication,
  listReferencePublications,
  getReferenceFile,
  prepareReferenceUpload,
  completeReferenceUpload,
  changeReference,
} from '../../../packages/database/src/reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../../../packages/database/src/reference-processing.ts';
import {
  assertReferenceSelections,
  captureReferenceSelections,
  hasRevokedReferencePublicationHistory,
} from '../../../packages/database/src/reference-runtime.ts';
import {
  readWorkbenchFile,
  updateWorkbenchFile,
} from '../../../packages/database/src/workbench-files.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
  getChatSessionHistory,
} from '../../../packages/database/src/workspace/service.ts';
import {
  acquireConversationRuntime,
  releaseConversationRuntime,
} from '../../../packages/database/src/conversation/conversation-runtime.ts';
import {
  prepareEmployeeContentContext,
  assertEmployeeContentContext,
  loadEmployeeRuntimeReferences,
  assertEmployeeContentReferenceMessages,
} from '../../../packages/database/src/employees/employee-runtime-content.ts';
import { resolveEmployeeExecution } from '../../../packages/database/src/employees/employeehub.ts';

const browser = vi.hoisted(() => ({
  context: null as RequestContext | null,
  storage: null as StoragePort | null,
}));
vi.mock('./identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
vi.mock('./storage/runtime', () => ({
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

    async function withdrawalBarrier() {
      const lock = await f.db.reserve();
      await lock`begin`;
      // change already holds the source FOR UPDATE before inserting its action.
      // This test-only lock leaves ACL reads possible and never enters product code.
      await lock`lock table allrice_knowledge_reference_actions in share mode`;
      const [holder] = await lock`select pg_backend_pid() pid`;
      return {
        async writer() {
          let writerPid = 0;
          await expect
            .poll(
              async () => {
                const [writer] = await f.db`select pid from pg_stat_activity
              where application_name=current_setting('application_name')
                and ${holder!.pid}::int=any(pg_blocking_pids(pid))
                and query like '%insert into allrice_knowledge_reference_actions%'`;
                writerPid = writer?.pid ?? 0;
                return writerPid;
              },
              { timeout: 5000 },
            )
            .toBeGreaterThan(0);
          return writerPid;
        },
        async reader(writerPid: number) {
          await expect
            .poll(
              async () =>
                (
                  await f.db`select count(*)::int n from pg_stat_activity
              where application_name=current_setting('application_name') and wait_event_type='Lock'
                and ${writerPid}::int=any(pg_blocking_pids(pid))
                and query like '%select s.id,s.status%' and query like '%for share%'`
                )[0]!.n,
              { timeout: 5000 },
            )
            .toBeGreaterThan(0);
        },
        async release() {
          try {
            await lock`rollback`;
          } finally {
            lock.release();
          }
        },
      };
    }
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
    async function referenceEligibility(
      context: RequestContext,
      sessionId: string,
    ) {
      browser.context = context;
      const { GET } =
        await import('../app/api/v1/sessions/[id]/reference-eligibility/route.ts');
      const response = await GET(
        new Request(
          `https://example.test/api/v1/sessions/${sessionId}/reference-eligibility?workspaceId=${context.workspaceId}`,
        ),
        { params: Promise.resolve({ id: sessionId }) },
      );
      expect(response.status).toBe(200);
      return (await response.json()).referenceEligibility;
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
        await ready(published.revisionId);
        expect(
          (
            await f.db.begin((tx) =>
              captureReferenceSelections(s.owner, [published.revisionId], tx),
            )
          ).map((pin) => pin.revisionId),
        ).toEqual([published.revisionId]);
        await expect(
          f.db.begin((tx) =>
            captureReferenceSelections(
              foreign.owner,
              [published.revisionId],
              tx,
            ),
          ),
        ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
        if (scope === 'personal')
          await expect(
            f.db.begin((tx) =>
              captureReferenceSelections(
                s.maintainer,
                [published.revisionId],
                tx,
              ),
            ),
          ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
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

    it('compares canonical publication parameters independently of display defaults and preserves exact request receipts after withdrawal', async () => {
      const a = await tenantValidationFixture(f.db);
      const owner = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.task.scope.workspaceId,
      };
      const original = await getWorkbenchArtifact(
        owner,
        a.task.chatSessionId!,
        a.artifact.artifactId,
        f.db,
      );
      const input = {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        origin: 'file' as const,
        objectId: original.object.id,
        purpose: '',
        audience: { scope: 'company' as const, departmentIds: [] },
      };
      const first = await publishReference(owner, input, browser.storage!);
      const [saved] =
        await f.db`select description,request_input from allrice_knowledge_revisions where id=${first.revisionId}`;
      expect(saved!.description).toBe('企业资料');
      expect(saved!.request_input.purpose).toBe('');
      expect(
        await publishReference(
          owner,
          { ...input, requestId: randomUUID(), purpose: '  ' },
          browser.storage!,
        ),
      ).toEqual(first);
      // An explicit purpose is data, even when its text resembles a UI default.
      for (const purpose of ['企业资料', '参考资料', 'another purpose']) {
        await expect(
          publishReference(
            owner,
            { ...input, requestId: randomUUID(), purpose },
            browser.storage!,
          ),
        ).rejects.toMatchObject({ code: 'request_conflict' });
      }
      await expect(
        publishReference(
          owner,
          { ...input, purpose: '企业资料' },
          browser.storage!,
        ),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      await change(owner, first.sourceId, 'revoke');
      expect(await publishReference(owner, input, browser.storage!)).toEqual(
        first,
      );
      await expect(file(owner, first.revisionId)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(
        (
          await publishReference(
            owner,
            { ...input, requestId: randomUUID() },
            browser.storage!,
          )
        ).sourceId,
      ).not.toBe(first.sourceId);
    }, 120000);

    it('copies an exact owned delivery once, leaves its original intact, and a new explicit publication after revoke has a new source identity', async () => {
      const a = await tenantValidationFixture(f.db);
      const owner = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.task.scope.workspaceId,
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
      await updateWorkbenchFile(
        owner,
        original.object.id,
        {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          expectedRevision: 1,
          sharing: { scope: 'personal', departmentIds: [] },
        },
        browser.storage!,
      );
      await expect(
        readWorkbenchFile(reader, original.object.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect((await file(reader, one.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
      expect((await file(owner, one.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
      expect(await publishReference(owner, input, browser.storage!)).toEqual(
        one,
      );
      expect(
        (
          await f.db`select state,immutable,deleted_at from allrice_storage_objects where id=${original.object.id}`
        )[0],
      ).toMatchObject({ state: 'ready', immutable: true, deleted_at: null });
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
        await f.db`select r.id,s.id as source_id,o.id as object_id,o.state from allrice_knowledge_save_requests request
        join allrice_knowledge_revisions r on r.id=request.revision_id
        join allrice_knowledge_sources s on s.id=r.knowledge_source_id
        join allrice_storage_objects o on o.id=r.file_object_id where request.request_id=${interruptedInput.requestId}`;
      expect(interrupted!.state).toBe('pending');
      const recoveryReads: string[] = [],
        recoveryChecks: string[] = [];
      let recoveryPuts = 0;
      const recoveryStorage: StoragePort = {
        get: async (object) => {
          recoveryReads.push(object.id);
          if (object.id === original.object.id)
            throw Error('SYNTHETIC_ORIGINAL_IO_UNAVAILABLE');
          return underlying.get(object);
        },
        exists: async (object) => {
          recoveryChecks.push(object.id);
          if (object.id === original.object.id)
            throw Error('SYNTHETIC_ORIGINAL_IO_UNAVAILABLE');
          return underlying.exists(object);
        },
        put: async () => {
          recoveryPuts++;
          throw Error('Recovery must not rewrite the acknowledged copy');
        },
        delete: underlying.delete.bind(underlying),
      };
      const recovered = await publishReference(
        owner,
        interruptedInput,
        recoveryStorage,
      );
      expect(recoveryReads).toEqual([interrupted!.object_id]);
      expect(recoveryChecks).toEqual([interrupted!.object_id]);
      expect(recoveryPuts).toBe(0);
      expect(recovered).toEqual({
        sourceId: interrupted!.source_id,
        revisionId: interrupted!.id,
      });
      expect((await file(owner, recovered.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
      expect(
        (
          await f.db`select state,immutable,deleted_at from allrice_storage_objects where id=${original.object.id}`
        )[0],
      ).toMatchObject({ state: 'ready', immutable: true, deleted_at: null });
      expect(await readArtifactBytes(underlying, original.object)).toEqual(
        await readArtifactBytes(underlying, retained.object),
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
        await f.db`update allrice_jobs set status='running',attempt=attempt+1,worker_id=${worker.workerId},lease_token=${worker.leaseToken},
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

    it.each(['delete', 'audience'] as const)(
      'Q8: real concurrent %s seals batched visible text while native drain and usage receipts remain writable',
      async (action) => {
        const s = await setup(),
          published = await httpUpload(s.owner);
        await ready(published.revisionId);
        const run = await runtimeRun({ ...s, owner: s.finance }, [
            published.revisionId,
          ]),
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
        const barrier = await withdrawalBarrier();
        const withdrawing = change(
          s.owner,
          published.sourceId,
          action,
          1,
          action === 'audience'
            ? { scope: 'personal', departmentIds: [] }
            : undefined,
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        let writing: Promise<unknown> | undefined;
        try {
          const writerPid = await barrier.writer();
          writing = appendJobEvent({
            ...worker,
            type: 'assistant.text.delta',
            payload: { source: 'dsh', text: 'VISIBLE_AFTER_WITHDRAWAL' },
          }).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          await barrier.reader(writerPid);
        } finally {
          await barrier.release();
        }
        expect(await withdrawing).toEqual({
          result: { sourceId: published.sourceId },
        });
        expect(await writing).toEqual({ result: null });
        await expect(
          appendJobEvent({
            ...worker,
            type: 'assistant.text.completed',
            payload: { source: 'dsh', text: 'COMPLETED_AFTER_WITHDRAWAL' },
          }),
        ).resolves.toBeNull();
        expect(
          await f.db`select id from allrice_run_events where run_id=${run.scope.runId}
        and payload->>'text' in ('VISIBLE_AFTER_WITHDRAWAL','COMPLETED_AFTER_WITHDRAWAL')`,
        ).toHaveLength(0);
        expect(
          await f.db`select id from allrice_employee_run_steps where run_id=${run.scope.runId}
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
      },
      120000,
    );

    it('actual batcher and normalizer keep usage/native projections after unpublished delta/replace/completed', async () => {
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
      await change(s.owner, published.sourceId, 'delete');
      const [job] =
        await f.db`select attempt from allrice_jobs where id=${worker.jobId}`;
      const envelope = {
        schemaVersion: 1 as const,
        harness: 'dsh' as const,
        generation: 1,
        attempt: job!.attempt as number,
        threadId: 'synthetic-native',
        turnId: 'synthetic-turn',
        sessionId: run.scope.sessionId,
        messageId: run.sent.assistantMessage.id,
      };
      const outcomes: unknown[] = [];
      // Exactly the job-runner/smoke wiring: await the write, discard its
      // publication result; a real rejection must still poison the batcher.
      const batcher = new HarnessEventBatcher(async (event) => {
        outcomes.push(
          await appendJobEvent({
            ...worker,
            ...normalizeHarnessRunEvent(event),
          }),
        );
      });
      try {
        await batcher.accept({
          ...envelope,
          order: 1,
          type: 'assistant.delta',
          text: 'DENIED_BATCH_DELTA',
        });
        await batcher.accept({
          ...envelope,
          order: 2,
          type: 'assistant.delta',
          textMode: 'replace',
          text: 'DENIED_BATCH_REPLACE',
        });
        await batcher.accept({
          ...envelope,
          order: 3,
          type: 'assistant.completed',
          text: 'DENIED_BATCH_COMPLETED',
        });
        await batcher.accept({
          ...envelope,
          order: 4,
          type: 'usage.updated',
          inputTokens: 13,
          cachedInputTokens: 2,
          outputTokens: 7,
        });
        await batcher.accept({
          ...envelope,
          order: 5,
          type: 'native.event',
          sourceEventType: 'session/stopped',
          presentation: 'lifecycle',
          status: 'completed',
          label: 'Native stopped',
          sourcePayload: { synthetic: true },
        });
      } finally {
        await batcher.close();
      }
      expect(outcomes.slice(0, 3)).toEqual([null, null, null]);
      expect(outcomes.slice(3)).toHaveLength(2);
      expect(
        await f.db`select id from allrice_run_events where run_id=${run.scope.runId} and payload->>'text' like 'DENIED_BATCH_%'`,
      ).toHaveLength(0);
      const projections =
        await f.db`select event_type,payload from allrice_run_events where run_id=${run.scope.runId}
        and event_type in ('usage.updated','harness.native') order by sequence`;
      expect(projections).toMatchObject([
        {
          event_type: 'usage.updated',
          payload: {
            usage: { inputTokens: 13, cachedInputTokens: 2, outputTokens: 7 },
          },
        },
        {
          event_type: 'harness.native',
          payload: { sourceEventType: 'session/stopped' },
        },
      ]);
      await expect(
        assertEmployeeContentContext(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await completeJob({
        ...worker,
        result: {
          answer: 'DENIED_BATCH_FINAL',
          citations: [
            { type: 'file', id: randomUUID(), label: 'DENIED_BATCH_CITATION' },
          ],
        },
      });
      const [closed] =
        await f.db`select j.status,j.worker_id,r.state,r.result,m.content
        from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs e on e.run_id=r.id
        join allrice_messages m on m.id=e.assistant_message_id where j.id=${worker.jobId}`;
      expect(closed).toMatchObject({
        status: 'failed',
        worker_id: null,
        state: 'failed',
        result: null,
      });
      expect(JSON.stringify(closed)).not.toContain('DENIED_BATCH_');
      expect(
        await f.db`select id from allrice_run_events where run_id=${run.scope.runId} and event_type in ('usage.updated','harness.native')`,
      ).toHaveLength(2);
    }, 120000);

    it.each([
      'delete',
      'audience',
      'department',
      'membership',
      'unread',
      'readable',
    ] as const)(
      'real native display pipeline preserves facts and stops only an inaccessible question (%s)',
      async (loss) => {
        const s = await setup(),
          published = await httpUpload(
            s.owner,
            upload(s.owner, {
              scope: 'departments',
              departmentIds: [s.departments[1]!.id],
            }),
          );
        await ready(published.revisionId);
        const run = await runtimeRun({ ...s, owner: s.finance }, [
            published.revisionId,
          ]),
          worker = await lease(run);
        if (loss !== 'unread')
          expect(
            await loadEmployeeRuntimeReferences(
              run.scope,
              run.runtime.generationId,
              worker,
            ),
          ).toHaveLength(1);
        await createRuntimeOperationLedger({
          database: f.db,
          admission: async () => {
            throw Error('unused admission');
          },
        }).createRoot({
          task: {
            scope: {
              organizationId: run.scope.organizationId,
              workspaceId: run.scope.workspaceId,
              projectId: null,
            },
            runId: run.scope.runId,
            rootRunId: run.scope.runId,
            parentRunId: null,
            chatSessionId: run.scope.sessionId,
            frozenConfiguration: {
              employeeVersionId: null,
              digest: `sha256:${'c'.repeat(64)}`,
            },
          },
          deadlineAt: new Date(Date.now() + 600000).toISOString(),
          budgets: [
            {
              metric: 'model_calls',
              unit: 'calls',
              capacity: 12,
              currency: null,
              source: {
                kind: 'worker',
                sourceId: 'publication-native-fixture',
              },
            },
          ],
        });
        let order = 0;
        const envelope = {
          schemaVersion: 1 as const,
          harness: 'dsh' as const,
          generation: 1,
          attempt: 1,
          threadId: `dsh-${run.scope.sessionId}`,
          turnId: 'native-turn',
          sessionId: run.scope.sessionId,
          messageId: run.sent.assistantMessage.id,
        };
        const outcomes: unknown[] = [];
        const batcher = new HarnessEventBatcher(async (event) => {
          outcomes.push(
            await appendJobEvent({
              ...worker,
              ...normalizeHarnessRunEvent(event),
            }),
          );
        });
        const emit = async (event: HarnessEvent) => batcher.accept(event);
        const todo = (content: string) =>
          nativeEventView({
            type: 'todo/write',
            seq: ++order,
            data: { todos: [{ id: 'plan', content, status: 'pending' }] },
          })!;
        await emit({ ...envelope, ...todo('ALREADY_PUBLIC_PLAN'), order });
        if (loss === 'delete' || loss === 'unread')
          await change(s.owner, published.sourceId, 'delete');
        else if (loss === 'audience')
          await change(s.owner, published.sourceId, 'audience', 1, {
            scope: 'personal',
            departmentIds: [],
          });
        else if (loss === 'department')
          await f.db`update allrice_departments set archived_at=clock_timestamp() where id=${s.departments[1]!.id}`;
        else if (loss === 'membership')
          await f.db`update allrice_memberships set active=false where organization_id=${s.owner.organizationId} and user_id=${s.finance.actor.id}`;
        const denied = loss !== 'unread' && loss !== 'readable';
        try {
          await emit({ ...envelope, ...todo('NEW_NATIVE_BODY'), order });
          for (const type of [
            'tool.started',
            'tool.completed',
            'tool.failed',
          ] as const)
            await emit({
              ...envelope,
              order: ++order,
              type,
              source: 'harness',
              toolCallId: 'native-call',
              name: 'NEW_NATIVE_BODY',
              label: 'NEW_NATIVE_BODY',
              summary: 'NEW_NATIVE_BODY',
              sourceEventId: `tool-${order}`,
              sourceEventType: 'tool/call',
              sourceOccurredAt: new Date().toISOString(),
              sourcePayload: {
                query: 'NEW_NATIVE_BODY',
                activityDetail: 'NEW_NATIVE_BODY',
                summary: 'NEW_NATIVE_BODY',
                skillName: 'NEW_NATIVE_BODY',
              },
            });
          const question = UserQuestionRequestSchema.parse({
            questionId: 'native-question',
            questions: [
              {
                // A rejected activation question must never reach the writer that
                // requires its authentic activation receipt. Normal questions do.
                id: denied
                  ? methodActivationQuestionPrefix + randomUUID()
                  : 'choice',
                question: 'NEW_NATIVE_BODY',
                detail: 'NEW_NATIVE_BODY',
                header: 'NEW_NATIVE_BODY',
                options: [
                  { label: 'NEW_NATIVE_BODY', description: 'NEW_NATIVE_BODY' },
                ],
              },
            ],
          });
          await emit({
            ...envelope,
            order: ++order,
            type: 'native.event',
            presentation: 'context',
            status: 'started',
            label: 'Rice 需要你确认',
            summary: 'NEW_NATIVE_BODY',
            sourceEventType: 'session/user-question',
            sourcePayload: question,
          });
          const [first] =
            await f.db`select cancel_requested_at,drain_deadline_at,lease_expires_at from allrice_jobs where id=${worker.jobId}`;
          await emit({
            ...envelope,
            order: ++order,
            type: 'native.event',
            presentation: 'context',
            status: 'completed',
            label: '问题状态已更新',
            sourceEventType: 'session/user-questions',
            sourcePayload: {
              sessionId: envelope.threadId,
              sequence: order,
              questions: {
                active: [
                  {
                    callId: 'native-question',
                    state: 'open',
                    questions: question.questions,
                  },
                ],
                settled: [
                  {
                    callId: 'prior',
                    answers: [{ id: 'choice', selected: ['NEW_NATIVE_BODY'] }],
                  },
                ],
              },
            },
          });
          await emit({
            ...envelope,
            order: ++order,
            type: 'usage.updated',
            inputTokens: 13,
            cachedInputTokens: 2,
            outputTokens: 7,
          });
          await emit({
            ...envelope,
            ...nativeContextView({
              contextPressure: { contextWindow: 10000, pressureTokens: 200 },
            })!,
            order: ++order,
          });
          await batcher.flush();
          const events =
              await f.db`select event_type,payload from allrice_run_events where run_id=${run.scope.runId} order by sequence`,
            steps =
              await f.db`select event_type,payload from allrice_employee_run_steps where run_id=${run.scope.runId} order by sequence`;
          expect(JSON.stringify(events)).toContain('ALREADY_PUBLIC_PLAN');
          for (const rows of [events, steps]) {
            expect(JSON.stringify(rows).includes('NEW_NATIVE_BODY')).toBe(
              !denied,
            );
            expect(
              rows.filter((r) => r.event_type === 'usage.updated'),
            ).toHaveLength(1);
            expect(
              rows.filter(
                (r) => r.payload.sourceEventType === 'session/projection',
              ),
            ).toHaveLength(1);
            expect(
              rows.filter((r) => String(r.event_type).startsWith('tool.')),
            ).toHaveLength(3);
          }
          const [last] =
            await f.db`select cancel_reason,cancel_requested_at,drain_deadline_at,lease_expires_at from allrice_jobs where id=${worker.jobId}`;
          if (denied) {
            expect(outcomes.slice(1, 2)).toEqual([null]);
            expect(outcomes.slice(5, 7)).toEqual([null, null]);
            expect(last).toMatchObject({
              cancel_reason: 'EMPLOYEE_CONTENT_UNAVAILABLE',
              cancel_requested_at: first!.cancel_requested_at,
              drain_deadline_at: first!.drain_deadline_at,
              lease_expires_at: first!.lease_expires_at,
            });
            expect(first!.cancel_requested_at).not.toBeNull();
            expect(first!.lease_expires_at <= first!.drain_deadline_at).toBe(
              true,
            );
            for (const rows of [
              await f.db`select * from allrice_task_questions where run_id=${run.scope.runId}`,
              await f.db`select * from allrice_native_questions where source_run_id=${run.scope.runId}`,
              await f.db`select * from allrice_native_question_waits where run_id=${run.scope.runId}`,
              await f.db`select * from allrice_employee_method_activations where source_run_id=${run.scope.runId}`,
            ])
              expect(rows).toHaveLength(0);
            const [root] =
              await f.db`select cancel_request_id from allrice_runtime_roots where root_run_id=${run.scope.runId}`;
            expect(root!.cancel_request_id).not.toBeNull();
            expect(
              await f.db`select id from allrice_audit_events where resource_id=${run.scope.runId} and action='run.cancel.request' and actor_id is null and reason='EMPLOYEE_CONTENT_UNAVAILABLE'`,
            ).not.toHaveLength(0);
            expect(
              await heartbeatJob(
                worker.workerId,
                worker.jobId,
                worker.leaseToken,
                30000,
              ),
            ).toMatchObject({ active: false, canceled: true, draining: true });
            await finishJobDrain(worker);
            const [closed] =
              await f.db`select j.status,c.state from allrice_jobs j join allrice_conversation_runtimes c on c.active_run_id=j.run_id where j.id=${worker.jobId}`;
            // release clears active_run_id; a remaining running owner is wrong.
            expect(closed).toBeUndefined();
            expect(
              (
                await f.db`select status from allrice_jobs where id=${worker.jobId}`
              )[0]!.status,
            ).toBe('canceled');
            expect(
              await hasRevokedReferencePublicationHistory(
                s.finance,
                run.scope.sessionId,
              ),
            ).toBe(loss === 'delete');
            expect(
              (
                await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${run.runtime.generationId}`
              )[0]!.invalidated_at,
            ).toBeNull();
          } else {
            expect(last!.cancel_requested_at).toBeNull();
            expect(outcomes.every((o) => o !== null)).toBe(true);
            expect(
              await f.db`select question_id from allrice_task_questions where run_id=${run.scope.runId} and pending`,
            ).toEqual([{ question_id: 'native-question' }]);
            await finish(run, worker);
          }
        } finally {
          await batcher.close();
        }
      },
      120000,
    );

    it('an actual native question waits behind the withdrawal writer, then cancels without any text projection', async () => {
      const s = await setup(),
        published = await httpUpload(s.owner);
      await ready(published.revisionId);
      const run = await runtimeRun(s, [published.revisionId]),
        worker = await lease(run);
      await loadEmployeeRuntimeReferences(
        run.scope,
        run.runtime.generationId,
        worker,
      );
      const barrier = await withdrawalBarrier();
      let writing: Promise<unknown> | undefined;
      const withdrawing = change(s.owner, published.sourceId, 'delete').then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        const writerPid = await barrier.writer();
        const batcher = new HarnessEventBatcher(async (event) => {
          expect(
            await appendJobEvent({
              ...worker,
              ...normalizeHarnessRunEvent(event),
            }),
          ).toBeNull();
        });
        writing = batcher
          .accept({
            schemaVersion: 1,
            harness: 'dsh',
            generation: 1,
            attempt: 1,
            order: 1,
            threadId: `dsh-${run.scope.sessionId}`,
            turnId: 'native-turn',
            sessionId: run.scope.sessionId,
            messageId: run.sent.assistantMessage.id,
            type: 'native.event',
            sourceEventType: 'session/user-question',
            presentation: 'context',
            status: 'started',
            label: 'Rice 需要你确认',
            sourcePayload: UserQuestionRequestSchema.parse({
              questionId: 'in-flight',
              questions: [{ id: 'choice', question: 'IN_FLIGHT_NATIVE_BODY' }],
            }),
          })
          .finally(() => batcher.close())
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
        await barrier.reader(writerPid);
      } finally {
        await barrier.release();
      }
      expect(await withdrawing).toEqual({
        result: { sourceId: published.sourceId },
      });
      expect(await writing).toEqual({ result: undefined });
      expect(
        await f.db`select payload from allrice_run_events where run_id=${run.scope.runId} and event_type='harness.native'`,
      ).toHaveLength(0);
      expect(
        await f.db`select * from allrice_task_questions where run_id=${run.scope.runId}`,
      ).toHaveLength(0);
      for (const rows of [
        await f.db`select * from allrice_native_questions where source_run_id=${run.scope.runId}`,
        await f.db`select * from allrice_native_question_waits where run_id=${run.scope.runId}`,
        await f.db`select * from allrice_employee_method_activations where source_run_id=${run.scope.runId}`,
        await f.db`select * from allrice_employee_run_steps where run_id=${run.scope.runId} and payload::text like '%IN_FLIGHT_NATIVE_BODY%'`,
      ])
        expect(rows).toHaveLength(0);
      expect(
        (
          await f.db`select cancel_reason from allrice_jobs where id=${worker.jobId}`
        )[0]!.cancel_reason,
      ).toBe('EMPLOYEE_CONTENT_UNAVAILABLE');
      await finishJobDrain(worker);
    }, 120000);

    it.each(['audience', 'department', 'membership'] as const)(
      'current %s loss seals real in-flight delta/completed without permanently marking an audience withdrawal',
      async (loss) => {
        const s = await setup(),
          published = await httpUpload(
            s.owner,
            upload(s.owner, {
              scope: 'departments',
              departmentIds: [s.departments[1]!.id, s.departments[2]!.id],
            }),
          );
        await ready(published.revisionId);
        const removed = await runtimeRun({ ...s, owner: s.finance }, [
            published.revisionId,
          ]),
          retained = await runtimeRun({ ...s, owner: s.operations }, [
            published.revisionId,
          ]),
          removedWorker = await lease(removed),
          retainedWorker = await lease(retained);
        for (const [run, worker] of [
          [removed, removedWorker],
          [retained, retainedWorker],
        ] as const)
          expect(
            await loadEmployeeRuntimeReferences(
              run.scope,
              run.runtime.generationId,
              worker,
            ),
          ).toHaveLength(1);
        if (loss === 'audience')
          await change(s.owner, published.sourceId, 'audience', 1, {
            scope: 'departments',
            departmentIds: [s.departments[2]!.id],
          });
        else if (loss === 'department')
          await f.db`update allrice_departments set archived_at=clock_timestamp() where id=${s.departments[1]!.id}`;
        else
          await f.db`update allrice_memberships set active=false where organization_id=${s.owner.organizationId} and user_id=${s.finance.actor.id}`;
        // The real model guard and both binding/read entry points must refuse
        // current loss without committing the old permanent-invalidation path.
        await expect(
          assertEmployeeContentContext(
            removed.scope,
            removed.runtime.generationId,
            removedWorker,
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        await expect(
          loadEmployeeRuntimeReferences(
            removed.scope,
            removed.runtime.generationId,
            removedWorker,
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        await expect(
          prepareEmployeeContentContext(removed.scope),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        await assertEmployeeContentContext(
          retained.scope,
          retained.runtime.generationId,
          retainedWorker,
        );
        for (const type of [
          'assistant.text.delta',
          'assistant.text.completed',
        ] as const) {
          await expect(
            appendJobEvent({
              ...removedWorker,
              type,
              payload: { text: 'DENIED_CURRENT_BODY' },
            }),
          ).resolves.toBeNull();
          await appendJobEvent({
            ...retainedWorker,
            type,
            payload: { text: 'RETAINED_CURRENT_BODY' },
          });
        }
        expect(
          await f.db`select id from allrice_run_events where run_id=${removed.scope.runId} and payload->>'text'='DENIED_CURRENT_BODY'`,
        ).toHaveLength(0);
        expect(
          await f.db`select id from allrice_run_events where run_id=${retained.scope.runId} and payload->>'text'='RETAINED_CURRENT_BODY'`,
        ).toHaveLength(2);
        expect(
          await hasRevokedReferencePublicationHistory(
            s.finance,
            removed.scope.sessionId,
          ),
        ).toBe(false);
        const [generation] =
          await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${removed.runtime.generationId}`;
        expect(generation!.invalidated_at).toBeNull();
        expect(
          await f.db`select source_id from allrice_knowledge_reference_actions where source_id=${published.sourceId} and input->>'action' in ('revoke','delete')`,
        ).toHaveLength(0);
        await appendJobEvent({
          ...removedWorker,
          type: 'usage.updated',
          payload: { usage: { inputTokens: 9, outputTokens: 3 } },
        });
        await appendJobEvent({
          ...removedWorker,
          type: 'harness.native',
          payload: { nativeType: 'session/stopped', nativePayload: {} },
        });
        // Recovering current authority is not a new permanent Q8 policy. This
        // direct commit did not mutate generation or a revoke/delete ledger.
        if (loss === 'audience')
          await change(s.owner, published.sourceId, 'audience', 2, {
            scope: 'company',
            departmentIds: [],
          });
        else if (loss === 'department')
          await f.db`update allrice_departments set archived_at=null where id=${s.departments[1]!.id}`;
        else
          await f.db`update allrice_memberships set active=true where organization_id=${s.owner.organizationId} and user_id=${s.finance.actor.id}`;
        await assertEmployeeContentContext(
          removed.scope,
          removed.runtime.generationId,
          removedWorker,
        );
        expect(
          (await prepareEmployeeContentContext(removed.scope))!.generationId,
        ).toBe(removed.runtime.generationId);
        await appendJobEvent({
          ...removedWorker,
          type: 'assistant.text.delta',
          payload: { text: 'CURRENT_ACCESS_RECOVERED' },
        });
        await finish(removed, removedWorker);
        await finish(retained, retainedWorker);
      },
      120000,
    );

    it.each(['unpublished', 'same', 'different', 'audience'] as const)(
      'real completeJob after withdrawal closes receipts and keeps only exact previously public body/citations (%s)',
      async (previous) => {
        const s = await setup(),
          published = await httpUpload(s.owner);
        await ready(published.revisionId);
        const reader = previous === 'audience' ? s.finance : s.owner;
        const run = await runtimeRun({ ...s, owner: reader }, [
            published.revisionId,
          ]),
          worker = await lease(run);
        expect(
          await loadEmployeeRuntimeReferences(
            run.scope,
            run.runtime.generationId,
            worker,
          ),
        ).toHaveLength(1);
        const [job] =
          await f.db`select attempt from allrice_jobs where id=${worker.jobId}`;
        const publicText = 'ALREADY_PUBLIC_EXACT_BODY',
          publicCitation = {
            type: 'file',
            id: randomUUID(),
            label: 'ALREADY_PUBLIC_EXACT_CITATION',
          };
        // An arbitrary completed marker, wrong message/attempt, tool-call body
        // or delta fragment must not authorize this terminal's new output.
        await appendJobEvent({
          ...worker,
          type: 'assistant.text.completed',
          payload: {
            messageId: run.sent.assistantMessage.id,
            attempt: job!.attempt - 1,
            text: 'WRONG_ATTEMPT_BODY',
          },
        });
        await appendJobEvent({
          ...worker,
          type: 'assistant.text.completed',
          payload: {
            messageId: randomUUID(),
            attempt: job!.attempt,
            text: 'WRONG_MESSAGE_BODY',
          },
        });
        await appendJobEvent({
          ...worker,
          type: 'assistant.text.delta',
          payload: {
            messageId: run.sent.assistantMessage.id,
            attempt: job!.attempt,
            text: 'ONLY_DELTA_FRAGMENT',
          },
        });
        if (previous !== 'unpublished')
          await appendJobEvent({
            ...worker,
            type: 'assistant.text.completed',
            payload: {
              messageId: run.sent.assistantMessage.id,
              attempt: job!.attempt,
              text: publicText,
              citations: [publicCitation],
              nativePayload: { interrupted: false, contentTypes: ['text'] },
            },
          });
        await change(
          s.owner,
          published.sourceId,
          previous === 'audience' ? 'audience' : 'delete',
          1,
          previous === 'audience'
            ? { scope: 'personal', departmentIds: [] }
            : undefined,
        );
        await appendJobEvent({
          ...worker,
          type: 'usage.updated',
          payload: {
            source: 'dsh',
            usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 0 },
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
        await completeJob({
          ...worker,
          result: {
            answer:
              previous === 'same' ? publicText : 'UNPUBLISHED_NEW_FINAL_BODY',
            citations: [
              publicCitation,
              {
                type: 'file',
                id: randomUUID(),
                label: 'UNPUBLISHED_NEW_FINAL_CITATION',
              },
            ],
            privateExtra: 'UNPUBLISHED_EXTRA_RESULT',
          },
        });
        const [closed] =
          await f.db`select j.status,j.worker_id,j.lease_token,j.completed_at,r.state,r.result,
          e.status employee_status,m.content,m.status message_status
          from allrice_jobs j join allrice_runs r on r.id=j.run_id
          join allrice_employee_runs e on e.run_id=r.id join allrice_messages m on m.id=e.assistant_message_id
          where j.id=${worker.jobId}`;
        expect(closed).toMatchObject({
          status: 'failed',
          worker_id: null,
          lease_token: null,
          state: 'failed',
          employee_status: 'failed',
          message_status: 'failed',
        });
        expect(closed!.completed_at).not.toBeNull();
        if (previous === 'unpublished') {
          expect(closed!.result).toBeNull();
          expect(closed!.content.citations).toEqual([]);
          expect(closed!.content.text).not.toContain('ONLY_DELTA_FRAGMENT');
          expect(closed!.content.text).not.toContain('WRONG_');
        } else {
          expect(closed!.content).toEqual({
            text: publicText,
            citations: [publicCitation],
          });
          expect(closed!.result).toEqual({
            answer: publicText,
            citations: [publicCitation],
          });
        }
        expect(JSON.stringify(closed)).not.toContain('UNPUBLISHED_');
        const terminal =
          await f.db`select payload from allrice_run_events where run_id=${run.scope.runId} and event_type='run.failed'`;
        expect(terminal).toHaveLength(1);
        expect(JSON.stringify(terminal)).not.toContain('UNPUBLISHED_');
        expect(
          await f.db`select id from allrice_run_events where run_id=${run.scope.runId} and event_type in ('usage.updated','harness.native')`,
        ).toHaveLength(2);
        const [runtime] =
          await f.db`select state,active_run_id from allrice_conversation_runtimes where session_id=${run.scope.sessionId}`;
        expect(runtime!.state).not.toBe('running');
        expect(runtime!.active_run_id).toBeNull();
        if (previous !== 'unpublished')
          expect(
            (
              await getChatSessionHistory(
                reader,
                reader.workspaceId!,
                run.scope.sessionId,
              )
            ).messages.some((m) => m.content.text === publicText),
          ).toBe(true);
      },
      120000,
    );

    it.each([false, true])(
      "in-flight frozen user text never acquires that Run's later reads (with prior=%s)",
      async (withPrior) => {
        const s = await setup(),
          published = await httpUpload(s.owner);
        await ready(published.revisionId);
        const priorPublication = withPrior ? await httpUpload(s.owner) : null;
        let sourceSessionId: string | undefined;
        if (priorPublication) {
          await ready(priorPublication.revisionId);
          const prior = await runtimeRun(s, [priorPublication.revisionId]),
            worker = await lease(prior);
          expect(
            await loadEmployeeRuntimeReferences(
              prior.scope,
              prior.runtime.generationId,
              worker,
            ),
          ).toHaveLength(1);
          await completeJob({
            ...worker,
            result: { answer: 'EARLIER_LEGAL_DERIVED_TEXT', citations: [] },
          });
          sourceSessionId = prior.scope.sessionId;
        }
        const source = await runtimeRun(
          s,
          [published.revisionId],
          sourceSessionId,
        );
        const frozen = await runtimeRun(s, [], undefined, [
            source.scope.sessionId,
          ]),
          frozenWorker = await lease(frozen);
        const [snapshot] =
          await f.db`select prompt_snapshot->'sessionReferences' as refs from allrice_employee_runs where run_id=${frozen.scope.runId}`;
        const frozenIds = snapshot!.refs[0].messages.map(
          (m: { id: string }) => m.id,
        );
        expect(frozenIds).toContain(source.sent.userMessage.id);
        expect(frozenIds).not.toContain(source.sent.assistantMessage.id);
        await completeJob({
          ...frozenWorker,
          result: { answer: 'FROZEN_USER_ORIGINAL', citations: [] },
        });
        const worker = await lease(source);
        expect(
          await loadEmployeeRuntimeReferences(
            source.scope,
            source.runtime.generationId,
            worker,
          ),
        ).toHaveLength(1);
        await completeJob({
          ...worker,
          result: { answer: 'LATER_PRIVATE_DERIVED_TEXT', citations: [] },
        });
        const importer = await runtimeRun(s, [], undefined, [
          source.scope.sessionId,
        ]);
        await finish(importer);
        await change(s.owner, published.sourceId, 'delete');
        await expect(
          assertEmployeeContentContext(
            source.scope,
            source.runtime.generationId,
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        expect(
          await hasRevokedReferencePublicationHistory(
            s.owner,
            frozen.scope.sessionId,
          ),
        ).toBe(false);
        expect(
          await hasRevokedReferencePublicationHistory(
            s.owner,
            importer.scope.sessionId,
          ),
        ).toBe(true);
        await assertEmployeeContentContext(
          frozen.scope,
          frozen.runtime.generationId,
        );
        const continued = await runtimeRun(s, [], frozen.scope.sessionId);
        await finish(continued);
        await expect(
          prepareEmployeeContentContext(importer.scope),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        if (priorPublication) {
          await change(s.owner, priorPublication.sourceId, 'delete');
          expect(
            await hasRevokedReferencePublicationHistory(
              s.owner,
              frozen.scope.sessionId,
            ),
          ).toBe(true);
          await expect(
            assertEmployeeContentContext(
              frozen.scope,
              frozen.runtime.generationId,
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        }
      },
      120000,
    );

    it('exact early graph stays small after real future growth reaches 129; the actual own-generation limit still rejects', async () => {
      // First execution budget: 240s for 128 real send/prepare admissions,
      // 127 load/lease/terminal cycles, and the boundary/early-import checks.
      // Grow from 1 to 129 distinct rows without fabricated ER/read receipts;
      // keep the production 128 limit and every existing test deadline.
      const s = await setup(),
        published = await httpUpload(s.owner);
      await ready(published.revisionId);
      const early = await runtimeRun(s),
        earlyWorker = await lease(early);
      await completeJob({
        ...earlyWorker,
        result: { answer: 'EARLY_SMALL_GRAPH', citations: [] },
      });
      const frozen = await runtimeRun(s, [], undefined, [
          early.scope.sessionId,
        ]),
        frozenWorker = await lease(frozen);
      await completeJob({
        ...frozenWorker,
        result: { answer: 'FROZEN_SMALL_GRAPH', citations: [] },
      });
      const growthStages = { prepared: 0, read: 0, completed: 0 },
        growthStartedAt = performance.now();
      const reportGrowth = (phase: string) =>
        console.info('[MET247:reference-growth]', {
          phase,
          ...growthStages,
          elapsedMs: performance.now() - growthStartedAt,
        });
      for (let index = 0; index < 128; index++) {
        const sent = await sendChatMessage(
          s.owner,
          s.owner.workspaceId!,
          early.scope.sessionId,
          {
            clientMessageId: randomUUID(),
            text: '实际后续资料读取',
            referenceRevisionIds: [published.revisionId],
            deliveryMode: 'follow_up',
          },
        );
        const scope = { ...early.scope, runId: sent.run.id };
        const runtime = await prepareEmployeeContentContext(scope);
        expect(runtime!.generationId).toBe(early.runtime.generationId);
        growthStages.prepared++;
        if (index % 16 === 0) reportGrowth('prepared');
        if (index === 127) {
          reportGrowth('boundary');
          await assertEmployeeContentContext(
            frozen.scope,
            frozen.runtime.generationId,
          );
          const continued = await runtimeRun(s, [], frozen.scope.sessionId);
          await finish(continued);
          await expect(
            assertEmployeeContentContext(scope, runtime!.generationId),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
          await finish({ ...early, scope, sent, runtime: runtime! });
          break;
        }
        const run = { ...early, scope, sent, runtime: runtime! },
          worker = await lease(run);
        expect(
          await loadEmployeeRuntimeReferences(
            scope,
            runtime!.generationId,
            worker,
          ),
        ).toHaveLength(1);
        growthStages.read++;
        await completeJob({
          ...worker,
          result: { answer: 'LATER_GRAPH_DERIVED', citations: [] },
        });
        growthStages.completed++;
        if (index % 16 === 15) reportGrowth('completed');
      }
      expect(growthStages).toEqual({
        prepared: 128,
        read: 127,
        completed: 127,
      });
      reportGrowth('finished');
      const [growth] =
        await f.db`select count(*)::int n from allrice_employee_runs where content_generation_id=${early.runtime.generationId}`;
      expect(growth!.n).toBe(129);
      // Discovery rejects the own graph before any invalidation operation.
      // The frozen import still depends only on its exact early predecessors.
      const contexts =
        await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id in ${f.db([early.runtime.generationId, frozen.runtime.generationId])}`;
      expect(contexts).toHaveLength(2);
      expect(contexts.every((context) => context.invalidated_at === null)).toBe(
        true,
      );
      await expect(
        assertEmployeeContentContext(early.scope, early.runtime.generationId),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await assertEmployeeContentContext(
        frozen.scope,
        frozen.runtime.generationId,
      );
      const continued = await runtimeRun(s, [], frozen.scope.sessionId),
        continuedWorker = await lease(continued);
      expect(continued.runtime.generationId).toBe(frozen.runtime.generationId);
      await assertEmployeeContentContext(
        continued.scope,
        continued.runtime.generationId,
        continuedWorker,
      );
      await completeJob({
        ...continuedWorker,
        result: { answer: 'EARLY_GRAPH_REMAINS_SMALL', citations: [] },
      });
    }, 240000);

    it('rechecks repeated actual pins across authority changes and preserves PG retention and authentication expiry', async () => {
      const s = await setup(),
        reader = { ...s, owner: s.finance },
        a = await httpUpload(s.owner),
        b = await httpUpload(s.owner);
      await ready(b.revisionId);
      const prior: Awaited<ReturnType<typeof runtimeRun>>[] = [];
      let sessionId: string | undefined;
      for (const published of [a, a, b]) {
        const run = await runtimeRun(reader, [published.revisionId], sessionId),
          worker = await lease(run);
        if (prior.length)
          expect(run.runtime.generationId).toBe(prior[0]!.runtime.generationId);
        sessionId = run.scope.sessionId;
        expect(
          (
            await loadEmployeeRuntimeReferences(
              run.scope,
              run.runtime.generationId,
              worker,
            )
          ).map((result) => result.citation.reference?.revisionId),
        ).toEqual([published.revisionId]);
        await completeJob({
          ...worker,
          result: { answer: 'READ_EXACT_PUBLICATION', citations: [] },
        });
        prior.push(run);
      }
      const current = await runtimeRun(reader, [a.revisionId], sessionId),
        worker = await lease(current),
        retained = (await file(s.owner, b.revisionId)).object;
      expect(current.runtime.generationId).toBe(prior[0]!.runtime.generationId);
      await change(s.owner, b.sourceId, 'audience', 1, {
        scope: 'personal',
        departmentIds: [],
      });
      expect(
        await referenceEligibility(s.finance, current.scope.sessionId),
      ).toEqual({
        canContinue: false,
        reason: 'current_access_lost',
      });
      await expect(
        assertEmployeeContentContext(
          current.scope,
          current.runtime.generationId,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await change(s.owner, b.sourceId, 'audience', 2, {
        scope: 'company',
        departmentIds: [],
      });
      expect(
        await referenceEligibility(s.finance, current.scope.sessionId),
      ).toEqual({
        canContinue: true,
        reason: null,
      });
      await assertEmployeeContentContext(
        current.scope,
        current.runtime.generationId,
        worker,
      );
      // Finite retention always takes the original PG-clock path, even while
      // unexpired. Metadata changes here do not mutate immutable file bytes.
      await f.db`update allrice_storage_objects set retention_until=clock_timestamp()+interval '1 hour' where id=${retained.id}`;
      await assertEmployeeContentContext(
        current.scope,
        current.runtime.generationId,
        worker,
      );
      expect(
        await loadEmployeeRuntimeReferences(
          current.scope,
          current.runtime.generationId,
          worker,
        ),
      ).toHaveLength(1);
      await completeJob({
        ...worker,
        result: { answer: 'CURRENT_AUTHORITY_RECHECKED', citations: [] },
      });
      // Model an aged fixture so expiry follows creation even when the real
      // operations above finish in under one second.
      await f.db`update allrice_storage_objects set created_at=clock_timestamp()-interval '1 day',retention_until=clock_timestamp()-interval '1 second' where id=${retained.id}`;
      await expect(
        assertEmployeeContentContext(
          current.scope,
          current.runtime.generationId,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      expect(
        (
          await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${current.runtime.generationId}`
        )[0]!.invalidated_at,
      ).toBeNull();
      expect(
        await hasRevokedReferencePublicationHistory(
          s.finance,
          current.scope.sessionId,
        ),
      ).toBe(false);
      await change(s.owner, b.sourceId, 'delete', 3);
      expect(
        await hasRevokedReferencePublicationHistory(
          s.finance,
          current.scope.sessionId,
        ),
      ).toBe(true);
      await expect(
        assertEmployeeContentContext(
          current.scope,
          current.runtime.generationId,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        sendChatMessage(
          s.finance,
          s.finance.workspaceId!,
          current.scope.sessionId,
          {
            clientMessageId: randomUUID(),
            text: '请继续核对',
          },
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const early = prior[0]!;
      await assertEmployeeContentReferenceMessages(
        s.finance,
        early.scope.sessionId,
        [early.sent.assistantMessage.id],
      );
      // Authentication sessions enforce the same expiry-after-creation rule.
      await f.db`update allrice_sessions set created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where id=${s.finance.sessionId!}`;
      await expect(
        assertEmployeeContentReferenceMessages(
          s.finance,
          early.scope.sessionId,
          [early.sent.assistantMessage.id],
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    }, 120000);

    it.each([false, true])(
      'frozen early external messages do not inherit future publication reads (later generation=%s)',
      async (rotate) => {
        const s = await setup(),
          published = await httpUpload(s.owner);
        await ready(published.revisionId);
        const early = await runtimeRun(s),
          earlyWorker = await lease(early);
        await completeJob({
          ...earlyWorker,
          result: { answer: 'EARLY_CLEAN_ANSWER', citations: [] },
        });
        const frozen = await runtimeRun(s, [], undefined, [
            early.scope.sessionId,
          ]),
          frozenWorker = await lease(frozen);
        await completeJob({
          ...frozenWorker,
          result: { answer: 'FROZEN_EARLY_ANSWER', citations: [] },
        });
        if (rotate) {
          const body = Buffer.from('LEGACY_ROTATION_SOURCE');
          const old = await prepareReferenceUpload(s.owner, {
            workspaceId: s.owner.workspaceId,
            requestId: randomUUID(),
            scope: 'personal',
            fileName: 'legacy.txt',
            purpose: '',
            mediaType: 'text/plain',
            contentBase64: body.toString('base64'),
          });
          await browser.storage!.put(
            old.object,
            new Blob([new Uint8Array(body)]).stream(),
          );
          await completeReferenceUpload(
            s.owner,
            s.owner.workspaceId!,
            old.revisionId,
          );
          await ready(old.revisionId);
          const legacy = await runtimeRun(
              s,
              [old.revisionId],
              early.scope.sessionId,
            ),
            legacyWorker = await lease(legacy);
          expect(legacy.runtime.generationId).toBe(early.runtime.generationId);
          expect(
            await loadEmployeeRuntimeReferences(
              legacy.scope,
              legacy.runtime.generationId,
              legacyWorker,
            ),
          ).toHaveLength(1);
          await completeJob({
            ...legacyWorker,
            result: { answer: 'LATER_LEGACY_ANSWER', citations: [] },
          });
          await changeReference(s.owner, old.sourceId, {
            workspaceId: s.owner.workspaceId,
            requestId: randomUUID(),
            expectedRevision: 1,
            action: 'archive',
          });
        }
        const later = await runtimeRun(
            s,
            [published.revisionId],
            early.scope.sessionId,
          ),
          laterWorker = await lease(later);
        if (rotate)
          expect(later.runtime.generationId).not.toBe(
            early.runtime.generationId,
          );
        else
          expect(later.runtime.generationId).toBe(early.runtime.generationId);
        expect(
          await loadEmployeeRuntimeReferences(
            later.scope,
            later.runtime.generationId,
            laterWorker,
          ),
        ).toHaveLength(1);
        await completeJob({
          ...laterWorker,
          result: { answer: 'LATER_PROTECTED_ANSWER', citations: [] },
        });
        const inherited = await runtimeRun(s, [], early.scope.sessionId),
          inheritedWorker = await lease(inherited);
        expect(inherited.runtime.generationId).toBe(later.runtime.generationId);
        await completeJob({
          ...inheritedWorker,
          result: { answer: 'LATER_INHERITED_ANSWER', citations: [] },
        });
        const derived = rotate
          ? null
          : await runtimeRun(s, [], undefined, [early.scope.sessionId]);
        if (derived) await finish(derived);
        await change(s.owner, published.sourceId, 'delete');
        // Publication Q8 uses exact read/action facts rather than invalidating
        // the whole generation. An earlier legacy invalidation still binds.
        await expect(
          assertEmployeeContentContext(later.scope, later.runtime.generationId),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        expect(
          await hasRevokedReferencePublicationHistory(
            s.owner,
            frozen.scope.sessionId,
          ),
        ).toBe(false);
        if (derived)
          expect(
            await hasRevokedReferencePublicationHistory(
              s.owner,
              derived.scope.sessionId,
            ),
          ).toBe(true);
        if (rotate) {
          // Legacy invalidation rejects this frozen Run and its old messages.
          // An unbound new Run may still start with the old history excluded.
          await expect(
            assertEmployeeContentContext(
              frozen.scope,
              frozen.runtime.generationId,
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
          await expect(
            assertEmployeeContentReferenceMessages(
              s.owner,
              early.scope.sessionId,
              [early.sent.assistantMessage.id],
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        } else {
          await assertEmployeeContentContext(
            frozen.scope,
            frozen.runtime.generationId,
          );
          await assertEmployeeContentReferenceMessages(
            s.owner,
            early.scope.sessionId,
            [early.sent.assistantMessage.id],
          );
        }
        await expect(
          assertEmployeeContentReferenceMessages(
            s.owner,
            early.scope.sessionId,
            [later.sent.assistantMessage.id],
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        await expect(
          assertEmployeeContentReferenceMessages(
            s.owner,
            early.scope.sessionId,
            [inherited.sent.assistantMessage.id],
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        if (rotate)
          await expect(
            prepareEmployeeContentContext(frozen.scope),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        const continued = await runtimeRun(s, [], frozen.scope.sessionId),
          continuedWorker = await lease(continued);
        if (rotate) {
          expect(continued.runtime.generationId).not.toBe(
            frozen.runtime.generationId,
          );
          expect(continued.runtime.historyFromMessageId).toBe(
            continued.sent.userMessage.id,
          );
          for (const message of [
            frozen.sent.userMessage,
            frozen.sent.assistantMessage,
          ])
            expect(continued.runtime.allowedMessageIds).not.toContain(
              message.id,
            );
          expect(
            (
              await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${frozen.runtime.generationId}`
            )[0]!.invalidated_at,
          ).not.toBeNull();
        } else {
          expect(continued.runtime.generationId).toBe(
            frozen.runtime.generationId,
          );
        }
        await assertEmployeeContentContext(
          continued.scope,
          continued.runtime.generationId,
          continuedWorker,
        );
        expect(
          await loadEmployeeRuntimeReferences(
            continued.scope,
            continued.runtime.generationId,
            continuedWorker,
          ),
        ).toEqual([]);
        await completeJob({
          ...continuedWorker,
          result: {
            answer: 'FRESH_RUN_WITH_AUTHORIZED_HISTORY',
            citations: [],
          },
        });
        if (rotate) {
          await expect(
            assertEmployeeContentContext(
              frozen.scope,
              frozen.runtime.generationId,
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
          await expect(
            assertEmployeeContentReferenceMessages(
              s.owner,
              frozen.scope.sessionId,
              [frozen.sent.assistantMessage.id],
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        }
        if (derived)
          await expect(
            sendChatMessage(
              s.owner,
              s.owner.workspaceId!,
              derived.scope.sessionId,
              {
                clientMessageId: randomUUID(),
                text: '继续保护的后期回答',
              },
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      },
      120000,
    );

    it.each(['canceled', 'failed-read'] as const)(
      'a %s selection with no actual publication read permits a later ordinary send/prepare/leased guard after deletion',
      async (ending) => {
        const s = await setup(),
          reader = { ...s, owner: s.finance };
        const published = await httpUpload(s.owner);
        await ready(published.revisionId);
        const first = await runtimeRun(reader, [published.revisionId]),
          worker = await lease(first);
        let revision = 1;
        if (ending === 'canceled')
          await cancelRun(
            s.finance,
            s.finance.workspaceId!,
            first.scope.runId,
            { reason: 'user_requested' },
          );
        else {
          await change(s.owner, published.sourceId, 'audience', revision++, {
            scope: 'personal',
            departmentIds: [],
          });
          await expect(
            loadEmployeeRuntimeReferences(
              first.scope,
              first.runtime.generationId,
              worker,
            ),
          ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        }
        await failJob({
          ...worker,
          code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
          message: 'Stopped before publication bytes',
          retryable: false,
        });
        expect(
          (
            await f.db`select status,reference_reads from allrice_employee_runs where run_id=${first.scope.runId}`
          )[0],
        ).toMatchObject({
          status: ending === 'canceled' ? 'canceled' : 'failed',
          reference_reads: null,
        });
        await change(s.owner, published.sourceId, 'delete', revision);
        expect(
          await hasRevokedReferencePublicationHistory(
            s.finance,
            first.scope.sessionId,
          ),
        ).toBe(false);
        await expect(
          runtimeRun(reader, [published.revisionId], first.scope.sessionId),
        ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
        const next = await runtimeRun(reader, [], first.scope.sessionId),
          nextWorker = await lease(next);
        expect(next.runtime.generationId).toBe(first.runtime.generationId);
        await assertEmployeeContentContext(
          next.scope,
          next.runtime.generationId,
          nextWorker,
        );
        expect(
          await loadEmployeeRuntimeReferences(
            next.scope,
            next.runtime.generationId,
            nextWorker,
          ),
        ).toEqual([]);
        expect(
          (
            await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${next.runtime.generationId}`
          )[0]!.invalidated_at,
        ).toBeNull();
        expect(
          await f.db`select run_id from allrice_employee_runs where session_id=${next.scope.sessionId} and jsonb_array_length(reference_reads)>0`,
        ).toHaveLength(0);
        await completeJob({
          ...nextWorker,
          result: {
            answer: 'Ordinary continuation without publication bytes',
            citations: [],
          },
        });
        const imported = await runtimeRun(reader, [], undefined, [
            first.scope.sessionId,
          ]),
          importedWorker = await lease(imported);
        await assertEmployeeContentContext(
          imported.scope,
          imported.runtime.generationId,
          importedWorker,
        );
        await completeJob({
          ...importedWorker,
          result: {
            answer: 'Visible conversation without a publication dependency',
            citations: [],
          },
        });
      },
      120000,
    );

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
      // Freeze S→T→U→S through real admissions and terminal commits. The
      // Session back-reference must retain only its exact predecessor Runs.
      const relayed: Awaited<ReturnType<typeof runtimeRun>>[] = [];
      let upstream = source.scope.sessionId;
      for (const destination of [
        undefined,
        undefined,
        source.scope.sessionId,
      ]) {
        const relay = await runtimeRun(s, [], destination, [upstream]),
          relayWorker = await lease(relay);
        await assertEmployeeContentContext(
          relay.scope,
          relay.runtime.generationId,
          relayWorker,
        );
        await completeJob({
          ...relayWorker,
          result: { answer: 'RELAYED_FROZEN_REFERENCE', citations: [] },
        });
        relayed.push(relay);
        upstream = relay.scope.sessionId;
      }
      expect(upstream).toBe(source.scope.sessionId);
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
      expect(
        await referenceEligibility(s.owner, merelySelected.scope.sessionId),
      ).toEqual({
        canContinue: true,
        reason: null,
      });
      const newPublication = await httpUpload(s.owner);
      expect(newPublication.sourceId).not.toBe(published.sourceId);
      for (const run of relayed)
        expect(
          await hasRevokedReferencePublicationHistory(
            s.owner,
            run.scope.sessionId,
          ),
        ).toBe(true);
      for (const run of [source, imported, ...relayed]) {
        expect(
          await referenceEligibility(s.owner, run.scope.sessionId),
        ).toEqual({
          canContinue: false,
          reason: 'publication_revoked',
        });
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
      const { POST } =
        await import('../app/api/v1/sessions/[id]/messages/route.ts');
      browser.context = s.owner;
      const denied = await POST(
        new Request(
          `https://example.test/api/v1/sessions/${source.scope.sessionId}/messages?workspaceId=${s.owner.workspaceId}`,
          {
            method: 'POST',
            headers: {
              origin: 'https://example.test',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              clientMessageId: randomUUID(),
              text: '继续刚才的任务',
            }),
          },
        ),
        { params: Promise.resolve({ id: source.scope.sessionId }) },
      );
      expect(denied.status).toBe(409);
      expect((await denied.json()).error).toMatchObject({
        code: 'REFERENCE_PUBLICATION_REVOKED',
        retryable: false,
      });
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
