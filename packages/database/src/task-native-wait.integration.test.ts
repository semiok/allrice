import { randomUUID } from 'node:crypto';
import {
  JobPayloadSchema,
  UuidSchema,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createLocalCommandFixture } from './local-command.fixture.ts';
import * as client from './core/client.ts';
import {
  parkNativeQuestion,
  readNativeQuestionWait,
  beginNativeTask,
  beginNativeTaskWithStopReceipt,
  continueNativeQuestion,
} from './task-native-wait.ts';
import { refreshTaskClock, readTaskClock } from './task-clock.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import {
  maintainQueue,
  claimNextJob,
  startClaimedJob,
  heartbeatJob,
  cancelRun,
  enqueueRun,
  finishJobDrain,
  bindJobNativeSession,
} from './execution/queue.ts';
import { nativeBindingDescriptor } from './native-session-binding.fixture.ts';
import { JOB_READY_CHANNEL } from './execution/queue-ready.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';
import { newNativeGeneration } from './conversation/native-root-origin.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
import { acquireConversationRuntime } from './conversation/conversation-runtime.ts';
import {
  ensureGeneralEmployeeInstance,
  changeEmployeeInstanceLifecycle,
} from './employees/employee-instances.ts';
import { authenticateSession, createSession } from './identity.ts';
import { sendChatMessage } from './workspace/service.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
} from './conversation/conversation-input.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET153 durable native waits and queue authority', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let runtimePackage: EmployeeRuntimePackage;
  beforeAll(async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    // MET-221: only a business origin binds, so a bound segment's chat is born
    // on the current generation under this synthetic release primary.
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'c'.repeat(64));
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const employee = await createEmployeeAdministrationFixture(fixture.db);
    runtimePackage = buildEmployeeRuntimePackage({
      revision: 1,
      definition: {
        ...employee.definition,
        capabilities: {
          ...employee.definition.capabilities,
          nativeSkillIds: [],
        },
      },
      skills: [],
    });
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  async function setup(withStopReceipt = false) {
    const f = await createLocalCommandFixture(
      fixture.db,
      'ask',
      false,
      {
            deferRuntimeRoot: true,
        ...(withStopReceipt
          ? { runtimePackage, businessCreationOrigin: true }
          : {}),
      },
    );
    f.requestContext.memberships = f.context.policySnapshot.memberships;
    if (withStopReceipt) {
      // The generic assistant fixture leaves Job.input empty. This fresh
      // employee segment must carry the exact source identities used by the
      // production employee handler, not synthetic replacement IDs.
      const [employeeRun] = await f.db<
        {
          session_id: string;
          user_message_id: string;
          assistant_message_id: string;
          employee_assignment_id: string;
          employee_version_id: string;
        }[]
      >`select session_id,user_message_id,assistant_message_id,employee_assignment_id,employee_version_id
        from allrice_employee_runs where run_id=${f.rootRunId}
          and organization_id=${f.org} and workspace_id=${f.workspace} and owner_id=${f.user}`;
      if (!employeeRun) throw Error('fixture_employee_run_missing');
      expect(employeeRun.session_id).toBe(f.session);
      const payload = {
        schemaVersion: 1,
        type: 'allrice.employee.run',
        input: {
          sessionId: UuidSchema.parse(employeeRun.session_id),
          userMessageId: UuidSchema.parse(employeeRun.user_message_id),
          assistantMessageId: UuidSchema.parse(
            employeeRun.assistant_message_id,
          ),
          employeeAssignmentId: UuidSchema.parse(
            employeeRun.employee_assignment_id,
          ),
          employeeVersionId: UuidSchema.parse(employeeRun.employee_version_id),
        },
      };
      JobPayloadSchema.parse(payload);
      await f.db`update allrice_jobs set payload=${f.db.json(payload)} where id=${f.worker.jobId}`;
    }
    await f.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    const checkpoint = {
      sessionId: `dsh-${f.session}`,
      questionId: `question-${randomUUID()}`,
      turnId: `dsh-${f.session}:turn:0`,
      sequence: 20,
      questions: [
        {
          id: 'choice',
          question: 'Continue?',
          multiSelect: false,
          options: [{ label: 'Continue' }],
        },
      ],
    };
    const [runtime] = await f.db<
      { config_checksum: string; thread_generation: number }[]
    >`select config_checksum,thread_generation from allrice_conversation_runtimes where session_id=${f.session}`;
    await f.db`update allrice_conversation_runtimes set thread_id=${checkpoint.sessionId},active_turn_id=${checkpoint.turnId} where session_id=${f.session}`;
    await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy) values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    await f.db`insert into allrice_task_questions(run_id,question_id,pending) values(${f.rootRunId},${checkpoint.questionId},true)`;
    await f.db.begin((tx) => refreshTaskClock(tx, f.rootRunId));
    const owner = {
      context: f.context,
      worker: f.worker,
      configChecksum: runtime!.config_checksum,
      generation: runtime!.thread_generation,
    };
    if (withStopReceipt)
      await bindJobNativeSession({
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: runtime!.config_checksum,
          generation: runtime!.thread_generation,
          expectedThreadId: checkpoint.sessionId,
        },
        descriptor: nativeBindingDescriptor({
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          contextKey: f.session,
          distributionGeneration: newNativeGeneration,
        }),
      });
    const stopReceipt = withStopReceipt
      ? await beginNativeTaskWithStopReceipt({
          ...owner,
          attempt: 1,
          sessionId: f.session,
        })
      : null;
    if (stopReceipt) expect(stopReceipt.started).toBe(true);
    else expect(await beginNativeTask({ ...owner, attempt: 1 })).toBe(true);
    return { f, checkpoint, owner, stopReceipt };
  }

  async function stoppedSegment() {
    const s = await setup(true);
    if (!s.stopReceipt?.started)
      throw Error('expected authorized native segment');
    return {
      ...s,
      stopReceipt: s.stopReceipt,
      closed: {
        nativeSessionId: s.checkpoint.sessionId,
        runtimeId: randomUUID(),
      },
    };
  }
  async function cancelSegment(s: Awaited<ReturnType<typeof stoppedSegment>>) {
    await cancelRun(s.f.requestContext, s.f.workspace, s.f.rootRunId, {
      reason: 'exact synthetic native stop',
    });
  }
  async function dispatchState(s: Awaited<ReturnType<typeof stoppedSegment>>) {
    return (
      await s.f
        .db`select state from allrice_native_task_dispatches where run_id=${s.f.rootRunId} and attempt=1`
    )[0]!.state;
  }

  it('settles only the confirmed canceled native segment without changing Run/Job or model usage', async () => {
    const s = await stoppedSegment();
    const callId = randomUUID();
    await createTaskProgressRuntime({
      context: s.f.context,
      worker: s.f.worker,
    })({
      action: 'start',
      kind: 'model',
      nativeSessionId: s.closed.nativeSessionId,
      callId,
    });
    await cancelSegment(s);
    const before = await s.f
      .db`select to_jsonb(j) value from allrice_jobs j where id=${s.f.worker.jobId}`;
    expect(await s.stopReceipt.confirmStopped(s.closed)).toEqual({
      completed: true,
      reused: false,
    });
    expect(await dispatchState(s)).toBe('completed');
    expect(
      await s.f
        .db`select to_jsonb(j) value from allrice_jobs j where id=${s.f.worker.jobId}`,
    ).toEqual(before);
    expect(
      (
        await s.f
          .db`select finished_at from allrice_task_calls where run_id=${s.f.rootRunId} and call_id=${callId}`
      )[0]!.finished_at,
    ).toBeNull();
    expect(await s.stopReceipt.confirmStopped(s.closed)).toEqual({
      completed: true,
      reused: false,
    });
    expect(
      (
        await s.f
          .db`select count(*)::int n from allrice_audit_events where resource_id=${s.f.rootRunId} and action='native_task.dispatch.stop_confirmed'`
      )[0]!.n,
    ).toBe(1);
    expect(() =>
      s.stopReceipt.confirmStopped({ ...s.closed, runtimeId: randomUUID() }),
    ).toThrow('native_stop_instance_changed');
  });

  it('accepts only the original minted receipt after terminal cancellation released the lease', async () => {
    const s = await stoppedSegment();
    await cancelSegment(s);
    await finishJobDrain({ ...s.f.worker });
    const before = await s.f
      .db`select to_jsonb(j) value from allrice_jobs j where id=${s.f.worker.jobId}`;
    expect(before[0]!.value).toMatchObject({
      status: 'canceled',
      worker_id: null,
      lease_token: null,
    });
    expect(await s.stopReceipt.confirmStopped(s.closed)).toMatchObject({
      completed: true,
    });
    expect(
      await s.f
        .db`select to_jsonb(j) value from allrice_jobs j where id=${s.f.worker.jobId}`,
    ).toEqual(before);
    await expect(
      beginNativeTaskWithStopReceipt({
        ...s.owner,
        attempt: 1,
        sessionId: s.f.session,
      }),
    ).rejects.toThrow('native_wait_lease_lost');
    expect(JSON.parse(JSON.stringify(s.stopReceipt))).toEqual({
      started: true,
    });
  });

  it('does not turn a noncancel failure into a completed/replayable native dispatch', async () => {
    const s = await stoppedSegment();
    await expect(s.stopReceipt.confirmStopped(s.closed)).rejects.toThrow(
      'native_stop_cancellation_changed',
    );
    expect(await dispatchState(s)).toBe('started');
    expect(await beginNativeTask({ ...s.owner, attempt: 1 })).toBe(false);
  });

  it('rejects another native session and never retries that unknown receipt write', async () => {
    const s = await stoppedSegment();
    await cancelSegment(s);
    const foreign = { ...s.closed, nativeSessionId: 'dsh-' + randomUUID() };
    const first = s.stopReceipt.confirmStopped(foreign);
    await expect(first).rejects.toThrow('native_stop_binding_changed');
    expect(s.stopReceipt.confirmStopped(foreign)).toBe(first);
    expect(() => s.stopReceipt.confirmStopped(s.closed)).toThrow(
      'native_stop_instance_changed',
    );
    expect(await dispatchState(s)).toBe('started');
  });

  it('rejects a replaced lease or attempt while preserving the original started intent', async () => {
    const s = await stoppedSegment();
    await cancelSegment(s);
    await s.f
      .db`update allrice_jobs set lease_token=${randomUUID()} where id=${s.f.worker.jobId}`;
    await expect(s.stopReceipt.confirmStopped(s.closed)).rejects.toThrow(
      'native_stop_incarnation_changed',
    );
    expect(await dispatchState(s)).toBe('started');
    const next = await stoppedSegment();
    await cancelSegment(next);
    await next.f
      .db`update allrice_jobs set attempt=2 where id=${next.f.worker.jobId}`;
    await expect(next.stopReceipt.confirmStopped(next.closed)).rejects.toThrow(
      'native_stop_cancellation_changed',
    );
    expect(await dispatchState(next)).toBe('started');
  });

  it('records an original stop after revocation without granting new execution authority', async () => {
    const s = await stoppedSegment();
    await cancelSegment(s);
    await finishJobDrain({ ...s.f.worker });
    await s.f
      .db`update allrice_memberships set active=false where id=${s.f.membership}`;
    expect(await s.stopReceipt.confirmStopped(s.closed)).toMatchObject({
      completed: true,
    });
    await expect(
      beginNativeTaskWithStopReceipt({
        ...s.owner,
        attempt: 1,
        sessionId: s.f.session,
      }),
    ).rejects.toThrow();
    expect(
      (
        await s.f
          .db`select status,worker_id,lease_token from allrice_jobs where id=${s.f.worker.jobId}`
      )[0],
    ).toMatchObject({ status: 'canceled', worker_id: null, lease_token: null });
  });

  it('cannot complete a timed-out attempt using a cancellation stop receipt', async () => {
    const s = await stoppedSegment();
    // The real clock refresh owns Job.timeout_at. Exhaust its original frozen
    // policy instead of fabricating a deadline that refresh would overwrite.
    const [clock] = await s.f
      .db`select policy from allrice_task_clocks where run_id=${s.f.rootRunId}`;
    expect(clock!.policy.timeoutMs).toBeGreaterThan(0);
    await s.f
      .db`update allrice_task_clocks set active_ms=${clock!.policy.timeoutMs + 1} where run_id=${s.f.rootRunId}`;
    const stopped = await heartbeatJob(
      s.f.worker.workerId,
      s.f.worker.jobId,
      s.f.worker.leaseToken,
      30000,
    );
    expect(stopped).toMatchObject({ active: false, canceled: false });
    expect(
      (
        await s.f
          .db`select drain_reason from allrice_jobs where id=${s.f.worker.jobId}`
      )[0]!.drain_reason,
    ).toBe('timeout');
    await expect(s.stopReceipt.confirmStopped(s.closed)).rejects.toThrow(
      'native_stop_cancellation_changed',
    );
    expect(await dispatchState(s)).toBe('started');
  });

  it('keeps the parked question continuation separate from a closed canceled dispatch', async () => {
    const s = await stoppedSegment();
    await parkNativeQuestion({ ...s.owner, checkpoint: s.checkpoint });
    await cancelSegment(s);
    await maintainQueue();
    const [job] = await s.f
      .db`select status,worker_id,lease_token,drain_reason,cancel_requested_at from allrice_jobs where id=${s.f.worker.jobId}`;
    expect(job).toMatchObject({
      status: 'canceled',
      worker_id: null,
      lease_token: null,
      drain_reason: null,
    });
    expect(job!.cancel_requested_at).not.toBeNull();
    const waits = await s.f
      .db`select to_jsonb(w) value from allrice_native_question_waits w where run_id=${s.f.rootRunId}`;
    // Parking already released execution authority; normal cancellation has no
    // running receipt drain. That earlier fence must reject this stale port.
    await expect(s.stopReceipt.confirmStopped(s.closed)).rejects.toThrow(
      'native_stop_cancellation_changed',
    );
    expect(await dispatchState(s)).toBe('parked');
    expect(
      await s.f
        .db`select to_jsonb(w) value from allrice_native_question_waits w where run_id=${s.f.rootRunId}`,
    ).toEqual(waits);
    expect(
      (
        await s.f
          .db`select count(*)::int n from allrice_audit_events where resource_id=${s.f.rootRunId} and action='native_task.dispatch.stop_confirmed'`
      )[0]!.n,
    ).toBe(0);
  });

  it('cannot mint a stop port for a foreign source session or execution scope', async () => {
    const s = await stoppedSegment();
    await expect(
      beginNativeTaskWithStopReceipt({
        ...s.owner,
        attempt: 1,
        sessionId: randomUUID(),
      }),
    ).rejects.toThrow('native_stop_attempt_changed');
    for (const context of [
      { ...s.f.context, organizationId: randomUUID() },
      { ...s.f.context, workspaceId: randomUUID() },
    ])
      await expect(
        beginNativeTaskWithStopReceipt({
          context,
          worker: s.f.worker,
          attempt: 1,
          sessionId: s.f.session,
        }),
      ).rejects.toThrow('native_wait_lease_lost');
    await expect(
      beginNativeTaskWithStopReceipt({
        ...s.owner,
        worker: { ...s.f.worker, jobId: randomUUID() },
        attempt: 1,
        sessionId: s.f.session,
      }),
    ).rejects.toThrow('native_wait_lease_lost');
    expect(await dispatchState(s)).toBe('started');
  });
  it('parks without a lease, wakes only for the exact typed answer and rejects the previous owner', async () => {
    const { f, checkpoint, owner } = await setup();
    await parkNativeQuestion({ ...owner, checkpoint });
    const [job] =
      await f.db`select status,worker_id,lease_token from allrice_jobs where id=${f.worker.jobId}`;
    expect(job).toMatchObject({
      status: 'waiting_approval',
      worker_id: null,
      lease_token: null,
    });
    await f.db`update allrice_task_clocks set active_ms=12345,changed_at=clock_timestamp()-interval '40 minutes' where run_id=${f.rootRunId}`;
    await maintainQueue();
    expect(await claimNextJob(randomUUID(), 30000)).toBeNull();
    async function submit(questionId: string) {
      const userMessage = randomUUID(),
        assistantMessage = randomUUID(),
        inputId = randomUUID();
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${userMessage},${f.org},${f.workspace},${f.session},${f.user},'user','{}'),(${assistantMessage},${f.org},${f.workspace},${f.session},${f.user},'assistant','{}')`;
      await enqueueRun(
        f.requestContext,
        {
          workspaceId: f.workspace,
          type: 'allrice.employee.run',
          input: {},
          idempotencyKey: randomUUID(),
          timeoutMs: 3600000,
        },
        {
          conversationDelivery: {
            sessionId: f.session,
            userMessageId: userMessage,
            assistantMessageId: assistantMessage,
            clientUserMessageId: inputId,
            message: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [{ id: 'choice', selected: ['Continue'] }] })}`,
            requestedMode: 'steer',
            expectedTurnId: checkpoint.turnId,
            expectedGeneration: owner.generation,
            hasAttachments: false,
          },
        },
      );
    }
    await submit('question-stale');
    await maintainQueue();
    expect(await claimNextJob(randomUUID(), 30000)).toBeNull();
    expect(
      await f.db`select state,error_code from allrice_conversation_commands where session_id=${f.session}`,
    ).toMatchObject([
      { state: 'rejected', error_code: 'QUESTION_ANSWER_INVALID' },
    ]);
    // MET-223: the answer itself announces work, so an idle Worker resumes
    // the parked Run now; the placeholder's own announcement is 24 h out.
    const announced: string[] = [];
    const subscription = await f.db.listen(JOB_READY_CHANNEL, (payload) =>
      announced.push(payload),
    );
    await submit(checkpoint.questionId);
    await vi.waitFor(() => expect(announced).toContain(''));
    await subscription.unlisten();
    await maintainQueue();
    await maintainQueue();
    const replacement = randomUUID(),
      claimed = await claimNextJob(replacement, 30000);
    expect(claimed?.id).toBe(f.worker.jobId);
    const execution = await startClaimedJob(
      replacement,
      claimed!.id,
      claimed!.lease!.token,
    );
    const next = {
      context: execution!.context,
      worker: {
        ...owner.worker,
        workerId: replacement,
        leaseToken: claimed!.lease!.token,
      },
      configChecksum: owner.configChecksum,
      generation: owner.generation,
    };
    await acquireConversationRuntime({
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      runId: f.rootRunId,
      workerId: replacement,
      ownerId: f.user,
      configChecksum: owner.configChecksum,
      compactThresholdTokens: 40000,
    });
    expect(await readNativeQuestionWait(next)).toEqual(checkpoint);
    await f.db`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(readNativeQuestionWait(next)).rejects.toThrow(
      'native_wait_authority_changed',
    );
    await f.db`update allrice_memberships set active=true where id=${f.membership}`;
    expect(await beginNativeTask({ ...next, attempt: claimed!.attempt })).toBe(
      true,
    );
    const clock = await f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
    expect(clock!.activeMs).toBe(12345);
    expect(clock!.waitingMs).toBeGreaterThanOrEqual(2400000);
    await expect(
      heartbeatJob(
        owner.worker.workerId,
        owner.worker.jobId,
        owner.worker.leaseToken,
        30000,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      continueNativeQuestion({ ...owner, questionId: checkpoint.questionId }),
    ).rejects.toThrow('native_wait_lease_lost');
    await expect(
      readNativeQuestionWait({ ...next, configChecksum: 'changed' }),
    ).rejects.toThrow('native_wait_configuration_changed');
    await continueNativeQuestion({
      ...next,
      questionId: checkpoint.questionId,
    });
    await expect(
      continueNativeQuestion({ ...next, questionId: checkpoint.questionId }),
    ).rejects.toThrow('native_wait_already_continued');
    // A resumed dispatch with no checkpoint cannot be run a second time.
    expect(
      await beginNativeTask({ ...next, attempt: claimed!.attempt + 1 }),
    ).toBe(false);
    await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
      reason: 'synthetic cleanup',
    });
    await maintainQueue();
  });
  it('MET-210: a skipped item from the chat answers a parked question and wakes the original Run', async () => {
    const { f, checkpoint, owner } = await setup();
    await parkNativeQuestion({ ...owner, checkpoint });
    const context = await authenticateSession(
      (await createSession(f.user)).token,
      { organizationId: f.org, workspaceId: f.workspace },
    );
    if (!context) throw Error('fixture_login');
    // The chat page sends "跳过本题" as DSH's skipped item: { id, selected: [] }.
    await sendChatMessage(context, f.workspace, f.session, {
      clientMessageId: randomUUID(),
      text: 'Continue?：跳过',
      deliveryMode: 'steer',
      expectedTurnId: checkpoint.turnId,
      expectedGeneration: owner.generation,
      userQuestionAnswer: {
        questionId: checkpoint.questionId,
        answers: [{ id: 'choice', selected: [] }],
      },
    });
    await maintainQueue();
    await maintainQueue();
    expect(
      await f.db`select state,input_kind from allrice_conversation_commands where session_id=${f.session}`,
    ).toEqual([{ state: 'pending', input_kind: 'ask_user' }]);
    const replacement = randomUUID(),
      claimed = await claimNextJob(replacement, 30000);
    expect(claimed?.id).toBe(f.worker.jobId);
    // The same steps the employee Worker takes to resume this Run. The native
    // adoption of the skipped item itself is covered by the p25 native tests.
    const execution = await startClaimedJob(
      replacement,
      claimed!.id,
      claimed!.lease!.token,
    );
    const next = {
      context: execution!.context,
      worker: {
        ...owner.worker,
        workerId: replacement,
        leaseToken: claimed!.lease!.token,
      },
      configChecksum: owner.configChecksum,
      generation: owner.generation,
    };
    await acquireConversationRuntime({
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      runId: f.rootRunId,
      workerId: replacement,
      ownerId: f.user,
      configChecksum: owner.configChecksum,
      compactThresholdTokens: 40000,
    });
    expect(await readNativeQuestionWait(next)).toEqual(checkpoint);
    const command = await claimConversationSteer({
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      workerId: replacement,
      generation: owner.generation,
      turnId: checkpoint.turnId,
    });
    expect(command).toMatchObject({ inputKind: 'ask_user' });
    expect(JSON.parse(command!.message.split(':v1:')[1]!)).toEqual({
      questionId: checkpoint.questionId,
      answers: [{ id: 'choice', selected: [] }],
    });
    expect(await beginNativeTask({ ...next, attempt: claimed!.attempt })).toBe(
      true,
    );
    await consumeConversationSteer({
      commandId: command!.id,
      workerId: replacement,
      proof: {
        status: 'adopted',
        inputId: command!.clientUserMessageId,
        messageId: checkpoint.questionId,
        sequence: checkpoint.sequence + 1,
        turnId: checkpoint.turnId,
        checkpoint: 'question_resolved',
      },
    });
    await continueNativeQuestion({
      ...next,
      questionId: checkpoint.questionId,
    });
    expect(
      await f.db`select state from allrice_conversation_commands where session_id=${f.session}`,
    ).toEqual([{ state: 'consumed' }]);
    expect(
      await f.db`select pending from allrice_task_questions where run_id=${f.rootRunId} and question_id=${checkpoint.questionId}`,
    ).toEqual([{ pending: false }]);
    expect(
      await f.db`select state,error_code from allrice_runs where id=${command!.followupRunId}`,
    ).toEqual([{ state: 'canceled', error_code: 'STEER_CONSUMED' }]);
    await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
      reason: 'synthetic cleanup',
    });
    await maintainQueue();
  });
  it('does not release a host with an unknown in-flight call', async () => {
    const { f, checkpoint, owner } = await setup();
    await f.db`insert into allrice_task_calls(run_id,native_session_id,call_id,kind) values(${f.rootRunId},${checkpoint.sessionId},'unknown','model')`;
    await expect(parkNativeQuestion({ ...owner, checkpoint })).rejects.toThrow(
      'native_wait_not_quiescent',
    );
    await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
      reason: 'synthetic cleanup',
    });
    await maintainQueue();
  });
  it('cancels a parked Run through queue maintenance with no native process', async () => {
    const { f, checkpoint, owner } = await setup();
    await parkNativeQuestion({ ...owner, checkpoint });
    await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
      reason: 'user requested',
    });
    await maintainQueue();
    const [job] =
      await f.db`select status from allrice_jobs where id=${f.worker.jobId}`;
    expect(job!.status).toBe('canceled');
    expect(
      (await f.db.begin((tx) => readTaskClock(tx, f.rootRunId)))!.phase,
    ).toBe('terminal');
    // MET-210: a stopped Run's question can no longer be answered.
    expect(
      await f.db`select pending from allrice_task_questions where run_id=${f.rootRunId}`,
    ).toEqual([{ pending: false }]);
  });
  it('MET-210: stopping a Run that is waiting live on a question clears it', async () => {
    const { f } = await setup();
    expect(
      await f.db`select pending from allrice_task_questions where run_id=${f.rootRunId}`,
    ).toEqual([{ pending: true }]);
    await cancelRun(f.requestContext, f.workspace, f.rootRunId, {
      reason: 'user requested',
    });
    await finishJobDrain({ ...f.worker });
    expect(
      await f.db`select state from allrice_runs where id=${f.rootRunId}`,
    ).toEqual([{ state: 'canceled' }]);
    expect(
      await f.db`select pending from allrice_task_questions where run_id=${f.rootRunId}`,
    ).toEqual([{ pending: false }]);
  });
  it('cannot revive a native parked question by restoring its archived employee instance', async () => {
    const { f, checkpoint, owner } = await setup();
    await ensureGeneralEmployeeInstance(f.db, f.assignment);
    const context = await authenticateSession(
      (await createSession(f.user)).token,
      { organizationId: f.org, workspaceId: f.workspace },
    );
    if (!context) throw Error('fixture_login');
    await parkNativeQuestion({ ...owner, checkpoint });
    await changeEmployeeInstanceLifecycle(context, f.assignment, {
      workspaceId: f.workspace,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    });
    await changeEmployeeInstanceLifecycle(context, f.assignment, {
      workspaceId: f.workspace,
      requestId: randomUUID(),
      expectedRevision: 2,
      operation: 'restore',
      sourceRevision: 1,
    });
    const [job] =
      await f.db`select cancel_requested_at from allrice_jobs where run_id=${f.rootRunId}`;
    expect(job!.cancel_requested_at).not.toBeNull();
    await maintainQueue();
    expect(
      (
        await f.db`select status from allrice_jobs where id=${f.worker.jobId}`
      )[0]!.status,
    ).toBe('canceled');
    expect(await claimNextJob(randomUUID(), 30000)).toBeNull();
  });
});
