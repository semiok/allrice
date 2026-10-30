/** Real chat admission -> Worker -> DSH JSON-RPC -> PostgreSQL completion.
 * Only the model target/transport and installed-artifact approval are synthetic.
 * Eligibility, frozen snapshots, native completion and commit guards are real.
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
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRetiredExecutionHistory } from './retired-execution-history.fixture.ts';
import * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
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
  createTraceableMemory,
  createCheckpointMemoryCandidate,
  listWorkspaceMemories,
} from '../../../../packages/database/src/workspace/service.ts';
import {
  contextCheckpointChecksum,
  getLatestContextCheckpoint,
} from '../../../../packages/database/src/conversation/conversation-checkpoint.ts';
import { upsertEmployeeModelPolicy } from '../../../../packages/database/src/providers/model-pool.ts';
import { updateUserPreferences } from '../../../../packages/database/src/user-preferences.ts';
import {
  createWorkflow,
  manageEmployeeCapabilities,
} from '../../../../packages/database/src/capabilities/capability-registry.ts';
import * as ModelPool from '../../../../packages/database/src/providers/model-pool.ts';
import * as RouteDecisions from '../../../../packages/database/src/execution/route-decision.ts';
import { createRuntimeOperationLedger } from '../../../../packages/database/src/runtime-ledger/ledger.ts';
import {
  claimNextJob,
  startClaimedJob,
  completeJob,
  cancelRun,
  failJob,
  finishJobDrain,
  appendJobEvent,
  maintainQueue,
} from '../../../../packages/database/src/execution/queue.ts';
import { publishWorkbenchArtifact } from '../../../../packages/database/src/artifact-review.ts';
import {
  finalDeliveryTextDigest,
  finalDeliveryFactsDigest,
} from '../../../../packages/database/src/final-delivery-commit.ts';
import { readDeliverySnapshot } from '../../../../packages/database/src/run-delivery.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import * as TurnLifecycle from '../../src/conversation/turn-lifecycle.ts';
import * as SubscriptionPreflight from '../../src/subscription-preflight.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.ts';
import { checkOfficeExport } from '../../src/office/quality.ts';
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
suite('MET-210 root Run delivery through real admission and Worker', () => {
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
    reply: Parameters<typeof p24Fixture>[0],
    nativeSubagents = false,
    progressWait = false,
    allowedTools = ['workspace.export.create', 'workspace.document.read'],
  ) {
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
      idleCloseMs: progressWait ? 60000 : 0,
      requestTimeoutMs: 15000,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-loopback-only' }),
      },
    });
    vi.spyOn(Router, 'getHarnessRouter').mockReturnValue(
      new Router.HarnessRouter([adapter]),
    );
    const db = fixture.db;
    const identity = await createRunAuthorityFixture(db, {
      configure: false,
      allowedTools,
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
    return { db, identity, context, chat, artifactId, launch };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  async function prepare(f: Setup, prompt: string, persistEvents = false) {
    const sent = await sendChatMessage(
      f.context,
      f.identity.workspace,
      f.chat.id,
      {
        text: prompt,
        clientMessageId: randomUUID(),
        deliveryMode: 'follow_up',
      },
    );
    expect(sent.run).toBeDefined();
    return claim(f, sent.run!.id, persistEvents);
  }
  async function claim(f: Setup, runId: string, persistEvents = false) {
    const workerId = randomUUID();
    const job = (await claimNextJob(workerId, 300000))!;
    const [queued] =
      await f.db`select id from allrice_jobs where run_id=${runId}`;
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
      runId,
      jobId: job.id,
      attempt: execution.job.attempt,
    });
    const [stored] =
      await f.db`select execution_snapshot from allrice_employee_runs where run_id=${runId}`;
    expect(stored!.execution_snapshot.modelSnapshot).toMatchObject({
      provider: 'openai-compatible',
      model: 'pr1b-synthetic',
    });
    const controller = new AbortController();
    beginCheckedFinalDeliveryExecution(workflowLease);
    return {
      runId,
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
          onHarnessEvent: async (event) => {
            if (persistEvents)
              await appendJobEvent({
                ...workflowLease,
                ...normalizeHarnessRunEvent(event),
              });
          },
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

  it('MET229: 普通 Worker 新账本逐 Run 结算，旧来源续聊不重计持久前缀', async () => {
    const f = await setup(async () => ({
      text: '会议结论：先整理资料，再确认下一步。',
    }));
    const [born] =
      await f.db`select native_root_origin from allrice_chat_sessions where id=${f.chat.id}`;
    for (const prompt of ['整理会议结论。', '继续补充下一步。']) {
      const task = await prepare(f, prompt, true);
      try {
        const result = await task.run();
        const facts =
          await f.db`select payload from allrice_run_events where run_id=${task.runId} and payload->>'source'='native_model_receipt_v1' order by sequence`;
        expect(facts).toHaveLength(2);
        expect(facts.map((r) => r.payload.fact.phase)).toEqual([
          'start',
          'finish',
        ]);
        expect(facts[0]!.payload.fact.callId).toBe(
          facts[1]!.payload.fact.callId,
        );
        expect(
          facts.every(
            (r) =>
              r.payload.runId === task.runId &&
              r.payload.jobId === task.workflowLease.jobId,
          ),
        ).toBe(true);
        expect(facts[1]!.payload.fact).toMatchObject({
          usageComplete: true,
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 25,
          },
        });
        const [route] =
          await f.db`select id,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known,cost_cents from allrice_route_decisions where run_id=${task.runId}`;
        expect(route).toMatchObject({
          input_tokens: 20,
          cached_input_tokens: 0,
          output_tokens: 5,
          usage_complete: true,
          cache_usage_known: true,
          cost_cents: null,
        });
        expect(result).toMatchObject({
          usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5 },
          usageComplete: true,
          cacheUsageKnown: true,
          estimatedCostCents: null,
        });
        expect(
          await f.db`select * from allrice_employee_run_steps where run_id=${task.runId} and payload->>'source'='native_model_receipt_v1'`,
        ).toHaveLength(0);
        await completeJob({ ...task.workflowLease, result });
        f.launch.artifactId = 'sha256:' + 'b'.repeat(64);
        vi.mocked(NativeArtifact.checkedDshNativeLaunch).mockReturnValue({
          artifactId: f.launch.artifactId,
          profileId: 'restricted',
        });
        vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', f.launch.artifactId);
      } finally {
        await task.isolation.cleanup();
      }
    }
    expect(model!.requests).toHaveLength(2);
    expect(
      (
        await f.db`select native_root_origin from allrice_chat_sessions where id=${f.chat.id}`
      )[0],
    ).toEqual(born);
    expect(
      vi.mocked(NativeArtifact.currentDshNativeLaunch).mock.results.at(-1)!
        .value.artifactId,
    ).toBe(f.launch.artifactId);
  }, 45000);

  it('MET229: 真实 finish 写入失败保持未知账单，不退旧累计或重跑模型', async () => {
    const f = await setup(async () => ({ text: '会议结论：先整理资料。' }));
    await f.db
      .unsafe(`create function reject_native_finish() returns trigger language plpgsql as $$
      begin
        if new.payload->>'source' = 'native_model_receipt_v1'
          and new.payload->'fact'->>'phase' = 'finish' then
          raise exception 'isolated native finish failure';
        end if;
        return new;
      end $$;
      create trigger reject_native_finish before insert on allrice_run_events
        for each row execute function reject_native_finish()`);
    const task = await prepare(f, '整理会议结论。', true);
    try {
      const result = await task.run();
      expect(model!.requests).toHaveLength(1);
      expect(result).toMatchObject({
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        usageComplete: false,
        cacheUsageKnown: false,
        estimatedCostCents: null,
      });
      const facts =
        await f.db`select payload from allrice_run_events where run_id=${task.runId} and payload->>'source'='native_model_receipt_v1'`;
      expect(facts.map((r) => r.payload.fact.phase)).toEqual(['start']);
      const [ledger] =
        await f.db`select l.input_tokens,l.output_tokens,l.usage_complete,l.cache_usage_known,l.cost_cents
          from allrice_model_usage_ledger l join allrice_route_decisions d on d.id=l.route_decision_id where d.run_id=${task.runId}`;
      expect(ledger).toMatchObject({
        input_tokens: 0,
        output_tokens: 0,
        usage_complete: false,
        cache_usage_known: false,
        cost_cents: null,
      });
      await completeJob({ ...task.workflowLease, result });
      expect(await state(f, task.runId)).toMatchObject({
        status: 'succeeded',
        successes: 1,
      });
    } finally {
      await task.isolation.cleanup();
    }
  }, 30000);

  it.each([
    { mode: 'plan_only', workbench: '1' },
    { mode: 'execute', workbench: '0' },
    { mode: 'plan_only', workbench: '0' },
  ] as const)(
    'PR3a 非交付工具保留合法读取：$mode / workbench=$workbench',
    async ({ mode, workbench }) => {
      const f = await setup(
        async (_request, count) => {
          if (count === 1)
            return {
              nativeTool: { name: 'workspace_file_list', arguments: {} },
            };
          if (count === 2)
            return {
              nativeTool: {
                name: 'todo_write',
                arguments: {
                  todos: [{ content: '已读取文件列表', status: 'completed' }],
                },
              },
            };
          return { text: '已读取当前文件列表。' };
        },
        false,
        false,
        ['workspace.file.list'],
      );
      await f.identity.setControls({
        version: 1,
        enabled: true,
        mode,
        rules: [],
      });
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', workbench);
      const task = await prepare(f, '列出当前可访问文件。');
      expect(task.snapshot.finalDeliveryPolicy?.mode).not.toBe(
        'checked_native_v1',
      );
      try {
        const result = await task.run();
        expect(result.answer).toBe('已读取当前文件列表。');
        expect(model!.requests).toHaveLength(3);
        const events = await journal();
        expect(events.some((e) => e.type === 'todo/write')).toBe(true);
        const [audit] = await f.db`select metadata from allrice_audit_events
          where organization_id=${f.identity.org} and action='tool.execute' and decision='allowed'
          and metadata->>'toolName'='workspace.file.list'`;
        expect(audit).toBeDefined();
        await completeJob({ ...task.workflowLease, result });
      } finally {
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  it('MET-228: legacy 原生问题停放超过30s，停止后普通新输入及时完成', async () => {
    const followup = '继续：用一句话给刚才线上例会写开场白，不调用其他工具。';
    const f = await setup(async (request, count) => {
      if (count === 1)
        return {
          nativeTool: {
            name: 'ask_user_question',
            arguments: {
              questions: [
                {
                  id: 'delivery',
                  question: '开场白放在聊天还是文件？',
                  options: [{ label: '聊天' }, { label: '文件' }],
                },
              ],
            },
          },
        };
      expect(count).toBe(2);
      expect(JSON.stringify(request.messages)).toContain(followup);
      return { text: '各位好，欢迎参加今天的线上例会。' };
    });
    const task = await prepare(f, '先问我开场白要放在聊天还是文件。', true);
    const started = Date.now();
    try {
      await expect(task.run()).rejects.toMatchObject({
        message: 'native_question_parked',
        persisted: true,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(30000);
      expect(adapter!.runtimeInventory()).toHaveLength(0);
      expect(model!.requests).toHaveLength(1);
      const [wait] = await f.db`select checkpoint,state,continued_at
        from allrice_native_question_waits where run_id=${task.runId}`;
      expect(wait).toMatchObject({ state: 'parked', continued_at: null });
      expect(
        await f.db`select status,worker_id,lease_token from allrice_jobs where run_id=${task.runId}`,
      ).toEqual([
        { status: 'waiting_approval', worker_id: null, lease_token: null },
      ]);
      const parkedEvents = await journal();
      expect(parkedEvents.some((e) => e.type === 'turn/end')).toBe(true);
      expect(JSON.stringify(parkedEvents)).toContain('ASK_ABORTED');
      await cancelRun(f.context, f.identity.workspace, task.runId, {
        reason: 'user_requested',
      });
      await maintainQueue();
      expect(await state(f, task.runId)).toMatchObject({
        status: 'canceled',
        state: 'canceled',
        successes: 0,
      });
      expect(
        await f.db`select state,active_run_id,active_turn_id,worker_id
          from allrice_conversation_runtimes where session_id=${f.chat.id}`,
      ).toEqual([
        {
          state: 'interrupted',
          active_run_id: null,
          active_turn_id: null,
          worker_id: null,
        },
      ]);
      const next = await prepare(f, followup, true);
      try {
        expect(next.execution.job.attempt).toBe(1);
        const result = await next.run();
        expect(result.answer).toBe('各位好，欢迎参加今天的线上例会。');
        const coverage = readCheckedFinalDeliveryForExecution(
          next.workflowLease,
          result,
        );
        if (coverage.coverage !== 'checked_native_v1')
          throw Error('Missing checked ordinary continuation');
        await completeJob({
          ...next.workflowLease,
          result,
          checkedDelivery: coverage.checkedDelivery,
        });
        expect(await state(f, next.runId)).toMatchObject({
          status: 'succeeded',
          successes: 1,
        });
        expect(
          await f.db`select thread_id,state,active_run_id,worker_id
            from allrice_conversation_runtimes where session_id=${f.chat.id}`,
        ).toEqual([
          {
            thread_id: wait!.checkpoint.sessionId,
            state: 'idle',
            active_run_id: null,
            worker_id: null,
          },
        ]);
        expect(
          await f.db`select continued_at from allrice_native_question_waits where run_id=${task.runId}`,
        ).toEqual([{ continued_at: null }]);
        expect(
          await f.db`select id from allrice_conversation_commands where session_id=${f.chat.id}`,
        ).toEqual([]);
        const events = await journal();
        expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(2);
        expect(events.filter((e) => e.type === 'turn/end')).toHaveLength(2);
        expect(model!.requests).toHaveLength(2);
      } finally {
        await next.isolation.cleanup();
      }
    } finally {
      await task.isolation.cleanup();
    }
  }, 90000);

  it('PR3a legacy 进度问题超过 30s 暂停，真实答复恢复原 Run 且保留完整调用身份', async () => {
    const requests: Record<string, unknown>[] = [];
    const setHandler = DshProtocolClient.prototype.setRequestHandler;
    vi.spyOn(
      DshProtocolClient.prototype,
      'setRequestHandler',
    ).mockImplementation(function (this: DshProtocolClient, handler) {
      setHandler.call(
        this,
        handler &&
          (async (method, params) => {
            if (method === 'allrice/progress') requests.push({ ...params });
            return handler(method, params);
          }),
      );
    });
    const f = await setup(async (request, count) => {
      if (count <= 3)
        return {
          nativeTool: { name: 'local_fs_list', arguments: { path: 42 } },
        };
      expect(JSON.stringify(request.messages)).toContain('重新检查后继续');
      return { text: '已按答复继续原任务。' };
    });
    const task = await prepare(f, '检查目录；重复失败时等我确认。', true);
    const started = Date.now();
    try {
      await expect(task.run()).rejects.toMatchObject({
        message: 'native_question_parked',
        persisted: true,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(30000);
      expect(adapter!.runtimeInventory()).toHaveLength(0);
      expect(model!.requests).toHaveLength(3);
      const [wait] =
        await f.db`select checkpoint,generation,state from allrice_native_question_waits
        where run_id=${task.runId}`;
      expect(wait!.state).toBe('parked');
      const { checkpoint, generation } = wait!;
      expect(checkpoint.questions).toEqual([
        expect.objectContaining({ id: 'runtime-progress' }),
      ]);
      const inputId = randomUUID();
      await sendChatMessage(f.context, f.identity.workspace, f.chat.id, {
        text: `allrice:user-question:v1:${JSON.stringify({
          questionId: checkpoint.questionId,
          answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }],
        })}`,
        clientMessageId: inputId,
        deliveryMode: 'steer',
        expectedTurnId: checkpoint.turnId,
        expectedGeneration: generation,
      });
      await maintainQueue();
      const resumed = await claim(f, task.runId, true);
      const beforeResume = requests.length;
      try {
        expect(resumed.execution.job.attempt).toBe(
          task.execution.job.attempt + 1,
        );
        const result = await resumed.run();
        expect(result.answer).toBe('已按答复继续原任务。');
        const controls = requests
          .slice(beforeResume)
          .filter((p) => p.action === 'check' || p.action === 'decide');
        expect(controls.slice(0, 2).map((p) => p.action)).toEqual([
          'check',
          'decide',
        ]);
        expect(controls[1]).toMatchObject({ decision: 'continue' });
        for (const request of requests)
          expect(request).toMatchObject({
            runId: task.runId,
            nativeSessionId: checkpoint.sessionId,
            rootSessionId: checkpoint.sessionId,
            parentSessionId: null,
            delegationDepth: 0,
          });
        const [command] =
          await f.db`select state,native_proof from allrice_conversation_commands
          where client_user_message_id=${inputId}`;
        expect(command).toMatchObject({
          state: 'consumed',
          native_proof: { status: 'adopted' },
        });
        const [decision] =
          await f.db`select decision from allrice_task_progress_decisions where run_id=${task.runId}`;
        expect(decision?.decision).toBe('continue');
        const coverage = readCheckedFinalDeliveryForExecution(
          resumed.workflowLease,
          result,
        );
        if (coverage.coverage !== 'checked_native_v1')
          throw Error('Missing checked continuation');
        await completeJob({
          ...resumed.workflowLease,
          result,
          checkedDelivery: coverage.checkedDelivery,
        });
        expect(await state(f, task.runId)).toMatchObject({
          status: 'succeeded',
          successes: 1,
        });
        expect(model!.requests).toHaveLength(4);
      } finally {
        await resumed.isolation.cleanup();
      }
    } finally {
      await task.isolation.cleanup();
    }
  }, 90000);

  it('从未开启助手的普通聊天也由根 Run 核对正文并提交真实 proof', async () => {
    const answer = '```js\nconst sum = (a, b) => a + b;\n```';
    const f = await setup(async () => ({ text: answer }));
    const legacyHistory = await readRetiredExecutionHistory(f.db);
    const task = await prepare(
      f,
      '帮我完成这项任务：写一个返回两数之和的 JavaScript 函数。',
    );
    expect(task.snapshot.finalDeliveryPolicy?.mode).toBe('checked_native_v1');
    try {
      const result = await task.run();
      const coverage = readCheckedFinalDeliveryForExecution(
        task.workflowLease,
        result,
      );
      expect(coverage.coverage).toBe('checked_native_v1');
      if (coverage.coverage !== 'checked_native_v1')
        throw Error('Ordinary chat lost checked proof');
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
      expect(
        await f.db`select run_id from allrice_runtime_run_links where root_run_id=${task.runId}`,
      ).toHaveLength(0);
      expect(await readRetiredExecutionHistory(f.db)).toEqual(legacyHistory);
      expect(model!.requests).toHaveLength(1);
    } finally {
      await task.isolation.cleanup();
    }
  }, 45000);

  it('MET-236: cumulative usage stays in billing while native history owns continuation', async () => {
    // Spread each Run's billed input across real native steps below the native
    // per-request compaction threshold. These are transport fixtures, not a benchmark.
    const runs = [
      { input: 477758, cached: 0, calls: 6 },
      { input: 207369, cached: 0, calls: 3 },
      { input: 2745756, cached: 0, calls: 36 },
    ];
    let phase = 0,
      step = 0;
    const f = await setup(async () => {
      const run = runs[phase]!;
      step++;
      expect(step).toBeLessThanOrEqual(run.calls);
      const share = (total: number) =>
        Math.floor(total / run.calls) +
        (step === run.calls ? total % run.calls : 0);
      return {
        ...(step === run.calls
          ? { text: `NATIVE_REPLY_${phase}` }
          : {
              nativeTool: {
                name: 'todo_write',
                arguments: {
                  todos: [
                    { content: `Step ${phase}-${step}`, status: 'completed' },
                  ],
                },
              },
            }),
        usage: {
          prompt_tokens: share(run.input),
          prompt_tokens_details: { cached_tokens: share(run.cached) },
          completion_tokens: 5,
          total_tokens: share(run.input) + 5,
        },
      };
    });
    const historyId = randomUUID();
    await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,status,content)
      values(${historyId},${f.identity.org},${f.identity.workspace},${f.chat.id},${f.identity.user},'user','completed',
      '{"text":"AUTHORIZED_HISTORY_236","citations":[]}')`;
    const explicit = await createTraceableMemory(f.context, {
      workspaceId: f.identity.workspace,
      employeeId: f.identity.employee,
      content: '我的偏好是中文周报。',
      sourceType: 'message',
      sourceId: historyId,
      sourceLabel: '用户明确要求记住',
      lifecycleState: 'durable',
      memoryClass: 'user_preference',
      confidence: 1,
    });
    let historical: Awaited<ReturnType<typeof getLatestContextCheckpoint>> =
      null;
    const memoryFacts = async () =>
      (
        await listWorkspaceMemories(
          f.context,
          f.identity.workspace,
          f.identity.employee,
        )
      ).map(
        ({ id, content, lifecycleState, sourceId, sourceType, revision }) => ({
          id,
          content,
          lifecycleState,
          sourceId,
          sourceType,
          revision,
        }),
      );
    let memories: Awaited<ReturnType<typeof memoryFacts>> = [];
    let threadId: string | undefined;
    for (phase = 0; phase < runs.length; phase++) {
      step = 0;
      const start = model!.requests.length;
      const task = await prepare(
        f,
        `继续核对记录 NATIVE_REQUEST_${phase}`,
        true,
      );
      try {
        const result = await task.run();
        const coverage = readCheckedFinalDeliveryForExecution(
          task.workflowLease,
          result,
        );
        if (coverage.coverage !== 'checked_native_v1')
          throw Error('Missing native delivery proof');
        expect(result).toMatchObject({
          usage: {
            inputTokens: runs[phase]!.input,
            cachedInputTokens: runs[phase]!.cached,
            outputTokens: runs[phase]!.calls * 5,
          },
        });
        await completeJob({
          ...task.workflowLease,
          result,
          checkedDelivery: coverage.checkedDelivery,
        });
        const [runtime] =
          await f.db`select * from allrice_conversation_runtimes where session_id=${f.chat.id}`;
        threadId ??= runtime!.thread_id;
        expect(runtime!.thread_id).toBe(threadId);
        expect(runtime!.context_pressure_tokens).toBe(0);
        expect(runtime!.dsh_context_projected_tokens).toBeGreaterThan(0);
        expect(runtime!.dsh_context_projected_tokens).toBeLessThan(
          runtime!.dsh_context_window_tokens,
        );
        const [route] =
          await f.db`select id,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known from allrice_route_decisions where run_id=${task.runId}`;
        expect(route).toMatchObject({
          input_tokens: runs[phase]!.input,
          cached_input_tokens: runs[phase]!.cached,
          output_tokens: runs[phase]!.calls * 5,
          usage_complete: true,
          // Exact prompt/output totals prove pi-ai's omitted write-cache is zero.
          cache_usage_known: true,
        });
        expect(
          await f.db`select route_decision_id id,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known from allrice_model_usage_ledger where route_decision_id=${route!.id}`,
        ).toEqual([route]);
        const firstMessages = model!.requests[start]!.messages;
        const userInput = JSON.stringify(
          firstMessages.findLast(
            (m) =>
              m.role === 'user' &&
              JSON.stringify(m.content).includes(`NATIVE_REQUEST_${phase}`),
          ),
        );
        expect(JSON.stringify(firstMessages)).toContain(
          'AUTHORIZED_HISTORY_236',
        );
        expect(JSON.stringify(firstMessages)).not.toContain(
          'RETIRED_AUTO_SUMMARY_236',
        );
        if (phase === 0) expect(userInput).toContain('AUTHORIZED_HISTORY_236');
        else {
          expect(userInput).not.toContain('AUTHORIZED_HISTORY_236');
          expect(userInput).not.toContain(`NATIVE_REPLY_${phase - 1}`);
          expect(JSON.stringify(firstMessages)).toContain(
            `NATIVE_REPLY_${phase - 1}`,
          );
        }
        expect(step).toBe(runs[phase]!.calls);
        if (phase === 0) {
          // Preserve a valid historical row and candidate, with the old baseline
          // that formerly made the third Run look like 2,267,998 context tokens.
          const values = {
            sessionId: f.chat.id,
            harness: 'dsh' as const,
            threadId: runtime!.thread_id,
            generation: runtime!.thread_generation,
            coveredThroughMessageId: historyId,
            summaryVersion: 'extractive-v1' as const,
            summary: 'RETIRED_AUTO_SUMMARY_236',
            configChecksum: runtime!.config_checksum,
            estimatedTokens: 40000,
            messageCount: 1,
          };
          const checkpointId = randomUUID();
          await f.db`insert into allrice_context_checkpoints(id,organization_id,workspace_id,session_id,owner_id,harness,thread_id,thread_generation,covered_through_message_id,summary_version,summary,checksum,config_checksum,estimated_tokens,message_count)
            values(${checkpointId},${f.identity.org},${f.identity.workspace},${f.chat.id},${f.identity.user},'dsh',${values.threadId},${values.generation},${historyId},'extractive-v1',${values.summary},${contextCheckpointChecksum(values)},${values.configChecksum},40000,1)`;
          await f.db`update allrice_conversation_runtimes set usage_baseline_input_tokens=477758 where session_id=${f.chat.id}`;
          await createCheckpointMemoryCandidate(f.context, {
            workspaceId: f.identity.workspace,
            employeeId: f.identity.employee,
            sessionId: f.chat.id,
            checkpointId,
            content: '历史候选偏好：每周整理记录。',
            sourceLabel: '历史自动候选',
          });
          memories = await memoryFacts();
          expect(memories.some((m) => m.id === explicit.id)).toBe(true);
        } else {
          expect(runtime!.usage_baseline_input_tokens).toBe(477758);
          expect(await memoryFacts()).toEqual(memories);
        }
        const saved = await getLatestContextCheckpoint({
          organizationId: f.identity.org,
          workspaceId: f.identity.workspace,
          sessionId: f.chat.id,
          ownerId: f.identity.user,
          configChecksum: runtime!.config_checksum,
        });
        if (historical) expect(saved).toEqual(historical);
        historical = saved;
        expect(historical?.summary).toBe('RETIRED_AUTO_SUMMARY_236');
        expect(
          await f.db`select id from allrice_context_checkpoints where session_id=${f.chat.id}`,
        ).toHaveLength(1);
        expect(
          await f.db`select id from allrice_run_events where run_id=${task.runId} and event_type in ('context.checkpoint.created','context.compaction.started','context.compaction.completed','context.compaction.failed')`,
        ).toEqual([]);
      } finally {
        await task.isolation.cleanup();
      }
    }
    expect(
      (await journal()).filter((e) => e.type.startsWith('compaction/')),
    ).toEqual([]);
  }, 120000);

  it.each([false, true])(
    'checked 资格下真实原生进度等待沿持久暂停回执返回，旧 checkpoint 阈值达到也不生成摘要=%s',
    async (checkpointDue) => {
      const f = await setup(
        async (_request, count) => {
          expect(count).toBeLessThanOrEqual(3);
          if (count === 1)
            await fixture!
              .db`update allrice_conversation_runtimes set compact_threshold_tokens=${checkpointDue ? 1000 : 100000},usage_baseline_input_tokens=0`;
          return {
            nativeTool: { name: 'local_fs_list', arguments: { path: 42 } },
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 5,
              total_tokens: 2005,
            },
          };
        },
        false,
        true,
      );
      await updateUserPreferences(f.context, {
        questionWait: { mode: 'timed', seconds: 1 },
      });
      const historyId = randomUUID();
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,status,content)
        values(${historyId},${f.identity.org},${f.identity.workspace},${f.chat.id},${f.identity.user},'user','completed',
        '{"text":"保留此前整理记录。","citations":[]}')`;
      const task = await prepare(f, '检查目录；遇到重复失败时等我确认。', true);
      expect(task.snapshot.finalDeliveryPolicy?.mode).toBe('checked_native_v1');
      expect(task.snapshot.nativePreferences.questionWait).toEqual({
        mode: 'timed',
        seconds: 1,
      });
      const finalDelivery = vi.spyOn(
        DshProtocolClient.prototype,
        'finalDelivery',
      );
      try {
        const result = await task.run();
        const facts =
          await f.db`select payload->'fact' fact from allrice_run_events
          where run_id=${task.runId} and payload->>'source'='native_model_receipt_v1' order by sequence`;
        // The fourth public stream hits the real progress question BEFORE
        // provider dispatch. It has no native finish; zero-cache proof cannot
        // turn that uncompleted observation into a complete bill.
        expect(facts.filter((r) => r.fact.phase === 'start')).toHaveLength(4);
        const finishes = facts.filter((r) => r.fact.phase === 'finish');
        expect(
          finishes.map((r) => r.fact.usageComplete),
          JSON.stringify(facts),
        ).toEqual([true, true, true, false]);
        expect(finishes.at(-1)!.fact).toMatchObject({
          outcome: 'incomplete',
          usage: {},
        });
        expect(result).toMatchObject({
          answer: '等你回答后继续。',
          waitingForUser: { questionId: expect.any(String) },
          usage: { inputTokens: 6000, cachedInputTokens: 0, outputTokens: 15 },
          usageComplete: false,
        });
        if (!('waitingForUser' in result) || !result.waitingForUser)
          throw Error('Missing native progress wait');
        const questionId = result.waitingForUser.questionId;
        const [question] =
          await f.db`select payload from allrice_run_events where run_id=${task.runId}
          and event_type='harness.native' and payload->>'sourceEventType'='session/user-question'`;
        expect(question!.payload.nativePayload).toMatchObject({
          questionId,
          questions: [expect.objectContaining({ id: 'runtime-progress' })],
        });
        const [paused] =
          await f.db`select pause_id,canceled from allrice_task_progress where run_id=${task.runId}`;
        expect(paused).toEqual({
          pause_id: expect.any(String),
          canceled: false,
        });
        expect(finalDelivery.mock.calls.map(([action]) => action)).toEqual([
          'bind',
        ]);
        expect(
          readCheckedFinalDeliveryForExecution(task.workflowLease, result),
        ).toEqual({ coverage: 'uncovered' });
        const checkpoints =
          await f.db`select covered_through_message_id from allrice_context_checkpoints where session_id=${f.chat.id}`;
        expect(checkpoints).toEqual([]);
        await completeJob({ ...task.workflowLease, result });
        expect(await state(f, task.runId)).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
          text: '等你回答后继续。',
          result: { waitingForUser: { questionId } },
        });
        const [released] =
          await f.db`select active_turn_id,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${f.chat.id}`;
        expect(released).toEqual({
          active_turn_id: null,
          active_run_id: null,
          worker_id: null,
        });
        const [route] =
          await f.db`select id,status,input_tokens,output_tokens,usage_complete from allrice_route_decisions where run_id=${task.runId}`;
        expect(route).toMatchObject({
          status: 'succeeded',
          input_tokens: 6000,
          output_tokens: 15,
          usage_complete: false,
        });
        expect(
          await f.db`select route_decision_id id,status,input_tokens,output_tokens,usage_complete from allrice_model_usage_ledger where route_decision_id=${route!.id}`,
        ).toEqual([route]);
        expect(
          await f.db`select * from allrice_task_progress_decisions where run_id=${task.runId}`,
        ).toHaveLength(0);
        expect(model!.requests).toHaveLength(3);
      } finally {
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  it.each(['missing-proof', 'forged-wait'] as const)(
    '真实 Worker 拒绝 %s：普通答复不能借缺 proof 或伪造等待绕过完成门禁',
    async (mode) => {
      const f = await setup(async () => ({ text: '已完成目录说明。' }));
      const execute = adapter!.execute.bind(adapter);
      vi.spyOn(adapter!, 'execute').mockImplementation(async (input) => ({
        ...(await execute(input)),
        ...(mode === 'forged-wait'
          ? { waitingForUser: { questionId: 'forged' } }
          : {}),
      }));
      const task = await prepare(f, '说明目录用途。');
      try {
        await expect(task.run()).rejects.toMatchObject({
          code:
            mode === 'forged-wait'
              ? 'DSH_TURN_FAILED'
              : 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          retryable: false,
        });
        expect(await state(f, task.runId)).toMatchObject({ successes: 0 });
        expect(model!.requests).toHaveLength(1);
      } finally {
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  it('PR3a 子智能体调用工具前撤销成员权限，真实 Worker 拒绝并收树', async () => {
    let rootCalls = 0;
    let childCalls = 0;
    const f: Setup = await setup(async (request) => {
      if (
        JSON.stringify(
          request.messages.filter((m) => m.role === 'user'),
        ).includes('PR3A_REVOKED_CHILD')
      ) {
        childCalls++;
        await f.db`update allrice_memberships set active=false where organization_id=${f.identity.org} and user_id=${f.identity.user}`;
        return {
          nativeTool: {
            name: 'todo_write',
            arguments: {
              todos: [{ content: '未经授权的新操作', status: 'pending' }],
            },
          },
        };
      }
      if (++rootCalls === 1)
        return {
          nativeTool: {
            name: 'subagent',
            arguments: {
              description: '权限边界',
              prompt: 'PR3A_REVOKED_CHILD',
            },
          },
        };
      return { text: '等待子任务' };
    }, true);
    const task = await prepare(f, '请派一个子智能体整理待办。');
    try {
      await expect(task.run()).rejects.toMatchObject({ retryable: false });
      expect(childCalls).toBe(1);
      expect(await state(f, task.runId)).toMatchObject({ successes: 0 });
      expect(
        (await journal()).filter((e) => e.type === 'todo/write'),
      ).toHaveLength(0);
      expect(adapter!.runtimeInventory()).toHaveLength(0);
    } finally {
      await task.isolation.cleanup();
    }
  }, 45000);

  it('后代晚于根首次 idle 结算并唤醒根：真实 Worker 将后续 turn 写入 PG 后提交', async () => {
    const childEntered = gate(),
      releaseChild = gate(),
      releaseOriginWrite = gate();
    let rootCalls = 0;
    let childCalls = 0;
    const preflight = vi.spyOn(SubscriptionPreflight, 'preflightSubscription');
    const answer = '已汇总子智能体的实际结果。';
    const f = await setup(async (request) => {
      const userInputs = request.messages.filter((m) => m.role === 'user');
      if (JSON.stringify(userInputs).includes('PR1B_CHILD_TASK')) {
        childEntered.release();
        await releaseChild.promise;
        if (++childCalls === 1)
          return {
            nativeTool: {
              name: 'todo_write',
              arguments: {
                todos: [{ content: '核对原生子级权限', status: 'completed' }],
              },
            },
          };
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
    }, true);
    const task = await prepare(f, '启动子任务，结束后汇总，不需要文件。');
    // PR3a: real child identity, authority and progress ports; no child bypass.
    const setHandler = DshProtocolClient.prototype.setRequestHandler;
    vi.spyOn(
      DshProtocolClient.prototype,
      'setRequestHandler',
    ).mockImplementation(function (this: DshProtocolClient, handler) {
      setHandler.call(
        this,
        handler &&
          (async (method, params) => {
            if (method === 'allrice/final-delivery-origin')
              releaseOriginWrite.release();
            return handler(method, params);
          }),
      );
    });
    let heldOriginWrite = false;
    const beginTurn = TurnLifecycle.beginEmployeeConversationTurn;
    vi.spyOn(TurnLifecycle, 'beginEmployeeConversationTurn').mockImplementation(
      async (input) => {
        if (input.turnId.endsWith(':turn:2')) {
          heldOriginWrite = true;
          await releaseOriginWrite.promise;
        }
        return beginTurn(input);
      },
    );
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
      // Five actual calls: three root calls and two child calls, each 20 input / 5 output.
      // Only these fresh receipts contribute; inherited history is not charged.
      expect(result).toMatchObject({
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 25,
        },
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
      expect(heldOriginWrite).toBe(true);
      expect(model!.requests).toHaveLength(5);
      // Once at Run freeze and once per real root/child model dispatch.
      expect(preflight).toHaveBeenCalledTimes(6);
      const calls =
        await f.db`select distinct native_session_id from allrice_task_calls where run_id=${task.runId}`;
      expect(calls.map((row) => row.native_session_id)).toContain(
        coverage.proof.nativeSessionId,
      );
      expect(calls).toHaveLength(2);
      expect(
        (await journal()).filter((e) => e.type === 'todo/write'),
      ).toHaveLength(1);
      expect(JSON.stringify(model!.requests.at(-1)!.messages)).toContain(
        'PR1B_CHILD_RESULT',
      );
    } finally {
      releaseChild.release();
      releaseOriginWrite.release();
      task.controller.abort();
      await task.isolation.cleanup();
    }
  }, 45000);

  it('普通聊天选择已发布 Workflow 时保留既有排除范围，同员工普通任务仍完整检查', async () => {
    const f = await setup(async () => ({ text: '已完成排序流程。' }));
    const workflow = await createWorkflow(f.context, {
      workspaceId: f.identity.workspace,
      slug: 'sort-workflow',
      name: '排序流程',
      description: '按流程解释数组排序',
      definition: {
        schemaVersion: 1,
        steps: [
          {
            key: 'explain',
            name: '解释排序',
            kind: 'model',
            input: { prompt: '解释数组排序，不需要文件。' },
          },
        ],
      },
    });
    await manageEmployeeCapabilities(f.context, {
      workspaceId: f.identity.workspace,
      employeeId: f.identity.employee,
      workflowRevisionIds: [workflow.id],
    });
    const task = await prepare(f, '按工作流执行排序流程，解释数组排序。');
    expect(task.snapshot.capabilitySnapshot.workflows).toHaveLength(1);
    expect(task.snapshot.finalDeliveryPolicy?.mode).toBe('checked_native_v1');
    try {
      const result = await task.run();
      expect(
        readCheckedFinalDeliveryForExecution(task.workflowLease, result),
      ).toEqual({ coverage: 'uncovered' });
      await completeJob({ ...task.workflowLease, result });
      expect(await state(f, task.runId)).toMatchObject({
        status: 'succeeded',
        successes: 1,
      });
      const [route] =
        await f.db`select selected_kind from allrice_route_decisions where run_id=${task.runId}`;
      expect(route!.selected_kind).toBe('workflow');
      const [stored] =
        await f.db`select execution_snapshot from allrice_employee_runs where run_id=${task.runId}`;
      expect(stored!.execution_snapshot).toEqual(task.snapshot);
      const ordinary = await prepare(f, '解释 JavaScript 的数组比较函数。');
      try {
        const ordinaryResult = await ordinary.run();
        const coverage = readCheckedFinalDeliveryForExecution(
          ordinary.workflowLease,
          ordinaryResult,
        );
        expect(coverage.coverage).toBe('checked_native_v1');
        if (coverage.coverage !== 'checked_native_v1')
          throw Error('Installed Workflow suppressed ordinary delivery');
        await completeJob({
          ...ordinary.workflowLease,
          result: ordinaryResult,
          checkedDelivery: coverage.checkedDelivery,
        });
        expect(await state(f, ordinary.runId)).toMatchObject({
          status: 'succeeded',
          successes: 1,
        });
        const [direct] =
          await f.db`select selected_kind from allrice_route_decisions where run_id=${ordinary.runId}`;
        expect(direct!.selected_kind).toBe('direct');
      } finally {
        await ordinary.isolation.cleanup();
      }
    } finally {
      await task.isolation.cleanup();
    }
  }, 45000);

  it.each(['complete', 'reject-origin', 'interrupt'] as const)(
    '公开 wait 返回后已接收的输入仍经候选的最终 wait，真实第二 turn 不丢来源或用量（%s）',
    async (mode) => {
      const entered = gate(),
        release = gate();
      const f = await setup(async (_request, count) => {
        if (count === 2) {
          entered.release();
          await release.promise;
        }
        return { text: count === 1 ? '首轮回复。' : '已结合补充信息。' };
      });
      const task = await prepare(f, '简单说明，不需要文件。');
      const wait = DshProtocolClient.prototype.wait;
      vi.spyOn(DshProtocolClient.prototype, 'wait').mockImplementationOnce(
        async function (this: DshProtocolClient, sessionId) {
          const result = await wait.call(this, sessionId);
          // An actual native input accepted before the Worker pauses ingress.
          await this.prompt(sessionId, '在输入窗口关闭前接收的补充。');
          await entered.promise;
          return result;
        },
      );
      const finalDelivery = DshProtocolClient.prototype.finalDelivery;
      vi.spyOn(DshProtocolClient.prototype, 'finalDelivery').mockImplementation(
        async function (this: DshProtocolClient, action, params) {
          if (action === 'candidate' && mode === 'reject-origin')
            await f.db`delete from allrice_run_events where run_id=${task.runId} and event_type='turn.started'`;
          const result = finalDelivery.call(this, action, params);
          if (action === 'candidate') {
            if (mode === 'interrupt')
              task.controller.abort(Error('interrupt late input'));
            release.release();
          }
          return result;
        },
      );
      try {
        if (mode !== 'complete') {
          await expect(task.run()).rejects.toMatchObject({
            code:
              mode === 'interrupt'
                ? 'EXECUTION_ABORTED'
                : 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
            retryable: false,
          });
          const [route] =
            await f.db`select id,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known from allrice_route_decisions where run_id=${task.runId}`;
          expect(route).toMatchObject({
            input_tokens: mode === 'interrupt' ? 20 : 40,
            cached_input_tokens: 0,
            output_tokens: mode === 'interrupt' ? 5 : 10,
            usage_complete: mode !== 'interrupt',
            cache_usage_known: mode !== 'interrupt',
          });
          expect(
            await f.db`select route_decision_id id,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known from allrice_model_usage_ledger where route_decision_id=${route!.id}`,
          ).toEqual([route]);
          expect(await state(f, task.runId)).toMatchObject({ successes: 0 });
          expect(model!.requests).toHaveLength(2);
          return;
        }
        const result = await task.run();
        const coverage = readCheckedFinalDeliveryForExecution(
          task.workflowLease,
          result,
        );
        if (coverage.coverage !== 'checked_native_v1')
          throw Error('Missing checked native proof');
        const starts =
          await f.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='turn.started' order by sequence`;
        expect(starts).toHaveLength(2);
        expect(starts[1]!.payload.turnId).toBe(
          `${coverage.proof.nativeSessionId}:turn:2`,
        );
        expect(result).toMatchObject({
          answer: '已结合补充信息。',
          usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 },
        });
        await completeJob({
          ...task.workflowLease,
          result,
          checkedDelivery: coverage.checkedDelivery,
        });
        expect(await state(f, task.runId)).toMatchObject({
          status: 'succeeded',
          text: '已结合补充信息。',
          successes: 1,
        });
        expect(model!.requests).toHaveLength(2);
      } finally {
        release.release();
        task.controller.abort();
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  it.each([
    { mode: 'valid', history: false },
    { mode: 'valid', history: true },
    { mode: 'repair', history: true },
  ] as const)(
    '真实资格 $mode / 历史 $history：月报由根 wait 后落库来源与精确版本',
    async ({ mode, history }) => {
      let answer = '';
      const original = `[月报](/api/v1/files/${randomUUID()}/download)`;
      const f = await setup(async (_request, count) => ({
        text: count === 1 && mode === 'repair' ? original : answer,
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 10,
          total_tokens: 2010,
        },
      }));
      // Authorized SQL history bootstraps the first native turn. Later Runs
      // resume its persisted session without synthesizing another summary.
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
        expect(checkpoints).toEqual([]);
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
        // answer/proof must survive the Worker's native context projection.
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
        // Prove continuation through the next real Worker and native history.
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
                  key: `user:${historyMessageId}`,
                  text: 'user: 请继续整理每月记录。',
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

  it.each(['missing-frozen-revision', 'unauthorized'] as const)(
    '异常 Workflow 路由 %s 不绕过根交付守卫',
    async (mode) => {
      const f = await setup(async () => ({ text: '本轮只解释比较函数。' }));
      const task = await prepare(f, '解释数组比较函数，不需要文件。');
      const record = RouteDecisions.recordRouteDecision;
      vi.spyOn(RouteDecisions, 'recordRouteDecision').mockImplementation(
        async (input) => {
          const stored = await record(input);
          const id = `workflow:${randomUUID()}`;
          return {
            ...stored,
            selectedKind: 'workflow',
            selectedCandidateId: id,
            candidates: [
              {
                ...stored.candidates[0]!,
                id,
                kind: 'workflow',
                authorized: mode !== 'unauthorized',
              },
            ],
          };
        },
      );
      try {
        await expect(task.run()).rejects.toMatchObject({
          code:
            mode === 'unauthorized'
              ? 'ROUTE_NOT_AUTHORIZED'
              : 'WORKFLOW_SNAPSHOT_MISSING',
        });
        expect(model!.requests).toHaveLength(0);
        expect(await state(f, task.runId)).toMatchObject({
          status: 'running',
          successes: 0,
        });
      } finally {
        await task.isolation.cleanup();
      }
    },
    45000,
  );

  it('旧子 Run 的同会话真实成果不能经 run_links 混入本轮根成果集合', async () => {
    let answer = '';
    const f = await setup(async () => ({ text: answer }));
    const previous = await prepare(f, '整理上轮月报并给我文件。');
    const artifact = await publishWorkbenchArtifact(
      {
        context: previous.execution.context,
        sessionId: f.chat.id,
        callId: randomUUID(),
        kind: 'document',
        fileName: '旧子月报.txt',
        format: 'text',
        mediaType: 'text/plain',
        bytes: Buffer.from('Old child report'),
      },
      runtimeFixtureStorage(fixture!.db),
      fixture!.db,
    );
    answer = `[月报](/api/v1/files/${artifact.object.id}/download)`;
    try {
      const result = await previous.run();
      const coverage = readCheckedFinalDeliveryForExecution(
        previous.workflowLease,
        result,
      );
      if (coverage.coverage !== 'checked_native_v1')
        throw Error('Previous Run lost checked proof');
      await completeJob({
        ...previous.workflowLease,
        result,
        checkedDelivery: coverage.checkedDelivery,
      });
    } finally {
      await previous.isolation.cleanup();
    }
    const current = await prepare(f, '整理本轮新月报并给我文件。');
    const task = {
      scope: {
        organizationId: f.identity.org,
        workspaceId: f.identity.workspace,
        projectId: null,
      },
      runId: current.runId,
      rootRunId: current.runId,
      parentRunId: null,
      chatSessionId: f.chat.id,
      frozenConfiguration: {
        employeeVersionId: f.identity.version,
        digest: current.snapshot.employee.definitionChecksum,
      },
    };
    await createRuntimeOperationLedger({
      database: f.db,
      admission: async () => {},
    }).createRoot({
      task,
      deadlineAt: new Date(Date.now() + 300000).toISOString(),
      budgets: [
        {
          metric: 'model_calls',
          unit: 'calls',
          currency: null,
          capacity: 5,
          source: { kind: 'worker', sourceId: 'historical-link-fixture' },
        },
      ],
    });
    const child = {
      ...task,
      runId: previous.runId,
      parentRunId: current.runId,
    };
    // Historical bookkeeping only. Both source Run and artifact were created
    // by the real chat/publisher/Worker path, in the same tenant and Session.
    await f.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
      values(${previous.runId},${current.runId},${current.runId},${f.identity.org},${f.identity.workspace},${f.db.json(child)})`;
    try {
      await expect(current.run()).rejects.toMatchObject({
        code: 'FINAL_DELIVERY_RESPONSE_INVALID',
      });
      expect(await state(f, current.runId)).toMatchObject({
        status: 'running',
        successes: 0,
      });
      expect(await state(f, previous.runId)).toMatchObject({
        status: 'succeeded',
        successes: 1,
      });
      expect(model!.requests).toHaveLength(2);
      expect(
        await f.db`select version_id from allrice_workbench_artifacts where version_id=${artifact.id} and run_id=${previous.runId}`,
      ).toHaveLength(1);
    } finally {
      await current.isolation.cleanup();
    }
  }, 45000);

  it('真实 Worker 不用文字修正掩盖 Excel 缺失公式缓存', async () => {
    let answer = '';
    const f = await setup(async () => ({ text: answer }));
    const task = await prepare(f, '把 1 加 1 的结果写到 Excel，给我下载链接。');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('合计').getCell('A1').value = { formula: '1+1' };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const receipt = await checkOfficeExport(bytes, 'xlsx', {
      cloudQualityAllowed: false,
    });
    expect(receipt.savedValues).toMatchObject({
      inspection: 'complete',
      counts: { formulaCount: 1, missingCacheCount: 1 },
    });
    const artifact = await publishWorkbenchArtifact(
      {
        context: task.execution.context,
        sessionId: f.chat.id,
        callId: randomUUID(),
        kind: 'document',
        fileName: '合计.xlsx',
        format: 'xlsx',
        mediaType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes,
        trustedOfficeExport: true,
        officeReceipt: receipt,
      },
      runtimeFixtureStorage(fixture!.db),
      fixture!.db,
    );
    answer = `[合计](/api/v1/files/${artifact.object.id}/download)`;
    try {
      await expect(task.run()).rejects.toMatchObject({
        code: 'FINAL_DELIVERY_RESPONSE_INVALID',
        retryable: false,
      });
      expect(await state(f, task.runId)).toMatchObject({
        status: 'running',
        successes: 0,
      });
      expect(model!.requests).toHaveLength(1);
      expect(
        await f.db`select id from allrice_audit_events where action='artifact.office-quality' and resource_id=${artifact.id}`,
      ).toHaveLength(1);
    } finally {
      await task.isolation.cleanup();
    }
  }, 45000);

  it('真实 Worker proof 不能越过提交前失效的租约', async () => {
    const f = await setup(async () => ({ text: '本轮已解释数组排序。' }));
    const task = await prepare(f, '解释数组排序，不需要文件。');
    try {
      const result = await task.run();
      const coverage = readCheckedFinalDeliveryForExecution(
        task.workflowLease,
        result,
      );
      if (coverage.coverage !== 'checked_native_v1')
        throw Error('Worker lost checked proof');
      const [before] =
        await f.db`select active_run_id,active_turn_id from allrice_conversation_runtimes where session_id=${f.chat.id}`;
      expect(before!.active_turn_id).toBeTruthy();
      await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${task.workflowLease.jobId}`;
      await expect(
        completeJob({
          ...task.workflowLease,
          result,
          checkedDelivery: coverage.checkedDelivery,
        }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      expect(await state(f, task.runId)).toMatchObject({
        status: 'running',
        successes: 0,
      });
      const [after] =
        await f.db`select active_run_id,active_turn_id from allrice_conversation_runtimes where session_id=${f.chat.id}`;
      expect(after).toEqual(before);
      expect(model!.requests).toHaveLength(1);
    } finally {
      await task.isolation.cleanup();
    }
  }, 45000);

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
      const f = await setup(async () => ({
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
    'missing-origin-after-repair',
    'missing-candidate',
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
      const f = await setup(async (_request, count) => {
        if (count === 2 && mode === 'cancel-repair') {
          entered.release();
          await release.promise;
        }
        return {
          ...(mode === 'missing-usage-repair' && count === 2
            ? { usage: null }
            : {}),
          text:
            mode === 'missing-origin' ||
            mode === 'missing-active-turn' ||
            mode === 'missing-candidate' ||
            (mode === 'missing-origin-after-repair' && count === 2)
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
      if (mode === 'wait-error') {
        const actualWait = DshProtocolClient.prototype.wait;
        vi.spyOn(DshProtocolClient.prototype, 'wait').mockImplementationOnce(
          async function (this: DshProtocolClient, sessionId) {
            await actualWait.call(this, sessionId);
            throw Error(
              'synthetic public wait failure after native completion',
            );
          },
        );
      }
      available = `[月报](/api/v1/files/${artifact.object.id}/download)`;
      if (
        mode === 'missing-origin' ||
        mode === 'missing-active-turn' ||
        mode === 'missing-origin-after-repair' ||
        mode === 'missing-candidate'
      ) {
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
            if (
              mode === 'missing-origin' ||
              (mode === 'missing-origin-after-repair' &&
                model!.requests.length === 2)
            )
              await f.db`delete from allrice_run_events where run_id=${task.runId} and event_type='turn.started'`;
            else if (mode === 'missing-active-turn')
              await f.db`update allrice_conversation_runtimes set active_turn_id=null where session_id=${f.chat.id}`;
          }
          const result = await finalDelivery.call(this, action, params);
          // Simulate a missing response at the untyped JSON-RPC boundary.
          return action === 'candidate' && mode === 'missing-candidate'
            ? (null as unknown as Record<string, unknown>)
            : result;
        });
      }
      try {
        const pending = task.run();
        const codes = {
          'wait-error': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'missing-origin': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'missing-active-turn': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'missing-origin-after-repair': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          'missing-candidate': 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
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
          mode === 'missing-active-turn' ||
          mode === 'missing-candidate';
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
          const complete = [
            'wait-error',
            'missing-origin',
            'missing-active-turn',
            'missing-origin-after-repair',
            'missing-candidate',
            'invalid-repair',
          ].includes(mode);
          const facts =
            await f.db`select payload->'fact' fact from allrice_run_events
            where run_id=${task.runId} and payload->>'source'='native_model_receipt_v1'`;
          expect(route!.usage_complete, JSON.stringify(facts)).toBe(complete);
          // Actual finish usage with exact total proves the omitted zero buckets;
          // a canceled/missing-usage attempt still makes the whole receipt unknown.
          expect(route!.cache_usage_known).toBe(complete);
          const ledger =
            await f.db`select route_decision_id id,status,input_tokens,cached_input_tokens,output_tokens,usage_complete,cache_usage_known,cost_cents
              from allrice_model_usage_ledger where route_decision_id=${route!.id}`;
          expect(ledger).toEqual([route]);
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
