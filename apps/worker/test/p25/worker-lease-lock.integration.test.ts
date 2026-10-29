/** MET-210 #4, from the user's side: a real chat Run through the real queue,
 * Worker runner (1 s heartbeat), DSH adapter and native process, while a second
 * PostgreSQL connection holds the Run's 703 lock past the 5 s lock_timeout.
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
} from '@allrice/database';
import * as client from '../../../../packages/database/src/core/client.ts';
import * as modelPool from '../../../../packages/database/src/providers/model-pool.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
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
import { p24Fixture, gate } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const failureTag = '[MET-210] Worker lease transaction rolled back';

suite('MET-210 a chat Run survives a 703 lock held past lock_timeout', () => {
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
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
    // Same registry seam as dsh-idle-recovery-worker: content measurement,
    // verification and exact launch approval remain real.
    process.execArgv = [];
    vi.stubEnv('NODE_OPTIONS', '');
    await installDshNativeArtifact({ root, expectedId: artifact.artifactId });
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact.artifactId);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact.artifactId);
    database = await createRuntimeFixtureDatabase();
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

  it('“1 分钟后提醒我”: one attempt, one model call, every event once and in order', async () => {
    const request = '1 分钟后提醒我：冒烟提醒-mvp3lupj。';
    const modelCalled = gate();
    const modelGo = gate();
    const model = await p24Fixture(async (_request, index) => {
      if (index === 1) {
        modelCalled.release();
        await modelGo.promise;
      }
      return { text: `好的，1 分钟后提醒你：冒烟提醒-mvp3lupj（${index}）` };
    });
    const freezeModel = modelPool.freezeSessionModelSnapshot;
    const selection = vi
      .spyOn(modelPool, 'freezeSessionModelSnapshot')
      .mockImplementation(async (...args) => ({
        ...(await freezeModel(...args)),
        provider: 'openai-compatible',
        authMode: 'api_key',
        model: 'lease-lock',
        reasoningEffort: 'low',
        credentialReference: 'test:synthetic',
        baseUrl: model.baseUrl,
      }));
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
    const adapter = new DshHarnessAdapter({
      runtimeRoot: join(model.root, 'native'),
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-only' }),
      },
      requestTimeoutMs: 30_000,
    });
    const f = await createRunAuthorityFixture(database.db, {
      configure: false,
      allowedTools: [],
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-compatible',
        model: 'lease-lock',
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
      title: 'MET-210 lease lock acceptance',
    });
    const sent = await sendChatMessage(context, f.workspace, chat.id, {
      text: request,
      clientMessageId: randomUUID(),
      deliveryMode: 'follow_up',
      assistantPreference: { mode: 'daily', allowAssistants: false },
    });
    if (!sent.run) throw Error('fixture_run_not_enqueued');
    const runId = sent.run.id;
    const job = await claimNextJob(workerId, 30_000);
    if (!job?.lease) throw Error('fixture_job_not_claimed');
    let handlerCalls = 0;
    const running = runClaimedJob(
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
        handlerCalls++;
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
            if (!value.conversation) throw Error('native_chat_binding_missing');
            runtime = value.conversation;
          },
        });
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
            onEvent: onHarnessEvent,
          });
        } finally {
          await releaseConversationRuntime({ ...ownership, outcome: 'idle' });
        }
      },
    );
    running.catch(() => {});
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedPid!: (pid: number) => void;
    const holderPid = new Promise<number>((resolve) => {
      lockedPid = resolve;
    });
    let holder: Promise<unknown> | undefined;
    try {
      await Promise.race([modelCalled.promise, running]);
      expect(model.requests).toHaveLength(1);
      holder = database.db.begin(async (tx) => {
        const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${runId},703))`;
        lockedPid(row!.pid);
        await released;
      });
      const pid = await holderPid;
      // The model now answers: its events and the next heartbeats queue on 703.
      modelGo.release();
      await expect
        .poll(
          async () => {
            const [row] = await database.db<{ n: number }[]>`
              select count(*)::int n from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`;
            return row!.n;
          },
          { timeout: 10_000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(2);
      await new Promise((resolve) => setTimeout(resolve, 6_500));
    } finally {
      release();
      modelGo.release();
      await holder;
    }
    try {
      await running;
      const [run] =
        await f.db`select state,error_code from allrice_runs where id=${runId}`;
      expect(run).toMatchObject({ state: 'succeeded', error_code: null });
      const [finished] =
        await f.db`select status,attempt from allrice_jobs where id=${job.id}`;
      expect(finished).toMatchObject({ status: 'succeeded', attempt: 1 });
      // No whole-turn rerun: one handler entry, one model request.
      expect(handlerCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
      const events = await f.db<{ sequence: number; event_type: string }[]>`
        select sequence,event_type from allrice_run_events where run_id=${runId} order by sequence`;
      expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i));
      expect(
        events.filter((e) => e.event_type === 'run.succeeded'),
      ).toHaveLength(1);
      expect(events.some((e) => e.event_type === 'run.failed')).toBe(false);
      // The lock really outlasted lock_timeout: some lease write rolled back
      // (55P03) and was retried inside the original lease.
      const retried = warn.mock.calls
        .filter(([tag]) => tag === failureTag)
        .map(([, record]) => record as Record<string, unknown>);
      expect(retried.length).toBeGreaterThan(0);
      for (const record of retried)
        expect(record).toMatchObject({
          sqlState: '55P03',
          outcome: 'retrying',
          runId,
          jobId: job.id,
        });
      // No lease write gave up (those are logged as errors).
      expect(error.mock.calls.filter(([tag]) => tag === failureTag)).toEqual(
        [],
      );
    } finally {
      await adapter.close();
      warn.mockRestore();
      error.mockRestore();
      selection.mockRestore();
      await model.close();
    }
  }, 90_000);
});
