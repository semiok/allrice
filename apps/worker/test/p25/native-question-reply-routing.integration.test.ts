/** Real message admission -> employee handler -> DSH -> PG. Only the model
 * target and installed executable approval use isolated synthetic fixtures. */
import { randomUUID } from 'node:crypto';
import { skillBytesChecksum } from '../../../../packages/database/src/skill-bundles.ts';
import { runtimePolicyDigest } from '../../../../packages/database/src/runtime-policy.ts';
import {
  getEmployeeInstance,
  updateEmployeeInstance,
} from '../../../../packages/database/src/employees/employee-instances.ts';
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
import {
  claimNextJob,
  maintainQueue,
} from '../../../../packages/database/src/execution/queue.ts';
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
import { experienceSkillFixture } from '../../../../packages/database/src/experience-skill.fixture.ts';
import { managePersonalSkill } from '../../../../packages/database/src/employees/personal-skills.ts';
import type { HarnessEvent } from '@allrice/contracts';

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
    const makeAdapter = () =>
      new DshHarnessAdapter({
        runtimeRoot: join(directory!, 'native'),
        idleCloseMs: 0,
        requestTimeoutMs: 15000,
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-loopback-only' }),
        },
      });
    adapter = makeAdapter();
    const router = vi
      .spyOn(Router, 'getHarnessRouter')
      .mockReturnValue(new Router.HarnessRouter([adapter]));
    const restartHost = async () => {
      await adapter!.close();
      adapter = makeAdapter();
      router.mockReturnValue(new Router.HarnessRouter([adapter]));
    };
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
    return { db, identity, context, chat, artifactId, restartHost };
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
        : {
            deliveryMode: 'follow_up',
            assistantPreference: { mode: 'daily', allowAssistants: false },
          }),
    });
  }
  async function execute(
    f: Setup,
    runId: string,
    state = 'succeeded',
    hooks: {
      onEvent?(event: HarnessEvent): Promise<void>;
      crashAfterHandler?: boolean;
    } = {},
  ) {
    const workerId = randomUUID();
    const job = (await claimNextJob(workerId, 300000))!;
    expect(job.id).toBe(
      (await f.db`select id from allrice_jobs where run_id=${runId}`)[0]!.id,
    );
    let crashed = false;
    await runClaimedJob(
      {
        workerId,
        jobId: job.id,
        leaseToken: job.lease!.token,
        leaseMs: 300000,
        heartbeatMs: 1000,
        executionRoot: join(directory!, 'execution'),
        stopping: () => crashed,
        onAbortReady() {},
      },
      async (input) => {
        const result = await executeEmployeeRun({
          ...input,
          onHarnessEvent: async (event) => {
            await input.onHarnessEvent(event);
            await hooks.onEvent?.(event);
          },
        });
        if (hooks.crashAfterHandler) {
          // Real command/Host result is committed; simulate process loss before
          // runClaimedJob can call completeJob. Recover through maintainQueue.
          await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${job.id}`;
          crashed = true;
          throw Error(
            'Synthetic crash after terminal command, before completeJob',
          );
        }
        return result;
      },
    );
    const [run] =
      await f.db`select r.state,r.result,r.error_code,j.last_error_code,j.last_error_message,j.status,j.lease_token from allrice_runs r
      join allrice_jobs j on j.run_id=r.id where r.id=${runId}`;
    expect(run).toMatchObject({
      state,
      status: state,
      lease_token: crashed ? job.lease!.token : null,
    });
    return run!;
  }
  const ask = {
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
  };
  async function seedSkill(f: Setup) {
    const [chat] =
      await f.db`select employee_instance_id from allrice_chat_sessions where id=${f.chat.id}`;
    const skill = experienceSkillFixture({
      organizationId: f.identity.org,
      ownerId: f.identity.user,
      instanceId: chat!.employee_instance_id,
    });
    const pin = skill.pin;
    await f.db.begin(async (tx) => {
      await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id)
        values(${pin.installationId},${pin.organizationId},${pin.ownerId},${skill.definition.name},'installed',${pin.versionId})`;
      await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${pin.versionId},${pin.organizationId},${pin.ownerId},${pin.installationId},1,${tx.json({ kind: 'attachment', objectId: randomUUID(), fileName: 'SKILL.md', originalChecksum: skill.definition.checksum, byteLength: Buffer.byteLength(skill.definition.content) })},${skill.definition.content},${tx.json(skill.definition)},${pin.definitionChecksum})`;
      await tx`insert into allrice_personal_skill_bindings(id,organization_id,workspace_id,owner_id,instance_id,installation_id,enabled,epoch)
        values(${pin.bindingId},${pin.organizationId},${f.identity.workspace},${pin.ownerId},${pin.instanceId},${pin.installationId},true,1)`;
    });
    return skill;
  }
  it.each(['warm', 'cold', 'revoked', 'published-v2'] as const)(
    'PR5 preserves a real Run-specific Skill context for a %s native answer',
    async (phase) => {
      const f = await setup(async (_r, index) =>
        index === 1 ? ask : { text: '已完成。' },
      );
      const skill = await seedSkill(f);
      const source = await send(f, '需要决定的地方先问我，其他工作继续。');
      await execute(f, source.run.id);
      const [q] =
        await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
      const [origin] =
        await f.db`select content_generation_id,execution_snapshot from allrice_employee_runs where run_id=${source.run.id}`;
      expect(origin!.execution_snapshot.personalSkills.skills).toHaveLength(1);
      expect(q!.native_session_id).toBe(
        `dsh-${f.chat.id}-${origin!.content_generation_id}-${source.run.id}`,
      );
      if (phase === 'published-v2') {
        const content =
          skill.definition.content +
          '\n新版要求：只输出 V2；本次原题续接不应采用。';
        const definition = {
          ...skill.definition,
          content,
          checksum: skillBytesChecksum(content),
        };
        const v2 = randomUUID();
        await f.db`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
          select ${v2},organization_id,owner_id,installation_id,2,source,${content},${f.db.json(definition)},${runtimePolicyDigest(definition)}
          from allrice_personal_skill_versions where id=${skill.pin.versionId}`;
        await f.db`update allrice_personal_skill_installations set current_version_id=${v2} where id=${skill.pin.installationId}`;
        const instance = await getEmployeeInstance(
          f.context,
          skill.pin.instanceId,
        );
        await updateEmployeeInstance(f.context, instance.id, {
          workspaceId: f.identity.workspace,
          expectedRevision: instance.revision,
          requestId: randomUUID(),
          profile: { expressionStyle: 'concise' },
        });
        await f.restartHost();
      }
      const reply = await send(f, '跳过本题', {
        questionId: `${q!.native_session_id}:${q!.call_id}`,
        answers: [{ id: 'choice', selected: [] }],
      });
      if (phase === 'cold') await f.restartHost();
      if (phase === 'revoked')
        await managePersonalSkill(f.context, {
          operation: 'disable',
          workspaceId: f.identity.workspace,
          expectedRevision: 1,
          instanceId: skill.pin.instanceId,
          installationId: skill.pin.installationId,
          requestId: randomUUID(),
        });
      const prompts = vi.spyOn(DshProtocolClient.prototype, 'prompt');
      const nativeReply = vi.spyOn(
        DshProtocolClient.prototype,
        'typedQuestionReply',
      );
      const requests = model!.requests.length;
      await execute(
        f,
        reply.run.id,
        phase === 'revoked' ? 'failed' : 'succeeded',
      );
      expect(prompts).not.toHaveBeenCalled();
      if (phase === 'revoked') {
        expect(nativeReply).not.toHaveBeenCalled();
        expect(model!.requests).toHaveLength(requests);
        expect(
          await f.db`select state from allrice_conversation_commands where followup_run_id=${reply.run.id}`,
        ).toEqual([{ state: 'rejected' }]);
        expect(
          (
            await f.db`select state from allrice_native_questions where session_id=${f.chat.id}`
          )[0]!.state,
        ).toBe('continued');
      } else {
        expect(nativeReply).toHaveBeenCalled();
        expect(
          (
            await f.db`select thread_id from allrice_conversation_runtimes where session_id=${f.chat.id}`
          )[0]!.thread_id,
        ).toBe(q!.native_session_id);
        expect(
          (
            await f.db`select content_generation_id from allrice_employee_runs where run_id=${reply.run.id}`
          )[0]!.content_generation_id,
        ).toBe(origin!.content_generation_id);
        expect(
          (
            await f.db`select state,native_proof from allrice_conversation_commands where followup_run_id=${reply.run.id}`
          )[0],
        ).toMatchObject({
          state: 'consumed',
          native_proof: { messageId: `${q!.native_session_id}:${q!.call_id}` },
        });
      }
    },
    60000,
  );
  it.each(['consumed', 'rejected'] as const)(
    'PR5 recovers the actual %s receipt Job after a crash before completeJob',
    async (terminal) => {
      const f = await setup(async (_r, index) =>
        index === 1 ? ask : { text: '已完成。' },
      );
      const source = await send(f, '先问我需要决定的地方。');
      await execute(f, source.run.id);
      const [q] =
        await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
      const answer = {
        questionId: `${q!.native_session_id}:${q!.call_id}`,
        answers: [{ id: 'choice', selected: [] as string[] }],
      };
      const first = await send(f, '跳过', answer);
      const duplicate = await send(f, '另一客户端回答', {
        ...answer,
        answers: [
          { id: 'choice', selected: terminal === 'rejected' ? ['B'] : [] },
        ],
      });
      await execute(f, first.run.id);
      await execute(f, duplicate.run.id, 'running', {
        crashAfterHandler: true,
      });
      const [committed] =
        await f.db`select state,native_proof,error_code,delivery_attempts from allrice_conversation_commands where followup_run_id=${duplicate.run.id}`;
      expect(committed!.state).toBe(terminal);
      const requests = model!.requests.length;
      const nativeReply = vi.spyOn(
        DshProtocolClient.prototype,
        'typedQuestionReply',
      );
      const prompt = vi.spyOn(DshProtocolClient.prototype, 'prompt');
      await f.restartHost();
      expect((await maintainQueue()).recover_lease).toBe(1);
      const receipt = await execute(f, duplicate.run.id);
      expect(receipt.result.answer).toContain(
        terminal === 'consumed' ? '已经回答过' : '没有被采用',
      );
      expect(Object.values(receipt.result.usage).every((n) => n === 0)).toBe(
        true,
      );
      expect(nativeReply).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(model!.requests).toHaveLength(requests);
      expect(
        await f.db`select state,native_proof,error_code,delivery_attempts from allrice_conversation_commands where followup_run_id=${duplicate.run.id}`,
      ).toEqual([committed]);
      expect(
        await f.db`select id from allrice_run_events where run_id=${duplicate.run.id} and payload->>'sourceEventType'='turn/start'`,
      ).toHaveLength(0);
    },
    60000,
  );
  it.each(['same', 'different'] as const)(
    'PR5 preserves the second %s digest input admitted in the live foreground window',
    async (digest) => {
      let questionReady!: () => void,
        bothAdmitted!: () => void,
        finishModel!: () => void;
      const ready = new Promise<void>((r) => {
        questionReady = r;
      });
      const admitted = new Promise<void>((r) => {
        bothAdmitted = r;
      });
      const modelGate = new Promise<void>((r) => {
        finishModel = r;
      });
      const f = await setup(async (_r, index) => {
        if (index === 1)
          return {
            nativeTool: {
              ...ask.nativeTool,
              arguments: { ...ask.nativeTool.arguments, timeout: -1 },
            },
          };
        await modelGate;
        return { text: '已完成。' };
      });
      const steer = adapter!.steer.bind(adapter!);
      let firstId: string | undefined;
      vi.spyOn(adapter!, 'steer').mockImplementation(async (input) => {
        await admitted;
        if (input.clientUserMessageId !== firstId && digest === 'same')
          return {
            status: 'pending',
            inputId: input.clientUserMessageId!,
            messageId: JSON.parse(
              input.message.slice('allrice:user-question:v1:'.length),
            ).questionId,
          };
        try {
          return await steer(input);
        } catch (error) {
          expect(digest).toBe('different');
          expect(String(error)).toContain('QUESTION_ANSWER_NOT_ADOPTED');
          throw error;
        } finally {
          if (digest === 'same' || input.clientUserMessageId !== firstId)
            finishModel();
        }
      });
      const source = await send(f, '阻塞提问，收到我的回答再继续。');
      const running = execute(f, source.run.id, 'succeeded', {
        onEvent: async (e) => {
          if (
            e.type === 'native.event' &&
            e.sourceEventType === 'session/user-questions' &&
            (e.sourcePayload as { questions?: { active?: unknown[] } })
              ?.questions?.active?.length
          )
            questionReady();
        },
      });
      try {
        await ready;
        const [q] =
          await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
        expect(q!.state).toBe('open');
        const answer = {
          questionId: `${q!.native_session_id}:${q!.call_id}`,
          answers: [{ id: 'choice', selected: [] as string[] }],
        };
        const first = await send(f, '跳过', answer);
        const second = await send(f, '另一客户端', {
          ...answer,
          answers: [
            { id: 'choice', selected: digest === 'different' ? ['B'] : [] },
          ],
        });
        expect(first.delivery).toBe('steer_pending');
        expect(second.delivery).toBe('steer_pending');
        firstId = (
          await f.db`select client_user_message_id from allrice_conversation_commands where followup_run_id=${first.fallbackRunId!}`
        )[0]!.client_user_message_id;
        bothAdmitted();
        await running;
        const secondRun = second.fallbackRunId!;
        expect(
          (
            await f.db`select c.state,c.native_proof,f.mode,f.state followup_state from allrice_conversation_commands c join allrice_conversation_followups f on f.run_id=c.followup_run_id where c.followup_run_id=${secondRun}`
          )[0],
        ).toMatchObject({
          state: digest === 'same' ? 'pending' : 'rejected',
          mode: 'follow_up',
          followup_state: 'released',
        });
        const requests = model!.requests.length;
        const prompt = vi.spyOn(DshProtocolClient.prototype, 'prompt');
        const receipt = await execute(f, secondRun);
        expect(
          (
            await f.db`select state from allrice_conversation_commands where followup_run_id=${secondRun}`
          )[0]!.state,
        ).toBe(digest === 'same' ? 'consumed' : 'rejected');
        expect(receipt.result.usageComplete).toBe(true);
        expect(Object.values(receipt.result.usage).every((n) => n === 0)).toBe(
          true,
        );
        expect(model!.requests).toHaveLength(requests);
        expect(prompt).not.toHaveBeenCalled();
        expect(
          await f.db`select id from allrice_run_events where run_id=${secondRun} and payload->>'sourceEventType'='turn/start'`,
        ).toHaveLength(0);
      } finally {
        bothAdmitted();
        finishModel();
        await running;
      }
    },
    60000,
  );

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
    const notices = await f.db`select payload->>'sourceEventType' kind,
      payload->'nativePayload'->>'sessionId' native_session_id,
      payload->'nativePayload'->>'sequence' sequence
      from allrice_run_events where run_id=${initial.run.id}
        and payload->>'sourceEventType' in ('session/user-questions','session/user-question') order by sequence`;
    const bindings =
      await f.db`select native_session_id,context_kind,context_id,first_run_id
      from allrice_native_session_bindings where context_id=${f.chat.id}`;
    const runtime =
      await f.db`select thread_id,thread_generation from allrice_conversation_runtimes where session_id=${f.chat.id}`;
    console.log(
      'PR5 actual native identity',
      JSON.stringify({
        chat: f.chat.id,
        sourceRun: initial.run.id,
        notices,
        bindings,
        runtime,
        projected: !!q,
      }),
    );
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
    const same = await send(f, '另一客户端也跳过本题。', answer);
    const different = await send(f, '另一客户端选择 B。', {
      ...answer,
      answers: [{ id: 'choice', selected: ['B'] }],
    });
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
    const requestsBeforeReceipts = model!.requests.length;
    for (const [duplicate, status] of [
      [same, 'consumed'],
      [different, 'rejected'],
    ] as const) {
      const receipt = await execute(f, duplicate.run.id);
      expect(receipt.result.usageComplete).toBe(true);
      expect(Object.values(receipt.result.usage).every((n) => n === 0)).toBe(
        true,
      );
      expect(
        await f.db`select state from allrice_conversation_commands where followup_run_id=${duplicate.run.id}`,
      ).toEqual([{ state: status }]);
      expect(
        await f.db`select id from allrice_run_events where run_id=${duplicate.run.id}
        and payload->>'sourceEventType'='turn/start'`,
      ).toHaveLength(0);
    }
    expect(model!.requests.length).toBe(requestsBeforeReceipts);
    expect(prompts).not.toHaveBeenCalled();
    const normal = await send(f, '按工作流执行排序流程，解释数组排序。');
    await execute(f, normal.run.id);
    const [normalRoute] =
      await f.db`select selected_kind from allrice_route_decisions where run_id=${normal.run.id}`;
    expect(normalRoute!.selected_kind).toBe('workflow');
    expect(
      await f.db`select id from allrice_workflow_runs where run_id=${normal.run.id}`,
    ).toHaveLength(1);
  }, 60000);
  it('rechecks revocation after admission before a real reply Job can reach the native Host', async () => {
    const f = await setup(async (_r, index) =>
      index === 1
        ? {
            nativeTool: {
              name: 'ask_user_question',
              arguments: {
                questions: [
                  {
                    id: 'choice',
                    question: '继续？',
                    options: [{ label: 'A' }],
                  },
                ],
                timeout: 1,
              },
            },
          }
        : { text: '已完成独立工作。' },
    );
    const initial = await send(f, '先问我需要决定的地方，其他内容继续完成。');
    await execute(f, initial.run.id);
    const [q] =
      await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
    const answer = {
      questionId: `${q!.native_session_id}:${q!.call_id}`,
      answers: [{ id: 'choice', selected: [] }],
    };
    const reply = await send(f, '跳过本题。', answer);
    await updateNativeQuestionMode(f.context, 'legacy');
    const prompts = vi.spyOn(DshProtocolClient.prototype, 'prompt');
    const nativeReply = vi.spyOn(
      DshProtocolClient.prototype,
      'typedQuestionReply',
    );
    const requests = model!.requests.length;
    await execute(f, reply.run.id, 'failed');
    expect(prompts).not.toHaveBeenCalled();
    expect(nativeReply).not.toHaveBeenCalled();
    expect(model!.requests).toHaveLength(requests);
    expect(
      await f.db`select state from allrice_conversation_commands where followup_run_id=${reply.run.id}`,
    ).toEqual([{ state: 'rejected' }]);
    expect(
      await f.db`select closed_at,answers from allrice_native_questions where session_id=${f.chat.id}`,
    ).toEqual([{ closed_at: expect.any(Date), answers: null }]);
  }, 60000);
});
