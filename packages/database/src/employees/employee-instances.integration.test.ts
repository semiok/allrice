import { assembleEmployeeKernel } from '../../../../apps/worker/src/employee-kernel.js';
import {
  prepareEmployeeRunBinding,
  resolveEmployeeExecution,
} from './employeehub.ts';
import { captureReferenceSelections } from '../reference-runtime.ts';
import { freezeChatRunExecutionBinding } from '../conversation/native-session-binding.ts';
import { isBaseRiceInstance } from './employee-instance-policy.ts';
import { sharedEmployeeMethodTarget } from './employee-method-target.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';
import { sceneSkillFixture } from './employee-scene-skills.fixture.ts';
import type { RequestContext } from '@allrice/contracts';
import {
  listPersonalSceneSkills,
  savePersonalSceneSkill,
  getPersonalSceneSkillResource,
} from './personal-scene-skills.ts';
import {
  inspectPersonalSceneSkill,
  listPersonalSceneReads,
} from './personal-scene-reads.ts';
import { heartbeatJob } from '../execution/queue.ts';
import { createReadPathProbe } from '../read-path-probe.fixture.ts';
import { sharedHistoryMethodAcceptancePhrases } from './employee-method-shared-history.fixture.ts';
import { seedHistoricalEmployeeContent } from './employee-method-history.fixture.ts';
import {
  employeeChatIdentity,
  employeeChatUuid,
} from './employee-chat-authority.ts';
import {
  appendNativeModelReceipt,
  bindJobNativeSession,
} from '../execution/queue.ts';
import {
  nativeBindingDescriptor,
  nativeBindingWaiter,
} from '../native-session-binding.fixture.ts';
import { bindNativeQuestionFixture } from '../native-question-binding.fixture.ts';
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
import type { RuntimeNativeInputProof } from '@allrice/contracts';
import {
  CurrentPlatformTestOriginSchema,
  freezePlatformTestExecutionBinding,
  newCurrentPlatformTestOrigin,
} from '../conversation/current-platform-test-binding.ts';
import { searchToolBrokerMemories } from '../execution/tool-broker.ts';
import * as toolSelection from '@allrice/contracts';
import {
  prepareEmployeeMethodActivationFromChat,
  activateEmployeeMethodFromChat,
  employeeMethodActivationChanges,
} from './employee-method-activation.ts';
import { askUserQuestionArguments } from './ask-user-question.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
} from '../conversation/conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
  rejectConversationSteer,
} from '../conversation/conversation-input.ts';
import {
  claimMethodFileExecution,
  methodFileExecutionUnverified,
} from './employee-method-file-runtime.ts';
import {
  ExecutionContextSchema,
  cloudToolchainImageV1,
  cloudPlatform,
} from '@allrice/contracts';
import {
  createEmployeeMethodFileOperation,
  publishCloudOperationArtifacts,
  loadCloudCommandInputs,
} from '../cloud-execution.ts';
import { runtimeFixtureStorage } from '../runtime.fixture.ts';
import { getStoredFile } from '../data.ts';
import {
  inspectEmployeeMethodFromChat,
  saveEmployeeMethodFromChat,
  restoreEmployeeMethodFromChat,
  saveEmployeeMethodAndPublishFromChat,
  restoreEmployeeMethodAndPublishFromChat,
  filterEmployeeMethodMemories,
} from './employee-method-chat.ts';
import {
  startEmployeeMethodTestFromChat,
  getEmployeeMethodTest,
  employeeMethodTestStillCurrent,
  readEmployeeMethodActivationTest,
} from './employee-method-tests.ts';
import { freezeRouteSubscriptionSnapshot } from '../execution/route-subscription.ts';
import {
  readPlatformModelSettings,
  updatePlatformModelSettings,
} from '../providers/platform-model-settings.ts';
import { resolveSubscriptionSnapshot } from '@allrice/contracts';
import {
  readEmployeeRuntimeContent,
  loadPersonalRuntimeSceneSkill,
  prepareEmployeeContentContext,
  assertEmployeeContentContext,
  assertEmployeeContentReferenceMessages,
} from './employee-runtime-content.ts';
import {
  freezeEmployeeRuntimeContent,
  freezeEmployeeMethodActivationCandidate,
  getEmployeeContentSet,
  getEffectiveEmployeeContent,
  getEmployeeDetails,
  getEmployeeContentHistory,
} from './employee-content.ts';
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
import { lockSchedulePrincipal } from '../native-schedule-authority.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { assertWorkbenchSession } from '../artifact-review.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { createLocalCommandFixture } from '../local-command.fixture.ts';
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

const e3HttpAuth = vi.hoisted(() => ({
  context: null as RequestContext | null,
}));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => e3HttpAuth.context,
}));

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET179 employee instances (isolated PostgreSQL; no model)', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    // Synthetic SQL approval only; production must provide a measured artifact.
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
    fixture = await createRuntimeFixtureDatabase();
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
  async function setup(profileWrite = false, basicRice = false) {
    const slug = `instance-${randomUUID()}`;
    const admin = await principal(undefined, 'admin'),
      a = await principal(slug),
      b = await principal(slug);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
    const original = await createEmployeeAdministrationFixture(fixture.db);
    const [rice] = basicRice
      ? await fixture.db`select id from allrice_platform_employees where employee_key='rice'`
      : [];
    const source = basicRice
      ? {
          ...original,
          employeeId: rice!.id as string,
          definition: {
            ...original.definition,
            key: 'rice',
            name: 'Platform assistant',
          },
        }
      : original;
    if (profileWrite || basicRice)
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            toolNames: ['workspace.skill.read', 'workspace.export.create'],
          },
        },
        ...(!basicRice ? { expectedRevisionId: source.revisionId } : {}),
      });
    await source.preview(source.employeeId);
    expect((await source.publish(source.employeeId)).valid).toBe(true);
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
    const assignment = (
      await getEmployeeWorkspace(a.context, a.workspaceId)
    ).employees.find(
      (e) =>
        e.employeeKey ===
        (basicRice ? 'default-assistant' : source.definition.key),
    )!;
    const bAssignment = (
      await getEmployeeWorkspace(b.context, b.workspaceId)
    ).employees.find(
      (e) =>
        e.employeeKey ===
        (basicRice ? 'default-assistant' : source.definition.key),
    )!;
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
  /** Synthetic pre-retirement Run. Every immutable field is present on its
   * first INSERT; normal methodRun/profileRun always use the real selector. */
  async function historicalMethodRun(
    f: Awaited<ReturnType<typeof setup>>,
    instanceId: string,
    text = '请保存我的工作场景候选：每周对账和每月对账，保留原始数据。',
    sessionId?: string,
    referenceRevisionIds: string[] = [],
  ) {
    const session = sessionId ? { id: sessionId } : await f.session(instanceId);
    const userMessageId = randomUUID(),
      assistantMessageId = randomUUID();
    const runId = randomUUID(),
      jobId = randomUUID(),
      policyId = randomUUID();
    const workerId = randomUUID(),
      leaseToken = randomUUID();
    await fixture.db.begin(async (tx) => {
      await tx`select id from allrice_users where id=${f.a.user.id} for no key update`;
      const [policyVersion] = await tx<{ version: number }[]>`
        select coalesce(max(version),0)::int+1 version from allrice_policy_snapshots
        where organization_id=${f.a.organizationId} and subject_id=${f.a.user.id}`;
      const references = await captureReferenceSelections(
        f.a.context,
        referenceRevisionIds,
        tx,
      );
      const conversation = await tx<
        { id: string; role: 'user' | 'assistant'; text: string }[]
      >`
        select id,role,content->>'text' text from allrice_messages
        where session_id=${session.id} and status='completed' order by created_at,id`;
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status,client_message_id)
        values(${userMessageId},${f.a.organizationId},${f.a.workspaceId},${session.id},${f.a.user.id},'user',
          ${tx.json({ text, citations: [], referenceSelections: references })},'completed',${randomUUID()})`;
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status,reply_to_id)
        values(${assistantMessageId},${f.a.organizationId},${f.a.workspaceId},${session.id},${f.a.user.id},'assistant',
          '{"text":"Synthetic historical response","citations":[]}', 'pending',${userMessageId})`;
      const [target] = await tx<
        { employee_assignment_id: string; employee_version_id: string }[]
      >`
        select employee_assignment_id,employee_version_id from allrice_chat_sessions where id=${session.id}`;
      const binding = await prepareEmployeeRunBinding(
        {
          context: f.a.context,
          workspaceId: f.a.workspaceId,
          assignmentId: target!.employee_assignment_id,
          employeeVersionId: target!.employee_version_id,
          sessionId: session.id,
          userMessageId,
          assistantMessageId,
          promptSnapshot: {
            systemPrompt: '',
            conversation,
            memories: [],
            userRequest: text,
            referenceSelections: references,
          },
        },
        tx,
      );
      const snapshot = binding.executionSnapshot;
      const baseRice = snapshot.instance
        ? await isBaseRiceInstance(snapshot.instance, tx)
        : false;
      const oldTools = toolSelection
        .employeeCustomizationToolsForInstance(
          snapshot.instance?.kind,
          baseRice,
        )
        .filter((tool) =>
          snapshot.capabilitySnapshot.grantedCapabilities.includes(
            tool.capability,
          ),
        )
        .map((tool) => tool.name);
      const frozen = toolSelection.EmployeeExecutionSnapshotSchema.parse({
        ...snapshot,
        capabilitySnapshot: {
          ...snapshot.capabilitySnapshot,
          bindings: {
            ...snapshot.capabilitySnapshot.bindings,
            toolNames: [
              ...new Set([
                ...snapshot.capabilitySnapshot.bindings.toolNames,
                ...oldTools,
              ]),
            ],
          },
        },
        tenantContext: {
          organizationId: f.a.organizationId,
          workspaceId: f.a.workspaceId,
          actorId: f.a.user.id,
          policySnapshotId: policyId,
        },
        createdAt: new Date().toISOString(),
      });
      await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
        values(${policyId},${f.a.organizationId},${f.a.user.id},${policyVersion!.version},${tx.json(
          {
            memberships: f.a.context.memberships,
            grants: [
              {
                resourceType: 'job',
                action: 'job:execute',
                workspaceId: f.a.workspaceId,
              },
              ...['storage_object', 'memory', 'chat_session'].map(
                (resourceType) => ({
                  resourceType,
                  action: 'resource:read',
                  workspaceId: f.a.workspaceId,
                }),
              ),
            ],
          },
        )},clock_timestamp()+interval '1 hour')`;
      const input = {
        employeeAssignmentId: binding.employeeAssignmentId,
        employeeVersionId: binding.employeeVersionId,
        sessionId: session.id,
        userMessageId,
        assistantMessageId,
      };
      await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
        values(${runId},${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},'queued',${policyId},
          ${tx.json({ schemaVersion: 1, handler: 'allrice.employee.run', employeeVersionId: binding.employeeVersionId, provider: 'codex' })},${tx.json(input)})`;
      await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
        values(${jobId},${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},${runId},'claimed',${randomUUID()},clock_timestamp()+interval '1 hour',
          ${tx.json({ schemaVersion: 1, type: 'allrice.employee.run', input })},${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
      const native = await freezeChatRunExecutionBinding(tx, {
        organizationId: f.a.organizationId,
        workspaceId: f.a.workspaceId,
        ownerId: f.a.user.id,
        sessionId: session.id,
        runId,
        employeeVersionId: binding.employeeVersionId,
        executionSnapshot: frozen,
      });
      await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,
        user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,skill_bindings,native_skills,execution_snapshot,native_execution_binding)
        values(${runId},${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},${binding.employeeAssignmentId},${binding.employeeVersionId},${session.id},
          ${userMessageId},${assistantMessageId},${tx.json(binding.providerSnapshot)},${tx.json(binding.promptSnapshot)},${tx.json(binding.skillBindings)},
          ${tx.json(binding.nativeSkills)},${tx.json(JSON.parse(JSON.stringify(frozen)))},${native ? tx.json(native) : null})`;
    });
    const execution = await queue.startClaimedJob(workerId, jobId, leaseToken);
    if (!execution) throw new Error('historical_run_fixture_failed_to_start');
    const [row] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${runId}`;
    const scope = {
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      ownerId: f.a.user.id,
      sessionId: session.id,
      runId,
    };
    const runtime = await prepareEmployeeContentContext(scope);
    if (!runtime) throw new Error('historical_run_content_context_missing');
    const finish = async () => {
      await fixture.db`update allrice_jobs set status='succeeded',completed_at=now() where run_id=${runId}`;
      await fixture.db`update allrice_runs set state='succeeded',completed_at=now() where id=${runId}`;
      await fixture.db`update allrice_employee_runs set status='succeeded',completed_at=now() where run_id=${runId}`;
    };
    return {
      context: execution.context,
      sessionId: session.id,
      userMessageId,
      worker: { attempt: execution.job.attempt, leaseToken },
      callId: randomUUID(),
      frozen: row!.execution_snapshot,
      scope,
      runtime,
      finish,
    };
  }
  // Complete historical snapshots only. No partial-edit merge, permission,
  // intent, CAS or activation behavior is implemented by this fixture.
  async function historicalMethod(
    f: Awaited<ReturnType<typeof setup>>,
    instanceId: string,
    snapshot: {
      sharedTarget?: toolSelection.EmployeeMethodSharedTarget;
      common?: string;
      scenes: {
        id?: string;
        name: string;
        appliesWhen: string;
        procedure?: string;
        references?: toolSelection.EmployeeContentReference[];
      }[];
    },
    options: Parameters<typeof seedHistoricalEmployeeContent>[3] & {
      requestId?: string;
    } = {},
  ) {
    const shared = snapshot.sharedTarget;
    const [existing] =
      await fixture.db`select id from allrice_employee_content_sets
      where instance_id=${instanceId} and scope='personal'`;
    const edits: unknown[] = [];
    const text = (kind: 'requirement' | 'procedure', body: string) => {
      const contentId = randomUUID();
      edits.push({
        contentId,
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind,
        title: 'Explicit historical fixture',
        body,
      });
      return { sourceKind: 'draft_text', contentId };
    };
    return seedHistoricalEmployeeContent(
      fixture.db,
      f.a.context,
      {
        operation: 'save_draft',
        workspaceId: f.a.workspaceId,
        setId:
          shared?.setId ??
          existing?.id ??
          employeeChatUuid('employee-method', instanceId),
        requestId: options.requestId ?? randomUUID(),
        ownership: shared
          ? {
              scope: shared.scope,
              organizationId: f.a.organizationId,
              ...(shared.scope === 'department'
                ? { departmentId: shared.departmentId }
                : {}),
            }
          : {
              scope: 'personal',
              organizationId: f.a.organizationId,
              ownerId: f.a.user.id,
            },
        target: shared
          ? { kind: 'employee', employeeId: shared.employeeId }
          : { kind: 'instance', instanceId },
        expectedRevision: 0,
        changeSummary: 'Explicit pre-retirement snapshot',
        textEdits: edits,
        manifest: {
          schemaVersion: 1,
          common: snapshot.common ? [text('requirement', snapshot.common)] : [],
          scenes: snapshot.scenes.map((scene) => ({
            id: scene.id ?? randomUUID(),
            name: scene.name,
            appliesWhen: scene.appliesWhen,
            references: [
              ...(scene.references ?? []),
              ...(scene.procedure ? [text('procedure', scene.procedure)] : []),
            ],
          })),
          declaredConflicts: [],
        },
      },
      options,
    );
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
    if (department === 'selected' || department === 'company')
      await departmentInfo!.configure(
        f.a.user.id,
        departmentInfo!.department.id,
        'company',
      );
    const [assignment] =
      await fixture.db`select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`;
    if (department === 'company') {
      const textId = randomUUID();
      await seedHistoricalEmployeeContent(
        fixture.db,
        f.a.context,
        {
          workspaceId: f.a.workspaceId,
          setId: randomUUID(),
          ownership: {
            scope: 'department',
            organizationId: f.a.organizationId,
            departmentId: departmentInfo!.department.id,
          },
          target: { kind: 'employee', employeeId: assignment!.employee_id },
          changeSummary: 'Existing department requirement',
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
        },
        { active: true },
      );
    }
    if (inheritedCommon)
      await seedHistoricalEmployeeContent(
        fixture.db,
        f.a.context,
        {
          workspaceId: f.a.workspaceId,
          setId: randomUUID(),
          ownership: { scope: 'company', organizationId: f.a.organizationId },
          target: { kind: 'employee', employeeId: assignment!.employee_id },
          changeSummary: 'Pre-existing synthetic company scene',
          operation: 'save_draft',
          expectedRevision: 0,
          requestId: randomUUID(),
          textEdits: [],
          manifest: {
            schemaVersion: 1,
            common: [],
            scenes: [
              {
                id: randomUUID(),
                name: '公司继承场景',
                appliesWhen: '固定合成业务',
                references: [],
              },
            ],
            declaredConflicts: [],
          },
        },
        { active: true },
      );
    if (department)
      await historicalMethod(
        f,
        instance.id,
        {
          scenes: [
            {
              name: '私有机密',
              appliesWhen: 'Private',
              procedure: 'PRIVATE-CONTENT-MUST-NOT-ENTER-SHARED-TEST',
            },
          ],
        },
        { active: true },
      );
    if (caseId === 'cny-file-flow-v1') await methodFileCloud(f);
    const editing = await historicalMethodRun(
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
    const saved = await historicalMethod(f, instance.id, {
      ...shared,
      ...(inheritedCommon ? { common: '所有场景均增加固定校验' } : {}),
      scenes: [
        {
          name: department ? '金额合计' : '金额汇总',
          appliesWhen: '固定合成数据',
          procedure: '只将整数分相加',
        },
      ],
    });
    await editing.finish();
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
    const run = await historicalMethodRun(f, instance.id, testingText);
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

  it('binds a real method-candidate preview to its own test identity and lease', async () => {
    const x = await retryFixture(),
      workerId = randomUUID();
    const test = (await claimNextPlatformEmployeeTestRun(workerId))!;
    expect(test.id).toBe(x.test.id);
    expect(test.methodCandidate).toBeDefined();
    const input = {
      workerId,
      jobId: test.previewExecution.jobId,
      leaseToken: test.previewExecution.leaseToken,
      attempt: test.previewExecution.jobAttempt,
      subject: { kind: 'platform_employee_test' as const, id: test.id },
      descriptor: nativeBindingDescriptor({
        ...test.previewContext,
        contextKey: test.id,
        distributionGeneration: test.runtimeProfile.distributionGeneration,
      }),
    };
    expect((await bindJobNativeSession(input)).binding.contextId).toBe(test.id);
    await x.fail(test.id);
    await expect(bindJobNativeSession(input)).rejects.toBeDefined();
  }, 30000);

  async function claimActivationTest(
    f: Awaited<ReturnType<typeof setup>>,
    test: { id: string },
  ) {
    const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim?.id).toBe(test.id);
    const method = claim!.methodCandidate!;
    if (!method.modelSnapshot.credentialReference)
      throw Error('fixture credential missing');
    const subscription = resolveSubscriptionSnapshot({
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
    native = false,
    sqlReceipt = false,
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
      const testing = await historicalMethodRun(
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
    const run = await historicalMethodRun(
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
    const preview = sqlReceipt
      ? await fixture.db.begin(async (tx) => {
          const { scope, requestId } = employeeChatIdentity({
            ...run,
            arguments: preparation,
          });
          const content = await freezeEmployeeMethodActivationCandidate(
            scope,
            { ...preparation, instanceId: instance.id },
            tx,
            false,
          );
          const tests: Awaited<
            ReturnType<typeof readEmployeeMethodActivationTest>
          >[] = [];
          for (const id of preparation.testIds)
            tests.push(
              await readEmployeeMethodActivationTest(
                tx,
                scope,
                instance.id,
                id,
                run.frozen.modelSnapshot,
                content.testCoverage?.views ? content : undefined,
              ),
            );
          const snapshot = {
            content,
            changes: employeeMethodActivationChanges(
              content.activeManifest,
              content.manifest,
            ),
            tests,
            modelSettings: await readPlatformModelSettings(),
          };
          const question = toolSelection.UserQuestionItemSchema.parse({
            id: toolSelection.methodActivationQuestionPrefix + requestId,
            question: 'Synthetic historical review',
            multiSelect: false,
            options: [
              { label: toolSelection.methodActivationApprove },
              { label: toolSelection.methodActivationDecline },
            ],
          });
          const [row] = await tx`insert into allrice_employee_method_activations
            (id,organization_id,workspace_id,owner_id,instance_id,session_id,source_run_id,source_job_id,source_attempt,request_digest,snapshot,snapshot_digest,question)
            values(${requestId},${scope.organizationId},${scope.workspaceId},${scope.actor.id},${instance.id},${run.sessionId},${run.context.runId},${run.context.jobId},${run.worker.attempt},${runtimePolicyDigest(preparation)},${tx.json(snapshot)},${runtimePolicyDigest(snapshot)},${tx.json(question)}) returning expires_at`;
          return {
            receiptId: requestId,
            enabled: false as const,
            question,
            askUserQuestion: askUserQuestionArguments(question),
            expiresAt: row!.expires_at.toISOString(),
            preview: snapshot,
          };
        })
      : await prepareEmployeeMethodActivationFromChat({
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
    const threadId = native
      ? `dsh-${run.sessionId}-${randomUUID()}`
      : `native-${randomUUID()}`;
    let turnId = native ? `${threadId}:turn:1` : `turn-${randomUUID()}`;
    await bindConversationThread({ ...runtime, threadId });
    if (native)
      await bindNativeQuestionFixture(fixture.db, run.context.runId, threadId);
    let binding = await recordConversationTurn({
      ...runtime,
      threadId,
      turnId,
    });
    const callId = `ask-${randomUUID()}`;
    const questionId = native
      ? `${threadId}:${callId}`
      : `question-${randomUUID()}`;
    const publicQuestion = toolSelection.UserQuestionItemSchema.omit({
      detail: true,
      intent: true,
    })
      .strip()
      .parse(preview.question);
    const project = (
      sequence: number,
      answers?: unknown[],
      projectedQuestion = publicQuestion,
      source = run,
    ) =>
      queue.appendJobEvent({
        workerId: source.context.worker.id,
        jobId: source.context.jobId,
        leaseToken: source.worker.leaseToken,
        type: 'harness.native',
        payload: {
          source: 'dsh',
          sourceEventType: 'session/user-questions',
          nativePayload: {
            sessionId: threadId,
            sequence,
            questions: {
              active: answers
                ? []
                : [{ callId, state: 'open', questions: [projectedQuestion] }],
              settled: answers ? [{ callId, answers }] : [],
            },
          },
        },
      });
    const show = async (
      question = preview.question,
      projectedQuestion = publicQuestion,
    ) => {
      if (native) {
        await fixture.db`update allrice_settings set value='"timed"'::jsonb where scope_type='system' and key='native_question_mode'`;
        await project(1, undefined, projectedQuestion);
      }
      return queue.appendJobEvent({
        workerId: run.context.worker.id,
        jobId: run.context.jobId,
        leaseToken: run.worker.leaseToken,
        type: 'harness.native',
        payload: {
          source: 'dsh',
          sourceEventType: 'session/user-question',
          nativePayload: {
            questionId,
            questions: [question],
            ...(native
              ? { nativeSessionId: threadId, callId, durable: true }
              : {}),
          },
        },
      });
    };
    const answer = async (
      selected = ['确认启用'],
      custom?: string,
      adopt = true,
      checkpoint:
        'question_resolved' | 'question_replied' = 'question_resolved',
      nativeAnswer?: (inputId: string) => Promise<RuntimeNativeInputProof>,
    ) => {
      if (native && checkpoint === 'question_replied') {
        turnId = `${threadId}:turn:2`;
        binding = await recordConversationTurn({
          ...runtime,
          threadId,
          turnId,
        });
      }
      const clientMessageId = randomUUID();
      await sendChatMessage(f.a.context, f.a.workspaceId, run.sessionId, {
        // The chat page labels a skipped item "跳过".
        text: custom ?? (selected.join('，') || '跳过'),
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
      const proof = nativeAnswer
        ? await nativeAnswer(clientMessageId)
        : {
            status: 'adopted' as const,
            inputId: clientMessageId,
            messageId: questionId,
            turnId,
            sequence: 5,
            checkpoint,
            ...(native ? { callId } : {}),
          };
      if (native && adopt)
        await project(6, [
          { id: preview.question.id, selected, ...(custom ? { custom } : {}) },
        ]);
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
      callId,
      project,
      show,
      answer,
      activate,
    };
  }

  const activationFootprint = (
    x: Awaited<ReturnType<typeof activationFixture>>,
  ) =>
    fixture.db`select s.*,to_jsonb(a) activation,er.method_authoring,er.execution_snapshot,to_jsonb(c) context,
      (select count(*)::int from allrice_employee_content_requests where set_id=s.id) requests,
      (select count(*)::int from allrice_employee_content_publications where set_id=s.id) publications
      from allrice_employee_content_sets s join allrice_employee_method_activations a on a.id=${x.preview.receiptId}
      join allrice_employee_runs er on er.run_id=${x.run.context.runId}
      join allrice_employee_content_contexts c on c.generation_id=er.content_generation_id where s.id=${x.saved.setId}`;

  // Historical publication/consumption metadata, never a product activation.
  async function seedHistoricalMethodPublication(
    x: Awaited<ReturnType<typeof activationFixture>>,
    consumed = false,
  ) {
    const current = await getEmployeeContentSet(x.f.a.context, x.saved.setId);
    const candidate = current.set.candidate!;
    const validation = {
      valid: true,
      issues: [],
      dependencyDigest: x.preview.preview.content.dependencyDigest,
      semanticConsistency: 'not_proven' as const,
    };
    const receipt = {
      ...x.saved,
      revision: x.saved.revision + (consumed ? 2 : 0),
      active: x.saved.candidate,
      validation,
    };
    await fixture.db.begin(async (tx) => {
      await tx`insert into allrice_employee_content_publications(set_id,revision_id)
        values(${x.saved.setId},${candidate.id}) on conflict do nothing`;
      await tx`update allrice_employee_content_sets set active_revision_id=${candidate.id} where id=${x.saved.setId}`;
      const refs = new Map(
        [
          ...candidate.manifest.common,
          ...candidate.manifest.scenes.flatMap((scene) => scene.references),
        ].map((ref) => [`${ref.contentId}:${ref.revisionId}`, ref]),
      );
      for (const ref of refs.values()) {
        if (!['requirement', 'procedure'].includes(ref.sourceKind)) continue;
        await tx`insert into allrice_company_asset_publications(asset_id,revision_id,published_by)
          values(${ref.contentId},${ref.revisionId},${x.f.a.user.id}) on conflict do nothing`;
        await tx`update allrice_company_assets set state='published',published_revision_id=${ref.revisionId},revision=revision+1
          where id=${ref.contentId} and latest_revision_id=${ref.revisionId}`;
      }
      if (consumed) {
        await tx`update allrice_employee_content_sets set revision=${receipt.revision},validation=${tx.json(validation)} where id=${x.saved.setId}`;
        await tx`update allrice_employee_method_activations set consumed_at=clock_timestamp(),response=${tx.json(receipt)}
            where id=${x.preview.receiptId}`;
      }
    });
    return receipt;
  }

  async function publishDepartmentOverlay(
    x: Awaited<ReturnType<typeof retryFixture>>,
    departmentId: string,
    count = 1,
  ) {
    const [assignment] =
      await fixture.db`select employee_id from allrice_employee_assignments where id=${x.instance.assignmentId}`;
    const [old] =
      await fixture.db`select s.*, r.manifest from allrice_employee_content_sets s
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
    return seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
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
      },
      { active: true },
    );
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
      base.saved = await seedHistoricalEmployeeContent(
        fixture.db,
        base.f.a.context,
        {
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
        },
      );
    }
    await publishDepartmentOverlay(
      base,
      base.departmentInfo!.department.id,
      full32 ? 0 : 1,
    );
    if (!full32)
      await publishDepartmentOverlay(base, base.departmentInfo!.other.id);
    const content = await getEmployeeContentSet(
      base.f.a.context,
      base.saved.setId,
    );
    const textId = randomUUID();
    const saved = await seedHistoricalEmployeeContent(
      fixture.db,
      base.f.a.context,
      {
        operation: 'save_draft',
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
        expectedRevision: base.saved.revision,
        requestId: randomUUID(),
        changeSummary:
          'Historical company requirements for all execution views',
        manifest: {
          ...content.set.candidate!.manifest,
          common: [{ sourceKind: 'draft_text', contentId: textId }],
        },
        textEdits: [
          {
            contentId: textId,
            revisionId: randomUUID(),
            expectedRevision: 0,
            kind: 'requirement',
            title: 'Historical company requirements',
            body:
              '金额一律使用人民币整数分；只将输入金额相加，不增加其他金额。' +
              (full32 ? '保留依据及原始记录。'.repeat(160) : ''),
          },
        ],
      },
    );
    const run = await historicalMethodRun(
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

  it('MET-210 populated employee method test GET commits without a transaction id', async () => {
    const x = await retryFixture();
    const probe = createReadPathProbe(fixture.db);
    vi.spyOn(client, 'getDatabase').mockReturnValue(probe.db);
    try {
      const result = await getEmployeeMethodTest(x.f.a.context, x.test.id);
      expect(result.id).toBe(x.test.id);
      expect(result.status).toBe('queued');
      probe.expectNoRowLocks();
    } finally {
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      // Settle the queued test so the next case claims its own.
      expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
        x.test.id,
      );
      await x.fail(x.test.id);
    }
  });

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
        // The GET takes no content lock since MET-210 #4. Pause it on its
        // current-content read instead; finalization never touches this table.
        await tx`lock table allrice_employee_content_sets in access exclusive mode`;
        const [row] = await tx`select pg_backend_pid() pid`;
        locked(row!.pid);
        await proceed;
      });
      void gate.catch(() => undefined);
      const pid = await ready;
      // The current-content read comes after the method binding and before
      // the platform test status. Finalize through the real atomic writer
      // while this GET is paused between those reads.
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
    await expect(x.activate()).rejects.toMatchObject({
      code: 'legacy_method_retired',
    });
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
      const run = await historicalMethodRun(
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

  it('candidate test pagination is exact at sub-millisecond timestamps and rejects foreign or stale candidate anchors', async () => {
    const x = await companyCommonFixture();
    await passActivationTest(x.f, x.test);
    const [method] =
      await fixture.db`select to_jsonb(t) data from allrice_employee_method_tests t where test_id=${x.test.id}`;
    const [platform] =
      await fixture.db`select to_jsonb(t) data from allrice_platform_employee_test_runs t where id=${x.test.id}`;
    const originalOrigin = CurrentPlatformTestOriginSchema.parse(
      platform!.data.native_root_origin,
    );
    const frozenSource = {
      platformEmployeeId: platform!.data.employee_id,
      platformRevisionId: platform!.data.revision_id,
      purpose: 'method_candidate' as const,
      definitionChecksum: originalOrigin.birthSource.definitionChecksum,
      definition: platform!.data.frozen_definition,
      runtimeProfile: platform!.data.frozen_runtime_profile,
      nativeSkills: platform!.data.frozen_native_skills,
      packageChecksum: platform!.data.frozen_package_checksum,
    };
    const clone = async (owner = x.f.a.user.id, index = 0) => {
      const id = randomUUID(),
        requestId = randomUUID();
      const created = `2027-01-01T00:00:00.${index % 2 ? '000001' : '000002'}Z`;
      const scope = { ...originalOrigin.scope, ownerId: owner, testId: id };
      const origin = newCurrentPlatformTestOrigin({
        scope,
        source: frozenSource,
      });
      const executionBinding = freezePlatformTestExecutionBinding({
        origin,
        scope,
        source: frozenSource,
      });
      // Synthetic history only, no extra execution. Each new row needs its
      // own coherent first-INSERT identity rather than the original test ID.
      await fixture.db`insert into allrice_platform_employee_test_runs select (jsonb_populate_record(null::allrice_platform_employee_test_runs,${fixture.db.json({ ...platform!.data, id, created_at: created, input: { ...platform!.data.input, ownerId: owner }, native_root_origin: origin, native_execution_binding: executionBinding })})).*`;
      await fixture.db`insert into allrice_employee_method_tests select (jsonb_populate_record(null::allrice_employee_method_tests,${fixture.db.json({ ...method!.data, test_id: id, owner_id: owner, request_id: requestId, binding_digest: `synthetic:${id}`, created_at: created, run_id: null, route_decision_id: null })})).*`;
      return id;
    };
    for (let i = 0; i < 35; i++) await clone(x.f.a.user.id, i);
    const foreign = await clone(x.f.b.user.id);
    const run = await historicalMethodRun(
      x.f,
      x.instance.id,
      '请查看公司候选测试记录。',
    );
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
    const edit = await historicalMethodRun(
      x.f,
      x.instance.id,
      '请移除公司的“金额合计”工作场景。',
    );
    const existing = (await getEmployeeContentSet(x.f.a.context, x.saved.setId))
      .set;
    const saved = await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
        operation: 'save_draft',
        workspaceId: x.f.a.workspaceId,
        setId: x.saved.setId,
        requestId: randomUUID(),
        expectedRevision: x.saved.revision,
        ownership: existing.ownership,
        target: existing.target,
        textEdits: [],
        changeSummary: 'Historical common-only candidate',
        manifest: { ...existing.candidate!.manifest, scenes: [] },
      },
    );
    await edit.finish();
    const run = await historicalMethodRun(
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
      const testing = await historicalMethodRun(
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
    const confirm = await historicalMethodRun(
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
    await expect(x.activate()).rejects.toMatchObject({
      code: 'legacy_method_retired',
    });
    await seedHistoricalMethodPublication(x);
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
      // Shared methods still run on the original assigned employee. A new
      // owner custom Run intentionally does not inherit these layers.
      const next = await historicalMethodRun(
        x.f,
        x.f.assignment.id,
        '普通金额任务',
      );
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
    const run = await historicalMethodRun(
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
    const sceneOnly = await historicalMethodRun(
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
        await expect(x.activate()).rejects.toMatchObject({
          code: 'legacy_method_retired',
        });
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
    await expect(x.activate()).rejects.toMatchObject({
      code: 'legacy_method_retired',
    });
    const receipt = await seedHistoricalMethodPublication(x, true);
    const before = await activationFootprint(x);
    expect(await x.activate()).toMatchObject({
      enabled: true,
      replayed: true,
      receipt,
    });
    expect(await x.activate()).toMatchObject({
      enabled: true,
      replayed: true,
      receipt,
    });
    expect(await activationFootprint(x)).toEqual(before);
    await recordConversationTurn({
      ...x.runtime,
      threadId: x.threadId,
      turnId: `continued-${randomUUID()}`,
    });
    await fixture.db`update allrice_jobs set attempt=attempt+1 where id=${x.run.context.jobId}`;
    const resumed = {
      ...x.run,
      worker: { ...x.run.worker, attempt: x.run.worker.attempt + 1 },
    };
    const continued = await activationFootprint(x);
    expect(await x.activate(resumed)).toMatchObject({
      enabled: true,
      replayed: true,
      receipt,
    });
    await expect(x.activate()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(await activationFootprint(x)).toEqual(continued);
    await x.run.finish();
    expect(
      (
        await getEffectiveEmployeeContent(x.f.a.context, x.instance.id)
      ).scenes.map((s) => s.name),
    ).not.toContain('金额合计');
    await x.departmentInfo!.configure(x.f.b.user.id, target.id, 'personal');
    // Preserve the backend assigned employee's original shared reader.
    const peer = { id: x.f.bAssignment.id };
    const session = await createChatSession(x.f.b.context, {
      workspaceId: x.f.b.workspaceId,
      employeeInstanceId: peer.id,
      title: '目标部门独立任务',
    });
    const adopted = await historicalMethodRun(
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
    const replay = await historicalMethodRun(x.f, x.instance.id);
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

  // MET-210: the receipt lives with the message, so it survives past the
  // polled interactions window and without the workbench.
  it('history keeps each question answer receipt from its command', async () => {
    const f = await setup(true),
      instance = await f.custom('Ordinary question');
    const run = await methodRun(f, instance.id, '请继续这个合成任务。');
    const runtime = { ...run.scope, workerId: run.context.worker.id };
    const threadId = `native-${randomUUID()}`,
      turnId = `turn-${randomUUID()}`,
      questionId = `question-${randomUUID()}`;
    await acquireConversationRuntime({
      ...runtime,
      configChecksum: `sha256:${'a'.repeat(64)}`,
      compactThresholdTokens: 10000,
    });
    await bindConversationThread({ ...runtime, threadId });
    const binding = await recordConversationTurn({
      ...runtime,
      threadId,
      turnId,
    });
    const question = {
      id: 'ordinary-confirmation',
      question: '是否继续合成任务？',
      options: [{ label: '继续' }, { label: '停止' }],
    };
    const x = {
      f,
      run,
      runtime,
      show: () =>
        queue.appendJobEvent({
          workerId: runtime.workerId,
          jobId: run.context.jobId,
          leaseToken: run.worker.leaseToken,
          type: 'harness.native',
          payload: {
            source: 'dsh',
            sourceEventType: 'session/user-question',
            nativePayload: { questionId, questions: [question] },
          },
        }),
      answer: async (selected = ['继续'], _custom?: string, adopt = true) => {
        const inputId = randomUUID();
        await sendChatMessage(f.a.context, f.a.workspaceId, run.sessionId, {
          text: selected.join('，'),
          clientMessageId: inputId,
          deliveryMode: 'steer',
          expectedTurnId: turnId,
          expectedGeneration: binding.generation,
          userQuestionAnswer: {
            questionId,
            answers: [{ id: question.id, selected }],
          },
        });
        const command = await claimConversationSteer({
          ...runtime,
          generation: binding.generation,
          turnId,
        });
        if (!command) throw Error('ordinary_question_command_missing');
        if (adopt)
          await consumeConversationSteer({
            commandId: command.id,
            workerId: runtime.workerId,
            proof: {
              status: 'adopted',
              inputId,
              messageId: questionId,
              turnId,
              sequence: 5,
              checkpoint: 'question_resolved',
            },
          });
        return { command };
      },
    };
    await x.show();
    const { getChatSessionHistory } = await import('../workspace/service.ts');
    const receipts = async () =>
      (
        await getChatSessionHistory(
          x.f.a.context,
          x.f.a.workspaceId,
          x.run.sessionId,
        )
      ).messages
        .filter((m) => m.content.interaction?.type === 'user_question_answer')
        .map((m) => m.answerStatus);
    const rejected = await x.answer(['继续'], undefined, false);
    expect(await receipts()).toEqual(['pending']);
    await rejectConversationSteer({
      commandId: rejected.command.id,
      workerId: x.runtime.workerId,
      errorCode: 'QUESTION_ANSWER_INVALID',
    });
    const unknown = await x.answer(['继续'], undefined, false);
    await rejectConversationSteer({
      commandId: unknown.command.id,
      workerId: x.runtime.workerId,
      errorCode: 'INPUT_OUTCOME_UNKNOWN',
    });
    await x.answer();
    expect(await receipts()).toEqual(['rejected', 'unknown', 'adopted']);
    await x.run.finish();
  });

  it('selected department consumed activation cannot replay after company maintainer is downgraded', async () => {
    const x = await activationFixture('selected');
    await x.show();
    await x.answer();
    const receipt = await seedHistoricalMethodPublication(x, true);
    const authorized = await activationFootprint(x);
    expect(await x.activate()).toMatchObject({
      enabled: true,
      replayed: true,
      receipt,
    });
    expect(await activationFootprint(x)).toEqual(authorized);
    const current = (await getEmployeeContentSet(x.f.a.context, x.saved.setId))
      .set;
    await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
        operation: 'save_draft',
        workspaceId: x.f.a.workspaceId,
        setId: x.saved.setId,
        requestId: randomUUID(),
        expectedRevision: current.revision,
        ownership: current.ownership,
        target: current.target,
        manifest: current.candidate!.manifest,
        textEdits: [],
        changeSummary: 'Later historical publication',
      },
      { active: true },
    );
    const later = await activationFootprint(x);
    expect(await x.activate()).toMatchObject({
      enabled: false,
      replayed: true,
      receipt,
    });
    expect(await activationFootprint(x)).toEqual(later);
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.department.id,
      'department',
    );
    const revoked = await activationFootprint(x);
    await expect(x.activate()).rejects.toThrow('authorization_denied');
    expect(await activationFootprint(x)).toEqual(revoked);
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
      const editing = await historicalMethodRun(
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
      ).rejects.toThrow('legacy_method_retired');
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
      const run = await historicalMethodRun(
        x.f,
        x.instance.id,
        phrases.test + denial,
      );
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
    const editing = await historicalMethodRun(
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
      const editing = await historicalMethodRun(x.f, x.instance.id, text);
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
      const testing = await historicalMethodRun(
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
      if (consumed) {
        const receipt = await seedHistoricalMethodPublication(x, true);
        const authorized = await activationFootprint(x);
        expect(await x.activate()).toMatchObject({
          enabled: true,
          replayed: true,
          receipt,
        });
        expect(await activationFootprint(x)).toEqual(authorized);
      }
      await x.departmentInfo!.configure(
        x.f.a.user.id,
        x.departmentInfo!.department.id,
        'department',
      );
      const revoked = await activationFootprint(x);
      await expect(x.activate()).rejects.toThrow('authorization_denied');
      expect(await activationFootprint(x)).toEqual(revoked);
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
      const run = await historicalMethodRun(x.f, x.instance.id, phrase);
      await expect(
        saveEmployeeMethodFromChat({ ...run, arguments: args }),
      ).rejects.toThrow('legacy_method_retired');
      await run.finish();
    }
    const run = await historicalMethodRun(
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
    ).rejects.toThrow('legacy_method_retired');
    expect(
      await fixture.db`select revision,candidate_revision_id,active_revision_id from allrice_employee_content_sets where id=${x.saved.setId}`,
    ).toEqual(before);
    await run.finish();
  });

  it('company maintainers in separate departments discover one exact set and retired writes cannot overwrite', async () => {
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
    const run = await historicalMethodRun(
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
    await expect(
      saveEmployeeMethodFromChat({ ...run, arguments: args }),
    ).rejects.toMatchObject({ code: 'legacy_method_retired' });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        callId: randomUUID(),
        arguments: args,
      }),
    ).rejects.toThrow('legacy_method_retired');
    await run.finish();
  });

  it('department shared consumed receipt cannot be replayed after maintenance revocation', async () => {
    const x = await activationFixture(true);
    await x.show();
    await x.answer();
    const receipt = await seedHistoricalMethodPublication(x, true);
    const authorized = await activationFootprint(x);
    expect(await x.activate()).toMatchObject({
      enabled: true,
      replayed: true,
      receipt,
    });
    expect(await activationFootprint(x)).toEqual(authorized);
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.department.id,
      'personal',
    );
    const revoked = await activationFootprint(x);
    await expect(x.activate()).rejects.toThrow('authorization_denied');
    expect(await activationFootprint(x)).toEqual(revoked);
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
    const editing = await historicalMethodRun(
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
    const call = { ...editing, arguments: args };
    const effects =
      () => fixture.db`select to_jsonb(s) content_set,er.execution_snapshot,er.method_authoring,to_jsonb(c) context,
      (select count(*)::int from allrice_employee_content_requests where set_id=s.id) requests,
      (select count(*)::int from allrice_employee_content_publications where set_id=s.id) publications,
      (select count(*)::int from allrice_employee_method_activations where instance_id=${x.instance.id}) activations
      from allrice_employee_content_sets s join allrice_employee_runs er on er.run_id=${editing.context.runId}
      join allrice_employee_content_contexts c on c.generation_id=er.content_generation_id where s.id=${x.saved.setId}`;
    const initial = await effects();
    await expect(
      saveEmployeeMethodFromChat({
        ...editing,
        arguments: { ...args, sharedTarget: undefined },
      }),
    ).rejects.toThrow('legacy_method_retired');
    await expect(
      saveEmployeeMethodFromChat({
        ...editing,
        arguments: { ...args, section: 'common', scene: undefined },
      }),
    ).rejects.toThrow('legacy_method_retired');
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
    expect(await effects()).toEqual(initial);
    const manifest = (await getEmployeeContentSet(x.f.a.context, x.saved.setId))
      .set.candidate!.manifest;
    expect(manifest.common).toEqual([]);
    const committed = await historicalMethod(
      x.f,
      x.instance.id,
      {
        sharedTarget: x.args.sharedTarget,
        scenes: manifest.scenes.map((scene) =>
          scene.id === args.scene.id
            ? {
                ...scene,
                procedure: args.procedure,
                references: scene.references.filter(
                  (ref) => ref.sourceKind !== 'procedure',
                ),
              }
            : scene,
        ),
      },
      {
        requestId: employeeChatIdentity(call).requestId,
        inputDigest: runtimePolicyDigest({
          instanceId: x.instance.id,
          runId: editing.context.runId,
          userMessageId: editing.userMessageId,
          arguments: toolSelection.EmployeeMethodSaveSchema.parse(args),
        }),
      },
    );
    const authorized = await effects();
    expect(await saveEmployeeMethodFromChat(call)).toEqual(committed);
    expect(await effects()).toEqual(authorized);
    await x.departmentInfo!.configure(
      x.f.a.user.id,
      x.departmentInfo!.other.id,
      'department',
    );
    const revoked = await effects();
    await expect(saveEmployeeMethodFromChat(call)).rejects.toThrow(
      'authorization_denied',
    );
    await expect(
      inspectEmployeeMethodFromChat({
        ...editing,
        arguments: {
          view: 'history',
          scope: 'department',
          departmentId: x.departmentInfo!.department.id,
        },
      }),
    ).rejects.toThrow('authorization_denied');
    await expect(
      saveEmployeeMethodFromChat({ ...call, callId: randomUUID() }),
    ).rejects.toThrow('legacy_method_retired');
    expect(await effects()).toEqual(revoked);
    const [unchanged] =
      await fixture.db`select revision from allrice_employee_content_sets where id=${x.saved.setId}`;
    expect(unchanged!.revision).toBe(committed.revision);
    await editing.finish();
  });

  it('department shared writes reject personal-only original wording with zero mutations', async () => {
    const x = await retryFixture('cny-total-v1', false, true);
    await passActivationTest(x.f, x.test);
    const run = await historicalMethodRun(
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
    ).rejects.toThrow('legacy_method_retired');
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
  it('department shared maintainers discover one set and reject retired candidate writes', async () => {
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
    const run = await historicalMethodRun(
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
    await expect(
      saveEmployeeMethodFromChat({ ...run, arguments: args }),
    ).rejects.toMatchObject({ code: 'legacy_method_retired' });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        callId: randomUUID(),
        arguments: args,
      }),
    ).rejects.toThrow('legacy_method_retired');
    await run.finish();
  });
  it.each([false, true, 'company', 'selected', 'rice'] as const)(
    'historical save/restore receipts preserve exact input, current authority and immutable source history: %s',
    async (scope) => {
      const f = await setup(true, scope === 'rice');
      const instance =
        scope === 'rice'
          ? { id: f.assignment.id }
          : await f.custom('Historical owner');
      const departmentInfo =
        scope && scope !== 'rice' ? await departmentFixture(f) : undefined;
      if (scope === 'company' || scope === 'selected')
        await departmentInfo!.configure(
          f.a.user.id,
          departmentInfo!.department.id,
          'company',
        );
      const sharedTarget = departmentInfo
        ? (
            await fixture.db.begin((tx) =>
              sharedEmployeeMethodTarget(
                f.a.context,
                instance.id,
                scope === 'company' ? 'company' : 'department',
                tx,
                scope === 'selected' ? departmentInfo.other.id : undefined,
              ),
            )
          ).sharedTarget
        : undefined;
      const scene = {
        id: randomUUID(),
        name: '金额汇总',
        appliesWhen: 'Synthetic historical amount',
      };
      const initial = await historicalMethod(
        f,
        instance.id,
        {
          sharedTarget,
          scenes: [{ ...scene, procedure: 'ORIGINAL_HISTORY_BODY' }],
        },
        { active: true },
      );
      const immutable =
        await fixture.db`select * from allrice_company_asset_revisions where organization_id=${f.a.organizationId} order by id`;
      const phrases =
        scope === 'company'
          ? companyMethodAcceptancePhrases
          : scope === 'selected'
            ? selectedDepartmentMethodAcceptancePhrases(
                departmentInfo!.other.name,
              )
            : scope === true
              ? departmentMethodAcceptancePhrases
              : undefined;
      for (const restore of [false, true]) {
        const source = (
          await getEmployeeContentHistory(f.a.context, initial.setId)
        ).revisions.find((r) => r.id === initial.candidate.id)!;
        const wording = restore
          ? sharedHistoryMethodAcceptancePhrases(
              scope === 'company'
                ? 'company'
                : {
                    departmentName:
                      scope === 'selected'
                        ? departmentInfo!.other.name
                        : (departmentInfo?.department.name ?? ''),
                  },
              source.number,
            ).restore
          : phrases?.save;
        const run = await historicalMethodRun(
          f,
          instance.id,
          restore && !sharedTarget
            ? `请恢复我的整份工作方法到第${source.number}版，只保存候选。`
            : wording,
        );
        const current = (
          await getEmployeeContentSet(f.a.context, initial.setId)
        ).set;
        const args = restore
          ? {
              ...(sharedTarget ? { sharedTarget } : {}),
              expectedRevision: current.revision,
              sourceRevisionId: source.id,
              changeSummary: 'Original historical restore',
            }
          : {
              ...(sharedTarget ? { sharedTarget } : {}),
              expectedRevision: current.revision,
              section: 'scene',
              scene: { id: scene.id },
              procedure: 'COMMITTED_HISTORY_BODY',
              changeSummary: 'Original historical save',
            };
        const call = { ...run, arguments: args };
        const parsed = restore
          ? toolSelection.EmployeeMethodRestoreSchema.parse(args)
          : toolSelection.EmployeeMethodSaveSchema.parse(args);
        const original = await historicalMethod(
          f,
          instance.id,
          {
            sharedTarget,
            scenes: [
              {
                ...scene,
                procedure: restore
                  ? 'ORIGINAL_HISTORY_BODY'
                  : 'COMMITTED_HISTORY_BODY',
              },
            ],
          },
          {
            requestId: employeeChatIdentity(call).requestId,
            inputDigest: runtimePolicyDigest({
              instanceId: instance.id,
              runId: run.context.runId,
              userMessageId: run.userMessageId,
              arguments: parsed,
            }),
            requestOperation: restore ? 'restore_draft' : 'save_draft',
            ...(restore ? { restoredFromRevisionId: source.id } : {}),
          },
        );
        const originalManifest = (
          await getEmployeeContentSet(f.a.context, original.setId)
        ).set.candidate!.manifest;
        const pin = originalManifest.scenes[0]!.references[0]!;
        const unpublished = await resolveEmployeeContentSource({
          context: f.a.context,
          employeeId: f.assignment.employeeId,
          instanceId: instance.id,
          sceneId: scene.id,
          ownership: current.ownership,
          ref: pin,
          sql: fixture.db,
          lock: false,
          allowDraft: false,
        });
        expect(unpublished.dto.available).toBe(false);
        expect(JSON.stringify(unpublished.dto)).not.toContain(
          restore ? 'ORIGINAL_HISTORY_BODY' : 'COMMITTED_HISTORY_BODY',
        );
        await fixture.db`insert into allrice_company_asset_publications(asset_id,revision_id,published_by) values(${pin.contentId},${pin.revisionId},${f.a.user.id})`;
        await fixture.db`update allrice_company_assets set state='published',published_revision_id=${pin.revisionId},revision=revision+1 where id=${pin.contentId}`;
        const later = await seedHistoricalEmployeeContent(
          fixture.db,
          f.a.context,
          {
            operation: 'save_draft',
            workspaceId: f.a.workspaceId,
            setId: original.setId,
            requestId: randomUUID(),
            expectedRevision: original.revision,
            ownership: current.ownership,
            target: current.target,
            manifest: originalManifest,
            textEdits: [],
            changeSummary: 'Later historical publication',
          },
          { active: true },
        );
        const foreign = await createChatSession(f.b.context, {
          workspaceId: f.b.workspaceId,
          employeeInstanceId: f.bAssignment.id,
          title: 'Foreign owner',
        });
        const effects =
          () => fixture.db`select s.revision,s.candidate_revision_id,s.active_revision_id,er.execution_snapshot,er.method_authoring,to_jsonb(c) context,
          (select count(*)::int from allrice_employee_content_requests where set_id=s.id) requests,
          (select count(*)::int from allrice_employee_content_publications where set_id=s.id) publications,
          (select count(*)::int from allrice_employee_method_activations where instance_id=${instance.id}) activations,
          (select count(*)::int from allrice_audit_events where organization_id=s.organization_id) audits
          from allrice_employee_content_sets s join allrice_employee_runs er on er.run_id=${run.context.runId}
          join allrice_employee_content_contexts c on c.generation_id=er.content_generation_id where s.id=${original.setId}`;
        const before = await effects();
        await expect(
          getEmployeeContentHistory(f.b.context, original.setId),
        ).rejects.toThrow();
        if (!sharedTarget)
          await expect(
            getEmployeeContentSet(f.b.context, original.setId),
          ).rejects.toThrow();
        const invoke = restore
          ? restoreEmployeeMethodFromChat
          : saveEmployeeMethodFromChat;
        const expected =
          scope === 'rice' ? { ...original, personalTextOnly: true } : original;
        expect(await invoke(call)).toEqual(expected);
        await expect(
          invoke({
            ...call,
            arguments: { ...args, changeSummary: 'Different payload' },
          }),
        ).rejects.toMatchObject({ code: 'request_conflict' });
        await expect(
          invoke({ ...call, callId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'legacy_method_retired' });
        await expect(
          invoke({ ...call, userMessageId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.context.jobId}`;
        await expect(invoke(call)).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '5 minutes' where id=${run.context.jobId}`;
        await expect(
          invoke({ ...call, sessionId: foreign.id }),
        ).rejects.toThrow();
        const history = await inspectEmployeeMethodFromChat({
          ...run,
          arguments: {
            view: 'history',
            ...(sharedTarget
              ? {
                  scope: sharedTarget.scope,
                  ...(sharedTarget.scope === 'department'
                    ? { departmentId: sharedTarget.departmentId }
                    : {}),
                }
              : {}),
          },
        });
        expect(
          'revisions' in history && history.revisions.map((r) => r.id),
        ).toEqual(
          expect.arrayContaining([
            initial.candidate.id,
            original.candidate.id,
            later.candidate.id,
          ]),
        );
        expect(JSON.stringify(history)).not.toContain('ORIGINAL_HISTORY_BODY');
        expect(JSON.stringify(history)).not.toContain('COMMITTED_HISTORY_BODY');
        await fixture.db`update allrice_company_assets set state='archived' where id=${pin.contentId}`;
        expect(await invoke(call)).toEqual(expected);
        const unavailable = await getEmployeeContentSet(
          f.a.context,
          original.setId,
        );
        expect(
          unavailable.sources.find(
            (s) => s.reference.revisionId === pin.revisionId,
          ),
        ).toMatchObject({ available: false });
        expect(JSON.stringify(unavailable)).not.toContain(
          restore ? 'ORIGINAL_HISTORY_BODY' : 'COMMITTED_HISTORY_BODY',
        );
        expect(await effects()).toEqual(before);
        await run.finish();
      }
      expect(
        await fixture.db`select * from allrice_company_asset_revisions where id in ${fixture.db(immutable.map((r) => r.id))} order by id`,
      ).toEqual(immutable);
    },
    60000,
  );

  it.each(['company', 'selected'] as const)(
    'shared restore requires exact direct scope/version and rechecks receipt authority: %s',
    async (scope) => {
      const x = await activationFixture(scope);
      await seedHistoricalMethodPublication(x);
      await x.run.finish();
      const current = (
        await getEmployeeContentSet(x.f.a.context, x.saved.setId)
      ).set;
      const source = current.candidate!;
      const target =
        scope === 'company'
          ? ('company' as const)
          : { departmentName: x.departmentInfo!.other.name };
      const run = await historicalMethodRun(
        x.f,
        x.instance.id,
        sharedHistoryMethodAcceptancePhrases(target, source.number).restore,
      );
      const args = {
        sharedTarget: x.args.sharedTarget,
        expectedRevision: current.revision,
        sourceRevisionId: source.id,
        changeSummary: 'Restore exact shared history',
      };
      const call = { ...run, arguments: args };
      const restored = await seedHistoricalEmployeeContent(
        fixture.db,
        x.f.a.context,
        {
          operation: 'save_draft',
          workspaceId: x.f.a.workspaceId,
          setId: x.saved.setId,
          requestId: employeeChatIdentity(call).requestId,
          ownership: current.ownership,
          target: current.target,
          expectedRevision: current.revision,
          manifest: source.manifest,
          textEdits: [],
          changeSummary: args.changeSummary,
        },
        {
          requestOperation: 'restore_draft',
          restoredFromRevisionId: source.id,
          inputDigest: runtimePolicyDigest({
            instanceId: x.instance.id,
            runId: run.context.runId,
            userMessageId: run.userMessageId,
            arguments: toolSelection.EmployeeMethodRestoreSchema.parse(args),
          }),
        },
      );
      const before =
        await fixture.db`select * from allrice_employee_content_sets where id=${x.saved.setId}`;
      const effects =
        () => fixture.db`select er.execution_snapshot,er.method_authoring,to_jsonb(c) context,
        (select count(*)::int from allrice_employee_content_requests where set_id=${x.saved.setId}) requests,
        (select count(*)::int from allrice_employee_content_publications where set_id=${x.saved.setId}) publications,
        (select count(*)::int from allrice_employee_method_activations where instance_id=${x.instance.id}) activations
        from allrice_employee_runs er join allrice_employee_content_contexts c on c.generation_id=er.content_generation_id
        where er.run_id=${run.context.runId}`;
      const authorized = await effects();
      expect(await restoreEmployeeMethodFromChat(call)).toEqual(restored);
      await expect(
        restoreEmployeeMethodFromChat({
          ...call,
          arguments: { ...args, changeSummary: 'Different payload' },
        }),
      ).rejects.toThrow('request_conflict');
      expect(await effects()).toEqual(authorized);
      await x.departmentInfo!.configure(
        x.f.a.user.id,
        x.departmentInfo!.department.id,
        'department',
      );
      const revoked = await effects();
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
      expect(await effects()).toEqual(revoked);
      expect(
        await fixture.db`select * from allrice_employee_content_sets where id=${x.saved.setId}`,
      ).toEqual(before);
      expect(
        (
          await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${run.context.runId}`
        )[0]!.execution_snapshot,
      ).toEqual(run.frozen);
      await run.finish();
    },
    60000,
  );

  it('restored shared history requires fresh proof for every scene and rejects an empty restored method', async () => {
    const x = await activationFixture('selected');
    await x.show();
    await x.answer();
    await seedHistoricalMethodPublication(x);
    await x.run.finish();
    const initial = await getEmployeeContentSet(x.f.a.context, x.saved.setId);
    const sharedTarget = x.args.sharedTarget!;
    const target = { departmentName: x.departmentInfo!.other.name };
    const phrases = sharedHistoryMethodAcceptancePhrases(target, 1);
    const edit = await historicalMethodRun(x.f, x.instance.id, phrases.edit);
    const multiple = await historicalMethod(x.f, x.instance.id, {
      sharedTarget,
      scenes: [
        ...initial.set.candidate!.manifest.scenes,
        {
          id: randomUUID(),
          name: '第二个金额场景',
          appliesWhen: 'Second synthetic amount case',
          procedure: '只将整数分相加',
        },
      ],
    });
    await edit.finish();
    const restore = await historicalMethodRun(
      x.f,
      x.instance.id,
      sharedHistoryMethodAcceptancePhrases(target, multiple.revision).restore,
    );
    const multi = (await getEmployeeContentSet(x.f.a.context, x.saved.setId))
      .set;
    const restored = await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
        operation: 'save_draft',
        workspaceId: x.f.a.workspaceId,
        setId: x.saved.setId,
        requestId: randomUUID(),
        expectedRevision: multi.revision,
        ownership: multi.ownership,
        target: multi.target,
        manifest: multi.candidate!.manifest,
        textEdits: [],
        changeSummary: 'Historical restored multi-scene snapshot',
      },
      {
        requestOperation: 'restore_draft',
        restoredFromRevisionId: multiple.candidate.id,
      },
    );
    await restore.finish();
    const testRun = await historicalMethodRun(x.f, x.instance.id, phrases.test);
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
    const confirmation = await historicalMethodRun(
      x.f,
      x.instance.id,
      phrases.confirm,
    );
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
    const empty = await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
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
      },
    );
    const emptyRun = await historicalMethodRun(
      x.f,
      x.instance.id,
      sharedHistoryMethodAcceptancePhrases(target, empty.revision).restore,
    );
    const emptyRestore = await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
        operation: 'save_draft',
        workspaceId: x.f.a.workspaceId,
        setId: x.saved.setId,
        requestId: randomUUID(),
        expectedRevision: empty.revision,
        ownership: multi.ownership,
        target: multi.target,
        manifest: {
          schemaVersion: 1,
          common: [],
          scenes: [],
          declaredConflicts: [],
        },
        textEdits: [],
        changeSummary: 'Historical empty restored snapshot',
      },
      {
        requestOperation: 'restore_draft',
        restoredFromRevisionId: empty.candidate.id,
      },
    );
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
    await expect(x.activate()).rejects.toMatchObject({
      code: 'legacy_method_retired',
    });
    await seedHistoricalMethodPublication(x);
    await x.run.finish();
    // Shared methods still run on the original assigned employee. A new
    // owner custom Run intentionally does not inherit these layers.
    const next = await historicalMethodRun(
      x.f,
      x.f.assignment.id,
      '普通金额任务',
    );
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
    const run = await historicalMethodRun(
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
    const sceneOnly = await historicalMethodRun(
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
    const edit = await historicalMethodRun(
      x.f,
      x.instance.id,
      '请移除本部门的“金额合计”工作场景。',
    );
    const existing = (await getEmployeeContentSet(x.f.a.context, x.saved.setId))
      .set;
    const saved = await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.a.context,
      {
        operation: 'save_draft',
        workspaceId: x.f.a.workspaceId,
        setId: x.saved.setId,
        requestId: randomUUID(),
        expectedRevision: x.saved.revision,
        ownership: existing.ownership,
        target: existing.target,
        textEdits: [],
        changeSummary: 'Historical common-only candidate',
        manifest: { ...existing.candidate!.manifest, scenes: [] },
      },
    );
    await edit.finish();
    const run = await historicalMethodRun(
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
    const confirm = await historicalMethodRun(
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
    await seedHistoricalEmployeeContent(
      fixture.db,
      x.f.b.context,
      {
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
      },
      { active: true },
    );
  }

  it.each(['queued', 'between-tests', 'after-question'] as const)(
    'department common coverage rejects an upstream change %s',
    async (stage) => {
      if (stage === 'after-question') {
        const x = await activationFixture(true, true);
        await x.show();
        await x.answer();
        await changeInheritedCompany(x);
        expect(
          (await getEmployeeMethodTest(x.f.a.context, x.test.id)).applicable,
        ).toBe(false);
        await expect(x.activate()).rejects.toMatchObject({
          code: 'legacy_method_retired',
        });
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
      const run = await historicalMethodRun(
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
    const run = await historicalMethodRun(x.f, x.instance.id, '请启用个人方法');
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
      await expect(
        prepareEmployeeMethodActivationFromChat({
          ...x.run,
          callId: randomUUID(),
          arguments: x.preparation,
        }),
      ).rejects.toMatchObject({ code: 'source_changed' });
      await expect(x.activate()).rejects.toMatchObject({
        code: 'legacy_method_retired',
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

  async function methodFileCloud(f: Awaited<ReturnType<typeof setup>>) {
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    const target = randomUUID(),
      grant = randomUUID();
    const profile = {
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudToolchainImageV1,
      architecture: cloudPlatform.architecture,
      runtime: 'runsc',
      runtimeVersion: 'release-20260831.0',
      runtimeChecksum: cloudPlatform.runtimeChecksum,
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
    const storage = runtimeFixtureStorage(fixture.db);
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
  it.each(['receipt', 'file-operation'] as const)(
    'serializes native receipts with real file operation, %s first',
    async (first) => {
      const f = await fileTestFixture();
      const request = {
        workerId: f.context.worker.id,
        jobId: f.claim.previewExecution.jobId,
        leaseToken: f.claim.previewExecution.leaseToken,
        rootSessionId: 'dsh-' + f.test.id,
        routeDecisionId: f.claim.methodCandidate!.decision.id,
      };
      await bindJobNativeSession({
        workerId: request.workerId,
        jobId: request.jobId,
        leaseToken: request.leaseToken,
        attempt: f.claim.previewExecution.jobAttempt,
        subject: { kind: 'platform_employee_test', id: f.test.id },
        descriptor: nativeBindingDescriptor({
          ...f.claim.previewContext,
          contextKey: f.test.id,
        }),
      });
      const fact = {
        phase: 'start' as const,
        callId: randomUUID(),
        nativeSessionId: request.rootSessionId,
        provider: 'synthetic',
        model: 'never-called',
      };
      await appendNativeModelReceipt({ ...request, fact });
      // The real file admission runs before finishCloudOperation creates a root.
      expect(
        await fixture.db`select root_run_id from allrice_runtime_roots where root_run_id=${f.context.runId}`,
      ).toHaveLength(0);
      const gate = await fixture.db.reserve();
      await gate`begin`;
      const [held] = await gate`select pg_backend_pid() pid`;
      const write = () =>
        appendNativeModelReceipt({
          ...request,
          fact: {
            ...fact,
            phase: 'finish',
            outcome: 'succeeded',
            usageComplete: true,
            usage: {
              inputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 1,
            },
          },
        }).then(
          () => 'committed',
          (error: unknown) => error,
        );
      const create = () =>
        f.create('normalize').then(
          () => 'created',
          (error: unknown) => error,
        );
      let writing: Promise<unknown> | undefined;
      let creating: Promise<unknown> | undefined;
      try {
        if (first === 'receipt') {
          await gate`select id from allrice_route_decisions where id=${request.routeDecisionId} for update`;
          writing = write();
          const writer = await nativeBindingWaiter(
            fixture.db,
            held!.pid as number,
          );
          creating = create();
          await nativeBindingWaiter(fixture.db, writer);
          // Job wait must happen before any Run lock, including with no root.
          await gate`select id from allrice_runs where id=${f.context.runId} for update nowait`;
        } else {
          await gate`select pg_advisory_xact_lock(hashtextextended(${`method-file:${f.test.id}`},0))`;
          creating = create();
          const creator = await nativeBindingWaiter(
            fixture.db,
            held!.pid as number,
          );
          writing = write();
          const writer = await nativeBindingWaiter(fixture.db, creator);
          const [blocked] =
            await fixture.db`select query from pg_stat_activity where pid=${writer}`;
          expect(blocked!.query).toContain('allrice_jobs');
        }
      } finally {
        await gate`rollback`;
        gate.release();
        await Promise.all([writing, creating]);
      }
      expect(await writing).toBe('committed');
      expect(await creating).toBe('created');
      expect(
        await fixture.db`select stage from allrice_employee_method_file_steps where test_id=${f.test.id}`,
      ).toEqual([{ stage: 'normalize' }]);
      expect(
        await fixture.db`select payload->'fact'->>'phase' phase from allrice_run_events
          where run_id=${f.context.runId} and payload->>'source'='native_model_receipt_v1' order by sequence`,
      ).toEqual([{ phase: 'start' }, { phase: 'finish' }]);
    },
    30000,
  );
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
    const retry = await historicalMethodRun(
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
    const readInput = async (
      file: Awaited<ReturnType<typeof loadCloudCommandInputs>>[number],
    ) =>
      'contentBase64' in file
        ? Buffer.from(file.contentBase64, 'base64')
        : Buffer.from(
            await new Response(
              await file.open(new AbortController().signal),
            ).arrayBuffer(),
          );
    const source = await loadCloudCommandInputs(
      f.context,
      first.payload,
      f.storage,
      fixture.db,
    );
    const sourceBytes = await Promise.all(source.map(readInput));
    expect(
      source.map((file, index) => [file.path, sourceBytes[index]!.toString()]),
    ).toEqual([['amounts.csv', 'entryId,amountCents\none,10000\ntwo,20000\n']]);
    expect(first.payload.arguments.inputs).toHaveLength(1);
    expect(first.payload.arguments.inputs[0]!.path).toBe(source[0]!.path);
    expect(first.payload.arguments.inputs[0]!.checksum).toBe(
      `sha256:${createHash('sha256').update(sourceBytes[0]!).digest('hex')}`,
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
      (
        await readInput(
          (
            await loadCloudCommandInputs(
              f.context,
              second.payload,
              f.storage,
              fixture.db,
            )
          )[0]!,
        )
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
    const retry = await historicalMethodRun(
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
    const ordinary = await historicalMethodRun(
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
    const retrying = await historicalMethodRun(
      f,
      instance.id,
      `请重试测试 ${test.id}。`,
    );
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
    const subscription = resolveSubscriptionSnapshot({
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
    const repeatParent = await historicalMethodRun(
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
    const next = await historicalMethodRun(
      f,
      instance.id,
      `请重试测试 ${child.id}。`,
    );
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
    const retrying = await historicalMethodRun(
      f,
      instance.id,
      `请重试测试 ${test.id}。`,
    );
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
      const retrying = await historicalMethodRun(
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
    const { f, instance, args, test, fail } = await retryFixture();
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      test.id,
    );
    await fail(test.id);
    const settings = await readPlatformModelSettings();
    await updatePlatformModelSettings(f.admin.context, {
      expectedRevision: settings.revision,
      configuration: { ...settings.configuration, reasoningEffort: 'low' },
    });
    const retrying = await historicalMethodRun(
      f,
      instance.id,
      `请重试测试 ${test.id}。`,
    );
    await expect(
      startEmployeeMethodTestFromChat({
        ...retrying,
        arguments: { ...args, retryOfTestId: test.id },
      }),
    ).rejects.toMatchObject({ code: 'test_retry_model_changed' });
    await retrying.finish();
    const edit = await historicalMethodRun(f, instance.id);
    await historicalMethod(f, instance.id, {
      scenes: [
        {
          id: args.sceneId,
          name: '金额汇总',
          appliesWhen: '固定合成数据',
          procedure: '先核对输入，再将整数分相加',
        },
      ],
    });
    await edit.finish();
    const stale = await historicalMethodRun(
      f,
      instance.id,
      `请重试测试 ${test.id}。`,
    );
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
    const editing = await historicalMethodRun(f, instance.id);
    const saved = await historicalMethod(f, instance.id, {
      scenes: [
        {
          name: '金额汇总',
          appliesWhen: '合成金额测试',
          procedure:
            '将输入整数分相加后额外加 100 分。只输出 totalCents JSON。',
        },
      ],
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
    const testing = await historicalMethodRun(
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
    const subscription = resolveSubscriptionSnapshot({
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
    const correcting = await historicalMethodRun(
      f,
      instance.id,
      '请调整我的工作场景候选：金额汇总不再额外加 100 分。',
    );
    const corrected = await historicalMethod(f, instance.id, {
      scenes: [
        {
          id: args.sceneId,
          name: '金额汇总',
          appliesWhen: '合成金额测试',
          procedure:
            '将输入的金额整数分相加，不加其他金额；只输出 totalCents JSON。',
        },
      ],
    });
    expect(
      (await getEmployeeMethodTest(f.a.context, first.id)).applicable,
    ).toBe(false);
    await correcting.finish();
    const repeat = await historicalMethodRun(
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
    const secondSubscription = resolveSubscriptionSnapshot({
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
      const editing = await historicalMethodRun(f, instance.id);
      const saved = await historicalMethod(f, instance.id, {
        scenes: [
          {
            name: '金额汇总',
            appliesWhen: '合成数据',
            procedure: '整数分相加',
          },
        ],
      });
      await editing.finish();
      const scene = (await getEmployeeContentSet(f.a.context, saved.setId)).set
        .candidate!.manifest.scenes[0]!;
      const run = await historicalMethodRun(
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
    const run = await historicalMethodRun(
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
    const saved = await historicalMethod(f, instance.id, {
      scenes: [
        {
          name: '每周对账',
          appliesWhen: '每周',
          procedure: '核对回款',
          references: [pin],
        },
      ],
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

  it.each(['read', 'conflict', 'intent'] as const)(
    'keeps inspect and rejected %s writes read-only without revoking the Run or visible history',
    async (action) => {
      const f = await setup(true),
        instance = await f.custom('小白');
      const run = await historicalMethodRun(
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
          code: 'legacy_method_retired',
        });
      const [old] =
        await fixture.db`select retired_at,invalidated_at from allrice_employee_content_contexts where generation_id=${run.runtime.generationId}`;
      expect(old!.retired_at).toBeNull();
      expect(old!.invalidated_at).toBeNull();
      expect(
        (await prepareEmployeeContentContext(run.scope))!.generationId,
      ).toBe(run.runtime.generationId);
      expect(
        (
          await fixture.db`select method_authoring,execution_snapshot from allrice_employee_runs where run_id=${run.context.runId}`
        )[0],
      ).toMatchObject({
        method_authoring: false,
        execution_snapshot: run.frozen,
      });
      await run.finish();
      const next = await historicalMethodRun(
        f,
        instance.id,
        '计算 17 乘以 23。',
        run.sessionId,
      );
      expect(next.runtime.generationId).toBe(run.runtime.generationId);
      expect(next.runtime.nativeContextKey).toBe(run.runtime.nativeContextKey);
      // With no retired generation there is no extra conversation filter.
      expect(next.runtime.allowedMessageIds).toBeNull();
      expect(next.runtime.historyFromMessageId).toBeNull();
      expect(next.runtime.historyFromMessageId).toBe(
        run.runtime.historyFromMessageId,
      );
      await expect(
        assertEmployeeContentContext(run.scope, run.runtime.generationId),
      ).resolves.toBeUndefined();
      await expect(
        assertEmployeeContentReferenceMessages(f.a.context, run.sessionId, [
          run.userMessageId,
          next.userMessageId,
        ]),
      ).resolves.toBeUndefined();
      await expect(
        assertEmployeeContentReferenceMessages(f.b.context, run.sessionId, [
          run.userMessageId,
          next.userMessageId,
        ]),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const [message] =
        await fixture.db`select content->>'text' text from allrice_messages where id=${run.userMessageId}`;
      expect(message!.text).toContain('DRAFT_BOUNDARY');
    },
    60000,
  );

  it("keeps the owner's ordinary watchlist across scene inspection while excluding candidate turns and prior answers", async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const first = await historicalMethodRun(
      f,
      instance.id,
      '观察名单：NVDA、COIN、CRCL、MSTR、HOOD、000660.KS、SNDK、MU。你要记住。',
    );
    const memory = await createTraceableMemory(f.a.context, {
      workspaceId: f.a.workspaceId,
      employeeId: first.frozen.employee.id,
      content:
        '用户的股票观察名单共8个标的：NVDA、COIN、CRCL、MSTR、HOOD、000660.KS、SNDK、MU。',
      visibility: 'private',
      sourceType: 'message',
      sourceId: first.userMessageId,
      sourceLabel: '用户明确要求记住',
      lifecycleState: 'durable',
      memoryClass: 'user_preference',
      confidence: 1,
      expiresAt: null,
    });
    await first.finish();
    const inspect = await historicalMethodRun(
      f,
      instance.id,
      '查看当前工作场景。',
      first.sessionId,
    );
    // Already persisted pre-retirement authoring metadata; inspect must not create it.
    await fixture.db`update allrice_employee_runs set method_authoring=true where run_id=${inspect.context.runId}`;
    await fixture.db`update allrice_employee_content_contexts set retired_at=clock_timestamp() where generation_id=${inspect.runtime.generationId}`;
    const before =
      await fixture.db`select * from allrice_employee_content_contexts where generation_id=${inspect.runtime.generationId}`;
    await inspectEmployeeMethodFromChat({
      ...inspect,
      arguments: { view: 'candidate' },
    });
    expect(
      await fixture.db`select * from allrice_employee_content_contexts where generation_id=${inspect.runtime.generationId}`,
    ).toEqual(before);
    await inspect.finish();
    const next = await historicalMethodRun(
      f,
      instance.id,
      '将上述名单保存到我的「美股监控助手」工作场景。',
      first.sessionId,
    );
    expect(next.runtime.generationId).not.toBe(first.runtime.generationId);
    expect(next.runtime.allowedMessageIds).toContain(first.userMessageId);
    expect(next.runtime.allowedMessageIds).toContain(next.userMessageId);
    expect(next.runtime.allowedMessageIds).not.toContain(inspect.userMessageId);
    const answers =
      await fixture.db`select assistant_message_id from allrice_employee_runs where run_id in (${first.scope.runId},${inspect.scope.runId})`;
    for (const answer of answers)
      expect(next.runtime.allowedMessageIds).not.toContain(
        answer.assistant_message_id,
      );
    expect(
      await searchToolBrokerMemories(
        next.context,
        '美股监控助手 8个标的 NVDA',
        5,
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memory.id })]),
    );
    await next.finish();
  }, 60000);

  it('does not recall memory saved before candidate entry and blocks later memory or implicit reference binding', async () => {
    const f = await setup(true),
      instance = await f.custom('小白');
    const run = await historicalMethodRun(
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
        instanceId: instance.id,
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
    // Already persisted pre-retirement authoring metadata; inspect must not create it.
    await fixture.db`update allrice_employee_runs set method_authoring=true where run_id=${run.context.runId}`;
    await fixture.db`update allrice_employee_content_contexts set retired_at=clock_timestamp() where generation_id=${run.runtime.generationId}`;
    const before =
      await fixture.db`select * from allrice_employee_content_contexts where generation_id=${run.runtime.generationId}`;
    await inspectEmployeeMethodFromChat({
      ...run,
      arguments: { view: 'candidate' },
    });
    expect(
      await fixture.db`select * from allrice_employee_content_contexts where generation_id=${run.runtime.generationId}`,
    ).toEqual(before);
    expect(
      await searchWorkspaceMemories(f.a.context, {
        workspaceId: f.a.workspaceId,
        instanceId: instance.id,
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
    ).rejects.toMatchObject({ code: 'legacy_method_retired' });
    await expect(
      saveEmployeeMethodFromChat({
        ...run,
        arguments: {
          expectedRevision: 0,
          section: 'common',
          requirements: '检查输入',
          changeSummary: '仅保存文本',
        },
      }),
    ).rejects.toMatchObject({ code: 'legacy_method_retired' });
  }, 60000);

  it.each([false, true, 'company', 'selected', 'rice'] as const)(
    'frozen legacy text calls reject every new save/restore without changing content or context: %s',
    async (scope) => {
      const f = await setup(true, scope === 'rice'),
        instance =
          scope === 'rice'
            ? { id: f.assignment.id }
            : await f.custom('Retired writer');
      const department =
        scope && scope !== 'rice' ? await departmentFixture(f) : undefined;
      if (scope === 'company' || scope === 'selected')
        await department!.configure(
          f.a.user.id,
          department!.department.id,
          'company',
        );
      const shared = department
        ? (
            await fixture.db.begin((tx) =>
              sharedEmployeeMethodTarget(
                f.a.context,
                instance.id,
                scope === 'company' ? 'company' : 'department',
                tx,
                scope === 'selected' ? department.other.id : undefined,
              ),
            )
          ).sharedTarget
        : undefined;
      const original = await historicalMethod(
        f,
        instance.id,
        {
          sharedTarget: shared,
          scenes: [
            {
              name: 'Existing legacy scene',
              appliesWhen: 'Historical task',
              procedure: 'Retained immutable text',
            },
          ],
        },
        { active: true },
      );
      const run = await historicalMethodRun(
        f,
        instance.id,
        '请保存并恢复这份工作方法。',
      );
      if (!shared) {
        expect(run.frozen.content).toMatchObject({
          personalScenes: true,
          layers: [],
        });
        expect(
          (await listPersonalSceneSkills(f.a.context, instance.id)).skills,
        ).toEqual([]);
        expect(
          (await getEffectiveEmployeeContent(f.a.context, instance.id)).scenes,
        ).toMatchObject([{ name: 'Existing legacy scene' }]);
      }
      const effects =
        () => fixture.db`select er.execution_snapshot,er.method_authoring,c.retired_at,c.invalidated_at,c.updated_at,
        (select jsonb_agg(s order by s.id) from allrice_employee_content_sets s where s.organization_id=er.organization_id) sets,
        (select count(*)::int from allrice_employee_content_revisions r join allrice_employee_content_sets s on s.id=r.set_id where s.organization_id=er.organization_id) revisions,
        (select count(*)::int from allrice_employee_content_requests where organization_id=er.organization_id) requests,
        (select count(*)::int from allrice_employee_method_activations where instance_id=${instance.id}) activations,
        (select count(*)::int from allrice_employee_content_publications p join allrice_employee_content_sets s on s.id=p.set_id where s.organization_id=er.organization_id) publications,
        (select count(*)::int from allrice_company_asset_revisions where organization_id=er.organization_id) source_revisions,
        (select count(*)::int from allrice_audit_events where organization_id=er.organization_id) audits
        from allrice_employee_runs er join allrice_employee_content_contexts c on c.generation_id=er.content_generation_id where er.run_id=${run.context.runId}`;
      const before = await effects();
      for (const view of ['effective', 'candidate', 'history'] as const) {
        const inspected = await inspectEmployeeMethodFromChat({
          ...run,
          arguments: {
            view,
            ...(shared
              ? {
                  scope: shared.scope,
                  ...(shared.scope === 'department'
                    ? { departmentId: shared.departmentId }
                    : {}),
                }
              : {}),
          },
        });
        if (scope === 'rice') {
          expect(inspected).not.toHaveProperty('sharedTarget');
          expect(inspected).not.toHaveProperty('departments');
        }
      }
      if (scope === 'rice')
        for (const sharedScope of ['company', 'department'] as const)
          await expect(
            inspectEmployeeMethodFromChat({
              ...run,
              arguments: { view: 'candidate', scope: sharedScope },
            }),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await effects()).toEqual(before);
      for (const expectedRevision of [original.revision, 99]) {
        const args = {
          ...(shared ? { sharedTarget: shared } : {}),
          expectedRevision,
          section: 'common',
          requirements: 'Must not overwrite history',
          changeSummary: 'Retired write',
        };
        for (const invoke of [
          saveEmployeeMethodFromChat,
          saveEmployeeMethodAndPublishFromChat,
        ])
          await expect(
            invoke({ ...run, callId: randomUUID(), arguments: args }),
          ).rejects.toMatchObject({ code: 'legacy_method_retired' });
        for (const invoke of [
          restoreEmployeeMethodFromChat,
          restoreEmployeeMethodAndPublishFromChat,
        ])
          await expect(
            invoke({
              ...run,
              callId: randomUUID(),
              arguments: {
                ...(shared ? { sharedTarget: shared } : {}),
                expectedRevision,
                sourceRevisionId: original.candidate.id,
                changeSummary: 'Retired restore',
              },
            }),
          ).rejects.toMatchObject({ code: 'legacy_method_retired' });
      }
      expect(await effects()).toEqual(before);
      expect(before[0]).toMatchObject({
        method_authoring: false,
        retired_at: null,
        invalidated_at: null,
        execution_snapshot: run.frozen,
      });
      await run.finish();
    },
  );

  it('rejects an unconsumed legacy activation after an adopted answer without consuming or publishing', async () => {
    const x = await activationFixture(false, false, false, false, true);
    await x.show();
    await x.answer();
    const before = await activationFootprint(x);
    await expect(x.activate()).rejects.toMatchObject({
      code: 'legacy_method_retired',
    });
    expect(await activationFootprint(x)).toEqual(before);
    expect(before[0]).toMatchObject({
      activation: { consumed_at: null, response: null },
      active_revision_id: null,
    });
    await x.run.finish();
  });

  it('rejects foreign actor, general instance, stale lease and revoked assignment for method tools', async () => {
    const f = await setup(true),
      instance = await f.custom('小白'),
      run = await historicalMethodRun(f, instance.id);
    const read = (extra = {}) =>
      inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'candidate' },
        ...extra,
      });
    expect(await read()).toMatchObject({ revision: 0 });
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
      '往后就叫你小禾，回复也短一点，记下来。',
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
  it('rejects mismatched user messages, stale leases and foreign sessions before creating a profile revision', async () => {
    const f = await setup(true),
      i = await f.custom('小白');
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
  it.each(['general', 'custom'] as const)(
    'rejects internal role=user sources before saving a %s profile, including a producer without its Run link',
    async (kind) => {
      const f = await setup(true),
        id = kind === 'general' ? f.assignment.id : (await f.custom('小白')).id;
      for (const link of ['run', 'message'] as const) {
        const input = await profileRun(f, id, '以后回答保持简洁。');
        const [message] = await fixture.db`select role,client_message_id
          from allrice_messages where id=${input.userMessageId}`;
        expect(message!.role).toBe('user');
        const automationId = randomUUID();
        await fixture.db`insert into allrice_automations
          (id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,
           conversation_mode,employee_assignment_id,session_id,clock_owner)
          values(${automationId},${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},'Internal profile source',
            'Isolated provenance fixture','schedule',${fixture.db.json({ frequency: 'daily', time: '08:30', timezone: 'Asia/Shanghai' })},
            'paused','reuse',${f.assignment.id},${input.sessionId},'legacy')`;
        const occurrenceId =
          link === 'message' ? message!.client_message_id : randomUUID();
        await fixture.db`insert into allrice_automation_runs
          (id,organization_id,workspace_id,automation_id,run_id,status,scheduled_for)
          values(${occurrenceId},${f.a.organizationId},${f.a.workspaceId},${automationId},
            ${link === 'run' ? input.context.runId : null},'queued',clock_timestamp())`;
        await expect(
          updateEmployeeProfileFromChat({
            ...input,
            arguments: { expectedRevision: 1, expressionStyle: 'concise' },
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect((await getEmployeeInstance(f.a.context, id)).revision).toBe(1);
        expect(
          (await getEmployeeInstanceHistory(f.a.context, id)).revisions,
        ).toHaveLength(1);
      }
    },
  );

  it('saves only a general owner expression preference, replays exactly and freezes it in a new Session', async () => {
    const f = await setup(true),
      id = f.assignment.id;
    const input = await profileRun(f, id, '请记住我喜欢简短回答。');
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

  it.each(['general', 'custom'] as const)(
    'rechecks current membership and archive before a %s profile write',
    async (kind) => {
      const f = await setup(true),
        id = kind === 'general' ? f.assignment.id : (await f.custom('小白')).id,
        input = await profileRun(f, id, '请记住我喜欢简短回答。');
      const call = () =>
        updateEmployeeProfileFromChat({
          ...input,
          arguments: { expectedRevision: 1, expressionStyle: 'concise' },
        });
      await fixture.db`update allrice_memberships set active=false
        where organization_id=${f.a.organizationId} and user_id=${f.a.user.id}`;
      await expect(call()).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      const [unchanged] =
        await fixture.db`select revision,profile from allrice_employee_instances where id=${id}`;
      expect(unchanged!.revision).toBe(1);
      expect(unchanged!.profile).not.toHaveProperty('expressionStyle');
      await fixture.db`update allrice_memberships set active=true
        where organization_id=${f.a.organizationId} and user_id=${f.a.user.id}`;
      await changeEmployeeInstanceLifecycle(f.a.context, id, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        operation: 'archive',
      });
      await expect(call()).rejects.toBeDefined();
      const [archived] =
        await fixture.db`select revision,profile,archived_at from allrice_employee_instances where id=${id}`;
      expect(archived!.revision).toBe(2);
      expect(archived!.archived_at).not.toBeNull();
      expect(archived!.profile).toEqual(unchanged!.profile);
    },
  );

  it('does not let an organization administrator write another owner profile through chat or the profile API', async () => {
    const f = await setup(true),
      instance = await f.custom('个人助手');
    await fixture.db`update allrice_memberships set role='admin'
      where organization_id=${f.b.organizationId} and user_id=${f.b.user.id}`;
    const context = (await authenticateSession(f.b.login.token, {
      organizationId: f.b.organizationId,
      workspaceId: f.b.workspaceId,
    }))!;
    const input = await profileRun(
      {
        ...f,
        a: { ...f.b, context },
        session: (id) =>
          createChatSession(context, {
            workspaceId: f.b.workspaceId,
            employeeInstanceId: id,
            title: 'Administrator own task',
          }),
      },
      f.bAssignment.id,
      '请记住我喜欢简短回答。',
    );
    const foreign = await f.session(instance.id);
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        sessionId: foreign.id,
        arguments: { expectedRevision: 1, expressionStyle: 'concise' },
      }),
    ).rejects.toBeDefined();
    await expect(
      updateEmployeeInstance(context, instance.id, {
        workspaceId: f.b.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        profile: { name: '越权改名' },
      }),
    ).rejects.toBeDefined();
    expect((await getEmployeeInstance(f.a.context, instance.id)).revision).toBe(
      1,
    );
  });

  it('rejects general name, persona and mixed fields without creating profile revisions', async () => {
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
    await expect(
      updateEmployeeProfileFromChat({
        ...input,
        arguments: {
          expectedRevision: 1,
          mission: 'Change duty',
          expressionStyle: 'concise',
        },
      }),
    ).rejects.toThrow();
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
        instanceId,
        idempotencyKey: randomUUID(),
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
      // Ordinary chat freezes confirmed documents instead of performing the
      // retired recall write. Restoring the instance admits the exact memory,
      // while retrying the same input must not create new recall side effects.
      expect(await memoryState()).toEqual(memoryBefore);
      const [restoredRun] =
        await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      expect(restoredRun!.prompt_snapshot.memories).toEqual([
        expect.objectContaining({
          id: memory.id,
          revision: memory.revision,
          content: input.text,
        }),
      ]);
      expect(restoredRun!.prompt_snapshot.employeeDocuments.memory).toContain(
        input.text,
      );
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
  it('E3 lets only the real platform Rice owner change name/style through HTTP and chat with CAS, receipts and immutable Run profiles', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    e3HttpAuth.context = f.a.context;
    // Load the real Web boundary at runtime, as the existing file API fixtures
    // do; its Bundler module graph is checked by the Web project.
    const routePath =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/route.ts';
    const { PATCH: patchInstance } = await import(routePath);
    const patch = (
      profile: Record<string, string>,
      expectedRevision: number,
      requestId = randomUUID(),
    ) =>
      patchInstance(
        new Request(`https://allrice.test/api/v1/employee-instances/${id}`, {
          method: 'PATCH',
          headers: {
            origin: 'https://allrice.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: f.a.workspaceId,
            requestId,
            expectedRevision,
            profile,
          }),
        }),
        { params: Promise.resolve({ id }) },
      );
    const first = await profileRun(f, id, '请把名字改为小米，回答简短一点。');
    const call = {
      ...first,
      arguments: {
        expectedRevision: 1,
        name: '小米',
        expressionStyle: 'concise',
      },
    };
    const saved = await updateEmployeeProfileFromChat(call);
    expect(saved.profile).toEqual({ name: '小米', expressionStyle: 'concise' });
    expect(await updateEmployeeProfileFromChat(call)).toEqual(saved);
    expect((await getEmployeeDetails(f.a.context, id)).profile).toMatchObject({
      name: '小米',
      expressionStyle: 'concise',
    });
    const requestId = randomUUID();
    const response = await patch({ name: '小饭' }, 2, requestId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instance.profile).toEqual({
      name: '小饭',
      expressionStyle: 'concise',
    });
    expect(await (await patch({ name: '小饭' }, 2, requestId)).json()).toEqual(
      body,
    );
    expect((await patch({ name: 'stale' }, 2)).status).toBe(409);
    expect(
      (await patch({ capabilities: 'grant extra capabilities' }, 3)).status,
    ).toBe(400);
    const next = await profileRun(f, id, '看看资料。');
    expect(next.frozen.instance.profile).toEqual({
      name: '小饭',
      expressionStyle: 'concise',
    });
    const [old] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${first.context.runId}`;
    expect(old!.execution_snapshot).toEqual(first.frozen);
    const listed = await listChatSessions(f.a.context, f.a.workspaceId, {
      includeEmployeeGroups: true,
    });
    expect(
      listed.sessions
        .filter((s) => s.employeeInstanceId === id)
        .map((s) => s.employeeName),
    ).toEqual(['小饭', '小饭']);
    expect(
      listed.employeeGroups!.find((g) => g.employeeInstanceId === id)
        ?.employeeName,
    ).toBe('小饭');
    const restored = await changeEmployeeInstanceLifecycle(f.a.context, id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 3,
      operation: 'restore',
      sourceRevision: 2,
    });
    expect(restored.profile).toEqual(saved.profile);
    e3HttpAuth.context = f.b.context;
    expect((await patch({ name: 'foreign' }, 4)).status).not.toBe(200);
    expect((await getEmployeeInstance(f.a.context, id)).profile).toEqual(
      saved.profile,
    );
    expect(
      (await getEmployeeInstance(f.b.context, f.bAssignment.id)).profile,
    ).toEqual({});
  });

  it('U1 Rice full persona reaches owner details, workspace and the next kernel without changing frozen history or grants', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    const before = await profileRun(f, id, 'Synthetic baseline');
    const oldRows =
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${before.context.runId}`;
    const profile = {
      name: '本人 Rice',
      description: 'Personal description',
      appearance: {
        avatarType: 'initials',
        avatarValue: '禾',
        accentColor: 'coral',
      },
      role: 'Personal role',
      mission: 'Personal mission',
      workStyle: 'Personal working style',
      expressionStyle: 'structured',
    };
    e3HttpAuth.context = f.a.context;
    const routePath =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/route.ts';
    const { PATCH } = await import(routePath);
    const response = await PATCH(
      new Request(`https://allrice.test/api/v1/employee-instances/${id}`, {
        method: 'PATCH',
        headers: {
          origin: 'https://allrice.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: f.a.workspaceId,
          expectedRevision: 1,
          requestId: randomUUID(),
          profile,
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).instance.profile).toEqual(profile);
    const details = (await getEmployeeDetails(f.a.context, id)).profile;
    expect(details).toMatchObject({
      name: profile.name,
      description: profile.description,
      appearance: profile.appearance,
      expressionStyle: profile.expressionStyle,
      isDefaultRice: true,
      identity: {
        role: profile.role,
        mission: profile.mission,
        workStyle: profile.workStyle,
      },
    });
    // Identity fields are nested in the read projection, not duplicated at top-level.
    expect(details.personalFields.sort()).toEqual(Object.keys(profile).sort());
    expect(details.editableFields?.sort()).toEqual(Object.keys(profile).sort());
    expect(details.defaults?.name).toBe('Platform assistant');
    expect(details.defaults?.role).not.toBe(profile.role);
    const hub = await getEmployeeWorkspace(f.a.context, f.a.workspaceId);
    expect(
      hub.employees.flatMap((e) => e.instances ?? []).find((i) => i.id === id)
        ?.profile,
    ).toEqual(profile);
    const next = await profileRun(f, id, 'Synthetic next task');
    const resolved = await resolveEmployeeExecution({
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      ownerId: f.a.user.id,
      runId: next.context.runId,
    });
    expect(resolved.promptSnapshot.personalIdentity).toEqual({
      role: profile.role,
      mission: profile.mission,
      workStyle: profile.workStyle,
    });
    const kernel = assembleEmployeeKernel({
      employeeAssignmentId: id,
      employeeVersionId: next.frozen.employee.versionId,
      sessionId: next.sessionId,
      userMessageId: next.userMessageId,
      assistantMessageId: randomUUID(),
      resolved,
    });
    expect(resolved.promptSnapshot.employeeDocuments).toBeDefined();
    expect(kernel.employeeDocuments).toEqual(
      resolved.promptSnapshot.employeeDocuments,
    );
    for (const instructions of [
      kernel.systemInstructions,
      kernel.rootSystemInstructions,
    ]) {
      expect(instructions).toContain(
        JSON.stringify(resolved.promptSnapshot.personalIdentity),
      );
      expect(instructions).toContain('do not change platform safety');
      expect(instructions).toContain(profile.name);
    }
    expect(next.frozen.capabilitySnapshot).toEqual(
      before.frozen.capabilitySnapshot,
    );
    expect(next.frozen.employee).toEqual(before.frozen.employee);
    expect(
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${before.context.runId}`,
    ).toEqual(oldRows);
    // Current owner permission remains required for the full identity write.
    await expect(
      updateEmployeeInstance(f.b.context, id, {
        workspaceId: f.b.workspaceId,
        expectedRevision: 2,
        requestId: randomUUID(),
        profile,
      }),
    ).rejects.toBeDefined();
    const restored = await changeEmployeeInstanceLifecycle(f.a.context, id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 2,
      requestId: randomUUID(),
      operation: 'restore',
      sourceRevision: 1,
    });
    expect(restored.profile).toEqual({});
  });

  it('U1 Rice explicit reset preserves memory, Skills, scenes and receipts while following current platform defaults', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    const profile = {
      name: 'Owner override',
      mission: 'Owner mission',
      expressionStyle: 'concise',
    };
    await updateEmployeeInstance(f.a.context, id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile,
    });
    const scene = await savePersonalSceneSkill(f.a.context, id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 0,
      expectedContentRef: null,
      scene: {
        id: randomUUID(),
        name: 'Retained scene',
        appliesWhen: 'Synthetic test',
      },
      procedure: {
        kind: 'procedure',
        title: 'Retained procedure',
        ...sceneSkillFixture(),
      },
      references: [],
      changeSummary: 'Synthetic setup',
    });
    const memory = await createTraceableMemory(f.a.context, {
      workspaceId: f.a.workspaceId,
      instanceId: id,
      idempotencyKey: randomUUID(),
      content: 'Retained personal memory',
      sourceType: 'user',
    });
    // Synthetic pre-existing ordinary Skill binding, independent of profile reset.
    const installationId = randomUUID(),
      versionId = randomUUID();
    await fixture.db.begin(async (tx) => {
      await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id) values(${installationId},${f.a.organizationId},${f.a.user.id},'retained-skill','installed',${versionId})`;
      await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum) values(${versionId},${f.a.organizationId},${f.a.user.id},${installationId},1,'{}','Synthetic retained source','{}',${'sha256:' + 'a'.repeat(64)})`;
      await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled) values(${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},${id},${installationId},false)`;
    });
    const retained = async () => ({
      memory:
        await fixture.db`select * from allrice_memories where id=${memory.id}`,
      installations:
        await fixture.db`select * from allrice_personal_skill_installations where id=${installationId}`,
      versions:
        await fixture.db`select * from allrice_personal_skill_versions where id=${versionId}`,
      bindings:
        await fixture.db`select * from allrice_personal_skill_bindings where instance_id=${id}`,
      scene: await listPersonalSceneSkills(f.a.context, id),
      resource: await getPersonalSceneSkillResource(
        f.a.context,
        id,
        scene.contentRef,
        'assets/template.csv',
      ),
      originalProfile:
        await fixture.db`select * from allrice_employee_instance_revisions where instance_id=${id} and revision<=2 order by revision`,
    });
    const prior = await retained();
    const draft = await savePlatformEmployeeDraft(f.source.employeeId, {
      definition: {
        ...f.source.definition,
        name: 'New platform default',
        description: 'New platform description',
      },
    });
    await f.source.preview(f.source.employeeId);
    expect(
      (
        await publishPlatformEmployee(f.source.employeeId, {
          scope: 'assigned',
          expectedRevisionId: draft!.currentDraft!.id,
        })
      ).valid,
    ).toBe(true);
    const defaults = (await getEmployeeDetails(f.a.context, id)).profile
      .defaults!;
    expect(defaults.name).toBe('New platform default');
    expect((await getEmployeeDetails(f.a.context, id)).profile.name).toBe(
      profile.name,
    );
    // Empty PATCH retains the existing rejection; it cannot silently clear state.
    await expect(
      updateEmployeeInstance(f.a.context, id, {
        workspaceId: f.a.workspaceId,
        expectedRevision: 2,
        requestId: randomUUID(),
        profile: {},
      }),
    ).rejects.toBeDefined();
    e3HttpAuth.context = f.a.context;
    const routePath =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/route.ts';
    const { PATCH } = await import(routePath);
    const args = {
      workspaceId: f.a.workspaceId,
      expectedRevision: 2,
      requestId: randomUUID(),
      operation: 'reset_profile',
    };
    const reset = (body: unknown = args) =>
      PATCH(
        new Request(`https://allrice.test/api/v1/employee-instances/${id}`, {
          method: 'PATCH',
          headers: {
            origin: 'https://allrice.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    expect((await reset({ ...args, profile: {} })).status).toBe(400);
    const response = await reset();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.instance).toMatchObject({ id, revision: 3, profile: {} });
    expect(await (await reset()).json()).toEqual(receipt);
    expect(await retained()).toEqual(prior);
    const current = (await getEmployeeDetails(f.a.context, id)).profile;
    expect(current).toMatchObject({
      name: defaults.name,
      description: defaults.description,
      isDefaultRice: true,
      personalFields: [],
    });
    expect(current.identity).toMatchObject({
      role: defaults.role,
      mission: defaults.mission,
      workStyle: defaults.workStyle,
    });
    expect(defaults.expressionStyle).toBe(
      f.source.definition.identity.expressionStyle,
    );
    expect(current.expressionStyle).toBe(defaults.expressionStyle);
    expect(current.overrides).toEqual({});
    expect((await getEmployeeInstance(f.a.context, id)).profile).toEqual({});
    expect((await reset({ ...args, requestId: randomUUID() })).status).toBe(
      409,
    );
    e3HttpAuth.context = f.b.context;
    expect((await reset()).status).not.toBe(200);
    e3HttpAuth.context = f.a.context;
    await fixture.db`update allrice_memberships set active=false where organization_id=${f.a.organizationId} and user_id=${f.a.user.id}`;
    expect((await reset()).status).toBe(403);
  });

  it('U1 does not grant full persona or default reset to professional general or custom by the name Rice', async () => {
    const f = await setup(true),
      id = f.assignment.id,
      custom = await f.custom('Rice');
    await fixture.db`update allrice_employee_instances set profile=${fixture.db.json({ name: 'Rice' })} where id=${id}`;
    const professional = (await getEmployeeDetails(f.a.context, id)).profile;
    expect(professional.isDefaultRice).toBe(false);
    expect(professional.editableFields).toEqual(['expressionStyle']);
    const ownCustom = (await getEmployeeDetails(f.a.context, custom.id))
      .profile;
    expect(ownCustom.isDefaultRice).toBe(false);
    expect(ownCustom.editableFields).toContain('mission');
    for (const target of [id, custom.id])
      await expect(
        updateEmployeeInstance(f.a.context, target, {
          workspaceId: f.a.workspaceId,
          expectedRevision: 1,
          requestId: randomUUID(),
          operation: 'reset_profile',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      updateEmployeeInstance(f.a.context, id, {
        workspaceId: f.a.workspaceId,
        expectedRevision: 1,
        requestId: randomUUID(),
        profile: { mission: 'Must not widen professional authority' },
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect((await getEmployeeInstance(f.a.context, id)).revision).toBe(1);
    expect((await getEmployeeInstance(f.a.context, custom.id)).revision).toBe(
      1,
    );
  });

  it('U1 default Rice archive protection uses real identity before receipts or Run cancellation', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    await updateEmployeeInstance(f.a.context, id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Not called Rice' },
    });
    const run = await profileRun(f, id, 'Synthetic active task');
    const state = async () => ({
      instance:
        await fixture.db`select * from allrice_employee_instances where id=${id}`,
      revisions:
        await fixture.db`select * from allrice_employee_instance_revisions where instance_id=${id} order by revision`,
      jobs: await fixture.db`select * from allrice_jobs where run_id=${run.context.runId}`,
      run: await fixture.db`select * from allrice_runs where id=${run.context.runId}`,
    });
    const before = await state();
    expect((await getEmployeeDetails(f.a.context, id)).profile).toMatchObject({
      isDefaultRice: true,
      canArchive: false,
    });
    const args = {
      workspaceId: f.a.workspaceId,
      expectedRevision: 2,
      requestId: randomUUID(),
      operation: 'archive',
    };
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, id, args),
    ).rejects.toMatchObject({ code: 'default_protected' });
    e3HttpAuth.context = f.a.context;
    const routePath =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/lifecycle/route.ts';
    const { POST } = await import(routePath);
    const archive = () =>
      POST(
        new Request(
          `https://allrice.test/api/v1/employee-instances/${id}/lifecycle`,
          {
            method: 'POST',
            headers: {
              origin: 'https://allrice.test',
              'content-type': 'application/json',
            },
            body: JSON.stringify(args),
          },
        ),
        { params: Promise.resolve({ id }) },
      );
    const response = await archive();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe(
      'DEFAULT_EMPLOYEE_PROTECTED',
    );
    expect(await state()).toEqual(before);
    e3HttpAuth.context = f.b.context;
    expect([403, 404]).toContain((await archive()).status);
    expect(await state()).toEqual(before);
    expect(
      (await getEmployeeInstanceHistory(f.a.context, id)).revisions,
    ).toHaveLength(2);
  });

  it.each(['general', 'custom'] as const)(
    'U1 allows non-default %s named Rice to archive and restore its current profile',
    async (kind) => {
      const f = await setup(true),
        id = kind === 'general' ? f.assignment.id : (await f.custom('Rice')).id;
      // Legacy label cannot confer the protected platform identity on a professional.
      if (kind === 'general')
        await fixture.db`update allrice_employee_instances set profile=${fixture.db.json({ name: 'Rice' })} where id=${id}`;
      const updated = await updateEmployeeInstance(f.a.context, id, {
        workspaceId: f.a.workspaceId,
        expectedRevision: 1,
        requestId: randomUUID(),
        profile: {
          ...(kind === 'custom'
            ? { name: 'Rice', mission: 'Preserved personal mission' }
            : {}),
          expressionStyle: 'structured',
        },
      });
      expect((await getEmployeeDetails(f.a.context, id)).profile).toMatchObject(
        { isDefaultRice: false, canArchive: true },
      );
      const archive = {
        workspaceId: f.a.workspaceId,
        expectedRevision: updated.revision,
        requestId: randomUUID(),
        operation: 'archive',
      };
      const archived = await changeEmployeeInstanceLifecycle(
        f.a.context,
        id,
        archive,
      );
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.profile).toEqual(updated.profile);
      expect(
        await changeEmployeeInstanceLifecycle(f.a.context, id, archive),
      ).toEqual(archived);
      const historical = await getEmployeeInstanceForHistory(f.a.context, id);
      expect(historical.profile).toEqual(updated.profile);
      const restore = {
        workspaceId: f.a.workspaceId,
        expectedRevision: historical.revision,
        sourceRevision: historical.revision,
        requestId: randomUUID(),
        operation: 'restore',
      };
      const restored = await changeEmployeeInstanceLifecycle(
        f.a.context,
        id,
        restore,
      );
      expect(restored.archivedAt).toBeNull();
      expect(restored.profile).toEqual(updated.profile);
      expect(restored.revision).toBe(archived.revision + 1);
      expect(
        await changeEmployeeInstanceLifecycle(f.a.context, id, restore),
      ).toEqual(restored);
      expect(
        (await listEmployeeInstances(f.a.context, f.a.workspaceId)).map(
          (i) => i.id,
        ),
      ).toContain(id);
      await expect(
        changeEmployeeInstanceLifecycle(f.b.context, id, {
          ...archive,
          expectedRevision: restored.revision,
          requestId: randomUUID(),
        }),
      ).rejects.toBeDefined();
    },
  );

  it.each([false, true] as const)(
    'normal new Run admission has no legacy methods (Rice=%s)',
    async (rice) => {
      const f = await setup(true, rice),
        id = rice ? f.assignment.id : (await f.custom('Current owner')).id;
      const run = await methodRun(f, id, '以后按这份办法来做。');
      expect(
        run.frozen.capabilitySnapshot.bindings.toolNames.filter(
          (name: string) => name.startsWith('workspace.employee.method.'),
        ),
      ).toEqual([]);
      const resolved = await resolveEmployeeExecution(run.scope);
      const kernel = assembleEmployeeKernel({
        employeeAssignmentId: run.frozen.assignment.id,
        employeeVersionId: run.frozen.employee.versionId,
        sessionId: run.sessionId,
        userMessageId: run.userMessageId,
        assistantMessageId: randomUUID(),
        resolved,
      });
      expect(kernel.employeeDocuments).toEqual(
        resolved.promptSnapshot.employeeDocuments,
      );
      expect(kernel.systemInstructions).not.toContain(
        'The three method tools inspect, save_candidate and restore_candidate',
      );
      for (const [invoke, args] of [
        [inspectEmployeeMethodFromChat, { view: 'candidate' }],
        [
          saveEmployeeMethodAndPublishFromChat,
          {
            expectedRevision: 0,
            section: 'scene',
            scene: { name: 'Owner method', appliesWhen: 'Owner asks' },
            procedure: 'Keep facts.',
            changeSummary: 'New text',
          },
        ],
        [
          restoreEmployeeMethodAndPublishFromChat,
          {
            expectedRevision: 0,
            sourceRevisionId: randomUUID(),
            changeSummary: 'New restore',
          },
        ],
      ] as const)
        await expect(invoke({ ...run, arguments: args })).rejects.toMatchObject(
          { code: 'authorization_denied' },
        );
      expect(
        (
          await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${run.scope.runId}`
        )[0]!.execution_snapshot,
      ).toEqual(run.frozen);
      expect(
        await fixture.db`select id from allrice_employee_content_sets where instance_id=${id}`,
      ).toHaveLength(0);
      await run.finish();
    },
  );

  it('U1 rejects other owners, absent frozen grants, stale leases and internal sources for Rice methods', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    let run = await historicalMethodRun(f, id, '把这套办法留下。');
    expect(
      await inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'candidate' },
      }),
    ).toMatchObject({ revision: 0 });
    const foreign = await createChatSession(f.b.context, {
      workspaceId: f.b.workspaceId,
      employeeInstanceId: f.bAssignment.id,
      title: 'Other owner',
    });
    const calls = [
      {
        invoke: inspectEmployeeMethodFromChat,
        arguments: { view: 'candidate' },
      },
      {
        invoke: saveEmployeeMethodAndPublishFromChat,
        arguments: {
          expectedRevision: 0,
          section: 'scene',
          scene: { name: 'Owner method', appliesWhen: 'Owner asks' },
          procedure: 'Keep original facts.',
          changeSummary: 'Owner edit',
        },
      },
      {
        invoke: restoreEmployeeMethodAndPublishFromChat,
        arguments: {
          expectedRevision: 0,
          sourceRevisionId: randomUUID(),
          changeSummary: 'Owner restore',
        },
      },
    ];
    for (const call of calls)
      await expect(
        call.invoke({
          ...run,
          sessionId: foreign.id,
          arguments: call.arguments,
        }),
      ).rejects.toThrow();
    await run.finish();
    const missing = await methodRun(f, id, '此前未授予方法工具。');
    expect(
      missing.frozen.capabilitySnapshot.bindings.toolNames.filter(
        (name: string) => name.startsWith('workspace.employee.method.'),
      ),
    ).toEqual([]);
    for (const call of calls)
      await expect(
        call.invoke({ ...missing, arguments: call.arguments }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    await missing.finish();
    run = await historicalMethodRun(f, id, '检查当前租约和消息来源。');
    expect(run.frozen.capabilitySnapshot.bindings.toolNames).toContain(
      'workspace.employee.method.inspect',
    );
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.context.jobId}`;
    for (const call of calls)
      await expect(
        call.invoke({ ...run, arguments: call.arguments }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '5 minutes' where id=${run.context.jobId}`;
    // Existing producer facts may precede their Run link; role=user is not
    // sufficient. This fixture never starts the paused automation.
    const [message] =
      await fixture.db`select client_message_id from allrice_messages where id=${run.userMessageId}`;
    const automationId = randomUUID();
    await fixture.db`insert into allrice_automations (id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,clock_owner)
      values(${automationId},${f.a.organizationId},${f.a.workspaceId},${f.a.user.id},'Synthetic source only','Synthetic source only','schedule',${fixture.db.json({ frequency: 'daily', time: '08:30', timezone: 'Asia/Shanghai' })},'paused','reuse',${id},${run.sessionId},'legacy')`;
    await fixture.db`insert into allrice_automation_runs (id,organization_id,workspace_id,automation_id,run_id,status,scheduled_for)
      values(${message!.client_message_id},${f.a.organizationId},${f.a.workspaceId},${automationId},null,'queued',clock_timestamp())`;
    for (const call of calls)
      await expect(
        call.invoke({ ...run, arguments: call.arguments }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(
      await fixture.db`select id from allrice_employee_content_sets where instance_id=${id}`,
    ).toHaveLength(0);
    expect(
      (
        await fixture.db`select method_authoring from allrice_employee_runs where run_id=${run.context.runId}`
      )[0]!.method_authoring,
    ).toBe(false);
    await run.finish();
  });

  it('U1 does not give a professional general employee Rice methods by its display name', async () => {
    const f = await setup(true);
    await fixture.db`update allrice_employee_instances set profile=${fixture.db.json({ name: 'Rice' })} where id=${f.assignment.id}`;
    const run = await methodRun(f, f.assignment.id, '保存本人的办法。');
    expect(
      run.frozen.capabilitySnapshot.bindings.toolNames.filter((name: string) =>
        name.startsWith('workspace.employee.method.'),
      ),
    ).toEqual([]);
    await expect(
      inspectEmployeeMethodFromChat({
        ...run,
        arguments: { view: 'candidate' },
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      listPersonalSceneSkills(f.a.context, f.assignment.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await run.finish();
  });

  it('U1 keeps the legacy unconfirmed content HTTP boundary closed for Rice', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    e3HttpAuth.context = f.a.context;
    const routePath =
      '../../../../apps/web/app/api/v1/employee-content/route.ts';
    const { POST: postInstanceContent } = await import(routePath);
    const response = await postInstanceContent(
      new Request(
        `https://allrice.test/api/v1/employee-instances/${id}/content`,
        {
          method: 'POST',
          headers: {
            origin: 'https://allrice.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: f.a.workspaceId,
            requestId: randomUUID(),
            setId: randomUUID(),
            operation: 'save_draft',
            expectedRevision: 0,
            ownership: {
              scope: 'personal',
              organizationId: f.a.organizationId,
              ownerId: f.a.user.id,
            },
            target: { kind: 'instance', instanceId: id },
            manifest: {
              schemaVersion: 1,
              common: [],
              scenes: [],
              declaredConflicts: [],
            },
            textEdits: [],
            changeSummary: 'Synthetic authorized personal method',
          }),
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(
      await fixture.db`select id from allrice_employee_content_sets where instance_id=${id}`,
    ).toHaveLength(0);
  });

  it('U1 gives Rice and owner custom the same exact personal package HTTP, resource and runtime reads', async () => {
    const f = await setup(true, true),
      custom = await f.custom('My workflow employee');
    e3HttpAuth.context = f.a.context;
    const routePath =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/route.ts';
    const { POST, GET } = await import(routePath);
    const body = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 0,
      expectedContentRef: null,
      scene: {
        id: randomUUID(),
        name: 'Synthetic workflow',
        appliesWhen: 'Synthetic test only',
      },
      procedure: {
        kind: 'procedure',
        title: 'Synthetic procedure',
        ...sceneSkillFixture(),
      },
      references: [],
      changeSummary: 'Owner package',
    };
    const save = (id: string, requestId = randomUUID()) =>
      POST(
        new Request(
          `https://allrice.test/api/v1/employee-instances/${id}/scene-skills`,
          {
            method: 'POST',
            headers: {
              origin: 'https://allrice.test',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ ...body, requestId }),
          },
        ),
        { params: Promise.resolve({ id }) },
      );
    expect((await save(f.assignment.id)).status).toBe(200);
    const riceSkills = await listPersonalSceneSkills(
      f.a.context,
      f.assignment.id,
    );
    expect(riceSkills.skills).toHaveLength(1);
    const ref = riceSkills.skills[0]!.contentRef;
    expect(typeof ref).toBe('string');
    if (!ref)
      throw new Error('Rice personal package must expose an exact contentRef');
    const readHttp = (selection: Record<string, string>) =>
      GET(
        new Request(
          `https://allrice.test/api/v1/employee-instances/${f.assignment.id}/scene-skills?${new URLSearchParams(selection)}`,
        ),
        { params: Promise.resolve({ id: f.assignment.id }) },
      );
    const directory = await readHttp({});
    expect(directory.status).toBe(200);
    expect((await directory.json()).skills[0].contentRef).toBe(ref);
    const exactHttp = await readHttp({
      contentRef: ref,
      resourcePath: 'assets/template.csv',
    });
    expect(exactHttp.status).toBe(200);
    expect(
      Buffer.from((await exactHttp.json()).contentBase64, 'base64').toString(),
    ).toContain('synthetic');
    const skill = await inspectPersonalSceneSkill(
      f.a.context,
      f.assignment.id,
      ref,
    );
    expect(skill.contentRef).toBe(ref);
    const resource = await getPersonalSceneSkillResource(
      f.a.context,
      f.assignment.id,
      ref,
      'assets/template.csv',
    );
    expect(Buffer.from(resource.contentBase64, 'base64').toString()).toContain(
      'synthetic',
    );
    await expect(
      inspectPersonalSceneSkill(f.b.context, f.assignment.id, ref),
    ).rejects.toThrow();
    const run = await methodRun(f, f.assignment.id, '使用本人工作场景。');
    expect(run.frozen.content.personalScenes).toBe(true);
    const worker = {
      jobId: run.context.jobId,
      workerId: run.context.worker.id,
      attempt: run.worker.attempt,
      leaseToken: run.worker.leaseToken,
    };
    await acquireConversationRuntime({
      ...run.scope,
      workerId: worker.workerId,
      configChecksum: `sha256:${'c'.repeat(64)}`,
      compactThresholdTokens: 40000,
    });
    await loadPersonalRuntimeSceneSkill(
      run.scope,
      run.runtime.generationId,
      { sceneId: body.scene.id },
      worker,
    );
    await loadPersonalRuntimeSceneSkill(
      run.scope,
      run.runtime.generationId,
      { contentRef: ref, resourcePath: 'assets/template.csv' },
      worker,
    );
    const [read] =
      await fixture.db`select content_scene_state from allrice_employee_runs where run_id=${run.context.runId}`;
    expect(read!.content_scene_state.reads[0].personal).toMatchObject({
      contentRef: ref,
      contentRead: true,
      resources: [{ path: 'assets/template.csv' }],
    });
    expect(
      await listPersonalSceneReads(f.a.context, f.assignment.id),
    ).toBeDefined();
    await run.finish();
    expect((await save(custom.id)).status).toBe(200);
    expect(
      (await listPersonalSceneSkills(f.a.context, custom.id)).skills,
    ).toHaveLength(1);
    await fixture.db`update allrice_employee_content_publications set invalidated_at=clock_timestamp()
      where set_id in (select id from allrice_employee_content_sets where instance_id=${f.assignment.id})`;
    await expect(
      inspectPersonalSceneSkill(f.a.context, f.assignment.id, ref),
    ).rejects.toThrow();
    await expect(
      getPersonalSceneSkillResource(
        f.a.context,
        f.assignment.id,
        ref,
        'assets/template.csv',
      ),
    ).rejects.toThrow();
    expect(
      (await readHttp({ contentRef: ref, resourcePath: 'assets/template.csv' }))
        .status,
    ).toBe(404);
    expect(
      (await listPersonalSceneSkills(f.a.context, custom.id)).skills,
    ).toHaveLength(1);
    expect(
      (
        await fixture.db`select content_scene_state from allrice_employee_runs where run_id=${run.context.runId}`
      )[0]!.content_scene_state,
    ).toEqual(read!.content_scene_state);
  });

  it('U1 Rice text tools cannot remove, relink or restore a package around exact-file confirmation', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    const input = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 0,
      expectedContentRef: null,
      scene: {
        id: randomUUID(),
        name: 'Exact package',
        appliesWhen: 'Owner task',
      },
      procedure: {
        kind: 'procedure',
        title: 'Package',
        ...sceneSkillFixture(),
      },
      references: [],
      changeSummary: 'Package v1',
    };
    const first = await savePersonalSceneSkill(f.a.context, id, input);
    const [before] =
      await fixture.db`select id,active_revision_id from allrice_employee_content_sets where instance_id=${id}`;
    const firstManifest = (await getEmployeeContentSet(f.a.context, before!.id))
      .set.active!.manifest;
    const packageRef = firstManifest.scenes[0]!.references.find(
      (ref) => ref.sourceKind === 'procedure',
    )!;
    await savePersonalSceneSkill(f.a.context, id, {
      ...input,
      requestId: randomUUID(),
      expectedRevision: first.revision,
      expectedContentRef: first.contentRef,
      procedure: { ...input.procedure, ...sceneSkillFixture('2.0.0') },
      changeSummary: 'Package v2',
    });
    const current = (await getEmployeeContentSet(f.a.context, before!.id)).set;
    const run = await historicalMethodRun(f, id, '调整本人方法。');
    const base = {
      expectedRevision: current.revision,
      section: 'scene',
      changeSummary: 'Text tool cannot change package',
    };
    for (const args of [
      { ...base, operation: 'remove_scene', scene: { id: input.scene.id } },
      {
        ...base,
        scene: {
          id: input.scene.id,
          name: 'Renamed outside file confirmation',
        },
      },
      {
        ...base,
        scene: { id: input.scene.id },
        procedure: 'Replace package with text',
        replaceTextReferences: current.active!.manifest.scenes[0]!.references,
      },
      {
        ...base,
        scene: { name: 'Relink package', appliesWhen: 'Owner task' },
        references: [packageRef],
      },
    ]) {
      await expect(
        saveEmployeeMethodAndPublishFromChat({
          ...run,
          callId: randomUUID(),
          arguments: args,
        }),
      ).rejects.toMatchObject({ code: 'legacy_method_retired' });
    }
    await expect(
      restoreEmployeeMethodAndPublishFromChat({
        ...run,
        callId: randomUUID(),
        arguments: {
          expectedRevision: current.revision,
          sourceRevisionId: before!.active_revision_id,
          changeSummary: 'Cannot restore package via text tool',
        },
      }),
    ).rejects.toMatchObject({ code: 'legacy_method_retired' });
    const after = (await getEmployeeContentSet(f.a.context, before!.id)).set;
    expect(after.revision).toBe(current.revision);
    expect(after.active).toEqual(current.active);
    expect(
      (await getEmployeeContentHistory(f.a.context, before!.id)).revisions,
    ).toHaveLength(2);
    await run.finish();
  });

  it('U1 replays a Rice text restore receipt without undoing a later confirmed package update', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    const input = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 0,
      expectedContentRef: null,
      scene: {
        id: randomUUID(),
        name: 'Stable package',
        appliesWhen: 'Owner task',
      },
      procedure: {
        kind: 'procedure',
        title: 'Package',
        ...sceneSkillFixture(),
      },
      references: [],
      changeSummary: 'Package A',
    };
    await savePersonalSceneSkill(f.a.context, id, input);
    const [set] =
      await fixture.db`select id,active_revision_id from allrice_employee_content_sets where instance_id=${id}`;
    const run = await historicalMethodRun(f, id, '保存本人文字方法。');
    const sourceManifest = (await getEmployeeContentSet(f.a.context, set!.id))
      .set.active!.manifest;
    const textId = randomUUID();
    const base = {
      workspaceId: f.a.workspaceId,
      setId: set!.id,
      ownership: {
        scope: 'personal',
        organizationId: f.a.organizationId,
        ownerId: f.a.user.id,
      },
      target: { kind: 'instance', instanceId: id },
    };
    const text = await seedHistoricalEmployeeContent(
      fixture.db,
      f.a.context,
      {
        ...base,
        operation: 'save_draft',
        requestId: randomUUID(),
        expectedRevision: 1,
        changeSummary: 'Historical text only',
        manifest: {
          ...sourceManifest,
          common: [{ sourceKind: 'draft_text', contentId: textId }],
        },
        textEdits: [
          {
            contentId: textId,
            revisionId: randomUUID(),
            expectedRevision: 0,
            kind: 'requirement',
            title: 'Historical text',
            body: 'Retained owner text',
          },
        ],
      },
      { active: true },
    );
    const restoreCall = {
      ...run,
      callId: randomUUID(),
      arguments: {
        expectedRevision: text.revision,
        sourceRevisionId: set!.active_revision_id,
        changeSummary: 'Restore text only',
      },
    };
    const restored = await seedHistoricalEmployeeContent(
      fixture.db,
      f.a.context,
      {
        ...base,
        operation: 'save_draft',
        requestId: employeeChatIdentity(restoreCall).requestId,
        expectedRevision: text.revision,
        manifest: sourceManifest,
        textEdits: [],
        changeSummary: restoreCall.arguments.changeSummary,
      },
      {
        active: true,
        requestOperation: 'restore_draft',
        restoredFromRevisionId: set!.active_revision_id,
        inputDigest: runtimePolicyDigest({
          publication: 'save_and_publish',
          instanceId: id,
          runId: run.context.runId,
          userMessageId: run.userMessageId,
          arguments: toolSelection.EmployeeMethodRestoreSchema.parse(
            restoreCall.arguments,
          ),
        }),
      },
    );
    const [skill] = (await listPersonalSceneSkills(f.a.context, id)).skills;
    const updated = await savePersonalSceneSkill(f.a.context, id, {
      ...input,
      requestId: randomUUID(),
      expectedRevision: restored.revision,
      expectedContentRef: skill!.contentRef,
      procedure: { ...input.procedure, ...sceneSkillFixture('2.0.0') },
      changeSummary: 'Package B',
    });
    const beforeReplay =
      await fixture.db`select * from allrice_employee_content_sets where id=${set!.id}`;
    expect(await restoreEmployeeMethodAndPublishFromChat(restoreCall)).toEqual({
      ...restored,
      personalTextOnly: true,
    });
    await expect(
      restoreEmployeeMethodAndPublishFromChat({
        ...restoreCall,
        arguments: {
          ...restoreCall.arguments,
          changeSummary: 'Changed historical payload',
        },
      }),
    ).rejects.toThrow('request_conflict');
    expect(
      await fixture.db`select * from allrice_employee_content_sets where id=${set!.id}`,
    ).toEqual(beforeReplay);
    expect(
      (
        await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${run.context.runId}`
      )[0]!.execution_snapshot,
    ).toEqual(run.frozen);
    const after = (await getEmployeeContentSet(f.a.context, set!.id)).set;
    expect(after.revision).toBe(updated.revision);
    expect(
      (await listPersonalSceneSkills(f.a.context, id)).skills[0]!.contentRef,
    ).toBe(updated.contentRef);
    expect(
      (await inspectPersonalSceneSkill(f.a.context, id, updated.contentRef))
        .bundleVersion,
    ).toBe('2.0.0');
    expect(
      (await getEmployeeContentHistory(f.a.context, set!.id)).revisions,
    ).toHaveLength(4);
    await run.finish();
  });

  it('U1 reads existing authorized Rice personal history without rewriting snapshots or revisions', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    const input = {
      instanceId: id,
      employeeId: f.assignment.employeeId,
      employeeVersionId: f.assignment.currentVersion.id,
    };
    const setId = randomUUID();
    let old;
    {
      await seedHistoricalEmployeeContent(
        fixture.db,
        f.a.context,
        {
          workspaceId: f.a.workspaceId,
          requestId: randomUUID(),
          setId,
          expectedRevision: 0,
          operation: 'save_draft',
          ownership: {
            scope: 'personal',
            organizationId: f.a.organizationId,
            ownerId: f.a.user.id,
          },
          target: { kind: 'instance', instanceId: id },
          manifest: {
            schemaVersion: 1,
            common: [],
            scenes: [],
            declaredConflicts: [],
          },
          textEdits: [],
          changeSummary: 'Pre-E3 legacy personal layer',
        },
        { active: true },
      );
      old = await freezeEmployeeRuntimeContent(f.a.context, input, fixture.db);
      expect(old.layers).toHaveLength(1);
      await readEmployeeRuntimeContent(f.a.context, old, fixture.db);
    }
    const before = JSON.stringify(old);
    await readEmployeeRuntimeContent(f.a.context, old, fixture.db);
    expect(JSON.stringify(old)).toBe(before);
    const next = await freezeEmployeeRuntimeContent(
      f.a.context,
      input,
      fixture.db,
    );
    expect(next.layers).toEqual(old.layers);
    await readEmployeeRuntimeContent(f.a.context, next, fixture.db);
    const [history] =
      await fixture.db`select manifest from allrice_employee_content_revisions where set_id=${setId}`;
    expect(history!.manifest).toEqual({
      schemaVersion: 1,
      common: [],
      scenes: [],
      declaredConflicts: [],
    });
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
    const f = await createLocalCommandFixture(fixture.db);
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
  it('stores the chosen employee name and palette in the instance, revision and reloaded workspace', async () => {
    const f = await setup();
    const input = {
      ...f.input('𠮷野财务助手'),
      profile: {
        name: '𠮷野财务助手',
        expressionStyle: 'structured',
        appearance: {
          avatarType: 'initials',
          avatarValue: '𠮷',
          accentColor: 'coral',
        },
      },
    };
    const created = await createEmployeeInstance(f.a.context, input);
    expect(created.profile).toEqual(input.profile);
    expect(
      (await getEmployeeInstance(f.a.context, created.id)).profile,
    ).toEqual(input.profile);
    const [stored] =
      await fixture.db`select profile from allrice_employee_instances where id=${created.id}`;
    expect(stored!.profile).toEqual(input.profile);
    expect(
      (await getEmployeeInstanceHistory(f.a.context, created.id)).revisions[0]!
        .profile,
    ).toEqual(input.profile);
    const hub = await getEmployeeWorkspace(f.a.context, f.a.workspaceId);
    expect(
      hub.employees
        .flatMap((e) => e.instances ?? [])
        .find((i) => i.id === created.id)?.profile,
    ).toEqual(input.profile);
    expect(await createEmployeeInstance(f.a.context, input)).toEqual(created);
    await expect(
      createEmployeeInstance(f.a.context, {
        ...input,
        profile: {
          ...input.profile,
          appearance: { ...input.profile.appearance, accentColor: 'blue' },
        },
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await expect(
      getEmployeeInstance(f.b.context, created.id),
    ).rejects.toBeDefined();
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
    await revokeSession(f.a.login.token);
    await expect(
      createEmployeeInstance(f.a.context, f.input('Expired')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    // The actual receipt -> Run/Job/history path is covered by the recurring
    // integration suite. Here retain this fixture's current identity gate,
    // without using the retired legacy due scanner to manufacture a Run.
    const authority = () =>
      fixture.db.begin((tx) =>
        lockSchedulePrincipal(
          tx,
          {
            organizationId: f.a.organizationId,
            workspaceId: f.a.workspaceId,
            ownerId: f.a.user.id,
          },
          randomUUID(),
        ),
      );
    const principal = await authority();
    expect(principal.actor).toEqual({ type: 'user', id: f.a.user.id });
    expect(principal).not.toHaveProperty('sessionId');
    expect(principal).not.toHaveProperty('authenticatedAt');
    await fixture.db`update allrice_memberships set active=false where user_id=${f.a.user.id} and organization_id=${f.a.organizationId}`;
    await expect(authority()).rejects.toMatchObject({
      code: 'authorization_denied',
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
    const f = await createRunAuthorityFixture(fixture.db, {
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
    const f = await createRunAuthorityFixture(fixture.db, {
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
    const [drain] =
      await fixture.db`select drain_reason,drain_deadline_at from allrice_jobs where run_id=${f.rootRunId}`;
    expect(drain?.drain_reason).toBe('cancel');
    expect(drain?.drain_deadline_at).toBeInstanceOf(Date);
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
      await heartbeatJob(
        f.worker.workerId,
        f.worker.jobId,
        f.worker.leaseToken,
        60000,
      ),
    ).toMatchObject({
      active: false,
      canceled: true,
      draining: true,
      drainDeadlineAt: drain!.drain_deadline_at.toISOString(),
    });
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
