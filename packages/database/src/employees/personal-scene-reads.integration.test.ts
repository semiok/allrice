import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HarnessEventSchema,
  type PersonalSceneSkill,
  type RequestContext,
} from '@allrice/contracts';
import { normalizeHarnessRunEvent } from '../../../../apps/worker/src/harness/runtime-contract.ts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from '../identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from '../organization-administration.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../tenant-employees.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
} from '../workspace/service.ts';
import { acquireConversationRuntime } from '../conversation/conversation-runtime.ts';
import {
  failJob,
  bindJobNativeSession,
  appendJobEvent,
  startClaimedJob,
} from '../execution/queue.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import {
  createEmployeeInstance,
  changeEmployeeInstanceLifecycle,
} from './employee-instances.ts';
import { resolveEmployeeExecution } from './employeehub.ts';
import {
  prepareEmployeeContentContext,
  loadPersonalRuntimeSceneSkill,
} from './employee-runtime-content.ts';
import {
  savePersonalSceneSkill,
  listPersonalSceneSkills,
  parsePersonalSceneContentRef,
} from './personal-scene-skills.ts';
import { sceneSkillFixture } from './employee-scene-skills.fixture.ts';
import {
  inspectPersonalSceneSkill,
  listPersonalSceneReads,
} from './personal-scene-reads.ts';

const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'owner inspects actual personal Workflow reads without creating model receipts',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
      admin: RequestContext;
    let publication: Awaited<
      ReturnType<typeof createEmployeeAdministrationFixture>
    >;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'c'.repeat(64)}`);
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'reads-platform@example.test',
        displayName: 'Platform',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      admin = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
      publication = await createEmployeeAdministrationFixture(f.db);
      await publication.preview();
      expect((await publication.publish()).valid).toBe(true);
    }, 120000);
    afterAll(async () => {
      browser.context = null;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);
    async function setup() {
      const company = await createManagedOrganization(admin, {
          name: `Read-${randomUUID()}`,
        }),
        workspaceId = company.defaultWorkspaceId!;
      const people = (
        await importOrganizationPeople(admin, company.organizationId, {
          people: [
            {
              username: `owner-${randomUUID()}`,
              displayName: 'Owner',
              contentMaintenanceLevel: 'personal',
            },
            {
              username: `peer-${randomUUID()}`,
              displayName: 'Peer',
              contentMaintenanceLevel: 'personal',
            },
          ],
        })
      ).created;
      const contexts: RequestContext[] = [];
      for (const person of people)
        contexts.push(
          (await authenticateSession(
            (await createSession(person.userId)).token,
            { organizationId: company.organizationId, workspaceId },
          ))!,
        );
      const owner = contexts[0]!,
        peer = contexts[1]!;
      const employee = (
        await listAdminTenantEmployees(
          admin,
          company.organizationId,
          workspaceId,
        )
      ).employees.find((entry) => entry.employeeId === publication.employeeId)!;
      await changeAdminTenantEmployee(admin, company.organizationId, {
        workspaceId,
        employeeId: publication.employeeId,
        action: 'assign',
        revisionId: employee.revisionId,
        expectedVersion: employee.deployment?.version ?? null,
      });
      const assigned = (
        await getEmployeeWorkspace(owner, workspaceId)
      ).employees.find(
        (entry) => entry.employeeKey === publication.definition.key,
      )!;
      const instance = await createEmployeeInstance(owner, {
        workspaceId,
        assignmentId: assigned.id,
        requestId: randomUUID(),
        profile: { name: '本人读取核对助理' },
      });
      return { owner, peer, workspaceId, assigned, instance };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    async function save(
      s: Setup,
      version = '1.0.0',
      previous?: Awaited<ReturnType<typeof savePersonalSceneSkill>>,
    ) {
      const payload = sceneSkillFixture(version),
        bytes = Buffer.from(`题目,版本\n周报,${version}\n`);
      const bundle = payload.skillPackage.bundle;
      Object.assign(bundle.resources[0]!, {
        byteLength: bytes.length,
        checksum: skillBytesChecksum(bytes),
        contentBase64: bytes.toString('base64'),
      });
      bundle.checksum = skillBundleChecksum({
        schemaVersion: bundle.schemaVersion,
        version: bundle.version,
        contentChecksum: bundle.contentChecksum,
        sourceRef: bundle.sourceRef,
        license: bundle.license,
        reviewedBy: bundle.reviewedBy,
        dependencies: bundle.dependencies,
        resources: bundle.resources,
      });
      return savePersonalSceneSkill(s.owner, s.instance.id, {
        workspaceId: s.workspaceId,
        requestId: randomUUID(),
        expectedRevision: previous?.revision ?? 0,
        expectedContentRef: previous?.contentRef ?? null,
        scene: {
          id: previous?.sceneId ?? randomUUID(),
          name: '本人周报',
          appliesWhen: '核对资料来源后整理',
        },
        procedure: { kind: 'procedure', title: '核对方法', ...payload },
        references: [],
        changeSummary: '本人保存文件',
      });
    }
    async function boundRun(s: Setup) {
      const session = await createChatSession(s.owner, {
        workspaceId: s.workspaceId,
        employeeInstanceId: s.instance.id,
        title: '合成读取核对',
      });
      const sent = await sendChatMessage(s.owner, s.workspaceId, session.id, {
        text: '加载我的周报并核对资源版本',
        clientMessageId: randomUUID(),
      });
      const scope = {
        organizationId: s.owner.organizationId,
        workspaceId: s.workspaceId,
        ownerId: s.owner.actor.id,
        sessionId: session.id,
        runId: sent.run.id,
      };
      await resolveEmployeeExecution(scope);
      return scope;
    }
    async function runtime(s: Setup) {
      const scope = await boundRun(s);
      const content = await prepareEmployeeContentContext(scope);
      expect(content).not.toBeNull();
      const worker = {
        workerId: randomUUID(),
        jobId: '',
        leaseToken: randomUUID(),
      };
      const [job] =
        await f.db`update allrice_jobs set status='claimed',attempt=1,worker_id=${worker.workerId},lease_token=${worker.leaseToken},claimed_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '10 minutes' where run_id=${scope.runId} returning id`;
      worker.jobId = job!.id;
      expect(
        await startClaimedJob(worker.workerId, worker.jobId, worker.leaseToken),
      ).not.toBeNull();
      await acquireConversationRuntime({
        ...scope,
        workerId: worker.workerId,
        configChecksum: `sha256:${'c'.repeat(64)}`,
        compactThresholdTokens: 40000,
      });
      return { scope, content: content!, worker };
    }
    type Runtime = Awaited<ReturnType<typeof runtime>>;
    async function native(run: Runtime) {
      const descriptor = nativeBindingDescriptor({
        ...run.scope,
        contextKey: run.scope.sessionId,
      });
      const [current] = await f.db<
        {
          config_checksum: string;
          thread_generation: number;
          thread_id: string | null;
        }[]
      >`select config_checksum,thread_generation,thread_id from allrice_conversation_runtimes where session_id=${run.scope.sessionId}`;
      await bindJobNativeSession({
        ...run.worker,
        attempt: 1,
        descriptor,
        subject: {
          kind: 'chat',
          id: run.scope.sessionId,
          configChecksum: current!.config_checksum,
          generation: current!.thread_generation,
          expectedThreadId: current!.thread_id,
        },
      });
      const [employee] = await f.db<
        { assistant_message_id: string }[]
      >`select assistant_message_id from allrice_employee_runs where run_id=${run.scope.runId}`;
      return {
        descriptor,
        generation: current!.thread_generation,
        messageId: employee!.assistant_message_id,
      };
    }
    function useEvent(
      run: Runtime,
      identity: Awaited<ReturnType<typeof native>>,
      skill: PersonalSceneSkill,
      kind: 'skill-invocation' | 'tool-result' = 'skill-invocation',
      nativeSequence = 100,
    ) {
      const evidence = {
        sceneId: skill.sceneId,
        nativeName: skill.nativeName,
        contentRef: skill.contentRef,
        revision: skill.revision,
        contentChecksum: skill.contentChecksum,
        bundleChecksum: skill.bundleChecksum,
        nativeSessionId: identity.descriptor.nativeSessionId,
        nativeSequence,
        kind,
        nativeId: `${kind}-${nativeSequence}`,
      };
      return {
        evidence,
        ...normalizeHarnessRunEvent(
          HarnessEventSchema.parse({
            schemaVersion: 1,
            harness: 'dsh',
            type: 'native.event',
            generation: identity.generation,
            attempt: 1,
            order: nativeSequence,
            threadId: evidence.nativeSessionId,
            turnId: `${evidence.nativeSessionId}:turn:1`,
            sessionId: run.scope.sessionId,
            messageId: identity.messageId,
            presentation: 'context',
            status: 'completed',
            label: 'synthetic Workflow use',
            sourceEventType: 'allrice/scene-use',
            sourceEventId: `scene-use:${evidence.nativeSessionId}:${nativeSequence}`,
            sourceOccurredAt: new Date().toISOString(),
            sourcePayload: evidence,
          }),
        ),
      };
    }
    async function appendUse(run: Runtime, event: ReturnType<typeof useEvent>) {
      await appendJobEvent({
        ...run.worker,
        type: event.type,
        payload: event.payload,
      });
      const [row] = await f.db<
        { id: string; sequence: number; occurred_at: Date }[]
      >`select id,sequence,occurred_at from allrice_run_events
        where run_id=${run.scope.runId} and payload->>'sourceEventId'=${String(event.payload.sourceEventId)} order by sequence desc limit 1`;
      return row!;
    }
    async function body(run: Runtime, sceneId: string) {
      const loaded = await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { sceneId },
        run.worker,
      );
      if (!('skill' in loaded)) throw Error('fixture body read required');
      return loaded.skill;
    }
    async function http(
      s: Setup,
      mode: 'reads' | 'content' | 'resource',
      query: Record<string, string> = {},
      instanceId = s.instance.id,
    ): Promise<Response> {
      const routePath =
        mode === 'reads'
          ? '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/reads/route.ts'
          : mode === 'content'
            ? '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/content/route.ts'
            : '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/route.ts';
      const { GET } = await import(routePath);
      return GET(
        new Request(
          `https://example.test/api/v1/employee-instances/${instanceId}/scene-skills${mode === 'resource' ? '' : `/${mode}`}?${new URLSearchParams({ workspaceId: s.workspaceId, ...query })}`,
        ),
        { params: Promise.resolve({ id: instanceId }) },
      );
    }

    it('distinguishes an available directory and human preview from actual committed body/resource reads', async () => {
      const s = await setup(),
        installed = await save(s),
        run = await runtime(s);
      browser.context = s.owner;
      expect(
        (await listPersonalSceneSkills(s.owner, s.instance.id)).skills,
      ).toHaveLength(1);
      const before = await listPersonalSceneReads(s.owner, s.instance.id);
      expect(before.runs).toMatchObject([
        { runId: run.scope.runId, reads: [] },
      ]);
      const preview = await http(s, 'content', {
        contentRef: installed.contentRef,
      });
      expect(preview.status).toBe(200);
      expect(preview.headers.get('cache-control')).toBe('private, no-store');
      expect((await preview.json()).content).toContain('1.0.0');
      const file = await http(s, 'resource', {
        contentRef: installed.contentRef,
        resourcePath: 'assets/template.csv',
      });
      expect(file.status).toBe(200);
      expect(await file.json()).toMatchObject({
        contentRef: installed.contentRef,
        bundleChecksum: installed.bundleChecksum,
        path: 'assets/template.csv',
      });
      expect(await listPersonalSceneReads(s.owner, s.instance.id)).toEqual(
        before,
      );
      await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { sceneId: installed.sceneId },
        run.worker,
      );
      const resource = await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        {
          contentRef: installed.contentRef,
          resourcePath: 'assets/template.csv',
        },
        run.worker,
      );
      const response = await http(s, 'reads', { runId: run.scope.runId });
      expect(response.status).toBe(200);
      const history = await response.json(),
        actual = history.runs[0].reads[0];
      expect(actual).toMatchObject({
        receiptId: resource.receipt.receiptId,
        sceneId: installed.sceneId,
        contentRef: installed.contentRef,
        contentRead: true,
        uses: [],
        contentChecksum: installed.contentChecksum,
        bundleChecksum: installed.bundleChecksum,
        resources: resource.receipt.personal!.resources,
      });
      expect(history.runs[0].sessionId).toBe(run.scope.sessionId);
      expect(Object.keys(actual).sort()).toEqual(
        [
          'receiptId',
          'sceneId',
          'contentRef',
          'contentChecksum',
          'bundleChecksum',
          'contentRead',
          'resources',
          'generationId',
          'readAt',
          'uses',
        ].sort(),
      );
      expect(JSON.stringify(history)).not.toContain(run.worker.leaseToken);
      expect(JSON.stringify(history)).not.toContain('workerId');
      expect(
        (
          await listPersonalSceneReads(s.owner, s.instance.id, {
            beforeCreatedAt: history.runs[0].createdAt,
            beforeRunId: run.scope.runId,
          })
        ).runs,
      ).toEqual([]);
    });

    it('projects only canonical native use events, with exact v1/v2 revisions and original native identities', async () => {
      const s = await setup(),
        a = await save(s),
        run = await runtime(s);
      const first = await body(run, a.sceneId),
        identity = await native(run);
      const invocation = useEvent(run, identity, first);
      // A successful ordinary tool event and directory/get metadata do not
      // acquire injection meaning from having similar fields or timing.
      await appendJobEvent({
        ...run.worker,
        type: 'harness.native',
        payload: { ...invocation.payload, sourceEventType: 'tool/result' },
      });
      await appendJobEvent({
        ...run.worker,
        type: 'harness.native',
        payload: { ...invocation.payload, sourceEventType: 'skill/summary' },
      });
      expect(
        (await listPersonalSceneReads(s.owner, s.instance.id)).runs[0]!
          .reads[0]!.uses,
      ).toEqual([]);
      const stored = await appendUse(run, invocation);
      await appendUse(run, invocation); // Duplicate durable delivery is one native fact.
      const b = await save(s, '2.0.0', a),
        second = await body(run, b.sceneId);
      const result = useEvent(run, identity, second, 'tool-result', 101);
      await appendUse(run, result);
      browser.context = s.owner;
      const response = await http(s, 'reads', { runId: run.scope.runId });
      expect(response.status).toBe(200);
      const history = await response.json();
      expect(history.runs[0].reads[0].uses).toEqual([
        {
          ...invocation.evidence,
          eventId: stored.id,
          eventSequence: stored.sequence,
          recordedAt: stored.occurred_at.toISOString(),
        },
      ]);
      expect(history.runs[0].reads[1].uses).toMatchObject([
        { ...result.evidence, revision: b.revision },
      ]);
      expect(
        history.runs[0].reads.map(
          (read: { uses: unknown[] }) => read.uses.length,
        ),
      ).toEqual([1, 1]);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(JSON.stringify(history)).not.toContain(
        identity.descriptor.storageNamespace,
      );
      expect(JSON.stringify(history)).not.toContain('synthetic Workflow use');
      expect(JSON.stringify(history)).not.toContain(first.content);
    });

    it.each([
      'revision',
      'checksum',
      'native name',
      'other chat binding',
      'assistant message',
      'nested task',
      'malformed payload',
      'resource only',
    ] as const)(
      'rejects a claimed use with %s mismatch without returning its private fields',
      async (fault) => {
        const s = await setup(),
          installed = await save(s),
          run = await runtime(s);
        let loaded: PersonalSceneSkill;
        if (fault === 'resource only') {
          await loadPersonalRuntimeSceneSkill(
            run.scope,
            run.content.generationId,
            {
              contentRef: installed.contentRef,
              resourcePath: 'assets/template.csv',
            },
            run.worker,
          );
          loaded = await inspectPersonalSceneSkill(
            s.owner,
            s.instance.id,
            installed.contentRef,
          );
        } else loaded = await body(run, installed.sceneId);
        const identity = await native(run),
          event = useEvent(run, identity, loaded);
        if (fault === 'revision')
          event.payload.nativePayload = {
            ...event.evidence,
            revision: installed.revision + 1,
          };
        if (fault === 'checksum')
          event.payload.nativePayload = {
            ...event.evidence,
            contentChecksum: `sha256:${'0'.repeat(64)}`,
          };
        if (fault === 'native name')
          event.payload.nativePayload = {
            ...event.evidence,
            nativeName: `allrice-scene-${randomUUID()}`,
          };
        if (fault === 'other chat binding') {
          const other = await native(await runtime(s));
          event.payload.nativePayload = {
            ...event.evidence,
            nativeSessionId: other.descriptor.nativeSessionId,
          };
          event.payload.threadId = other.descriptor.nativeSessionId;
          event.payload.sourceEventId = `scene-use:${other.descriptor.nativeSessionId}:${event.evidence.nativeSequence}`;
        }
        if (fault === 'assistant message')
          event.payload.messageId = randomUUID();
        if (fault === 'nested task')
          event.payload.internalTask = {
            kind: 'private task',
            private: 'do-not-return',
          };
        if (fault === 'malformed payload')
          event.payload.nativePayload = {
            ...event.evidence,
            nativeId: 0,
            private: 'do-not-return',
          };
        await appendUse(run, event);
        browser.context = s.owner;
        const response = await http(s, 'reads', { runId: run.scope.runId });
        expect(response.status).toBe(409);
        const text = await response.text();
        expect(text).not.toContain('do-not-return');
        expect(text).not.toContain(identity.descriptor.nativeSessionId);
        expect(text).not.toContain(installed.contentRef);
        expect(text).not.toContain(loaded.content);
      },
    );

    it('rejects a cross-instance exact ref even when a malformed read and use agree on its hashes', async () => {
      const s = await setup(),
        installed = await save(s),
        run = await runtime(s);
      const first = await body(run, installed.sceneId),
        identity = await native(run);
      const other = await createEmployeeInstance(s.owner, {
        workspaceId: s.workspaceId,
        assignmentId: s.assigned.id,
        requestId: randomUUID(),
        profile: { name: '另一个本人实例' },
      });
      const otherVersion = await save({ ...s, instance: other });
      const [row] =
        await f.db`select content_scene_state from allrice_employee_runs where run_id=${run.scope.runId}`;
      const corrupted = structuredClone(row!.content_scene_state);
      const badRead = structuredClone(corrupted.reads[0]);
      badRead.receiptId = randomUUID();
      badRead.sceneId = otherVersion.sceneId;
      badRead.sceneDigest = otherVersion.bundleChecksum;
      Object.assign(badRead.personal, {
        contentRef: otherVersion.contentRef,
        contentChecksum: otherVersion.contentChecksum,
        bundleChecksum: otherVersion.bundleChecksum,
      });
      corrupted.reads.push(badRead);
      await f.db`update allrice_employee_runs set content_scene_state=${f.db.json(corrupted)} where run_id=${run.scope.runId}`;
      const [appended] =
        await f.db`select content_scene_state from allrice_employee_runs where run_id=${run.scope.runId}`;
      expect(appended!.content_scene_state.reads[0]).toEqual(
        row!.content_scene_state.reads[0],
      );
      await appendUse(
        run,
        useEvent(run, identity, {
          ...first,
          sceneId: otherVersion.sceneId,
          nativeName: `allrice-scene-${otherVersion.sceneId}`,
          contentRef: otherVersion.contentRef,
        }),
      );
      browser.context = s.owner;
      const response = await http(s, 'reads', { runId: run.scope.runId });
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain(otherVersion.contentRef);
    });

    it('keeps exact v1/v2 body reads separate and never interprets resource-only reads as body injection', async () => {
      const s = await setup(),
        a = await save(s),
        run = await runtime(s);
      await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { contentRef: a.contentRef, resourcePath: 'assets/template.csv' },
        run.worker,
      );
      const b = await save(s, '2.0.0', a);
      await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { sceneId: a.sceneId },
        run.worker,
      );
      const history = await listPersonalSceneReads(s.owner, s.instance.id);
      expect(history.runs[0]!.reads).toMatchObject([
        {
          contentRef: a.contentRef,
          contentRead: false,
          resources: [{ path: 'assets/template.csv' }],
        },
        { contentRef: b.contentRef, contentRead: true, resources: [] },
      ]);
      expect(
        (await inspectPersonalSceneSkill(s.owner, s.instance.id, a.contentRef))
          .content,
      ).toContain('1.0.0');
      expect(
        (await inspectPersonalSceneSkill(s.owner, s.instance.id, b.contentRef))
          .content,
      ).toContain('2.0.0');
      browser.context = s.owner;
      const oldResource = await (
        await http(s, 'resource', {
          contentRef: a.contentRef,
          resourcePath: 'assets/template.csv',
        })
      ).json();
      const newResource = await (
        await http(s, 'resource', {
          contentRef: b.contentRef,
          resourcePath: 'assets/template.csv',
        })
      ).json();
      expect(oldResource.contentRef).toBe(a.contentRef);
      expect(newResource.contentRef).toBe(b.contentRef);
      expect(oldResource.checksum).not.toBe(newResource.checksum);
      expect(
        Buffer.from(oldResource.contentBase64, 'base64').toString(),
      ).toContain('1.0.0');
      expect(
        Buffer.from(newResource.contentBase64, 'base64').toString(),
      ).toContain('2.0.0');
    });

    it('retains read metadata and a safe failure after source withdrawal while historical body reads are denied', async () => {
      const s = await setup(),
        a = await save(s),
        run = await runtime(s);
      const loaded = await body(run, a.sceneId),
        identity = await native(run);
      await appendUse(run, useEvent(run, identity, loaded));
      const [source] =
        await f.db`select asset_id from allrice_company_asset_revisions where id=${parsePersonalSceneContentRef(a.contentRef).sourceRevisionId}`;
      await f.db`update allrice_company_assets set state='withdrawn' where id=${source!.asset_id}`;
      await expect(
        loadPersonalRuntimeSceneSkill(
          run.scope,
          run.content.generationId,
          { sceneId: a.sceneId },
          run.worker,
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await failJob({
        ...run.worker,
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
        message: 'private config /Users/secret/.env token=do-not-return',
        retryable: false,
      });
      browser.context = s.owner;
      expect(
        (await http(s, 'content', { contentRef: a.contentRef })).status,
      ).toBe(404);
      expect(
        (
          await http(s, 'resource', {
            contentRef: a.contentRef,
            resourcePath: 'assets/template.csv',
          })
        ).status,
      ).toBe(404);
      const response = await http(s, 'reads', { runId: run.scope.runId });
      expect(response.status).toBe(200);
      const history = await response.json();
      expect(history.runs[0].error).toEqual({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
        message: '工作要求或其引用资料已失效，请确认当前版本后重新发起任务。',
      });
      expect(history.runs[0].reads[0].contentRef).toBe(a.contentRef);
      expect(history.runs[0].reads[0].uses).toMatchObject([
        {
          contentRef: a.contentRef,
          nativeSessionId: identity.descriptor.nativeSessionId,
        },
      ]);
      expect(JSON.stringify(history)).not.toContain('do-not-return');
      expect(JSON.stringify(history)).not.toContain('/Users/secret');
    });

    it('rejects other owners, another own instance, foreign Runs and raw authority selectors', async () => {
      const s = await setup(),
        foreign = await setup(),
        installed = await save(s),
        run = await runtime(s);
      const loaded = await body(run, installed.sceneId),
        identity = await native(run);
      await appendUse(run, useEvent(run, identity, loaded));
      for (const { context, status } of [
        { context: s.peer, status: 404 },
        { context: foreign.owner, status: 403 },
        { context: null, status: 401 },
      ]) {
        browser.context = context;
        expect(
          (await http(s, 'reads', { runId: run.scope.runId })).status,
        ).toBe(status);
        expect(
          (await http(s, 'content', { contentRef: installed.contentRef }))
            .status,
        ).toBe(status);
        expect(
          (
            await http(s, 'resource', {
              contentRef: installed.contentRef,
              resourcePath: 'assets/template.csv',
            })
          ).status,
        ).toBe(status);
      }
      const other = await createEmployeeInstance(s.owner, {
        workspaceId: s.workspaceId,
        assignmentId: s.assigned.id,
        requestId: randomUUID(),
        profile: { name: '本人另一员工' },
      });
      browser.context = s.owner;
      expect(
        (await http(s, 'reads', { runId: run.scope.runId }, other.id)).status,
      ).toBe(404);
      expect(
        (
          await http(
            s,
            'content',
            { contentRef: installed.contentRef },
            other.id,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await http(
            s,
            'resource',
            {
              contentRef: installed.contentRef,
              resourcePath: 'assets/template.csv',
            },
            other.id,
          )
        ).status,
      ).toBe(404);
      expect(
        (await (await http(s, 'reads', {}, other.id)).json()).runs,
      ).toEqual([]);
      const invalidQueries: Record<string, string>[] = [
        { legacy: 'true' },
        { ownerId: s.owner.actor.id },
        { sharedTarget: 'company' },
        { beforeRunId: randomUUID() },
      ];
      for (const raw of invalidQueries)
        expect((await http(s, 'reads', raw)).status).toBe(400);
      await expect(
        listPersonalSceneReads({ ...s.owner, sessionId: '' }, s.instance.id),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
      expect((await http(s, 'reads', { runId: run.scope.runId })).status).toBe(
        200,
      );
      expect(
        (await http(s, 'content', { contentRef: installed.contentRef })).status,
      ).toBe(403);
      expect(
        (
          await http(s, 'resource', {
            contentRef: installed.contentRef,
            resourcePath: 'assets/template.csv',
          })
        ).status,
      ).toBe(403);
    });

    it('returns real HTTP 409 for archived current content while owner read audit remains 200', async () => {
      const s = await setup(),
        installed = await save(s),
        run = await runtime(s);
      const loaded = await body(run, installed.sceneId),
        identity = await native(run);
      await appendUse(run, useEvent(run, identity, loaded));
      const archived = await changeEmployeeInstanceLifecycle(
        s.owner,
        s.instance.id,
        {
          workspaceId: s.workspaceId,
          expectedRevision: s.instance.revision,
          requestId: randomUUID(),
          operation: 'archive',
        },
      );
      expect(archived.archivedAt).not.toBeNull();
      browser.context = s.owner;
      const directory = await http(s, 'resource');
      expect(directory.status).toBe(409);
      expect(await directory.json()).toMatchObject({
        error: { retryable: false },
      });
      expect(
        (await http(s, 'content', { contentRef: installed.contentRef })).status,
      ).toBe(409);
      expect(
        (
          await http(s, 'resource', {
            contentRef: installed.contentRef,
            resourcePath: 'assets/template.csv',
          })
        ).status,
      ).toBe(409);
      const audit = await http(s, 'reads', { runId: run.scope.runId });
      expect(audit.status).toBe(200);
      expect((await audit.json()).runs[0].reads).toMatchObject([
        {
          contentRef: installed.contentRef,
          contentRead: true,
          uses: [{ nativeSessionId: identity.descriptor.nativeSessionId }],
        },
      ]);
    });

    it('pages through all owned Run receipts without dropping or duplicating the boundary Run', async () => {
      const s = await setup();
      await save(s);
      const created: string[] = [];
      for (let index = 0; index < 21; index++)
        created.push((await boundRun(s)).runId);
      const first = await listPersonalSceneReads(s.owner, s.instance.id);
      expect(first.runs).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      const second = await listPersonalSceneReads(s.owner, s.instance.id, {
        beforeCreatedAt: first.nextCursor!.createdAt,
        beforeRunId: first.nextCursor!.runId,
      });
      expect(second.runs).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const actual = [...first.runs, ...second.runs].map((run) => run.runId);
      expect(new Set(actual).size).toBe(21);
      expect(actual.toSorted()).toEqual(created.toSorted());
    }, 60000);

    it('does not return unrecognized private error codes or messages from a Run', async () => {
      const s = await setup();
      await save(s);
      const run = await runtime(s);
      await failJob({
        ...run.worker,
        code: 'PRIVATE_TOKEN_DO_NOT_RETURN',
        message: '/Users/private/.env secret=not-for-browser',
        retryable: false,
      });
      const history = await listPersonalSceneReads(s.owner, s.instance.id);
      expect(history.runs[0]!.error).toEqual({
        code: null,
        message: '本次执行未完成，请回到原工作记录查看错误回执。',
      });
      expect(history.runs[0]!.reads).toEqual([]);
      expect(JSON.stringify(history)).not.toContain('PRIVATE_TOKEN');
      expect(JSON.stringify(history)).not.toContain('not-for-browser');
    });
  },
);
