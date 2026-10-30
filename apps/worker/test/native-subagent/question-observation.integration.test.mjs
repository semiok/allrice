/* global process, AbortController */
import { randomUUID } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runFixture,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { appendJobEvent } from '../../../../packages/database/src/execution/queue.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { HarnessEventBatcher } from '../../src/harness/delta-batcher.ts';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.ts';
import { p24Fixture, gate } from '../p24/fixture.ts';
import { startExecutionPressureLog } from '../../src/execution-pressure.ts';
import { detectWorkerCapacity } from '../../src/worker-capacity.ts';
import * as Router from '../../src/harness/router.ts';
import { readOperationsInventory } from '../../../../packages/database/src/operations-resources.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'real Host -> current snapshot -> independent WorkerOperations diagnostics',
  () => {
    let dbFixture, model, adapter;
    afterEach(async () => {
      await adapter?.close();
      await model?.close();
      await dbFixture?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it.each([
      'legacy-answer',
      'program-timeout',
      'legacy-answer-write-fault',
      'program-timeout-write-fault',
    ])(
      '%s samples true foreground and recovers diagnostics without affecting the Run',
      async (mode) => {
        dbFixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
        const db = dbFixture.db,
          f = await runFixture(db);
        vi.spyOn(DatabaseClient, 'getDatabase').mockReturnValue(db);
        vi.spyOn(DatabaseClient, 'getDiagnosticsDatabase').mockReturnValue(db);
        vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
        vi.stubEnv('ALLRICE_WORKER_CONCURRENCY', '4');
        const runId = f.task.runId,
          sessionId = randomUUID(),
          threadId = `dsh-${sessionId}`;
        const appeared = gate(),
          resourceEntered = gate(),
          release = gate();
        const login = mode.startsWith('program'),
          fault = mode.endsWith('fault');
        model = await p24Fixture(async (_r, n) =>
          n === 1 || (login && n === 2)
            ? {
                nativeTool: login
                  ? {
                      name: 'cloud_mcp_call',
                      arguments: {
                        action: 'status',
                        connectionId: randomUUID(),
                      },
                    }
                  : {
                      name: 'ask_user_question',
                      arguments: {
                        questions: [
                          {
                            id: 'go',
                            question: '是否继续这项工作？',
                            options: [{ label: '继续' }],
                          },
                        ],
                      },
                    },
              }
            : (resourceEntered.release(),
              await release.promise,
              { text: '已继续完成。' }),
        );
        const root = await realpath(model.root);
        vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'unused-platform'));
        adapter = new DshHarnessAdapter({
          runtimeRoot: join(root, 'runtime'),
          idleCloseMs: 60000,
          credentialResolver: {
            resolve: async () => ({ apiKey: 'synthetic-only' }),
          },
          requestTimeoutMs: 15000,
        });
        let turnId,
          questionId,
          calls = 0;
        const controller = new AbortController();
        const batcher = new HarnessEventBatcher((event) =>
          appendJobEvent({ ...f.worker, ...normalizeHarnessRunEvent(event) }),
        );
        const input = {
          kernel: {
            schemaVersion: 1,
            harness: 'dsh',
            sessionId,
            employeeAssignmentId: randomUUID(),
            employeeVersionId: randomUUID(),
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            systemInstructions: 'Use the requested native tool.',
            userRequest: login ? '连接应用后继续工作。' : '先问我是否继续。',
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
            model: 'foreground-test',
            reasoningEffort: 'low',
            credentialReference: 'test:foreground',
            baseUrl: model.baseUrl,
          },
          executionEnvironment: {
            ALLRICE_ORGANIZATION_ID: f.context.organizationId,
            ALLRICE_WORKSPACE_ID: f.context.workspaceId,
            ALLRICE_OWNER_ID: f.context.actor.id,
            ALLRICE_RUN_ID: runId,
            ALLRICE_JOB_ID: f.worker.jobId,
            ALLRICE_ATTEMPT: '2',
            ALLRICE_ASK_USER_MODE: 'legacy',
            ALLRICE_QUESTION_RELEASE_MS: login ? '1000' : '0',
          },
          workDirectory: root,
          storageObjects: [],
          tools: login
            ? [
                {
                  name: 'cloud.mcp.call',
                  description: 'fixture',
                  inputSchema: {},
                },
              ]
            : [],
          nativeQuestionWait: login
            ? { mode: 'timed', seconds: 1 }
            : { mode: 'default' },
          signal: controller.signal,
          attempt: 2,
          generation: 7,
          onTurnStarted: async (value) => {
            turnId = value.turnId;
          },
          onToolCall: async () => {
            if (++calls === 1)
              return {
                modelContent: JSON.stringify({
                  needsLogin: true,
                  requestId: randomUUID(),
                  connection: { id: randomUUID() },
                  loginPath: '/fixture-login',
                }),
              };
            resourceEntered.release();
            await release.promise;
            return { modelContent: 'resource available' };
          },
          onEvent: async (event) => {
            await batcher.accept(event);
            if (event.sourceEventType === 'session/user-question')
              questionId = event.sourcePayload.questionId;
            if (event.sourceEventType === 'session/user-question')
              appeared.release();
          },
        };
        await db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
        const execution = adapter.execute(input);
        void execution.catch(() => {});
        vi.spyOn(Router, 'getHarnessRouter').mockReturnValue(
          new Router.HarnessRouter([adapter]),
        );
        let tick,
          stop,
          samples = 0;
        const realInterval = globalThis.setInterval;
        vi.spyOn(globalThis, 'setInterval').mockImplementation(
          (callback, ms, ...args) => {
            if (ms === 30_000) tick = callback;
            return realInterval(callback, ms, ...args);
          },
        );
        const workerId = randomUUID(),
          workerBootId = randomUUID();
        const logPath = join(root, 'diagnostics', workerId, 'pressure.jsonl');
        const persisted = async () =>
          (await readOperationsInventory(db)).workers.find(
            (w) => w.workerId === workerId,
          );
        const sampleDone = async () => {
          samples++;
          await expect
            .poll(
              async () =>
                (await readFile(logPath, 'utf8').catch(() => ''))
                  .trim()
                  .split('\n')
                  .filter(Boolean).length,
            )
            .toBe(samples);
          return JSON.parse(
            (await readFile(logPath, 'utf8')).trim().split('\n').at(-1),
          );
        };
        try {
          await Promise.race([appeared.promise, execution]);
          stop = startExecutionPressureLog(
            root,
            workerId,
            detectWorkerCapacity(),
            workerBootId,
          );
          await sampleDone();
          const first = await persisted(),
            item = first.onlineQuestions.executions[0];
          const runtime = Reflect.get(adapter, 'runtimePool').get(threadId);
          expect(first).toMatchObject({
            workerId,
            capacity: { concurrency: 4 },
            onlineQuestions: {
              version: 1,
              workerBootId,
              scope: 'default_harness_router',
            },
          });
          expect(item).toMatchObject({
            runId,
            jobId: f.worker.jobId,
            attempt: 2,
            generation: 7,
            runtimeId: runtime.id,
            rootSessionId: threadId,
            foreground: {
              version: 1,
              sampledAt: expect.any(String),
              complete: true,
              runId,
              rootSessionId: threadId,
              questions: [
                {
                  questionId,
                  runId,
                  nativeSessionId: threadId,
                  rootSessionId: threadId,
                },
              ],
            },
          });
          expect(Object.keys(item.foreground.questions[0]).sort()).toEqual([
            'nativeSessionId',
            'questionId',
            'rootSessionId',
            'runId',
          ]);
          if (fault) {
            await db.unsafe(`create function foreground_diagnostics_fault() returns trigger language plpgsql as $$
              begin raise exception 'fixture diagnostics unavailable' using errcode='P0001'; end $$;
              create trigger foreground_diagnostics_fault before insert or update on allrice_runtime_metadata
              for each row execute function foreground_diagnostics_fault()`);
          }
          if (login) {
            await Promise.race([resourceEntered.promise, execution]);
          } else {
            await adapter.steer({
              threadId,
              turnId,
              clientUserMessageId: randomUUID(),
              inputKind: 'ask_user',
              message: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
            });
          }
          await Promise.race([resourceEntered.promise, execution]);
          tick();
          const observed = await sampleDone();
          expect(
            observed.onlineQuestions.executions[0].foreground,
          ).toMatchObject({ complete: true, questions: [] });
          if (fault) {
            // The old row is stale, with its own unrefreshed Host timestamp.
            expect((await persisted()).onlineQuestions).toEqual(
              first.onlineQuestions,
            );
            await db.unsafe(
              'drop trigger foreground_diagnostics_fault on allrice_runtime_metadata',
            );
            tick();
            await sampleDone();
          }
          const recovered = (await persisted()).onlineQuestions.executions[0]
            .foreground;
          expect(recovered).toMatchObject({ complete: true, questions: [] });
          expect(recovered.sampledAt > item.foreground.sampledAt).toBe(true);
          const events =
            await db`select payload from allrice_run_events where run_id=${runId}`;
          expect(
            events.some((r) =>
              [
                'allrice/user-question-opened',
                'allrice/user-question-ended',
              ].includes(r.payload.sourceEventType),
            ),
          ).toBe(false);
          if (login)
            expect(
              events.some(
                (r) =>
                  r.payload.sourceEventType ===
                  'session/user-question-answered',
              ),
            ).toBe(false);
          release.release();
          await expect(execution).resolves.toMatchObject({ threadId });
          await batcher.flush();
          expect(await adapter.questionSnapshots()).toEqual([]);
        } finally {
          stop?.();
          release.release();
          controller.abort();
          await execution.catch(() => {});
        }
      },
      30000,
    );
  },
);
