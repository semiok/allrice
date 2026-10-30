/* global process, AbortController */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Client from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runFixture,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { assertNativeRunAuthority } from '../../../../packages/database/src/run-delivery-authority.ts';
import {
  appendJobEvent,
  QuestionObservationWriteError,
  QueueError,
} from '../../../../packages/database/src/execution/queue.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { HarnessEventBatcher } from '../../src/harness/delta-batcher.ts';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.ts';
import { p24Fixture, gate } from '../p24/fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'foreground observation failures through the real leased writer and batcher',
  () => {
    let fixture, model, adapter;
    afterEach(async () => {
      await adapter?.close();
      await model?.close();
      await fixture?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    async function database() {
      fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      vi.spyOn(Client, 'getDatabase').mockReturnValue(fixture.db);
      return fixture.db;
    }
    function writer(worker, failures = []) {
      return new HarnessEventBatcher(async (event) => {
        try {
          await appendJobEvent({
            ...worker,
            ...normalizeHarnessRunEvent(event),
          });
        } catch (error) {
          failures.push(error);
          throw error;
        }
      });
    }
    async function fault(
      db,
      predicate,
      { table = 'allrice_run_events', commit = false, retry = false } = {},
    ) {
      if (retry) await db.unsafe('create sequence foreground_fault_count');
      await db.unsafe(`create function foreground_sink_fault() returns trigger language plpgsql as $$
      begin
        if ${predicate}${retry ? " and nextval('foreground_fault_count')=1" : ''} then
          raise exception using errcode='${retry ? '55P03' : 'P0001'}', message='foreground_sink_failure';
        end if;
        return NEW;
      end $$`);
      await db.unsafe(`create ${commit ? 'constraint ' : ''}trigger foreground_sink_fault
      ${commit ? 'after' : 'before'} insert on ${table}
      ${commit ? 'deferrable initially deferred' : ''} for each row execute function foreground_sink_fault()`);
    }

    it.each(['none', 'opened', 'ended', 'mirror-ended', 'revoked'])(
      'real Host question preserves its answer across %s; revocation still stops it',
      async (mode) => {
        const db = await database();
        const f = await createRunAuthorityFixture(db, {
          configure: false,
          memberRole: 'member',
        });
        const threadId = `dsh-${f.session}`;
        await db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
        await db`update allrice_conversation_runtimes set thread_id=${threadId} where session_id=${f.session}`;
        await db`insert into allrice_native_session_bindings(native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
        storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,
        first_run_id,first_job_id,first_attempt,binding_basis)
        values(${threadId},${f.org},${f.workspace},${f.user},'chat',${f.session},${f.session},${'/synthetic/' + f.session},
        ${'sha256:' + 'a'.repeat(64)},${'sha256:' + 'a'.repeat(64)},'fixture','restricted',${f.rootRunId},${f.worker.jobId},1,'approved_compatibility_reader')`;
        const authority = {
          scope: f.task.scope,
          rootRunId: f.rootRunId,
          worker: { ...f.worker, attempt: 1 },
        };
        await expect(
          assertNativeRunAuthority(authority),
        ).resolves.toMatchObject({ nativeSessionId: threadId });
        const sinkPhase = mode === 'mirror-ended' ? 'ended' : mode;
        if (['opened', 'ended'].includes(sinkPhase))
          await fault(
            db,
            `NEW.payload->>'sourceEventType'='allrice/user-question-${sinkPhase}'`,
            {
              table:
                mode === 'mirror-ended'
                  ? 'allrice_employee_run_steps'
                  : 'allrice_run_events',
            },
          );
        model = await p24Fixture(async (_request, index) =>
          index === 1
            ? {
                nativeTool: {
                  name: 'ask_user_question',
                  arguments: {
                    questions: [
                      {
                        id: 'continue',
                        question: '先问我，再继续完成。',
                        options: [{ label: '继续' }],
                      },
                    ],
                  },
                },
              }
            : { text: '已按回答继续完成。' },
        );
        const root = await realpath(model.root);
        vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'unused-platform'));
        adapter = new DshHarnessAdapter({
          runtimeRoot: join(root, 'runtime'),
          idleCloseMs: 60000,
          requestTimeoutMs: 15000,
          credentialResolver: {
            resolve: async () => ({ apiKey: 'synthetic-only' }),
          },
        });
        const opened = gate(),
          controller = new AbortController(),
          failures = [];
        const batcher = writer(f.worker, failures);
        let questionId,
          turnId,
          lastEvent,
          authorityCalls = 0;
        const execution = adapter
          .execute({
            kernel: {
              schemaVersion: 1,
              harness: 'dsh',
              sessionId: f.session,
              employeeAssignmentId: f.assignment,
              employeeVersionId: f.version,
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
              systemInstructions: 'Use the native question tool.',
              userRequest: '先问我，然后完成。',
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
              model: 'foreground-fault',
              reasoningEffort: 'low',
              credentialReference: 'fixture:only',
              baseUrl: model.baseUrl,
            },
            executionEnvironment: {
              ALLRICE_ORGANIZATION_ID: f.org,
              ALLRICE_WORKSPACE_ID: f.workspace,
              ALLRICE_OWNER_ID: f.user,
              ALLRICE_RUN_ID: f.rootRunId,
              ALLRICE_JOB_ID: f.worker.jobId,
              ALLRICE_ATTEMPT: '1',
              ALLRICE_ASK_USER_MODE: 'legacy',
              ALLRICE_QUESTION_RELEASE_MS: '0',
            },
            workDirectory: root,
            storageObjects: [],
            tools: [],
            nativeQuestionWait: { mode: 'default' },
            signal: controller.signal,
            attempt: 1,
            generation: 1,
            nativeRunAuthority: () => async () => {
              authorityCalls++;
              return assertNativeRunAuthority(authority);
            },
            onTurnStarted: async (value) => {
              turnId = value.turnId;
            },
            onToolCall: async () => {
              throw Error('unexpected broker tool');
            },
            onEvent: async (event) => {
              lastEvent = event;
              if (event.sourceEventType === 'session/user-question')
                questionId = event.sourcePayload.questionId;
              await batcher.accept(event);
              if (event.sourceEventType === 'allrice/user-question-opened')
                opened.release();
            },
          })
          .then(async (value) => {
            await batcher.flush(); // Same final flush required by runClaimedJob.
            return { value };
          })
          .catch((error) => ({ error }));
        try {
          await Promise.race([opened.promise, execution]);
          if (mode === 'revoked')
            await db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
          await adapter
            .steer({
              threadId,
              turnId,
              clientUserMessageId: randomUUID(),
              inputKind: 'ask_user',
              message: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [{ id: 'continue', selected: ['继续'] }] })}`,
            })
            .catch((error) => {
              if (mode !== 'revoked') throw error;
            });
          const outcome = await execution;
          expect(authorityCalls).toBeGreaterThan(0);
          if (mode === 'revoked') {
            await expect(
              assertNativeRunAuthority(authority),
            ).rejects.toMatchObject({
              code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
            });
            expect(outcome.error).toBeDefined();
            expect(outcome.value).toBeUndefined();
            return;
          }
          expect(outcome.error).toBeUndefined();
          expect(outcome.value).toMatchObject({
            answer: '已按回答继续完成。',
            threadId,
          });
          await expect(
            assertNativeRunAuthority(authority),
          ).resolves.toMatchObject({ nativeSessionId: threadId });
          expect(failures).toHaveLength(mode === 'none' ? 0 : 1);
          for (const error of failures) {
            expect(error).toBeInstanceOf(QuestionObservationWriteError);
            expect(error).toMatchObject({
              code: 'P0001',
              cause: { name: 'PostgresError', code: 'P0001' },
            });
          }
          const rows =
            await db`select payload from allrice_run_events where run_id=${f.rootRunId}
          and payload->>'sourceEventType' like 'allrice/user-question-%' order by sequence`;
          expect(rows.map((r) => r.payload.sourceEventType)).toEqual(
            ['opened', 'ended']
              .filter((phase) => phase !== sinkPhase)
              .map((phase) => `allrice/user-question-${phase}`),
          );
          // A later required write and the deferred delta flush both remain usable.
          await batcher.accept({
            ...lastEvent,
            sourceEventType: undefined,
            type: 'usage.updated',
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
          });
          await batcher.accept({
            ...lastEvent,
            sourceEventType: undefined,
            type: 'assistant.delta',
            text: 'after-observation-flush',
          });
          await batcher.flush();
          const later =
            await db`select 1 from allrice_run_events where run_id=${f.rootRunId} and payload->>'text'='after-observation-flush'`;
          expect(later).toHaveLength(1);
        } finally {
          controller.abort();
          await execution;
        }
      },
      30000,
    );

    const event = (sourceEventType = 'allrice/user-question-opened') => ({
      schemaVersion: 1,
      harness: 'dsh',
      generation: 1,
      attempt: 1,
      order: 1,
      threadId: 'foreground-fixture',
      turnId: 'turn',
      sessionId: randomUUID(),
      messageId: randomUUID(),
      type: 'native.event',
      presentation: 'context',
      status: 'started',
      label: 'foreground',
      sourceEventType,
      sourcePayload: { version: 1, questionId: randomUUID() },
    });
    it.each(['lease', 'gate-sql', 'commit', 'delta', 'billing', 'control'])(
      '%s failure is still fatal and cannot be cleared by a later optional observation',
      async (mode) => {
        const db = await database(),
          f = await runFixture(db);
        const failures = [],
          observation = event();
        const batcher = writer(
          {
            ...f.worker,
            ...(mode === 'lease' ? { leaseToken: randomUUID() } : {}),
          },
          failures,
        );
        if (mode === 'gate-sql')
          await db.unsafe(
            'alter table allrice_task_clocks rename column run_id to fault_saved_run_id',
          );
        else if (mode !== 'lease')
          await fault(
            db,
            mode === 'delta'
              ? "NEW.event_type='assistant.text.delta'"
              : mode === 'billing'
                ? "NEW.event_type='usage.updated'"
                : mode === 'control'
                  ? "NEW.payload->>'sourceEventType'='allrice/runtime-preparation'"
                  : "NEW.payload->>'sourceEventType'='allrice/user-question-opened'",
            { commit: mode === 'commit' },
          );
        if (mode === 'delta')
          await batcher.accept({
            ...observation,
            type: 'assistant.delta',
            text: 'pending required text',
          });
        const required =
          mode === 'billing'
            ? {
                ...observation,
                type: 'usage.updated',
                inputTokens: 1,
                cachedInputTokens: 0,
                outputTokens: 1,
              }
            : mode === 'control'
              ? event('allrice/runtime-preparation')
              : observation;
        const error = await batcher.accept(required).then(
          () => undefined,
          (error) => error,
        );
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(QuestionObservationWriteError);
        if (mode === 'lease') expect(error).toBeInstanceOf(QueueError);
        expect(error.code).toBe(
          mode === 'lease'
            ? 'lease_lost'
            : mode === 'gate-sql'
              ? '42703'
              : 'P0001',
        );
        if (mode === 'gate-sql')
          await db.unsafe(
            'alter table allrice_task_clocks rename column fault_saved_run_id to run_id',
          );
        await expect(batcher.accept(observation)).rejects.toBe(error);
        await expect(batcher.flush()).rejects.toBe(error);
        expect(failures).toHaveLength(1);
      },
      30000,
    );

    it('preserves the existing 55P03 retry and its eventual single committed observation', async () => {
      const db = await database(),
        f = await runFixture(db),
        batcher = writer(f.worker);
      await fault(
        db,
        "NEW.payload->>'sourceEventType'='allrice/user-question-opened'",
        { retry: true },
      );
      await batcher.accept(event());
      await batcher.flush();
      const count = await db.unsafe(
        'select last_value from foreground_fault_count',
      );
      expect(Number(count[0].last_value)).toBe(2);
      const rows =
        await db`select 1 from allrice_run_events where run_id=${f.task.runId} and payload->>'sourceEventType'='allrice/user-question-opened'`;
      expect(rows).toHaveLength(1);
    }, 30000);
  },
);
