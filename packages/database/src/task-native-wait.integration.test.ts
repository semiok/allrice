import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import * as client from './core/client.ts';
import {
  parkNativeQuestion,
  readNativeQuestionWait,
  beginNativeTask,
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
} from './execution/queue.ts';
import { acquireConversationRuntime } from './conversation/conversation-runtime.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET153 durable native waits and queue authority', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  async function setup() {
    const f = await createAssistantLocalCommandFixture(
      fixture.db,
      'ask',
      false,
      { skipChild: true, deferRuntimeRoot: true },
    );
    f.requestContext.memberships = f.context.policySnapshot.memberships;
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
    expect(await beginNativeTask({ ...owner, attempt: 1 })).toBe(true);
    return { f, checkpoint, owner };
  }
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
    await submit(checkpoint.questionId);
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
  });
});
