import { assembleEmployeeKernel } from '../../../../apps/worker/src/employee-kernel.js';
import { resolveEmployeeExecution } from './employeehub.ts';

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

import { memoryPairDigest } from '../workspace/employee-memory.ts';

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
  loadPersonalRuntimeSceneSkill,
  prepareEmployeeContentContext,
} from './employee-runtime-content.ts';
import { getEmployeeDetails } from './employee-content.ts';
import { randomUUID } from 'node:crypto';

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
  getEmployeeWorkspace,
  listChatSessions,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
  disablePlatformEmployee,
  assignPublishedPlatformEmployeeToWorkspace,
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

  async function chatRun(
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
    const first = await chatRun(f, instance.id, 'Synthetic first task');
    expect(first.frozen.sandboxExecutionPolicy).toEqual({
      version: 1,
      maxExecutionMs: 600000,
      sources: [],
    });
    const frozenBytes = JSON.stringify(first.frozen);
    await first.finish();
    await fixture.db`insert into allrice_model_resource_limits(id,organization_id,scope_type,scope_id,monthly_run_limit,monthly_token_limit,concurrent_run_limit,max_runtime_ms,max_sandbox_execution_ms)
      values(${randomUUID()},${f.a.organizationId},'user',${f.a.user.id},2000,2000000,3,0,1800000)`;
    const second = await chatRun(
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

  // MET-210: the receipt lives with the message, so it survives past the
  // polled interactions window and without the workbench.
  it('history keeps each question answer receipt from its command', async () => {
    const f = await setup(true),
      instance = await f.custom('Ordinary question');
    const run = await chatRun(f, instance.id, '请继续这个合成任务。');
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
        await fixture.db`select prompt_snapshot,memory_context_state from allrice_employee_runs where run_id=${sent.run.id}`;
      const [pair] = await fixture.db<
        { summary: string; details: string | null }[]
      >`select summary,details from allrice_memories where id=${memory.id}`;
      expect(pair).toEqual({
        summary: Array.from(input.text).slice(0, 40).join(''),
        details: input.text,
      });
      expect(restoredRun!.prompt_snapshot.memories).toEqual([]);
      expect(restoredRun!.prompt_snapshot.employeeDocuments.schemaVersion).toBe(
        2,
      );
      expect(restoredRun!.prompt_snapshot.employeeDocuments.memory).toContain(
        `[1] ${pair!.summary}（有说明）`,
      );
      expect(
        restoredRun!.prompt_snapshot.employeeDocuments.memory,
      ).not.toContain(input.text);
      expect(restoredRun!.memory_context_state.pins).toEqual([
        {
          number: 1,
          id: memory.id,
          revision: memory.revision,
          pairDigest: memoryPairDigest(pair!),
          hasDetails: true,
        },
      ]);
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

  function personaDocument(text: string | undefined) {
    expect(text?.startsWith('# 人设\n')).toBe(true);
    expect(Buffer.byteLength(text!, 'utf8')).toBeLessThanOrEqual(16384);
    return JSON.parse(text!.slice('# 人设\n'.length));
  }
  it('U1 Rice full persona reaches owner details, workspace and the next kernel without changing frozen history or grants', async () => {
    const f = await setup(true, true),
      id = f.assignment.id;
    const before = await profileRun(f, id, 'Synthetic baseline');
    const oldRows =
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${before.context.runId}`;
    expect(
      personaDocument(oldRows[0]!.prompt_snapshot.employeeDocuments.persona)
        .name,
    ).toEqual({ value: 'Platform assistant', source: 'platform_default' });
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
    const [current] =
      await fixture.db`select profile from allrice_employee_instances where id=${id}`;
    expect(current!.profile).toEqual(profile);
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
    expect(next.frozen.instance.profile).toEqual(profile);
    const resolved = await resolveEmployeeExecution({
      organizationId: f.a.organizationId,
      workspaceId: f.a.workspaceId,
      ownerId: f.a.user.id,
      runId: next.context.runId,
    });
    const persona = personaDocument(
      resolved.promptSnapshot.employeeDocuments?.persona,
    );
    for (const [field, value] of Object.entries(profile)) {
      if (field === 'appearance') continue;
      expect(persona[field]).toMatchObject({
        value,
        source: 'personal_override',
      });
    }
    for (const [field, value] of Object.entries(profile.appearance)) {
      expect(persona.appearance[field]).toEqual({
        value,
        source: 'personal_override',
      });
    }
    expect(persona.source).toMatchObject({
      kind: 'employee_run',
      ownerId: f.a.user.id,
      instanceId: id,
      profileRevision: 2,
      profileEligibility: 'full_identity',
    });
    expect(persona.source).toEqual(next.frozen.persona.source);
    expect(resolved.promptSnapshot).not.toHaveProperty('personalIdentity');
    const kernel = assembleEmployeeKernel({
      employeeAssignmentId: id,
      employeeVersionId: next.frozen.employee.versionId,
      sessionId: next.sessionId,
      userMessageId: next.userMessageId,
      assistantMessageId: randomUUID(),
      resolved,
    });
    const [stored] =
      await fixture.db`select prompt_snapshot from allrice_employee_runs where run_id=${next.context.runId}`;
    expect(stored!.prompt_snapshot.employeeDocuments).toEqual(
      resolved.promptSnapshot.employeeDocuments,
    );
    expect(kernel.employeeDocuments).toEqual(
      resolved.promptSnapshot.employeeDocuments,
    );
    for (const instructions of [
      kernel.systemInstructions,
      kernel.rootSystemInstructions,
    ]) {
      expect(instructions).toContain(f.source.definition.systemPrompt);
      expect(instructions).toContain('cannot override platform policy');
      expect(instructions).not.toContain(profile.name);
      expect(instructions).not.toContain(profile.mission);
      expect(instructions).not.toContain(
        'Explicit personal identity preferences',
      );
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
      const run = await chatRun(f, id, '以后按这份办法来做。');
      expect(
        run.frozen.capabilitySnapshot.bindings.toolNames.filter(
          (name: string) => name.startsWith('workspace.employee.method.'),
        ),
      ).toEqual([]);
      const resolved = await resolveEmployeeExecution(run.scope);
      expect(resolved.promptSnapshot.employeeDocuments).toEqual({
        schemaVersion: 2,
        persona: expect.any(String),
        user: expect.any(String),
        memory: expect.any(String),
      });
      if (rice) {
        const details = (await getEmployeeDetails(f.a.context, id)).profile;
        const persona = personaDocument(
          resolved.promptSnapshot.employeeDocuments?.persona,
        );
        expect(persona.name).toEqual({
          value: details.name,
          source: 'platform_default',
        });
        expect(persona.source).toMatchObject({
          ownerId: f.a.user.id,
          instanceId: id,
          profileRevision: 1,
          profileEligibility: 'full_identity',
        });
      }
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
    const run = await chatRun(f, f.assignment.id, '使用本人工作场景。');
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
