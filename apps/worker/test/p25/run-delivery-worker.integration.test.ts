/** Real chat admission -> Worker -> DSH JSON-RPC -> PostgreSQL completion.
 * Only the model target/transport, installed-artifact approval, and (in explicitly
 * marked cases) the future eligibility switch are synthetic. No credentials.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
import * as Rollout from '../../../../packages/database/src/final-delivery-rollout.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
import { upsertEmployeeModelPolicy } from '../../../../packages/database/src/providers/model-pool.ts';
import * as ModelPool from '../../../../packages/database/src/providers/model-pool.ts';
import {
  claimNextJob,
  startClaimedJob,
  completeJob,
  cancelRun,
  failJob,
  finishJobDrain,
} from '../../../../packages/database/src/execution/queue.ts';
import { publishWorkbenchArtifact } from '../../../../packages/database/src/artifact-review.ts';
import {
  finalDeliveryTextDigest,
  finalDeliveryFactsDigest,
} from '../../../../packages/database/src/final-delivery-commit.ts';
import { readDeliverySnapshot } from '../../../../packages/database/src/run-delivery.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import * as Router from '../../src/harness/router.ts';
import * as NativeArtifact from '../../src/harness/dsh-native-artifact.ts';
import {
  DSH_DISTRIBUTION_CURRENT_GENERATION,
  DSH_DISTRIBUTION_CURRENT_VERSION,
} from '../../src/harness/dsh-distribution.ts';
import {
  beginCheckedFinalDeliveryExecution,
  readCheckedFinalDeliveryForExecution,
} from '../../src/final-delivery/checked-delivery.ts';
import { p24Fixture, gate } from '../p24/fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-210 PR1b real Worker delivery (synthetic local model)', () => {
  let fixture:
    Awaited<ReturnType<typeof createRuntimeFixtureDatabase>> | undefined;
  let model: Awaited<ReturnType<typeof p24Fixture>> | undefined;
  let adapter: DshHarnessAdapter | undefined;
  let directory: string | undefined;
  afterEach(async () => {
    await adapter?.close();
    await model?.close();
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    fixture = undefined;
    model = undefined;
    adapter = undefined;
    directory = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }, 30000);

  async function setup(
    checked: boolean,
    reply: Parameters<typeof p24Fixture>[0],
    nativeSubagents = false,
  ) {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    const artifactId = `sha256:${'a'.repeat(64)}`;
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifactId);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifactId);
    directory = await realpath(await mkdtemp(join(tmpdir(), 'pr1b-worker-')));
    vi.stubEnv('ALLRICE_STORAGE_ROOT', join(directory, 'storage'));
    vi.stubEnv(
      'ALLRICE_DSH_PLATFORM_HOME',
      join(directory, 'unused-platform-home'),
    );
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(DatabaseClient, 'getDatabase').mockReturnValue(fixture.db);
    model = await p24Fixture(reply);
    const launch = {
      artifactId,
      generation: DSH_DISTRIBUTION_CURRENT_GENERATION,
      version: DSH_DISTRIBUTION_CURRENT_VERSION,
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      ],
      profile: resolve(
        import.meta.dirname,
        '../../dsh/allrice-restricted.cordis.yml',
      ),
    };
    if (nativeSubagents) {
      // Test-only native plugins, with the production Worker/Host and real
      // model HTTP transport. This does not enable product eligibility.
      await symlink(
        resolve(import.meta.dirname, '../../node_modules'),
        join(directory, 'node_modules'),
      );
      const profile = await readFile(launch.profile, 'utf8');
      launch.profile = join(directory, 'profile.yml');
      await writeFile(
        launch.profile,
        profile +
          '\n' +
          (await readFile(
            resolve(
              import.meta.dirname,
              '../native-subagent/plugins.cordis.yml',
            ),
            'utf8',
          )),
      );
    }
    vi.spyOn(NativeArtifact, 'checkedDshNativeLaunch').mockReturnValue({
      artifactId,
      profileId: 'restricted',
    });
    vi.spyOn(NativeArtifact, 'currentDshNativeLaunch').mockImplementation(
      (profile) => {
        expect(profile).toBe('restricted');
        return launch;
      },
    );
    adapter = new DshHarnessAdapter({
      runtimeRoot: join(directory, 'native'),
      idleCloseMs: 0,
      requestTimeoutMs: 15000,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-loopback-only' }),
      },
    });
    vi.spyOn(Router, 'getHarnessRouter').mockReturnValue(
      new Router.HarnessRouter([adapter]),
    );
    // PR1c is intentionally NOT implemented: only this explicit test seam
    // freezes eligibility before INSERT. No immutable snapshot is rewritten.
    if (checked) {
      const freeze = Rollout.freezeDeliveryPolicy;
      vi.spyOn(Rollout, 'freezeDeliveryPolicy').mockImplementation(
        (tx, input) => freeze(tx, { ...input, eligible: true }),
      );
    }
    const db = fixture.db;
    const identity = await createRunAuthorityFixture(db, {
      configure: false,
      allowedTools: ['workspace.export.create', 'workspace.document.read'],
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-compatible',
        model: 'pr1b-synthetic',
        reasoningEffort: 'low',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'test:pr1b-synthetic',
        baseUrl: model.baseUrl,
      },
    });
    const login = await createSession(identity.user);
    const context = (await authenticateSession(login.token, {
      organizationId: identity.org,
      workspaceId: identity.workspace,
    }))!;
    await authorizeFixturePlatformAdministrator(db, identity.user);
    const connectionId = randomUUID(),
      catalogId = randomUUID();
    await db`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode,enabled)
      values(${randomUUID()},'openai-compatible','Synthetic loopback','dsh','api_key',true)
      on conflict(provider_key) do update set enabled=true`;
    const [provider] =
      await db`select id from allrice_model_providers where provider_key='openai-compatible'`;
    await db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url,status)
      values(${connectionId},${provider!.id},'platform','Synthetic loopback','test:pr1b-synthetic',${model.baseUrl},'ready')`;
    await db`insert into allrice_model_catalog_entries(id,provider_id,model,display_name,reasoning_efforts,default_reasoning_effort,input_modalities,output_modalities,enabled)
      values(${catalogId},${provider!.id},'pr1b-synthetic','Synthetic loopback','["low"]','low','["text"]','["text"]',true)`;
    await upsertEmployeeModelPolicy({
      context,
      workspaceId: identity.workspace,
      employeeId: identity.employee,
      policy: {
        connectionId,
        modelCatalogEntryId: catalogId,
        reasoningEffort: 'low',
        fallbackPolicy: 'disabled',
        fallbackTargets: [],
        fallbackOn: [],
        runLimits: {
          timeoutMs: 300000,
          maxInputTokens: 100000,
          maxOutputTokens: 4000,
          maxTotalTokens: 150000,
          maxCostCents: 10000,
        },
      },
    });
    // Current product admission deliberately selects the platform subscription.
    // Substitute only its model target BEFORE the Run is frozen, so all native
    // requests use the local HTTP responder and never inspect OAuth material.
    const freezeModel = ModelPool.freezeSessionModelSnapshot;
    vi.spyOn(ModelPool, 'freezeSessionModelSnapshot').mockImplementation(
      async (input, database) => {
        const frozen = await freezeModel(input, database);
        const snapshot = {
          ...frozen,
          connectionId,
          modelCatalogEntryId: catalogId,
          provider: 'openai-compatible',
          authMode: 'api_key' as const,
          model: 'pr1b-synthetic',
          credentialReference: 'test:pr1b-synthetic',
          baseUrl: model!.baseUrl,
        };
        const sql = database ?? db;
        await sql`update allrice_session_model_snapshots set connection_id=${connectionId},model_catalog_entry_id=${catalogId},snapshot=${sql.json(snapshot)} where session_id=${input.sessionId}`;
        return snapshot;
      },
    );
    const chat = await createAssignedChatSession(context, {
      workspaceId: identity.workspace,
      employeeAssignmentId: identity.assignment,
      title: 'PR1b synthetic Worker',
    });
    return { db, identity, context, chat, artifactId };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  async function prepare(f: Setup, prompt: string) {
    const sent = await sendChatMessage(
      f.context,
      f.identity.workspace,
      f.chat.id,
      {
        text: prompt,
        clientMessageId: randomUUID(),
        deliveryMode: 'follow_up',
        assistantPreference: { mode: 'daily', allowAssistants: false },
      },
    );
    expect(sent.run).toBeDefined();
    const workerId = randomUUID();
    const job = (await claimNextJob(workerId, 300000))!;
    const [queued] =
      await f.db`select id from allrice_jobs where run_id=${sent.run!.id}`;
    expect(job.id).toBe(queued!.id);
    const workflowLease = {
      workerId,
      jobId: job.id,
      leaseToken: job.lease!.token,
      leaseMs: 300000,
    };
    const execution = (await startClaimedJob(
      workerId,
      job.id,
      workflowLease.leaseToken,
    ))!;
    const isolation = await prepareExecutionIsolation({
      root: join(directory!, 'execution'),
      organizationId: f.identity.org,
      workspaceId: f.identity.workspace,
      ownerId: f.identity.user,
      runId: sent.run!.id,
      jobId: job.id,
      attempt: execution.job.attempt,
    });
    const [stored] =
      await f.db`select execution_snapshot from allrice_employee_runs where run_id=${sent.run!.id}`;
    expect(stored!.execution_snapshot.modelSnapshot).toMatchObject({
      provider: 'openai-compatible',
      model: 'pr1b-synthetic',
    });
    const controller = new AbortController();
    beginCheckedFinalDeliveryExecution(workflowLease);
    return {
      runId: sent.run!.id,
      execution,
      workflowLease,
      isolation,
      controller,
      snapshot: stored!.execution_snapshot,
      run: () =>
        executeEmployeeRun({
          execution,
          workflowLease,
          isolation,
          signal: controller.signal,
          onHarnessEvent: async () => {},
        }),
    };
  }
  async function state(f: Setup, runId: string) {
    return (
      await f.db`select j.status,r.state,r.result,m.content->>'text' text,
      (select count(*)::int from allrice_run_events ev where ev.run_id=r.id and ev.event_type='run.succeeded') successes
      from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs e on e.run_id=r.id
      join allrice_messages m on m.id=e.assistant_message_id where r.id=${runId}`
    )[0];
  }
  async function journal() {
    const root = join(directory!, 'native');
    const paths = await readdir(root, { recursive: true });
    const records = (
      await Promise.all(
        paths
          .filter((p) => p.endsWith('.jsonl'))
          .map((p) => readFile(join(root, p), 'utf8')),
      )
    ).join('\n');
    return records
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('普通聊天程序题保持现有资格：真实 Worker 落库正文，不生成助手或伪造 checked proof', async () => {
    const answer = '```js\nconst sum = (a, b) => a + b;\n```';
    const f = await setup(false, async () => ({ text: answer }));
    const task = await prepare(
      f,
      '帮我完成这项任务：写一个返回两数之和的 JavaScript 函数。',
    );
    expect(task.snapshot.finalDeliveryPolicy).toBeUndefined();
    try {
      const result = await task.run();
      expect(
        readCheckedFinalDeliveryForExecution(task.workflowLease, result),
      ).toEqual({ coverage: 'uncovered' });
      await completeJob({ ...task.workflowLease, result });
      expect(await state(f, task.runId)).toMatchObject({
        status: 'succeeded',
        text: answer,
        successes: 1,
      });
      expect(
        await f.db`select root_run_id from allrice_assistant_roots where root_run_id=${task.runId}`,
      ).toHaveLength(0);
      expect(model!.requests).toHaveLength(1);
    } finally {
      await task.isolation.cleanup();
    }
  }, 45000);

  it('后代晚于根首次 idle 结算并唤醒根：真实 Worker 将后续 turn 写入 PG 后提交', async () => {
    const childEntered = gate(),
      releaseChild = gate();
    let rootCalls = 0;
    const answer = '已汇总子智能体的实际结果。';
    const f = await setup(
      true,
      async (request) => {
        const userInputs = request.messages.filter((m) => m.role === 'user');
        if (JSON.stringify(userInputs).includes('PR1B_CHILD_TASK')) {
          childEntered.release();
          await releaseChild.promise;
          return { text: 'PR1B_CHILD_RESULT' };
        }
        rootCalls++;
        if (rootCalls === 1)
          return {
            nativeTool: {
              name: 'subagent',
              arguments: {
                description: '检查独立子任务',
                prompt: 'PR1B_CHILD_TASK',
              },
            },
          };
        if (rootCalls === 2) return { text: '子任务仍在执行。' };
        return { text: answer };
      },
      true,
    );
    const task = await prepare(f, '启动子任务，结束后汇总，不需要文件。');
    const wait = DshProtocolClient.prototype.wait;
    let waited = false;
    vi.spyOn(DshProtocolClient.prototype, 'wait').mockImplementation(
      async function (this: DshProtocolClient, sessionId) {
        if (!waited) {
          waited = true;
          await childEntered.promise;
          expect(rootCalls).toBe(2);
          const before =
            await f.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='turn.started'`;
          expect(before).toHaveLength(1);
          releaseChild.release();
        }
        return wait.call(this, sessionId);
      },
    );
    try {
      const result = await task.run();
      const coverage = readCheckedFinalDeliveryForExecution(
        task.workflowLease,
        result,
      );
      if (coverage.coverage !== 'checked_native_v1')
        throw Error('Missing checked native proof');
      const starts =
        await f.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='turn.started' order by sequence`;
      expect(starts.map((row) => row.payload.turnId)).toEqual([
        `${coverage.proof.nativeSessionId}:turn:1`,
        `${coverage.proof.nativeSessionId}:turn:2`,
      ]);
      const [runtime] =
        await f.db`select active_turn_id from allrice_conversation_runtimes where session_id=${f.chat.id}`;
      expect(runtime!.active_turn_id).toBe(starts[1]!.payload.turnId);
      expect(result.answer).toBe(answer);
      // Root receipts include the tool call, first idle and woken turn. Child
      // usage归根 is PR3b; never synthesize it from a journal into this Run.
      expect(result.usage).toEqual({
        inputTokens: 60,
        cachedInputTokens: 0,
        outputTokens: 15,
      });
      await completeJob({
        ...task.workflowLease,
        result,
        checkedDelivery: coverage.checkedDelivery,
      });
      expect(await state(f, task.runId)).toMatchObject({
        status: 'succeeded',
        text: answer,
        successes: 1,
      });
      expect(rootCalls).toBe(3);
      expect(model!.requests).toHaveLength(4);
      expect(JSON.stringify(model!.requests.at(-1)!.messages)).toContain(
        'PR1B_CHILD_RESULT',
      );
    } catch (error) {
      console.info(
        'Synthetic descendant requests',
        model!.requests.map((r) => ({
          messages: r.messages.map((m) => ({
            role: m.role,
            content: JSON.stringify(m.content).slice(-1500),
            tools: m.tool_calls,
          })),
        })),
      );
      throw error;
    } finally {
      releaseChild.release();
      task.controller.abort();
      await task.isolation.cleanup();
    }
  }, 45000);

  it.each([
    { mode: 'valid', history: false },
    { mode: 'valid', history: true },
    { mode: 'repair', history: true },
  ] as const)(
    '合成资格下 $mode / 历史 $history：月报经根 wait 后落库同一 Run 的来源与精确版本',
    async ({ mode, history }) => {
      let answer = '';
      const original = `[月报](/api/v1/files/${randomUUID()}/download)`;
      const f = await setup(true, async (_request, count) => ({
        text: count === 1 && mode === 'repair' ? original : answer,
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 10,
          total_tokens: 2010,
        },
      }));
      // Admission checkpoints completed history, never the current user input.
      // Seed ordinary history before admission so its real frozen snapshot
      // contains a covered message; keep a first-turn case without a checkpoint.
      const historyMessageId = randomUUID();
      if (history)
        await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,status,content)
          values(${historyMessageId},${f.identity.org},${f.identity.workspace},${f.chat.id},${f.identity.user},'user','completed',
          '{"text":"请继续整理每月记录。","citations":[]}')`;
      const task = await prepare(
        f,
        '帮我完成这项任务：把月报整理成文件，把下载链接给我。',
      );
      expect(task.snapshot.finalDeliveryPolicy).toMatchObject({
        mode: 'checked_native_v1',
      });
      const artifact = await publishWorkbenchArtifact(
        {
          context: task.execution.context,
          sessionId: f.chat.id,
          callId: randomUUID(),
          kind: 'document',
          fileName: '月报.txt',
          format: 'text',
          mediaType: 'text/plain',
          bytes: Buffer.from('Synthetic monthly report'),
        },
        runtimeFixtureStorage(fixture!.db),
        fixture!.db,
      );
      answer = `[月报](/api/v1/files/${artifact.object.id}/download)`;
      const finalDelivery = DshProtocolClient.prototype.finalDelivery;
      vi.spyOn(DshProtocolClient.prototype, 'finalDelivery').mockImplementation(
        async function (this: DshProtocolClient, action, params) {
          const response = await finalDelivery.call(this, action, params);
          if (action === 'finish' && history)
            await f.db`update allrice_conversation_runtimes set compact_threshold_tokens=1000,usage_baseline_input_tokens=0 where session_id=${f.chat.id}`;
          return response;
        },
      );
      try {
        const result = await task.run();
        const coverage = readCheckedFinalDeliveryForExecution(
          task.workflowLease,
          result,
        );
        expect(coverage.coverage).toBe('checked_native_v1');
        if (coverage.coverage !== 'checked_native_v1')
          throw Error('Worker lost checked proof');
        const authority = {
          scope: {
            organizationId: f.identity.org,
            workspaceId: f.identity.workspace,
            projectId: null,
          },
          rootRunId: task.runId,
          worker: {
            ...task.workflowLease,
            attempt: task.execution.job.attempt,
            generation: coverage.proof.generation,
          },
        };
        const starts =
          await f.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='turn.started' order by sequence`;
        expect(starts).toHaveLength(mode === 'repair' ? 2 : 1);
        const [retained] =
          await f.db`select active_turn_id,active_run_id,state from allrice_conversation_runtimes where session_id=${f.chat.id}`;
        expect(retained).toMatchObject({
          active_turn_id: starts.at(-1)!.payload.turnId,
          active_run_id: task.runId,
          state: 'running',
        });
        const checkpoints =
          await f.db`select id,summary,covered_through_message_id from allrice_context_checkpoints where session_id=${f.chat.id}`;
        expect(checkpoints).toHaveLength(history ? 1 : 0);
        if (history) {
          expect(checkpoints[0]!.covered_through_message_id).toBe(
            historyMessageId,
          );
          expect(checkpoints[0]!.summary).toContain('请继续整理每月记录。');
        }
        expect(
          starts.every(
            (row) => row.payload.threadId === coverage.proof.nativeSessionId,
          ),
        ).toBe(true);
        expect(coverage.proof.candidateDigest).toBe(
          finalDeliveryTextDigest(answer),
        );
        const facts = await readDeliverySnapshot(authority);
        expect(coverage.proof.factSetDigest).toBe(
          finalDeliveryFactsDigest(facts),
        );
        expect(facts.artifacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              objectId: artifact.object.id,
              versionId: artifact.version.id,
            }),
          ]),
        );
        expect(
          await f.db`select run_id from allrice_employee_runs where session_id=${f.chat.id}`,
        ).toHaveLength(1);
        expect(
          await f.db`select id from allrice_messages where session_id=${f.chat.id} and role='assistant'`,
        ).toHaveLength(1);
        expect(
          await f.db`select run_id from allrice_runtime_run_links where root_run_id=${task.runId}`,
        ).toHaveLength(0);
        expect(model!.requests).toHaveLength(mode === 'repair' ? 2 : 1);
        const events = await journal();
        const replies = events.filter((e) => e.type === 'assistant/message');
        expect(
          replies.map((e) =>
            e.data.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join(''),
          ),
        ).toEqual(mode === 'repair' ? [original, answer] : [answer]);
        expect(replies.at(-1)).toMatchObject({
          seq: coverage.proof.durableSeq,
          data: { message: { id: coverage.proof.publicMessageId } },
        });
        expect(
          replies.every(
            (e) =>
              e.data.message.source.provider === 'openai-compatible' &&
              e.data.message.source.model === 'pr1b-synthetic',
          ),
        ).toBe(true);
        expect(
          events.filter(
            (e) => e.type === 'user/message' && e.data.source?.kind === 'user',
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (e) =>
              e.type === 'user/message' &&
              e.data.source?.kind === 'allrice-final-delivery-repair',
          ),
        ).toHaveLength(mode === 'repair' ? 1 : 0);
        expect(
          await f.db`select * from allrice_task_calls where run_id=${task.runId} and reserved_output_tokens is not null`,
        ).toHaveLength(0);
        // This is the job-runner's actual final transaction. A valid native
        // answer/proof must survive the Worker's checkpoint finalization.
        try {
          await completeJob({
            ...task.workflowLease,
            result,
            checkedDelivery: coverage.checkedDelivery,
          });
        } catch (error) {
          expect(await state(f, task.runId)).toMatchObject({
            status: 'running',
            state: 'running',
            successes: 0,
          });
          throw error;
        }
        expect(await state(f, task.runId)).toMatchObject({
          status: 'succeeded',
          text: answer,
          successes: 1,
        });
        const [released] =
          await f.db`select active_turn_id,active_run_id,worker_id,state from allrice_conversation_runtimes where session_id=${f.chat.id}`;
        expect(released).toEqual({
          active_turn_id: null,
          active_run_id: null,
          worker_id: null,
          state: 'idle',
        });
        // A checkpoint row alone does not prove that the next real Worker can
        // read it or that the native model still receives the uncovered history.
        if (history && mode === 'valid') {
          const previousAnswer = answer;
          answer = '已继续整理每月记录。';
          const next = await prepare(f, '下一轮继续回顾上下文，不需要新文件。');
          const execution = vi.spyOn(adapter!, 'execute');
          try {
            const nextResult = await next.run();
            const nextCoverage = readCheckedFinalDeliveryForExecution(
              next.workflowLease,
              nextResult,
            );
            expect(nextCoverage.coverage).toBe('checked_native_v1');
            if (nextCoverage.coverage !== 'checked_native_v1')
              throw Error('Next Worker lost checked proof');
            expect(nextCoverage.proof.nativeSessionId).toBe(
              coverage.proof.nativeSessionId,
            );
            expect(nextCoverage.proof.publicMessageId).not.toBe(
              coverage.proof.publicMessageId,
            );
            expect(
              execution.mock.calls[0]![0].kernel.bootstrapContext?.segments,
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  key: 'checkpoint',
                  text: expect.stringContaining(checkpoints[0]!.summary),
                }),
              ]),
            );
            const messages = JSON.stringify(model!.requests.at(-1)!.messages);
            expect(messages).toContain('请继续整理每月记录。');
            expect(messages).toContain(previousAnswer);
            expect(messages).toContain('下一轮继续回顾上下文，不需要新文件。');
            await completeJob({
              ...next.workflowLease,
              result: nextResult,
              checkedDelivery: nextCoverage.checkedDelivery,
            });
            expect(await state(f, next.runId)).toMatchObject({
              status: 'succeeded',
              successes: 1,
            });
            expect(await state(f, task.runId)).toMatchObject({
              status: 'succeeded',
              successes: 1,
            });
            expect(model!.requests).toHaveLength(2);
          } finally {
            await next.isolation.cleanup();
          }
        }
      } finally {
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  // Existing cancellation happens inside the repair model. These boundaries
  // instead stop an already-settled model, before proof or before terminal SQL.
  it.each([
    'cancel-before-proof',
    'cancel-after-proof',
    'timeout-after-proof',
    'failure-after-proof',
  ] as const)(
    '真实 Worker 在 %s 时按终态生命周期释放占有，不发布成功',
    async (mode) => {
      const f = await setup(true, async () => ({
        text: '排序会按比较函数排列数组。',
      }));
      const task = await prepare(f, '解释数组排序，不需要文件。');
      const cancel = () =>
        cancelRun(f.context, f.identity.workspace, task.runId, {
          reason: 'user_requested',
        });
      if (mode === 'cancel-before-proof') {
        const wait = DshProtocolClient.prototype.wait;
        vi.spyOn(DshProtocolClient.prototype, 'wait').mockImplementation(
          async function (this: DshProtocolClient, sessionId) {
            const settled = await wait.call(this, sessionId);
            expect(model!.requests).toHaveLength(1);
            await cancel();
            task.controller.abort(Error('cancel after native wait'));
            return settled;
          },
        );
      }
      try {
        if (mode === 'cancel-before-proof') {
          await expect(task.run()).rejects.toMatchObject({
            code: 'EXECUTION_ABORTED',
            retryable: false,
          });
          await finishJobDrain(task.workflowLease);
        } else {
          const result = await task.run();
          const coverage = readCheckedFinalDeliveryForExecution(
            task.workflowLease,
            result,
          );
          if (coverage.coverage !== 'checked_native_v1')
            throw Error('Missing settled proof');
          const [held] =
            await f.db`select active_run_id,active_turn_id from allrice_conversation_runtimes where session_id=${f.chat.id}`;
          expect(held!.active_run_id).toBe(task.runId);
          expect(held!.active_turn_id).toBeTruthy();
          if (mode === 'cancel-after-proof') await cancel();
          if (mode === 'timeout-after-proof') {
            // Real admission enrolls a task clock. timeout_at is only its
            // projection and lockedLeasedJob refreshes it before completion.
            const expired = await f.db`update allrice_task_clocks
              set active_ms=(policy->>'timeoutMs')::double precision+1,
                  phase='active',changed_at=clock_timestamp()
              where run_id=${task.runId} returning policy`;
            expect(expired).toHaveLength(1);
            expect(expired[0]!.policy.timeoutMs).toBeGreaterThan(0);
          }
          if (mode === 'failure-after-proof')
            await failJob({
              ...task.workflowLease,
              code: 'SYNTHETIC_FINAL_FLUSH_FAILED',
              message: 'Synthetic final event flush failure',
              retryable: false,
            });
          else
            await completeJob({
              ...task.workflowLease,
              result,
              checkedDelivery: coverage.checkedDelivery,
            });
        }
        const canceled = mode.startsWith('cancel');
        expect(await state(f, task.runId)).toMatchObject({
          status: canceled ? 'canceled' : 'failed',
          state: canceled ? 'canceled' : 'failed',
          successes: 0,
        });
        const [released] =
          await f.db`select active_run_id,active_turn_id,worker_id,state from allrice_conversation_runtimes where session_id=${f.chat.id}`;
        expect(released).toEqual({
          active_run_id: null,
          active_turn_id: null,
          worker_id: null,
          state: canceled ? 'interrupted' : 'error',
        });
        const terminal =
          await f.db`select event_type,payload from allrice_run_events where run_id=${task.runId} and event_type in ('run.succeeded','run.canceled','run.failed')`;
        expect(terminal).toHaveLength(1);
        expect(terminal[0]!.event_type).toBe(
          canceled ? 'run.canceled' : 'run.failed',
        );
        if (mode === 'timeout-after-proof')
          expect(terminal[0]!.payload.code).toBe('JOB_TIMEOUT');
        expect(model!.requests).toHaveLength(1);
      } finally {
        task.controller.abort();
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  it.each([
    'wait-error',
    'missing-origin',
    'missing-active-turn',
    'empty-repair',
    'invalid-repair',
    'missing-usage-repair',
    'cancel-repair',
  ] as const)(
    '真实 Worker 遇到 %s 不提交完成、不无限重试、不借用维护模型准备权限',
    async (mode) => {
      const entered = gate(),
        release = gate();
      const wrong = `[月报](/api/v1/files/${randomUUID()}/download)`;
      let available = '';
      const f = await setup(true, async (_request, count) => {
        if (count === 2 && mode === 'cancel-repair') {
          entered.release();
          await release.promise;
        }
        return {
          ...(mode === 'missing-usage-repair' && count === 2
            ? { usage: null }
            : {}),
          text:
            mode === 'missing-origin' || mode === 'missing-active-turn'
              ? available
              : count === 2 && mode === 'empty-repair'
                ? ''
                : wrong,
        };
      });
      const task = await prepare(
        f,
        '帮我完成这项任务：整理月报并给我下载链接。',
      );
      const artifact = await publishWorkbenchArtifact(
        {
          context: task.execution.context,
          sessionId: f.chat.id,
          callId: randomUUID(),
          kind: 'document',
          fileName: '月报.txt',
          format: 'text',
          mediaType: 'text/plain',
          bytes: Buffer.from('Synthetic report'),
        },
        runtimeFixtureStorage(fixture!.db),
        fixture!.db,
      );
      if (mode === 'wait-error')
        vi.spyOn(DshProtocolClient.prototype, 'wait').mockRejectedValueOnce(
          Error('synthetic public wait failure'),
        );
      available = `[月报](/api/v1/files/${artifact.object.id}/download)`;
      if (mode === 'missing-origin' || mode === 'missing-active-turn') {
        const finalDelivery = DshProtocolClient.prototype.finalDelivery;
        vi.spyOn(
          DshProtocolClient.prototype,
          'finalDelivery',
        ).mockImplementation(async function (
          this: DshProtocolClient,
          action,
          params,
        ) {
          if (action === 'candidate') {
            if (mode === 'missing-origin')
              await f.db`delete from allrice_run_events where run_id=${task.runId} and event_type='turn.started'`;
            else
              await f.db`update allrice_conversation_runtimes set active_turn_id=null where session_id=${f.chat.id}`;
          }
          return finalDelivery.call(this, action, params);
        });
      }
      try {
        const pending = task.run();
        const codes = {
          'wait-error': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'missing-origin': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'missing-active-turn': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'empty-repair': 'DSH_EMPTY_RESPONSE',
          'invalid-repair': 'FINAL_DELIVERY_RESPONSE_INVALID',
          'missing-usage-repair': 'FINAL_DELIVERY_RESPONSE_INVALID',
          'cancel-repair': 'EXECUTION_ABORTED',
        };
        const rejected = expect(pending).rejects.toMatchObject({
          code: codes[mode],
          retryable: false,
        });
        if (mode === 'cancel-repair') {
          await entered.promise;
          task.controller.abort(Error('synthetic cancel during repair'));
          release.release();
        }
        await rejected;
        const [released] =
          await f.db`select active_turn_id,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${f.chat.id}`;
        expect(released).toEqual({
          active_turn_id: null,
          active_run_id: null,
          worker_id: null,
        });
        expect(await state(f, task.runId)).toMatchObject({
          status: 'running',
          state: 'running',
          successes: 0,
        });
        const oneTurn =
          mode === 'wait-error' ||
          mode === 'missing-origin' ||
          mode === 'missing-active-turn';
        expect(model!.requests).toHaveLength(oneTurn ? 1 : 2);
        expect(
          await f.db`select run_id from allrice_employee_runs where session_id=${f.chat.id}`,
        ).toHaveLength(1);
        expect(
          await f.db`select * from allrice_task_calls where run_id=${task.runId} and reserved_output_tokens is not null`,
        ).toHaveLength(0);
        const events = await journal();
        expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(
          oneTurn ? 1 : 2,
        );
        // The real Worker records the route and model ledger even when
        // delivery fails. Queue terminalization must not erase that receipt.
        if (mode !== 'cancel-repair') {
          await failJob({
            ...task.workflowLease,
            code: codes[mode],
            message: 'Delivery failed after native model execution',
            retryable: false,
          });
          expect(await state(f, task.runId)).toMatchObject({
            status: 'failed',
            state: 'failed',
            successes: 0,
          });
        }
        if (mode !== 'empty-repair') {
          const completedCalls =
            oneTurn ||
            mode === 'cancel-repair' ||
            mode === 'missing-usage-repair'
              ? 1
              : 2;
          const [route] =
            await f.db`select id,status,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known,cost_cents
              from allrice_route_decisions where run_id=${task.runId}`;
          expect(route).toMatchObject({
            status: mode === 'cancel-repair' ? 'canceled' : 'failed',
            input_tokens: 20 * completedCalls,
            cached_input_tokens: 0,
            output_tokens: 5 * completedCalls,
            cost_cents: null,
          });
          if (mode === 'invalid-repair' || mode === 'missing-usage-repair')
            expect(route!.usage_complete).toBe(mode === 'invalid-repair');
          if (mode === 'cancel-repair' || mode === 'missing-usage-repair')
            expect(route!.cache_usage_known).toBe(false);
          const ledger =
            await f.db`select status,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known,cost_cents
              from allrice_model_usage_ledger where route_decision_id=${route!.id}`;
          const { id: _id, ...receipt } = route!;
          expect(ledger).toEqual([receipt]);
        }
      } finally {
        release.release();
        task.controller.abort();
        await task.isolation.cleanup();
      }
    },
    45000,
  );
});
