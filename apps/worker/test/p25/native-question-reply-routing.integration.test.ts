/** Real employee Worker/native Host/PG regressions, synthetic model only. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setupNativeReplyEmployee,
  sendNativeReplyMessage as send,
  executeNativeReplyJob as execute,
} from './native-question-employee.fixture.ts';
import { skillBytesChecksum } from '../../../../packages/database/src/skill-bundles.ts';
import { runtimePolicyDigest } from '../../../../packages/database/src/runtime-policy.ts';
import {
  getEmployeeInstance,
  updateEmployeeInstance,
} from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  createWorkflow,
  manageEmployeeCapabilities,
} from '../../../../packages/database/src/capabilities/capability-registry.ts';
import { updateNativeQuestionMode } from '../../../../packages/database/src/native-questions.ts';
import { maintainQueue } from '../../../../packages/database/src/execution/queue.ts';
import type { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import type { p24Fixture } from '../p24/fixture.ts';
import { experienceSkillFixture } from '../../../../packages/database/src/experience-skill.fixture.ts';
import { managePersonalSkill } from '../../../../packages/database/src/employees/personal-skills.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('PR5 native reply routing through the actual employee handler', () => {
  let closeSetup: (() => Promise<void>) | undefined;
  let model: Awaited<ReturnType<typeof p24Fixture>> | undefined;
  let adapter: DshHarnessAdapter | undefined;
  afterEach(async () => {
    await closeSetup?.();
    closeSetup = undefined;
    model = undefined;
    adapter = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }, 30000);
  async function setup(reply: Parameters<typeof p24Fixture>[0]) {
    const f = await setupNativeReplyEmployee(reply);
    closeSetup = f.close;
    model = f.model;
    adapter = f.adapter;
    const restart = f.restartHost;
    f.restartHost = async () => {
      await restart();
      adapter = f.adapter;
    };
    return f;
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
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
  it('PR5 restores the original published scene after v2 without losing the native Session', async () => {
    const sceneId = randomUUID(),
      setId = randomUUID();
    const f = await setup(async (_request, index) =>
      index === 1
        ? ask
        : index === 3
          ? {
              nativeTool: {
                name: 'skill',
                arguments: { name: `allrice-scene-${sceneId}` },
              },
            }
          : { text: '已按原题场景继续。' },
    );
    async function publish(number: number) {
      const revisionId = randomUUID();
      const manifest = {
        schemaVersion: 1,
        common: [],
        scenes: [
          {
            id: sceneId,
            name: `V${number} 原题场景`,
            appliesWhen: `V${number} 固定合成任务`,
            references: [],
          },
        ],
        declaredConflicts: [],
      };
      if (number === 1)
        await f.db`insert into allrice_employee_content_sets(id,organization_id,workspace_id,employee_id,scope,created_by)
        values(${setId},${f.identity.org},${f.identity.workspace},${f.identity.employee},'company',${f.identity.user})`;
      await f.db`insert into allrice_employee_content_revisions(id,set_id,number,manifest,digest,change_summary,created_by)
        values(${revisionId},${setId},${number},${f.db.json(manifest)},${runtimePolicyDigest(manifest)},'Published fixture',${f.identity.user})`;
      await f.db`insert into allrice_employee_content_publications(set_id,revision_id) values(${setId},${revisionId})`;
      await f.db`update allrice_employee_content_sets set revision=${number},active_revision_id=${revisionId},candidate_revision_id=${revisionId} where id=${setId}`;
      return revisionId;
    }
    const v1 = await publish(1);
    const source = await send(f, '固定合成任务，先问我再继续。');
    await execute(f, source.run.id);
    const [q] =
      await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
    await publish(2);
    const reply = await send(f, '继续原题 V1', {
      questionId: `${q!.native_session_id}:${q!.call_id}`,
      answers: [{ id: 'choice', selected: [] }],
    });
    await f.restartHost();
    const prompt = vi.spyOn(DshProtocolClient.prototype, 'prompt');
    await execute(f, reply.run.id);
    expect(prompt).not.toHaveBeenCalled();
    const [frozen] =
      await f.db`select execution_snapshot,content_scene_state from allrice_employee_runs where run_id=${reply.run.id}`;
    expect(frozen!.execution_snapshot.content.layers[0].revisionId).toBe(v1);
    expect(frozen!.content_scene_state.adopted.sceneId).toBe(sceneId);
    expect(
      (
        await f.db`select thread_id from allrice_conversation_runtimes where session_id=${f.chat.id}`
      )[0]!.thread_id,
    ).toBe(q!.native_session_id);
    const result = JSON.stringify(
      model!.requests
        .at(-1)!
        .messages.filter((m) => m.role === 'tool')
        .at(-1)?.content,
    );
    expect(result).toContain('V1 原题场景');
    expect(result).not.toContain('V2 原题场景');
  }, 60000);
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
