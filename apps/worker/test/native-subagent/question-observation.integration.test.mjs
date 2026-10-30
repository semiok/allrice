/* global process, AbortController */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runFixture,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { appendJobEvent } from '../../../../packages/database/src/execution/queue.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.ts';
import { p24Fixture, gate } from '../p24/fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'real Host -> adapter -> leased run_events foreground observations',
  () => {
    let dbFixture, model, adapter;
    afterEach(async () => {
      await adapter?.close();
      await model?.close();
      await dbFixture?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it.each(['legacy-answer', 'program-timeout'])(
      '%s retains only exact execution metadata and closes the same foreground request',
      async (mode) => {
        dbFixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
        const db = dbFixture.db,
          f = await runFixture(db);
        vi.spyOn(DatabaseClient, 'getDatabase').mockReturnValue(db);
        const runId = f.task.runId,
          sessionId = randomUUID(),
          threadId = `dsh-${sessionId}`;
        const appeared = gate(),
          ended = gate(),
          resourceEntered = gate(),
          release = gate();
        const login = mode === 'program-timeout';
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
            : { text: '已继续完成。' },
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
            await appendJobEvent({
              ...f.worker,
              ...normalizeHarnessRunEvent(event),
            });
            if (event.sourceEventType === 'session/user-question')
              questionId = event.sourcePayload.questionId;
            if (event.sourceEventType === 'allrice/user-question-opened')
              appeared.release();
            if (event.sourceEventType === 'allrice/user-question-ended')
              ended.release();
          },
        };
        await db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
        const execution = adapter.execute(input);
        void execution.catch(() => {});
        const observations =
          () => db`select payload from allrice_run_events where run_id=${runId}
        and payload->>'sourceEventType' in ('allrice/user-question-opened','allrice/user-question-ended') order by sequence`;
        try {
          await Promise.race([appeared.promise, execution]);
          const rows = await observations();
          expect(rows).toHaveLength(1);
          const payload = rows[0].payload;
          const runtime = Reflect.get(adapter, 'runtimePool').get(threadId);
          expect(payload).toMatchObject({
            attempt: 2,
            generation: 7,
            threadId,
            sourceEventType: 'allrice/user-question-opened',
            nativePayload: {
              version: 1,
              questionId,
              runId,
              nativeSessionId: threadId,
              rootSessionId: threadId,
              runtimeId: runtime.id,
              jobId: f.worker.jobId,
              timed: login,
            },
          });
          expect(Object.keys(payload.nativePayload).sort()).toEqual(
            [
              'version',
              'questionId',
              'runId',
              'nativeSessionId',
              'rootSessionId',
              'runtimeId',
              'jobId',
              'timed',
              ...(login ? ['deadlineAt', 'releaseLimited'] : []),
            ].sort(),
          );
          if (login) {
            expect(payload.nativePayload.releaseLimited).toBe(true);
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
          await Promise.race([ended.promise, execution]);
          const settled = await observations();
          expect(settled.map((r) => r.payload.sourceEventType)).toEqual([
            'allrice/user-question-opened',
            'allrice/user-question-ended',
          ]);
          expect(settled[1].payload.nativePayload).toEqual(
            payload.nativePayload,
          );
          if (login) {
            const answered =
              await db`select 1 from allrice_run_events where run_id=${runId} and payload->>'sourceEventType'='session/user-question-answered'`;
            expect(answered).toHaveLength(0);
          }
          release.release();
          await expect(execution).resolves.toMatchObject({ threadId });
          expect(await observations()).toHaveLength(2);
        } finally {
          release.release();
          controller.abort();
          await execution.catch(() => {});
        }
      },
      30000,
    );
  },
);
