import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createExperienceFixture } from '../../../../packages/database/src/experience.fixture.ts';
import { bindNativeQuestionFixture } from '../../../../packages/database/src/native-question-binding.fixture.ts';
import * as database from '../../../../packages/database/src/core/client.ts';
import { sendChatMessage } from '../../../../packages/database/src/workspace/service.ts';
import { updateNativeQuestionMode } from '../../../../packages/database/src/native-questions.ts';
import { prepareNativeQuestionReply } from '../../../../packages/database/src/native-question-replies.ts';
import { claimNextJob } from '../../../../packages/database/src/execution/queue.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
} from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import { getSessionRunTimings } from '../../../../packages/database/src/conversation/interaction-status.ts';
import { runClaimedJob } from '../../src/job-runner.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.js';
import { pollEmployeeConversationSteers } from '../../src/conversation/turn-lifecycle.js';
import { HandlerError } from '../../src/errors.js';
import {
  hasCheckedNativeQuestionReceipt,
  requireCheckedFinalDelivery,
  transferCheckedFinalDeliveryForExecution,
} from '../../src/final-delivery/checked-delivery.js';
import { p24Fixture } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'PR5 chat entry → durable FIFO → Worker → native question adoption',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(database, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });

    it.each([
      'warm',
      'cold',
      'fifo',
      'duplicate',
      'different',
      'closing',
      'delayed-projection',
      'ack-lost',
    ] as const)(
      'adopts a late skipped answer in a %s Host without prompting the answer JSON',
      async (phase) => {
        const f = await createExperienceFixture(fixture.db);
        await updateNativeQuestionMode(f.reviewer, 'timed');
        const model = await p24Fixture(async (_request, index) =>
          index === 1
            ? {
                nativeTool: {
                  name: 'ask_user_question',
                  arguments: {
                    questions: [
                      {
                        id: 'choice',
                        question: '先做哪项？',
                        options: [{ label: 'A' }, { label: 'B' }],
                      },
                    ],
                    timeout: 1,
                  },
                },
              }
            : { text: '已按原生输入继续。' },
        );
        const makeAdapter = () =>
          new DshHarnessAdapter({
            runtimeRoot: join(model.root, 'runtime'),
            credentialResolver: {
              resolve: async () => ({ apiKey: 'synthetic-only' }),
            },
          });
        let adapter = makeAdapter();
        let nativeTurns = 0;
        let holdRoot = phase === 'closing';
        let holdProjection = false;
        let rootReturned!: () => void, releaseRoot!: () => void;
        let projectionHeld!: () => void, releaseProjection!: () => void;
        const rootReady = new Promise<void>((r) => {
          rootReturned = r;
        });
        const rootGate = new Promise<void>((r) => {
          releaseRoot = r;
        });
        const projectionReady = new Promise<void>((r) => {
          projectionHeld = r;
        });
        const projectionGate = new Promise<void>((r) => {
          releaseProjection = r;
        });
        const prompts = vi.spyOn(DshProtocolClient.prototype, 'prompt');
        const typedReply = DshProtocolClient.prototype.typedQuestionReply;
        const lostAck =
          phase === 'ack-lost'
            ? vi
                .spyOn(DshProtocolClient.prototype, 'typedQuestionReply')
                .mockImplementationOnce(async function (
                  this: DshProtocolClient,
                  ...args
                ) {
                  await typedReply.apply(this, args);
                  throw new HandlerError(
                    'DSH_REQUEST_TIMEOUT',
                    'Synthetic lost ACK',
                    false,
                  );
                })
            : undefined;
        const send = (
          text: string,
          answer?: {
            questionId: string;
            answers: { id: string; selected: string[] }[];
          },
        ) =>
          sendChatMessage(f.owner, f.workspace, f.session.id, {
            clientMessageId: randomUUID(),
            text,
            ...(answer
              ? { userQuestionAnswer: answer }
              : { deliveryMode: 'follow_up' }),
          });
        const executeNext = async (expectedJobId: string) => {
          const workerId = randomUUID();
          const job = await claimNextJob(workerId, 120000);
          expect(job?.id).toBe(expectedJobId);
          expect(job?.lease).toBeTruthy();
          await runClaimedJob(
            {
              workerId,
              jobId: job!.id,
              leaseToken: job!.lease!.token,
              leaseMs: 120000,
              heartbeatMs: 1000,
              executionRoot: join(model.root, 'jobs'),
              stopping: () => false,
              onAbortReady() {},
            },
            async ({
              execution,
              workflowLease,
              isolation,
              signal,
              onHarnessEvent,
            }) => {
              const ownership = {
                organizationId: f.org,
                workspaceId: f.workspace,
                sessionId: f.session.id,
                runId: execution.context.runId,
                workerId,
              };
              let runtime = await acquireConversationRuntime({
                ...ownership,
                ownerId: f.user,
                configChecksum: `sha256:${'a'.repeat(64)}`,
                compactThresholdTokens: 40000,
              });
              const reply = await prepareNativeQuestionReply({
                context: execution.context,
                worker: workflowLease,
                sessionId: f.session.id,
              });
              const [source] =
                await fixture.db`select e.*,m.content->>'text' as text from allrice_employee_runs e
          join allrice_messages m on m.id=e.user_message_id where e.run_id=${execution.context.runId}`;
              const result = await adapter.execute({
                nativeQuestionMode: 'timed',
                questionReply: reply,
                kernel: {
                  schemaVersion: 1,
                  harness: 'dsh',
                  employeeAssignmentId: source!.employee_assignment_id,
                  employeeVersionId: source!.employee_version_id,
                  sessionId: f.session.id,
                  userMessageId: source!.user_message_id,
                  assistantMessageId: source!.assistant_message_id,
                  systemInstructions:
                    'Synthetic question reply Worker fixture.',
                  userRequest: source!.text,
                  bootstrapConversation: '',
                  authorizedMemoryContext: '',
                  grantedCapabilities: ['model:invoke'],
                  skillVersionIds: [],
                  imageAttachments: [],
                },
                providerSnapshot: {
                  provider: 'dsh',
                  authMode: 'allrice_credential',
                  route: 'openai-compatible',
                  model: 'native-question',
                  reasoningEffort: 'low',
                  credentialReference: 'synthetic-only',
                  baseUrl: model.baseUrl,
                },
                storageObjects: [],
                tools: [],
                workDirectory: isolation.workDirectory,
                executionEnvironment: isolation.environment,
                signal,
                attempt: execution.job.attempt,
                generation: runtime.generation,
                threadId: runtime.threadId,
                onEvent: async (event) => {
                  if (
                    holdProjection &&
                    event.type === 'native.event' &&
                    event.sourceEventType === 'session/user-questions' &&
                    Array.isArray(
                      (
                        event.sourcePayload as {
                          questions?: { settled?: unknown[] };
                        }
                      )?.questions?.settled,
                    ) &&
                    (
                      event.sourcePayload as {
                        questions: { settled: unknown[] };
                      }
                    ).questions.settled.length > 0
                  ) {
                    holdProjection = false;
                    projectionHeld();
                    await projectionGate;
                  }
                  await onHarnessEvent(event);
                },
                onThreadBound: async (bound) => {
                  await bindNativeQuestionFixture(
                    fixture.db,
                    execution.context.runId,
                    bound.threadId,
                  );
                  runtime = await bindConversationThread({
                    ...ownership,
                    ...bound,
                  });
                  return { generation: runtime.generation };
                },
                onTurnStarted: async (turn) => {
                  nativeTurns++;
                  runtime = await recordConversationTurn({
                    ...ownership,
                    ...turn,
                  });
                },
              });
              if (holdRoot) {
                holdRoot = false;
                rootReturned();
                await rootGate;
              }
              if (hasCheckedNativeQuestionReceipt(result)) {
                requireCheckedFinalDelivery(workflowLease);
                transferCheckedFinalDeliveryForExecution(
                  workflowLease,
                  result,
                  result,
                );
              }
              return result;
            },
          );
          const [run] =
            await fixture.db`select r.state,r.result,j.status,j.lease_token from allrice_runs r
        join allrice_jobs j on j.run_id=r.id where j.id=${job!.id}`;
          expect(run).toMatchObject({
            state: 'succeeded',
            status: 'succeeded',
            lease_token: null,
          });
          return run!;
        };
        try {
          const initial = await send(
            '先问我需要决定的地方，其他内容继续完成。',
          );
          const initialExecution = executeNext(initial.run.job.id);
          if (phase === 'closing') await rootReady;
          else await initialExecution;
          const [q] =
            await fixture.db`select * from allrice_native_questions where session_id=${f.session.id}`;
          expect(q).toMatchObject({
            state: 'continued',
            closed_at: null,
            source_run_id: initial.run.id,
          });
          if (phase === 'cold') {
            await adapter.close();
            adapter = makeAdapter();
          }
          const ordinary =
            phase === 'fifo'
              ? await send('先处理我刚发的另一个要求。')
              : undefined;
          const answer = {
            questionId: `${q!.native_session_id}:${q!.call_id}`,
            answers: [{ id: 'choice', selected: [] }],
          };
          const sent = await send('跳过本题', answer);
          const replyRunId = sent.fallbackRunId ?? sent.run.id;
          const [replyJob] =
            await fixture.db`select id from allrice_jobs where run_id=${replyRunId}`;
          if (phase === 'closing') {
            expect(sent.delivery).toBe('steer_pending');
            const [runtime] =
              await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session.id}`;
            await pollEmployeeConversationSteers({
              ownership: {
                organizationId: f.org,
                workspaceId: f.workspace,
                sessionId: f.session.id,
                runId: initial.run.id,
                workerId: runtime!.worker_id,
              },
              generation: runtime!.thread_generation,
              threadId: runtime!.thread_id,
              turnId: runtime!.active_turn_id,
              signal: new AbortController().signal,
              adapter,
              polling: () => false,
              drain: true,
            });
            expect(
              await fixture.db`select state from allrice_conversation_commands where followup_run_id=${replyRunId}`,
            ).toEqual([{ state: 'pending' }]);
            releaseRoot();
            await initialExecution;
          }
          const repeated =
            phase === 'duplicate' || phase === 'different'
              ? await send('另一份回答', {
                  ...answer,
                  answers: [
                    {
                      id: 'choice',
                      selected: phase === 'different' ? ['B'] : [],
                    },
                  ],
                })
              : undefined;
          if (ordinary) await executeNext(ordinary.run.job.id);
          const promptCount = prompts.mock.calls.length;
          holdProjection = phase === 'delayed-projection';
          const replyExecution = executeNext(replyJob!.id);
          if (phase === 'delayed-projection') {
            await projectionReady;
            expect(
              await fixture.db`select c.state,c.native_proof,r.state as run_state
              from allrice_conversation_commands c join allrice_runs r on r.id=c.followup_run_id
              where c.followup_run_id=${replyRunId}`,
            ).toEqual([
              { state: 'claimed', native_proof: null, run_state: 'running' },
            ]);
            releaseProjection();
          }
          await replyExecution;
          expect(prompts.mock.calls.length).toBe(promptCount);
          const [command] =
            await fixture.db`select state,native_proof from allrice_conversation_commands where followup_run_id=${replyRunId}`;
          expect(command).toMatchObject({
            state: 'consumed',
            native_proof: {
              status: 'adopted',
              callId: q!.call_id,
              messageId: answer.questionId,
              checkpoint: 'question_replied',
            },
          });
          expect(
            await fixture.db`select state,answers,source_run_id from allrice_native_questions where session_id=${f.session.id}`,
          ).toMatchObject([
            {
              state: 'settled',
              answers: answer.answers,
              source_run_id: initial.run.id,
            },
          ]);
          const status = await getSessionRunTimings(
            f.owner,
            f.session.id,
            fixture.db,
            { inputs: true },
          );
          expect(
            status.inputs?.find((i) => i.runId === replyRunId),
          ).toMatchObject({
            status: 'adopted',
            kind: 'ask_user',
            evidence: { checkpoint: 'question_replied' },
          });
          if (repeated) {
            const turnsBeforeReceipt = nativeTurns;
            const receipt = await executeNext(repeated.run.job.id);
            expect(receipt.result.answer).toContain(
              phase === 'different' ? '没有被采用' : '已经回答过',
            );
            expect(
              await fixture.db`select state from allrice_conversation_commands where followup_run_id=${repeated.run.id}`,
            ).toEqual([
              { state: phase === 'different' ? 'rejected' : 'consumed' },
            ]);
            expect(prompts.mock.calls.length).toBe(promptCount);
            expect(nativeTurns).toBe(turnsBeforeReceipt);
            expect(receipt.result.usageComplete).toBe(true);
            expect(Object.values(receipt.result.usage)).toEqual(
              expect.arrayContaining([0]),
            );
            expect(
              Object.values(receipt.result.usage).every((n) => n === 0),
            ).toBe(true);
          }
          expect(
            model.requests
              .at(-1)
              ?.messages.filter(
                (message) =>
                  message.role === 'user' &&
                  JSON.stringify(message.content).includes(
                    'answer_to_pending_question',
                  ) &&
                  JSON.stringify(message.content).includes(q!.call_id),
              ),
          ).toHaveLength(1);
        } finally {
          releaseRoot();
          releaseProjection();
          lostAck?.mockRestore();
          prompts.mockRestore();
          await adapter.close();
          await model.close();
        }
      },
      60000,
    );
  },
);
