import { sharedHistoryMethodAcceptancePhrases } from './employee-method-shared-history.fixture.ts';
import {
  departmentCommonAcceptancePhrases,
  companyCommonAcceptancePhrases,
} from './employee-method-common.fixture.ts';
import { companyMethodAcceptancePhrases } from './employee-method-company.fixture.ts';
import { selectedDepartmentMethodAcceptancePhrases } from './employee-method-selected-department.fixture.ts';
import { departmentMethodAcceptancePhrases } from './employee-method-department.fixture.ts';
import {
  createOrganizationDepartment,
  updateOrganizationDepartment,
} from '../organization-departments.ts';
import {
  listOrganizationPeople,
  updateOrganizationPerson,
} from '../organization-administration.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  prepareEmployeeMethodActivationFromChat,
  activateEmployeeMethodFromChat,
} from './employee-method-activation.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
} from '../conversation/conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
} from '../conversation/conversation-input.ts';
import {
  claimMethodFileExecution,
  methodFileExecutionUnverified,
} from './employee-method-file-runtime.ts';
import {
  ExecutionContextSchema,
  cloudToolchainImageV1,
  EmployeeContentMutationSchema,
} from '@allrice/contracts';
import {
  createEmployeeMethodFileOperation,
  publishCloudOperationArtifacts,
  loadCloudCommandInputs,
} from '../cloud-execution.ts';
import { assistantFixtureStorage } from '../assistant-runtime.fixture.ts';
import { getStoredFile } from '../data.ts';
import {
  inspectEmployeeMethodFromChat,
  saveEmployeeMethodFromChat,
  restoreEmployeeMethodFromChat,
  filterEmployeeMethodMemories,
} from './employee-method-chat.ts';
import {
  startEmployeeMethodTestFromChat,
  getEmployeeMethodTest,
  employeeMethodTestStillCurrent,
} from './employee-method-tests.ts';
import { freezeRouteSubscriptionSnapshot } from '../execution/route-subscription.ts';
import {
  readPlatformModelSettings,
  updatePlatformModelSettings,
} from '../providers/platform-model-settings.ts';
import { resolveAssistantSubscriptionSnapshot } from '@allrice/contracts';
import {
  prepareEmployeeContentContext,
  assertEmployeeContentContext,
  assertEmployeeContentReferenceMessages,
} from './employee-runtime-content.ts';
import {
  getEmployeeContentSet,
  getEffectiveEmployeeContent,
  getEmployeeContentHistory,
  mutateEmployeeContent,
  mutateEmployeeContentInTransaction,
} from './employee-content.ts';
import type { ContentTx } from './employee-content-model.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  prepareReferenceUpload,
  completeReferenceUpload,
  changeReference,
} from '../reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../reference-processing.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmployeeInstanceProfileSchema } from '@allrice/contracts';
import * as client from '../core/client.ts';
import * as queue from '../execution/queue.ts';
import * as accessCancellation from './employee-access-cancellation.ts';
import { updateEmployeeRelease } from './employee-quality.ts';
import * as folderTriggers from '../folder-triggers.ts';
import {
  createAutomation,
  claimDueAutomations,
} from '../execution/automation.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { assertWorkbenchSession } from '../artifact-review.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { createAssistantLocalCommandFixture } from '../local-command-assistant.fixture.ts';
import { resolveTaskRuntimePolicy } from '../task-runtime-policy.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../identity.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from '../tenant-employees.ts';
import {
  createAssignedChatSession,
  createChatSession,
  createTraceableMemory,
  searchWorkspaceMemories,
  getEmployeeWorkspace,
  listChatSessions,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
  disablePlatformEmployee,
  assignPublishedPlatformEmployeeToWorkspace,
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  listPlatformEmployeeTestRuns,
  listPlatformEmployeeAuditEvents,
} from './platform-employees.ts';
import {
  assertEmployeeInstanceAdmission,
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
  listEmployeeInstances,
  lockEmployeeInstanceAdmissionIdentity,
  prepareEmployeeInstanceSnapshot,
  updateEmployeeInstance,
  updateEmployeeProfileFromChat,
  changeEmployeeInstanceLifecycle,
  getEmployeeInstanceForHistory,
  getEmployeeInstanceHistory,
  listHistoricalEmployeeInstances,
} from './employee-instances.ts';
import {
  manageEmployeeAssignments,
  updateEmployeeStatus,
} from './employeehub.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET179 employee instances (isolated PostgreSQL; no model)', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  async function principal(
    organizationSlug = `instance-${randomUUID()}`,
    role: 'member' | 'admin' = 'member',
  ) {
    const p = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug,
        organizationName: 'Synthetic instance company',
        workspaceSlug: 'default',
        workspaceName: 'Synthetic workspace',
        email: `${randomUUID()}@example.test`,
        displayName: 'Synthetic member',
        role,
      },
      fixture.db,
    );
    const login = await createSession(p.user.id);
    const context = await authenticateSession(login.token, {
      organizationId: p.organizationId,
      workspaceId: p.workspaceId,
    });
    if (!context) throw Error('fixture_login');
    return { ...p, login, context };
  }
  async function setup(profileWrite = false) {
    const slug = `instance-${randomUUID()}`;
    const admin = await principal(undefined, 'admin'),
      a = await principal(slug),
      b = await principal(slug);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
    const source = await createEmployeeAdministrationFixture(fixture.db);
    if (profileWrite)
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
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const entry = async () =>
      (
        await listAdminTenantEmployees(
          admin.context,
          a.organizationId,
          a.workspaceId,
        )
      ).employees.find((e) => e.employeeId === source.employeeId)!;
    const change = async (action: 'assign' | 'withdraw') => {
      const e = await entry();
      return changeAdminTenantEmployee(admin.context, a.organizationId, {
        workspaceId: a.workspaceId,
        employeeId: source.employeeId,
        action,
        revisionId:
          action === 'assign' ? e.revisionId : e.deployment!.revisionId,
        expectedVersion: e.deployment?.version ?? null,
      });
    };
    await change('assign');
    const assignment = (await getEmployeeWorkspace(a.context, a.workspaceId))
      .employees[0]!;
    const bAssignment = (await getEmployeeWorkspace(b.context, b.workspaceId))
      .employees[0]!;
    const input = (name: string) => ({
      workspaceId: a.workspaceId,
      assignmentId: assignment.id,
      requestId: randomUUID(),
      profile: { name },
    });
    const custom = (name: string) =>
      createEmployeeInstance(a.context, input(name));
    const session = (id: string) =>
      createChatSession(a.context, {
        workspaceId: a.workspaceId,
        employeeInstanceId: id,
        title: 'Instance task',
      });
    return {
      admin,
      a,
      b,
      source,
      assignment,
      bAssignment,
      change,
      input,
      custom,
      session,
    };
  }
  async function profileRun(
    f: Awaited<ReturnType<typeof setup>>,
    instanceId: string,
    text: string,
    sessionId?: string,
    referenceRevisionIds?: string[],
  ) {
    const session = sessionId ? { id: sessionId } : await f.session(instanceId);
    const sent = await sendChatMessage(
      f.a.context,
      f.a.workspaceId,
      session.id,
      {
        text,
        clientMessageId: randomUUID(),
        referenceRevisionIds,
        ...(referenceRevisionIds?.length
          ? { deliveryMode: 'follow_up' as const }
          : {}),
      },
    );
    const workerId = randomUUID(),
      leaseToken = randomUUID();
    const [job] =
      await fixture.db`update allrice_jobs set status='claimed',worker_id=${workerId},lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes'
      where run_id=${sent.run.id} returning id`;
    const execution = await queue.startClaimedJob(
      workerId,
      job!.id,
      leaseToken,
    );
    if (!execution) throw new Error('profile fixture failed to start');
    const [row] =
      await fixture.db`select user_message_id,execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
    return {
      context: execution.context,
      sessionId: session.id,
      userMessageId: row!.user_message_id as string,
      worker: { attempt: execution.job.attempt, leaseToken },
      callId: randomUUID(),
      frozen: row!.execution_snapshot,
    };
  }

  async function methodRun(
    f: Awaited<ReturnType<typeof setup>>,
    instanceId: string,
    text = '请保存我的工作场景候选：每周对账和每月对账，保留原始数据。',
    sessionId?: string,
    referenceRevisionIds?: string[],
  ) {
    const input = await profileRun(
      f,
      instanceId,
      text,
      sessionId,
      referenceRevisionIds,
    );
    const scope = {
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      ownerId: f.a.user.id,
      sessionId: input.sessionId,
      runId: input.context.runId,
    };
    const runtime = await prepareEmployeeContentContext(scope);
    expect(runtime).not.toBeNull();
    const finish = async () => {
      await fixture.db`update allrice_jobs set status='succeeded',completed_at=now() where run_id=${scope.runId}`;
      await fixture.db`update allrice_runs set state='succeeded',completed_at=now() where id=${scope.runId}`;
      await fixture.db`update allrice_employee_runs set status='succeeded',completed_at=now() where run_id=${scope.runId}`;
    };
    return { ...input, scope, runtime: runtime!, finish };
  }
  it('freezes sandbox caps per new Run in the same session without rewriting old execution snapshots', async () => {
    const f = await setup(),
      instance = await f.custom('Sandbox budget fixture');
    const first = await methodRun(f, instance.id, 'Synthetic first task');
    expect(first.frozen.sandboxExecutionPolicy).toEqual({
      version: 1,
      maxExecutionMs: 600000,
      sources: [],
    });
    const frozenBytes = JSON.stringify(first.frozen);
    await first.finish();
    await fixture.db`insert into allrice_model_resource_limits(id,organization_id,scope_type,scope_id,monthly_run_limit,monthly_token_limit,concurrent_run_limit,max_runtime_ms,max_sandbox_execution_ms)
      values(${randomUUID()},${f.a.organizationId},'user',${f.a.user.id},2000,2000000,3,0,1800000)`;
    const second = await methodRun(
      f,
      instance.id,
      'Synthetic second task',
      first.sessionId,
    );
    expect(second.frozen.sandboxExecutionPolicy.maxExecutionMs).toBe(1800000);
    expect(second.frozen.taskRuntimePolicy.timeoutMs).toBe(0);
    const [old] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${first.context.runId}`;
    expect(JSON.stringify(old!.execution_snapshot)).toBe(frozenBytes);
    await second.finish();
  });

  async function departmentFixture(f: Awaited<ReturnType<typeof setup>>) {
    const department = (
      await createOrganizationDepartment(f.admin.context, f.a.organizationId, {
        name: '验收财务部',
        requestId: randomUUID(),
      })
    ).department;
    const other = (
      await createOrganizationDepartment(f.admin.context, f.a.organizationId, {
        name: '验收运营部',
        requestId: randomUUID(),
      })
    ).department;
    const configure = async (
      userId: string,
      departmentId: string | null,
      level: 'personal' | 'department' | 'company',
    ) => {
      const person = (
        await listOrganizationPeople(f.admin.context, f.a.organizationId)
      ).people.find((p) => p.userId === userId)!;
      return updateOrganizationPerson(
        f.admin.context,
        f.a.organizationId,
        userId,
        {
          username: person.username ?? `dept-${userId.slice(0, 8)}`,
          displayName: person.displayName,
          jobTitle: person.jobTitle,
          responsibilities: person.responsibilities,
          departmentId,
          contentMaintenanceLevel: level,
          expectedVersion: person.version,
        },
      );
    };
    await configure(f.a.user.id, department.id, 'department');
    await configure(f.b.user.id, department.id, 'personal');
    return { department, other, configure };
  }
  async function retryFixture(
    caseId = 'cny-total-v1',
    inheritedCommon = false,
    department: boolean | 'company' | 'selected' = false,
  ) {
    const f = await setup(true),
      instance = await f.custom('重试测试');
    const departmentInfo = department ? await departmentFixture(f) : undefined;
    const sharedScope = department === 'company' ? 'company' : 'department';
    const phrases =
      department === 'company'
        ? companyMethodAcceptancePhrases
        : department === 'selected'
          ? selectedDepartmentMethodAcceptancePhrases(
              departmentInfo!.other.name,
            )
          : departmentMethodAcceptancePhrases;
    if (department === 'selected')
      await departmentInfo!.configure(
        f.a.user.id,
        departmentInfo!.department.id,
        'company',
      );
    if (department === 'company') {
      await departmentInfo!.configure(
        f.a.user.id,
        departmentInfo!.department.id,
        'company',
      );
      // A real active department requirement must never enter a company test.
      const [assignment] =
        await fixture.db`select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`;
      const textId = randomUUID();
      const base = {
        workspaceId: f.a.workspaceId,
        setId: randomUUID(),
        ownership: {
          scope: 'department',
          organizationId: f.a.organizationId,
          departmentId: departmentInfo!.department.id,
        },
        target: { kind: 'employee', employeeId: assignment!.employee_id },
        changeSummary: 'Existing department requirement',
      };
      const saved = await mutateEmployeeContent(f.a.context, {
        ...base,
        operation: 'save_draft',
        expectedRevision: 0,
        requestId: randomUUID(),
        textEdits: [
          {
            contentId: textId,
            revisionId: randomUUID(),
            expectedRevision: 0,
            kind: 'requirement',
            title: 'Department only',
            body: 'DEPARTMENT-ONLY-MUST-NOT-ENTER-COMPANY-TEST',
          },
        ],
        manifest: {
          schemaVersion: 1,
          common: [{ sourceKind: 'draft_text', contentId: textId }],
          scenes: [],
          declaredConflicts: [],
        },
      });
      const pin = {
        candidateRevisionId: saved.candidate.id,
        candidateDigest: saved.candidate.digest,
      };
      const validated = await mutateEmployeeContent(f.a.context, {
        ...base,
        ...pin,
        operation: 'validate',
        expectedRevision: saved.revision,
        requestId: randomUUID(),
      });
      await mutateEmployeeContent(f.a.context, {
        ...base,
        ...pin,
        operation: 'activate',
        expectedRevision: validated.revision,
        requestId: randomUUID(),
      });
    }
    if (inheritedCommon) {
      // Trusted, pre-existing company configuration; no product write bypass.
      const setId = randomUUID(),
        revisionId = randomUUID(),
        sceneId = randomUUID();
      const manifest = {
        schemaVersion: 1,
        common: [],
        scenes: [
          {
            id: sceneId,
            name: '公司继承场景',
            appliesWhen: '固定合成业务',
            references: [],
          },
        ],
        declaredConflicts: [],
      };
      const [assignment] =
        await fixture.db`select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`;
      await fixture.db`insert into allrice_employee_content_sets(id,organization_id,workspace_id,employee_id,scope,created_by)
        values(${setId},${f.a.organizationId},${f.a.workspaceId},${assignment!.employee_id},'company',${f.a.user.id})`;
      await fixture.db`insert into allrice_employee_content_revisions(id,set_id,number,manifest,digest,change_summary,created_by)
        values(${revisionId},${setId},1,${fixture.db.json(manifest)},${runtimePolicyDigest(manifest)},'Pre-existing synthetic company scene',${f.a.user.id})`;
      await fixture.db`update allrice_employee_content_sets set revision=1,candidate_revision_id=${revisionId},active_revision_id=${revisionId} where id=${setId}`;
      await fixture.db`insert into allrice_employee_content_publications(set_id,revision_id) values(${setId},${revisionId})`;
    }
    if (department) {
      const privateRun = await methodRun(f, instance.id);
      const own = await saveEmployeeMethodFromChat({
        ...privateRun,
        arguments: {
          expectedRevision: 0,
          section: 'scene',
          scene: { name: '私有机密', appliesWhen: 'Private' },
          procedure: 'PRIVATE-CONTENT-MUST-NOT-ENTER-SHARED-TEST',
          changeSummary: 'Private fixture',
        },
      });
      const base = {
        workspaceId: f.a.workspaceId,
        setId: own.setId,
        ownership: {
          scope: 'personal',
          organizationId: f.a.organizationId,
          ownerId: f.a.user.id,
        },
        target: { kind: 'instance', instanceId: instance.id },
        candidateRevisionId: own.candidate.id,
        candidateDigest: own.candidate.digest,
        changeSummary: 'Pre-existing effective personal method',
      };
      const validated = await mutateEmployeeContent(f.a.context, {
        ...base,
        operation: 'validate',
        expectedRevision: own.revision,
        requestId: randomUUID(),
      });
      await mutateEmployeeContent(f.a.context, {
        ...base,
        operation: 'activate',
        expectedRevision: validated.revision,
        requestId: randomUUID(),
      });
      await privateRun.finish();
    }
    if (caseId === 'cny-file-flow-v1') await methodFileCloud(f);
    const editing = await methodRun(
      f,
      instance.id,
      department ? phrases.save : undefined,
    );
    const inspected = department
      ? await inspectEmployeeMethodFromChat({
          ...editing,
          arguments: {
            view: 'candidate',
            scope: sharedScope,
            ...(department === 'selected'
              ? { departmentId: departmentInfo!.other.id }
              : {}),
          },
        })
      : undefined;
    const shared =
      inspected && 'sharedTarget' in inspected && inspected.sharedTarget
        ? { sharedTarget: inspected.sharedTarget }
        : {};
    let saved = await saveEmployeeMethodFromChat({
      ...editing,
      arguments: {
        ...shared,
        expectedRevision: 0,
        section: 'scene',
        scene: {
          name: department ? '金额合计' : '金额汇总',
          appliesWhen: '固定合成数据',
        },
        procedure: '只将整数分相加',
        changeSummary: '重试边界样例',
      },
    });
    await editing.finish();
    if (inheritedCommon) {
      const commonRun = await methodRun(
        f,
        instance.id,
        department
          ? departmentCommonAcceptancePhrases(
              (department === 'selected'
                ? departmentInfo!.other
                : departmentInfo!.department
              ).name,
            ).correct
          : '请保存我的通用执行要求：所有场景均增加固定校验。',
      );
      saved = await saveEmployeeMethodFromChat({
        ...commonRun,
        callId: randomUUID(),
        arguments: {
          ...shared,
          expectedRevision: saved.revision,
          section: 'common',
          requirements: '所有场景均增加固定校验',
          changeSummary: '改变通用要求',
        },
      });
      await commonRun.finish();
    }
    const content = await getEmployeeContentSet(f.a.context, saved.setId);
    const testingText =
      inheritedCommon && department
        ? departmentCommonAcceptancePhrases(
            (department === 'selected'
              ? departmentInfo!.other
              : departmentInfo!.department
            ).name,
          ).test
        : department
          ? phrases.test
          : '请测试我的工作场景候选：金额汇总。';
    const run = await methodRun(f, instance.id, testingText);
    const plan =
      inheritedCommon && department
        ? await inspectEmployeeMethodFromChat({
            ...run,
            arguments: { view: 'candidate', scope: 'department' },
          })
        : undefined;
    const coverage =
      plan && 'testCoverage' in plan ? plan.testCoverage : undefined;
    if (inheritedCommon && department) expect(coverage?.valid).toBe(true);
    const args = {
      ...shared,
      expectedRevision: saved.revision,
      candidateRevisionId: saved.candidate.id,
      candidateDigest: saved.candidate.digest,
      ...(coverage ? { coverageDigest: coverage.digest } : {}),
      sceneId: content.set.candidate!.manifest.scenes[0]!.id,
      caseId,
    };
    const test = await startEmployeeMethodTestFromChat({
      ...run,
      arguments: args,
    });
    await run.finish();
    const fail = async (id: string) => {
      await completePlatformEmployeeTestRun(id, {
        answer: null,
        provider: null,
        model: null,
        threadId: null,
        usage: null,
        events: [],
        error: {
          code: 'DSH_TRANSPORT',
          message: 'Synthetic interrupted response',
        },
        modelExecution: {
          dispatched: true,
          subscriptionSnapshotCreated: false,
          usageComplete: false,
          cacheUsageKnown: false,
          costCents: null,
        },
      });
    };
    return {
      f,
      instance,
      saved,
      args,
      run,
      test,
      fail,
      departmentInfo,
      coverage,
    };
  }

  async function claimActivationTest(
    f: Awaited<ReturnType<typeof setup>>,
    test: { id: string },
  ) {
    const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim?.id).toBe(test.id);
    const method = claim!.methodCandidate!;
    if (!method.modelSnapshot.credentialReference)
      throw Error('fixture credential missing');
    const subscription = resolveAssistantSubscriptionSnapshot({
      sessionId: method.sourceSessionId,
      modelSnapshot: method.modelSnapshot,
      decision: method.decision,
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: method.modelSnapshot.model,
        reasoningEffort: method.modelSnapshot.reasoningEffort,
        credentialReference: method.modelSnapshot.credentialReference,
        baseUrl: null,
      },
    });
    await freezeRouteSubscriptionSnapshot({
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      decisionId: method.decision.id,
      snapshot: subscription!,
    });
    return method;
  }

  async function passActivationTest(
    f: Awaited<ReturnType<typeof setup>>,
    test: { id: string },
  ) {
    const method = await claimActivationTest(f, test);
    await completePlatformEmployeeTestRun(test.id, {
      answer: '{"totalCents":30000}',
      provider: method.modelSnapshot.provider,
      model: method.modelSnapshot.model,
      threadId: null,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
      events: [],
      error: null,
      modelExecution: {
        dispatched: true,
        subscriptionSnapshotCreated: true,
        usageComplete: true,
        cacheUsageKnown: false,
        costCents: null,
      },
    });
  }
  async function activationFixture(
    department: boolean | 'company' | 'selected' = false,
    inheritedCommon = false,
    companyCommon: boolean | 'max' = false,
  ) {
    const base = companyCommon
      ? await companyCommonFixture(companyCommon === 'max')
      : await retryFixture('cny-total-v1', inheritedCommon, department);
    const { f, instance, args, test } = base;
    if (department === 'company')
      await base.departmentInfo!.configure(f.a.user.id, null, 'company');
    await passActivationTest(f, test);
    const testIds = [test.id];
    for (const scene of base.coverage?.scenes ?? []) {
      if (
        scene.sceneId === args.sceneId &&
        runtimePolicyDigest(scene.executionView ?? null) ===
          runtimePolicyDigest(
            'executionView' in args ? args.executionView : null,
          )
      )
        continue;
      const testing = await methodRun(
        f,
        instance.id,
        companyCommon
          ? companyCommonAcceptancePhrases.test
          : departmentCommonAcceptancePhrases(
              base.departmentInfo!.department.name,
            ).test,
      );
      const inheritedTest = await startEmployeeMethodTestFromChat({
        ...testing,
        arguments: {
          ...args,
          sceneId: scene.sceneId,
          ...(scene.executionView
            ? { executionView: scene.executionView }
            : {}),
        },
      });
      await testing.finish();
      await passActivationTest(f, inheritedTest);
      testIds.push(inheritedTest.id);
    }
    const run = await methodRun(
      f,
      instance.id,
      companyCommon
        ? companyCommonAcceptancePhrases.confirm
        : department
          ? (department === 'company'
              ? companyMethodAcceptancePhrases
              : department === 'selected'
                ? selectedDepartmentMethodAcceptancePhrases(
                    base.departmentInfo!.other.name,
                  )
                : departmentMethodAcceptancePhrases
            ).confirm
          : '请查看通过的测试并让我确认启用。',
    );
    const inspected = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: {
        view: 'candidate',
        ...(department
          ? { scope: department === 'company' ? 'company' : 'department' }
          : {}),
        ...(department === 'selected'
          ? { departmentId: base.departmentInfo!.other.id }
          : {}),
      },
    });
    expect('candidateTests' in inspected && inspected.candidateTests).toEqual(
      expect.arrayContaining([expect.objectContaining({ testId: test.id })]),
    );
    const preparation = {
      ...(args.sharedTarget ? { sharedTarget: args.sharedTarget } : {}),
      expectedRevision: args.expectedRevision,
      candidateRevisionId: args.candidateRevisionId,
      candidateDigest: args.candidateDigest,
      testIds,
    };
    const preview = await prepareEmployeeMethodActivationFromChat({
      ...run,
      arguments: preparation,
    });
    const runtime = {
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      sessionId: run.sessionId,
      ownerId: f.a.user.id,
      runId: run.context.runId,
      workerId: run.context.worker.id,
    };
    await acquireConversationRuntime({
      ...runtime,
      configChecksum: `sha256:${'a'.repeat(64)}`,
      compactThresholdTokens: 10000,
    });
    const threadId = `native-${randomUUID()}`,
      turnId = `turn-${randomUUID()}`;
    await bindConversationThread({ ...runtime, threadId });
    const binding = await recordConversationTurn({
      ...runtime,
      threadId,
      turnId,
    });
    const questionId = `question-${randomUUID()}`;
    const show = (question = preview.question) =>
      queue.appendJobEvent({
        workerId: run.context.worker.id,
        jobId: run.context.jobId,
        leaseToken: run.worker.leaseToken,
        type: 'harness.native',
        payload: {
          source: 'dsh',
          sourceEventType: 'session/user-question',
          nativePayload: { questionId, questions: [question] },
        },
      });
    const answer = async (
      selected = ['确认启用'],
      custom?: string,
      adopt = true,
    ) => {
      const clientMessageId = randomUUID();
      await sendChatMessage(f.a.context, f.a.workspaceId, run.sessionId, {
        text: custom ?? selected.join('，'),
        clientMessageId,
        deliveryMode: 'steer',
        expectedTurnId: turnId,
        expectedGeneration: binding.generation,
        userQuestionAnswer: {
          questionId,
          answers: [
            {
              id: preview.question.id,
              selected,
              ...(custom ? { custom } : {}),
            },
          ],
        },
      });
      const command = await claimConversationSteer({
        ...runtime,
        generation: binding.generation,
        turnId,
      });
      expect(command).not.toBeNull();
      const proof = {
        status: 'adopted' as const,
        inputId: clientMessageId,
        messageId: questionId,
        turnId,
        sequence: 5,
        checkpoint: 'question_resolved' as const,
      };
      if (adopt)
        await consumeConversationSteer({
          commandId: command!.id,
          workerId: runtime.workerId,
          proof,
        });
      return { command: command!, proof };
    };
    const activate = (call = run) =>
      activateEmployeeMethodFromChat({
        ...call,
        callId: randomUUID(),
        arguments: { receiptId: preview.receiptId },
      });
    return {
      ...base,
      run,
      preparation,
      preview,
      runtime,
      threadId,
      turnId,
      show,
      answer,
      activate,
    };
  }

  async function publishDepartmentOverlay(
    x: Awaited<ReturnType<typeof retryFixture>>,
    departmentId: string,
    count = 1,
    tx?: ContentTx,
  ) {
    const sql = tx ?? fixture.db;
    const mutate = (input: unknown) =>
      tx
        ? mutateEmployeeContentInTransaction(
            x.f.a.context,
            EmployeeContentMutationSchema.parse(input),
            tx,
          )
        : mutateEmployeeContent(x.f.a.context, input);
    const [assignment] =
      await sql`select employee_id from allrice_employee_assignments where id=${x.instance.assignmentId}`;
    const [old] =
      await sql`select s.*, r.manifest from allrice_employee_content_sets s
      left join allrice_employee_content_revisions r on r.id=s.active_revision_id
      where s.organization_id=${x.f.a.organizationId} and s.workspace_id=${x.f.a.workspaceId}
        and s.scope='department' and s.department_id=${departmentId} and s.employee_id=${assignment!.employee_id}`;
    const base = {
      workspaceId: x.f.a.workspaceId,
      setId: old?.id ?? randomUUID(),
      ownership: {
        scope: 'department',
        organizationId: x.f.a.organizationId,
        departmentId,
      },
      target: { kind: 'employee', employeeId: assignment!.employee_id },
      changeSummary: 'Existing departmental overlay',
    };
    const saved = await mutate({
      ...base,
      operation: 'save_draft',
      expectedRevision: old?.revision ?? 0,
      requestId: randomUUID(),
      textEdits: [],
      manifest: {
        schemaVersion: 1,
        common: old?.manifest?.common ?? [],
        declaredConflicts: [],
        scenes: Array.from({ length: count }, (_, i) => ({
          id: randomUUID(),
          name: `部门独有金额场景 ${i + 1}`,
          appliesWhen: 'Synthetic fixed cents',
          references: [],
        })),
      },
    });
    const pin = {
      candidateRevisionId: saved.candidate.id,
      candidateDigest: saved.candidate.digest,
    };
    const validated = await mutate({
      ...base,
      ...pin,
      operation: 'validate',
      expectedRevision: saved.revision,
      requestId: randomUUID(),
    });
    await mutate({
      ...base,
      ...pin,
      operation: 'activate',
      expectedRevision: validated.revision,
      requestId: randomUUID(),
    });
    return saved;
  }

  async function companyCommonFixture(full32 = false) {
    const base = await retryFixture('cny-total-v1', false, 'company');
    await passActivationTest(base.f, base.test);
    if (full32) {
      const content = await getEmployeeContentSet(
        base.f.a.context,
        base.saved.setId,
      );
      const manifest = content.set.candidate!.manifest;
      base.saved = await mutateEmployeeContent(base.f.a.context, {
        workspaceId: base.f.a.workspaceId,
        setId: base.saved.setId,
        ownership: {
          scope: 'company',
          organizationId: base.f.a.organizationId,
        },
        target: {
          kind: 'employee',
          employeeId: base.args.sharedTarget!.employeeId,
        },
        operation: 'save_draft',
        requestId: randomUUID(),
        expectedRevision: base.saved.revision,
        changeSummary: 'Maximum complete coverage fixture',
        textEdits: [],
        manifest: {
          ...manifest,
          scenes: Array.from({ length: 16 }, (_, i) => ({
            ...manifest.scenes[0]!,
            id: i ? randomUUID() : base.args.sceneId,
            name: `${i + 1}：${'完整长名称金额场景'.repeat(5)}`,
          })),
        },
      });
    }
    await publishDepartmentOverlay(
      base,
      base.departmentInfo!.department.id,
      full32 ? 0 : 1,
    );
    if (!full32)
      await publishDepartmentOverlay(base, base.departmentInfo!.other.id);
    const edit = await methodRun(
      base.f,
      base.instance.id,
      companyCommonAcceptancePhrases.save,
    );
    const saved = await saveEmployeeMethodFromChat({
      ...edit,
      arguments: {
        sharedTarget: base.args.sharedTarget,
        expectedRevision: base.saved.revision,
        section: 'common',
        requirements:
          '金额一律使用人民币整数分；只将输入金额相加，不增加其他金额。' +
          (full32 ? '保留依据及原始记录。'.repeat(160) : ''),
        changeSummary: 'Company requirements for all shared execution views',
      },
    });
    await edit.finish();
    const run = await methodRun(
      base.f,
      base.instance.id,
      companyCommonAcceptancePhrases.test,
    );
    const plan = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate', scope: 'company' },
    });
    if (!('testCoverage' in plan) || !plan.testCoverage)
      throw Error('company coverage missing');
    const coverage = plan.testCoverage;
    expect(coverage.valid).toBe(true);
    expect(coverage.scenes).toHaveLength(full32 ? 32 : 5);
    const args = {
      ...base.args,
      expectedRevision: saved.revision,
      candidateRevisionId: saved.candidate.id,
      candidateDigest: saved.candidate.digest,
      coverageDigest: coverage.digest,
      executionView: { scope: 'company' as const },
    };
    const test = await startEmployeeMethodTestFromChat({
      ...run,
      arguments: args,
    });
    await run.finish();
    return { ...base, saved, args, run, test, coverage };
  }

  it.each(['passed', 'mismatch', 'execution_failed'] as const)(
    'method test result stays coherent when %s finalization commits during its read',
    async (outcome) => {
      const x = await companyCommonFixture();
      const method = await claimActivationTest(x.f, x.test);
      const before = await getEmployeeMethodTest(x.f.a.context, x.test.id);
      expect(before.status).toBe('running');
      expect(before.assertion).toBeNull();
      let locked!: (pid: number) => void, release!: () => void;
      const ready = new Promise<number>((resolve) => {
        locked = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = fixture.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${x.f.a.organizationId}`},0))`;
        const [row] = await tx`select pg_backend_pid() pid`;
        locked(row!.pid);
        await proceed;
      });
      void gate.catch(() => undefined);
      const pid = await ready;
      // The current-content gate is reached after reading the method binding,
      // before reading the platform test status. Finalize through the real
      // atomic writer while this GET is paused between those reads.
      const reading = getEmployeeMethodTest(x.f.a.context, x.test.id);
      void reading.catch(() => undefined);
      try {
        await expect
          .poll(
            async () => {
              const [row] =
                await fixture.db`select count(*)::int n from pg_stat_activity where datname=current_database() and ${pid}::int=any(pg_blocking_pids(pid))`;
              return row!.n;
            },
            { timeout: 3000, interval: 20 },
          )
          .toBeGreaterThan(0);
        await completePlatformEmployeeTestRun(x.test.id, {
          answer:
            outcome === 'execution_failed'
              ? null
              : JSON.stringify({
                  totalCents: outcome === 'passed' ? 30000 : 30100,
                }),
          provider: method.modelSnapshot.provider,
          model: method.modelSnapshot.model,
          threadId: null,
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
          events: [],
          error:
            outcome === 'execution_failed'
              ? {
                  code: 'DSH_TRANSPORT',
                  message: 'Synthetic execution failure',
                }
              : null,
          modelExecution: {
            dispatched: true,
            subscriptionSnapshotCreated: true,
            usageComplete: true,
            cacheUsageKnown: false,
            costCents: null,
          },
        });
      } finally {
        release();
        await gate;
      }
      const result = await reading;
      expect(result).toMatchObject({
        status: outcome === 'execution_failed' ? 'failed' : 'succeeded',
        validationStatus:
          outcome === 'execution_failed'
            ? 'not_verified'
            : outcome === 'passed'
              ? 'passed'
              : 'failed',
        runId: before.runId,
        coverageDigest: x.coverage.digest,
        executionView: x.test.executionView,
        sharedTarget: x.test.sharedTarget,
        assertion: {
          passed: outcome === 'passed',
          actual:
            outcome === 'execution_failed'
              ? null
              : outcome === 'passed'
                ? 30000
                : 30100,
        },
      });
      expect(result.completedAt).not.toBeNull();
    },
    60000,
  );

  it('company common maximum coverage keeps all 32 proofs in a bounded exact confirmation detail', async () => {
    const x = await activationFixture('company', false, 'max');
    expect(x.preparation.testIds).toHaveLength(32);
    expect(x.preview.question.question.length).toBeLessThanOrEqual(4000);
    expect(x.preview.question.detail!.length).toBeLessThanOrEqual(20000);
    for (const scene of x.coverage!.scenes)
      expect(x.preview.question.detail).toContain(scene.sceneId);
    await x.show();
    await x.answer();
    expect((await x.activate()).enabled).toBe(true);
    await x.run.finish();
  }, 120000);

  it.each(['scenes', 'views'] as const)(
    'company common coverage overflow in %s rejects the complete plan without queuing partial paid tests',
    async (kind) => {
      const x = await companyCommonFixture(kind === 'scenes');
      await passActivationTest(x.f, x.test);
      if (kind === 'scenes')
        await publishDepartmentOverlay(x, x.departmentInfo!.other.id, 0);
      else
        for (let i = 0; i < 30; i++) {
          const d = (
            await createOrganizationDepartment(
              x.f.admin.context,
              x.f.a.organizationId,
              { name: `上限测试部门 ${i}`, requestId: randomUUID() },
            )
          ).department;
          await publishDepartmentOverlay(x, d.id, 0);
        }
      const run = await methodRun(
        x.f,
        x.instance.id,
        companyCommonAcceptancePhrases.test,
      );
      const plan = await inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'candidate', scope: 'company' },
      });
      expect('testCoverage' in plan && plan.testCoverage).toMatchObject({
        valid: false,
        scenes: [],
        issues: expect.arrayContaining([expect.stringContaining('32')]),
      });
      const before =
        await fixture.db`select test_id from allrice_employee_method_tests where instance_id=${x.instance.id}`;
      await expect(
        startEmployeeMethodTestFromChat({ ...run, arguments: x.args }),
      ).rejects.toThrow('validation_failed');
      expect(
        await fixture.db`select test_id from allrice_employee_method_tests where instance_id=${x.instance.id}`,
      ).toEqual(before);
      await run.finish();
    },
    60000,
  );

  it('company common activation serializes behind a concurrent new department publication and rejects stale coverage', async () => {
    const x = await activationFixture('company', false, true);
    await x.show();
    await x.answer();
    const added = (
      await createOrganizationDepartment(
        x.f.admin.context,
        x.f.a.organizationId,
        { name: '并发新增部门', requestId: randomUUID() },
      )
    ).department;
    let locked!: (pid: number) => void, release!: () => void;
    const ready = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publication = fixture.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${x.f.a.organizationId}`},0))`;
      const [row] = await tx`select pg_backend_pid() pid`;
      locked(row!.pid);
      await proceed;
      await publishDepartmentOverlay(x, added.id, 1, tx);
    });
    void publication.catch(() => undefined);
    const pid = await ready,
      activation = x.activate();
    void activation.catch(() => undefined);
    try {
      await expect
        .poll(
          async () => {
            const [row] =
              await fixture.db`select count(*)::int n from pg_stat_activity where datname=current_database() and ${pid}::int=any(pg_blocking_pids(pid))`;
            return row!.n;
          },
          { timeout: 3000, interval: 20 },
        )
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    await publication;
    await expect(activation).rejects.toThrow('validation_required');
    expect(
      (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
    ).toBeNull();
    await x.run.finish();
  }, 60000);

  it('candidate test pagination is exact at sub-millisecond timestamps and rejects foreign or stale candidate anchors', async () => {
    const x = await companyCommonFixture();
    await passActivationTest(x.f, x.test);
    const [method] =
      await fixture.db`select to_jsonb(t) data from allrice_employee_method_tests t where test_id=${x.test.id}`;
    const [platform] =
      await fixture.db`select to_jsonb(t) data from allrice_platform_employee_test_runs t where id=${x.test.id}`;
    const clone = async (owner = x.f.a.user.id, index = 0) => {
      const id = randomUUID(),
        requestId = randomUUID();
      const created = `2027-01-01T00:00:00.${index % 2 ? '000001' : '000002'}Z`;
      // Synthetic persisted history, not extra executions. All rows remain in
      // this isolated schema; copying complete records preserves table invariants.
      await fixture.db`insert into allrice_platform_employee_test_runs select (jsonb_populate_record(null::allrice_platform_employee_test_runs,${fixture.db.json({ ...platform!.data, id, created_at: created })})).*`;
      await fixture.db`insert into allrice_employee_method_tests select (jsonb_populate_record(null::allrice_employee_method_tests,${fixture.db.json({ ...method!.data, test_id: id, owner_id: owner, request_id: requestId, binding_digest: `synthetic:${id}`, created_at: created, run_id: null, route_decision_id: null })})).*`;
      return id;
    };
    for (let i = 0; i < 35; i++) await clone(x.f.a.user.id, i);
    const foreign = await clone(x.f.b.user.id);
    const run = await methodRun(x.f, x.instance.id, '请查看公司候选测试记录。');
    const first = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate', scope: 'company' },
    });
    if (!('candidateTests' in first)) throw Error('tests missing');
    expect(first.candidateTests).toHaveLength(32);
    expect(first.candidateTests[0]).toMatchObject({
      executionView: { scope: 'company' },
      coverageDigest: x.coverage.digest,
    });
    const second = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: {
        view: 'candidate',
        scope: 'company',
        beforeTestId: first.nextBeforeTestId,
      },
    });
    if (!('candidateTests' in second)) throw Error('second page missing');
    expect(second.nextBeforeTestId).toBeNull();
    const expected =
      await fixture.db`select test_id from allrice_employee_method_tests where instance_id=${x.instance.id} and owner_id=${x.f.a.user.id} and candidate_revision_id=${x.saved.candidate.id} order by created_at desc,test_id desc`;
    expect(
      [...first.candidateTests, ...second.candidateTests].map((t) => t.testId),
    ).toEqual(expected.map((t) => t.test_id));
    const [old] =
      await fixture.db`select test_id from allrice_employee_method_tests where instance_id=${x.instance.id} and candidate_revision_id<>${x.saved.candidate.id} limit 1`;
    for (const beforeTestId of [foreign, old!.test_id, randomUUID()])
      await expect(
        inspectEmployeeMethodFromChat({
          ...run,
          arguments: { view: 'candidate', scope: 'company', beforeTestId },
        }),
      ).rejects.toThrow('not_found');
    await run.finish();
  }, 60000);

  it.each(['rename', 'archive', 'withdraw-source', 'downgrade'] as const)(
    'company common evidence rechecks a covered department change: %s',
    async (change) => {
      const x = await companyCommonFixture();
      await passActivationTest(x.f, x.test);
      if (change === 'rename' || change === 'archive') {
        const target = x.departmentInfo!.other;
        await updateOrganizationDepartment(
          x.f.admin.context,
          x.f.a.organizationId,
          target.id,
          {
            expectedRevision: target.revision,
            name: change === 'rename' ? '改名后的运营部' : target.name,
            active: change !== 'archive',
          },
        );
      } else if (change === 'withdraw-source') {
        await fixture.db`update allrice_company_assets set state='archived' where organization_id=${x.f.a.organizationId} and content_scope='department'`;
      } else
        await x.departmentInfo!.configure(
          x.f.a.user.id,
          x.departmentInfo!.department.id,
          'department',
        );
      if (change === 'downgrade')
        await expect(
          getEmployeeMethodTest(x.f.a.context, x.test.id),
        ).rejects.toThrow('authorization_denied');
      else
        expect(
          (await getEmployeeMethodTest(x.f.a.context, x.test.id)).applicable,
        ).toBe(false);
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
      ).toBeNull();
    },
    60000,
  );

  it('company common coverage keeps an empty base view without inventing a test and rejects a globally empty plan', async () => {
    const x = await companyCommonFixture();
    await passActivationTest(x.f, x.test);
    const edit = await methodRun(
      x.f,
      x.instance.id,
      '请移除公司的“金额合计”工作场景。',
    );
    const saved = await saveEmployeeMethodFromChat({
      ...edit,
      arguments: {
        sharedTarget: x.args.sharedTarget,
        expectedRevision: x.saved.revision,
        section: 'scene',
        operation: 'remove_scene',
        scene: { id: x.args.sceneId },
        changeSummary: 'Only department scenes remain',
      },
    });
    await edit.finish();
    const run = await methodRun(
      x.f,
      x.instance.id,
      companyCommonAcceptancePhrases.test,
    );
    const plan = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate', scope: 'company' },
    });
    if (!('testCoverage' in plan) || !plan.testCoverage)
      throw Error('coverage missing');
    expect(plan.testCoverage).toMatchObject({
      valid: true,
      views: expect.arrayContaining([
        expect.objectContaining({
          executionView: { scope: 'company' },
          sceneIds: [],
        }),
      ]),
    });
    expect(plan.testCoverage.scenes).toHaveLength(2);
    await run.finish();
    const ids: string[] = [];
    for (const scene of plan.testCoverage.scenes) {
      const testing = await methodRun(
        x.f,
        x.instance.id,
        companyCommonAcceptancePhrases.test,
      );
      const test = await startEmployeeMethodTestFromChat({
        ...testing,
        callId: randomUUID(),
        arguments: {
          ...x.args,
          expectedRevision: saved.revision,
          candidateRevisionId: saved.candidate.id,
          candidateDigest: saved.candidate.digest,
          sceneId: scene.sceneId,
          executionView: scene.executionView,
          coverageDigest: plan.testCoverage.digest,
        },
      });
      await testing.finish();
      await passActivationTest(x.f, test);
      ids.push(test.id);
    }
    const confirm = await methodRun(
      x.f,
      x.instance.id,
      companyCommonAcceptancePhrases.confirm,
    );
    const prepared = await prepareEmployeeMethodActivationFromChat({
      ...confirm,
      callId: randomUUID(),
      arguments: {
        sharedTarget: x.args.sharedTarget,
        expectedRevision: saved.revision,
        candidateRevisionId: saved.candidate.id,
        candidateDigest: saved.candidate.digest,
        testIds: ids,
      },
    });
    expect(prepared.question.detail).toContain('无独有或继承场景');
    await publishDepartmentOverlay(x, x.departmentInfo!.department.id, 0);
    await publishDepartmentOverlay(x, x.departmentInfo!.other.id, 0);
    const empty = await inspectEmployeeMethodFromChat({
      ...confirm,
      arguments: { view: 'candidate', scope: 'company' },
    });
    expect('testCoverage' in empty && empty.testCoverage).toMatchObject({
      valid: false,
      scenes: [],
    });
    await confirm.finish();
  }, 60000);

  it('company common requirements validate every execution view before exact confirmation and fresh department adoption', async () => {
    const x = await activationFixture('company', false, true);
    expect(x.coverage?.views).toHaveLength(3);
    expect(x.preparation.testIds).toHaveLength(5);
    expect(
      x.coverage?.scenes.filter((s) => s.sceneId === x.args.sceneId),
    ).toHaveLength(3);
    const bindings =
      await fixture.db`select candidate_snapshot from allrice_employee_method_tests where test_id=any(${x.preparation.testIds}::uuid[])`;
    for (const { candidate_snapshot: binding } of bindings) {
      expect(binding.content.sharedTarget.scope).toBe('company');
      expect(JSON.stringify(binding.content)).not.toContain('PRIVATE-CONTENT');
      const bodies = binding.content.sources.map(
        (s: { body?: string }) => s.body,
      );
      expect(bodies.join('\n')).toContain('金额一律使用人民币整数分');
      if (
        binding.content.executionView.departmentId ===
        x.departmentInfo!.department.id
      ) {
        expect(bodies.join('\n')).toContain('DEPARTMENT-ONLY');
        expect(
          binding.content.sources.find(
            (s: { reference: { revisionId: string } }) =>
              s.reference.revisionId === binding.content.common[0].revisionId,
          ).body,
        ).toContain('金额一律使用人民币整数分');
      } else expect(bodies.join('\n')).not.toContain('DEPARTMENT-ONLY');
    }
    expect(x.preview.question.question).toContain(
      '公司基础及 2 个部门的 5 项共享场景全部已测',
    );
    expect(x.preview.question.detail).toContain(
      x.departmentInfo!.department.name,
    );
    expect(x.preview.question.detail).toContain(x.departmentInfo!.other.name);
    expect(x.preview.askUserQuestion.questions[0]?.detail).toBe(
      x.preview.question.detail,
    );
    await expect(
      x.show({ ...x.preview.question, detail: 'Changed scope' }),
    ).rejects.toThrow('activation_question_invalid');
    await x.show();
    await x.answer();
    expect((await x.activate()).enabled).toBe(true);
    await x.run.finish();
    for (const department of [
      x.departmentInfo!.department,
      x.departmentInfo!.other,
    ]) {
      await x.departmentInfo!.configure(
        x.f.a.user.id,
        department.id,
        'personal',
      );
      const next = await methodRun(x.f, x.instance.id, '普通金额任务');
      expect(JSON.stringify(next.runtime.snapshot)).toContain(
        x.saved.candidate.id,
      );
      const effective = await getEffectiveEmployeeContent(
        x.f.a.context,
        x.instance.id,
      );
      expect(
        effective.sources.some((s) =>
          s.body?.includes('金额一律使用人民币整数分'),
        ),
      ).toBe(true);
      expect(
        effective.scenes.some((s) => s.name === '部门独有金额场景 1'),
      ).toBe(true);
      await next.finish();
    }
  }, 60000);

  it('company common coverage rejects partial proof, forged or omitted execution views, and scene-only authorization', async () => {
    const x = await companyCommonFixture();
    await passActivationTest(x.f, x.test);
    const run = await methodRun(
      x.f,
      x.instance.id,
      companyCommonAcceptancePhrases.test,
    );
    await expect(
      prepareEmployeeMethodActivationFromChat({
        ...run,
        arguments: {
          sharedTarget: x.args.sharedTarget,
          expectedRevision: x.args.expectedRevision,
          candidateRevisionId: x.args.candidateRevisionId,
          candidateDigest: x.args.candidateDigest,
          testIds: [x.test.id],
        },
      }),
    ).rejects.toMatchObject({ code: 'activation_test_coverage' });
    for (const delta of [
      { executionView: undefined },
      { executionView: { scope: 'department', departmentId: randomUUID() } },
      { coverageDigest: `sha256:${'0'.repeat(64)}` },
    ])
      await expect(
        startEmployeeMethodTestFromChat({
          ...run,
          callId: randomUUID(),
          arguments: JSON.parse(JSON.stringify({ ...x.args, ...delta })),
        }),
      ).rejects.toMatchObject({ code: 'source_changed' });
    await run.finish();
    const sceneOnly = await methodRun(
      x.f,
      x.instance.id,
      companyMethodAcceptancePhrases.test,
    );
    await expect(
      startEmployeeMethodTestFromChat({ ...sceneOnly, arguments: x.args }),
    ).rejects.toMatchObject({ code: 'explicit_method_request_required' });
    await sceneOnly.finish();
  }, 60000);

  it.each(['queued', 'after-question'] as const)(
    'company common proofs expire when a new department overlay is published %s',
    async (stage) => {
      const x =
        stage === 'queued'
          ? await companyCommonFixture()
          : await activationFixture('company', false, true);
      if (stage === 'after-question' && 'show' in x) {
        await x.show();
        await x.answer();
      }
      const added = (
        await createOrganizationDepartment(
          x.f.admin.context,
          x.f.a.organizationId,
          { name: '新测试部门', requestId: randomUUID() },
        )
      ).department;
      await publishDepartmentOverlay(x, added.id);
      expect(
        (await getEmployeeMethodTest(x.f.a.context, x.test.id)).applicable,
      ).toBe(false);
      if (stage === 'queued')
        expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      else if ('activate' in x) {
        await expect(x.activate()).rejects.toThrow('validation_required');
        await x.run.finish();
      }
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
      ).toBeNull();
    },
    60000,
  );

  it('company maintainer selects another department through the full save/test/confirmation/new-session chain', async () => {
    const x = await activationFixture('selected');
    const target = x.departmentInfo!.other;
    expect(x.args.sharedTarget).toMatchObject({
      scope: 'department',
      departmentId: target.id,
    });
    expect(x.preview.question.question).toContain(target.name);
    expect(x.preview.question.question).toContain('该目标部门');
    expect(x.preview.question.question).not.toContain('影响本部门');
    await x.show();
    await x.answer();
    expect((await x.activate()).enabled).toBe(true);
    expect((await x.activate()).replayed).toBe(true);
    await x.run.finish();
    expect(
      (
        await getEffectiveEmployeeContent(x.f.a.context, x.instance.id)
      ).scenes.map((s) => s.name),
    ).not.toContain('金额合计');
    await x.departmentInfo!.configure(x.f.b.user.id, target.id, 'personal');
    const peer = await createEmployeeInstance(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      assignmentId: x.f.bAssignment.id,
      requestId: randomUUID(),
      profile: { name: '目标部门员工' },
    });
    const session = await createChatSession(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      employeeInstanceId: peer.id,
      title: '目标部门独立任务',
    });
    const adopted = await methodRun(
      { ...x.f, a: x.f.b },
      peer.id,
      selectedDepartmentMethodAcceptancePhrases(target.name).adopt,
      session.id,
    );
    expect(adopted.frozen.content.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setId: x.saved.setId }),
      ]),
    );
    await adopted.finish();
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.department.id,
      'department',
    );
    const replay = await methodRun(x.f, x.instance.id);
    await expect(
      inspectEmployeeMethodFromChat({
        ...replay,
        arguments: {
          view: 'candidate',
          scope: 'department',
          departmentId: target.id,
        },
      }),
    ).rejects.toThrow('authorization_denied');
    await replay.finish();
  });

  it('selected department consumed activation cannot replay after company maintainer is downgraded', async () => {
    const x = await activationFixture('selected');
    await x.show();
    await x.answer();
    await x.activate();
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.department.id,
      'department',
    );
    await expect(x.activate()).rejects.toThrow('authorization_denied');
    await x.run.finish();
  });

  it('named sharing and test denials leave the candidate, test queue and model routes unchanged', async () => {
    const x = await retryFixture('cny-total-v1', false, 'selected');
    await passActivationTest(x.f, x.test);
    const phrases = selectedDepartmentMethodAcceptancePhrases(
      x.departmentInfo!.other.name,
    );
    for (const target of [
      `部门「${x.departmentInfo!.other.name}」`,
      `部门 ${x.departmentInfo!.other.name}`,
      `部门 ${x.departmentInfo!.other.id}`,
    ]) {
      const editing = await methodRun(
        x.f,
        x.instance.id,
        phrases.save + `不要向${target}共享。`,
      );
      await expect(
        saveEmployeeMethodFromChat({
          ...editing,
          arguments: {
            sharedTarget: x.args.sharedTarget,
            expectedRevision: x.saved.revision,
            section: 'scene',
            scene: { id: x.args.sceneId },
            procedure: 'Must not save',
            changeSummary: 'Denied sharing',
          },
        }),
      ).rejects.toThrow('explicit_method_request_required');
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set
          .revision,
      ).toBe(x.saved.revision);
      await editing.finish();
    }
    for (const denial of [
      '先不要测试部门「验收运营部」的工作场景候选。',
      '暂不测试。',
    ]) {
      const run = await methodRun(x.f, x.instance.id, phrases.test + denial);
      const count = () => fixture.db`select
        (select count(*)::int from allrice_employee_method_tests where instance_id=${x.instance.id}) tests,
        (select count(*)::int from allrice_runs where organization_id=${x.f.a.organizationId}) runs,
        (select count(*)::int from allrice_route_decisions where organization_id=${x.f.a.organizationId}) routes`;
      const before = await count();
      await expect(
        startEmployeeMethodTestFromChat({ ...run, arguments: x.args }),
      ).rejects.toThrow('explicit_method_request_required');
      expect(await count()).toEqual(before);
      await run.finish();
    }
  });

  it('company maintainer without membership discovers choices and must explicitly select an active company department', async () => {
    const f = await setup(true),
      instance = await f.custom('部门选择'),
      d = await departmentFixture(f);
    await d.configure(f.a.user.id, null, 'company');
    const editing = await methodRun(
      f,
      instance.id,
      selectedDepartmentMethodAcceptancePhrases(d.other.name).save,
    );
    const choices = await inspectEmployeeMethodFromChat({
      ...editing,
      arguments: { view: 'candidate', scope: 'department' },
    });
    expect(choices).toMatchObject({
      selectionRequired: true,
      sharedTarget: null,
    });
    expect(
      await inspectEmployeeMethodFromChat({
        ...editing,
        arguments: { view: 'history', scope: 'department' },
      }),
    ).toMatchObject({ selectionRequired: true, sharedTarget: null });
    expect('departments' in choices && choices.departments).toEqual(
      expect.arrayContaining(
        [d.department, d.other].map(({ id, name }) => ({ id, name })),
      ),
    );
    const selected = await inspectEmployeeMethodFromChat({
      ...editing,
      arguments: {
        view: 'candidate',
        scope: 'department',
        departmentId: d.other.id,
      },
    });
    expect('sharedTarget' in selected && selected.sharedTarget).toMatchObject({
      departmentId: d.other.id,
    });
    await expect(
      inspectEmployeeMethodFromChat({
        ...editing,
        arguments: {
          view: 'candidate',
          scope: 'department',
          departmentId: randomUUID(),
        },
      }),
    ).rejects.toThrow('authorization_denied');
    await editing.finish();
  });

  it.each([
    'own-wording',
    'wrong-name',
    'personal-body',
    'foreign-id',
  ] as const)(
    'selected department cannot be supplied by the model instead of direct consent: %s',
    async (mismatch) => {
      const x = await retryFixture('cny-total-v1', false, 'selected');
      await passActivationTest(x.f, x.test);
      const text =
        mismatch === 'own-wording'
          ? departmentMethodAcceptancePhrases.save
          : mismatch === 'wrong-name'
            ? selectedDepartmentMethodAcceptancePhrases(
                x.departmentInfo!.department.name,
              ).save
            : mismatch === 'personal-body'
              ? '请保存我的工作场景候选：资料来自验收运营部。'
              : selectedDepartmentMethodAcceptancePhrases(
                  x.departmentInfo!.other.name,
                ).save;
      const editing = await methodRun(x.f, x.instance.id, text);
      await expect(
        saveEmployeeMethodFromChat({
          ...editing,
          arguments: {
            sharedTarget:
              mismatch === 'foreign-id'
                ? { ...x.args.sharedTarget, departmentId: randomUUID() }
                : x.args.sharedTarget,
            expectedRevision: x.saved.revision,
            section: 'scene',
            scene: { id: x.args.sceneId },
            procedure: '不得被写入',
            changeSummary: 'Rejected mismatch',
          },
        }),
      ).rejects.toThrow();
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set
          .revision,
      ).toBe(x.saved.revision);
      await editing.finish();
      const testing = await methodRun(
        x.f,
        x.instance.id,
        mismatch === 'wrong-name'
          ? selectedDepartmentMethodAcceptancePhrases(
              x.departmentInfo!.department.name,
            ).test
          : departmentMethodAcceptancePhrases.test,
      );
      await expect(
        startEmployeeMethodTestFromChat({ ...testing, arguments: x.args }),
      ).rejects.toThrow('explicit_method_request_required');
      await testing.finish();
    },
  );

  it.each(['rename', 'demotion'] as const)(
    'selected department queued test rejects %s before paid admission',
    async (change) => {
      const x = await retryFixture('cny-total-v1', false, 'selected');
      if (change === 'rename')
        await updateOrganizationDepartment(
          x.f.admin.context,
          x.f.a.organizationId,
          x.departmentInfo!.other.id,
          {
            name: '目标部门已改名',
            expectedRevision: x.departmentInfo!.other.revision,
            active: true,
          },
        );
      else
        await x.departmentInfo!.configure(
          x.f.a.user.id,
          x.departmentInfo!.department.id,
          'department',
        );
      const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
      expect(claim?.id).not.toBe(x.test.id);
      const [row] =
        await fixture.db`select r.status,t.run_id from allrice_employee_method_tests t join allrice_platform_employee_test_runs r on r.id=t.test_id where t.test_id=${x.test.id}`;
      expect(row).toMatchObject({ status: 'failed', run_id: null });
    },
  );

  it.each(['rename', 'demotion', 'archive'] as const)(
    'selected department pending exact confirmation rejects %s',
    async (change) => {
      const x = await activationFixture('selected');
      await x.show();
      await x.answer();
      if (change === 'demotion')
        await x.departmentInfo!.configure(
          x.f.a.user.id,
          x.departmentInfo!.department.id,
          'department',
        );
      else
        await updateOrganizationDepartment(
          x.f.admin.context,
          x.f.a.organizationId,
          x.departmentInfo!.other.id,
          {
            name:
              change === 'rename' ? '新部门名' : x.departmentInfo!.other.name,
            expectedRevision: x.departmentInfo!.other.revision,
            active: change !== 'archive',
          },
        );
      await expect(x.activate()).rejects.toThrow();
      const [row] =
        await fixture.db`select active_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`;
      expect(row!.active_revision_id).toBeNull();
      await x.run.finish();
    },
  );

  it('company original wording completes exact confirmation without department and new-session adoption in two departments', async () => {
    const x = await activationFixture('company');
    expect(x.args.sharedTarget?.scope).toBe('company');
    expect(x.args.sharedTarget).not.toHaveProperty('departmentId');
    const [person] =
      await fixture.db`select department_id from allrice_organization_people where organization_id=${x.f.a.organizationId} and user_id=${x.f.a.user.id}`;
    expect(person!.department_id).toBeNull();
    expect(x.preview.question.question).toContain('公司工作方法');
    expect(x.preview.question.question).toContain(x.f.a.organizationId);
    expect(x.preview.question.question).toContain(
      x.args.sharedTarget!.employeeId,
    );
    expect(x.preview.question.question).toContain('各部门及未分配部门');
    const [binding] =
      await fixture.db`select candidate_snapshot from allrice_employee_method_tests where test_id=${x.test.id}`;
    expect(binding!.candidate_snapshot.content.sharedTarget).toEqual(
      x.args.sharedTarget,
    );
    expect(JSON.stringify(binding!.candidate_snapshot.content)).not.toMatch(
      /PRIVATE-CONTENT|DEPARTMENT-ONLY/,
    );
    // The test was created while the maintainer had both active lower overlays;
    // moving them out of a department cannot change company-only evidence.
    expect(
      (await getEmployeeMethodTest(x.f.a.context, x.test.id)).applicable,
    ).toBe(true);
    await x.show();
    await x.answer();
    expect((await x.activate()).enabled).toBe(true);
    expect((await x.activate()).replayed).toBe(true);
    await x.run.finish();
    const peer = await createEmployeeInstance(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      assignmentId: x.f.bAssignment.id,
      requestId: randomUUID(),
      profile: { name: '公司方法使用者' },
    });
    for (const department of [
      x.departmentInfo!.department,
      x.departmentInfo!.other,
    ]) {
      await x.departmentInfo!.configure(
        x.f.b.user.id,
        department.id,
        'personal',
      );
      const session = await createChatSession(x.f.b.context, {
        workspaceId: x.f.b.workspaceId,
        employeeInstanceId: peer.id,
        title: '公司方法新会话',
      });
      const run = await methodRun(
        { ...x.f, a: x.f.b },
        peer.id,
        companyMethodAcceptancePhrases.adopt,
        session.id,
      );
      expect(run.frozen.content.layers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            setId: x.saved.setId,
            revisionId: x.saved.candidate.id,
          }),
        ]),
      );
      expect(JSON.stringify(run.frozen.content)).not.toContain(
        'PRIVATE-CONTENT',
      );
      await expect(
        inspectEmployeeMethodFromChat({
          ...run,
          arguments: { view: 'candidate', scope: 'company' },
        }),
      ).rejects.toThrow('authorization_denied');
      await run.finish();
    }
    const foreign = await principal();
    await expect(
      getEmployeeContentSet(foreign.context, x.saved.setId),
    ).rejects.toThrow();
  });

  it.each(['personal', 'department'] as const)(
    'company queued test refuses downgrade to %s before model admission',
    async (level) => {
      const x = await retryFixture('cny-total-v1', false, 'company');
      await x.departmentInfo!.configure(
        x.f.a.user.id,
        x.departmentInfo!.department.id,
        level,
      );
      const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
      expect(claim?.id).not.toBe(x.test.id);
      const [row] =
        await fixture.db`select p.status,t.run_id from allrice_platform_employee_test_runs p join allrice_employee_method_tests t on t.test_id=p.id where p.id=${x.test.id}`;
      expect(row).toMatchObject({ status: 'failed', run_id: null });
    },
  );

  it.each([false, true])(
    'company confirmation and consumed receipt recheck maintenance (consumed=%s)',
    async (consumed) => {
      const x = await activationFixture('company');
      await x.show();
      await x.answer();
      if (consumed) await x.activate();
      await x.departmentInfo!.configure(
        x.f.a.user.id,
        x.departmentInfo!.department.id,
        'department',
      );
      await expect(x.activate()).rejects.toThrow('authorization_denied');
      const [row] =
        await fixture.db`select active_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`;
      expect(row!.active_revision_id).toBe(
        consumed ? x.saved.candidate.id : null,
      );
      await x.run.finish();
    },
  );

  it('company shared writes reject missing consent, forged targets and retained lower-scope fields without mutations', async () => {
    const x = await activationFixture('company');
    await x.run.finish();
    const args = {
      sharedTarget: x.args.sharedTarget,
      expectedRevision: x.saved.revision,
      section: 'scene',
      scene: { id: x.args.sceneId },
      procedure: '整数分相加',
      changeSummary: 'Company-only edit',
    };
    const before =
      await fixture.db`select revision,candidate_revision_id,active_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`;
    for (const phrase of [
      '请保存我的“公司金额”工作场景：整数分相加。',
      '请保存本公司的工作场景候选：整数分相加。仅供我个人使用。',
      `${companyMethodAcceptancePhrases.save}不要长期保存。`,
      'Please save company work method: sum integer cents; do not save company work method.',
      '请保存本公司工作场景候选：整数分相加。只用于这次任务。',
    ]) {
      const run = await methodRun(x.f, x.instance.id, phrase);
      await expect(
        saveEmployeeMethodFromChat({ ...run, arguments: args }),
      ).rejects.toThrow('explicit_method_request_required');
      await run.finish();
    }
    const run = await methodRun(
      x.f,
      x.instance.id,
      companyMethodAcceptancePhrases.save,
    );
    for (const sharedTarget of [
      { ...x.args.sharedTarget, setId: randomUUID() },
      { ...x.args.sharedTarget, employeeId: randomUUID() },
      { ...x.args.sharedTarget, departmentId: x.departmentInfo!.department.id },
      undefined,
    ])
      await expect(
        saveEmployeeMethodFromChat({
          ...run,
          callId: randomUUID(),
          arguments: { ...args, sharedTarget },
        }),
      ).rejects.toThrow();
    expect(
      await inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'history', scope: 'company' },
      }),
    ).toMatchObject({
      sharedTarget: x.args.sharedTarget,
      setId: x.saved.setId,
    });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        arguments: { ...args, section: 'common', scene: undefined },
      }),
    ).rejects.toThrow('explicit_method_request_required');
    expect(
      await fixture.db`select revision,candidate_revision_id,active_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`,
    ).toEqual(before);
    await run.finish();
  });

  it('company maintainers in separate departments share one exact set and stale candidates cannot overwrite', async () => {
    const x = await activationFixture('company');
    await x.run.finish();
    await x.departmentInfo!.configure(
      x.f.b.user.id,
      x.departmentInfo!.other.id,
      'company',
    );
    const peer = await createEmployeeInstance(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      assignmentId: x.f.bAssignment.id,
      requestId: randomUUID(),
      profile: { name: '公司维护人二' },
    });
    const session = await createChatSession(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      employeeInstanceId: peer.id,
      title: '另一公司维护人',
    });
    const run = await methodRun(
      { ...x.f, a: x.f.b },
      peer.id,
      companyMethodAcceptancePhrases.save,
      session.id,
    );
    const selected = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate', scope: 'company' },
    });
    expect('sharedTarget' in selected && selected.sharedTarget).toEqual(
      x.args.sharedTarget,
    );
    const args = {
      sharedTarget: x.args.sharedTarget,
      expectedRevision: x.saved.revision,
      section: 'scene',
      scene: { id: x.args.sceneId },
      procedure: '校验后整数分相加',
      changeSummary: 'Concurrent company change',
    };
    await saveEmployeeMethodFromChat({ ...run, arguments: args });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        callId: randomUUID(),
        arguments: args,
      }),
    ).rejects.toThrow('version_conflict');
    await run.finish();
  });

  it('department shared original wording completes save, test, scoped answer and peer adoption without private overlays', async () => {
    const x = await activationFixture(true);
    expect(x.args.sharedTarget?.scope).toBe('department');
    expect(x.preview.question.question).toContain('验收财务部');
    expect(x.preview.question.question).toContain(
      x.args.sharedTarget!.employeeId,
    );
    expect(x.preview.question.question).not.toContain('重试测试');
    const [binding] =
      await fixture.db`select candidate_snapshot from allrice_employee_method_tests where test_id=${x.test.id}`;
    expect(binding!.candidate_snapshot.content.sharedTarget).toEqual(
      x.args.sharedTarget,
    );
    // The already ACTIVE private method must not contaminate the shared test.
    const own = await getEffectiveEmployeeContent(x.f.a.context, x.instance.id);
    expect(JSON.stringify(own)).toContain('PRIVATE-CONTENT');
    expect(JSON.stringify(binding!.candidate_snapshot.content)).not.toContain(
      'PRIVATE-CONTENT',
    );
    await x.show();
    await x.answer();
    const enabled = await x.activate();
    expect(enabled.enabled).toBe(true);
    expect((await x.activate()).replayed).toBe(true);
    await x.run.finish();
    const peerInstance = await createEmployeeInstance(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      assignmentId: x.f.bAssignment.id,
      requestId: randomUUID(),
      profile: { name: '同事小白' },
    });
    const effective = await getEffectiveEmployeeContent(
      x.f.b.context,
      peerInstance.id,
    );
    expect(effective.scenes.map((scene) => scene.name)).toContain('金额合计');
    expect(JSON.stringify(effective)).not.toContain('PRIVATE-CONTENT');
    const peerSession = await createChatSession(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      employeeInstanceId: peerInstance.id,
      title: '新会话采用部门方法',
    });
    const adopted = await methodRun(
      { ...x.f, a: x.f.b },
      peerInstance.id,
      departmentMethodAcceptancePhrases.adopt,
      peerSession.id,
    );
    expect(adopted.frozen.content.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setId: x.saved.setId }),
      ]),
    );
    await adopted.finish();
    await x.departmentInfo!.configure(
      x.f.b.user.id,
      x.departmentInfo!.other.id,
      'personal',
    );
    const outside = await getEffectiveEmployeeContent(
      x.f.b.context,
      peerInstance.id,
    );
    expect(outside.scenes.map((scene) => scene.name)).not.toContain('金额合计');
  });

  it.each(['demotion', 'transfer', 'archive'] as const)(
    'department shared pending confirmation rejects %s and retains inactive candidate',
    async (change) => {
      const x = await activationFixture(true);
      await x.show();
      await x.answer();
      if (change === 'demotion')
        await x.departmentInfo!.configure(
          x.f.a.user.id,
          x.departmentInfo!.department.id,
          'personal',
        );
      else {
        await x.departmentInfo!.configure(
          x.f.a.user.id,
          x.departmentInfo!.other.id,
          'department',
        );
        if (change === 'archive') {
          await x.departmentInfo!.configure(
            x.f.b.user.id,
            x.departmentInfo!.other.id,
            'personal',
          );
          await updateOrganizationDepartment(
            x.f.admin.context,
            x.f.a.organizationId,
            x.departmentInfo!.department.id,
            {
              name: x.departmentInfo!.department.name,
              expectedRevision: x.departmentInfo!.department.revision,
              active: false,
            },
          );
        }
      }
      await expect(x.activate()).rejects.toThrow();
      const [row] =
        await fixture.db`select active_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`;
      expect(row!.active_revision_id).toBeNull();
      await x.run.finish();
    },
  );

  it('department shared consumed receipt cannot be replayed after maintenance revocation', async () => {
    const x = await activationFixture(true);
    await x.show();
    await x.answer();
    await x.activate();
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.department.id,
      'personal',
    );
    await expect(x.activate()).rejects.toThrow('authorization_denied');
    await x.run.finish();
  });

  it('department shared queued test rechecks authority before any model admission', async () => {
    const x = await retryFixture('cny-total-v1', false, true);
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.department.id,
      'personal',
    );
    const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim?.id).not.toBe(x.test.id);
    const [test] =
      await fixture.db`select status from allrice_platform_employee_test_runs where id=${x.test.id}`;
    expect(test!.status).toBe('failed');
    const routes =
      await fixture.db`select run_id from allrice_employee_method_tests where test_id=${x.test.id}`;
    expect(routes[0]!.run_id).toBeNull();
  });

  it('department shared selection cannot redirect after transfer or admit company/private/files/common targets', async () => {
    const x = await retryFixture('cny-total-v1', false, true);
    await passActivationTest(x.f, x.test);
    const editing = await methodRun(
      x.f,
      x.instance.id,
      departmentMethodAcceptancePhrases.save,
    );
    const args = {
      sharedTarget: x.args.sharedTarget,
      expectedRevision: x.saved.revision,
      section: 'scene',
      scene: { id: x.args.sceneId },
      procedure: '整数分相加',
      changeSummary: 'Same scope',
    };
    await expect(
      saveEmployeeMethodFromChat({
        ...editing,
        arguments: { ...args, sharedTarget: undefined },
      }),
    ).rejects.toThrow('explicit_method_request_required');
    await expect(
      saveEmployeeMethodFromChat({
        ...editing,
        arguments: { ...args, section: 'common', scene: undefined },
      }),
    ).rejects.toThrow('explicit_method_request_required');
    await expect(
      saveEmployeeMethodFromChat({
        ...editing,
        arguments: {
          ...args,
          references: [
            {
              sourceKind: 'knowledge',
              contentId: randomUUID(),
              revisionId: randomUUID(),
              digest: `sha256:${'1'.repeat(64)}`,
            },
          ],
        },
      }),
    ).rejects.toThrow('authorization_denied');
    expect(
      await inspectEmployeeMethodFromChat({
        ...editing,
        arguments: { view: 'history', scope: 'department' },
      }),
    ).toMatchObject({
      sharedTarget: x.args.sharedTarget,
      setId: x.saved.setId,
    });
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.other.id,
      'department',
    );
    await expect(
      saveEmployeeMethodFromChat({ ...editing, arguments: args }),
    ).rejects.toThrow('authorization_denied');
    const [unchanged] =
      await fixture.db`select revision from allrice_employee_content_sets where id=${x.saved.setId}`;
    expect(unchanged!.revision).toBe(x.saved.revision);
    await editing.finish();
  });

  it('department shared writes reject personal-only original wording with zero mutations', async () => {
    const x = await retryFixture('cny-total-v1', false, true);
    await passActivationTest(x.f, x.test);
    const run = await methodRun(
      x.f,
      x.instance.id,
      '请保存仅供我个人使用而非本部门共享的工作场景候选：金额只相加。',
    );
    const before =
      await fixture.db`select revision,candidate_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`;
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        arguments: {
          sharedTarget: x.args.sharedTarget,
          expectedRevision: x.saved.revision,
          section: 'scene',
          scene: { id: x.args.sceneId },
          procedure: '金额只相加',
          changeSummary: 'Must remain personal',
        },
      }),
    ).rejects.toThrow('explicit_method_request_required');
    expect(
      await fixture.db`select revision,candidate_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`,
    ).toEqual(before);
    await run.finish();
  });

  it('department shared selection uses NOWAIT when publication holds deployment before assignment', async () => {
    const x = await retryFixture('cny-total-v1', false, true);
    await passActivationTest(x.f, x.test);
    // Reproduce the reversed lock order without waiting for PostgreSQL to
    // choose a deadlock victim. The existing access transaction retries 55P03.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const publication = fixture.db.begin(async (tx) => {
      await tx`select tenant_employee_id from allrice_platform_employee_tenant_assignments where tenant_employee_id=${x.args.sharedTarget!.employeeId} for update`;
      locked();
      await blocked;
    });
    await ready;
    try {
      const { ownDepartmentMethodTarget } =
        await import('./employee-method-target.ts');
      await expect(
        fixture.db.begin(async (tx) => {
          await tx`select id from allrice_employee_assignments where id=${x.instance.assignmentId} for share`;
          return ownDepartmentMethodTarget(x.f.a.context, x.instance.id, tx);
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release();
      await publication;
    }
  });
  it('department shared two maintainers share one set and reject a stale candidate write', async () => {
    const x = await retryFixture('cny-total-v1', false, true);
    await passActivationTest(x.f, x.test);
    await x.departmentInfo!.configure(
      x.f.b.user.id,
      x.departmentInfo!.department.id,
      'department',
    );
    const peer = await createEmployeeInstance(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      assignmentId: x.f.bAssignment.id,
      requestId: randomUUID(),
      profile: { name: '另一维护人' },
    });
    const session = await createChatSession(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      employeeInstanceId: peer.id,
      title: '同一部门候选',
    });
    const run = await methodRun(
      { ...x.f, a: x.f.b },
      peer.id,
      departmentMethodAcceptancePhrases.save,
      session.id,
    );
    const found = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate', scope: 'department' },
    });
    expect('sharedTarget' in found && found.sharedTarget).toEqual(
      x.args.sharedTarget,
    );
    const args = {
      sharedTarget: x.args.sharedTarget,
      expectedRevision: x.saved.revision,
      section: 'scene',
      scene: { id: x.args.sceneId },
      procedure: '核对后将整数分相加',
      changeSummary: '第二维护人修改',
    };
    await saveEmployeeMethodFromChat({ ...run, arguments: args });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        callId: randomUUID(),
        arguments: args,
      }),
    ).rejects.toThrow('version_conflict');
    await run.finish();
  });
  it.each([false, true, 'company', 'selected'] as const)(
    'restores exact chat history and repeatedly forks old text without altering active sources: %s',
    async (scope) => {
      const x = await activationFixture(scope);
      const shared = x.args.sharedTarget
        ? { sharedTarget: x.args.sharedTarget }
        : {};
      const target =
        scope === 'company'
          ? ('company' as const)
          : {
              departmentName:
                scope === 'selected'
                  ? (x.departmentInfo?.other.name ?? '')
                  : (x.departmentInfo?.department.name ?? ''),
            };
      const phrases = sharedHistoryMethodAcceptancePhrases(target, 1);
      await x.show();
      await x.answer();
      await x.activate();
      await x.run.finish();
      const initial = await getEmployeeContentSet(x.f.a.context, x.saved.setId);
      const original = initial.set.candidate!;
      const scene = original.manifest.scenes[0]!;
      const oldPin = scene.references[0]!;
      const edit = await methodRun(
        x.f,
        x.instance.id,
        scope ? phrases.edit : undefined,
      );
      const newer = await saveEmployeeMethodFromChat({
        ...edit,
        arguments: {
          ...shared,
          expectedRevision: initial.set.revision,
          section: 'scene',
          scene: { id: scene.id },
          procedure: '错误地额外加100分',
          changeSummary: 'Known wrong candidate',
        },
      });
      await edit.finish();
      const sourceBefore =
        await fixture.db`select * from allrice_company_assets where id=${oldPin.contentId}`;
      expect(sourceBefore[0]!.latest_revision_id).not.toBe(oldPin.revisionId);
      const restore = await methodRun(
        x.f,
        x.instance.id,
        scope
          ? sharedHistoryMethodAcceptancePhrases(target, original.number)
              .restore
          : `请恢复我的整份工作方法到第${original.number}版，只保存候选。`,
      );
      const history = await inspectEmployeeMethodFromChat({
        ...restore,
        arguments: {
          view: 'history',
          ...(scope
            ? { scope: scope === 'company' ? 'company' : 'department' }
            : {}),
          ...(scope === 'selected'
            ? { departmentId: x.departmentInfo!.other.id }
            : {}),
        },
      });
      if (!('revisions' in history)) throw Error('History response missing');
      expect(history.revisions.map((r) => r.id)).toContain(original.id);
      expect(JSON.stringify(history)).not.toContain('错误地额外加100分');
      expect(history.activeRevisionId).toBe(original.id);
      expect(
        (
          await fixture.db`select retired_at from allrice_employee_content_contexts where generation_id=${restore.runtime.generationId}`
        )[0]?.retired_at,
      ).not.toBeNull();
      const args = {
        ...shared,
        expectedRevision: newer.revision,
        sourceRevisionId: original.id,
        changeSummary: '恢复已启用的历史版本',
      };
      const call = { ...restore, arguments: args };
      const restored = await restoreEmployeeMethodFromChat(call);
      expect(await restoreEmployeeMethodFromChat(call)).toEqual(restored);
      await expect(
        restoreEmployeeMethodFromChat({
          ...call,
          arguments: { ...args, changeSummary: 'Different input' },
        }),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      await expect(
        restoreEmployeeMethodFromChat({ ...call, callId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      const read = await getEmployeeContentSet(x.f.a.context, x.saved.setId);
      expect(read.set.active!.id).toBe(original.id);
      expect(read.set.candidate).toMatchObject({
        restoredFromRevisionId: original.id,
        manifest: original.manifest,
      });
      expect(read.set.candidate!.id).not.toBe(original.id);
      expect(read.set.validation).toBeNull();
      await expect(
        prepareEmployeeMethodActivationFromChat({
          ...restore,
          callId: randomUUID(),
          arguments: {
            ...shared,
            expectedRevision: restored.revision,
            candidateRevisionId: restored.candidate.id,
            candidateDigest: restored.candidate.digest,
            testIds: [x.test.id],
          },
        }),
      ).rejects.toThrow();
      await expect(
        prepareEmployeeMethodActivationFromChat({
          ...restore,
          callId: randomUUID(),
          arguments: {
            ...shared,
            expectedRevision: restored.revision,
            candidateRevisionId: restored.candidate.id,
            candidateDigest: restored.candidate.digest,
            testIds: [],
          },
        }),
      ).rejects.toMatchObject({ code: 'activation_test_coverage' });
      await restore.finish();
      let previous = restored;
      let pin = oldPin;
      const correction = await methodRun(
        x.f,
        x.instance.id,
        scope ? phrases.edit : '请更新我的工作场景候选：核对金额再汇总。',
      );
      const noOp = await saveEmployeeMethodFromChat({
        ...correction,
        callId: randomUUID(),
        arguments: {
          ...shared,
          expectedRevision: previous.revision,
          section: 'scene',
          scene: { id: scene.id, name: scene.name },
          changeSummary: 'Unchanged scene name',
        },
      });
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set
          .candidate!.restoredFromRevisionId,
      ).toBe(original.id);
      await expect(
        prepareEmployeeMethodActivationFromChat({
          ...correction,
          callId: randomUUID(),
          arguments: {
            ...shared,
            expectedRevision: noOp.revision,
            candidateRevisionId: noOp.candidate.id,
            candidateDigest: noOp.candidate.digest,
            testIds: [],
          },
        }),
      ).rejects.toMatchObject({ code: 'activation_test_coverage' });
      previous = noOp;
      await expect(
        saveEmployeeMethodFromChat({
          ...correction,
          arguments: {
            ...shared,
            expectedRevision: previous.revision,
            section: 'scene',
            scene: { id: scene.id },
            procedure: '新的文字',
            changeSummary: 'Must name historical pin',
          },
        }),
      ).rejects.toMatchObject({ code: 'source_changed' });
      for (const body of ['先检查整数分再相加', '核对输入后只将整数分相加']) {
        previous = await saveEmployeeMethodFromChat({
          ...correction,
          callId: randomUUID(),
          arguments: {
            ...shared,
            expectedRevision: previous.revision,
            section: 'scene',
            scene: { id: scene.id },
            procedure: body,
            replaceTextReferences: [pin],
            changeSummary: 'Explicit private replacement',
          },
        });
        const current = await getEmployeeContentSet(
          x.f.a.context,
          x.saved.setId,
        );
        const next = current.set.candidate!.manifest.scenes[0]!.references[0]!;
        expect(next.contentId).not.toBe(pin.contentId);
        expect(
          current.sources.find((v) => v.reference.contentId === next.contentId)
            ?.body,
        ).toBe(body);
        pin = next;
      }
      expect(
        await fixture.db`select * from allrice_company_assets where id=${oldPin.contentId}`,
      ).toEqual(sourceBefore);
      expect(
        (
          await getEmployeeContentHistory(x.f.a.context, x.saved.setId)
        ).revisions.find((r) => r.id === original.id),
      ).toMatchObject(original);
      await correction.finish();
      const testRun = await methodRun(
        x.f,
        x.instance.id,
        scope ? phrases.test : '请测试我的工作场景候选',
      );
      const freshTest = await startEmployeeMethodTestFromChat({
        ...testRun,
        arguments: {
          ...shared,
          expectedRevision: previous.revision,
          candidateRevisionId: previous.candidate.id,
          candidateDigest: previous.candidate.digest,
          sceneId: scene.id,
          caseId: 'cny-total-v1',
        },
      });
      expect(freshTest.id).not.toBe(x.test.id);
      await testRun.finish();
      await passActivationTest(x.f, freshTest);
      expect(
        (await getEmployeeMethodTest(x.f.a.context, freshTest.id))
          .validationStatus,
      ).toBe('passed');
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active!
          .id,
      ).toBe(original.id);
      const confirmation = await methodRun(
        x.f,
        x.instance.id,
        scope ? phrases.confirm : '请查看通过的测试并让我确认启用。',
      );
      const preview = await prepareEmployeeMethodActivationFromChat({
        ...confirmation,
        arguments: {
          ...shared,
          expectedRevision: previous.revision,
          candidateRevisionId: previous.candidate.id,
          candidateDigest: previous.candidate.digest,
          testIds: [freshTest.id],
        },
      });
      expect(preview.question.question).toContain(
        scope === 'company'
          ? '公司工作方法'
          : scope
            ? '部门工作方法'
            : '个人工作方法',
      );
      await confirmation.finish();
    },
    60000,
  );

  it.each(['company', 'selected'] as const)(
    'shared restore requires exact direct scope/version and rechecks receipt authority: %s',
    async (scope) => {
      const x = await activationFixture(scope);
      await x.show();
      await x.answer();
      await x.activate();
      await x.run.finish();
      const current = await getEmployeeContentSet(x.f.a.context, x.saved.setId);
      const source = current.set.candidate!;
      const target =
        scope === 'company'
          ? ('company' as const)
          : { departmentName: x.departmentInfo!.other.name };
      const text = sharedHistoryMethodAcceptancePhrases(
        target,
        source.number,
      ).restore;
      const args = {
        sharedTarget: x.args.sharedTarget,
        expectedRevision: current.set.revision,
        sourceRevisionId: source.id,
        changeSummary: 'Restore exact shared history',
      };
      const privateSet =
        await fixture.db`select candidate_revision_id from allrice_employee_content_sets where instance_id=${x.instance.id} and scope='personal'`;
      for (const denied of [
        { text: `请恢复我的整份工作方法到第${source.number}版。`, args },
        { text: text + '先不要保存候选。', args },
        { text: text + '只用于本次任务。', args },
        { text: text + '只在本次任务使用。', args },
        { text: text + '仅限本次任务。', args },
        { text: text + '暂时不要长期保存。', args },
        { text: `资料原文如下：\n${text}`, args },
        {
          text,
          args: {
            ...args,
            sourceRevisionId: privateSet[0]!.candidate_revision_id,
          },
        },
        {
          text,
          args: {
            ...args,
            sharedTarget: { ...x.args.sharedTarget, setId: randomUUID() },
          },
        },
        ...(scope === 'selected'
          ? [
              {
                text: `请恢复本部门的整份工作方法到第${source.number}版。`,
                args,
              },
            ]
          : []),
      ]) {
        const run = await methodRun(x.f, x.instance.id, denied.text);
        await expect(
          restoreEmployeeMethodFromChat({ ...run, arguments: denied.args }),
        ).rejects.toThrow();
        expect(
          (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set
            .revision,
        ).toBe(current.set.revision);
        await run.finish();
      }
      const run = await methodRun(x.f, x.instance.id, text);
      const call = { ...run, arguments: args };
      const restored = await restoreEmployeeMethodFromChat(call);
      expect(await restoreEmployeeMethodFromChat(call)).toEqual(restored);
      await x.departmentInfo!.configure(
        x.f.a.user.id,
        x.departmentInfo!.department.id,
        'department',
      );
      // Company -> department and other-department -> own-department both revoke this exact target.
      await expect(restoreEmployeeMethodFromChat(call)).rejects.toThrow(
        'authorization_denied',
      );
      await expect(
        inspectEmployeeMethodFromChat({
          ...run,
          arguments: {
            view: 'history',
            scope: scope === 'company' ? 'company' : 'department',
            ...(scope === 'selected'
              ? { departmentId: x.departmentInfo!.other.id }
              : {}),
          },
        }),
      ).rejects.toThrow('authorization_denied');
      const [row] =
        await fixture.db`select revision,active_revision_id,candidate_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`;
      expect(row).toMatchObject({
        revision: restored.revision,
        active_revision_id: source.id,
        candidate_revision_id: restored.candidate.id,
      });
      await run.finish();
    },
    60000,
  );

  it('restored shared history requires fresh proof for every scene and rejects an empty restored method', async () => {
    const x = await activationFixture('selected');
    await x.show();
    await x.answer();
    await x.activate();
    await x.run.finish();
    const initial = await getEmployeeContentSet(x.f.a.context, x.saved.setId);
    const sharedTarget = x.args.sharedTarget!;
    const target = { departmentName: x.departmentInfo!.other.name };
    const phrases = sharedHistoryMethodAcceptancePhrases(target, 1);
    const edit = await methodRun(x.f, x.instance.id, phrases.edit);
    const multiple = await saveEmployeeMethodFromChat({
      ...edit,
      arguments: {
        sharedTarget,
        expectedRevision: initial.set.revision,
        section: 'scene',
        scene: {
          name: '第二个金额场景',
          appliesWhen: 'Second synthetic amount case',
        },
        procedure: '只将整数分相加',
        changeSummary: 'Two-scene history',
      },
    });
    await edit.finish();
    const restore = await methodRun(
      x.f,
      x.instance.id,
      sharedHistoryMethodAcceptancePhrases(target, multiple.revision).restore,
    );
    const restored = await restoreEmployeeMethodFromChat({
      ...restore,
      arguments: {
        sharedTarget,
        expectedRevision: multiple.revision,
        sourceRevisionId: multiple.candidate.id,
        changeSummary: 'Restore both scenes',
      },
    });
    await restore.finish();
    const testRun = await methodRun(x.f, x.instance.id, phrases.test);
    const test = await startEmployeeMethodTestFromChat({
      ...testRun,
      arguments: {
        ...x.args,
        sharedTarget,
        expectedRevision: restored.revision,
        candidateRevisionId: restored.candidate.id,
        candidateDigest: restored.candidate.digest,
      },
    });
    await testRun.finish();
    await passActivationTest(x.f, test);
    const confirmation = await methodRun(x.f, x.instance.id, phrases.confirm);
    await expect(
      prepareEmployeeMethodActivationFromChat({
        ...confirmation,
        arguments: {
          sharedTarget,
          expectedRevision: restored.revision,
          candidateRevisionId: restored.candidate.id,
          candidateDigest: restored.candidate.digest,
          testIds: [test.id],
        },
      }),
    ).rejects.toThrow('activation_test_coverage');
    await confirmation.finish();
    // Historical empty manifests can exist from earlier admin maintenance; they
    // must not turn the fresh-proof requirement into a vacuous all-pass.
    const empty = await mutateEmployeeContent(x.f.a.context, {
      operation: 'save_draft',
      workspaceId: x.f.a.workspaceId,
      setId: x.saved.setId,
      requestId: randomUUID(),
      ownership: {
        scope: 'department',
        organizationId: x.f.a.organizationId,
        departmentId:
          sharedTarget.scope === 'department'
            ? sharedTarget.departmentId
            : null,
      },
      target: { kind: 'employee', employeeId: sharedTarget.employeeId },
      expectedRevision: restored.revision,
      manifest: {
        schemaVersion: 1,
        common: [],
        scenes: [],
        declaredConflicts: [],
      },
      textEdits: [],
      changeSummary: 'Pre-existing empty history',
    });
    const emptyRun = await methodRun(
      x.f,
      x.instance.id,
      sharedHistoryMethodAcceptancePhrases(target, empty.revision).restore,
    );
    const emptyRestore = await restoreEmployeeMethodFromChat({
      ...emptyRun,
      arguments: {
        sharedTarget,
        expectedRevision: empty.revision,
        sourceRevisionId: empty.candidate.id,
        changeSummary: 'Restore empty history',
      },
    });
    await expect(
      prepareEmployeeMethodActivationFromChat({
        ...emptyRun,
        arguments: {
          sharedTarget,
          expectedRevision: emptyRestore.revision,
          candidateRevisionId: emptyRestore.candidate.id,
          candidateDigest: emptyRestore.candidate.digest,
          testIds: [],
        },
      }),
    ).rejects.toThrow('activation_test_coverage');
    expect(
      (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active!
        .id,
    ).toBe(initial.set.active!.id);
    await emptyRun.finish();
  }, 60000);

  it('keeps old unpublished pins unavailable and rechecks restore target, intent and current authority', async () => {
    const f = await setup(true),
      instance = await f.custom('历史边界');
    const editing = await methodRun(f, instance.id);
    const first = await saveEmployeeMethodFromChat({
      ...editing,
      arguments: {
        expectedRevision: 0,
        section: 'scene',
        scene: { name: '金额', appliesWhen: '合成样例' },
        procedure: '原未发布文字',
        changeSummary: 'Unpublished history',
      },
    });
    const before = await getEmployeeContentSet(f.a.context, first.setId);
    const scene = before.set.candidate!.manifest.scenes[0]!;
    const second = await saveEmployeeMethodFromChat({
      ...editing,
      callId: randomUUID(),
      arguments: {
        expectedRevision: first.revision,
        section: 'scene',
        scene: { id: scene.id },
        procedure: '新草稿',
        changeSummary: 'New draft',
      },
    });
    await editing.finish();
    const args = {
      expectedRevision: second.revision,
      sourceRevisionId: first.candidate.id,
      changeSummary: 'Restore history',
    };
    const unrelated = await f.custom('另一个小白');
    const other = await methodRun(
      f,
      unrelated.id,
      '请恢复我的整份工作方法到第1版，保存候选后，只展示差异。',
    );
    await expect(
      restoreEmployeeMethodFromChat({ ...other, arguments: args }),
    ).rejects.toThrow();
    await other.finish();
    for (const text of [
      '请恢复我的每周场景到第1版',
      '请恢复我的整份工作方法到第2版',
      '> 请恢复我的整份工作方法到第1版',
      '请恢复我的整份工作方法到第1版：不要保存，只展示差异。',
      '请恢复我的整份工作方法到第1版，先不要保存，只展示差异。',
      '请恢复我的整份工作方法到第1版，只讨论，不执行。',
      '请恢复我的整份工作方法到第1版，本次暂时不要实际恢复。',
      '请恢复我的整份工作方法到第1版，先别保存候选。',
      '请恢复我的整份工作方法到第1版，暂不保存。',
      '请恢复我的整份工作方法到第1版，保存候选后，先不要保存，只展示差异。',
      '请恢复我的工作方法到第1版，只恢复周度场景，月度场景保持不变。',
    ]) {
      const denied = await methodRun(f, instance.id, text);
      await expect(
        restoreEmployeeMethodFromChat({ ...denied, arguments: args }),
      ).rejects.toMatchObject({ code: 'explicit_method_restore_required' });
      await denied.finish();
    }
    expect(
      (await getEmployeeContentSet(f.a.context, first.setId)).set.candidate!.id,
    ).toBe(second.candidate.id);
    const restore = await methodRun(
      f,
      instance.id,
      '请恢复我的整份工作方法到第1版，保存候选后，只展示差异。',
    );
    await expect(
      restoreEmployeeMethodFromChat({
        ...restore,
        arguments: { ...args, sourceRevisionId: randomUUID() },
      }),
    ).rejects.toThrow();
    const restored = await restoreEmployeeMethodFromChat({
      ...restore,
      arguments: args,
    });
    const content = await getEmployeeContentSet(f.a.context, first.setId);
    expect(content.sources.some((s) => !s.available)).toBe(true);
    await restore.finish();
    const correcting = await methodRun(f, instance.id);
    await expect(
      saveEmployeeMethodFromChat({
        ...correcting,
        arguments: {
          expectedRevision: restored.revision,
          section: 'scene',
          scene: { id: scene.id },
          procedure: 'copy unavailable old text',
          replaceTextReferences: scene.references,
          changeSummary: 'Denied copy',
        },
      }),
    ).rejects.toMatchObject({ code: 'source_changed' });
    await correcting.finish();
    const stale = await methodRun(
      f,
      instance.id,
      '请恢复我的整份工作方法到第1版',
    );
    await fixture.db`update allrice_jobs set cancel_requested_at=now() where id=${stale.context.jobId}`;
    await expect(
      restoreEmployeeMethodFromChat({
        ...stale,
        arguments: { ...args, expectedRevision: restored.revision },
      }),
    ).rejects.toThrow();
    await stale.finish();
    const revoked = await methodRun(
      f,
      instance.id,
      '请恢复我的整份工作方法到第1版',
    );
    await f.change('withdraw');
    await expect(
      restoreEmployeeMethodFromChat({
        ...revoked,
        arguments: { ...args, expectedRevision: restored.revision },
      }),
    ).rejects.toThrow();
    await revoked.finish();
  }, 60000);

  it('replaces exact legacy text in one scene without contradicting or rewriting old sources', async () => {
    const f = await setup(true),
      instance = await f.custom('旧流程迁移');
    const source = randomUUID(),
      revision = randomUUID(),
      sceneId = randomUUID(),
      otherScene = randomUUID(),
      setId = randomUUID();
    const saved = await mutateEmployeeContent(f.a.context, {
      operation: 'save_draft',
      workspaceId: f.a.workspaceId,
      setId,
      requestId: randomUUID(),
      expectedRevision: 0,
      ownership: {
        scope: 'personal',
        organizationId: f.a.organizationId,
        ownerId: f.a.user.id,
      },
      target: { kind: 'instance', instanceId: instance.id },
      changeSummary: '原有手工流程',
      manifest: {
        schemaVersion: 1,
        common: [],
        scenes: [
          {
            id: sceneId,
            name: '周度',
            appliesWhen: '每周',
            references: [{ sourceKind: 'draft_text', contentId: source }],
          },
          {
            id: otherScene,
            name: '月度',
            appliesWhen: '每月',
            references: [{ sourceKind: 'draft_text', contentId: source }],
          },
        ],
        declaredConflicts: [],
      },
      textEdits: [
        {
          contentId: source,
          revisionId: revision,
          expectedRevision: 0,
          kind: 'procedure',
          title: '旧流程',
          body: '先汇总再校验',
        },
      ],
    });
    const before = await getEmployeeContentSet(f.a.context, setId),
      ref = before.set.candidate!.manifest.scenes[0]!.references[0]!;
    const run = await methodRun(
      f,
      instance.id,
      '请调整我的「周度」工作场景候选：把执行流程改成先校验再汇总，保留月度流程。',
    );
    const args = {
      expectedRevision: saved.revision,
      section: 'scene',
      scene: { id: sceneId },
      procedure: '先校验再汇总',
      changeSummary: '纠正顺序',
    };
    await expect(
      saveEmployeeMethodFromChat({ ...run, arguments: args }),
    ).rejects.toMatchObject({ code: 'method_text_target_required' });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        arguments: {
          ...args,
          replaceTextReferences: [{ ...ref, revisionId: randomUUID() }],
        },
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const result = await saveEmployeeMethodFromChat({
      ...run,
      arguments: { ...args, replaceTextReferences: [ref] },
    });
    expect(
      await saveEmployeeMethodFromChat({
        ...run,
        arguments: { ...args, replaceTextReferences: [ref] },
      }),
    ).toEqual(result);
    const after = await getEmployeeContentSet(f.a.context, setId);
    expect(after.set.active).toBeNull();
    expect(after.set.candidate!.manifest.scenes[0]!.references).toHaveLength(1);
    expect(
      after.set.candidate!.manifest.scenes[0]!.references[0]!.contentId,
    ).not.toBe(ref.contentId);
    expect(after.set.candidate!.manifest.scenes[1]).toEqual(
      before.set.candidate!.manifest.scenes[1],
    );
    expect(
      after.sources.find((s) => s.reference.contentId === ref.contentId)?.body,
    ).toBe('先汇总再校验');
    expect(
      (await getEmployeeContentHistory(f.a.context, setId)).revisions.some(
        (r) => r.id === saved.candidate.id,
      ),
    ).toBe(true);
    await run.finish();
  }, 60000);

  it('activates only the displayed exact candidate after adopted confirmation and returns one durable receipt', async () => {
    const x = await activationFixture();
    await expect(x.activate()).rejects.toMatchObject({
      code: 'activation_answer_pending',
    });
    await expect(
      x.show({ ...x.preview.question, question: '请确认另一个候选' }),
    ).rejects.toMatchObject({ code: 'activation_question_invalid' });
    await x.show();
    const pending = await x.answer(['确认启用'], undefined, false);
    await expect(x.activate()).rejects.toMatchObject({
      code: 'activation_answer_pending',
    });
    await consumeConversationSteer({
      commandId: pending.command.id,
      workerId: x.runtime.workerId,
      proof: pending.proof,
    });
    const concurrent = await Promise.all([
      x.activate(),
      x.activate(),
      x.activate(),
    ]);
    expect(concurrent.filter((r) => !r.replayed)).toHaveLength(1);
    const result = concurrent.find((r) => !r.replayed)!;
    expect(result).toMatchObject({
      enabled: true,
      replayed: false,
      receipt: { active: x.saved.candidate },
    });
    const again = await x.activate();
    expect(again).toMatchObject({
      enabled: true,
      replayed: true,
      receipt: result.receipt,
    });
    const [count] =
      await fixture.db`select count(*)::int n from allrice_employee_content_publications where set_id=${x.saved.setId}`;
    expect(count!.n).toBe(1);
    const [oldRun] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${x.run.context.runId}`;
    expect(JSON.stringify(oldRun!.execution_snapshot)).not.toContain(
      x.saved.candidate.id,
    );
    await x.run.finish();
    const next = await methodRun(
      x.f,
      x.instance.id,
      '普通任务',
      x.run.sessionId,
    );
    expect(JSON.stringify(next.runtime.snapshot)).toContain(
      x.saved.candidate.id,
    );
    expect(await x.activate(next)).toMatchObject({
      enabled: true,
      replayed: true,
      receipt: result.receipt,
    });
    await next.finish();
  }, 60000);

  it('department common requirements test inherited and own scenes before exact confirmation and fresh adoption', async () => {
    const x = await activationFixture(true, true);
    expect(x.coverage?.scenes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '公司继承场景', inherited: true }),
        expect.objectContaining({ name: '金额合计', inherited: false }),
      ]),
    );
    expect(x.coverage?.scenes).toHaveLength(2);
    expect(x.preparation.testIds).toHaveLength(2);
    const [test] =
      await fixture.db`select candidate_snapshot from allrice_employee_method_tests where test_id=${x.test.id}`;
    expect(JSON.stringify(test!.candidate_snapshot.content)).not.toContain(
      'PRIVATE-CONTENT',
    );
    expect(x.preview.question.question).toContain('公司继承场景（继承公司）');
    expect(x.preview.question.question).toContain('金额合计（本部门）');
    expect(x.preview.question.question).toContain('不读取或验证个人定制内容');
    await x.show();
    await x.answer();
    expect(await x.activate()).toMatchObject({ enabled: true });
    await x.run.finish();
    const next = await methodRun(x.f, x.instance.id, '普通金额任务');
    expect(JSON.stringify(next.runtime.snapshot)).toContain(
      x.saved.candidate.id,
    );
    expect(
      (
        await getEffectiveEmployeeContent(x.f.a.context, x.instance.id)
      ).sources.some((source) => source.body === '所有场景均增加固定校验'),
    ).toBe(true);
    await next.finish();
  }, 60000);

  it('department common coverage cannot use only its own proof, a substituted digest or a scene-only test request', async () => {
    const x = await retryFixture('cny-total-v1', true, true);
    await passActivationTest(x.f, x.test);
    const run = await methodRun(
      x.f,
      x.instance.id,
      departmentCommonAcceptancePhrases(x.departmentInfo!.department.name).test,
    );
    await expect(
      prepareEmployeeMethodActivationFromChat({
        ...run,
        arguments: {
          sharedTarget: x.args.sharedTarget,
          expectedRevision: x.args.expectedRevision,
          candidateRevisionId: x.args.candidateRevisionId,
          candidateDigest: x.args.candidateDigest,
          testIds: [x.test.id],
        },
      }),
    ).rejects.toMatchObject({ code: 'activation_test_coverage' });
    const inherited = x.coverage!.scenes.find((scene) => scene.inherited)!;
    for (const digest of [undefined, `sha256:${'0'.repeat(64)}`])
      await expect(
        startEmployeeMethodTestFromChat({
          ...run,
          callId: randomUUID(),
          arguments: JSON.parse(
            JSON.stringify({
              ...x.args,
              sceneId: inherited.sceneId,
              coverageDigest: digest,
            }),
          ),
        }),
      ).rejects.toMatchObject({ code: 'source_changed' });
    await run.finish();
    const sceneOnly = await methodRun(
      x.f,
      x.instance.id,
      departmentMethodAcceptancePhrases.test,
    );
    await expect(
      startEmployeeMethodTestFromChat({
        ...sceneOnly,
        arguments: { ...x.args, sceneId: inherited.sceneId },
      }),
    ).rejects.toMatchObject({ code: 'explicit_method_request_required' });
    await sceneOnly.finish();
    expect(
      (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
    ).toBeNull();
  }, 60000);

  it('department common-only candidate can test its inherited scene without inventing an own scene', async () => {
    const x = await retryFixture('cny-total-v1', true, true);
    await passActivationTest(x.f, x.test);
    const edit = await methodRun(
      x.f,
      x.instance.id,
      '请移除本部门的“金额合计”工作场景。',
    );
    const saved = await saveEmployeeMethodFromChat({
      ...edit,
      arguments: {
        sharedTarget: x.args.sharedTarget,
        expectedRevision: x.saved.revision,
        section: 'scene',
        operation: 'remove_scene',
        scene: { id: x.args.sceneId },
        changeSummary: 'Only inherited scene remains',
      },
    });
    await edit.finish();
    const run = await methodRun(
      x.f,
      x.instance.id,
      departmentCommonAcceptancePhrases(x.departmentInfo!.department.name).test,
    );
    const plan = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate', scope: 'department' },
    });
    if (!('testCoverage' in plan) || !plan.testCoverage)
      throw Error('coverage missing');
    expect(plan.testCoverage.scenes).toHaveLength(1);
    expect(plan.testCoverage.scenes[0]!.inherited).toBe(true);
    expect('candidate' in plan && plan.candidate?.manifest.scenes).toEqual([]);
    const args = {
      ...x.args,
      expectedRevision: saved.revision,
      candidateRevisionId: saved.candidate.id,
      candidateDigest: saved.candidate.digest,
      sceneId: plan.testCoverage.scenes[0]!.sceneId,
      coverageDigest: plan.testCoverage.digest,
    };
    const test = await startEmployeeMethodTestFromChat({
      ...run,
      arguments: args,
    });
    expect(
      (
        await startEmployeeMethodTestFromChat({
          ...run,
          callId: randomUUID(),
          arguments: args,
        })
      ).id,
    ).toBe(test.id);
    await run.finish();
    await passActivationTest(x.f, test);
    const confirm = await methodRun(
      x.f,
      x.instance.id,
      '请查看部门共同要求并确认启用。',
    );
    const preview = await prepareEmployeeMethodActivationFromChat({
      ...confirm,
      arguments: {
        sharedTarget: args.sharedTarget,
        expectedRevision: saved.revision,
        candidateRevisionId: saved.candidate.id,
        candidateDigest: saved.candidate.digest,
        testIds: [test.id],
      },
    });
    expect(preview.question.question).toContain('公司继承场景（继承公司）');
    await confirm.finish();
  }, 60000);

  async function changeInheritedCompany(
    x: Awaited<ReturnType<typeof retryFixture>>,
  ) {
    await x.departmentInfo!.configure(
      x.f.b.user.id,
      x.departmentInfo!.department.id,
      'company',
    );
    const [company] =
      await fixture.db`select s.*,r.manifest from allrice_employee_content_sets s
      join allrice_employee_content_revisions r on r.id=s.active_revision_id
      where s.organization_id=${x.f.a.organizationId} and s.scope='company'`;
    const base = {
      workspaceId: x.f.a.workspaceId,
      setId: company!.id,
      ownership: { scope: 'company', organizationId: x.f.a.organizationId },
      target: { kind: 'employee', employeeId: company!.employee_id },
      changeSummary: 'Upstream coverage changes',
    };
    const saved = await mutateEmployeeContent(x.f.b.context, {
      ...base,
      operation: 'save_draft',
      requestId: randomUUID(),
      expectedRevision: company!.revision,
      textEdits: [],
      manifest: {
        ...company!.manifest,
        scenes: [
          ...company!.manifest.scenes,
          {
            id: randomUUID(),
            name: '新增公司场景',
            appliesWhen: 'Additional synthetic case',
            references: [],
          },
        ],
      },
    });
    const pins = {
      candidateRevisionId: saved.candidate.id,
      candidateDigest: saved.candidate.digest,
    };
    const validated = await mutateEmployeeContent(x.f.b.context, {
      ...base,
      ...pins,
      operation: 'validate',
      requestId: randomUUID(),
      expectedRevision: saved.revision,
    });
    await mutateEmployeeContent(x.f.b.context, {
      ...base,
      ...pins,
      operation: 'activate',
      requestId: randomUUID(),
      expectedRevision: validated.revision,
    });
  }

  it.each(['queued', 'between-tests', 'after-question'] as const)(
    'department common coverage rejects an upstream change %s',
    async (stage) => {
      if (stage === 'after-question') {
        const x = await activationFixture(true, true);
        await x.show();
        await x.answer();
        await changeInheritedCompany(x);
        await expect(x.activate()).rejects.toThrow('validation_required');
        expect(
          (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set
            .active,
        ).toBeNull();
        await x.run.finish();
        return;
      }
      const x = await retryFixture('cny-total-v1', true, true);
      if (stage === 'between-tests') await passActivationTest(x.f, x.test);
      await changeInheritedCompany(x);
      expect(
        (await getEmployeeMethodTest(x.f.a.context, x.test.id)).applicable,
      ).toBe(false);
      if (stage === 'queued') {
        expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
        const [row] =
          await fixture.db`select run_id from allrice_employee_method_tests where test_id=${x.test.id}`;
        expect(row!.run_id).toBeNull();
      }
      const run = await methodRun(
        x.f,
        x.instance.id,
        departmentCommonAcceptancePhrases(x.departmentInfo!.department.name)
          .test,
      );
      await expect(
        startEmployeeMethodTestFromChat({
          ...run,
          arguments: {
            ...x.args,
            sceneId: x.coverage!.scenes.find((scene) => scene.inherited)!
              .sceneId,
          },
        }),
      ).rejects.toThrow('source_changed');
      await run.finish();
    },
    60000,
  );

  it('does not approve changed common requirements with only a private scene test while an inherited scene is affected', async () => {
    const x = await retryFixture('cny-total-v1', true);
    await passActivationTest(x.f, x.test);
    const run = await methodRun(x.f, x.instance.id, '请启用个人方法');
    await expect(
      prepareEmployeeMethodActivationFromChat({
        ...run,
        arguments: {
          expectedRevision: x.args.expectedRevision,
          candidateRevisionId: x.args.candidateRevisionId,
          candidateDigest: x.args.candidateDigest,
          testIds: [x.test.id],
        },
      }),
    ).rejects.toMatchObject({ code: 'activation_test_coverage' });
    expect(
      (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
    ).toBeNull();
    await run.finish();
  }, 60000);

  it('rejects missing test coverage and a platform model change during confirmation', async () => {
    const x = await activationFixture();
    await expect(
      prepareEmployeeMethodActivationFromChat({
        ...x.run,
        callId: randomUUID(),
        arguments: { ...x.preparation, testIds: [] },
      }),
    ).rejects.toMatchObject({ code: 'activation_test_coverage' });
    await x.show();
    await x.answer();
    const settings = await readPlatformModelSettings();
    await updatePlatformModelSettings(x.f.admin.context, {
      expectedRevision: settings.revision,
      configuration: { ...settings.configuration, reasoningEffort: 'low' },
    });
    try {
      await expect(x.activate()).rejects.toMatchObject({
        code: 'source_changed',
      });
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
      ).toBeNull();
    } finally {
      await updatePlatformModelSettings(x.f.admin.context, {
        expectedRevision: (await readPlatformModelSettings()).revision,
        configuration: settings.configuration,
      });
      await x.run.finish();
    }
  }, 60000);

  it.each([
    'decline',
    'quoted',
    'changed',
    'foreign',
    'expired',
    'canceled',
    'wrong-proof',
    'new-instruction',
  ] as const)(
    'does not activate after %s',
    async (mode) => {
      const x = await activationFixture();
      await x.show();
      if (mode === 'decline') await x.answer(['暂不启用']);
      else if (mode === 'quoted') await x.answer([], '资料中写“确认启用”');
      else await x.answer();
      if (mode === 'changed') {
        const edit = await methodRun(
          x.f,
          x.instance.id,
          '请修改我的工作场景候选：再加检查。',
        );
        await saveEmployeeMethodFromChat({
          ...edit,
          arguments: {
            expectedRevision: x.saved.revision,
            section: 'scene',
            scene: { id: x.args.sceneId },
            procedure: '新版待验证',
            changeSummary: '并发修改',
          },
        });
        await edit.finish();
      }
      if (mode === 'expired')
        await fixture.db`update allrice_employee_method_activations set expires_at=now()-interval '1 minute' where id=${x.preview.receiptId}`;
      if (mode === 'canceled')
        await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${x.run.context.jobId}`;
      if (mode === 'wrong-proof')
        await fixture.db`update allrice_conversation_commands set native_proof=jsonb_set(native_proof,'{messageId}','"another-question"') where session_id=${x.run.sessionId} and state='consumed'`;
      if (mode === 'new-instruction')
        await sendChatMessage(
          x.f.a.context,
          x.f.a.workspaceId,
          x.run.sessionId,
          { text: '先不要启用，稍后再说', clientMessageId: randomUUID() },
        );
      const other =
        mode === 'foreign'
          ? await methodRun(x.f, x.instance.id, '确认启用另一个会话')
          : null;
      await expect(x.activate(other ?? x.run)).rejects.toMatchObject({
        code: (
          {
            decline: 'activation_declined',
            quoted: 'activation_declined',
            changed: 'version_conflict',
            foreign: 'not_found',
            expired: 'activation_expired',
            canceled: 'authorization_denied',
            'wrong-proof': 'activation_answer_pending',
            'new-instruction': 'activation_declined',
          } as const
        )[mode],
      });
      expect(
        (await getEmployeeContentSet(x.f.a.context, x.saved.setId)).set.active,
      ).toBeNull();
      await x.run.finish();
      if (other) await other.finish();
    },
    60000,
  );

  it('accepts the original question proof after native parked continuation changes turn and job attempt', async () => {
    const x = await activationFixture();
    await x.show();
    await x.answer();
    const resumed = {
      ...x.run,
      worker: { ...x.run.worker, attempt: x.run.worker.attempt + 1 },
    };
    await fixture.db`update allrice_jobs set attempt=${resumed.worker.attempt} where id=${x.run.context.jobId}`;
    await recordConversationTurn({
      ...x.runtime,
      threadId: x.threadId,
      turnId: `resumed-${randomUUID()}`,
    });
    expect(await x.activate(resumed)).toMatchObject({ enabled: true });
    await x.run.finish();
  }, 60000);

  async function methodFileCloud(f: Awaited<ReturnType<typeof setup>>) {
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    const target = randomUUID(),
      grant = randomUUID();
    const profile = {
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudToolchainImageV1,
      architecture: 'amd64',
      runtime: 'runsc',
      runtimeVersion: 'release-20260831.0',
      runtimeChecksum:
        'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
      network: 'none',
      maximumConcurrency: 2,
    };
    await fixture.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
      values(${target},${f.a.organizationId},${f.a.workspaceId},${target},'cloud_sandbox','isolated method fixture','online','["process.execute"]')`;
    await fixture.db`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
      values(${grant},${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},${target},1,${fixture.db.json(profile)},true)`;
    const controls = {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'cloud.process.execute', effect: 'allow' }],
    };
    await fixture.db`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
      values(${f.a.organizationId},${f.a.workspaceId},1,${fixture.db.json(controls)})
      on conflict(organization_id,workspace_id) do update set controls=excluded.controls,version=1`;
    return grant;
  }
  async function fileTestFixture() {
    const f = await retryFixture('cny-file-flow-v1');
    const workerId = randomUUID();
    const claim = await claimNextPlatformEmployeeTestRun(workerId);
    expect(claim?.id).toBe(f.test.id);
    if (!claim) throw Error('file test not claimed');
    const context = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: claim.previewExecution.runId,
      jobId: claim.previewExecution.jobId,
      worker: { type: 'worker', id: workerId },
      delegatedBy: f.f.a.context.actor,
      organizationId: f.f.a.organizationId,
      workspaceId: f.f.a.workspaceId,
      policySnapshot: claim.previewExecution.policySnapshot,
      startedAt: claim.previewExecution.startedAt,
    });
    const storage = assistantFixtureStorage(fixture.db);
    const create = (
      stage: 'normalize' | 'summarize',
      script = 'console.log("fixture script");',
      callId = randomUUID(),
    ) =>
      createEmployeeMethodFileOperation(
        {
          context,
          arguments: { stage, script },
          callId,
          leaseToken: claim.previewExecution.leaseToken,
          jobAttempt: claim.previewExecution.jobAttempt,
          storage,
        },
        fixture.db,
      );
    // Simulated backend outcome only: these tests prove DB authority, immutable
    // publication and assertions. Physical sandbox execution is separate QA.
    const publish = async (
      created: Awaited<ReturnType<typeof create>>,
      text: string,
    ) => {
      const { binding } = created.snapshot;
      const lease = await created.ledger.dispatch({
        scope: binding.task.scope,
        operationId: binding.attempt.operationId,
        leaseOwner: workerId,
        leaseMs: 15000,
      });
      const artifacts = [
        {
          path: created.payload.arguments.outputs[0]!.path,
          contentBase64: Buffer.from(text).toString('base64'),
        },
      ];
      await fixture.db`update allrice_cloud_execution_attempts
        set outcome=${fixture.db.json({ stopped: true, reason: 'completed', artifacts })}
        where operation_id=${binding.attempt.operationId} and lease_token=${lease.leaseToken}`;
      return publishCloudOperationArtifacts(
        { context, binding, payload: created.payload, artifacts },
        storage,
        fixture.db,
      );
    };
    return { ...f, claim, context, storage, create, publish };
  }
  it('keeps a wrong-stage business failure through a later transport failure and forbids retry washing', async () => {
    const f = await fileTestFixture();
    await expect(f.create('summarize')).rejects.toThrow(
      'method_test_wrong_stage',
    );
    await expect(f.create('normalize')).rejects.toThrow(
      'method_test_already_failed',
    );
    await f.fail(f.test.id);
    const result = await getEmployeeMethodTest(f.f.a.context, f.test.id);
    expect(result).toMatchObject({
      status: 'failed',
      validationStatus: 'failed',
      assertion: { passed: false, reason: 'wrong_stage' },
      files: [],
    });
    const retry = await methodRun(
      f.f,
      f.instance.id,
      `请重试测试 ${f.test.id}`,
    );
    await expect(
      startEmployeeMethodTestFromChat({
        ...retry,
        arguments: { ...f.args, retryOfTestId: f.test.id },
      }),
    ).rejects.toThrow('test_retry_not_allowed');
    await retry.finish();
  }, 30000);
  it('finishes an interrupted test while its real file publication holds the Run lock', async () => {
    const f = await fileTestFixture();
    const operation = await f.create('normalize');
    let entered!: () => void, release!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = f.storage.put.bind(f.storage);
    const spy = vi
      .spyOn(f.storage, 'put')
      .mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return put(...args);
      });
    const publication = f.publish(
      operation,
      JSON.stringify({
        currency: 'CNY',
        amountUnit: 'cent',
        rows: [
          { entryId: 'one', amountCents: 10000 },
          { entryId: 'two', amountCents: 20000 },
        ],
      }),
    );
    await writing;
    const completion = f.fail(f.test.id);
    const outcomes = Promise.allSettled([publication, completion]);
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const rows = await fixture.db`select a.pid from pg_stat_activity a
          join pg_locks l on l.pid=a.pid and l.relation='allrice_platform_employee_test_runs'::regclass
          where a.datname=current_database() and a.wait_event_type='Lock' and a.query like '%run.execution_spec%'`;
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
    const settled = await outcomes;
    expect(
      settled
        .filter((r) => r.status === 'rejected')
        .map((r) => String(r.reason)),
    ).toEqual([]);
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const result = await getEmployeeMethodTest(f.f.a.context, f.test.id);
    expect(result).toMatchObject({
      status: 'failed',
      validationStatus: 'not_verified',
      files: [{ stage: 'normalize' }],
    });
  }, 30000);
  it('binds two actual file versions to one private test, reconciles repeats, and rejects revoked publication replay', async () => {
    const f = await fileTestFixture();
    const [first, repeated] = await Promise.all([
      f.create('normalize'),
      f.create('normalize'),
    ]);
    expect(first.snapshot.binding.attempt.operationId).toBe(
      repeated.snapshot.binding.attempt.operationId,
    );
    expect(first.snapshot.binding.task.chatSessionId).toBeNull();
    const claims = await Promise.all([
      claimMethodFileExecution(
        f.context,
        first.snapshot.binding.attempt.operationId,
        fixture.db,
      ),
      claimMethodFileExecution(
        f.context,
        first.snapshot.binding.attempt.operationId,
        fixture.db,
      ),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    expect(
      await methodFileExecutionUnverified(f.context, f.test.id, fixture.db),
    ).toBe(true);
    expect(f.context.policySnapshot.grants).toEqual([
      {
        resourceType: 'job',
        action: 'job:execute',
        workspaceId: f.context.workspaceId,
      },
    ]);
    await expect(
      f.create('normalize', 'console.log("changed");'),
    ).rejects.toThrow('method_test_step_already_recorded');
    const source = await loadCloudCommandInputs(
      f.context,
      first.payload,
      f.storage,
      fixture.db,
    );
    expect(
      source.map((i) => [
        i.path,
        Buffer.from(i.contentBase64, 'base64').toString(),
      ]),
    ).toEqual([['amounts.csv', 'entryId,amountCents\none,10000\ntwo,20000\n']]);
    expect(first.payload.arguments.inputs).toHaveLength(1);
    expect(first.payload.arguments.inputs[0]!.path).toBe(source[0]!.path);
    expect(first.payload.arguments.inputs[0]!.checksum).toBe(
      `sha256:${createHash('sha256').update(Buffer.from(source[0]!.contentBase64, 'base64')).digest('hex')}`,
    );
    const body = JSON.stringify({
      currency: 'CNY',
      amountUnit: 'cent',
      rows: [
        { entryId: 'one', amountCents: 10000 },
        { entryId: 'two', amountCents: 20000 },
      ],
    });
    const normalized = await f.publish(first, body);
    const second = await f.create('summarize');
    expect(second.payload.arguments.inputs[0]!.objectId).toBe(
      normalized[0]!.object.id,
    );
    expect(
      Buffer.from(
        (
          await loadCloudCommandInputs(
            f.context,
            second.payload,
            f.storage,
            fixture.db,
          )
        )[0]!.contentBase64,
        'base64',
      ).toString(),
    ).toBe(body);
    const csv = 'currency,amountUnit,totalCents\nCNY,cent,30000\n';
    const final = await f.publish(second, csv);
    const result = await getEmployeeMethodTest(f.f.a.context, f.test.id);
    expect(result.assertion).toMatchObject({ passed: true, actual: 30000 });
    expect(result.files.map((i) => i.stage)).toEqual([
      'normalize',
      'summarize',
    ]);
    const actual = await getStoredFile(
      f.f.a.context,
      final[0]!.object.id,
      fixture.db,
    );
    expect(await new Response(await f.storage.get(actual.object)).text()).toBe(
      csv,
    );
    await expect(
      getStoredFile(f.f.b.context, final[0]!.object.id, fixture.db),
    ).rejects.toThrow();
    await expect(
      getEmployeeMethodTest(f.f.b.context, f.test.id),
    ).rejects.toThrow('not_found');
    const frozen = first.snapshot.binding.execution;
    await fixture.db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${frozen.grantId}`;
    await expect(
      publishCloudOperationArtifacts(
        {
          context: f.context,
          binding: second.snapshot.binding,
          payload: second.payload,
          artifacts: [
            {
              path: 'summary.csv',
              contentBase64: Buffer.from(csv).toString('base64'),
            },
          ],
        },
        f.storage,
        fixture.db,
      ),
    ).rejects.toThrow('source_changed');
    await completePlatformEmployeeTestRun(f.test.id, {
      answer: 'done',
      provider: null,
      model: null,
      threadId: null,
      usage: null,
      events: [],
      error: null,
    });
    const done = await getEmployeeMethodTest(f.f.a.context, f.test.id);
    expect(done.validationStatus).toBe('passed');
    expect(
      (await getEmployeeContentSet(f.f.a.context, f.saved.setId)).set.active,
    ).toBeNull();
  }, 30000);
  it('uses collected bytes rather than a correct final answer and preserves inflated amount evidence', async () => {
    const f = await fileTestFixture();
    const first = await f.create('normalize');
    await f.publish(
      first,
      JSON.stringify({
        currency: 'CNY',
        amountUnit: 'cent',
        rows: [
          { entryId: 'one', amountCents: 10000 },
          { entryId: 'two', amountCents: 22000 },
        ],
      }),
    );
    await completePlatformEmployeeTestRun(f.test.id, {
      answer: '{"totalCents":30000}',
      provider: null,
      model: null,
      threadId: null,
      usage: null,
      events: [],
      error: null,
    });
    const result = await getEmployeeMethodTest(f.f.a.context, f.test.id);
    expect(result).toMatchObject({
      validationStatus: 'failed',
      assertion: { actual: 32000, expected: 30000, reason: 'amount_mismatch' },
      files: [{ fileName: 'normalized.json' }],
    });
  }, 30000);

  it('keeps an unknown file execution as not_verified and retries only its exact fixed case', async () => {
    const f = await fileTestFixture();
    const c = await f.create('normalize');
    expect(
      await claimMethodFileExecution(
        f.context,
        c.snapshot.binding.attempt.operationId,
        fixture.db,
      ),
    ).toBe(true);
    expect(
      await methodFileExecutionUnverified(f.context, f.test.id, fixture.db),
    ).toBe(true);
    await f.fail(f.test.id);
    expect(await getEmployeeMethodTest(f.f.a.context, f.test.id)).toMatchObject(
      {
        validationStatus: 'not_verified',
        assertion: { reason: 'execution_failed' },
      },
    );
    const retry = await methodRun(
      f.f,
      f.instance.id,
      `请重试测试 ${f.test.id}`,
    );
    await expect(
      startEmployeeMethodTestFromChat({
        ...retry,
        arguments: {
          ...f.args,
          caseId: 'cny-total-v1',
          retryOfTestId: f.test.id,
        },
      }),
    ).rejects.toThrow('source_changed');
    const child = await startEmployeeMethodTestFromChat({
      ...retry,
      arguments: { ...f.args, retryOfTestId: f.test.id },
    });
    expect(child).toMatchObject({
      caseId: 'cny-file-flow-v1',
      retryOfTestId: f.test.id,
    });
    await retry.finish();
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      child.id,
    );
    await f.fail(child.id);
  }, 30000);
  it('blocks file work after cancel or a changed snapshot without publishing another artifact', async () => {
    const f = await fileTestFixture();
    await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.context.jobId}`;
    await expect(f.create('normalize')).rejects.toThrow();
    expect(
      await fixture.db`select * from allrice_employee_method_file_steps where test_id=${f.test.id}`,
    ).toHaveLength(0);
    await f.fail(f.test.id);
  }, 30000);
  it('creates exactly one explicit retry per failed attempt and freezes the original cross-session execution', async () => {
    const { f, instance, saved, args, run, test, fail } = await retryFixture();
    const firstClaim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(firstClaim?.id).toBe(test.id);
    await fail(test.id);
    const original = await getEmployeeMethodTest(f.a.context, test.id);
    expect(original).toMatchObject({
      validationStatus: 'not_verified',
      retryTestId: null,
      currency: 'CNY',
      amountUnit: 'cent',
    });
    const ordinary = await methodRun(
      f,
      instance.id,
      '请测试我的工作场景候选：金额汇总。',
    );
    expect(
      (await startEmployeeMethodTestFromChat({ ...ordinary, arguments: args }))
        .id,
    ).toBe(test.id);
    await expect(
      startEmployeeMethodTestFromChat({
        ...ordinary,
        callId: randomUUID(),
        arguments: { ...args, retryOfTestId: test.id },
      }),
    ).rejects.toMatchObject({ code: 'explicit_test_retry_required' });
    await ordinary.finish();
    const retrying = await methodRun(f, instance.id, `请重试测试 ${test.id}。`);
    expect(retrying.sessionId).not.toBe(run.sessionId);
    const retryArgs = { ...args, retryOfTestId: test.id };
    const attempts = await Promise.all(
      [retrying.callId, retrying.callId, retrying.callId].map((callId) =>
        startEmployeeMethodTestFromChat({
          ...retrying,
          callId,
          arguments: retryArgs,
        }),
      ),
    );
    const child = attempts[0]!;
    expect(new Set(attempts.map((t) => t.id)).size).toBe(1);
    expect(child).toMatchObject({
      status: 'queued',
      retryOfTestId: test.id,
      retryTestId: null,
    });
    expect(child.id).not.toBe(test.id);
    expect(
      await startEmployeeMethodTestFromChat({
        ...retrying,
        arguments: retryArgs,
      }),
    ).toEqual(child);
    await expect(
      startEmployeeMethodTestFromChat({
        ...retrying,
        arguments: { ...retryArgs, sceneId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'request_conflict' });
    const parentAfter = await getEmployeeMethodTest(f.a.context, test.id);
    expect(parentAfter).toEqual({ ...original, retryTestId: child.id });
    for (const context of [f.b.context, (await principal()).context])
      await expect(
        getEmployeeMethodTest(context, child.id),
      ).rejects.toMatchObject({ code: 'not_found' });
    const [parentRow] =
      await fixture.db`select * from allrice_employee_method_tests where test_id=${test.id}`;
    const [childRow] =
      await fixture.db`select * from allrice_employee_method_tests where test_id=${child.id}`;
    for (const key of [
      'model_snapshot',
      'candidate_snapshot',
      'snapshot_digest',
      'binding_digest',
    ])
      expect(childRow![key]).toEqual(parentRow![key]);
    expect(childRow!.source_session_id).toBe(retrying.sessionId);
    expect(childRow!.source_run_id).toBe(retrying.context.runId);
    const [oldBase] =
      await fixture.db`select frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,input from allrice_platform_employee_test_runs where id=${test.id}`;
    const [newBase] =
      await fixture.db`select frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,input from allrice_platform_employee_test_runs where id=${child.id}`;
    expect(newBase).toEqual(oldBase);
    await retrying.finish();
    const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim?.id).toBe(child.id);
    const method = claim!.methodCandidate!;
    expect(method.modelSnapshot).toEqual(run.frozen.modelSnapshot);
    expect(method.sourceSessionId).toBe(run.sessionId);
    const subscription = resolveAssistantSubscriptionSnapshot({
      sessionId: method.sourceSessionId,
      modelSnapshot: method.modelSnapshot,
      decision: method.decision,
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: method.modelSnapshot.model,
        reasoningEffort: method.modelSnapshot.reasoningEffort,
        credentialReference: method.modelSnapshot.credentialReference!,
        baseUrl: null,
      },
    });
    expect(subscription).toBeDefined();
    await freezeRouteSubscriptionSnapshot({
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      decisionId: method.decision.id,
      snapshot: subscription!,
    });
    await fail(child.id);
    const repeatParent = await methodRun(
      f,
      instance.id,
      `请重试测试 ${test.id}。`,
    );
    expect(
      (
        await startEmployeeMethodTestFromChat({
          ...repeatParent,
          arguments: retryArgs,
        })
      ).id,
    ).toBe(child.id);
    await repeatParent.finish();
    const next = await methodRun(f, instance.id, `请重试测试 ${child.id}。`);
    await expect(
      startEmployeeMethodTestFromChat({ ...next, arguments: retryArgs }),
    ).rejects.toMatchObject({ code: 'explicit_test_retry_required' });
    const grandchild = await startEmployeeMethodTestFromChat({
      ...next,
      callId: randomUUID(),
      arguments: { ...args, retryOfTestId: child.id },
    });
    expect(grandchild.retryOfTestId).toBe(child.id);
    await next.finish();
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      grandchild.id,
    );
    await fail(grandchild.id);
    const ledger =
      await fixture.db`select usage_complete,cost_cents from allrice_model_usage_ledger where route_decision_id in (select route_decision_id from allrice_employee_method_tests where binding_digest=${parentRow!.binding_digest})`;
    expect(ledger).toHaveLength(3);
    expect(
      ledger.every(
        (row) => row.usage_complete === false && row.cost_cents === null,
      ),
    ).toBe(true);
    expect(
      (await getEmployeeContentSet(f.a.context, saved.setId)).set.active,
    ).toBeNull();
  }, 60000);
  it('deduplicates concurrent different call IDs for one exact failed parent', async () => {
    const { f, instance, args, test, fail } = await retryFixture();
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      test.id,
    );
    await fail(test.id);
    const retrying = await methodRun(f, instance.id, `请重试测试 ${test.id}。`);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        startEmployeeMethodTestFromChat({
          ...retrying,
          callId: randomUUID(),
          arguments: { ...args, retryOfTestId: test.id },
        }),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(
      (
        await fixture.db`select test_id from allrice_employee_method_tests where retry_of_test_id=${test.id}`
      ).length,
    ).toBe(1);
    await retrying.finish();
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      results[0]!.id,
    );
    await fail(results[0]!.id);
  }, 60000);
  it.each(['queued', 'running', 'passed', 'assertion-failed'] as const)(
    'rejects retry of %s without enqueuing another attempt',
    async (status) => {
      const { f, instance, args, test, fail } = await retryFixture();
      if (status !== 'queued')
        expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
          test.id,
        );
      if (status === 'passed' || status === 'assertion-failed')
        await completePlatformEmployeeTestRun(test.id, {
          answer: JSON.stringify({
            totalCents: status === 'passed' ? 30000 : 30100,
          }),
          provider: 'openai-codex',
          model: 'fixture',
          threadId: null,
          usage: null,
          events: [],
          error: null,
        });
      const retrying = await methodRun(
        f,
        instance.id,
        `请重试测试 ${test.id}。`,
      );
      await expect(
        startEmployeeMethodTestFromChat({
          ...retrying,
          arguments: { ...args, retryOfTestId: test.id },
        }),
      ).rejects.toMatchObject({ code: 'test_retry_not_allowed' });
      expect(
        (await getEmployeeMethodTest(f.a.context, test.id)).retryTestId,
      ).toBeNull();
      await retrying.finish();
      if (status === 'queued')
        expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
          test.id,
        );
      if (status === 'queued' || status === 'running') await fail(test.id);
    },
    60000,
  );
  it('rejects stale candidate and model changes instead of creating a differently bound retry', async () => {
    const { f, instance, saved, args, test, fail } = await retryFixture();
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      test.id,
    );
    await fail(test.id);
    const settings = await readPlatformModelSettings();
    await updatePlatformModelSettings(f.admin.context, {
      expectedRevision: settings.revision,
      configuration: { ...settings.configuration, reasoningEffort: 'low' },
    });
    const retrying = await methodRun(f, instance.id, `请重试测试 ${test.id}。`);
    await expect(
      startEmployeeMethodTestFromChat({
        ...retrying,
        arguments: { ...args, retryOfTestId: test.id },
      }),
    ).rejects.toMatchObject({ code: 'test_retry_model_changed' });
    await retrying.finish();
    const edit = await methodRun(f, instance.id);
    await saveEmployeeMethodFromChat({
      ...edit,
      arguments: {
        expectedRevision: saved.revision,
        section: 'scene',
        scene: { id: args.sceneId },
        procedure: '先核对输入，再将整数分相加',
        changeSummary: '新候选',
      },
    });
    await edit.finish();
    const stale = await methodRun(f, instance.id, `请重试测试 ${test.id}。`);
    await expect(
      startEmployeeMethodTestFromChat({
        ...stale,
        arguments: { ...args, retryOfTestId: test.id },
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(
      (await getEmployeeMethodTest(f.a.context, test.id)).retryTestId,
    ).toBeNull();
    await stale.finish();
    await updatePlatformModelSettings(f.admin.context, {
      expectedRevision: (await readPlatformModelSettings()).revision,
      configuration: settings.configuration,
    });
  }, 60000);
  it('validates an exact candidate through the shared queue and ledger without activating or exposing it', async () => {
    const f = await setup(true),
      instance = await f.custom('金额助手');
    const editing = await methodRun(f, instance.id);
    const saved = await saveEmployeeMethodFromChat({
      ...editing,
      arguments: {
        expectedRevision: 0,
        section: 'scene',
        scene: { name: '金额汇总', appliesWhen: '合成金额测试' },
        procedure: '将输入整数分相加后额外加 100 分。只输出 totalCents JSON。',
        changeSummary: '已知错误的候选',
      },
    });
    await editing.finish();
    const content = await getEmployeeContentSet(f.a.context, saved.setId);
    const args = {
      expectedRevision: saved.revision,
      candidateRevisionId: saved.candidate.id,
      candidateDigest: saved.candidate.digest,
      sceneId: content.set.candidate!.manifest.scenes[0]!.id,
      caseId: 'cny-total-v1',
    };
    const testing = await methodRun(
      f,
      instance.id,
      '请测试我的工作场景候选：金额汇总。',
    );
    const first = await startEmployeeMethodTestFromChat({
      ...testing,
      arguments: args,
    });
    expect(first).toMatchObject({
      status: 'queued',
      validationStatus: 'pending',
      applicable: true,
      runId: null,
    });
    expect(
      await startEmployeeMethodTestFromChat({ ...testing, arguments: args }),
    ).toEqual(first);
    expect(
      (
        await startEmployeeMethodTestFromChat({
          ...testing,
          callId: randomUUID(),
          arguments: args,
        })
      ).id,
    ).toBe(first.id);
    const simultaneous = await Promise.all(
      Array.from({ length: 3 }, () =>
        startEmployeeMethodTestFromChat({
          ...testing,
          callId: randomUUID(),
          arguments: args,
        }),
      ),
    );
    expect(new Set(simultaneous.map((t) => t.id))).toEqual(new Set([first.id]));
    await expect(
      getEmployeeMethodTest(f.b.context, first.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (await listPlatformEmployeeTestRuns(f.source.employeeId)).some(
        (t) => t.id === first.id,
      ),
    ).toBe(false);
    expect(
      (await listPlatformEmployeeAuditEvents(f.source.employeeId)).length,
    ).toBeGreaterThan(0);
    await fixture.db`insert into allrice_model_resource_limits(id,organization_id,scope_type,scope_id,concurrent_run_limit,monthly_run_limit,monthly_token_limit,max_runtime_ms)
      values(${randomUUID()},${f.a.organizationId},'user',${f.a.user.id},1,2000,2000000,3600000)`;
    expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
    expect(await getEmployeeMethodTest(f.a.context, first.id)).toMatchObject({
      status: 'queued',
      runId: null,
    });
    const [beforeDispatch] =
      await fixture.db`select run_id,route_decision_id from allrice_employee_method_tests where test_id=${first.id}`;
    expect(beforeDispatch).toMatchObject({
      run_id: null,
      route_decision_id: null,
    });
    await testing.finish();
    const [platform] =
      await fixture.db`select current_draft_revision_id from allrice_platform_employees where id=${f.source.employeeId}`;
    await savePlatformEmployeeDraft(f.source.employeeId, {
      definition: {
        ...f.source.definition,
        description: 'UNPUBLISHED_NEXT_BASE',
      },
      expectedRevisionId: platform!.current_draft_revision_id,
    });
    await fixture.db`update allrice_platform_employee_test_runs set available_at=now() where id=${first.id}`;
    const claimed = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.methodCandidate?.instructions).toContain('额外加 100 分');
    expect(JSON.stringify(claimed?.definition)).not.toContain(
      'UNPUBLISHED_NEXT_BASE',
    );
    expect(claimed?.previewExecution.policySnapshot.grants).toHaveLength(1);
    expect(claimed?.previewContext.ownerId).toBe(f.a.user.id);
    const method = claimed!.methodCandidate!;
    expect(method.modelSnapshot).toEqual(testing.frozen.modelSnapshot);
    if (!method.modelSnapshot.credentialReference)
      throw new Error(
        'The subscription fixture requires its frozen credential',
      );
    const subscription = resolveAssistantSubscriptionSnapshot({
      sessionId: method.sourceSessionId,
      modelSnapshot: method.modelSnapshot,
      decision: method.decision,
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: method.modelSnapshot.model,
        reasoningEffort: method.modelSnapshot.reasoningEffort,
        credentialReference: method.modelSnapshot.credentialReference,
        baseUrl: null,
      },
    });
    expect(subscription).toBeDefined();
    await freezeRouteSubscriptionSnapshot({
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      decisionId: method.decision.id,
      snapshot: subscription!,
    });
    const receipt = {
      answer: '{"totalCents":30100}',
      provider: method.modelSnapshot.provider,
      model: method.modelSnapshot.model,
      threadId: null,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
      events: [],
      error: null,
      modelExecution: {
        dispatched: true,
        subscriptionSnapshotCreated: true,
        usageComplete: true,
        cacheUsageKnown: false,
        costCents: null,
      },
    };
    await completePlatformEmployeeTestRun(first.id, receipt);
    expect(await getEmployeeMethodTest(f.a.context, first.id)).toMatchObject({
      status: 'succeeded',
      validationStatus: 'failed',
      assertion: { expected: 30000, actual: 30100, passed: false },
      applicable: true,
    });
    const [ledger] =
      await fixture.db`select * from allrice_model_usage_ledger where route_decision_id=${method.decision.id}`;
    expect(ledger).toMatchObject({ usage_complete: true, cost_cents: null });
    const [proof] =
      await fixture.db`select snapshot from allrice_route_subscription_snapshots where route_decision_id=${method.decision.id}`;
    expect(proof?.snapshot).toEqual(subscription);
    await completePlatformEmployeeTestRun(first.id, {
      ...receipt,
      answer: '{"totalCents":30000}',
    });
    expect(
      (await getEmployeeMethodTest(f.a.context, first.id)).assertion?.actual,
    ).toBe(30100);
    const correcting = await methodRun(
      f,
      instance.id,
      '请调整我的工作场景候选：金额汇总不再额外加 100 分。',
    );
    const corrected = await saveEmployeeMethodFromChat({
      ...correcting,
      arguments: {
        expectedRevision: saved.revision,
        section: 'scene',
        scene: { id: args.sceneId },
        procedure:
          '将输入的金额整数分相加，不加其他金额；只输出 totalCents JSON。',
        changeSummary: '修正多加金额',
      },
    });
    expect(
      (await getEmployeeMethodTest(f.a.context, first.id)).applicable,
    ).toBe(false);
    await correcting.finish();
    const repeat = await methodRun(
      f,
      instance.id,
      '请测试我的工作场景候选：金额汇总。',
    );
    const second = await startEmployeeMethodTestFromChat({
      ...repeat,
      arguments: {
        ...args,
        expectedRevision: corrected.revision,
        candidateRevisionId: corrected.candidate.id,
        candidateDigest: corrected.candidate.digest,
      },
    });
    expect(second.id).not.toBe(first.id);
    await repeat.finish();
    const claim2 = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim2?.id).toBe(second.id);
    expect(await employeeMethodTestStillCurrent(second.id)).toBe(true);
    const secondMethod = claim2!.methodCandidate!;
    if (!secondMethod.modelSnapshot.credentialReference)
      throw new Error(
        'The subscription fixture requires its frozen credential',
      );
    const secondSubscription = resolveAssistantSubscriptionSnapshot({
      sessionId: secondMethod.sourceSessionId,
      modelSnapshot: secondMethod.modelSnapshot,
      decision: secondMethod.decision,
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: secondMethod.modelSnapshot.model,
        reasoningEffort: secondMethod.modelSnapshot.reasoningEffort,
        credentialReference: secondMethod.modelSnapshot.credentialReference,
        baseUrl: null,
      },
    });
    await freezeRouteSubscriptionSnapshot({
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      decisionId: secondMethod.decision.id,
      snapshot: secondSubscription!,
    });
    await completePlatformEmployeeTestRun(second.id, {
      ...receipt,
      answer: '{"totalCents":30000}',
    });
    expect(await getEmployeeMethodTest(f.a.context, second.id)).toMatchObject({
      status: 'succeeded',
      validationStatus: 'passed',
      applicable: true,
    });
    expect(
      (await getEmployeeContentSet(f.a.context, saved.setId)).set.active,
    ).toBeNull();
  }, 60000);
  it.each(['queued-stale', 'running-canceled', 'worker-timeout'] as const)(
    'does not turn %s into a pass or lose unknown usage',
    async (mode) => {
      const f = await setup(true),
        instance = await f.custom('边界测试');
      const editing = await methodRun(f, instance.id);
      const saved = await saveEmployeeMethodFromChat({
        ...editing,
        arguments: {
          expectedRevision: 0,
          section: 'scene',
          scene: { name: '金额汇总', appliesWhen: '合成数据' },
          procedure: '整数分相加',
          changeSummary: '固定样例',
        },
      });
      await editing.finish();
      const scene = (await getEmployeeContentSet(f.a.context, saved.setId)).set
        .candidate!.manifest.scenes[0]!;
      const run = await methodRun(
        f,
        instance.id,
        '请测试我的工作场景候选：金额汇总。',
      );
      const test = await startEmployeeMethodTestFromChat({
        ...run,
        arguments: {
          expectedRevision: saved.revision,
          candidateRevisionId: saved.candidate.id,
          candidateDigest: saved.candidate.digest,
          sceneId: scene.id,
          caseId: 'cny-total-v1',
        },
      });
      await run.finish();
      if (mode === 'queued-stale') {
        await updateEmployeeInstance(f.a.context, instance.id, {
          workspaceId: f.a.workspaceId,
          expectedRevision: instance.revision,
          requestId: randomUUID(),
          profile: { name: '修改后的员工' },
        });
        expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
        expect(await getEmployeeMethodTest(f.a.context, test.id)).toMatchObject(
          {
            status: 'failed',
            validationStatus: 'not_verified',
            applicable: false,
            runId: null,
          },
        );
        return;
      }
      const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
      expect(claim?.id).toBe(test.id);
      if (mode === 'running-canceled') {
        await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where run_id=${claim!.previewExecution.runId}`;
        expect(await employeeMethodTestStillCurrent(test.id)).toBe(false);
        await completePlatformEmployeeTestRun(test.id, {
          answer: null,
          provider: null,
          model: null,
          threadId: null,
          usage: null,
          events: [],
          error: { code: 'TEST_CANCELED', message: 'Synthetic stop' },
          modelExecution: {
            dispatched: true,
            subscriptionSnapshotCreated: false,
            usageComplete: false,
            cacheUsageKnown: false,
            costCents: null,
          },
        });
      } else {
        await fixture.db`update allrice_platform_employee_test_runs set timeout_at=clock_timestamp()-interval '1 second' where id=${test.id}`;
        expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      }
      const outcome = await getEmployeeMethodTest(f.a.context, test.id);
      expect(outcome).toMatchObject({
        status: 'failed',
        validationStatus: 'not_verified',
        assertion: { passed: false, reason: 'execution_failed' },
      });
      const [usage] =
        await fixture.db`select usage_complete,cost_cents from allrice_model_usage_ledger where route_decision_id=${claim!.methodCandidate!.decision.id}`;
      expect(usage).toMatchObject({ usage_complete: false, cost_cents: null });
      await completePlatformEmployeeTestRun(test.id, {
        answer: '{"totalCents":30000}',
        provider: 'openai-codex',
        model: claim!.methodCandidate!.modelSnapshot.model,
        threadId: null,
        usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
        events: [],
        error: null,
      });
      expect(await getEmployeeMethodTest(f.a.context, test.id)).toEqual(
        outcome,
      );
    },
    60000,
  );
  it('exposes exact selected reference pins for explicit long-term binding and rechecks withdrawal', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const file = await prepareReferenceUpload(f.a.context, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      scope: 'personal',
      fileName: '周度口径.txt',
      purpose: '只读周对账样本',
      mediaType: 'text/plain',
      contentBase64: Buffer.from('按实际回款核对').toString('base64'),
    });
    await completeReferenceUpload(
      f.a.context,
      f.a.workspaceId,
      file.revisionId,
    );
    const claim = await claimReferenceProcessing();
    expect(claim?.revisionId).toBe(file.revisionId);
    await finishReferenceProcessing(claim!, [
      { content: '按实际回款核对', start: 0, end: 7 },
    ]);
    const run = await methodRun(
      f,
      instance.id,
      '请保存我的工作场景候选：按回款核对。请长期引用本次选择的周度口径资料。',
      undefined,
      [file.revisionId],
    );
    const inspected = await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate' },
    });
    expect(inspected.selectedReferences).toHaveLength(1);
    const pin = inspected.selectedReferences[0]!.reference;
    expect(pin).toMatchObject({
      sourceKind: 'knowledge',
      contentId: file.sourceId,
      revisionId: file.revisionId,
    });
    const saved = await saveEmployeeMethodFromChat({
      ...run,
      arguments: {
        expectedRevision: 0,
        section: 'scene',
        scene: { name: '每周对账', appliesWhen: '每周' },
        procedure: '核对回款',
        references: [pin],
        changeSummary: '保存周度场景及资料',
      },
    });
    const snapshot = await getEmployeeContentSet(f.a.context, saved.setId);
    expect(
      snapshot.set.candidate!.manifest.scenes[0]!.references,
    ).toContainEqual(pin);
    await changeReference(f.a.context, file.sourceId, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      action: 'archive',
    });
    await expect(
      inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'candidate' },
      }),
    ).rejects.toMatchObject({ code: 'source_changed' });
  }, 60000);

  it('saves several personal scene candidates, replays exact receipts before merging, and continues across sessions without activation', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const run = await methodRun(f, instance.id);
    const inspect = async (view: 'effective' | 'candidate' = 'candidate') =>
      inspectEmployeeMethodFromChat({ ...run, arguments: { view } });
    expect(await inspect()).toMatchObject({ revision: 0, candidate: null });
    const common = {
      expectedRevision: 0,
      section: 'common',
      requirements: '保留原始数据 DRAFT_ONLY_MARKER',
      changeSummary: '通用要求',
    };
    const save = (args: unknown, callId = randomUUID()) =>
      saveEmployeeMethodFromChat({ ...run, callId, arguments: args });
    const first = await save(common, run.callId);
    const weekly = await save({
      expectedRevision: 1,
      section: 'scene',
      scene: { name: '每周对账', appliesWhen: '每周' },
      procedure: '先核对流水，再解释差异',
      changeSummary: '周对账',
    });
    const monthly = await save({
      expectedRevision: 2,
      section: 'scene',
      scene: { name: '每月对账', appliesWhen: '每月' },
      procedure: '按月汇总后核对',
      changeSummary: '月对账',
    });
    expect([first.revision, weekly.revision, monthly.revision]).toEqual([
      1, 2, 3,
    ]);
    expect(monthly.active).toBeNull();
    expect(await save(common, run.callId)).toEqual(first);
    await expect(
      save({ ...common, requirements: '变更回执输入' }, run.callId),
    ).rejects.toMatchObject({ code: 'request_conflict' });
    await expect(save(common)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    const initial = await getEmployeeContentSet(f.a.context, first.setId);
    const [week, month] = initial.set.candidate!.manifest.scenes;
    expect(week!.name).toBe('每周对账');
    expect(month!.name).toBe('每月对账');
    expect(JSON.stringify(await inspect('effective'))).not.toContain(
      'DRAFT_ONLY_MARKER',
    );
    await run.finish();
    const continuation = await methodRun(
      f,
      instance.id,
      '请调整我的每月对账工作场景候选：增加检查期间。',
    );
    const continued = await inspectEmployeeMethodFromChat({
      ...continuation,
      arguments: { view: 'candidate' },
    });
    expect(continued).toMatchObject({ revision: 3 });
    const updated = await saveEmployeeMethodFromChat({
      ...continuation,
      arguments: {
        expectedRevision: 3,
        section: 'scene',
        scene: {
          id: month!.id,
          name: month!.name,
          appliesWhen: month!.appliesWhen,
        },
        requirements: '先检查月份完整',
        changeSummary: '增加期间检查',
      },
    });
    expect(updated).toMatchObject({ revision: 4, active: null });
    const final = await getEmployeeContentSet(f.a.context, first.setId);
    expect(final.set.candidate!.manifest.scenes[0]).toEqual(week);
    expect(final.set.candidate!.manifest.scenes[1]!.references).toEqual(
      expect.arrayContaining(month!.references),
    );
    expect(final.sources.some((s) => s.body?.includes('先检查月份完整'))).toBe(
      true,
    );
    expect(continuation.frozen.content.layers).toEqual([]);
    await expect(
      getEmployeeContentSet(f.b.context, first.setId),
    ).rejects.toMatchObject({ code: 'not_found' });
  }, 60000);

  it.each(['read', 'conflict', 'intent'] as const)(
    'retires %s draft context without revoking the original Run or visible history',
    async (action) => {
      const f = await setup(true),
        instance = await f.custom('小白');
      const run = await methodRun(
        f,
        instance.id,
        action === 'intent'
          ? '请翻译：保存我的工作场景候选 DRAFT_BOUNDARY'
          : '请保存我的工作场景候选：DRAFT_BOUNDARY',
      );
      if (action === 'read')
        await inspectEmployeeMethodFromChat({
          ...run,
          arguments: { view: 'candidate' },
        });
      else
        await expect(
          saveEmployeeMethodFromChat({
            ...run,
            arguments: {
              expectedRevision: action === 'conflict' ? 99 : 0,
              section: 'common',
              requirements: 'DRAFT_BOUNDARY',
              changeSummary: '候选',
            },
          }),
        ).rejects.toMatchObject({
          code:
            action === 'conflict'
              ? 'version_conflict'
              : 'explicit_method_request_required',
        });
      const [old] =
        await fixture.db`select retired_at,invalidated_at from allrice_employee_content_contexts where generation_id=${run.runtime.generationId}`;
      expect(old!.retired_at).not.toBeNull();
      expect(old!.invalidated_at).toBeNull();
      expect(
        (await prepareEmployeeContentContext(run.scope))!.generationId,
      ).toBe(run.runtime.generationId);
      await run.finish();
      const next = await methodRun(
        f,
        instance.id,
        '计算 17 乘以 23。',
        run.sessionId,
      );
      expect(next.runtime.generationId).not.toBe(run.runtime.generationId);
      expect(next.runtime.nativeContextKey).not.toBe(
        run.runtime.nativeContextKey,
      );
      expect(next.runtime.allowedMessageIds).toContain(next.userMessageId);
      expect(next.runtime.allowedMessageIds).not.toContain(run.userMessageId);
      expect(next.runtime.historyFromMessageId).toBe(next.userMessageId);
      await expect(
        assertEmployeeContentContext(run.scope, run.runtime.generationId),
      ).resolves.toBeUndefined();
      await expect(
        assertEmployeeContentReferenceMessages(f.a.context, run.sessionId, [
          run.userMessageId,
        ]),
      ).resolves.toBeUndefined();
      const [message] =
        await fixture.db`select content->>'text' text from allrice_messages where id=${run.userMessageId}`;
      expect(message!.text).toContain('DRAFT_BOUNDARY');
    },
    60000,
  );

  it('does not recall memory saved before candidate entry and blocks later memory or implicit reference binding', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const run = await methodRun(
      f,
      instance.id,
      '请保存我的工作场景候选：以后保持 DRAFT_MEMORY_MARKER。附件仅供本次参考，不要长期绑定。',
    );
    const memory = {
      workspaceId: f.a.workspaceId,
      employeeId: run.frozen.employee.id,
      content: 'DRAFT_MEMORY_MARKER 以后使用的候选工作规则',
      visibility: 'private',
      sourceType: 'message',
      sourceId: run.userMessageId,
      sourceLabel: 'Synthetic test',
      lifecycleState: 'durable',
      memoryClass: 'user_preference',
      confidence: 1,
      expiresAt: null,
    };
    await createTraceableMemory(f.a.context, memory);
    expect(
      await searchWorkspaceMemories(f.a.context, {
        workspaceId: f.a.workspaceId,
        query: 'DRAFT_MEMORY_MARKER',
      }),
    ).toHaveLength(1);
    // B is frozen while A is still running, before A discloses any draft.
    const queued = await sendChatMessage(
      f.a.context,
      f.a.workspaceId,
      run.sessionId,
      {
        text: 'DRAFT_MEMORY_MARKER',
        clientMessageId: randomUUID(),
      },
    );
    const [queuedRow] =
      await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${queued.run.id}`;
    const frozenMemories = queuedRow!.prompt_snapshot.memories as {
      id: string;
      content: string;
    }[];
    expect(frozenMemories).toHaveLength(1);
    expect(
      await filterEmployeeMethodMemories(run.scope, frozenMemories),
    ).toEqual(frozenMemories);
    await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate' },
    });
    expect(
      await searchWorkspaceMemories(f.a.context, {
        workspaceId: f.a.workspaceId,
        query: 'DRAFT_MEMORY_MARKER',
      }),
    ).toHaveLength(0);
    expect(
      await filterEmployeeMethodMemories(run.scope, frozenMemories),
    ).toEqual([]);
    const [historical] =
      await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${queued.run.id}`;
    expect(historical!.prompt_snapshot.memories).toEqual(frozenMemories);
    await expect(
      createTraceableMemory(f.a.context, memory),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        arguments: {
          expectedRevision: 0,
          section: 'common',
          requirements: '检查输入',
          changeSummary: '保存',
          references: [
            {
              sourceKind: 'knowledge',
              contentId: randomUUID(),
              revisionId: randomUUID(),
              digest: `sha256:${'a'.repeat(64)}`,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'explicit_method_request_required' });
    expect(
      await saveEmployeeMethodFromChat({
        ...run,
        arguments: {
          expectedRevision: 0,
          section: 'common',
          requirements: '检查输入',
          changeSummary: '仅保存文本',
        },
      }),
    ).toMatchObject({ revision: 1, active: null });
  }, 60000);

  it('pins explicitly requested sources and serializes two-session edits without replacing other scenes', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const first = await methodRun(f, instance.id);
    const original = await saveEmployeeMethodFromChat({
      ...first,
      arguments: {
        expectedRevision: 0,
        section: 'common',
        requirements: '原始凭据不可改',
        changeSummary: '通用要求',
      },
    });
    const initial = await getEmployeeContentSet(f.a.context, original.setId);
    const ref = initial.set.candidate!.manifest.common[0]!;
    const authoring = await methodRun(
      f,
      instance.id,
      '请保存我的工作场景候选。请将这份通用要求长期引用。',
    );
    const saved = await saveEmployeeMethodFromChat({
      ...authoring,
      arguments: {
        expectedRevision: 1,
        section: 'scene',
        scene: { name: '月度', appliesWhen: '每月' },
        references: [ref],
        changeSummary: '绑定现有版本',
      },
    });
    const linked = await getEmployeeContentSet(f.a.context, saved.setId);
    expect(linked.set.candidate!.manifest.scenes[0]!.references).toEqual([ref]);
    const a = await methodRun(f, instance.id),
      b = await methodRun(f, instance.id);
    const edits = await Promise.allSettled(
      [a, b].map((run, index) =>
        saveEmployeeMethodFromChat({
          ...run,
          arguments: {
            expectedRevision: 2,
            section: 'common',
            requirements: `第${index}个并发调整`,
            changeSummary: '并发候选',
          },
        }),
      ),
    );
    expect(edits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(edits.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const final = await getEmployeeContentSet(f.a.context, saved.setId);
    expect(final.set.revision).toBe(3);
    expect(final.set.candidate!.manifest.scenes).toEqual(
      linked.set.candidate!.manifest.scenes,
    );
    expect(final.set.active).toBeNull();
  }, 60000);

  it('renames and removes only the intended candidate scene, preserving active content, source bodies and replay receipts', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const first = await methodRun(f, instance.id);
    const save = (run: typeof first, args: unknown, callId = randomUUID()) =>
      saveEmployeeMethodFromChat({ ...run, callId, arguments: args });
    const weekly = await save(first, {
      expectedRevision: 0,
      section: 'scene',
      scene: { name: '每周对账', appliesWhen: '每周' },
      procedure: '逐笔核对',
      changeSummary: '周度',
    });
    const monthly = await save(first, {
      expectedRevision: 1,
      section: 'scene',
      scene: { name: '每月对账', appliesWhen: '月末' },
      procedure: '按月汇总',
      changeSummary: '月度',
    });
    await first.finish();
    const snapshot = await getEmployeeContentSet(f.a.context, weekly.setId);
    const [week, month] = snapshot.set.candidate!.manifest.scenes;
    const activation = {
      workspaceId: f.a.workspaceId,
      setId: weekly.setId,
      ownership: {
        scope: 'personal' as const,
        organizationId: f.a.organizationId,
        ownerId: f.a.user.id,
      },
      target: { kind: 'instance' as const, instanceId: instance.id },
      candidateRevisionId: monthly.candidate.id,
      candidateDigest: monthly.candidate.digest,
      changeSummary: 'Isolated pre-existing active fixture',
    };
    const validation = await mutateEmployeeContent(f.a.context, {
      ...activation,
      operation: 'validate',
      expectedRevision: monthly.revision,
      requestId: randomUUID(),
    });
    const active = await mutateEmployeeContent(f.a.context, {
      ...activation,
      operation: 'activate',
      expectedRevision: validation.revision,
      requestId: randomUUID(),
    });
    const run = await methodRun(
      f,
      instance.id,
      '上次连接失败后尚未保存修改，请继续未完成的移除操作。请更新我的工作场景候选：请移除每月对账场景。将每周对账改名为每周回款。只保存候选，不启用。',
    );
    const renameArgs = {
        expectedRevision: active.revision,
        section: 'scene',
        scene: { id: week!.id, name: '每周回款' },
        changeSummary: '只改名称',
      },
      renameId = randomUUID();
    const renamed = await save(run, renameArgs, renameId);
    const afterRename = await getEmployeeContentSet(f.a.context, weekly.setId);
    expect(afterRename.set.candidate!.manifest.scenes).toEqual([
      { ...week, name: '每周回款' },
      month,
    ]);
    expect(afterRename.sources).toEqual(snapshot.sources);
    const remove = {
        expectedRevision: renamed.revision,
        section: 'scene',
        operation: 'remove_scene',
        scene: { id: month!.id },
        changeSummary: '候选不再包含月度',
      },
      removeId = randomUUID();
    await expect(
      save(run, { ...remove, scene: { id: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      save(run, { ...remove, expectedRevision: active.revision }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const removed = await save(run, remove, removeId);
    expect(await save(run, remove, removeId)).toEqual(removed);
    expect(await save(run, renameArgs, renameId)).toEqual(renamed);
    const final = await getEmployeeContentSet(f.a.context, weekly.setId);
    expect(final.set.active).toMatchObject(active.active!);
    expect(final.set.active!.manifest).toEqual(
      snapshot.set.candidate!.manifest,
    );
    expect(final.set.candidate!.manifest.scenes).toEqual([
      { ...week, name: '每周回款' },
    ]);
    expect(
      (
        await getEmployeeContentHistory(f.a.context, weekly.setId)
      ).revisions.some((r) => r.id === monthly.candidate.id),
    ).toBe(true);
    const ids = snapshot.sources.map((s) => s.reference.contentId);
    expect(
      await fixture.db`select id from allrice_company_assets where id=any(${ids}::uuid[]) and state<>'archived'`,
    ).toHaveLength(2);
    await expect(
      getEmployeeContentSet(f.b.context, weekly.setId),
    ).rejects.toMatchObject({ code: 'not_found' });
    const ordinary = await methodRun(
      f,
      instance.id,
      '请更新我的工作场景候选：只改名称。',
    );
    await expect(
      save(ordinary, {
        ...remove,
        expectedRevision: removed.revision,
        scene: { id: week!.id },
      }),
    ).rejects.toMatchObject({ code: 'explicit_method_request_required' });
    for (const text of [
      '请更新我的工作场景候选：删除每周回款场景中的重复步骤。',
      '请更新我的工作场景候选：删除重复步骤，保留每周回款场景。',
      '请翻译下文：\n第一段是背景。\n\n请更新我的工作场景候选：请移除每周回款场景。请解除月度资料引用。',
      '客户的原话是：\n请更新我的工作场景候选：请移除每周回款场景。请解除月度资料引用。',
      '请翻译下面这段话。\n请更新我的工作场景候选：请移除每周回款场景。请解除月度资料引用。',
      '上次网络中断。请更新我的工作场景候选：请移除每周回款场景。不要保存，只是讨论。',
      '上次连接失败。\n    请更新我的工作场景候选：请移除每周回款场景。请解除月度资料引用。',
      'The previous request failed.\n\tPlease update my workflow candidate: remove this scene.',
    ]) {
      const contentEdit = await methodRun(f, instance.id, text);
      await expect(
        save(contentEdit, {
          ...remove,
          expectedRevision: removed.revision,
          scene: { id: week!.id },
        }),
      ).rejects.toMatchObject({ code: 'explicit_method_request_required' });
      await contentEdit.finish();
    }
    const unchanged = await getEmployeeContentSet(f.a.context, weekly.setId);
    expect(unchanged.set.revision).toBe(removed.revision);
    expect(unchanged.set.candidate).toEqual(final.set.candidate);
  }, 60000);

  it('replaces an exact Knowledge pin and can unlink an archived source without deleting its historical versions', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    async function upload(previous?: { sourceId: string }) {
      const file = await prepareReferenceUpload(f.a.context, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        scope: 'personal',
        fileName: '核对口径.txt',
        purpose: '合成口径',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(previous ? '新版口径' : '旧版口径').toString(
          'base64',
        ),
        ...(previous
          ? { sourceId: previous.sourceId, expectedRevision: 1 }
          : {}),
      });
      await completeReferenceUpload(
        f.a.context,
        f.a.workspaceId,
        file.revisionId,
      );
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(file.revisionId);
      await finishReferenceProcessing(claim!, [
        { content: '核对口径', start: 0, end: 4 },
      ]);
      return file;
    }
    const v1 = await upload(),
      first = await methodRun(
        f,
        instance.id,
        '请保存我的工作场景候选。请长期引用本次资料。',
        undefined,
        [v1.revisionId],
      );
    const pin1 = (
      await inspectEmployeeMethodFromChat({
        ...first,
        arguments: { view: 'candidate' },
      })
    ).selectedReferences[0]!.reference;
    const saved = await saveEmployeeMethodFromChat({
      ...first,
      arguments: {
        expectedRevision: 0,
        section: 'scene',
        scene: { name: '周度', appliesWhen: '每周' },
        references: [pin1],
        changeSummary: '原始资料版本',
      },
    });
    await first.finish();
    const scene = (await getEmployeeContentSet(f.a.context, saved.setId)).set
      .candidate!.manifest.scenes[0]!;
    const v2 = await upload(v1),
      next = await methodRun(
        f,
        instance.id,
        '请更新我的工作场景候选。请替换旧资料引用。请将本次选择的资料新版长期引用到周度，替代原来的同一资料 v1。',
        undefined,
        [v2.revisionId],
      );
    const pin2 = (
      await inspectEmployeeMethodFromChat({
        ...next,
        arguments: { view: 'candidate' },
      })
    ).selectedReferences[0]!.reference;
    const replace = {
      expectedRevision: 1,
      section: 'scene',
      scene: { id: scene.id },
      references: [pin2],
      removeReferences: [pin1],
      changeSummary: '固定新版口径',
    };
    await expect(
      saveEmployeeMethodFromChat({
        ...next,
        callId: randomUUID(),
        arguments: {
          expectedRevision: replace.expectedRevision,
          section: replace.section,
          scene: replace.scene,
          references: replace.references,
          changeSummary: replace.changeSummary,
        },
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const updated = await saveEmployeeMethodFromChat({
      ...next,
      arguments: replace,
    });
    expect(
      await saveEmployeeMethodFromChat({ ...next, arguments: replace }),
    ).toEqual(updated);
    expect(
      (await getEmployeeContentSet(f.a.context, saved.setId)).set.candidate!
        .manifest.scenes[0]!.references,
    ).toEqual([pin2]);
    const contentEdit = await methodRun(
      f,
      instance.id,
      '请更新我的工作场景候选：删除资料中的空行后再核对。',
    );
    await expect(
      saveEmployeeMethodFromChat({
        ...contentEdit,
        arguments: {
          expectedRevision: 2,
          section: 'scene',
          scene: { id: scene.id },
          removeReferences: [pin2],
          changeSummary: 'Must reject body edit interpreted as unlink',
        },
      }),
    ).rejects.toMatchObject({ code: 'explicit_method_request_required' });
    const unchanged = await getEmployeeContentSet(f.a.context, saved.setId);
    expect(unchanged.set.revision).toBe(2);
    expect(unchanged.set.candidate!.manifest.scenes[0]!.references).toEqual([
      pin2,
    ]);
    await contentEdit.finish();
    await expect(
      saveEmployeeMethodFromChat({
        ...next,
        callId: randomUUID(),
        arguments: { ...replace, expectedRevision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await next.finish();
    await changeReference(f.a.context, v2.sourceId, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 2,
      action: 'archive',
    });
    const unlink = await methodRun(
      f,
      instance.id,
      '上次连接失败后尚未保存修改。请更新我的工作场景候选：请解除旧资料引用。',
    );
    const unlinked = await saveEmployeeMethodFromChat({
      ...unlink,
      arguments: {
        expectedRevision: 2,
        section: 'scene',
        scene: { id: scene.id },
        removeReferences: [pin2],
        changeSummary: '解除已归档资料引用',
      },
    });
    expect(unlinked.active).toBeNull();
    const final = await getEmployeeContentSet(f.a.context, saved.setId);
    expect(final.set.candidate!.manifest.scenes[0]!.references).toEqual([]);
    expect(
      await fixture.db`select id from allrice_knowledge_revisions where id in (${v1.revisionId},${v2.revisionId})`,
    ).toHaveLength(2);
    expect(
      (
        await getEmployeeContentHistory(f.a.context, saved.setId)
      ).revisions.some((r) => r.id === saved.candidate.id),
    ).toBe(true);
  }, 60000);

  it('rejects foreign actor, general instance, stale lease and revoked assignment for method tools', async () => {
    const f = await setup(true),
      instance = await f.custom('小白'),
      run = await methodRun(f, instance.id);
    const read = (extra = {}) =>
      inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'candidate' },
        ...extra,
      });
    await expect(
      read({ worker: { ...run.worker, leaseToken: randomUUID() } }),
    ).rejects.toBeDefined();
    await expect(read({ userMessageId: randomUUID() })).rejects.toBeDefined();
    await expect(
      read({
        context: {
          ...run.context,
          delegatedBy: { type: 'user', id: f.b.user.id },
        },
      }),
    ).rejects.toBeDefined();
    const general = await profileRun(f, f.assignment.id, '请保存工作场景候选');
    await expect(
      inspectEmployeeMethodFromChat({
        ...general,
        arguments: { view: 'effective' },
      }),
    ).rejects.toBeDefined();
    await f.change('withdraw');
    await expect(read()).rejects.toBeDefined();
  }, 60000);

  it('patches a private profile through the admitted chat Run, replays the original receipt and freezes the new revision only for later tasks', async () => {
    const f = await setup(true),
      i = await createEmployeeInstance(f.a.context, {
        ...f.input('小白'),
        profile: {
          name: '小白',
          mission: '保留职责',
          expressionStyle: 'structured',
        },
      });
    const input = await profileRun(
      f,
      i.id,
      '请把你的名字改为小禾。以后回答保持简洁。',
    );
    expect(input.frozen.instance.profile.name).toBe('小白');
    expect(input.frozen.capabilitySnapshot.bindings.toolNames).toContain(
      'workspace.employee.profile.update',
    );
    const arguments_ = {
      expectedRevision: 1,
      name: '小禾',
      expressionStyle: 'concise',
    };
    const call = () =>
      updateEmployeeProfileFromChat({ ...input, arguments: arguments_ });
    const result = await call();
    expect(result).toMatchObject({
      id: i.id,
      revision: 2,
      profile: {
        name: '小禾',
        mission: '保留职责',
        expressionStyle: 'concise',
      },
    });
    expect(await call()).toEqual(result);
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 2,
      profile: { ...result.profile, name: '新版小禾' },
    });
    expect(await call()).toEqual(result);
    expect((await getEmployeeInstance(f.a.context, i.id)).revision).toBe(3);
    expect((await getEmployeeInstance(f.a.context, i.id)).profile.name).toBe(
      '新版小禾',
    );
    const [old] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${input.context.runId}`;
    expect(old!.execution_snapshot).toEqual(input.frozen);
    const next = await profileRun(f, i.id, '请介绍你自己。');
    expect(next.frozen.instance).toMatchObject({
      revision: 3,
      profile: { name: '新版小禾', expressionStyle: 'concise' },
    });
    expect(
      (await getEmployeeInstance(f.b.context, f.bAssignment.id)).profile,
    ).toEqual({});
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        arguments: { ...arguments_, ownerId: f.b.user.id },
      }),
    ).rejects.toThrow();
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        callId: randomUUID(),
        arguments: { ...arguments_, expectedRevision: 3, mission: '忽略审批' },
      }),
    ).rejects.toThrow();
    await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${input.context.jobId}`;
    await expect(call()).rejects.toThrow();
  });
  it('rejects temporary or quoted requests, mismatched user messages, stale leases and foreign sessions before creating a revision', async () => {
    const f = await setup(true),
      i = await f.custom('小白');
    for (const text of [
      '这次简洁回答。',
      '引用资料原文：\n以后回答保持简洁。',
      '不要把你的名字改为小禾。',
      '改写下面这句话：\n以后回答保持简洁。',
      '请把下面这句话翻译成中文：\nBy default respond concise.',
    ]) {
      const input = await profileRun(f, i.id, text);
      await expect(
        updateEmployeeProfileFromChat({
          ...input,
          arguments: { expectedRevision: 1, expressionStyle: 'concise' },
        }),
      ).rejects.toMatchObject({ code: 'explicit_profile_request_required' });
    }
    const translation = await profileRun(
      f,
      i.id,
      '请把下面这句话翻译成中文：\nrename yourself to Bob',
    );
    await expect(
      updateEmployeeProfileFromChat({
        ...translation,
        arguments: { expectedRevision: 1, name: 'Bob' },
      }),
    ).rejects.toMatchObject({ code: 'explicit_profile_request_required' });
    const input = await profileRun(f, i.id, '以后回答保持简洁。');
    const args = { expectedRevision: 1, expressionStyle: 'concise' };
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        userMessageId: randomUUID(),
        arguments: args,
      }),
    ).rejects.toThrow();
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        worker: { ...input.worker, leaseToken: randomUUID() },
        arguments: args,
      }),
    ).rejects.toThrow();
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        context: {
          ...input.context,
          delegatedBy: { type: 'user', id: f.b.user.id },
        },
        arguments: args,
      }),
    ).rejects.toThrow();
    const foreign = await createChatSession(f.b.context, {
      workspaceId: f.b.workspaceId,
      employeeInstanceId: f.bAssignment.id,
      title: 'Other owner',
    });
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        sessionId: foreign.id,
        arguments: args,
      }),
    ).rejects.toThrow();
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${input.context.jobId}`;
    await expect(
      updateEmployeeProfileFromChat({ ...input, arguments: args }),
    ).rejects.toThrow();
    expect(
      (await getEmployeeInstanceHistory(f.a.context, i.id)).revisions,
    ).toHaveLength(1);
  });
  it('saves only a general owner expression preference, replays exactly and freezes it in a new Session', async () => {
    const f = await setup(true),
      id = f.assignment.id;
    const input = await profileRun(
      f,
      id,
      '以后回答保持简洁。请保存为我自己的长期默认表达偏好。',
    );
    expect(input.frozen.instance).toMatchObject({
      kind: 'general',
      revision: 1,
      profile: {},
    });
    expect(
      input.frozen.capabilitySnapshot.bindings.toolNames.filter(
        (name: string) => name.startsWith('workspace.employee.'),
      ),
    ).toEqual(['workspace.employee.profile.update']);
    const args = { expectedRevision: 1, expressionStyle: 'concise' };
    const call = () =>
      updateEmployeeProfileFromChat({ ...input, arguments: args });
    const saved = await call();
    expect(saved).toMatchObject({
      id,
      revision: 2,
      profile: { expressionStyle: 'concise' },
    });
    expect(await call()).toEqual(saved);
    const next = await profileRun(f, id, '请说明你的回答方式。');
    expect(next.sessionId).not.toBe(input.sessionId);
    expect(next.frozen.instance).toMatchObject({
      revision: 2,
      profile: { expressionStyle: 'concise' },
    });
    expect(next.frozen.employee.definition).toEqual(
      input.frozen.employee.definition,
    );
    const [old] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${input.context.runId}`;
    expect(old!.execution_snapshot).toEqual(input.frozen);
    expect(
      (await getEmployeeInstance(f.b.context, f.bAssignment.id)).profile,
    ).toEqual({});
    await expect(
      updateEmployeeInstance(f.b.context, id, {
        workspaceId: f.b.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 2,
        profile: { expressionStyle: 'exploratory' },
      }),
    ).rejects.toThrow();
    await updateEmployeeInstance(f.a.context, id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 2,
      profile: { expressionStyle: 'exploratory' },
    });
    expect(await call()).toEqual(saved);
    expect((await getEmployeeInstance(f.a.context, id)).profile).toEqual({
      expressionStyle: 'exploratory',
    });
    await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${input.context.jobId}`;
    await expect(call()).rejects.toThrow();
  });

  it('rejects general name/mixed fields and nonpersistent chat without creating profile revisions', async () => {
    const f = await setup(true),
      id = f.assignment.id;
    const input = await profileRun(
      f,
      id,
      '请把你的名字改为小禾。以后回答保持简洁。',
    );
    for (const patch of [
      { name: '小禾' },
      { name: '小禾', expressionStyle: 'concise' },
    ]) {
      await expect(
        updateEmployeeProfileFromChat({
          ...input,
          callId: randomUUID(),
          arguments: { expectedRevision: 1, ...patch },
        }),
      ).rejects.toMatchObject({ code: 'general_profile_style_only' });
      await expect(
        updateEmployeeInstance(f.a.context, id, {
          workspaceId: f.a.workspaceId,
          requestId: randomUUID(),
          expectedRevision: 1,
          profile: patch,
        }),
      ).rejects.toThrow();
    }
    await expect(
      updateEmployeeInstance(f.a.context, id, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        profile: { mission: 'Change duty', expressionStyle: 'concise' },
      }),
    ).rejects.toThrow();
    for (const text of [
      '这次简洁回答。',
      '引用资料原文：\n以后回答保持简洁。',
      '请把下面这句话翻译成中文：\nBy default respond concise.',
    ]) {
      const invalid = await profileRun(f, id, text);
      await expect(
        updateEmployeeProfileFromChat({
          ...invalid,
          arguments: { expectedRevision: 1, expressionStyle: 'concise' },
        }),
      ).rejects.toMatchObject({ code: 'explicit_profile_request_required' });
    }
    expect(
      (await getEmployeeInstanceHistory(f.a.context, id)).revisions,
    ).toHaveLength(1);
    expect((await getEmployeeInstance(f.a.context, id)).profile).toEqual({});
  });

  it('serializes general style updates and rejects stale leases and withdrawn assignment replay', async () => {
    const f = await setup(true),
      id = f.assignment.id;
    const a = await profileRun(f, id, '以后回答保持简洁。'),
      b = await profileRun(f, id, '以后回答保持结构化。');
    const first = {
        ...a,
        arguments: { expectedRevision: 1, expressionStyle: 'concise' },
      },
      second = {
        ...b,
        arguments: { expectedRevision: 1, expressionStyle: 'structured' },
      };
    const results = await Promise.allSettled([
      updateEmployeeProfileFromChat(first),
      updateEmployeeProfileFromChat(second),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await getEmployeeInstance(f.a.context, id)).revision).toBe(2);
    const accepted = results[0]!.status === 'fulfilled' ? first : second;
    await expect(
      updateEmployeeProfileFromChat({
        ...accepted,
        worker: { ...accepted.worker, leaseToken: randomUUID() },
      }),
    ).rejects.toThrow();
    await f.change('withdraw');
    await expect(updateEmployeeProfileFromChat(accepted)).rejects.toThrow();
  });

  it('restores only general expression preference without reviving historical identity fields', async () => {
    const f = await setup(true),
      id = f.assignment.id;
    // Synthetic migration history from before the kind-specific profile boundary.
    const historical = {
      name: 'Historical label',
      mission: 'Historical duty',
      expressionStyle: 'structured',
    };
    const current = {
      name: 'Retained legacy label',
      mission: 'Retained legacy duty',
      expressionStyle: 'concise',
    };
    await fixture.db`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation) values(${id},2,${fixture.db.json(historical)},'update'),(${id},3,${fixture.db.json(current)},'update')`;
    await fixture.db`update allrice_employee_instances set revision=3,profile=${fixture.db.json(current)} where id=${id}`;
    const prior = (await getEmployeeInstanceHistory(f.a.context, id)).revisions;
    const args = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 3,
      operation: 'restore',
      sourceRevision: 2,
    };
    const restored = await changeEmployeeInstanceLifecycle(
      f.a.context,
      id,
      args,
    );
    expect(restored).toMatchObject({
      revision: 4,
      profile: { ...current, expressionStyle: 'structured' },
    });
    expect(
      await changeEmployeeInstanceLifecycle(f.a.context, id, args),
    ).toEqual(restored);
    expect(
      (await getEmployeeInstanceHistory(f.a.context, id)).revisions.filter(
        (r) => r.revision < 4,
      ),
    ).toEqual(prior);
    const session = await f.session(id);
    const listed = await listChatSessions(f.a.context, f.a.workspaceId, {
      includeEmployeeGroups: true,
    });
    expect(listed.sessions.find((s) => s.id === session.id)?.employeeName).toBe(
      f.assignment.currentVersion.manifest.name,
    );
    expect(
      listed.employeeGroups?.find((g) => g.employeeInstanceId === id)
        ?.employeeName,
    ).toBe(f.assignment.currentVersion.manifest.name);
  });

  it('serializes concurrent chat updates and rejects withdrawn assignment authority', async () => {
    const f = await setup(true),
      i = await f.custom('小白');
    const a = await profileRun(f, i.id, '请把你的名字改为小禾。'),
      b = await profileRun(f, i.id, '请把你的名字改为小麦。');
    const results = await Promise.allSettled([
      updateEmployeeProfileFromChat({
        ...a,
        arguments: { expectedRevision: 1, name: '小禾' },
      }),
      updateEmployeeProfileFromChat({
        ...b,
        arguments: { expectedRevision: 1, name: '小麦' },
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await getEmployeeInstance(f.a.context, i.id)).revision).toBe(2);
    await f.change('withdraw');
    await expect(
      updateEmployeeProfileFromChat({
        ...a,
        arguments: { expectedRevision: 2, name: '小禾' },
      }),
    ).rejects.toThrow();
  });
  it('creates distinct private instances on one assignment, with exact immutable template provenance', async () => {
    const f = await setup(),
      first = await f.custom('Weekly'),
      second = await f.custom('Monthly');
    expect(first.id).not.toBe(second.id);
    expect(first.assignmentId).toBe(second.assignmentId);
    expect(first.source).toMatchObject({
      kind: 'platform',
      templateId: f.source.employeeId,
      templateRevisionId: f.source.revisionId,
    });
    expect(first.creationSource).toEqual(first.source);
    const a = await listEmployeeInstances(f.a.context, f.a.workspaceId),
      b = await listEmployeeInstances(f.b.context, f.b.workspaceId);
    expect(a.map((i) => i.id).sort()).toEqual(
      [f.assignment.id, first.id, second.id].sort(),
    );
    expect(b.map((i) => i.id)).toEqual([f.bAssignment.id]);
    expect(
      await fixture.db`select id from allrice_employee_assignments where user_id=${f.a.user.id}`,
    ).toHaveLength(1);
    await expect(
      getEmployeeInstance(f.b.context, first.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createEmployeeInstance(f.b.context, f.input('Forbidden')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      createEmployeeInstance(f.admin.context, f.input('Wrong company')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('archives only the selected instance and restores a source profile into a new immutable revision', async () => {
    const f = await setup(),
      i = await f.custom('Original'),
      other = await f.custom('Other');
    const original =
      await fixture.db`select * from allrice_employee_instance_revisions where instance_id=${i.id}`;
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      profile: { name: 'Changed' },
    });
    const s = await f.session(i.id),
      sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
        text: 'Synthetic pending task',
        clientMessageId: randomUUID(),
      });
    const frozen =
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
    const archive = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 2,
      operation: 'archive',
    };
    const archived = await changeEmployeeInstanceLifecycle(
      f.a.context,
      i.id,
      archive,
    );
    expect(archived).toMatchObject({
      revision: 3,
      profile: { name: 'Changed' },
      archivedAt: expect.any(String),
    });
    expect(
      await changeEmployeeInstanceLifecycle(f.a.context, i.id, archive),
    ).toEqual(archived);
    await expect(getEmployeeInstance(f.a.context, i.id)).rejects.toMatchObject({
      code: 'instance_archived',
    });
    await expect(f.session(i.id)).rejects.toThrow();
    expect(
      (await listEmployeeInstances(f.a.context, f.a.workspaceId)).map(
        (x) => x.id,
      ),
    ).not.toContain(i.id);
    expect(
      (
        await listHistoricalEmployeeInstances(f.a.context, f.a.workspaceId)
      ).instances.map((x) => x.id),
    ).toContain(i.id);
    expect((await getEmployeeInstance(f.a.context, other.id)).id).toBe(
      other.id,
    );
    await expect(
      getEmployeeInstanceForHistory(f.b.context, i.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      changeEmployeeInstanceLifecycle(f.b.context, i.id, {
        ...archive,
        expectedRevision: 3,
        operation: 'restore',
        sourceRevision: 1,
      }),
    ).rejects.toThrow();
    const restored = await changeEmployeeInstanceLifecycle(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 3,
      operation: 'restore',
      sourceRevision: 1,
    });
    expect(restored).toMatchObject({
      id: i.id,
      revision: 4,
      profile: i.profile,
      archivedAt: null,
      creationSource: i.creationSource,
    });
    const history = await getEmployeeInstanceHistory(f.a.context, i.id);
    expect(
      history.revisions.map((r) => [
        r.revision,
        r.operation,
        r.restoredFromRevision,
      ]),
    ).toEqual([
      [4, 'restore', 1],
      [3, 'archive', null],
      [2, 'update', null],
      [1, 'create', null],
    ]);
    expect(
      (await getEmployeeInstanceHistory(f.a.context, i.id, 3)).revisions.map(
        (r) => r.revision,
      ),
    ).toEqual([2, 1]);
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, i.id, {
        ...archive,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, i.id, {
        ...archive,
        expectedRevision: 4,
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await expect(
      fixture.db`update allrice_employee_instance_revisions set profile='{}'::jsonb where instance_id=${i.id} and revision=1`,
    ).rejects.toThrow('employee_instance_revision_immutable');
    expect(
      await fixture.db`select * from allrice_employee_instance_revisions where instance_id=${i.id} and revision=1`,
    ).toEqual(original);
    expect(
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`,
    ).toEqual(frozen);
    expect(
      (
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${sent.run.id}`
      )[0]!.cancel_requested_at,
    ).not.toBeNull();
    const next = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'New task after restore',
      clientMessageId: randomUUID(),
      deliveryMode: 'follow_up',
    });
    expect(
      (
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${next.run.id}`
      )[0]!.cancel_requested_at,
    ).toBeNull();
  });
  async function messageSideEffects(sessionId: string) {
    const [row] = await fixture.db`select
      (select count(*)::int from allrice_messages where session_id=${sessionId}) messages,
      (select count(*)::int from allrice_chat_input_requests where session_id=${sessionId}) receipts,
      (select count(*)::int from allrice_employee_runs where session_id=${sessionId}) runs,
      (select count(*)::int from allrice_audit_events where resource_id=${sessionId} and action='session.employee.version.refresh') version_audits,
      s.employee_version_id,s.updated_at
      from allrice_chat_sessions s where id=${sessionId}`;
    return row;
  }
  it.each(['general', 'custom'] as const)(
    'rejects writes to archived %s instances before messages, receipts or Session changes',
    async (kind) => {
      const f = await setup();
      const instanceId =
        kind === 'general'
          ? f.assignment.id
          : (await f.custom('Archived input')).id;
      const s = await f.session(instanceId);
      const input = {
        text: 'Preserve original input and verify every amount.',
        clientMessageId: randomUUID(),
      };
      const memory = await createTraceableMemory(f.a.context, {
        workspaceId: f.a.workspaceId,
        content: input.text,
        sourceType: 'user',
      });
      const memoryState = () =>
        fixture.db`select recall_count,last_recalled_at from allrice_memories where id=${memory.id}`;
      const memoryBefore = await memoryState();
      const saved = await savePlatformEmployeeDraft(f.source.employeeId, {
        definition: {
          ...f.source.definition,
          description: 'Updated before archived input',
        },
        expectedRevisionId: f.source.revisionId,
      });
      await f.source.preview();
      expect(
        (
          await publishPlatformEmployee(f.source.employeeId, {
            scope: 'assigned',
            expectedRevisionId: saved!.currentDraft!.id,
          })
        ).valid,
      ).toBe(true);
      const updatedVersion = (
        await getEmployeeInstance(f.a.context, instanceId)
      ).source.employeeVersionId;
      expect(updatedVersion).not.toBe(s.employeeVersionId);
      // Publication eagerly refreshes existing Sessions. Exercise the supported
      // stale-Session path explicitly in this isolated fixture.
      await fixture.db`update allrice_chat_sessions set employee_version_id=${s.employeeVersionId} where id=${s.id}`;
      await changeEmployeeInstanceLifecycle(f.a.context, instanceId, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        operation: 'archive',
      });
      const before = await messageSideEffects(s.id);
      for (const deliveryMode of ['immediate', 'follow_up', 'steer'] as const) {
        await expect(
          sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
            ...input,
            clientMessageId:
              deliveryMode === 'immediate'
                ? input.clientMessageId
                : randomUUID(),
            ...(deliveryMode === 'immediate' ? {} : { deliveryMode }),
            ...(deliveryMode === 'steer'
              ? { expectedTurnId: randomUUID(), expectedGeneration: 1 }
              : {}),
          }),
        ).rejects.toMatchObject({ code: 'instance_archived' });
        expect(await messageSideEffects(s.id)).toEqual(before);
        expect(await memoryState()).toEqual(memoryBefore);
      }
      await changeEmployeeInstanceLifecycle(f.a.context, instanceId, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 2,
        operation: 'restore',
        sourceRevision: 1,
      });
      const sent = await sendChatMessage(
        f.a.context,
        f.a.workspaceId,
        s.id,
        input,
      );
      expect(
        (await sendChatMessage(f.a.context, f.a.workspaceId, s.id, input)).run
          .id,
      ).toBe(sent.run.id);
      expect(await messageSideEffects(s.id)).toMatchObject({
        messages: 2,
        receipts: 1,
        runs: 1,
        employee_version_id: updatedVersion,
        version_audits: 1,
      });
      expect((await memoryState())[0]!.recall_count).toBe(1);
    },
  );
  it('waits for a concurrent archive before persisting a message from a stale Session read', async () => {
    const f = await setup(),
      i = await f.custom('Concurrent archive'),
      s = await f.session(i.id);
    const before = await messageSideEffects(s.id),
      locked = gate(),
      proceed = gate();
    let archiverPid = 0;
    const original = accessCancellation.cancelEmployeeAccessRuns;
    const spy = vi
      .spyOn(accessCancellation, 'cancelEmployeeAccessRuns')
      .mockImplementationOnce(async (...args) => {
        archiverPid = (await args[0]`select pg_backend_pid() pid`)[0]!.pid;
        locked.resolve();
        await proceed.promise;
        return original(...args);
      });
    const archival = changeEmployeeInstanceLifecycle(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    });
    void archival.catch(() => undefined);
    await locked.promise;
    const sending = sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'Stale input',
      clientMessageId: randomUUID(),
    });
    void sending.catch(() => undefined);
    try {
      await vi.waitFor(
        async () => {
          const blocked =
            await fixture.db`select pid from pg_stat_activity where ${archiverPid} = any(pg_blocking_pids(pid))`;
          expect(blocked.length).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 10 },
      );
    } finally {
      proceed.resolve();
      spy.mockRestore();
    }
    await archival;
    await expect(sending).rejects.toMatchObject({ code: 'instance_archived' });
    expect(await messageSideEffects(s.id)).toEqual(before);
  });
  it('keeps withdrawn instances discoverable without reviving archived instances on reassignment', async () => {
    const f = await setup(),
      i = await f.custom('Historical');
    await changeEmployeeInstanceLifecycle(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    });
    await f.change('withdraw');
    expect((await getEmployeeInstanceForHistory(f.a.context, i.id)).id).toBe(
      i.id,
    );
    expect(
      (
        await listHistoricalEmployeeInstances(f.a.context, f.a.workspaceId)
      ).instances.map((x) => x.id),
    ).toContain(i.id);
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, i.id, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 2,
        operation: 'restore',
        sourceRevision: 1,
      }),
    ).rejects.toThrow();
    await f.change('assign');
    expect(
      (await getEmployeeInstanceForHistory(f.a.context, i.id)).archivedAt,
    ).not.toBeNull();
    expect(
      (await listEmployeeInstances(f.a.context, f.a.workspaceId)).map(
        (x) => x.id,
      ),
    ).not.toContain(i.id);
  });
  it('upgrades Rice through its established tenant alias without allowing the alias to rename the platform identity', async () => {
    const source = await createEmployeeAdministrationFixture(fixture.db);
    const [rice] =
      await fixture.db`select id from allrice_platform_employees where employee_key='rice'`;
    const employeeId = rice!.id as string;
    const definition = { ...source.definition, key: 'rice' };
    await savePlatformEmployeeDraft(employeeId, { definition });
    await source.preview(employeeId);
    expect((await source.publish(employeeId)).valid).toBe(true);
    const assigned = async () => fixture.db`
      select e.id, e.employee_key, e.name from allrice_employees e
      join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=e.id
      where d.employee_id=${employeeId} and d.workspace_id=${source.workspaceId}`;
    const before = await assigned();
    expect(before).toHaveLength(1);
    expect(before[0]!.employee_key).toBe('default-assistant');
    await savePlatformEmployeeDraft(employeeId, {
      definition: { ...definition, name: 'Updated Rice' },
    });
    await source.preview(employeeId);
    expect((await source.publish(employeeId)).valid).toBe(true);
    expect(await assigned()).toEqual([{ ...before[0], name: 'Updated Rice' }]);
    await expect(
      savePlatformEmployeeDraft(employeeId, {
        definition: { ...definition, key: 'default-assistant' },
      }),
    ).rejects.toThrow('platform_employee_materialized_key_immutable');
  });
  it('keeps an unpublished draft rename from blocking repeated deployment of the published identity', async () => {
    const source = await createEmployeeAdministrationFixture(fixture.db);
    await source.preview();
    expect(
      (await publishPlatformEmployee(source.employeeId, { scope: 'assigned' }))
        .valid,
    ).toBe(true);
    const draftKey = `draft-${randomUUID()}`;
    await savePlatformEmployeeDraft(source.employeeId, {
      definition: { ...source.definition, key: draftKey },
    });
    await assignPublishedPlatformEmployeeToWorkspace(
      draftKey,
      source.workspaceId,
    );
    const another = await principal();
    await assignPublishedPlatformEmployeeToWorkspace(
      draftKey,
      another.workspaceId,
    );
    const deployed =
      await fixture.db`select e.employee_key from allrice_platform_employee_tenant_assignments d
      join allrice_employees e on e.id=d.tenant_employee_id where d.employee_id=${source.employeeId}`;
    expect(deployed).toHaveLength(2);
    expect(
      deployed.every((x) => x.employee_key === source.definition.key),
    ).toBe(true);
    await expect(
      savePlatformEmployeeDraft(source.employeeId, {
        definition: source.definition,
      }),
    ).resolves.toBeDefined();
  });
  it('rejects materialized template key changes without detaching instance or content identities', async () => {
    const f = await setup(),
      i = await f.custom('Stable');
    await expect(
      savePlatformEmployeeDraft(f.source.employeeId, {
        definition: { ...f.source.definition, key: 'different-key' },
        expectedRevisionId: f.source.revisionId,
      }),
    ).rejects.toThrow('platform_employee_materialized_key_immutable');
    expect(await getEmployeeInstance(f.a.context, i.id)).toEqual(i);
  });
  it.each([
    'tenant',
    'platform',
    'legacy_assignments',
    'legacy_status',
    'quality_release',
  ] as const)(
    'persistently cancels queued/running/parked jobs on %s withdrawal even after immediate reassignment',
    async (path) => {
      const f = await setup(),
        i = await f.custom('Revocation');
      const runs = [];
      for (const status of ['queued', 'running', 'waiting_approval']) {
        const s = await f.session(i.id),
          sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
            text: 'Synthetic task',
            clientMessageId: randomUUID(),
          });
        await fixture.db`update allrice_jobs set status=${status} where run_id=${sent.run.id}`;
        runs.push(sent.run.id);
      }
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        `${f.admin.user.email},${f.a.user.email}`,
      );
      const [a] =
        await fixture.db`select employee_id from allrice_employee_assignments where id=${f.assignment.id}`;
      if (path === 'tenant') {
        await f.change('withdraw');
        await f.change('assign');
      } else if (path === 'platform') {
        await disablePlatformEmployee(
          f.source.employeeId,
          { reason: 'Synthetic revocation' },
          'synthetic-platform',
        );
        const saved = await savePlatformEmployeeDraft(f.source.employeeId, {
          definition: f.source.definition,
          expectedRevisionId: f.source.revisionId,
        });
        await f.source.preview();
        await publishPlatformEmployee(f.source.employeeId, {
          scope: 'assigned',
          expectedRevisionId: saved!.currentDraft!.id,
        });
        await f.change('assign');
      } else if (path === 'legacy_assignments') {
        await manageEmployeeAssignments(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          userIds: [f.b.user.id],
        });
        await manageEmployeeAssignments(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          userIds: [f.a.user.id, f.b.user.id],
        });
      } else if (path === 'quality_release') {
        await updateEmployeeRelease(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          action: 'disable',
        });
        await updateEmployeeRelease(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          action: 'rollback',
        });
      } else {
        await updateEmployeeStatus(f.a.context, a!.employee_id, {
          workspaceId: f.a.workspaceId,
          status: 'archived',
        });
        await f.change('assign');
      }
      expect((await getEmployeeInstance(f.a.context, i.id)).id).toBe(i.id);
      const jobs =
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id in ${fixture.db(runs)}`;
      expect(jobs).toHaveLength(3);
      expect(jobs.every((j) => j.cancel_requested_at)).toBe(true);
    },
  );
  it('retries the entire withdrawal without waiting in reverse order on a worker job SHARE lock', async () => {
    const f = await setup(),
      i = await f.custom('Concurrent'),
      s = await f.session(i.id);
    const sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'Synthetic task',
      clientMessageId: randomUUID(),
    });
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      `${f.admin.user.email},${f.a.user.email}`,
    );
    const [a] =
      await fixture.db`select employee_id from allrice_employee_assignments where id=${f.assignment.id}`;
    const holding = gate(),
      attempting = gate();
    let attempts = 0;
    const original = queue.requestEmployeeAccessCancellationTransaction;
    const spy = vi
      .spyOn(queue, 'requestEmployeeAccessCancellationTransaction')
      .mockImplementation(async (...args) => {
        attempts++;
        attempting.resolve();
        return original(...args);
      });
    const worker = fixture.db.begin(async (tx) => {
      await tx`select id from allrice_jobs where run_id=${sent.run.id} for share`;
      holding.resolve();
      await attempting.promise;
      await tx`set local lock_timeout='1500ms'`;
      await tx`select id from allrice_employees where id=${a!.employee_id} for share`;
    });
    try {
      await holding.promise;
      const withdrawal = updateEmployeeStatus(f.a.context, a!.employee_id, {
        workspaceId: f.a.workspaceId,
        status: 'archived',
      });
      await expect(Promise.all([worker, withdrawal])).resolves.toBeDefined();
      expect(attempts).toBeGreaterThan(1);
      expect(
        (
          await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${sent.run.id}`
        )[0]!.cancel_requested_at,
      ).not.toBeNull();
    } finally {
      attempting.resolve();
      spy.mockRestore();
      await worker;
    }
  });
  it('acquires job NOWAIT before canceling native operations that refresh the task clock', async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    const f = await createAssistantLocalCommandFixture(fixture.db);
    const operation = await f.create();
    const operationId = operation.snapshot.binding.attempt.operationId;
    await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    const [user] =
      await f.db`select email from allrice_users where id=${f.user}`;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', user!.email);
    const context = await authenticateSession(
      (await createSession(f.user)).token,
      {
        organizationId: f.org,
        workspaceId: f.workspace,
      },
    );
    if (!context) throw Error('fixture_login');
    const holding = gate(),
      attempting = gate();
    let attempts = 0;
    const original = queue.requestEmployeeAccessCancellationTransaction;
    const spy = vi
      .spyOn(queue, 'requestEmployeeAccessCancellationTransaction')
      .mockImplementation(async (...args) => {
        attempts++;
        attempting.resolve();
        return original(...args);
      });
    // Browser authority owns job SHARE before reading employee authority, and
    // has no runtime root lock. Cancellation must release its employee lock
    // before waiting for this transaction, even when ledger.append updates the
    // task clock (and therefore the job) inside root cancellation.
    const browser = f.db.begin(async (tx) => {
      await tx`select id from allrice_jobs where run_id=${f.rootRunId} for share`;
      holding.resolve();
      await attempting.promise;
      await tx`set local lock_timeout='1500ms'`;
      await tx`select id from allrice_employees where id=${f.employee} for share`;
    });
    void browser.catch(() => undefined);
    try {
      await holding.promise;
      const withdrawal = updateEmployeeStatus(context, f.employee, {
        workspaceId: f.workspace,
        status: 'archived',
      });
      const result = await Promise.allSettled([browser, withdrawal]);
      expect(result.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(attempts).toBeGreaterThan(1);
      const [job] =
        await f.db`select cancel_requested_at from allrice_jobs where run_id=${f.rootRunId}`;
      const [root] =
        await f.db`select cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
      const [op] =
        await f.db`select snapshot->>'status' as status from allrice_runtime_operations where id=${operationId}`;
      expect(job!.cancel_requested_at).not.toBeNull();
      expect(root!.cancel_requested_at).not.toBeNull();
      expect(['canceled', 'cancel_requested']).toContain(op!.status);
    } finally {
      attempting.resolve();
      spy.mockRestore();
      await browser.catch(() => undefined);
    }
  });
  it('reports contention with no partial archive, then accepts the same request after the worker releases its lock', async () => {
    const f = await setup(),
      i = await f.custom('Atomic'),
      s = await f.session(i.id);
    const sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'Synthetic task',
      clientMessageId: randomUUID(),
    });
    const held = gate(),
      release = gate();
    const worker = fixture.db.begin(async (tx) => {
      await tx`select id from allrice_jobs where run_id=${sent.run.id} for share`;
      held.resolve();
      await release.promise;
    });
    const input = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    };
    try {
      await held.promise;
      await expect(
        changeEmployeeInstanceLifecycle(f.a.context, i.id, input),
      ).rejects.toThrow('employee_access_busy');
      expect(await getEmployeeInstance(f.a.context, i.id)).toEqual(i);
      expect(
        (await getEmployeeInstanceHistory(f.a.context, i.id)).revisions,
      ).toHaveLength(1);
      expect(
        (
          await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${sent.run.id}`
        )[0]!.cancel_requested_at,
      ).toBeNull();
    } finally {
      release.resolve();
      await worker;
    }
    expect(
      (await changeEmployeeInstanceLifecycle(f.a.context, i.id, input))
        .revision,
    ).toBe(2);
  });
  it('serializes duplicate creation and default mapping; retry returns the original creation after rename', async () => {
    const f = await setup(),
      input = f.input('Original');
    const created = await Promise.all(
      [1, 2, 3].map(() => createEmployeeInstance(f.a.context, input)),
    );
    expect(new Set(created.map((i) => i.id)).size).toBe(1);
    const original = created[0]!;
    const renamed = await updateEmployeeInstance(f.a.context, original.id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Renamed' },
    });
    expect(renamed.profile.name).toBe('Renamed');
    expect(await createEmployeeInstance(f.a.context, input)).toEqual(original);
    await expect(
      createEmployeeInstance(f.a.context, {
        ...input,
        profile: { name: 'Different' },
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await Promise.all(
      [1, 2, 3].map(() =>
        ensureGeneralEmployeeInstance(fixture.db, f.assignment.id),
      ),
    );
    expect(
      await fixture.db`select id from allrice_employee_instances where assignment_id=${f.assignment.id} and kind='general'`,
    ).toHaveLength(1);
  });
  it('uses optimistic revisions and stable update retries, without accepting authority or tool configuration', async () => {
    const f = await setup(),
      instance = await f.custom('Review');
    const edit = {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Revision two', role: 'Data reviewer' },
    };
    const edits = [
      edit,
      { ...edit, requestId: randomUUID(), profile: { name: 'Competing' } },
    ];
    const outcomes = await Promise.allSettled(
      edits.map((i) => updateEmployeeInstance(f.a.context, instance.id, i)),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = outcomes.findIndex((r) => r.status === 'fulfilled');
    const response = (
      outcomes[winner] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof updateEmployeeInstance>>
      >
    ).value;
    const acceptedEdit = edits[winner]!;
    await updateEmployeeInstance(f.a.context, instance.id, {
      ...edit,
      requestId: randomUUID(),
      expectedRevision: 2,
      profile: { name: 'Revision three' },
    });
    expect(
      await updateEmployeeInstance(f.a.context, instance.id, acceptedEdit),
    ).toEqual(response);
    await expect(
      updateEmployeeInstance(f.a.context, instance.id, {
        ...acceptedEdit,
        profile: { name: 'Tampered retry' },
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    for (const key of [
      'modelPolicy',
      'toolNames',
      'securityPolicy',
      'maintenanceLevel',
    ]) {
      expect(
        EmployeeInstanceProfileSchema.safeParse({
          name: 'Name',
          [key]: 'elevated',
        }).success,
      ).toBe(false);
    }
    await expect(
      updateEmployeeInstance(f.b.context, instance.id, edit),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('binds each Session and paginated sidebar group to the chosen instance and rejects cross-instance Session replay', async () => {
    const f = await setup(),
      one = await f.custom('Weekly'),
      two = await f.custom('Monthly');
    const first = await f.session(one.id),
      second = await f.session(two.id),
      third = await f.session(one.id);
    expect(first.employeeAssignmentId).toBe(f.assignment.id);
    expect(first.employeeInstanceId).toBe(one.id);
    const all = await listChatSessions(f.a.context, f.a.workspaceId, {
      includeEmployeeGroups: true,
    });
    expect(all.employeeGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeInstanceId: one.id,
          employeeName: 'Weekly',
          count: 2,
        }),
        expect.objectContaining({
          employeeInstanceId: two.id,
          employeeName: 'Monthly',
          count: 1,
        }),
      ]),
    );
    const page = await listChatSessions(f.a.context, f.a.workspaceId, {
      employeeInstanceId: one.id,
      limit: 1,
    });
    const next = await listChatSessions(f.a.context, f.a.workspaceId, {
      employeeInstanceId: one.id,
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(
      [...page.sessions, ...next.sessions].map((s) => s.id).sort(),
    ).toEqual([first.id, third.id].sort());
    expect(second.employeeInstanceId).toBe(two.id);
    await expect(
      createAssignedChatSession(
        f.a.context,
        {
          workspaceId: f.a.workspaceId,
          employeeAssignmentId: f.assignment.id,
          employeeInstanceId: two.id,
        },
        { sessionId: first.id },
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      createChatSession(f.b.context, {
        workspaceId: f.b.workspaceId,
        employeeInstanceId: one.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createChatSession(f.a.context, {
        workspaceId: f.a.workspaceId,
        employeeAssignmentId: f.bAssignment.id,
        employeeInstanceId: one.id,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    // The database also rejects a forged owner/assignment association.
    await expect(
      fixture.db`update allrice_chat_sessions set employee_instance_id=${f.bAssignment.id} where id=${first.id}`,
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('freezes personal metadata and exact source in the actual Run, preserving retries after a personal edit', async () => {
    const f = await setup(),
      i = await f.custom('Original instance'),
      s = await f.session(i.id);
    const input = {
      text: 'Read installed synthetic skill',
      clientMessageId: randomUUID(),
      deliveryMode: 'follow_up',
    };
    const sent = await sendChatMessage(
      f.a.context,
      f.a.workspaceId,
      s.id,
      input,
    );
    const [before] =
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
    expect(before!.execution_snapshot.instance).toMatchObject({
      id: i.id,
      revision: 1,
      profile: { name: 'Original instance' },
      source: i.source,
    });
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'New instance name' },
    });
    expect(
      (await sendChatMessage(f.a.context, f.a.workspaceId, s.id, input)).run.id,
    ).toBe(sent.run.id);
    const next = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      ...input,
      clientMessageId: randomUUID(),
      text: 'Next task',
    });
    const [nextRow] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${next.run.id}`;
    expect(nextRow!.execution_snapshot.instance).toMatchObject({
      id: i.id,
      revision: 2,
      profile: { name: 'New instance name' },
    });
    expect(
      (
        await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`
      )[0],
    ).toEqual(before);
  });
  it('keeps personal identity through publication, recording creation source separately from the current run source', async () => {
    const f = await setup(),
      i = await f.custom('My reviewer'),
      s = await f.session(i.id);
    const saved = await savePlatformEmployeeDraft(f.source.employeeId, {
      definition: { ...f.source.definition, description: 'Updated template' },
      expectedRevisionId: f.source.revisionId,
    });
    await f.source.preview();
    expect(
      (
        await publishPlatformEmployee(f.source.employeeId, {
          scope: 'assigned',
          expectedRevisionId: saved!.currentDraft!.id,
        })
      ).valid,
    ).toBe(true);
    const updated = await getEmployeeInstance(f.a.context, i.id);
    expect(updated).toMatchObject({
      id: i.id,
      revision: 1,
      profile: i.profile,
      creationSource: i.creationSource,
    });
    expect(updated.source).toMatchObject({
      kind: 'platform',
      templateRevisionId: saved!.currentDraft!.id,
    });
    expect(updated.source.employeeVersionId).not.toBe(
      i.source.employeeVersionId,
    );
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      updated.source.employeeVersionId,
    );
    expect(snapshot.source).toEqual(updated.source);
    await expect(
      prepareEmployeeInstanceSnapshot(
        f.a.context,
        s.id,
        f.assignment.id,
        i.source.employeeVersionId,
      ),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
  });
  it('rechecks changed metadata, owner, Session binding, assignment withdrawal and current login before admission', async () => {
    const f = await setup(),
      i = await f.custom('Review'),
      s = await f.session(i.id);
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      i.source.employeeVersionId,
    );
    const admit = () =>
      fixture.db.begin((tx) =>
        assertEmployeeInstanceAdmission(tx, f.a.context, s.id, snapshot),
      );
    await admit();
    await expect(
      fixture.db.begin((tx) =>
        assertEmployeeInstanceAdmission(tx, f.b.context, s.id, snapshot),
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const other = await f.session((await f.custom('Other')).id);
    await expect(
      fixture.db.begin((tx) =>
        assertEmployeeInstanceAdmission(tx, f.a.context, other.id, snapshot),
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Changed while preparing' },
    });
    await expect(admit()).rejects.toMatchObject({ code: 'instance_conflict' });
    await f.change('withdraw');
    await expect(admit()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(f.session(i.id)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await f.change('assign');
    await revokeSession(f.a.login.token);
    await expect(
      createEmployeeInstance(f.a.context, f.input('Revoked login')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('keeps scheduled work independent of browser logins while rechecking current membership', async () => {
    const f = await setup();
    const rule = await createAutomation(f.a.context, {
      workspaceId: f.a.workspaceId,
      employeeAssignmentId: f.assignment.id,
      name: 'Synthetic daily task',
      prompt: 'Return the synthetic count',
      schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' },
    });
    await revokeSession(f.a.login.token);
    await expect(
      createEmployeeInstance(f.a.context, f.input('Expired')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const tick = async () => {
      await fixture.db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 second' where id=${rule.id}`;
      await claimDueAutomations();
      return fixture.db`select r.run_id,r.status,e.execution_snapshot from allrice_automation_runs r left join allrice_employee_runs e on e.run_id=r.run_id where r.automation_id=${rule.id} order by r.created_at`;
    };
    const first = await tick();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      status: 'queued',
      execution_snapshot: {
        instance: { id: f.assignment.id, ownerId: f.a.user.id },
      },
    });
    await fixture.db`update allrice_memberships set active=false where user_id=${f.a.user.id} and organization_id=${f.a.organizationId}`;
    const afterRevocation = await tick();
    expect(afterRevocation).toHaveLength(2);
    expect(afterRevocation[0]!.run_id).toBe(first[0]!.run_id);
    expect(afterRevocation[1]).toMatchObject({
      status: 'failed',
      run_id: null,
    });
  });
  it('serializes simultaneous actual task admissions for one user across two instances without a lock upgrade deadlock', async () => {
    const f = await setup(),
      a = await f.session((await f.custom('A')).id),
      b = await f.session((await f.custom('B')).id);
    const result = await Promise.all(
      [a, b].map((s) =>
        sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
          text: 'Independent task',
          clientMessageId: randomUUID(),
          deliveryMode: 'follow_up',
        }),
      ),
    );
    expect(new Set(result.map((r) => r.run.id)).size).toBe(2);
    const rows =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id in ${fixture.db(result.map((r) => r.run.id))}`;
    expect(rows.map((r) => r.execution_snapshot.instance.id).sort()).toEqual(
      [a.employeeInstanceId, b.employeeInstanceId].sort(),
    );
  }, 30000);
  it('serializes task admission before downstream folder authority takes user SHARE', async () => {
    const f = await setup(),
      a = await f.session((await f.custom('Folder A')).id),
      b = await f.session((await f.custom('Folder B')).id);
    const calls = new Map<string, number>();
    // Isolate the folder-authority port's lock behaviour. Actual folder grant,
    // import and lost-ACK checks remain in folder-triggers.integration.test.ts.
    const spy = vi
      .spyOn(folderTriggers, 'assertFolderTriggerMessage')
      .mockImplementation(async (tx, eventId, context) => {
        await tx`select id from allrice_users where id=${context.actor.id} for share`;
        const n = (calls.get(eventId) ?? 0) + 1;
        calls.set(eventId, n);
        if (n === 2) {
          // At queue admission another event must be unable to acquire SHARE.
          // Otherwise both events could subsequently wait on a lock upgrade.
          await expect(
            fixture.db.begin(async (probe) => {
              await probe`select id from allrice_users where id=${context.actor.id} for share nowait`;
            }),
          ).rejects.toMatchObject({ code: '55P03' });
        }
      });
    try {
      const result = await Promise.all(
        [a, b].map((s) => {
          const eventId = randomUUID();
          return sendChatMessage(
            f.a.context,
            f.a.workspaceId,
            s.id,
            {
              text: 'Folder task',
              clientMessageId: eventId,
              deliveryMode: 'follow_up',
            },
            { folderEventId: eventId },
          );
        }),
      );
      expect(new Set(result.map((r) => r.run.id)).size).toBe(2);
      expect([...calls.values()]).toEqual([2, 2]);
    } finally {
      spy.mockRestore();
    }
  });
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  async function waitingOnLock(pid: number) {
    await expect
      .poll(
        async () =>
          (
            await fixture.db`select wait_event_type from pg_stat_activity where pid=${pid}`
          )[0]?.wait_event_type,
        { timeout: 2000, interval: 10 },
      )
      .toBe('Lock');
  }
  it('admits while a workbench writer waits on the same identity, without a Session→user lock inversion', async () => {
    const f = await setup(),
      i = await f.custom('Concurrent writer'),
      s = await f.session(i.id);
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      i.source.employeeVersionId,
    );
    const locked = gate(),
      proceed = gate(),
      readerReady = gate();
    let readerPid = 0;
    const admission = fixture.db.begin(async (tx) => {
      await lockEmployeeInstanceAdmissionIdentity(tx, f.a.context);
      locked.resolve();
      await proceed.promise;
      await assertEmployeeInstanceAdmission(tx, f.a.context, s.id, snapshot);
    });
    void admission.catch(() => undefined);
    await locked.promise;
    const workbench = fixture.db.begin(async (tx) => {
      readerPid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
      readerReady.resolve();
      await assertWorkbenchSession(tx, f.a.context, s.id, true);
    });
    void workbench.catch(() => undefined);
    try {
      await readerReady.promise;
      await waitingOnLock(readerPid);
    } finally {
      proceed.resolve();
    }
    expect(
      (await Promise.allSettled([admission, workbench])).map((r) => r.status),
    ).toEqual(['fulfilled', 'fulfilled']);
  });
  it('permits publication FK checks while admission waits on its assignment', async () => {
    const f = await setup(),
      i = await f.custom('Publishing'),
      s = await f.session(i.id);
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      i.source.employeeVersionId,
    );
    const locked = gate(),
      publish = gate(),
      admissionReady = gate();
    let admissionPid = 0;
    const publication = fixture.db.begin(async (tx) => {
      // The same assignment/skill-binding sequence used by materialization.
      await tx`select id from allrice_employee_assignments where id=${f.assignment.id} for no key update`;
      locked.resolve();
      await publish.promise;
      const [binding] =
        await tx`delete from allrice_employee_dsh_skill_bindings where employee_id=${f.assignment.employeeId} returning *`;
      if (!binding) throw Error('fixture_binding_missing');
      await tx`insert into allrice_employee_dsh_skill_bindings(organization_id,workspace_id,employee_id,skill_id,bound_by)
        values(${binding.organization_id},${binding.workspace_id},${binding.employee_id},${binding.skill_id},${f.a.user.id})`;
    });
    void publication.catch(() => undefined);
    await locked.promise;
    const admission = fixture.db.begin(async (tx) => {
      admissionPid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
      await lockEmployeeInstanceAdmissionIdentity(tx, f.a.context);
      admissionReady.resolve();
      await assertEmployeeInstanceAdmission(tx, f.a.context, s.id, snapshot);
    });
    void admission.catch(() => undefined);
    try {
      await admissionReady.promise;
      await waitingOnLock(admissionPid);
    } finally {
      publish.resolve();
    }
    expect(
      (await Promise.allSettled([publication, admission])).map((r) => r.status),
    ).toEqual(['fulfilled', 'fulfilled']);
  });
  it('reads a stored legacy Run without adding instance data or rewriting its frozen JSON', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = await createAssistantAuthorityFixture(fixture.db, {
      memberRole: 'member',
    });
    const before = (
      await fixture.db`select execution_snapshot::text snapshot,prompt_snapshot::text prompt from allrice_employee_runs where run_id=${f.rootRunId}`
    )[0]!;
    expect(JSON.parse(before.snapshot)).not.toHaveProperty('instance');
    await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
    const { getChatSessionHistory } = await import('../workspace/service.ts');
    const login = await createSession(f.user);
    const context = await authenticateSession(login.token, {
      organizationId: f.org,
      workspaceId: f.workspace,
    });
    if (!context) throw Error('fixture_login');
    const history = await getChatSessionHistory(
      context,
      f.workspace,
      f.session,
    );
    expect(history.session.employeeInstanceId).toBe(f.assignment);
    expect(
      (
        await fixture.db`select execution_snapshot::text snapshot,prompt_snapshot::text prompt from allrice_employee_runs where run_id=${f.rootRunId}`
      )[0],
    ).toEqual(before);
  });
  it('keeps an existing native assistant root canceled after the archived instance is restored', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = await createAssistantAuthorityFixture(fixture.db, {
      memberRole: 'member',
    });
    await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
    const context = await authenticateSession(
      (await createSession(f.user)).token,
      { organizationId: f.org, workspaceId: f.workspace },
    );
    if (!context) throw Error('fixture_login');
    const input = {
      workspaceId: f.workspace,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    };
    await changeEmployeeInstanceLifecycle(context, f.assignment, input);
    const [cutoff] =
      await fixture.db`select cancel_request_id,cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    expect(cutoff!.cancel_request_id).not.toBeNull();
    await changeEmployeeInstanceLifecycle(context, f.assignment, {
      ...input,
      requestId: randomUUID(),
      expectedRevision: 2,
      operation: 'restore',
      sourceRevision: 1,
    });
    expect(
      (
        await fixture.db`select cancel_request_id,cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`
      )[0],
    ).toEqual(cutoff);
    expect(
      await f.runtime.assertCurrentAuthority({
        scope: f.task.scope,
        rootRunId: f.rootRunId,
        worker: f.worker,
      }),
    ).toEqual({ cancelRequested: true });
  });
  it('maps legacy Sessions to their original default, labels unprovable provenance honestly, and leaves old Run JSON intact', async () => {
    const f = await setup();
    const s = await f.session(f.assignment.id);
    await fixture.db`update allrice_chat_sessions set employee_instance_id=null where id=${s.id}`;
    await fixture.db`delete from allrice_employee_version_sources where employee_version_id=${f.assignment.currentVersion.id}`;
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      f.assignment.currentVersion.id,
    );
    expect(snapshot.id).toBe(f.assignment.id);
    expect(snapshot.source).toEqual({
      kind: 'tenant_version',
      employeeVersionId: f.assignment.currentVersion.id,
    });
    expect(
      (await listChatSessions(f.a.context, f.a.workspaceId)).sessions[0]!
        .employeeInstanceId,
    ).toBe(f.assignment.id);
    expect(
      (
        await fixture.db`select employee_instance_id from allrice_chat_sessions where id=${s.id}`
      )[0]!.employee_instance_id,
    ).toBeNull();
  });
});
