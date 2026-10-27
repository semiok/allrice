/**
 * Exercises the published-template, instance, saved-method and test-queue flow.
 * Uses isolated PostgreSQL and synthetic historical test-tool grants/completion;
 * does not call a provider or start a Native Host.
 */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as toolSelection from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../identity.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from '../tenant-employees.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
} from '../workspace/service.ts';
import { createEmployeeInstance } from '../employees/employee-instances.ts';
import { saveEmployeeMethodFromChat } from '../employees/employee-method-chat.ts';
import { getEmployeeContentSet } from '../employees/employee-content.ts';
import { prepareEmployeeContentContext } from '../employees/employee-runtime-content.ts';
import {
  getEmployeeMethodTest,
  startEmployeeMethodTestFromChat,
} from '../employees/employee-method-tests.ts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  savePlatformEmployeeDraft,
} from '../employees/platform-employees.ts';
import {
  bindJobNativeSession,
  prepareJobNativeSession,
  startClaimedJob,
} from '../execution/queue.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { newNativeGeneration } from './current-execution-binding.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'B2a real method issuer, replay and explicit retry (isolated SQL)',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    const artifactA = 'sha256:' + 'a'.repeat(64);
    const artifactB = 'sha256:' + 'b'.repeat(64);
    const currentMethodTools = toolSelection.withEmployeeCustomizationTools;
    const approve = (artifact = artifactA) => {
      // Synthetic SQL authority only; these are not measured runnable artifacts.
      // MET-221: the release primary is the only birth input.
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
    };

    beforeAll(async () => {
      approve();
      fixture = await createAssistantFixtureDatabase();
      // The historical SQL bootstrap has no generation field. This SQL-only
      // fixture publishes current sources without running content:sync.
      await fixture.db`update allrice_platform_employee_revisions
        set runtime_profile=runtime_profile || ${fixture.db.json({ distributionGeneration: newNativeGeneration })}
        where runtime_profile is not null and not runtime_profile ? 'distributionGeneration'`;
      const [where] =
        await fixture.db`select current_database() db,current_schema() schema`;
      expect(where!.db).toBe(
        new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
      );
      expect(where!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No provider/network from method issuer SQL fixture'),
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      // The consumer under test is the existing historical draft/test API. Match
      // its already-existing integration fixture, retaining capability/kind checks.
      // New product chat flows no longer expose these legacy test/activation tools.
      vi.spyOn(
        toolSelection,
        'withEmployeeCustomizationTools',
      ).mockImplementation((names, capabilities, kind) => [
        ...currentMethodTools(names, capabilities, kind),
        ...(kind === 'custom'
          ? toolSelection
              .employeeCustomizationToolsForInstance(kind)
              .filter((tool) => capabilities.includes(tool.capability))
              .map((tool) => tool.name)
              .filter(
                (name) =>
                  !currentMethodTools(names, capabilities, kind).includes(name),
              )
          : []),
      ]);
    }, 120000);

    afterEach(() => approve());
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      const proof = await fixture?.close();
      console.log(
        JSON.stringify({ kind: 'b2a-method-issuer-fixture-cleanup', proof }),
      );
    }, 30000);

    async function principal(
      organizationSlug = `b2a-method-${randomUUID()}`,
      role: 'member' | 'admin' = 'member',
    ) {
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug,
          organizationName: 'Synthetic B2a method company',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic B2a method workspace',
          email: `${randomUUID()}@example.test`,
          displayName: 'Synthetic method member',
          role,
        },
        fixture.db,
      );
      const login = await createSession(p.user.id);
      const context = await authenticateSession(login.token, {
        organizationId: p.organizationId,
        workspaceId: p.workspaceId,
      });
      if (!context) throw Error('method fixture login failed');
      return { ...p, context };
    }

    async function setup() {
      approve();
      const slug = `b2a-method-${randomUUID()}`;
      const admin = await principal(undefined, 'admin');
      const owner = await principal(slug);
      const other = await principal(slug);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
      const source = await createEmployeeAdministrationFixture(fixture.db);
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            toolNames: ['workspace.skill.read', 'workspace.export.create'],
          },
        },
        expectedRevisionId: source.revisionId,
      });
      // The publication fixture records a synthetic no-provider preview result.
      // Its real queue INSERT must also satisfy the enabled 0211 guard.
      await source.preview();
      expect((await source.publish()).valid).toBe(true);
      const entry = (
        await listAdminTenantEmployees(
          admin.context,
          owner.organizationId,
          owner.workspaceId,
        )
      ).employees.find((e) => e.employeeId === source.employeeId)!;
      await changeAdminTenantEmployee(admin.context, owner.organizationId, {
        workspaceId: owner.workspaceId,
        employeeId: source.employeeId,
        action: 'assign',
        revisionId: entry.revisionId,
        expectedVersion: entry.deployment?.version ?? null,
      });
      const assignment = (
        await getEmployeeWorkspace(owner.context, owner.workspaceId)
      ).employees[0]!;
      const instance = await createEmployeeInstance(owner.context, {
        workspaceId: owner.workspaceId,
        assignmentId: assignment.id,
        requestId: randomUUID(),
        profile: { name: 'B2a frozen method fixture' },
      });
      expect(instance.source.kind).toBe('platform');
      const [published] = await fixture.db`
      select r.* from allrice_employee_version_sources s
      join allrice_platform_employee_revisions r
        on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
      where s.employee_version_id=${instance.source.employeeVersionId}
        and s.organization_id=${owner.organizationId} and s.workspace_id=${owner.workspaceId}`;
      expect(published?.status).toBe('published');
      return { admin, owner, other, source, instance, published: published! };
    }

    async function methodRun(
      f: Awaited<ReturnType<typeof setup>>,
      text: string,
    ) {
      const session = await createChatSession(f.owner.context, {
        workspaceId: f.owner.workspaceId,
        employeeInstanceId: f.instance.id,
        title: 'Synthetic method authorization',
      });
      const sent = await sendChatMessage(
        f.owner.context,
        f.owner.workspaceId,
        session.id,
        { text, clientMessageId: randomUUID() },
      );
      const workerId = randomUUID(),
        leaseToken = randomUUID();
      const [job] =
        await fixture.db`update allrice_jobs set status='claimed',worker_id=${workerId},
      lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
      lease_expires_at=clock_timestamp()+interval '5 minutes'
      where run_id=${sent.run.id} returning id`;
      const execution = await startClaimedJob(workerId, job!.id, leaseToken);
      if (!execution) throw Error('method authorizing chat did not start');
      const [row] = await fixture.db`select user_message_id,execution_snapshot
      from allrice_employee_runs where run_id=${sent.run.id}`;
      const runtime = await prepareEmployeeContentContext({
        organizationId: f.owner.organizationId,
        workspaceId: f.owner.workspaceId,
        ownerId: f.owner.user.id,
        sessionId: session.id,
        runId: sent.run.id,
      });
      expect(runtime).not.toBeNull();
      return {
        context: execution.context,
        sessionId: session.id,
        userMessageId: row!.user_message_id as string,
        worker: { attempt: execution.job.attempt, leaseToken },
        callId: randomUUID(),
        frozen: row!.execution_snapshot,
        // Same SQL-only chat completion as the source integration fixture. No
        // model/native dispatch or usage is fabricated by this authorizing chat.
        finish: async () => {
          await fixture.db`update allrice_jobs set status='succeeded',completed_at=now() where run_id=${sent.run.id}`;
          await fixture.db`update allrice_runs set state='succeeded',completed_at=now() where id=${sent.run.id}`;
          await fixture.db`update allrice_employee_runs set status='succeeded',completed_at=now() where run_id=${sent.run.id}`;
        },
      };
    }

    async function candidate() {
      const f = await setup();
      const editing = await methodRun(
        f,
        '请保存我的工作场景候选：金额汇总，保留原始数据。',
      );
      const saved = await saveEmployeeMethodFromChat({
        ...editing,
        arguments: {
          expectedRevision: 0,
          section: 'scene',
          scene: { name: '金额汇总', appliesWhen: '固定合成数据' },
          procedure: '只将整数分相加',
          changeSummary: 'B2a 原始来源与重试边界样例',
        },
      });
      await editing.finish();
      const content = await getEmployeeContentSet(f.owner.context, saved.setId);
      const args = {
        expectedRevision: saved.revision,
        candidateRevisionId: saved.candidate.id,
        candidateDigest: saved.candidate.digest,
        sceneId: content.set.candidate!.manifest.scenes[0]!.id,
        caseId: 'cny-total-v1',
      };
      const testing = await methodRun(f, '请测试我的工作场景候选：金额汇总。');
      return { f, saved, args, testing };
    }

    async function testRow(id: string) {
      const [row] =
        await fixture.db`select * from allrice_platform_employee_test_runs where id=${id}`;
      if (!row) throw Error('owned method test row missing');
      return row;
    }
    async function methodRow(id: string) {
      const [row] =
        await fixture.db`select * from allrice_employee_method_tests where test_id=${id}`;
      if (!row) throw Error('owned method binding missing');
      return row;
    }
    async function counts(id: string) {
      const [row] = await fixture.db`select
      (select count(*)::integer from allrice_runs where execution_spec->>'platformEmployeeTestRunId'=${id}) runs,
      (select count(*)::integer from allrice_jobs j join allrice_runs r on r.id=j.run_id
        where r.execution_spec->>'platformEmployeeTestRunId'=${id}) jobs`;
      return row!;
    }
    async function ownerCounts(f: Awaited<ReturnType<typeof setup>>) {
      const [row] = await fixture.db`select
      (select count(*)::integer from allrice_employee_method_tests where organization_id=${f.owner.organizationId}
        and workspace_id=${f.owner.workspaceId} and owner_id=${f.owner.user.id}) tests,
      (select count(*)::integer from allrice_runs where organization_id=${f.owner.organizationId}) runs,
      (select count(*)::integer from allrice_jobs where organization_id=${f.owner.organizationId}) jobs`;
      return row!;
    }
    async function fail(id: string) {
      return completePlatformEmployeeTestRun(id, {
        answer: null,
        provider: null,
        model: null,
        threadId: null,
        usage: null,
        events: [],
        error: {
          code: 'DSH_TRANSPORT',
          message: 'Synthetic pre-dispatch failure; no provider called',
        },
        modelExecution: {
          dispatched: false,
          subscriptionSnapshotCreated: false,
          usageComplete: true,
          cacheUsageKnown: true,
          costCents: 0,
        },
      });
    }
    async function claimAndBind(
      id: string,
      f: Awaited<ReturnType<typeof setup>>,
    ) {
      const row = await testRow(id),
        workerId = randomUUID();
      const claimed = await claimNextPlatformEmployeeTestRun(workerId);
      expect(claimed?.id).toBe(id);
      if (!claimed) throw Error('owned method test not claimed');
      expect(claimed.methodCandidate).toBeDefined();
      const descriptor = {
        ...nativeBindingDescriptor({
          organizationId: f.owner.organizationId,
          workspaceId: f.owner.workspaceId,
          ownerId: f.owner.user.id,
          contextKey: id,
          distributionGeneration: newNativeGeneration,
        }),
        artifactId: row.native_root_origin.artifactId,
        artifactManifestDigest: row.native_root_origin.artifactId,
      };
      const lease = {
        workerId,
        jobId: claimed.previewExecution.jobId,
        leaseToken: claimed.previewExecution.leaseToken,
        attempt: claimed.previewExecution.jobAttempt,
        subject: { kind: 'platform_employee_test' as const, id },
      };
      const preparation = {
        ...lease,
        nativeSessionId: descriptor.nativeSessionId,
        storageContextKey: id,
      };
      const prepared = await prepareJobNativeSession(preparation);
      expect(prepared.binding).toBeNull();
      expect(prepared.executionBinding).toEqual({
        kind: 'current_platform_test_run_execution',
        test: row.native_execution_binding,
        runId: claimed.previewExecution.runId,
        jobId: lease.jobId,
        attempt: lease.attempt,
      });
      const bound = await bindJobNativeSession({ ...lease, descriptor });
      expect(bound.binding).toMatchObject({
        contextKind: 'platform_employee_test',
        contextId: id,
        organizationId: f.owner.organizationId,
        workspaceId: f.owner.workspaceId,
        ownerId: f.owner.user.id,
        artifactId: row.native_root_origin.artifactId,
      });
      const cold = await prepareJobNativeSession(preparation);
      expect(cold.executionBinding).toEqual(prepared.executionBinding);
      expect(cold.requiresRecovery).toBe(true);
      expect(cold.binding?.firstRunId).toBe(claimed.previewExecution.runId);
      return claimed;
    }

    it('first INSERT freezes the published source; replay is one test and claim owns the first real execution', async () => {
      const x = await candidate();
      const input = { ...x.testing, arguments: x.args };
      const test = await startEmployeeMethodTestFromChat(input);
      expect(test).toMatchObject({
        status: 'queued',
        runId: null,
        validationStatus: 'pending',
      });
      expect(await counts(test.id)).toEqual({ runs: 0, jobs: 0 });
      const row = await testRow(test.id),
        binding = await methodRow(test.id);
      expect(row).toMatchObject({
        employee_id: x.f.source.employeeId,
        revision_id: x.f.published.id,
        purpose: 'method_candidate',
      });
      expect(row.frozen_definition).toEqual(x.f.published.definition);
      expect(row.frozen_runtime_profile).toEqual(x.f.published.runtime_profile);
      expect(row.frozen_native_skills).toEqual(
        x.f.published.runtime_profile.runtimePackage.skills,
      );
      expect(row.frozen_package_checksum).toBe(
        x.f.published.runtime_profile.runtimePackage.checksum,
      );
      expect(row.native_root_origin).toMatchObject({
        schemaVersion: 2,
        contextKind: 'platform_employee_test',
        contextId: test.id,
        artifactId: artifactA,
        birthSource: {
          platformRevisionId: x.f.published.id,
          definitionChecksum: x.f.published.checksum,
          purpose: 'method_candidate',
        },
      });
      expect(row.native_execution_binding).toMatchObject({
        scope: {
          testId: test.id,
          organizationId: x.f.owner.organizationId,
          workspaceId: x.f.owner.workspaceId,
          ownerId: x.f.owner.user.id,
        },
        source: row.native_root_origin.birthSource,
        execution: { artifactId: artifactA },
      });
      expect(binding.model_snapshot).toEqual(x.testing.frozen.modelSnapshot);
      expect(binding.candidate_snapshot.content).toMatchObject({
        candidateRevisionId: x.args.candidateRevisionId,
        candidateDigest: x.args.candidateDigest,
        employeeVersionId: x.f.instance.source.employeeVersionId,
      });
      expect((await startEmployeeMethodTestFromChat(input)).id).toBe(test.id);
      const repeats = await Promise.all(
        [0, 1].map(() =>
          startEmployeeMethodTestFromChat({ ...input, callId: randomUUID() }),
        ),
      );
      expect(repeats.map((r) => r.id)).toEqual([test.id, test.id]);
      expect((await ownerCounts(x.f)).tests).toBe(1);
      expect(await counts(test.id)).toEqual({ runs: 0, jobs: 0 });
      for (const context of [x.f.other.context, x.f.admin.context]) {
        await expect(
          getEmployeeMethodTest(context, test.id),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      await x.testing.finish();
      // A later editable platform draft must not become this queued test's source.
      await savePlatformEmployeeDraft(x.f.source.employeeId, {
        definition: {
          ...x.f.published.definition,
          name: 'Later draft must not replace queued source',
        },
        expectedRevisionId: x.f.published.id,
      });
      const claim = await claimAndBind(test.id, x.f);
      expect(await counts(test.id)).toEqual({ runs: 1, jobs: 1 });
      expect(claim.methodCandidate!.modelSnapshot).toEqual(
        binding.model_snapshot,
      );
      const after = await testRow(test.id);
      for (const key of [
        'revision_id',
        'frozen_definition',
        'frozen_runtime_profile',
        'frozen_native_skills',
        'frozen_package_checksum',
        'native_root_origin',
        'native_execution_binding',
      ]) {
        expect(after[key]).toEqual(row[key]);
      }
      await fail(test.id);
    }, 60000);

    it('explicit failure retry gets a new current executor while preserving the failed parent and original method/model source', async () => {
      const x = await candidate();
      const parent = await startEmployeeMethodTestFromChat({
        ...x.testing,
        arguments: x.args,
      });
      await x.testing.finish();
      await claimAndBind(parent.id, x.f);
      await fail(parent.id);
      const parentTest = await testRow(parent.id),
        parentMethod = await methodRow(parent.id);
      expect(parentTest.status).toBe('failed');
      expect(
        (await getEmployeeMethodTest(x.f.owner.context, parent.id))
          .validationStatus,
      ).toBe('not_verified');
      const ordinary = await methodRun(
        x.f,
        '请测试我的工作场景候选：金额汇总。',
      );
      expect(
        (
          await startEmployeeMethodTestFromChat({
            ...ordinary,
            arguments: x.args,
          })
        ).id,
      ).toBe(parent.id);
      await expect(
        startEmployeeMethodTestFromChat({
          ...ordinary,
          callId: randomUUID(),
          arguments: { ...x.args, retryOfTestId: parent.id },
        }),
      ).rejects.toMatchObject({ code: 'explicit_test_retry_required' });
      await ordinary.finish();

      approve(artifactB);
      const retrying = await methodRun(x.f, `请重试测试 ${parent.id}。`);
      expect(retrying.sessionId).not.toBe(x.testing.sessionId);
      const args = { ...x.args, retryOfTestId: parent.id };
      const retried = await Promise.all(
        [0, 1].map(() =>
          startEmployeeMethodTestFromChat({
            ...retrying,
            callId: randomUUID(),
            arguments: args,
          }),
        ),
      );
      const child = retried[0]!;
      expect(retried[1]!.id).toBe(child.id);
      expect(child.id).not.toBe(parent.id);
      expect(child).toMatchObject({
        status: 'queued',
        retryOfTestId: parent.id,
        runId: null,
      });
      expect(
        (
          await startEmployeeMethodTestFromChat({
            ...retrying,
            arguments: args,
          })
        ).id,
      ).toBe(child.id);
      expect(await counts(child.id)).toEqual({ runs: 0, jobs: 0 });
      expect((await ownerCounts(x.f)).tests).toBe(2);
      const childTest = await testRow(child.id),
        childMethod = await methodRow(child.id);
      for (const key of [
        'employee_id',
        'revision_id',
        'purpose',
        'input',
        'frozen_definition',
        'frozen_runtime_profile',
        'frozen_native_skills',
        'frozen_package_checksum',
      ]) {
        expect(childTest[key]).toEqual(parentTest[key]);
      }
      for (const key of [
        'model_snapshot',
        'candidate_snapshot',
        'snapshot_digest',
        'binding_digest',
      ]) {
        expect(childMethod[key]).toEqual(parentMethod[key]);
      }
      expect(childMethod.source_session_id).toBe(retrying.sessionId);
      expect(childMethod.source_run_id).toBe(retrying.context.runId);
      expect(childMethod.retry_of_test_id).toBe(parent.id);
      expect(childTest.native_root_origin).toMatchObject({
        contextId: child.id,
        rootSeed: child.id,
        artifactId: artifactB,
      });
      expect(childTest.native_root_origin.birthSource).toEqual(
        parentTest.native_root_origin.birthSource,
      );
      expect(childTest.native_execution_binding.source).toEqual(
        parentTest.native_execution_binding.source,
      );
      expect(childTest.native_execution_binding.execution.artifactId).toBe(
        artifactB,
      );
      // The old failure, raw output, timestamps, source and execution identity are
      // immutable evidence. Only the DTO's reverse retry lookup can gain a child.
      expect(await testRow(parent.id)).toEqual(parentTest);
      expect(await methodRow(parent.id)).toEqual(parentMethod);
      await retrying.finish();
      const claimed = await claimAndBind(child.id, x.f);
      expect(claimed.methodCandidate!.modelSnapshot).toEqual(
        parentMethod.model_snapshot,
      );
      expect(claimed.methodCandidate!.sourceSessionId).toBe(
        parentMethod.model_snapshot.sessionId,
      );
      expect(await counts(child.id)).toEqual({ runs: 1, jobs: 1 });
      await fail(child.id);
      expect(await testRow(parent.id)).toEqual(parentTest);
      expect(await methodRow(parent.id)).toEqual(parentMethod);
    }, 60000);

    it('missing current execution approval rolls back the issuer without a test or additional Run/Job', async () => {
      const x = await candidate();
      const before = await ownerCounts(x.f);
      expect(before.tests).toBe(0);
      // The authorizing chat Run already exists. Assert no additional execution,
      // rather than incorrectly asserting the tenant has no Runs at all.
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
      await expect(
        startEmployeeMethodTestFromChat({ ...x.testing, arguments: x.args }),
      ).rejects.toThrow();
      expect(await ownerCounts(x.f)).toEqual(before);
      expect(
        await fixture.db`select id from allrice_platform_employee_test_runs
      where purpose='method_candidate' and input->>'ownerId'=${x.f.owner.user.id}`,
      ).toHaveLength(0);
      approve();
      await x.testing.finish();
    }, 60000);

    it('revocation after enqueue terminates the method test before its first Run or Job', async () => {
      const x = await candidate();
      const test = await startEmployeeMethodTestFromChat({
        ...x.testing,
        arguments: x.args,
      });
      const frozen = await testRow(test.id);
      await x.testing.finish();
      await fixture.db`update allrice_memberships set active=false
      where organization_id=${x.f.owner.organizationId} and user_id=${x.f.owner.user.id}`;
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      const row = await testRow(test.id);
      expect(row.status).toBe('failed');
      expect(row.output.error.code).toBe('TEST_ENVIRONMENT_UNAVAILABLE');
      expect(await counts(test.id)).toEqual({ runs: 0, jobs: 0 });
      expect(row.native_root_origin).toEqual(frozen.native_root_origin);
      expect(row.native_execution_binding).toEqual(
        frozen.native_execution_binding,
      );
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
    }, 60000);

    it('revocation before first INSERT rejects the issuer even with the original chat capability snapshot', async () => {
      const x = await candidate();
      const before = await ownerCounts(x.f);
      await fixture.db`update allrice_memberships set active=false
      where organization_id=${x.f.owner.organizationId} and user_id=${x.f.owner.user.id}`;
      await expect(
        startEmployeeMethodTestFromChat({ ...x.testing, arguments: x.args }),
      ).rejects.toThrow();
      expect(await ownerCounts(x.f)).toEqual(before);
      expect(
        await fixture.db`select id from allrice_platform_employee_test_runs
      where purpose='method_candidate' and input->>'ownerId'=${x.f.owner.user.id}`,
      ).toHaveLength(0);
      await x.testing.finish();
    }, 60000);
  },
);
