/** Owned PostgreSQL schema, real queue/Worker/native binding and DSH process.
 * Only the HTTP model and credentials are synthetic; no Dev services are used. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EmployeeExecutionSnapshotSchema,
  HarnessExecutionSnapshotSchema,
} from '@allrice/contracts';
import {
  acquireConversationRuntime,
  claimNextJob,
  recordConversationTurn,
  releaseConversationRuntime,
  replaceWorkerDshRuntimeInventory,
} from '@allrice/database';
import * as client from '../../../../packages/database/src/core/client.ts';
import * as modelPool from '../../../../packages/database/src/providers/model-pool.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import {
  authenticateSession,
  createSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
import { runClaimedJob } from '../../src/job-runner.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { createJobNativeBinding } from '../../src/harness/native-session-binding.js';
import {
  installDshNativeArtifact,
  measureDshNativeArtifact,
  nativeArtifactPath,
} from '../../src/harness/dsh-native-artifact.js';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.js';
import type {
  DshRuntimePool,
  DshRuntime,
} from '../../src/harness/dsh/runtime-pool.js';
import { p24Fixture, gate } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'MET216 idle reclaim through the real chat queue and native binding',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let manifestPath: string;
    let previousManifest: Buffer | undefined;
    const testHarnessExecArgv = process.execArgv;
    const workerId = randomUUID();

    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      for (const flag of [
        'ALLRICE_ASSISTANTS_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', '[]');
      for (const key of Object.keys(process.env))
        if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
          vi.stubEnv(key, undefined);
      const root = await realpath(resolve(import.meta.dirname, '../../../..'));
      const artifact = await measureDshNativeArtifact(root, undefined, {
        schemaVersion: 2,
      });
      manifestPath = join(root, nativeArtifactPath);
      previousManifest = await readFile(manifestPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        },
      );
      await mkdir(join(root, '.local'), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(artifact));
      // Same registry seam as dsh-native-artifact.test.ts: Vitest has a --require
      // warning shim. Loader enforcement is tested separately by startup probes.
      // Content measurement, verification and exact launch approval remain real.
      process.execArgv = [];
      vi.stubEnv('NODE_OPTIONS', '');
      await installDshNativeArtifact({ root, expectedId: artifact.artifactId });
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact.artifactId);
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact.artifactId);
      database = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 120_000);

    afterAll(async () => {
      try {
        await database?.close();
      } finally {
        if (manifestPath) {
          if (previousManifest) await writeFile(manifestPath, previousManifest);
          else await rm(manifestPath, { force: true });
        }
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.execArgv = testHarnessExecArgv;
      }
    }, 30_000);

    it('recovers the same conversation on a new Host after timer-driven idle reclaim', async () => {
      const firstRequest = '记住我的项目代号是蓝鲸';
      const secondRequest = '我的项目代号是什么？';
      const firstModel = gate();
      const modelCalled = gate();
      const model = await p24Fixture(async (_request, index) => {
        if (index === 1) {
          modelCalled.release();
          await firstModel.promise;
        }
        return { text: `Synthetic response ${index}: ${randomUUID()}` };
      });
      // Ordinary chat currently insists on the platform Codex subscription
      // (model-pool.ts freezeEmployeeModelTarget). Substitute only its frozen
      // model selection to reach our local HTTP model. Chat enqueue, immutable
      // execution binding, Job admission and native session SQL stay real.
      const freezeModel = modelPool.freezeSessionModelSnapshot;
      const selection = vi
        .spyOn(modelPool, 'freezeSessionModelSnapshot')
        .mockImplementation(async (...args) => ({
          ...(await freezeModel(...args)),
          provider: 'openai-compatible',
          authMode: 'api_key',
          model: 'idle-recovery',
          reasoningEffort: 'low',
          credentialReference: 'test:synthetic',
          baseUrl: model.baseUrl,
        }));
      vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
      const adapter = new DshHarnessAdapter({
        runtimeRoot: join(model.root, 'native'),
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-only' }),
        },
        idleCloseMs: 100,
        requestTimeoutMs: 15_000,
      });
      const pool = Reflect.get(adapter, 'runtimePool') as DshRuntimePool;
      const recover = vi.spyOn(DshProtocolClient.prototype, 'recover');
      const prepared: { requiresRecovery: boolean; bound: boolean }[] = [];
      let firstRuntime: DshRuntime | undefined;
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: [],
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-compatible',
          model: 'idle-recovery',
          reasoningEffort: 'low',
          timeoutMs: 300_000,
          fallbackModels: [],
          credentialReference: 'test:synthetic',
          baseUrl: model.baseUrl,
        },
      });
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('isolated_login_required');
      const chat = await createAssignedChatSession(context, {
        workspaceId: f.workspace,
        employeeAssignmentId: f.assignment,
        title: 'Owned idle recovery acceptance',
      });
      const syncInventory = () =>
        replaceWorkerDshRuntimeInventory({
          workerId,
          runtimes: adapter
            .runtimeInventory()
            .flatMap((runtime) =>
              runtime.sessionId === null
                ? []
                : [{ ...runtime, sessionId: runtime.sessionId }],
            ),
        });
      async function turn(text: string) {
        const sent = await sendChatMessage(context!, f.workspace, chat.id, {
          text,
          clientMessageId: randomUUID(),
          deliveryMode: 'follow_up',
          assistantPreference: { mode: 'daily', allowAssistants: false },
        });
        if (!sent.run) throw Error('fixture_run_not_enqueued');
        const job = await claimNextJob(workerId, 30_000);
        if (!job?.lease) throw Error('fixture_job_not_claimed');
        const [claimed] =
          await f.db`select run_id from allrice_jobs where id=${job.id}`;
        expect(claimed!.run_id).toBe(sent.run.id);
        await runClaimedJob(
          {
            workerId,
            jobId: job.id,
            leaseToken: job.lease.token,
            leaseMs: 30_000,
            heartbeatMs: 1_000,
            executionRoot: join(model.root, 'execution'),
            stopping: () => false,
            onAbortReady: () => {},
          },
          async ({
            execution,
            workflowLease,
            isolation,
            signal,
            onHarnessEvent,
          }) => {
            const [stored] =
              await f.db`select * from allrice_employee_runs where run_id=${execution.context.runId}`;
            const snapshot = EmployeeExecutionSnapshotSchema.parse(
              stored!.execution_snapshot,
            );
            const ownership = {
              organizationId: f.org,
              workspaceId: f.workspace,
              sessionId: chat.id,
              runId: execution.context.runId,
              workerId,
            };
            let runtime = await acquireConversationRuntime({
              ...ownership,
              ownerId: f.user,
              configChecksum: snapshot.employee.definitionChecksum,
              compactThresholdTokens: 40_000,
            });
            const binding = createJobNativeBinding({
              lease: workflowLease,
              attempt: execution.job.attempt,
              subject: () => ({
                kind: 'chat',
                id: chat.id,
                configChecksum: runtime.configChecksum,
                generation: runtime.generation,
                expectedThreadId: runtime.threadId,
              }),
              onBound: async (value) => {
                if (!value.conversation)
                  throw Error('native_chat_binding_missing');
                runtime = value.conversation;
              },
            });
            const prepare = binding.prepare;
            binding.prepare = async (request) => {
              const result = await prepare(request);
              prepared.push({
                requiresRecovery: result.requiresRecovery,
                bound: !!result.binding,
              });
              return result;
            };
            try {
              return await adapter.execute({
                kernel: {
                  schemaVersion: 1,
                  harness: 'dsh',
                  sessionId: chat.id,
                  employeeAssignmentId: f.assignment,
                  employeeVersionId: f.version,
                  userMessageId: stored!.user_message_id,
                  assistantMessageId: stored!.assistant_message_id,
                  systemInstructions: stored!.prompt_snapshot.systemPrompt,
                  userRequest: stored!.prompt_snapshot.userRequest,
                  // No SQL transcript injection: native disk recovery must supply history.
                  bootstrapConversation: '',
                  authorizedMemoryContext: '',
                  grantedCapabilities: ['model:invoke'],
                  skillVersionIds: [],
                  imageAttachments: [],
                },
                providerSnapshot: HarnessExecutionSnapshotSchema.parse(
                  stored!.provider_snapshot,
                ),
                workDirectory: isolation.workDirectory,
                executionEnvironment: isolation.environment,
                storageObjects: [],
                tools: [],
                signal,
                attempt: execution.job.attempt,
                generation: runtime.generation,
                threadId: runtime.threadId,
                nativeBinding: binding,
                onTurnStarted: async (input) => {
                  runtime = await recordConversationTurn({
                    ...ownership,
                    ...input,
                  });
                },
                onEvent: async (event) => {
                  await onHarnessEvent(event);
                  if (event.sourceEventType === 'allrice/runtime-preparation') {
                    firstRuntime ??= pool.get(event.threadId!);
                    await syncInventory();
                  }
                },
              });
            } finally {
              await releaseConversationRuntime({
                ...ownership,
                outcome: 'idle',
              });
            }
          },
        );
        const [run] =
          await f.db`select state,result,error_code from allrice_runs where id=${sent.run.id}`;
        expect(run).toMatchObject({ state: 'succeeded', error_code: null });
        const [runtime] =
          await f.db`select thread_id from allrice_conversation_runtimes where session_id=${chat.id}`;
        return {
          runId: sent.run.id,
          threadId: runtime!.thread_id,
          result: run!.result,
        };
      }
      let running: ReturnType<typeof turn> | undefined;
      try {
        running = turn(firstRequest);
        await Promise.race([modelCalled.promise, running]);
        expect(model.requests).toHaveLength(1);
        // A real active Worker job remains resident even beyond its idle timeout.
        await pool.reclaimIdle(Date.now() + 86_400_000);
        expect(adapter.runtimeInventory()).toHaveLength(1);
        const [active] =
          await f.db`select r.state,j.status from allrice_runs r join allrice_jobs j on j.run_id=r.id where r.id=(select active_run_id from allrice_conversation_runtimes where session_id=${chat.id})`;
        expect(active).toMatchObject({ state: 'running', status: 'running' });
        firstModel.release();
        const first = await running;
        expect(prepared).toEqual([{ requiresRecovery: false, bound: false }]);
        expect(recover).not.toHaveBeenCalled();
        const [pin] =
          await f.db`select * from allrice_native_session_bindings where native_session_id=${first.threadId}`;
        expect(pin).toMatchObject({
          context_id: chat.id,
          binding_basis: 'business_root_origin',
        });
        await expect
          .poll(() => adapter.runtimeInventory().length, { timeout: 10_000 })
          .toBe(0);
        expect(firstRuntime!.client.processState?.().state).toBe('exited');
        await syncInventory();
        const [offline] =
          await f.db`select status,ended_at from allrice_dsh_runtime_instances where id=${firstRuntime!.id}`;
        expect(offline!.status).toBe('offline');
        expect(offline!.ended_at).not.toBeNull();
        const second = await turn(secondRequest);
        expect(second.threadId).toBe(first.threadId);
        expect(prepared).toEqual([
          { requiresRecovery: false, bound: false },
          { requiresRecovery: true, bound: true },
        ]);
        expect(recover).toHaveBeenCalledExactlyOnceWith(first.threadId);
        const events =
          await f.db`select run_id,payload from allrice_run_events where run_id in (${first.runId},${second.runId}) and payload->>'sourceEventType'='allrice/runtime-preparation' order by occurred_at`;
        expect(events).toHaveLength(2);
        expect(events[1]!.payload.nativePayload.reason).toBe('not_resident');
        expect(events[1]!.payload.nativePayload.runtimeId).not.toBe(
          events[0]!.payload.nativePayload.runtimeId,
        );
        expect(model.requests).toHaveLength(2);
        const messages = model.requests[1]!.messages;
        expect(
          messages.some(
            (m) =>
              m.role === 'user' &&
              JSON.stringify(m.content).includes(firstRequest),
          ),
        ).toBe(true);
        expect(
          messages.some(
            (m) =>
              m.role === 'assistant' &&
              JSON.stringify(m.content).includes(first.result.answer),
          ),
        ).toBe(true);
        expect(
          messages.some(
            (m) =>
              m.role === 'user' &&
              JSON.stringify(m.content).includes(secondRequest),
          ),
        ).toBe(true);
      } finally {
        firstModel.release();
        await running?.catch(() => {});
        await adapter.close();
        recover.mockRestore();
        selection.mockRestore();
        await model.close();
      }
    }, 90_000);
  },
);
