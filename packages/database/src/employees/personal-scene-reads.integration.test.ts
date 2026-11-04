import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
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
import { failJob } from '../execution/queue.ts';
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
        await f.db`update allrice_jobs set status='running',worker_id=${worker.workerId},lease_token=${worker.leaseToken},claimed_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '10 minutes' where run_id=${scope.runId} returning id`;
      worker.jobId = job!.id;
      await acquireConversationRuntime({
        ...scope,
        workerId: worker.workerId,
        configChecksum: `sha256:${'c'.repeat(64)}`,
        compactThresholdTokens: 40000,
      });
      return { scope, content: content!, worker };
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
      await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { sceneId: a.sceneId },
        run.worker,
      );
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
      expect(JSON.stringify(history)).not.toContain('do-not-return');
      expect(JSON.stringify(history)).not.toContain('/Users/secret');
    });

    it('rejects other owners, another own instance, foreign Runs and raw authority selectors', async () => {
      const s = await setup(),
        foreign = await setup(),
        installed = await save(s),
        run = await runtime(s);
      await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { sceneId: installed.sceneId },
        run.worker,
      );
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
      await loadPersonalRuntimeSceneSkill(
        run.scope,
        run.content.generationId,
        { sceneId: installed.sceneId },
        run.worker,
      );
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
        { contentRef: installed.contentRef, contentRead: true },
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
