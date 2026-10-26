/** Native question/checkpoint safety; actual DSH and local HTTP model, no SQL. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { NativeQuestionCheckpoint } from '@allrice/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../../src/harness/adapter.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import type { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.js';
import { NativeQuestionParked } from '../../src/harness/dsh/native-question-wait.js';
import { p24Fixture, gate } from '../p24/fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// MET-210: "跳过本题" is DSH's skipped item { id, selected: [] }. A live
// question is the path for members with assistants on (they never park).
it.each([
  ['live', 'chosen'],
  ['live', 'skipped'],
  ['parked', 'chosen'],
  ['parked', 'skipped'],
] as const)(
  'preserves an unanswered %s question across overdue sweeps and adopts a %s answer once',
  async (phase, reply) => {
    const answerItem =
      reply === 'skipped'
        ? { id: 'choice', selected: [] }
        : { id: 'choice', selected: ['继续'] };
    const model = await p24Fixture(async (_request, index) =>
      index === 1
        ? {
            nativeTool: {
              name: 'ask_user_question',
              arguments: {
                questions: [
                  {
                    id: 'choice',
                    question: '继续这项工作？',
                    options: [{ label: '继续' }],
                  },
                ],
              },
            },
          }
        : { text: 'Synthetic continuation.' },
    );
    vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
    const adapter = new DshHarnessAdapter({
      runtimeRoot: join(model.root, 'runtime'),
      idleCloseMs: 60_000,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-only' }),
      },
      requestTimeoutMs: 15_000,
    });
    const pool = Reflect.get(adapter, 'runtimePool') as DshRuntimePool;
    const controller = new AbortController();
    const questionSeen = gate(),
      checkpointSeen = gate(),
      persisted = gate();
    let questionId = '',
      turnId = '';
    let checkpoint: NativeQuestionCheckpoint | undefined;
    const sessionId = randomUUID(),
      threadId = `dsh-${sessionId}`;
    const adopted = vi.fn(async () => {});
    const input: HarnessExecutionInput = {
      kernel: {
        schemaVersion: 1,
        harness: 'dsh',
        sessionId,
        employeeAssignmentId: randomUUID(),
        employeeVersionId: randomUUID(),
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        systemInstructions: 'Ask a question, then continue after the answer.',
        userRequest: '先问我是否继续这项工作。',
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities: ['model:invoke'],
        skillVersionIds: [],
        imageAttachments: [],
      },
      providerSnapshot: {
        provider: 'dsh',
        route: 'openai-compatible',
        authMode: 'allrice_credential',
        model: 'idle-question',
        reasoningEffort: 'low',
        credentialReference: 'test:synthetic',
        baseUrl: model.baseUrl,
      },
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: randomUUID(),
        ALLRICE_WORKSPACE_ID: randomUUID(),
        ALLRICE_OWNER_ID: randomUUID(),
      },
      workDirectory: model.root,
      storageObjects: [],
      tools: [],
      signal: controller.signal,
      attempt: 1,
      generation: 0,
      onTurnStarted: async (value) => {
        turnId = value.turnId;
      },
      onEvent: async (event) => {
        if (event.sourceEventType === 'session/user-question') {
          questionId = String(event.sourcePayload?.questionId);
          questionSeen.release();
        }
      },
      ...(phase === 'parked'
        ? {
            questionWait: {
              adopted,
              park: async (value: NativeQuestionCheckpoint) => {
                checkpoint = value;
                checkpointSeen.release();
                await persisted.promise;
              },
            },
          }
        : {}),
    };
    let execution = adapter.execute(input);
    execution.catch(() => {});
    try {
      await Promise.race([questionSeen.promise, execution]);
      expect(questionId).not.toBe('');
      const original = pool.get(threadId)!;
      expect(original).toBeDefined();
      const close = vi.spyOn(original.client, 'close');
      await pool.reclaimIdle(Date.now() + 86_400_000);
      expect(pool.get(threadId)).toBe(original);
      expect(close).not.toHaveBeenCalled();
      if (phase === 'parked') {
        // Wait for the real 30 s grace timer and the native journal checkpoint.
        // SQL persistence is represented by an explicit acknowledgement gate.
        await Promise.race([checkpointSeen.promise, execution]);
        expect(checkpoint).toMatchObject({
          sessionId: threadId,
          questionId,
          turnId,
        });
        await pool.reclaimIdle(Date.now() + 86_400_000);
        expect(pool.get(threadId)).toBe(original);
        expect(close).not.toHaveBeenCalled();
        persisted.release();
        await expect(execution).rejects.toMatchObject({
          constructor: NativeQuestionParked,
          persisted: true,
        });
        // Parking intentionally closes the Host after persistence. Idle close
        // must not be confused with this existing durable-wait lifecycle.
        expect(close).toHaveBeenCalledOnce();
        expect(adapter.runtimeInventory()).toEqual([]);
        await pool.reclaimIdle(Date.now() + 86_400_000);
        expect(checkpoint).toMatchObject({ questionId, turnId });
        execution = adapter.execute({
          ...input,
          threadId,
          kernel: {
            ...input.kernel,
            userRequest: 'DO_NOT_REPLAY_THE_ORIGINAL_TASK',
          },
          questionWait: {
            adopted,
            park: async () => {
              throw Error('unexpected_second_question');
            },
            resume: {
              sessionId: threadId,
              questionId,
              turnId,
              inputId: randomUUID(),
              text: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [answerItem] })}`,
            },
          },
        });
        execution.catch(() => {});
      } else {
        await expect(
          adapter.steer({
            threadId,
            turnId,
            clientUserMessageId: randomUUID(),
            inputKind: 'ask_user',
            message: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [answerItem] })}`,
          }),
        ).resolves.toMatchObject({
          status: 'adopted',
          checkpoint: 'question_resolved',
        });
      }
      await expect(execution).resolves.toMatchObject({ threadId });
      expect(model.requests).toHaveLength(2);
      const history = JSON.stringify(model.requests[1]!.messages);
      expect(history).toContain('先问我是否继续这项工作。');
      expect(history).toContain('继续');
      // The model receives the skipped item as an empty selection.
      if (reply === 'skipped') expect(history).toMatch(/\\"selected\\":\[\]/);
      expect(history).not.toContain('DO_NOT_REPLAY_THE_ORIGINAL_TASK');
      if (phase === 'parked') {
        expect(adopted).toHaveBeenCalledOnce();
        expect(adopted.mock.calls[0]).toMatchObject([
          { status: 'adopted', checkpoint: 'question_resolved' },
        ]);
        expect(pool.get(threadId)?.id).not.toBe(original.id);
      } else {
        expect(pool.get(threadId)).toBe(original);
      }
    } finally {
      persisted.release();
      controller.abort();
      await adapter.close();
      await execution.catch(() => {});
      await model.close();
    }
  },
  60_000,
);
