import {
  savePlatformEmployeeDraft,
  publishPlatformEmployee,
} from './platform-employees.ts';
import { randomUUID } from 'node:crypto';
import { updateQueuedMessage } from '../conversation/queued-messages.ts';
import {
  prepareReferenceUpload,
  completeReferenceUpload,
  changeReference,
} from '../reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../reference-processing.ts';
import {
  captureReferenceSelections,
  retrieveSelectedReferenceKnowledge,
  assertReferenceSelections,
} from '../reference-runtime.ts';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema } from '@allrice/contracts';
import type {
  EmployeeContentMutation,
  EmployeeContentReference,
  EmployeeContentReceipt,
  RequestContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from '../organization-administration.ts';
import { createOrganizationDepartment } from '../organization-departments.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../tenant-employees.ts';
import {
  getEmployeeWorkspace,
  createChatSession,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  createEmployeeInstance,
  updateEmployeeInstance,
  listEmployeeInstances,
} from './employee-instances.ts';
import {
  getEffectiveEmployeeContent,
  getEmployeeDetails,
  getEmployeeContentSet,
  getEmployeeContentHistory,
  mutateEmployeeContent,
} from './employee-content.ts';
import {
  getCompanyAsset,
  listCompanyAssets,
  listCompanyAssetRevisions,
  mutateCompanyAsset,
} from '../company-assets.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { listContextCheckpointEvidence } from '../conversation/conversation-checkpoint.ts';
import {
  acquireConversationRuntime,
  releaseConversationRuntime,
} from '../conversation/conversation-runtime.ts';
import { resolveEmployeeExecution } from './employeehub.ts';
import {
  prepareEmployeeContentContext,
  loadEmployeeRuntimeScene,
  loadEmployeeRuntimeReferences,
  readEmployeeReferenceCitations,
  adoptEmployeeRuntimeScene,
  assertEmployeeContentContext,
  readEmployeeRuntimeContent,
  assertEmployeeContentReferenceMessages,
} from './employee-runtime-content.ts';
const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
function contentGate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'layered employee content: isolated transactions and current authority',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
      admin: RequestContext,
      publication: Awaited<
        ReturnType<typeof createEmployeeAdministrationFixture>
      >;
    beforeAll(async () => {
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const p = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'content-platform@example.test',
        displayName: 'Platform',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      admin = (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
      publication = await createEmployeeAdministrationFixture(f.db);
      await publication.preview();
      expect((await publication.publish()).valid).toBe(true);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);
    async function setup() {
      const created = await createManagedOrganization(admin, {
        name: `Content-${randomUUID()}`,
      });
      const company = { ...created, workspaceId: created.defaultWorkspaceId! };
      const dept = (
        await createOrganizationDepartment(admin, company.organizationId, {
          name: 'Research',
          requestId: randomUUID(),
        })
      ).department;
      const otherDept = (
        await createOrganizationDepartment(admin, company.organizationId, {
          name: 'Finance',
          requestId: randomUUID(),
        })
      ).department;
      const people = (
        await importOrganizationPeople(admin, company.organizationId, {
          people: [
            {
              username: `owner-${randomUUID()}`,
              displayName: 'Owner',
              departmentId: dept.id,
              contentMaintenanceLevel: 'company',
            },
            {
              username: `peer-${randomUUID()}`,
              displayName: 'Peer',
              departmentId: dept.id,
              contentMaintenanceLevel: 'personal',
            },
            {
              username: `other-${randomUUID()}`,
              displayName: 'Other',
              departmentId: otherDept.id,
              contentMaintenanceLevel: 'department',
            },
          ],
        })
      ).created;
      const contexts: RequestContext[] = [],
        tokens: string[] = [];
      for (const person of people) {
        const login = await createSession(person.userId);
        tokens.push(login.token);
        contexts.push(
          (await authenticateSession(login.token, {
            organizationId: company.organizationId,
            workspaceId: company.workspaceId,
          }))!,
        );
      }
      const [a, b, c] = contexts as [
        RequestContext,
        RequestContext,
        RequestContext,
      ];
      const employee = (
        await listAdminTenantEmployees(
          admin,
          company.organizationId,
          company.workspaceId,
        )
      ).employees.find((e) => e.employeeId === publication.employeeId)!;
      await changeAdminTenantEmployee(admin, company.organizationId, {
        workspaceId: company.workspaceId,
        employeeId: publication.employeeId,
        action: 'assign',
        revisionId: employee.revisionId,
        expectedVersion: employee.deployment?.version ?? null,
      });
      const assigned = (
        await getEmployeeWorkspace(a, company.workspaceId)
      ).employees.find((e) => e.employeeKey === publication.definition.key)!;
      const [assignmentRow] = await f.db<
        { employee_id: string }[]
      >`select employee_id from allrice_employee_assignments where id=${assigned.id}`;
      const instance = await createEmployeeInstance(a, {
        workspaceId: company.workspaceId,
        assignmentId: assigned.id,
        requestId: randomUUID(),
        profile: { name: 'Research assistant' },
      });
      const base = {
        workspaceId: company.workspaceId,
        setId: randomUUID(),
        ownership: {
          scope: 'personal' as const,
          organizationId: company.organizationId,
          ownerId: a.actor.id,
        },
        target: { kind: 'instance' as const, instanceId: instance.id },
        requestId: randomUUID(),
        expectedRevision: 0,
        changeSummary: 'Fixed synthetic content',
      };
      const draft = (
        extra: Partial<
          Extract<EmployeeContentMutation, { operation: 'save_draft' }>
        > = {},
      ): Extract<EmployeeContentMutation, { operation: 'save_draft' }> => ({
        ...base,
        requestId: randomUUID(),
        operation: 'save_draft',
        manifest: {
          schemaVersion: 1,
          common: [],
          scenes: [],
          declaredConflicts: [],
        },
        textEdits: [],
        ...extra,
      });
      return {
        company,
        dept,
        otherDept,
        a,
        b,
        c,
        assigned,
        instance,
        employeeId: assignmentRow!.employee_id,
        base,
        draft,
        tokens,
      };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    async function knowledge(
      s: Setup,
      name: string,
      acl: 'workspace' | 'user' | 'employee' = 'workspace',
    ) {
      const sourceId = randomUUID(),
        revisionId = randomUUID(),
        bindingId = randomUUID();
      const definition = {
        schemaVersion: 1,
        sourceKind: 'managed',
        connectorBindingId: null,
        resourceRef: `synthetic:${name}`,
        indexing: 'none',
        updatePolicy: 'manual',
        citationRequired: true,
        allowedScopes: ['workspace'],
      };
      const checksum = runtimePolicyDigest(definition);
      await f.db`insert into allrice_knowledge_sources(id,organization_id,workspace_id,slug,name,description,created_by)
      values(${sourceId},${s.company.organizationId},${s.company.workspaceId},${`source-${sourceId}`},${name},${name},${s.a.actor.id})`;
      await f.db`insert into allrice_knowledge_revisions(id,organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by)
      values(${revisionId},${s.company.organizationId},${s.company.workspaceId},${sourceId},1,${name},${name},'draft',${f.db.json(definition)},${checksum},${s.a.actor.id})`;
      await f.db`insert into allrice_knowledge_acl_entries(organization_id,workspace_id,knowledge_revision_id,principal_type,principal_id,permission)
      values(${s.company.organizationId},${s.company.workspaceId},${revisionId},${acl},${acl === 'user' ? s.a.actor.id : acl === 'employee' ? s.employeeId : s.company.workspaceId},'read')`;
      await f.db`update allrice_knowledge_revisions set status='published',published_at=now() where id=${revisionId}`;
      await f.db`insert into allrice_employee_knowledge_bindings(id,organization_id,workspace_id,employee_id,knowledge_revision_id,bound_by)
      values(${bindingId},${s.company.organizationId},${s.company.workspaceId},${s.employeeId},${revisionId},${s.a.actor.id})`;
      return {
        ref: {
          sourceKind: 'knowledge' as const,
          contentId: sourceId,
          revisionId,
          digest: checksum,
        },
        bindingId,
      };
    }
    function text(body = 'Preserve source values; show calculations.') {
      return {
        contentId: randomUUID(),
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'requirement' as const,
        title: 'Common rule',
        body,
      };
    }
    function action(
      input: EmployeeContentMutation,
      receipt: EmployeeContentReceipt,
      operation: 'validate' | 'activate',
    ): EmployeeContentMutation {
      return {
        workspaceId: input.workspaceId,
        setId: input.setId,
        ownership: input.ownership,
        target: input.target,
        expectedRevision: receipt.revision,
        requestId: randomUUID(),
        changeSummary: operation,
        operation,
        candidateRevisionId: receipt.candidate.id,
        candidateDigest: receipt.candidate.digest,
      };
    }
    async function enable(s: Setup, input: EmployeeContentMutation) {
      const saved = await mutateEmployeeContent(s.a, input),
        check = await mutateEmployeeContent(
          s.a,
          action(input, saved, 'validate'),
        );
      expect(check.validation?.valid).toBe(true);
      return mutateEmployeeContent(s.a, action(input, check, 'activate'));
    }
    async function runtimeRun(
      s: Setup,
      sessionId?: string,
      custom = true,
      sessionReferenceIds: string[] = [],
      referenceRevisionIds: string[] = [],
      request = 'Use current requirements',
    ) {
      const session = sessionId
        ? { id: sessionId }
        : await createChatSession(s.a, {
            workspaceId: s.company.workspaceId,
            title: 'Isolated runtime content',
            ...(custom
              ? { employeeInstanceId: s.instance.id }
              : { employeeAssignmentId: s.assigned.id }),
          });
      const sent = await sendChatMessage(
        s.a,
        s.company.workspaceId,
        session.id,
        {
          text: request,
          clientMessageId: randomUUID(),
          sessionReferenceIds,
          ...(referenceRevisionIds.length ? { referenceRevisionIds } : {}),
          ...(sessionReferenceIds.length || referenceRevisionIds.length
            ? { deliveryMode: 'follow_up' }
            : {}),
        },
      );
      const scope = {
        organizationId: s.company.organizationId,
        workspaceId: s.company.workspaceId,
        ownerId: s.a.actor.id,
        sessionId: session.id,
        runId: sent.run.id,
      };
      const resolved = await resolveEmployeeExecution(scope);
      const runtime = await prepareEmployeeContentContext(scope);
      expect(runtime).not.toBeNull();
      const finish = async () => {
        await f.db`update allrice_jobs set status='canceled',completed_at=now() where run_id=${sent.run.id}`;
        await f.db`update allrice_runs set state='canceled',completed_at=now() where id=${sent.run.id}`;
        await f.db`update allrice_employee_runs set status='canceled',completed_at=now() where run_id=${sent.run.id}`;
      };
      return { scope, sent, resolved, runtime: runtime!, finish };
    }

    async function readyReference(
      s: Setup,
      body = 'REFERENCE_V1 budget=1000 spent=300 balance=700',
      scope: 'company' | 'department' | 'personal' = 'company',
      previous?: { sourceId: string; revision: number },
    ) {
      const input = {
        workspaceId: s.company.workspaceId,
        requestId: randomUUID(),
        scope,
        ...(scope === 'department' ? { departmentId: s.dept.id } : {}),
        ...(previous
          ? { sourceId: previous.sourceId, expectedRevision: previous.revision }
          : {}),
        fileName: '已确认口径.txt',
        purpose: '核对预算',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(body).toString('base64'),
      };
      const ref = await prepareReferenceUpload(s.a, input);
      await runtimeFixtureStorage(f.db).put(
        ref.object,
        new Blob([new Uint8Array(ref.bytes)]).stream(),
      );
      await completeReferenceUpload(s.a, s.company.workspaceId, ref.revisionId);
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(ref.revisionId);
      await finishReferenceProcessing(claim!, [
        { content: body, start: 0, end: body.length },
      ]);
      return ref;
    }
    async function archiveReference(s: Setup, sourceId: string, revision = 1) {
      await changeReference(s.a, sourceId, {
        workspaceId: s.company.workspaceId,
        requestId: randomUUID(),
        expectedRevision: revision,
        action: 'archive',
      });
    }
    async function managedRef(s: Setup, result: { revisionId: string }) {
      const [pin] = await f.db.begin((tx) =>
        captureReferenceSelections(s.a, [result.revisionId], tx),
      );
      return {
        sourceKind: 'knowledge' as const,
        contentId: pin!.sourceId,
        revisionId: pin!.revisionId,
        digest: pin!.digest,
      };
    }
    async function referenceArtifact(
      run: Awaited<ReturnType<typeof runtimeRun>>,
    ) {
      const {
        organizationId: org,
        workspaceId: ws,
        ownerId: owner,
        runId,
        sessionId,
      } = run.scope;
      const id = randomUUID(),
        objectId = randomUUID(),
        checksum = `sha256:${'a'.repeat(64)}`;
      await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
        values(${objectId},${org},${ws},${owner},${`organizations/${org}/workspaces/${ws}/owners/${owner}/artifacts/${objectId}`},'artifacts','text/plain',1,${checksum},'ready',true)`;
      await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
        values(${id},${org},${ws},${owner},${objectId},${randomUUID()},1,${sessionId},'sources.txt','text')`;
      await f.db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
        values(${id},${org},${ws},${owner},${runId},'document',${f.db.json({ kind: 'model_proposal', runId, operationId: null, stepId: null, referenceReads: ['untrusted claim'] })},${randomUUID()},${checksum})`;
      return id;
    }
    it('bound references retrieve Chinese/common and selected-scene excerpts with stable receipts, exact versions and per-version artifact sources', async () => {
      const s = await setup(),
        common = await readyReference(s, '预算总额为873元。'),
        weekly = await readyReference(s, '预算已花费218元。WEEK_ONLY'),
        monthly = await readyReference(s, '月度利润999元。MONTH_ONLY'),
        sceneId = randomUUID(),
        otherId = randomUUID();
      await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [await managedRef(s, common)],
            declaredConflicts: [],
            scenes: [
              {
                id: sceneId,
                name: '每周核算',
                appliesWhen: '周度预算',
                references: [
                  await managedRef(s, weekly),
                  await managedRef(s, common),
                ],
              },
              {
                id: otherId,
                name: '月度利润',
                appliesWhen: '月度',
                references: [await managedRef(s, monthly)],
              },
            ],
          },
        }),
      );
      const run = await runtimeRun(
          s,
          undefined,
          true,
          [],
          [],
          '请核对预算总额及预算花费',
        ),
        worker = await sceneLease(run);
      await readyReference(s, '预算总额改为9999元。', 'company', {
        sourceId: common.sourceId,
        revision: 1,
      });
      const initial = await loadEmployeeRuntimeReferences(
        run.scope,
        run.runtime.generationId,
        worker,
      );
      expect(initial).toHaveLength(1);
      expect(initial[0]!.content).toBe('预算总额为873元。');
      expect(initial[0]!.citation).toMatchObject({
        referenceLabel: 'R1',
        reference: { revisionId: common.revisionId, revision: 1 },
      });
      await f.db`update allrice_knowledge_chunks set id=${randomUUID()} where document_id=${initial[0]!.citation.documentId}`;
      expect(
        await loadEmployeeRuntimeReferences(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).toEqual(initial);
      const artifactBefore = await referenceArtifact(run),
        scene = run.runtime.scenes.find((x) => x.id === sceneId)!;
      const loaded = await loadEmployeeRuntimeScene(
        run.scope,
        run.runtime.generationId,
        { sceneId, sceneDigest: scene.digest },
        worker,
      );
      expect(loaded.knowledge).toHaveLength(2);
      expect(
        loaded.knowledge.find(
          (k) => k.citation.reference!.revisionId === common.revisionId,
        )!.citation.referenceLabel,
      ).toBe('R1');
      expect(
        loaded.knowledge.find(
          (k) => k.citation.reference!.revisionId === weekly.revisionId,
        )!.citation.referenceLabel,
      ).toBe('R2');
      expect(JSON.stringify(loaded)).not.toContain('MONTH_ONLY');
      const citations = await readEmployeeReferenceCitations(run.scope);
      expect(citations.map((c) => c.referenceLabel)).toEqual(['R1', 'R2']);
      const artifactAfter = await referenceArtifact(run);
      const { getWorkbenchArtifact } = await import('../artifact-review.ts');
      expect(
        (await getWorkbenchArtifact(s.a, run.scope.sessionId, artifactBefore))
          .provenance.referenceReads,
      ).toHaveLength(1);
      const sources = (
        await getWorkbenchArtifact(s.a, run.scope.sessionId, artifactAfter)
      ).provenance.referenceReads!;
      expect(sources).toHaveLength(2);
      expect(sources.map((r) => r.origin.kind)).toEqual(['common', 'scene']);
      expect(
        sources.every(
          (r) => r.runId === run.scope.runId && r.jobId === worker.jobId,
        ),
      ).toBe(true);
      await expect(
        f.db`update allrice_employee_runs set reference_reads='[]' where run_id=${run.scope.runId}`,
      ).rejects.toThrow();
      await archiveReference(s, weekly.sourceId);
      await expect(
        assertEmployeeContentContext(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      // Historical source evidence remains; current file access must still reject.
      expect(
        (await getWorkbenchArtifact(s.a, run.scope.sessionId, artifactAfter))
          .provenance.referenceReads,
      ).toEqual(sources);
      await expect(
        getWorkbenchArtifact(s.b, run.scope.sessionId, artifactAfter),
      ).rejects.toThrow();
      await releaseConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        outcome: 'idle',
      });
      await run.finish();
      const next = await runtimeRun(
          s,
          run.scope.sessionId,
          true,
          [],
          [],
          '计算月度利润',
        ),
        nextWorker = await sceneLease(next);
      expect(next.runtime.nativeContextKey).not.toBe(
        run.runtime.nativeContextKey,
      );
      const month = next.runtime.scenes.find((x) => x.id === otherId)!;
      const nextLoaded = await loadEmployeeRuntimeScene(
        next.scope,
        next.runtime.generationId,
        { sceneId: month.id, sceneDigest: month.digest },
        nextWorker,
      );
      expect(nextLoaded.knowledge.map((k) => k.content)).toEqual([
        '月度利润999元。MONTH_ONLY',
      ]);
      expect(
        JSON.stringify(await readEmployeeReferenceCitations(next.scope)),
      ).not.toContain(weekly.revisionId);
      await releaseConversationRuntime({
        ...next.scope,
        workerId: nextWorker.workerId,
        outcome: 'idle',
      });
      await next.finish();
    }, 120000);
    it('bound references do not label an irrelevant, unready or missing index as read; common-only tasks get distinct native contexts', async () => {
      const s = await setup(),
        ref = await readyReference(s, '火星探测器运行速度。');
      await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [await managedRef(s, ref)],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const run = await runtimeRun(
          s,
          undefined,
          true,
          [],
          [],
          '请核对预算支出',
        ),
        worker = await sceneLease(run);
      expect(
        await loadEmployeeRuntimeReferences(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).toEqual([]);
      expect(await readEmployeeReferenceCitations(run.scope)).toEqual([]);
      await f.db`update allrice_knowledge_documents set active=false where knowledge_revision_id=${ref.revisionId}`;
      await expect(
        loadEmployeeRuntimeReferences(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      expect(await readEmployeeReferenceCitations(run.scope)).toEqual([]);
      await f.db`update allrice_knowledge_documents set active=true where knowledge_revision_id=${ref.revisionId}`;
      await releaseConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        outcome: 'idle',
      });
      await run.finish();
      const next = await runtimeRun(
          s,
          run.scope.sessionId,
          true,
          [],
          [],
          '查阅火星探测器速度',
        ),
        nextWorker = await sceneLease(next);
      expect(next.runtime.nativeContextKey).not.toBe(
        run.runtime.nativeContextKey,
      );
      expect(
        (
          await loadEmployeeRuntimeReferences(
            next.scope,
            next.runtime.generationId,
            nextWorker,
          )
        ).map((r) => r.content),
      ).toEqual(['火星探测器运行速度。']);
      await releaseConversationRuntime({
        ...next.scope,
        workerId: nextWorker.workerId,
        outcome: 'idle',
      });
      await next.finish();
    }, 120000);
    it('bound reference evidence remains subject to the importing reader and every native compaction guard', async () => {
      const s = await setup(),
        ref = await readyReference(s, '预算100元', 'department');
      await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [await managedRef(s, ref)],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const source = await runtimeRun(s, undefined, true, [], [], '核对预算'),
        worker = await sceneLease(source);
      await loadEmployeeRuntimeReferences(
        source.scope,
        source.runtime.generationId,
        worker,
      );
      await releaseConversationRuntime({
        ...source.scope,
        workerId: worker.workerId,
        outcome: 'idle',
      });
      await source.finish();
      await f.db`update allrice_messages set status='completed',content=${f.db.json({ text: 'DERIVED_BUDGET_100', citations: [] })} where id=${source.sent.assistantMessage.id}`;
      const imported = await runtimeRun(s, undefined, false, [
        source.scope.sessionId,
      ]);
      await assertEmployeeContentContext(
        imported.scope,
        imported.runtime.generationId,
      );
      await archiveReference(s, ref.sourceId);
      await expect(
        assertEmployeeContentContext(
          imported.scope,
          imported.runtime.generationId,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        assertEmployeeContentReferenceMessages(s.a, source.scope.sessionId, [
          source.sent.assistantMessage.id,
        ]),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      expect(await readEmployeeReferenceCitations(source.scope)).toHaveLength(
        1,
      );
      await imported.finish();
    }, 120000);

    it.each(['personal', 'department'] as const)(
      'bound references cannot promote a %s source into company content',
      async (scope) => {
        const s = await setup(),
          ref = await readyReference(s, '预算100元', scope),
          pin = await managedRef(s, ref);
        const draft = s.draft({
          ownership: {
            scope: 'company',
            organizationId: s.company.organizationId,
          },
          target: { kind: 'employee', employeeId: s.employeeId },
          manifest: {
            schemaVersion: 1,
            common: [pin],
            scenes: [],
            declaredConflicts: [],
          },
        });
        const saved = await mutateEmployeeContent(s.a, draft),
          checked = await mutateEmployeeContent(
            s.a,
            action(draft, saved, 'validate'),
          );
        expect(checked.validation?.valid).toBe(false);
        expect(checked.validation?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'source_scope_mismatch' }),
          ]),
        );
        const forged = s.draft({
          setId: randomUUID(),
          manifest: {
            schemaVersion: 1,
            common: [{ ...pin, digest: `sha256:${'0'.repeat(64)}` }],
            scenes: [],
            declaredConflicts: [],
          },
        });
        const fs = await mutateEmployeeContent(s.a, forged),
          fc = await mutateEmployeeContent(s.a, action(forged, fs, 'validate'));
        expect(fc.validation?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'source_changed' }),
          ]),
        );
      },
    );
    it('bound reference excerpts and receipts do not survive lease cancellation while waiting for the index query', async () => {
      const s = await setup(),
        ref = await readyReference(s, '预算100元');
      await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [await managedRef(s, ref)],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const run = await runtimeRun(s, undefined, true, [], [], '核对预算'),
        worker = await sceneLease(run),
        ready = contentGate<number>(),
        release = contentGate<void>();
      const holder = f.db.begin(async (tx) => {
        const [pid] = await tx`select pg_backend_pid() id`;
        await tx`lock table allrice_knowledge_chunks in access exclusive mode`;
        ready.resolve(pid!.id);
        await release.promise;
      });
      const pid = await ready.promise;
      const reading = loadEmployeeRuntimeReferences(
        run.scope,
        run.runtime.generationId,
        worker,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      try {
        await expect
          .poll(
            async () => {
              const [r] =
                await f.db`select count(*)::int n from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`;
              return r!.n;
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await f.db`update allrice_jobs set cancel_requested_at=now() where id=${worker.jobId}`;
      } finally {
        release.resolve();
      }
      await holder;
      expect(await reading).toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      });
      expect(await readEmployeeReferenceCitations(run.scope)).toEqual([]);
      await releaseConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        outcome: 'idle',
      });
      await run.finish();
    }, 120000);

    it('references pin the chosen version through ordinary admission, message replay and verified source retrieval', async () => {
      const s = await setup(),
        ref = await readyReference(s);
      const run = await runtimeRun(s, undefined, false, [], [ref.revisionId]);
      const pins = run.resolved.promptSnapshot.referenceSelections!;
      expect(pins).toHaveLength(1);
      expect(pins[0]).toMatchObject({
        revisionId: ref.revisionId,
        checksum: ref.object.checksum,
        revision: 1,
      });
      expect(pins[0]!.digest).not.toBe(ref.object.checksum);
      const [stored] =
        await f.db`select content,client_message_id from allrice_messages where id=${run.sent.userMessage.id}`;
      expect(stored!.content.referenceSelections).toEqual(pins);
      const replayInput = {
        clientMessageId: stored!.client_message_id,
        text: 'Use current requirements',
        sessionReferenceIds: [],
        referenceRevisionIds: [ref.revisionId],
        deliveryMode: 'follow_up',
      };
      expect(
        (
          await sendChatMessage(
            s.a,
            s.company.workspaceId,
            run.scope.sessionId,
            replayInput,
          )
        ).run.id,
      ).toBe(run.scope.runId);
      const v2 = await readyReference(
        s,
        'REFERENCE_V2 budget=2000',
        'company',
        { sourceId: ref.sourceId, revision: 1 },
      );
      await expect(
        sendChatMessage(s.a, s.company.workspaceId, run.scope.sessionId, {
          ...replayInput,
          referenceRevisionIds: [v2.revisionId],
        }),
      ).rejects.toMatchObject({ code: 'input_id_conflict' });
      const results = await retrieveSelectedReferenceKnowledge({
        context: s.a,
        selections: pins,
        query: '核对预算',
      });
      expect(results.map((r) => r.content).join('')).toContain('REFERENCE_V1');
      expect(JSON.stringify(results)).not.toContain('REFERENCE_V2');
      expect(results[0]!.citation.reference).toEqual(pins[0]);
      await assertEmployeeContentContext(run.scope, run.runtime.generationId);
      await run.finish();
      const next = await runtimeRun(s, run.scope.sessionId, false);
      expect(next.resolved.promptSnapshot.referenceSelections).toBeUndefined();
      expect(next.runtime.nativeContextKey).not.toBe(
        run.runtime.nativeContextKey,
      );
      await next.finish();
    }, 120000);
    it('references use reader ownership without maintenance privilege and deny personal, cross-company and changed-department access', async () => {
      const s = await setup(),
        other = await setup();
      const ref = await readyReference(s, 'DEPARTMENT_ONLY', 'department');
      const pins = await f.db.begin((tx) =>
        captureReferenceSelections(s.b, [ref.revisionId], tx),
      );
      expect(
        (
          await retrieveSelectedReferenceKnowledge({
            context: s.b,
            selections: pins,
            query: '部门',
          })
        )[0]!.content,
      ).toBe('DEPARTMENT_ONLY');
      for (const reader of [s.c, other.a])
        await expect(
          retrieveSelectedReferenceKnowledge({
            context: reader,
            selections: pins,
            query: '部门',
          }),
        ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      await f.db`update allrice_organization_people set department_id=${s.otherDept.id} where organization_id=${s.company.organizationId} and user_id=${s.b.actor.id}`;
      await expect(
        retrieveSelectedReferenceKnowledge({
          context: s.b,
          selections: pins,
          query: '部门',
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      const privateRef = await readyReference(s, 'PRIVATE_ONLY', 'personal');
      await expect(
        f.db.begin((tx) =>
          captureReferenceSelections(s.b, [privateRef.revisionId], tx),
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      await expect(
        f.db.begin((tx) =>
          assertReferenceSelections(
            s.a,
            [{ ...pins[0], checksum: `sha256:${'0'.repeat(64)}` }],
            tx,
            true,
          ),
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    }, 120000);
    it('references revoke native history, compressed context and imported answers without creating a permanent employee binding', async () => {
      const s = await setup(),
        ref = await readyReference(s);
      const source = await runtimeRun(
        s,
        undefined,
        false,
        [],
        [ref.revisionId],
      );
      await source.finish();
      await f.db`update allrice_messages set status='completed',content=${f.db.json({ text: 'DERIVED_REFERENCE_700', citations: [] })} where id=${source.sent.assistantMessage.id}`;
      const imported = await runtimeRun(s, undefined, false, [
        source.scope.sessionId,
      ]);
      await imported.finish();
      await assertEmployeeContentContext(
        imported.scope,
        imported.runtime.generationId,
      );
      await archiveReference(s, ref.sourceId);
      for (const r of [source, imported])
        await expect(
          assertEmployeeContentContext(r.scope, r.runtime.generationId),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        prepareEmployeeContentContext(source.scope),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const next = await runtimeRun(s, source.scope.sessionId, false);
      expect(next.runtime.generationId).not.toBe(source.runtime.generationId);
      expect(next.runtime.allowedMessageIds).not.toContain(
        source.sent.assistantMessage.id,
      );
      expect(next.resolved.promptSnapshot.referenceSelections).toBeUndefined();
      await next.finish();
    }, 120000);
    it('references in queued messages cannot be promoted into a text-only steering turn', async () => {
      const s = await setup(),
        ref = await readyReference(s);
      const first = await runtimeRun(s, undefined, false);
      await sceneLease(first);
      const queued = await sendChatMessage(
        s.a,
        s.company.workspaceId,
        first.scope.sessionId,
        {
          clientMessageId: randomUUID(),
          text: '使用资料的新任务',
          deliveryMode: 'follow_up',
          referenceRevisionIds: [ref.revisionId],
        },
      );
      await expect(
        updateQueuedMessage(
          s.a,
          s.company.workspaceId,
          first.scope.sessionId,
          queued.userMessage.id,
          {
            action: 'steer',
            expectedTurnId: 'synthetic-turn',
            expectedGeneration: 1,
          },
        ),
      ).rejects.toMatchObject({ code: 'queued_references_require_turn' });
      await updateQueuedMessage(
        s.a,
        s.company.workspaceId,
        first.scope.sessionId,
        queued.userMessage.id,
        { action: 'edit' },
      );
      const [stored] =
        await f.db`select content from allrice_messages where id=${queued.userMessage.id}`;
      expect(stored!.content.referenceSelections[0].revisionId).toBe(
        ref.revisionId,
      );
      await first.finish();
    }, 120000);
    it.each(['archive', 'department'])(
      'references recheck current authority after waiting for %s locks',
      async (kind) => {
        const s = await setup(),
          ref = await readyReference(s, 'LOCKED_PRIVATE_BODY', 'department');
        const pins = await f.db.begin((tx) =>
          captureReferenceSelections(s.b, [ref.revisionId], tx),
        );
        const ready = contentGate<number>(),
          release = contentGate<void>();
        const holder = f.db.begin(async (tx) => {
          const [pid] = await tx`select pg_backend_pid() as id`;
          if (kind === 'archive')
            await tx`update allrice_knowledge_sources set status='archived' where id=${ref.sourceId}`;
          else
            await tx`update allrice_organization_people set department_id=${s.otherDept.id} where organization_id=${s.company.organizationId} and user_id=${s.b.actor.id}`;
          ready.resolve(pid!.id);
          await release.promise;
        });
        const pid = await ready.promise;
        const waiting = retrieveSelectedReferenceKnowledge({
          context: s.b,
          selections: pins,
          query: 'PRIVATE',
        }).then(
          (body) => ({ body }),
          (error: unknown) => error,
        );
        try {
          await expect
            .poll(
              async () =>
                (
                  await f.db`select count(*)::int n from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`
                )[0]!.n,
              { timeout: 5000 },
            )
            .toBeGreaterThan(0);
        } finally {
          release.resolve();
        }
        await holder;
        expect(await waiting).toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      },
      120000,
    );
    it('references revoked between message commit and final queue admission never create a Run, including replay', async () => {
      const s = await setup(),
        ref = await readyReference(s);
      const session = await createChatSession(s.a, {
        workspaceId: s.company.workspaceId,
        employeeAssignmentId: s.assigned.id,
      });
      const module = await import('./employeehub.ts'),
        original = module.prepareEmployeeRunBinding;
      const spy = vi
        .spyOn(module, 'prepareEmployeeRunBinding')
        .mockImplementationOnce(async (input) => {
          const binding = await original(input);
          await archiveReference(s, ref.sourceId);
          return binding;
        });
      const input = {
        clientMessageId: randomUUID(),
        text: 'ADMISSION_RACE',
        deliveryMode: 'follow_up',
        referenceRevisionIds: [ref.revisionId],
      };
      try {
        await expect(
          sendChatMessage(s.a, s.company.workspaceId, session.id, input),
        ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      } finally {
        spy.mockRestore();
      }
      await expect(
        sendChatMessage(s.a, s.company.workspaceId, session.id, input),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      expect(
        await f.db`select run_id from allrice_employee_runs where session_id=${session.id}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_messages where session_id=${session.id} and role='user'`,
      ).toHaveLength(1);
    }, 120000);
    it('references reject missing indexes and stale index checksums instead of reporting fabricated adoption', async () => {
      const s = await setup(),
        ref = await readyReference(s);
      const pins = await f.db.begin((tx) =>
        captureReferenceSelections(s.a, [ref.revisionId], tx),
      );
      await f.db`update allrice_knowledge_documents set checksum=${`sha256:${'0'.repeat(64)}`} where knowledge_revision_id=${ref.revisionId}`;
      await expect(
        retrieveSelectedReferenceKnowledge({
          context: s.a,
          selections: pins,
          query: 'budget',
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      await f.db`update allrice_knowledge_processing set state='unsupported' where revision_id=${ref.revisionId}`;
      await expect(
        f.db.begin((tx) =>
          captureReferenceSelections(s.a, [ref.revisionId], tx),
        ),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      const session = await createChatSession(s.a, {
        workspaceId: s.company.workspaceId,
        employeeAssignmentId: s.assigned.id,
      });
      await expect(
        sendChatMessage(s.a, s.company.workspaceId, session.id, {
          text: 'read',
          clientMessageId: randomUUID(),
          referenceRevisionIds: [ref.revisionId],
          deliveryMode: 'follow_up',
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
      expect(
        await f.db`select id from allrice_messages where session_id=${session.id}`,
      ).toHaveLength(0);
    }, 120000);

    async function sceneLease(run: Awaited<ReturnType<typeof runtimeRun>>) {
      const worker = {
        workerId: randomUUID(),
        jobId: '',
        leaseToken: randomUUID(),
      };
      const [job] =
        await f.db`update allrice_jobs set status='running',worker_id=${worker.workerId},lease_token=${worker.leaseToken},claimed_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '10 minutes' where run_id=${run.scope.runId} returning id`;
      worker.jobId = job!.id;
      await acquireConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        configChecksum: `sha256:${'c'.repeat(64)}`,
        compactThresholdTokens: 40000,
      });
      return worker;
    }
    async function sceneSetup(overlap = false) {
      const s = await setup(),
        week = text('WEEK_ONLY_47'),
        month = text('MONTH_ONLY_86');
      const ids = [randomUUID(), randomUUID()];
      await enable(
        s,
        s.draft({
          textEdits: [week, month],
          manifest: {
            schemaVersion: 1,
            common: [],
            declaredConflicts: [],
            scenes: [week, month].map((t, i) => ({
              id: ids[i]!,
              name: '经营复盘',
              appliesWhen: i ? '月度' : '每周',
              references: [
                { sourceKind: 'draft_text' as const, contentId: t.contentId },
                ...(overlap && i === 1
                  ? [
                      {
                        sourceKind: 'draft_text' as const,
                        contentId: week.contentId,
                      },
                    ]
                  : []),
              ],
            })),
          },
        }),
      );
      return { s, ids };
    }
    it('restores an immutable historical manifest as a new candidate, with current validation and unchanged frozen Runs', async () => {
      const s = await setup(),
        t = text('HISTORICAL_REQUIREMENT_73');
      const first = s.draft({
        textEdits: [t],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: t.contentId }],
          scenes: [],
          declaredConflicts: [],
        },
      });
      const original = await enable(s, first),
        run = await runtimeRun(s);
      const frozen =
        await f.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${run.sent.run.id}`;
      const changed = await enable(
        s,
        s.draft({ expectedRevision: original.revision }),
      );
      const input = {
        ...s.base,
        operation: 'restore_draft' as const,
        requestId: randomUUID(),
        expectedRevision: changed.revision,
        sourceRevisionId: original.candidate.id,
      };
      const restored = await mutateEmployeeContent(s.a, input);
      expect(restored.candidate.id).not.toBe(original.candidate.id);
      expect(restored.candidate.digest).toBe(original.candidate.digest);
      expect(restored.active).toEqual(changed.active);
      expect(restored.validation).toBeNull();
      expect(await mutateEmployeeContent(s.a, input)).toEqual(restored);
      await expect(
        mutateEmployeeContent(s.a, action(input, restored, 'activate')),
      ).rejects.toMatchObject({ code: 'validation_required' });
      const validated = await mutateEmployeeContent(
        s.a,
        action(input, restored, 'validate'),
      );
      expect(validated.validation?.valid).toBe(true);
      const active = await mutateEmployeeContent(
        s.a,
        action(input, validated, 'activate'),
      );
      expect(active.active).toEqual(restored.candidate);
      expect(
        (await getEmployeeContentSet(s.a, s.base.setId)).set.active
          ?.restoredFromRevisionId,
      ).toBe(original.candidate.id);
      const history = await getEmployeeContentHistory(s.a, s.base.setId);
      expect(history.revisions.map((r) => r.id)).toEqual([
        restored.candidate.id,
        changed.candidate.id,
        original.candidate.id,
      ]);
      expect(
        (
          await getEmployeeContentHistory(
            s.a,
            s.base.setId,
            history.revisions[1]!.number,
          )
        ).revisions.map((r) => r.id),
      ).toEqual([original.candidate.id]);
      await expect(
        getEmployeeContentHistory(s.b, s.base.setId),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        await f.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${run.sent.run.id}`,
      ).toEqual(frozen);
      await assertEmployeeContentContext(run.scope, run.runtime.generationId);
      await run.finish();
    });
    it('refuses restore from another set or an explicitly invalidated publication', async () => {
      const s = await setup(),
        other = await setup(),
        original = await enable(s, s.draft()),
        foreign = await enable(other, other.draft());
      const saved = await mutateEmployeeContent(
        s.a,
        s.draft({ expectedRevision: original.revision }),
      );
      const validated = await mutateEmployeeContent(
        s.a,
        action(s.draft(), saved, 'validate'),
      );
      const current = await mutateEmployeeContent(s.a, {
        ...action(s.draft(), validated, 'activate'),
        invalidatePrevious: true,
      });
      const input = {
        ...s.base,
        operation: 'restore_draft',
        requestId: randomUUID(),
        expectedRevision: current.revision,
        sourceRevisionId: original.candidate.id,
      };
      await expect(mutateEmployeeContent(s.a, input)).rejects.toMatchObject({
        code: 'source_changed',
      });
      await expect(
        mutateEmployeeContent(s.a, {
          ...input,
          sourceRevisionId: foreign.candidate.id,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (await getEmployeeContentHistory(s.a, s.base.setId)).revisions.find(
          (r) => r.id === original.candidate.id,
        )?.invalidatedAt,
      ).toEqual(expect.any(String));
      expect(
        (await getEmployeeContentSet(s.a, s.base.setId)).set.revision,
      ).toBe(current.revision);
    });
    it('does not regain source access by restoring a formerly valid manifest after its binding is withdrawn', async () => {
      const s = await setup(),
        k = await knowledge(s, 'Historical knowledge');
      const original = await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [k.ref],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const latest = await enable(
        s,
        s.draft({ expectedRevision: original.revision }),
      );
      await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${k.bindingId}`;
      const input = {
        ...s.base,
        operation: 'restore_draft' as const,
        requestId: randomUUID(),
        expectedRevision: latest.revision,
        sourceRevisionId: original.candidate.id,
      };
      const restored = await mutateEmployeeContent(s.a, input);
      const validated = await mutateEmployeeContent(
        s.a,
        action(input, restored, 'validate'),
      );
      expect(validated.validation?.valid).toBe(false);
      expect(
        (await getEmployeeContentSet(s.a, s.base.setId)).sources[0],
      ).toMatchObject({ available: false });
      await expect(
        mutateEmployeeContent(s.a, action(input, validated, 'activate')),
      ).rejects.toMatchObject({ code: 'validation_required' });
    });
    it('loads one exact scene lazily; repeated gets preserve a receipt; following Runs choose independently and old leases cannot read', async () => {
      const { s, ids } = await sceneSetup(),
        run = await runtimeRun(s),
        worker = await sceneLease(run);
      expect(run.runtime.sources).toEqual([]);
      expect(new Set(run.runtime.scenes.map((x) => x.nativeName)).size).toBe(2);
      expect(JSON.stringify(run.runtime.snapshot)).not.toContain(
        'WEEK_ONLY_47',
      );
      const scene = run.runtime.scenes.find((x) => x.id === ids[0])!,
        selection = { sceneId: scene.id, sceneDigest: scene.digest };
      const first = await loadEmployeeRuntimeScene(
        run.scope,
        run.runtime.generationId,
        selection,
        worker,
      );
      expect(first.sources.map((x) => x.body)).toEqual(['WEEK_ONLY_47']);
      expect(
        (
          await loadEmployeeRuntimeScene(
            run.scope,
            run.runtime.generationId,
            selection,
            worker,
          )
        ).receipt,
      ).toEqual(first.receipt);
      const [read] =
        await f.db`select content_scene_state from allrice_employee_runs where run_id=${run.scope.runId}`;
      expect(read!.content_scene_state).toEqual({ reads: [first.receipt] });
      const adopted = await adoptEmployeeRuntimeScene(
        run.scope,
        run.runtime.generationId,
        {
          ...first.receipt,
          nativeSessionId: 'isolated-root',
          callId: 'native-call-1',
        },
        worker,
      );
      expect(adopted).toMatchObject(first.receipt);
      await expect(
        loadEmployeeRuntimeScene(
          { ...run.scope, ownerId: s.b.actor.id },
          run.runtime.generationId,
          selection,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await releaseConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        outcome: 'idle',
      });
      await run.finish();
      const next = await runtimeRun(s, run.scope.sessionId),
        nextWorker = await sceneLease(next);
      expect(next.runtime.generationId).toBe(run.runtime.generationId);
      expect(next.runtime.nativeContextKey).not.toBe(
        run.runtime.nativeContextKey,
      );
      await expect(
        loadEmployeeRuntimeScene(
          run.scope,
          run.runtime.generationId,
          selection,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const monthly = next.runtime.scenes.find((x) => x.id === ids[1])!;
      expect(
        (
          await loadEmployeeRuntimeScene(
            next.scope,
            next.runtime.generationId,
            { sceneId: monthly.id, sceneDigest: monthly.digest },
            nextWorker,
          )
        ).sources.map((x) => x.body),
      ).toEqual(['MONTH_ONLY_86']);
      await releaseConversationRuntime({
        ...next.scope,
        workerId: nextWorker.workerId,
        outcome: 'idle',
      });
      await next.finish();
      // A task with no scene adoption also has a distinct native context.
      const ordinary = await runtimeRun(s, run.scope.sessionId);
      expect(ordinary.runtime.nativeContextKey).not.toBe(
        next.runtime.nativeContextKey,
      );
      const [record] =
        await f.db`select content_scene_state from allrice_employee_runs where run_id=${ordinary.scope.runId}`;
      expect(record!.content_scene_state).toBeNull();
    }, 120000);
    it('does not return scene content or append a receipt after the execution lease expires while waiting for a source lock', async () => {
      const { s } = await sceneSetup(),
        run = await runtimeRun(s),
        worker = await sceneLease(run),
        scene = run.runtime.scenes[0]!;
      const ready = contentGate<number>(),
        release = contentGate<void>();
      const holder = f.db.begin(async (tx) => {
        const [pid] = await tx`select pg_backend_pid() as id`;
        await tx`select revision_id from allrice_employee_content_publications where set_id=${s.base.setId} for update`;
        ready.resolve(pid!.id);
        await release.promise;
      });
      const pid = await ready.promise;
      const reading = loadEmployeeRuntimeScene(
        run.scope,
        run.runtime.generationId,
        { sceneId: scene.id, sceneDigest: scene.digest },
        worker,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      try {
        await expect
          .poll(
            async () => {
              const [x] =
                await f.db`select count(*)::int as n from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`;
              return x!.n;
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await f.db`update allrice_jobs set lease_expires_at=now()-interval '1 second' where id=${worker.jobId}`;
      } finally {
        release.resolve();
      }
      await holder;
      expect(await reading).toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      });
      const [saved] =
        await f.db`select content_scene_state from allrice_employee_runs where run_id=${run.scope.runId}`;
      expect(saved!.content_scene_state).toBeNull();
    }, 120000);
    it('keeps a scene body canonical when another conservative read has overlapping sources', async () => {
      const { s, ids } = await sceneSetup(true),
        run = await runtimeRun(s),
        worker = await sceneLease(run);
      const load = (id: string) => {
        const scene = run.runtime.scenes.find((s) => s.id === id)!;
        return loadEmployeeRuntimeScene(
          run.scope,
          run.runtime.generationId,
          { sceneId: scene.id, sceneDigest: scene.digest },
          worker,
        );
      };
      const first = await load(ids[1]!);
      await load(ids[0]!);
      const again = await load(ids[1]!);
      expect(again.receipt).toEqual(first.receipt);
      expect(JSON.stringify(again.sources)).toBe(JSON.stringify(first.sources));
    }, 120000);
    it('persists two conservative probe reads but rejects conflicting native adoption before further dispatch or recovery', async () => {
      const { s } = await sceneSetup(),
        run = await runtimeRun(s),
        worker = await sceneLease(run);
      const loaded = await Promise.all(
        run.runtime.scenes.map((scene) =>
          loadEmployeeRuntimeScene(
            run.scope,
            run.runtime.generationId,
            { sceneId: scene.id, sceneDigest: scene.digest },
            worker,
          ),
        ),
      );
      const adopted = await Promise.allSettled(
        loaded.map((r, i) =>
          adoptEmployeeRuntimeScene(
            run.scope,
            run.runtime.generationId,
            {
              ...r.receipt,
              nativeSessionId: `child-${i}`,
              callId: `call-${i}`,
            },
            worker,
          ),
        ),
      );
      expect(adopted.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      await expect(
        assertEmployeeContentContext(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        prepareEmployeeContentContext(run.scope),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const [saved] =
        await f.db`select content_scene_state from allrice_employee_runs where run_id=${run.scope.runId}`;
      expect(saved!.content_scene_state.reads).toHaveLength(2);
    }, 120000);
    it('rechecks scene-only sources after a read and denies revoked imported answers without loading unrelated bodies', async () => {
      const s = await setup(),
        k = await knowledge(s, 'Scene-only source'),
        sceneId = randomUUID();
      await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [],
            declaredConflicts: [],
            scenes: [
              {
                id: sceneId,
                name: '资料报告',
                appliesWhen: '需要资料时',
                references: [k.ref],
              },
            ],
          },
        }),
      );
      const run = await runtimeRun(s),
        worker = await sceneLease(run),
        scene = run.runtime.scenes[0]!;
      await loadEmployeeRuntimeScene(
        run.scope,
        run.runtime.generationId,
        { sceneId, sceneDigest: scene.digest },
        worker,
      );
      await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${k.bindingId}`;
      await expect(
        assertEmployeeContentContext(
          run.scope,
          run.runtime.generationId,
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        loadEmployeeRuntimeScene(
          run.scope,
          run.runtime.generationId,
          { sceneId, sceneDigest: scene.digest },
          worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        assertEmployeeContentReferenceMessages(s.a, run.scope.sessionId, [
          run.sent.userMessage.id,
        ]),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await releaseConversationRuntime({
        ...run.scope,
        workerId: worker.workerId,
        outcome: 'idle',
      });
      await run.finish();
      const ordinary = await runtimeRun(s, run.scope.sessionId);
      expect(ordinary.runtime.sources).toEqual([]);
      expect(ordinary.runtime.historyFromMessageId).toBe(
        ordinary.sent.userMessage.id,
      );
    }, 120000);
    it('freezes common references for both kinds, keeps personal content private and does not load an unrelated broken scene', async () => {
      const s = await setup(),
        shared = text('COMPANY_COMMON_42'),
        privateText = text('PRIVATE_COMMON_73'),
        k = await knowledge(s, 'Unrelated scene');
      await enable(
        s,
        s.draft({
          setId: randomUUID(),
          ownership: {
            scope: 'company',
            organizationId: s.company.organizationId,
          },
          target: { kind: 'employee', employeeId: s.employeeId },
          textEdits: [shared],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: shared.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      await enable(
        s,
        s.draft({
          textEdits: [privateText],
          manifest: {
            schemaVersion: 1,
            common: [
              { sourceKind: 'draft_text', contentId: privateText.contentId },
            ],
            scenes: [
              {
                id: randomUUID(),
                name: 'Unrelated',
                appliesWhen: 'Only when selected',
                references: [k.ref],
              },
            ],
            declaredConflicts: [],
          },
        }),
      );
      await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${k.bindingId}`;
      const general = await runtimeRun(s, undefined, false),
        custom = await runtimeRun(s);
      expect(general.runtime.sources.map((x) => x.body)).toEqual([
        'COMPANY_COMMON_42',
      ]);
      expect(custom.runtime.sources.map((x) => x.body)).toEqual([
        'COMPANY_COMMON_42',
        'PRIVATE_COMMON_73',
      ]);
      expect(JSON.stringify(custom.runtime.snapshot)).not.toContain(
        'PRIVATE_COMMON_73',
      );
      expect(custom.runtime.snapshot.employeeVersionId).toBe(
        s.assigned.currentVersion.id,
      );
      expect(
        custom.runtime.snapshot.layers.some((l) =>
          l.common.some((r) => r.contentId === k.ref.contentId),
        ),
      ).toBe(false);
      await expect(
        readEmployeeRuntimeContent(s.b, custom.runtime.snapshot),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        assertEmployeeContentContext(
          { ...custom.scope, ownerId: s.b.actor.id },
          custom.runtime.generationId,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    }, 120000);
    it('keeps ordinary updates frozen, commits correction invalidation, rejects same-Run recovery and rotates new history', async () => {
      const s = await setup();
      async function publish(
        body: string,
        expectedRevision = 0,
        correction = false,
      ) {
        const t = text(body),
          input = s.draft({
            expectedRevision,
            textEdits: [t],
            manifest: {
              schemaVersion: 1,
              common: [{ sourceKind: 'draft_text', contentId: t.contentId }],
              scenes: [],
              declaredConflicts: [],
            },
          });
        const saved = await mutateEmployeeContent(s.a, input),
          checked = await mutateEmployeeContent(
            s.a,
            action(input, saved, 'validate'),
          );
        return mutateEmployeeContent(s.a, {
          ...action(input, checked, 'activate'),
          invalidatePrevious: correction,
        });
      }
      const v1 = await publish('VERSION_ONE');
      const first = await runtimeRun(s);
      await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${s.company.organizationId},${s.company.workspaceId},${first.scope.runId},1000,'tool.completed',${f.db.json({ name: 'synthetic', summary: 'OLD_TOOL_DERIVED_CONTENT' })})`;
      await first.finish();
      const v2 = await publish('VERSION_TWO', v1.revision);
      await expect(
        assertEmployeeContentContext(first.scope, first.runtime.generationId),
      ).resolves.toBeUndefined();
      expect(
        (await readEmployeeRuntimeContent(s.a, first.runtime.snapshot))
          .sources[0]!.body,
      ).toBe('VERSION_ONE');
      const second = await runtimeRun(s, first.scope.sessionId);
      expect(second.runtime.generationId).toBe(first.runtime.generationId);
      expect(second.runtime.sources[0]!.body).toBe('VERSION_TWO');
      await second.finish();
      await publish('VERSION_THREE_CORRECTED', v2.revision, true);
      await expect(
        assertEmployeeContentContext(first.scope, first.runtime.generationId),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const [invalid] =
        await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${first.runtime.generationId}`;
      expect(invalid!.invalidated_at).not.toBeNull();
      await expect(
        prepareEmployeeContentContext(second.scope),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const next = await runtimeRun(s, first.scope.sessionId);
      expect(next.runtime.generationId).not.toBe(first.runtime.generationId);
      expect(next.runtime.historyFromMessageId).toBe(next.sent.userMessage.id);
      expect(next.runtime.allowedMessageIds).not.toContain(
        first.sent.userMessage.id,
      );
      expect(next.runtime.allowedMessageIds).not.toContain(
        second.sent.assistantMessage.id,
      );
      expect(
        JSON.stringify(await listContextCheckpointEvidence(first.scope)),
      ).toContain('OLD_TOOL_DERIVED_CONTENT');
      expect(
        JSON.stringify(
          await listContextCheckpointEvidence({
            ...next.scope,
            contentGenerationId: next.runtime.generationId,
            allowedMessageIds: next.runtime.allowedMessageIds!,
          }),
        ),
      ).not.toContain('OLD_TOOL_DERIVED_CONTENT');
      await expect(
        assertEmployeeContentReferenceMessages(s.a, first.scope.sessionId, [
          second.sent.assistantMessage.id,
        ]),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        f.db`update allrice_employee_runs set content_generation_id=${next.runtime.generationId} where run_id=${first.scope.runId}`,
      ).rejects.toThrow('immutable');
    }, 120000);
    it('retains imported answer dependencies across sessions and revokes the importer before dispatch', async () => {
      const s = await setup(),
        t = text('PRIVATE_SOURCE_42');
      await enable(
        s,
        s.draft({
          textEdits: [t],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: t.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const source = await runtimeRun(s);
      await source.finish();
      await f.db`update allrice_messages set status='completed',content=${f.db.json({ text: 'DERIVED_SOURCE_ANSWER_42', citations: [] })} where id=${source.sent.assistantMessage.id}`;
      const imported = await runtimeRun(s, undefined, false, [
        source.scope.sessionId,
      ]);
      expect(imported.runtime.sources).toEqual([]); // No direct private common requirement.
      expect(
        JSON.stringify(imported.resolved.promptSnapshot.sessionReferences),
      ).toContain('DERIVED_SOURCE_ANSWER_42');
      await expect(
        assertEmployeeContentContext(
          imported.scope,
          imported.runtime.generationId,
        ),
      ).resolves.toBeUndefined();
      await f.db`update allrice_employee_content_publications set invalidated_at=now() where set_id=${s.base.setId}`;
      await expect(
        assertEmployeeContentContext(
          imported.scope,
          imported.runtime.generationId,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const [row] =
        await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${imported.runtime.generationId}`;
      expect(row!.invalidated_at).not.toBeNull();
      await expect(
        prepareEmployeeContentContext(imported.scope),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
    }, 120000);
    it.each([false, true])(
      'holds imported Session visibility while later authorization waits (legacy=%s)',
      async (legacy) => {
        const s = await setup(),
          t = text('IMPORTED_AUTHORITY');
        await enable(
          s,
          s.draft({
            textEdits: [t],
            manifest: {
              schemaVersion: 1,
              common: [{ sourceKind: 'draft_text', contentId: t.contentId }],
              scenes: [],
              declaredConflicts: [],
            },
          }),
        );
        let sourceSessionId: string;
        if (legacy) {
          const session = await createChatSession(s.a, {
            workspaceId: s.company.workspaceId,
            employeeAssignmentId: s.assigned.id,
            title: 'Historical source without a content generation',
          });
          const sent = await sendChatMessage(
            s.a,
            s.company.workspaceId,
            session.id,
            {
              text: 'Historical input',
              clientMessageId: randomUUID(),
            },
          );
          await f.db`update allrice_jobs set status='canceled',completed_at=now() where run_id=${sent.run.id}`;
          await f.db`update allrice_runs set state='canceled',completed_at=now() where id=${sent.run.id}`;
          await f.db`update allrice_employee_runs set status='canceled',completed_at=now() where run_id=${sent.run.id}`;
          sourceSessionId = session.id;
        } else {
          const source = await runtimeRun(s);
          await source.finish();
          sourceSessionId = source.scope.sessionId;
        }
        await f.db`update allrice_messages set status='completed',content=${f.db.json({ text: 'IMPORTED_ANSWER', citations: [] })} where session_id=${sourceSessionId} and role='assistant'`;
        const imported = await runtimeRun(s, undefined, false, [
          sourceSessionId,
        ]);
        const ready = contentGate<number>(),
          release = contentGate<void>();
        const holder = f.db.begin(async (tx) => {
          const [pid] = await tx`select pg_backend_pid() as id`;
          if (legacy)
            await tx`select generation_id from allrice_employee_content_contexts where generation_id=${imported.runtime.generationId} for update`;
          else
            await tx`select revision_id from allrice_employee_content_publications where set_id=${s.base.setId} for update`;
          ready.resolve(pid!.id);
          await release.promise;
        });
        const holderPid = await ready.promise;
        const guard = assertEmployeeContentContext(
          imported.scope,
          imported.runtime.generationId,
        ).then(
          () => null,
          (e: unknown) => e,
        );
        let writer: Promise<unknown> | undefined;
        try {
          let guardPid = 0;
          await expect
            .poll(
              async () => {
                const [row] =
                  await f.db`select pid from pg_stat_activity where ${holderPid}::int=any(pg_blocking_pids(pid))`;
                guardPid = row?.pid ?? 0;
                return guardPid;
              },
              { timeout: 5000 },
            )
            .toBeGreaterThan(0);
          const writerReady = contentGate<number>();
          // This is the Session-first lock order used by updateChatSession.
          writer = f.db.begin(async (tx) => {
            const [pid] = await tx`select pg_backend_pid() as id`;
            writerReady.resolve(pid!.id);
            await tx`update allrice_chat_sessions set archived_at=now() where id=${sourceSessionId}`;
          });
          void writer.catch(() => undefined);
          const writerPid = await writerReady.promise;
          await expect
            .poll(
              async () => {
                const [row] =
                  await f.db`select ${guardPid}::int=any(pg_blocking_pids(${writerPid})) as blocked`;
                return row!.blocked;
              },
              { timeout: 5000 },
            )
            .toBe(true);
        } finally {
          release.resolve();
          await holder;
          await writer;
        }
        expect(await guard).toBeNull(); // Serializes before the revocation commit.
        await expect(
          assertEmployeeContentContext(
            imported.scope,
            imported.runtime.generationId,
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      },
      120000,
    );
    it('serializes a final guard with correction and rechecks a lease after waiting for the context', async () => {
      const s = await setup(),
        t = text('CONCURRENT_SOURCE');
      await enable(
        s,
        s.draft({
          textEdits: [t],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: t.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const run = await runtimeRun(s);
      const ready = contentGate<number>(),
        release = contentGate<void>();
      const correction = f.db.begin(async (tx) => {
        const [pid] = await tx`select pg_backend_pid() as id`;
        await tx`update allrice_employee_content_publications set invalidated_at=now() where set_id=${s.base.setId}`;
        ready.resolve(pid!.id);
        await release.promise;
      });
      const pid = await ready.promise;
      const guard = assertEmployeeContentContext(
        run.scope,
        run.runtime.generationId,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      try {
        await expect
          .poll(
            async () => {
              const [row] =
                await f.db`select count(*)::int as n from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`;
              return row!.n;
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
      } finally {
        release.resolve();
      }
      await correction;
      expect(await guard).toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      });

      const empty = await setup(),
        current = await runtimeRun(empty);
      const worker = {
        workerId: randomUUID(),
        jobId: '',
        leaseToken: randomUUID(),
      };
      const [job] =
        await f.db`update allrice_jobs set status='running',worker_id=${worker.workerId},lease_token=${worker.leaseToken},claimed_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '10 minutes' where run_id=${current.scope.runId} returning id`;
      worker.jobId = job!.id;
      await acquireConversationRuntime({
        ...current.scope,
        workerId: worker.workerId,
        configChecksum: `sha256:${'c'.repeat(64)}`,
        compactThresholdTokens: 40000,
      });
      await expect(
        assertEmployeeContentContext(
          current.scope,
          current.runtime.generationId,
          worker,
        ),
      ).resolves.toBeUndefined();
      const contextReady = contentGate<number>(),
        contextRelease = contentGate<void>();
      const holder = f.db.begin(async (tx) => {
        const [pid] = await tx`select pg_backend_pid() as id`;
        await tx`select generation_id from allrice_employee_content_contexts where generation_id=${current.runtime.generationId} for update`;
        contextReady.resolve(pid!.id);
        await contextRelease.promise;
      });
      const holderPid = await contextReady.promise;
      const waiting = assertEmployeeContentContext(
        current.scope,
        current.runtime.generationId,
        worker,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      try {
        await expect
          .poll(
            async () => {
              const [row] =
                await f.db`select count(*)::int as n from pg_stat_activity where ${holderPid}::int=any(pg_blocking_pids(pid))`;
              return row!.n;
            },
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await f.db`update allrice_jobs set lease_expires_at=now()-interval '1 second' where id=${worker.jobId}`;
      } finally {
        contextRelease.resolve();
      }
      await holder;
      expect(await waiting).toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      });
      const [context] =
        await f.db`select invalidated_at from allrice_employee_content_contexts where generation_id=${current.runtime.generationId}`;
      expect(context!.invalidated_at).toBeNull(); // Lease loss is not source revocation.
    }, 120000);
    it('checks the owning department even for a publicly readable source and does not reuse revoked context', async () => {
      const s = await setup(),
        t = text('DEPARTMENT_ONLY');
      await enable(
        s,
        s.draft({
          setId: randomUUID(),
          target: { kind: 'employee', employeeId: s.employeeId },
          ownership: {
            scope: 'department',
            organizationId: s.company.organizationId,
            departmentId: s.dept.id,
          },
          textEdits: [t],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: t.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        }),
      );
      const first = await runtimeRun(s);
      await first.finish();
      await f.db`update allrice_organization_people set department_id=${s.otherDept.id},content_maintenance_level='personal' where organization_id=${s.company.organizationId} and user_id=${s.a.actor.id}`;
      await expect(
        assertEmployeeContentContext(first.scope, first.runtime.generationId),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const next = await runtimeRun(s, first.scope.sessionId);
      expect(next.runtime.sources).toEqual([]);
      expect(next.runtime.generationId).not.toBe(first.runtime.generationId);
      expect(next.runtime.allowedMessageIds).not.toContain(
        first.sent.assistantMessage.id,
      );
    }, 120000);
    it('saves two scenes with a shared rule and distinct native Knowledge; activates the exact immutable candidate', async () => {
      const s = await setup(),
        k1 = await knowledge(s, 'Weekly sources'),
        k2 = await knowledge(s, 'Monthly sources'),
        rule = text();
      const input = s.draft({
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
          scenes: [
            {
              id: randomUUID(),
              name: 'Weekly',
              appliesWhen: 'Weekly research',
              references: [k1.ref],
            },
            {
              id: randomUUID(),
              name: 'Monthly',
              appliesWhen: 'Monthly research',
              references: [k2.ref],
            },
          ],
          declaredConflicts: [],
        },
      });
      const saved = await mutateEmployeeContent(s.a, input);
      expect(
        (await getEffectiveEmployeeContent(s.a, s.instance.id)).scenes,
      ).toEqual([]);
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).sources.find(
          (r) => r.reference.contentId === rule.contentId,
        )?.body,
      ).toBe(rule.body);
      const checked = await mutateEmployeeContent(
        s.a,
        action(input, saved, 'validate'),
      );
      expect(checked.validation).toMatchObject({
        valid: true,
        semanticConsistency: 'not_proven',
      });
      const activated = await mutateEmployeeContent(
        s.a,
        action(input, checked, 'activate'),
      );
      expect(activated.active).toEqual(saved.candidate);
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.validation.valid).toBe(true);
      expect(effective.scenes.map((v) => v.name)).toEqual([
        'Weekly',
        'Monthly',
      ]);
      expect(effective.common).toHaveLength(1);
      expect(effective.sources).toHaveLength(3);
      expect(effective.platform.revisionId).toBe(publication.revisionId);
      expect(effective.platform.requirements).toContain(
        'No implicit authority',
      );
      await expect(
        f.db`update allrice_employee_content_revisions set manifest='{}' where id=${saved.candidate.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_employee_content_sets set owner_id=${s.b.actor.id} where id=${input.setId}`,
      ).rejects.toThrow('immutable');
    });
    it('pins different revisions of one reference independently in weekly and monthly scenes', async () => {
      const s = await setup();
      const v1 = await readyReference(
        s,
        '部门金额：运营12000元，财务18000元，合计30000元。TOTAL30000',
      );
      const v2 = await readyReference(
        s,
        '部门金额：运营15000元，财务18000元，合计33000元。TOTAL33000',
        'company',
        {
          sourceId: v1.sourceId,
          revision: 1,
        },
      );
      const oldPin = await managedRef(s, v1),
        newPin = await managedRef(s, v2);
      const weeklyId = randomUUID(),
        monthlyId = randomUUID();
      await enable(
        s,
        s.draft({
          manifest: {
            schemaVersion: 1,
            common: [],
            declaredConflicts: [],
            scenes: [
              {
                id: weeklyId,
                name: '周度对账',
                appliesWhen: '每周核对部门金额',
                references: [newPin],
              },
              {
                id: monthlyId,
                name: '月度复盘',
                appliesWhen: '每月核对部门金额',
                references: [oldPin],
              },
            ],
          },
        }),
      );
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.validation.valid).toBe(true);
      expect(
        effective.sources.map((r) => r.reference.revisionId).sort(),
      ).toEqual([v1.revisionId, v2.revisionId].sort());
      for (const [sceneId, revisionId, total, absent] of [
        [weeklyId, v2.revisionId, 'TOTAL33000', 'TOTAL30000'],
        [monthlyId, v1.revisionId, 'TOTAL30000', 'TOTAL33000'],
      ] as const) {
        const run = await runtimeRun(
            s,
            undefined,
            true,
            [],
            [],
            '请核对运营和财务的部门金额及合计',
          ),
          worker = await sceneLease(run);
        const scene = run.runtime.scenes.find((v) => v.id === sceneId)!;
        const loaded = await loadEmployeeRuntimeScene(
          run.scope,
          run.runtime.generationId,
          { sceneId, sceneDigest: scene.digest },
          worker,
        );
        expect(loaded.knowledge).toHaveLength(1);
        expect(loaded.knowledge[0]!.citation.reference!.revisionId).toBe(
          revisionId,
        );
        expect(loaded.knowledge[0]!.content).toContain(total);
        expect(JSON.stringify(loaded)).not.toContain(absent);
        const beforeReads = await readEmployeeReferenceCitations(run.scope);
        const other = run.runtime.scenes.find((v) => v.id !== sceneId)!;
        await expect(
          loadEmployeeRuntimeScene(
            run.scope,
            run.runtime.generationId,
            { sceneId: other.id, sceneDigest: other.digest },
            worker,
          ),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        expect(await readEmployeeReferenceCitations(run.scope)).toEqual(
          beforeReads,
        );
        await run.finish();
      }
    }, 120000);
    it.each([
      'common',
      'common-only',
      'same-scene',
      'same-scene-reversed',
      'inherited-scene',
      'inherited-common',
    ] as const)(
      'still rejects different reference versions within one effective view: %s',
      async (kind) => {
        const s = await setup(),
          v1 = await readyReference(s, 'SOURCE_V1');
        const v2 = await readyReference(s, 'SOURCE_V2', 'company', {
          sourceId: v1.sourceId,
          revision: 1,
        });
        const oldPin = await managedRef(s, v1),
          newPin = await managedRef(s, v2),
          sceneId = randomUUID();
        const scene = {
          id: sceneId,
          name: '周度核对',
          appliesWhen: '每周核对',
          references: [newPin],
        };
        if (kind.startsWith('inherited')) {
          await enable(
            s,
            s.draft({
              setId: randomUUID(),
              ownership: {
                scope: 'company',
                organizationId: s.company.organizationId,
              },
              target: { kind: 'employee', employeeId: s.employeeId },
              manifest: {
                schemaVersion: 1,
                common: kind === 'inherited-common' ? [oldPin] : [],
                declaredConflicts: [],
                scenes:
                  kind === 'inherited-scene'
                    ? [{ ...scene, references: [oldPin] }]
                    : [],
              },
            }),
          );
        }
        const input = s.draft({
          manifest: {
            schemaVersion: 1,
            common:
              kind === 'common'
                ? [oldPin]
                : kind === 'common-only'
                  ? [oldPin, newPin]
                  : [],
            declaredConflicts: [],
            scenes:
              kind === 'common-only'
                ? []
                : [
                    {
                      ...scene,
                      references:
                        kind === 'same-scene'
                          ? [oldPin, newPin]
                          : kind === 'same-scene-reversed'
                            ? [newPin, oldPin]
                            : [newPin],
                    },
                  ],
          },
        });
        const saved = await mutateEmployeeContent(s.a, input);
        const checked = await mutateEmployeeContent(
          s.a,
          action(input, saved, 'validate'),
        );
        expect(checked.validation?.valid).toBe(false);
        expect(
          checked.validation?.issues.some(
            (v) => v.code === 'mandatory_rule_conflict',
          ),
        ).toBe(true);
        await expect(
          mutateEmployeeContent(s.a, action(input, checked, 'activate')),
        ).rejects.toMatchObject({ code: 'validation_required' });
      },
      120000,
    );
    it('replays original receipts after later changes, rejects reused request IDs and atomically loses a concurrent stale edit', async () => {
      const s = await setup(),
        input = s.draft();
      const receipts = await Promise.all(
        [1, 2, 3].map(() => mutateEmployeeContent(s.a, input)),
      );
      expect(receipts[1]).toEqual(receipts[0]);
      expect(receipts[2]).toEqual(receipts[0]);
      const checked = await mutateEmployeeContent(
        s.a,
        action(input, receipts[0]!, 'validate'),
      );
      expect(await mutateEmployeeContent(s.a, input)).toEqual(receipts[0]);
      await expect(
        mutateEmployeeContent(s.a, { ...input, changeSummary: 'different' }),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      const edits = [text('First'), text('Second')];
      const updates = edits.map((t) => ({
        ...input,
        requestId: randomUUID(),
        expectedRevision: checked.revision,
        textEdits: [t],
        manifest: {
          ...input.manifest,
          common: [
            { sourceKind: 'draft_text' as const, contentId: t.contentId },
          ],
        },
      }));
      const results = await Promise.allSettled(
        updates.map((i) => mutateEmployeeContent(s.a, i)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const assets =
        await f.db`select id from allrice_company_assets where id in ${f.db(edits.map((e) => e.contentId))}`;
      expect(assets).toHaveLength(1);
      await expect(
        mutateEmployeeContent(s.a, {
          ...input,
          setId: randomUUID(),
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
    });
    it('a revoked dependency prevents activation and preserves the prior active version; fresh reads redact it', async () => {
      const s = await setup(),
        input = s.draft(),
        active = await enable(s, input),
        k = await knowledge(s, 'revocable');
      const next = {
        ...input,
        requestId: randomUUID(),
        expectedRevision: active.revision,
        manifest: { ...input.manifest, common: [k.ref] },
      };
      const saved = await mutateEmployeeContent(s.a, next),
        checked = await mutateEmployeeContent(
          s.a,
          action(next, saved, 'validate'),
        );
      await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${k.bindingId}`;
      await expect(
        mutateEmployeeContent(s.a, action(next, checked, 'activate')),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).set.active?.id,
      ).toBe(active.active?.id);
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).sources[0],
      ).toMatchObject({ available: false });
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).sources[0],
      ).not.toHaveProperty('body');
      expect(
        await f.db`select id from allrice_employee_content_requests where set_id=${input.setId}`,
      ).toHaveLength(5);
    });
    it('private content cannot enter the old company directory, historical source reader, or mutation API', async () => {
      const s = await setup(),
        rule = text('Owner-only detail'),
        input = s.draft({
          textEdits: [rule],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        });
      await enable(s, input);
      expect(
        (await listCompanyAssets(s.a, s.company.organizationId)).assets,
      ).toEqual([]);
      expect(
        (await listCompanyAssets(s.b, s.company.organizationId)).assets,
      ).toEqual([]);
      for (const ctx of [s.a, s.b, admin]) {
        const administration = ctx === admin;
        await expect(
          getCompanyAsset(
            ctx,
            s.company.organizationId,
            rule.contentId,
            administration,
          ),
        ).rejects.toThrow();
        await expect(
          listCompanyAssetRevisions(
            ctx,
            s.company.organizationId,
            rule.contentId,
            administration,
          ),
        ).rejects.toThrow();
        await expect(
          mutateCompanyAsset(
            ctx,
            s.company.organizationId,
            {
              assetId: rule.contentId,
              operation: 'archive',
              expectedRevision: 2,
            },
            runtimeFixtureStorage(f.db),
            administration,
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      await expect(getEmployeeContentSet(s.b, input.setId)).rejects.toThrow();
      await expect(getEmployeeContentSet(admin, input.setId)).rejects.toThrow();
    });
    it('inherits company and department rules; private edits cannot overwrite them or silently lose an upstream change', async () => {
      const s = await setup(),
        rule = text('Company source requirements');
      const company = s.draft({
        setId: randomUUID(),
        ownership: {
          scope: 'company',
          organizationId: s.company.organizationId,
        },
        target: { kind: 'employee', employeeId: s.employeeId },
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
          scenes: [],
          declaredConflicts: [],
        },
      });
      const enabled = await enable(s, company);
      const departmental = text('Research output includes provenance');
      const dept = s.draft({
        ...company,
        setId: randomUUID(),
        requestId: randomUUID(),
        ownership: {
          scope: 'department',
          organizationId: s.company.organizationId,
          departmentId: s.dept.id,
        },
        textEdits: [departmental],
        manifest: {
          ...company.manifest,
          common: [
            { sourceKind: 'draft_text', contentId: departmental.contentId },
          ],
        },
      });
      await enable(s, dept);
      const own = s.draft(),
        saved = await mutateEmployeeContent(s.a, own),
        validated = await mutateEmployeeContent(
          s.a,
          action(own, saved, 'validate'),
        );
      const changedRule = {
        ...rule,
        revisionId: randomUUID(),
        expectedRevision: 2,
        body: 'New company requirements',
      };
      const changed = {
        ...company,
        expectedRevision: enabled.revision,
        requestId: randomUUID(),
        textEdits: [changedRule],
      };
      await enable(s, changed);
      await expect(
        mutateEmployeeContent(s.a, action(own, validated, 'activate')),
      ).rejects.toMatchObject({ code: 'source_changed' });
      const revalidated = await mutateEmployeeContent(
        s.a,
        action(own, validated, 'validate'),
      );
      await mutateEmployeeContent(s.a, action(own, revalidated, 'activate'));
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.common).toHaveLength(2);
      expect(effective.sources.map((x) => x.body)).toEqual(
        expect.arrayContaining(['New company requirements', departmental.body]),
      );
      const ownState = await getEmployeeContentSet(s.a, own.setId);
      await expect(
        mutateEmployeeContent(
          s.a,
          s.draft({
            requestId: randomUUID(),
            expectedRevision: ownState.set.revision,
            textEdits: [{ ...changedRule, expectedRevision: 4 }],
            manifest: {
              ...own.manifest,
              common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      // Both old and new immutable publications still exist. A lower reference
      // to an old version must conflict with the new inherited version.
      const oldRef: EmployeeContentReference = {
        sourceKind: 'requirement',
        contentId: rule.contentId,
        revisionId: rule.revisionId,
        digest: runtimePolicyDigest({
          kind: rule.kind,
          title: rule.title,
          body: rule.body,
        }),
      };
      const conflicting = s.draft({
        requestId: randomUUID(),
        expectedRevision: ownState.set.revision,
        manifest: { ...own.manifest, common: [oldRef] },
      });
      const pending = await mutateEmployeeContent(s.a, conflicting),
        check = await mutateEmployeeContent(
          s.a,
          action(conflicting, pending, 'validate'),
        );
      expect(
        check.validation?.issues.some(
          (x) => x.code === 'mandatory_rule_conflict',
        ),
      ).toBe(true);
      await expect(
        mutateEmployeeContent(s.a, action(conflicting, check, 'activate')),
      ).rejects.toMatchObject({ code: 'validation_required' });
    });
    it('shared source drafts stay hidden from ordinary readers and user-only or employee-only Knowledge cannot be promoted', async () => {
      const s = await setup(),
        k = await knowledge(s, 'Owner ACL', 'user');
      const company = s.draft({
        setId: randomUUID(),
        ownership: {
          scope: 'company',
          organizationId: s.company.organizationId,
        },
        target: { kind: 'employee', employeeId: s.employeeId },
      });
      const active = await enable(s, company),
        rule = text('Unpublished company draft');
      const next = {
        ...company,
        requestId: randomUUID(),
        expectedRevision: active.revision,
        textEdits: [rule],
        manifest: {
          ...company.manifest,
          common: [
            { sourceKind: 'draft_text' as const, contentId: rule.contentId },
            k.ref,
          ],
        },
      };
      const saved = await mutateEmployeeContent(s.a, next);
      const peer = await getEmployeeContentSet(s.b, company.setId);
      expect(peer.set.candidate).toBeNull();
      expect(peer.sources).toEqual([]);
      const checked = await mutateEmployeeContent(
        s.a,
        action(next, saved, 'validate'),
      );
      expect(checked.validation?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'source_scope_mismatch',
            contentId: k.ref.contentId,
          }),
        ]),
      );
      // A new immutable ACL revision grants only the AI employee. It is valid
      // in its owner's instance, but is not a general company-reader grant.
      const employeeOnly = await knowledge(s, 'Employee ACL', 'employee');
      const employeeDraft = {
        ...company,
        requestId: randomUUID(),
        expectedRevision: checked.revision,
        manifest: { ...company.manifest, common: [employeeOnly.ref] },
      };
      const es = await mutateEmployeeContent(s.a, employeeDraft),
        ec = await mutateEmployeeContent(
          s.a,
          action(employeeDraft, es, 'validate'),
        );
      expect(
        ec.validation?.issues.some((x) => x.code === 'source_scope_mismatch'),
      ).toBe(true);
      const personal = s.draft({
        manifest: { ...company.manifest, common: [employeeOnly.ref] },
      });
      expect((await enable(s, personal)).active).not.toBeNull();
    });
    it('rechecks current department, maintenance, assignment and login before reads, writes, or idempotent replay', async () => {
      const s = await setup(),
        dept = s.draft({
          setId: randomUUID(),
          ownership: {
            scope: 'department',
            organizationId: s.company.organizationId,
            departmentId: s.dept.id,
          },
          target: { kind: 'employee', employeeId: s.employeeId },
        });
      const state = await enable(s, dept);
      expect(
        (await getEmployeeContentSet(s.b, dept.setId)).set.access.canRead,
      ).toBe(true);
      await expect(getEmployeeContentSet(s.c, dept.setId)).rejects.toThrow();
      await f.db`update allrice_organization_people set department_id=${s.otherDept.id} where organization_id=${s.company.organizationId} and user_id=${s.b.actor.id}`;
      await expect(getEmployeeContentSet(s.b, dept.setId)).rejects.toThrow();
      await f.db`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${s.company.organizationId} and user_id=${s.a.actor.id}`;
      await expect(mutateEmployeeContent(s.a, dept)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        mutateEmployeeContent(s.a, action(dept, state, 'validate')),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const own = s.draft(),
        saved = await mutateEmployeeContent(s.a, own);
      await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
      await expect(mutateEmployeeContent(s.a, own)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await f.db`update allrice_employee_assignments set active=true where id=${s.assigned.id}`;
      await revokeSession(s.tokens[0]!);
      await expect(
        mutateEmployeeContent(s.a, action(own, saved, 'validate')),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(getEmployeeContentSet(s.a, own.setId)).rejects.toThrow();
    });
    it('a failed activation never publishes staged text and declared conflicts remain blocking', async () => {
      const s = await setup(),
        rule = text(),
        k = await knowledge(s, 'Temporarily available');
      const input = s.draft({
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [
            { sourceKind: 'draft_text', contentId: rule.contentId },
            k.ref,
          ],
          scenes: [],
          declaredConflicts: [],
        },
      });
      const saved = await mutateEmployeeContent(s.a, input),
        checked = await mutateEmployeeContent(
          s.a,
          action(input, saved, 'validate'),
        );
      await f.db`update allrice_knowledge_sources set status='archived' where id=${k.ref.contentId}`;
      await expect(
        mutateEmployeeContent(s.a, action(input, checked, 'activate')),
      ).rejects.toThrow();
      expect(
        await f.db`select * from allrice_company_asset_publications where asset_id=${rule.contentId}`,
      ).toHaveLength(0);
      expect(
        (await getEmployeeContentSet(s.a, input.setId)).set.active,
      ).toBeNull();
      const declared = {
        ...input,
        expectedRevision: checked.revision,
        requestId: randomUUID(),
        textEdits: [],
        manifest: {
          schemaVersion: 1 as const,
          common: [],
          scenes: [],
          declaredConflicts: [
            {
              contentIds: [rule.contentId],
              reason: 'Two different accounting bases',
            },
          ],
        },
      };
      const pending = await mutateEmployeeContent(s.a, declared),
        check = await mutateEmployeeContent(
          s.a,
          action(declared, pending, 'validate'),
        );
      expect(
        check.validation?.issues.some((x) => x.code === 'declared_conflict'),
      ).toBe(true);
    });
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    };
    it('does not invert publication employee→assignment locks during candidate validation', async () => {
      const s = await setup(),
        input = s.draft(),
        saved = await mutateEmployeeContent(s.a, input),
        request = action(input, saved, 'validate');
      const locked = gate(),
        proceed = gate();
      const publicationWrite = f.db.begin(async (tx) => {
        await tx`select id from allrice_employees where id=${s.employeeId} for no key update`;
        locked.resolve();
        await proceed.promise;
        await tx`update allrice_employee_assignments set updated_at=clock_timestamp() where id=${s.assigned.id}`;
      });
      void publicationWrite.catch(() => undefined);
      await locked.promise;
      const validation = mutateEmployeeContent(s.a, request);
      void validation.catch(() => undefined);
      try {
        await expect
          .poll(
            async () =>
              (
                await f.db`select id from allrice_employee_content_requests where request_id=${request.requestId}`
              ).length,
            { timeout: 3000, interval: 20 },
          )
          .toBe(1);
      } finally {
        proceed.resolve();
      }
      expect(
        (await Promise.allSettled([validation, publicationWrite])).map(
          (r) => r.status,
        ),
      ).toEqual(['fulfilled', 'fulfilled']);
    });
    it('serializes shared validation with deployment→employee withdrawal without adding the reverse lock', async () => {
      const s = await setup(),
        input = s.draft({
          ownership: {
            scope: 'company',
            organizationId: s.company.organizationId,
          },
          target: { kind: 'employee', employeeId: s.employeeId },
        });
      const saved = await mutateEmployeeContent(s.a, input),
        locked = gate(),
        proceed = gate();
      const withdrawal = f.db.begin(async (tx) => {
        await tx`update allrice_platform_employee_tenant_assignments set active=false where tenant_employee_id=${s.employeeId}`;
        locked.resolve();
        await proceed.promise;
        await tx`update allrice_employees set status='archived' where id=${s.employeeId}`;
      });
      void withdrawal.catch(() => undefined);
      await locked.promise;
      const validation = mutateEmployeeContent(
        s.a,
        action(input, saved, 'validate'),
      );
      void validation.catch(() => undefined);
      try {
        await expect
          .poll(
            async () =>
              (
                await f.db`select pid from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like '%select active,tenant_employee_version_id%'`
              ).length,
            { timeout: 3000, interval: 20 },
          )
          .toBeGreaterThan(0);
      } finally {
        proceed.resolve();
      }
      await expect(withdrawal).resolves.toBeUndefined();
      await expect(validation).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (
          await f.db`select revision from allrice_employee_content_sets where id=${input.setId}`
        )[0]?.revision,
      ).toBe(saved.revision);
    });
    it('MET182 current details bind persona, general preferences and effective content to one authorized instance', async () => {
      const s = await setup();
      const rule = text('DETAILS_ACTIVE_RULE');
      const input = s.draft({
        textEdits: [rule],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
          scenes: [],
          declaredConflicts: [],
        },
      });
      await enable(s, input);
      const first = await getEmployeeDetails(s.a, s.instance.id);
      expect(first.profile).toMatchObject({
        instanceId: s.instance.id,
        name: 'Research assistant',
        kind: 'custom',
        canMaintainPersonal: true,
      });
      expect(
        first.content.sources.some((item) => item.body === rule.body),
      ).toBe(true);
      await updateEmployeeInstance(s.a, s.instance.id, {
        workspaceId: s.company.workspaceId,
        requestId: randomUUID(),
        expectedRevision: first.profile.revision,
        profile: { name: '同名小白', expressionStyle: 'concise' },
      });
      const second = await createEmployeeInstance(s.a, {
        workspaceId: s.company.workspaceId,
        assignmentId: s.assigned.id,
        requestId: randomUUID(),
        profile: { name: '同名小白', expressionStyle: 'exploratory' },
      });
      const changed = await getEmployeeDetails(s.a, s.instance.id);
      const peer = await getEmployeeDetails(s.a, second.id);
      expect(changed.profile).toMatchObject({
        name: '同名小白',
        expressionStyle: 'concise',
        revision: first.profile.revision + 1,
      });
      expect(peer.profile.expressionStyle).toBe('exploratory');
      expect(peer.content.sources.some((item) => item.body === rule.body)).toBe(
        false,
      );
      const general = (
        await listEmployeeInstances(s.a, s.company.workspaceId)
      ).find((item) => item.kind === 'general')!;
      await updateEmployeeInstance(s.a, general.id, {
        workspaceId: s.company.workspaceId,
        requestId: randomUUID(),
        expectedRevision: general.revision,
        profile: { expressionStyle: 'concise' },
      });
      const standard = await getEmployeeDetails(s.a, general.id);
      expect(standard.profile).toMatchObject({
        kind: 'general',
        expressionStyle: 'concise',
        personalFields: ['expressionStyle'],
      });
      expect(standard.profile.name).not.toBe('同名小白');
      await expect(
        getEmployeeDetails(s.b, s.instance.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      await f.db`update allrice_memberships set role='viewer' where user_id=${s.a.actor.id} and organization_id=${s.company.organizationId}`;
      expect(
        (await getEmployeeDetails(s.a, s.instance.id)).profile
          .canMaintainPersonal,
      ).toBe(false);
      await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
      await expect(getEmployeeDetails(s.a, s.instance.id)).rejects.toThrow();
    });

    it('HTTP save→validate→activate→effective details preserves DTOs, source checks and browser write boundaries', async () => {
      // Load the Next entrypoints at runtime; the database's NodeNext typecheck
      // must not pull the Web bundler's extensionless imports into its project.
      const writePath =
        '../../../../apps/web/app/api/v1/employee-content/route.ts';
      const readPath =
        '../../../../apps/web/app/api/v1/employee-instances/[id]/content/route.ts';
      const { POST: postContent } = (await import(writePath)) as {
        POST: (request: Request) => Promise<Response>;
      };
      const { GET: readContentRoute } = (await import(readPath)) as {
        GET: (
          request: Request,
          options: { params: Promise<{ id: string }> },
        ) => Promise<Response>;
      };
      const s = await setup(),
        rule = text('HTTP-visible exact content'),
        input = s.draft({
          textEdits: [rule],
          manifest: {
            schemaVersion: 1,
            common: [{ sourceKind: 'draft_text', contentId: rule.contentId }],
            scenes: [],
            declaredConflicts: [],
          },
        });
      browser.context = s.a;
      const request = (body: unknown, origin = 'https://allrice.test') =>
        new Request('https://allrice.test/api/v1/employee-content', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect(
        (await postContent(request(input, 'https://foreign.test'))).status,
      ).toBe(403);
      expect(
        (await postContent(request({ ...input, tools: ['anything'] }))).status,
      ).toBe(400);
      const saved = await postContent(request(input));
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as {
        receipt: EmployeeContentReceipt;
      };
      const checked = await postContent(
        request(action(input, savedBody.receipt, 'validate')),
      );
      expect(checked.status).toBe(200);
      const checkedBody = (await checked.json()) as {
        receipt: EmployeeContentReceipt;
      };
      expect(
        (
          await postContent(
            request(action(input, checkedBody.receipt, 'activate')),
          )
        ).status,
      ).toBe(200);
      const read = () =>
        readContentRoute(
          new Request(
            `https://allrice.test/api/v1/employee-instances/${s.instance.id}/content?workspaceId=${s.company.workspaceId}`,
          ),
          { params: Promise.resolve({ id: s.instance.id }) },
        );
      const actual = await read();
      expect(actual.status).toBe(200);
      expect(actual.headers.get('cache-control')).toBe('private, no-store');
      const detail = await actual.json();
      expect(detail.content.sources[0].body).toBe(rule.body);
      expect(detail.profile).toMatchObject({
        instanceId: s.instance.id,
        name: 'Research assistant',
      });
      browser.context = s.b;
      expect((await read()).status).toBe(404);
      browser.context = null;
      expect((await read()).status).toBe(401);
    });
    it('existing workflow bindings and current confirmed memories remain independent authority boundaries', async () => {
      const s = await setup(),
        workflowId = randomUUID(),
        workflowRevisionId = randomUUID(),
        memoryId = randomUUID(),
        memoryRevisionId = randomUUID();
      const workflowDefinition = WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          { key: 'read', name: 'Read authorized sources', kind: 'knowledge' },
        ],
      });
      const workflowDigest = runtimePolicyDigest(workflowDefinition);
      await f.db`insert into allrice_workflows(id,organization_id,workspace_id,slug,name,description,created_by)
      values(${workflowId},${s.company.organizationId},${s.company.workspaceId},${`flow-${workflowId}`},'Existing workflow','Already managed by the capability registry',${s.a.actor.id})`;
      await f.db`insert into allrice_workflow_revisions(id,organization_id,workspace_id,workflow_id,revision,name,description,definition,checksum,created_by,published_at)
      values(${workflowRevisionId},${s.company.organizationId},${s.company.workspaceId},${workflowId},1,'Existing workflow','Reviewed steps',${f.db.json(JSON.parse(JSON.stringify(workflowDefinition)))},${workflowDigest},${s.a.actor.id},now())`;
      await f.db`insert into allrice_employee_workflow_bindings(organization_id,workspace_id,employee_id,workflow_revision_id,bound_by)
      values(${s.company.organizationId},${s.company.workspaceId},${s.employeeId},${workflowRevisionId},${s.a.actor.id})`;
      const body = 'Use the original data dictionary.';
      await f.db`insert into allrice_memories(id,organization_id,workspace_id,employee_id,owner_id,content)
      values(${memoryId},${s.company.organizationId},${s.company.workspaceId},${s.employeeId},${s.a.actor.id},${body})`;
      await f.db`insert into allrice_memory_revisions(id,organization_id,workspace_id,memory_id,revision,content,trust_level,confidence,reason,changed_by)
      values(${memoryRevisionId},${s.company.organizationId},${s.company.workspaceId},${memoryId},1,${body},'user_confirmed',1,'Confirmed fixture',${s.a.actor.id})`;
      const memoryRef: EmployeeContentReference = {
        sourceKind: 'experience',
        contentId: memoryId,
        revisionId: memoryRevisionId,
        digest: runtimePolicyDigest({
          memoryId,
          revisionId: memoryRevisionId,
          revision: 1,
          content: body,
        }),
      };
      const procedure = {
        ...text('Read input, check assumptions, then prepare the report.'),
        kind: 'procedure' as const,
      };
      const input = s.draft({
        textEdits: [procedure],
        manifest: {
          schemaVersion: 1,
          common: [memoryRef],
          scenes: [
            {
              id: randomUUID(),
              name: 'Review',
              appliesWhen: 'Review supplied data',
              references: [
                {
                  sourceKind: 'workflow',
                  contentId: workflowId,
                  revisionId: workflowRevisionId,
                  digest: workflowDigest,
                },
                { sourceKind: 'draft_text', contentId: procedure.contentId },
              ],
            },
          ],
          declaredConflicts: [],
        },
      });
      await enable(s, input);
      expect(
        (await getEffectiveEmployeeContent(s.a, s.instance.id)).sources.every(
          (x) => x.available,
        ),
      ).toBe(true);
      await f.db`update allrice_employee_workflow_bindings set enabled=false where workflow_revision_id=${workflowRevisionId}`;
      await f.db`update allrice_memories set lifecycle_state='candidate',trust_level='derived' where id=${memoryId}`;
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.validation.valid).toBe(false);
      for (const id of [workflowId, memoryId]) {
        const source = effective.sources.find(
          (x) => x.reference.contentId === id,
        )!;
        expect(source.available).toBe(false);
        expect(source).not.toHaveProperty('body');
      }
      expect(
        effective.sources.find(
          (x) => x.reference.contentId === procedure.contentId,
        )?.body,
      ).toBe(procedure.body);
    });
    it('preserves company, department and personal bindings across a template upgrade while frozen Runs retain their old version', async () => {
      const s = await setup(),
        sets = [];
      for (const scope of ['company', 'department', 'personal'] as const) {
        const ownership =
          scope === 'personal'
            ? s.base.ownership
            : scope === 'department'
              ? {
                  scope,
                  organizationId: s.company.organizationId,
                  departmentId: s.dept.id,
                }
              : { scope, organizationId: s.company.organizationId };
        const target =
          scope === 'personal'
            ? s.base.target
            : { kind: 'employee' as const, employeeId: s.employeeId };
        const input = s.draft({ setId: randomUUID(), ownership, target });
        const receipt = await enable(s, input);
        sets.push(receipt.setId);
      }
      const original = await runtimeRun(s),
        before =
          await f.db`select execution_snapshot::text,prompt_snapshot::text from allrice_employee_runs where run_id=${original.sent.run.id}`;
      const draft = await savePlatformEmployeeDraft(publication.employeeId, {
        definition: {
          ...publication.definition,
          description: 'Synthetic template V2',
        },
        expectedRevisionId: publication.revisionId,
      });
      await publication.preview();
      expect(
        (
          await publishPlatformEmployee(publication.employeeId, {
            scope: 'assigned',
            expectedRevisionId: draft!.currentDraft!.id,
          })
        ).valid,
      ).toBe(true);
      const effective = await getEffectiveEmployeeContent(s.a, s.instance.id);
      expect(effective.employeeId).toBe(s.employeeId);
      expect(effective.layers.map((x) => x.id).sort()).toEqual(sets.sort());
      await assertEmployeeContentContext(
        original.scope,
        original.runtime.generationId,
      );
      await original.finish();
      const next = await runtimeRun(s, original.scope.sessionId);
      const snapshot = next.resolved.executionSnapshot;
      if (snapshot?.schemaVersion !== 2) throw Error('Expected v2 snapshot');
      expect(snapshot.instance?.id).toBe(s.instance.id);
      expect(snapshot.instance?.source.employeeVersionId).not.toBe(
        s.instance.source.employeeVersionId,
      );
      expect(
        await f.db`select execution_snapshot::text,prompt_snapshot::text from allrice_employee_runs where run_id=${original.sent.run.id}`,
      ).toEqual(before);
      await next.finish();
    });
  },
);
