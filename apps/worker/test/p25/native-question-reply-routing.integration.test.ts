/** Real message admission -> employee handler -> DSH -> PG. Only the model
 * target and installed executable approval use isolated synthetic fixtures. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
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
import {
  createWorkflow,
  manageEmployeeCapabilities,
} from '../../../../packages/database/src/capabilities/capability-registry.ts';
import * as ModelPool from '../../../../packages/database/src/providers/model-pool.ts';
import { updateNativeQuestionMode } from '../../../../packages/database/src/native-questions.ts';
import { claimNextJob } from '../../../../packages/database/src/execution/queue.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { runClaimedJob } from '../../src/job-runner.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import * as Router from '../../src/harness/router.ts';
import * as NativeArtifact from '../../src/harness/dsh-native-artifact.ts';
import {
  DSH_DISTRIBUTION_CURRENT_GENERATION,
  DSH_DISTRIBUTION_CURRENT_VERSION,
} from '../../src/harness/dsh-distribution.ts';
import { p24Fixture } from '../p24/fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('PR5 native reply routing through the actual employee handler', () => {
  let fixture:
    Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined;
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
  async function setup(reply: Parameters<typeof p24Fixture>[0]) {
    // This historical fixture seeds an unused assistant root. Product chat
    // admission below runs with the switch off and no assistant preference.
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    const artifactId = `sha256:${'a'.repeat(64)}`;
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifactId);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifactId);
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'native-reply-routing-')),
    );
    vi.stubEnv('ALLRICE_STORAGE_ROOT', join(directory, 'storage'));
    vi.stubEnv(
      'ALLRICE_DSH_PLATFORM_HOME',
      join(directory, 'unused-platform-home'),
    );
    fixture = await createAssistantFixtureDatabase();
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
    const db = fixture.db;
    const identity = await createAssistantAuthorityFixture(db, {
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
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    const login = await createSession(identity.user);
    const context = (await authenticateSession(login.token, {
      organizationId: identity.org,
      workspaceId: identity.workspace,
    }))!;
    await authorizeFixturePlatformAdministrator(db, identity.user);
    await updateNativeQuestionMode(context, 'timed');
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
  async function send(
    f: Setup,
    text: string,
    answer?: {
      questionId: string;
      answers: { id: string; selected: string[] }[];
    },
  ) {
    return sendChatMessage(f.context, f.identity.workspace, f.chat.id, {
      clientMessageId: randomUUID(),
      text,
      ...(answer
        ? { userQuestionAnswer: answer }
        : { deliveryMode: 'follow_up' }),
      assistantPreference: { mode: 'daily', allowAssistants: false },
    });
  }
  async function execute(f: Setup, runId: string) {
    const workerId = randomUUID();
    const job = (await claimNextJob(workerId, 300000))!;
    expect(job.id).toBe(
      (await f.db`select id from allrice_jobs where run_id=${runId}`)[0]!.id,
    );
    await runClaimedJob(
      {
        workerId,
        jobId: job.id,
        leaseToken: job.lease!.token,
        leaseMs: 300000,
        heartbeatMs: 1000,
        executionRoot: join(directory!, 'execution'),
        stopping: () => false,
        onAbortReady() {},
      },
      executeEmployeeRun,
    );
    const [run] =
      await f.db`select r.state,r.error,j.status,j.lease_token from allrice_runs r
      join allrice_jobs j on j.run_id=r.id where r.id=${runId}`;
    expect(run).toMatchObject({
      state: 'succeeded',
      status: 'succeeded',
      lease_token: null,
    });
  }
  it('keeps installed Workflow chat routing while a native answer resumes only its original ordinary DSH question', async () => {
    const f = await setup(async (_r, index) =>
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
        : { text: '已完成本次工作。' },
    );
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
            input: { prompt: '解释数组排序。' },
          },
        ],
      },
    });
    await manageEmployeeCapabilities(f.context, {
      workspaceId: f.identity.workspace,
      employeeId: f.identity.employee,
      workflowRevisionIds: [workflow.id],
    });
    // The source is an ordinary native DSH turn, with a Workflow installed but
    // unselected. Workflow program questions retain their existing boundary.
    const initial = await send(f, '先问我需要决定的地方，其他内容继续完成。');
    await execute(f, initial.run.id);
    const [q] =
      await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
    expect(q).toMatchObject({
      state: 'continued',
      source_run_id: initial.run.id,
    });
    const [sourceRoute] =
      await f.db`select selected_kind from allrice_route_decisions where run_id=${initial.run.id}`;
    expect(sourceRoute!.selected_kind).toBe('direct');
    const prompts = vi.spyOn(DshProtocolClient.prototype, 'prompt');
    const answer = {
      questionId: `${q!.native_session_id}:${q!.call_id}`,
      answers: [{ id: 'choice', selected: [] }],
    };
    // Deliberately names the installed Workflow: routing the answer text as a
    // new task would select it. The private reply still must call DSH.answer().
    const reply = await send(f, '按工作流执行排序流程，解释数组排序。', answer);
    const [frozen] =
      await f.db`select execution_snapshot from allrice_employee_runs where run_id=${reply.run.id}`;
    expect(
      frozen!.execution_snapshot.capabilitySnapshot.workflows,
    ).toHaveLength(1);
    await execute(f, reply.run.id);
    expect(prompts).not.toHaveBeenCalled();
    expect(
      await f.db`select state,native_proof->>'callId' call_id from allrice_conversation_commands where followup_run_id=${reply.run.id}`,
    ).toEqual([{ state: 'consumed', call_id: q!.call_id }]);
    expect(
      await f.db`select id from allrice_workflow_runs where run_id=${reply.run.id}`,
    ).toHaveLength(0);
    expect(
      (
        await f.db`select execution_snapshot from allrice_employee_runs where run_id=${reply.run.id}`
      )[0]!.execution_snapshot,
    ).toEqual(frozen!.execution_snapshot);
    const normal = await send(f, '按工作流执行排序流程，解释数组排序。');
    await execute(f, normal.run.id);
    const [normalRoute] =
      await f.db`select selected_kind from allrice_route_decisions where run_id=${normal.run.id}`;
    expect(normalRoute!.selected_kind).toBe('workflow');
    expect(
      await f.db`select id from allrice_workflow_runs where run_id=${normal.run.id}`,
    ).toHaveLength(1);
  }, 60000);
});
