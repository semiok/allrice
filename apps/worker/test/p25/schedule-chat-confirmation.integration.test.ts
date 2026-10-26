import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FixedRecurringScheduleRule } from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createChatSession,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
import { initializeNativeRecurringPartition } from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import { initializeNativeOncePartition } from '../../../../packages/database/src/native-schedule-once-product.ts';
import {
  claimNextJob,
  startClaimedJob,
  failJob,
} from '../../../../packages/database/src/execution/queue.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../../../../packages/database/src/employees/employee-config.ts';
import { updateWorkAutomation } from '../../../../packages/database/src/work-automation.ts';
import { createAutomation as automationHandler } from '../../src/tool-broker/handlers/automation.ts';
import type { RiceToolHandlerContext } from '../../src/tool-broker/types.ts';

type Rule = FixedRecurringScheduleRule;
const every = (seconds: number): Rule => ({ kind: 'every', seconds });
const at = (
  time: string,
  timezone = 'Asia/Shanghai',
  weekdays?: number[],
): Rule =>
  weekdays
    ? { kind: 'weekly', weekdays, time, timezone }
    : { kind: 'daily', time, timezone };

/** Real chat wording, desensitized (check words replaced). Sources are
 * allrice_messages id prefixes from the old Dev (huihuimac), its 10-24 copy
 * and the M1 Dev, plus the wording table in MET-202 #7 (run d1043dbc). Each
 * rule is what a model is expected to call with; no wording is derived from
 * the server's own patterns. */
const corpus: { text: string; source: string; rules: Rule[] }[] = [
  {
    text: '弄个定时，每 2 分钟提醒我去吃饭',
    source: '073f8cdc / MET-202 #7 原话',
    rules: [every(120)],
  },
  {
    text: '设个提醒，每隔 2 分钟提醒我喝水',
    source: 'MET-202 #7',
    rules: [every(120)],
  },
  { text: '每两分钟喊我一次吃饭', source: 'MET-202 #7', rules: [every(120)] },
  { text: '2 分钟提醒我一次去吃饭', source: 'MET-202 #7', rules: [every(120)] },
  {
    text: '每小时提醒我站起来活动',
    source: 'MET-202 #7',
    rules: [every(3600)],
  },
  { text: '每 2 分钟提醒我去吃饭', source: 'MET-202 #7', rules: [every(120)] },
  {
    text: '帮我每两分钟提醒我去吃饭',
    source: 'MET-202 #7',
    rules: [every(120)],
  },
  {
    text: '每 2 分钟提醒我去吃饭吧',
    source: 'MET-202 #7',
    rules: [every(120)],
  },
  {
    text: '每 2 分钟就提醒我一次，要吃药',
    source: '2cdbba23',
    rules: [every(120)],
  },
  {
    text: '每 2 分钟就提醒我一次，要喝水',
    source: '3d6d0fbd',
    rules: [every(120)],
  },
  {
    text: '搞个定时任务，两分钟提醒我喝水',
    source: '044c50ee',
    rules: [every(120)],
  },
  { text: '每 2 分钟提醒我泡茶', source: 'b9d67025', rules: [every(120)] },
  {
    text: '每周一早上 9 点提醒我写周报',
    source: 'd556b5d4 / MET-202 #3',
    rules: [at('09:00:00', 'Asia/Shanghai', [1])],
  },
  {
    text: '12 个小时监控一次，如果出现信号就推送，每天 早上九点和晚上九点',
    source: 'fdddf413',
    rules: [at('09:00:00'), at('21:00:00')],
  },
  {
    text: '请每隔两分钟，在当前对话中只回复校验词「RECURRING-CHAT-1」。请实际创建周期任务，不要现在执行。',
    source: 'f85eb410',
    rules: [every(120)],
  },
  {
    text: '请每天00:33:08，时区UTC，在当前对话中只回复校验词「RECURRING-CHAT-2」。请实际创建周期任务，不要现在执行。',
    source: '8b9979d0',
    rules: [at('00:33:08', 'UTC')],
  },
  {
    text: '请从现在起每隔1分钟，在当前对话中提醒我喝水，并附上校验词「M1-EVERY-1」。请创建周期提醒。',
    source: '9ce04def',
    rules: [every(60)],
  },
  {
    text: '请每周五02:49:43，时区Asia/Shanghai，在当前对话中只回复校验词「WEEKLY-1」。请实际创建周期任务，不要现在执行。',
    source: '526b03a6',
    rules: [at('02:49:43', 'Asia/Shanghai', [5])],
  },
];
/** Not reminder requests. A model mistakenly calling the tool on them must
 * still not enroll anything unless the human confirms the exact rule. */
const notRequests = [
  { text: '你有定时任务工具吗', source: 'f13978a0' },
  { text: '我习惯把项目周会安排在每周三下午。', source: '79ad377a' },
  { text: '刚才两次提醒分别提醒我做什么？简短概括即可。', source: 'fd757327' },
  {
    text: '请记住我的股票观察名单：A、B、C。只是保存名单，不查询行情，不创建定时任务。',
    source: '8ab80b2f',
  },
];

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

/** User view: a chat message goes in, the model (a stub here) calls the real
 * automation.create handler, and either a recurring task row exists or the
 * human is shown a card. No wording is ever refused outright. */
suite(
  'setting a reminder from chat ends in a task row (MET-210 #2)',
  { timeout: 120_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    /** As DSH does: record the tool call in the Run ledger at start, then
     * dispatch to the production handler, then mark it finished. */
    async function createAutomation(context: RiceToolHandlerContext) {
      const { runId } = context.input.context,
        callId = context.input.call.id;
      await f.db`insert into allrice_task_calls(run_id,native_session_id,call_id,kind,name)
        values(${runId},'synthetic-reminder-chat',${callId},'tool','automation_create') on conflict do nothing`;
      try {
        return await automationHandler(context);
      } finally {
        await f.db`update allrice_task_calls set finished_at=clock_timestamp()
          where run_id=${runId} and call_id=${callId} and kind='tool' and finished_at is null`;
      }
    }
    let root: string;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      const manifest = employeeManifest({
        key: 'p27-codex-worker',
        name: 'Reminder chat fixture',
        description: 'Stub model, real tool handler and SQL',
        toolNames: ['automation.create'],
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-codex',
          model: 'gpt-5.6-luna',
          reasoningEffort: 'low',
          timeoutMs: f.runLimits.timeoutMs,
          fallbackModels: [],
          credentialReference: 'deployment:codex-default',
          baseUrl: null,
        },
        securityPolicy: {
          dataScopes: ['workspace'],
          connectorIdentityModes: ['user'],
          approvalPolicy: 'confirm_side_effects',
          deniedCapabilities: ['secret:use', 'network:outbound'],
        },
      });
      const versionId = randomUUID();
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        values(${versionId},${f.organizationId},${f.workspaceId},${f.employeeId},2,${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${f.db.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},${f.db.json(manifest)},${f.db.json(manifest.provider)})`;
      await f.db`update allrice_employee_assignments set employee_version_id=${versionId} where id=${f.assignmentId}`;
      const [work] =
        await f.db`select revision from allrice_member_work_automation where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
      await updateWorkAutomation(
        f.context,
        f.workspaceId,
        {
          expectedRevision: work?.revision ?? 0,
          capability: 'cloud',
          enabled: true,
        },
        f.db,
      );
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-reminder-chat-')),
      );
      const reference = {
        artifactId: `sha256:${'c'.repeat(64)}`,
        profileId: 'allrice-recurring-control-v1',
        storageId: 'synthetic-sql-only',
        stateRoot: root,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(reference),
      );
      await initializeNativeRecurringPartition(reference);
      const onceReference = {
        ...reference,
        profileId: 'allrice-once-control-v1',
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_ONCE_REFERENCE',
        JSON.stringify(onceReference),
      );
      await initializeNativeOncePartition(onceReference);
    }, 120_000);
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function chat(text: string, sessionId?: string) {
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const session = sessionId
        ? { id: sessionId }
        : await createChatSession(f.context, {
            workspaceId: f.workspaceId,
            employeeAssignmentId: f.assignmentId,
            title: 'Reminder from chat',
          });
      const sent = await sendChatMessage(f.context, f.workspaceId, session.id, {
        clientMessageId: randomUUID(),
        text,
        deliveryMode: 'follow_up',
      });
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 30_000);
      expect(job?.id).toBe(sent.run.job.id);
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        job!.lease!.token,
      );
      // The stub model's tool call through the production handler.
      const call = (
        schedule: Rule | number,
        options:
          | string
          | {
              prompt?: string;
              callId?: string;
              conversationMode?: 'reuse' | 'new_each_run';
            } = {},
      ): RiceToolHandlerContext => {
        const opts =
          typeof options === 'string' ? { prompt: options } : options;
        const args = {
          name: '提醒',
          prompt: opts.prompt ?? '到点提醒我原话里的事',
          ...(typeof schedule === 'number'
            ? { delayMinutes: schedule }
            : { rule: schedule }),
          ...(opts.conversationMode
            ? { conversationMode: opts.conversationMode }
            : {}),
        };
        return {
          arguments: args,
          input: {
            context: execution!.context,
            sessionId: session.id,
            userMessageId: sent.userMessage.id,
            storageRoot: '/unused-synthetic',
            capabilities: ['automation:write'],
            call: {
              id: opts.callId ?? randomUUID(),
              name: 'automation.create',
              arguments: args,
            },
            managedBrowserJobAttempt: job!.attempt,
            managedBrowserJobLeaseToken: job!.lease!.token,
          },
        };
      };
      let turn = 1;
      /** The native card as DSH records it, then the human's typed choice
       * (one label per question on the card). */
      const answer = async (
        askUserQuestion: unknown,
        ...choices: (
          | string
          | {
              selected: string[];
              custom?: string;
              questionId?: string;
              itemId?: string;
            }
        )[]
      ) => {
        const { questions } = askUserQuestion as {
          questions: ({ multi_select: boolean } & Record<string, unknown>)[];
        };
        const questionId = `question-${randomUUID()}`;
        const turnId = `dsh-${execution!.context.runId}:turn:${turn++}`;
        const nativePayload = {
          questionId,
          questions: questions.map(({ multi_select, ...item }) => ({
            ...item,
            multiSelect: multi_select,
          })),
        };
        const first = choices[0];
        const reply = {
          questionId:
            typeof first === 'object'
              ? (first.questionId ?? questionId)
              : questionId,
          answers: choices.map((choice, index) => {
            const value =
              typeof choice === 'string' ? { selected: [choice] } : choice;
            return {
              id: value.itemId ?? String(questions[index]!.id),
              selected: value.selected,
              ...(value.custom === undefined ? {} : { custom: value.custom }),
            };
          }),
        };
        const followup = await sendChatMessage(
          f.context,
          f.workspaceId,
          session.id,
          {
            clientMessageId: randomUUID(),
            text: 'typed answer fixture',
            deliveryMode: 'follow_up',
          },
        );
        const clientId = followup.userMessage.clientMessageId;
        await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
          select ${f.organizationId},${f.workspaceId},${execution!.context.runId},coalesce(max(sequence),0)+1,'harness.native',
            ${f.db.json({ sourceEventType: 'session/user-question', turnId, generation: 1, nativePayload })}
          from allrice_run_events where run_id=${execution!.context.runId}`;
        await f.db`update allrice_messages set content=${f.db.json({ text: reply.answers.flatMap((choice) => choice.selected).join('；'), citations: [], interaction: { type: 'user_question_answer', answer: reply } })}
          where id=${followup.userMessage.id}`;
        await f.db`insert into allrice_conversation_followups(run_id,organization_id,workspace_id,session_id,owner_id,user_message_id,assistant_message_id,client_user_message_id,mode,state)
          values(${followup.run.id},${f.organizationId},${f.workspaceId},${session.id},${f.ownerId},
            ${followup.userMessage.id},${followup.assistantMessage.id},${clientId},'follow_up','consumed')
          on conflict(run_id) do update set state='consumed',consumed_at=clock_timestamp()`;
        const [command] =
          await f.db`insert into allrice_conversation_commands(organization_id,workspace_id,session_id,owner_id,followup_run_id,command_type,
          client_user_message_id,expected_generation,expected_turn_id,message,input_kind,state,native_proof)
          values(${f.organizationId},${f.workspaceId},${session.id},${f.ownerId},${followup.run.id},'steer',
            ${clientId},1,${turnId},${'allrice:user-question:v1:' + JSON.stringify(reply)},'ask_user','consumed',
            ${f.db.json({ status: 'adopted', turnId, inputId: clientId, sequence: 18, messageId: questionId, checkpoint: 'question_resolved' })}) returning id`;
        return {
          commandId: String(command!.id),
          followup,
          nativePayload,
          turnId,
        };
      };
      const tasks = () => f.db<
        {
          id: string;
          rule: Rule;
          prompt: string;
          conversation_mode: string;
          version_prompt: string;
        }[]
      >`
        select a.id,v.configuration->'rule' rule,a.prompt,a.conversation_mode,v.configuration->>'prompt' version_prompt from allrice_automations a
        join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=1
        where a.session_id=${session.id} and a.clock_owner='native_recurring' order by a.created_at`;
      const onceTasks = () => f.db<
        { id: string; prompt: string; conversation_mode: string }[]
      >`
        select id,prompt,conversation_mode from allrice_automations
        where session_id=${session.id} and clock_owner='native_once' order by created_at`;
      const finish = () =>
        failJob({
          workerId,
          jobId: job!.id,
          leaseToken: job!.lease!.token,
          code: 'FIXTURE_DONE',
          message: 'Stub model; no provider call',
          retryable: false,
        });
      return {
        call,
        answer,
        tasks,
        onceTasks,
        finish,
        sessionId: session.id,
        runId: execution!.context.runId,
      };
    }
    type Card = {
      questions: ({ options: { label: string }[] } & Record<string, unknown>)[];
    };
    const read = (result: { modelContent: string }) =>
      JSON.parse(result.modelContent) as {
        status: string;
        created?: boolean;
        automationId?: string;
        prompt?: string;
        recognizedFromUserWords?: string;
        askUserQuestion?: Card;
      };
    const yes = (card: Card | undefined) =>
      card!.questions[0]!.options[0]!.label;

    it.each(corpus)(
      'creates the reminder for “$text” ($source), directly or after one confirmation',
      async ({ text, rules }) => {
        const c = await chat(text);
        try {
          for (const [index, rule] of rules.entries()) {
            const first = read(await createAutomation(c.call(rule)));
            if (first.status === 'confirmation_required') {
              expect(await c.tasks()).toHaveLength(index);
              await c.answer(first.askUserQuestion, yes(first.askUserQuestion));
              expect(read(await createAutomation(c.call(rule)))).toMatchObject({
                status: expect.not.stringMatching('confirmation|declined'),
              });
            }
            const saved = await c.tasks();
            expect(saved).toHaveLength(index + 1);
            expect(saved[index]!.rule).toEqual(rule);
            // What runs is the human's words, plus only what the card showed.
            expect(saved[index]!.prompt.startsWith(text)).toBe(true);
            if (first.status === 'confirmation_required')
              expect(saved[index]!.prompt).toContain(
                '用户已确认的任务内容：到点提醒我原话里的事',
              );
          }
        } finally {
          await c.finish();
        }
      },
    );

    it('creates the weekly report reminder after the timezone question (MET-202 #3)', async () => {
      const rule = at('09:00:00', 'Asia/Shanghai', [1]);
      const label = '确认：每周一 09:00（Asia/Shanghai），在本聊天中执行';
      const c = await chat('每周一早上 9 点提醒我写周报');
      try {
        // The model's own question: only the timezone, as seen on 10-23.
        await c.answer(
          {
            questions: [
              {
                id: 'tz',
                question: '每周一早上 9 点按哪个时区提醒？',
                options: [
                  { label: '北京时间（Asia/Shanghai）' },
                  { label: 'UTC' },
                ],
                multi_select: false,
              },
            ],
          },
          '北京时间（Asia/Shanghai）',
        );
        const asked = read(await createAutomation(c.call(rule)));
        expect(asked.status).toBe('confirmation_required');
        expect(yes(asked.askUserQuestion)).toBe(label);
        expect(await c.tasks()).toHaveLength(0);
        await c.answer(asked.askUserQuestion, label);
        await createAutomation(c.call(rule));
        expect(await c.tasks()).toMatchObject([{ rule }]);
        // One answer, one task: a repeated call needs a new confirmation.
        expect(read(await createAutomation(c.call(rule))).status).toBe(
          'confirmation_required',
        );
        expect(await c.tasks()).toHaveLength(1);
      } finally {
        await c.finish();
      }
      // Without a separate timezone question the model's likely zone is shown
      // on the server card: one click.
      const direct = await chat('每周一早上 9 点提醒我写周报');
      try {
        const asked = read(await createAutomation(direct.call(rule)));
        await direct.answer(asked.askUserQuestion, label);
        await createAutomation(direct.call(rule));
        expect(await direct.tasks()).toMatchObject([{ rule }]);
      } finally {
        await direct.finish();
      }
    });

    it('accepts only the server card, never a model-written question with the same words', async () => {
      const rule = at('09:00:00', 'Asia/Shanghai', [1]);
      const c = await chat('帮我翻译一下这个按钮的文案');
      try {
        const server = read(await createAutomation(c.call(rule)));
        await c.answer(
          {
            questions: [
              {
                ...server.askUserQuestion!.questions[0]!,
                question: '哪个按钮需要翻译？',
              },
            ],
          },
          yes(server.askUserQuestion),
        );
        expect(read(await createAutomation(c.call(rule))).status).toBe(
          'confirmation_required',
        );
        expect(await c.tasks()).toHaveLength(0);
      } finally {
        await c.finish();
      }
    });

    it('creates both rules confirmed on one card and keeps a decline final', async () => {
      const morning = at('09:00:00'),
        evening = at('21:00:00'),
        late = at('23:00:00');
      const c = await chat(
        '12 个小时监控一次，如果出现信号就推送，每天 早上九点和晚上九点',
      );
      try {
        const a = read(await createAutomation(c.call(morning)));
        const b = read(await createAutomation(c.call(evening)));
        const d = read(await createAutomation(c.call(late)));
        // The model merges three server cards into one question.
        await c.answer(
          {
            questions: [
              ...a.askUserQuestion!.questions,
              ...b.askUserQuestion!.questions,
              ...d.askUserQuestion!.questions,
            ],
          },
          yes(a.askUserQuestion),
          yes(b.askUserQuestion),
          '先不创建',
        );
        await createAutomation(c.call(evening));
        await createAutomation(c.call(morning));
        expect(read(await createAutomation(c.call(late))).status).toBe(
          'declined',
        );
        expect((await c.tasks()).map((task) => task.rule)).toEqual([
          evening,
          morning,
        ]);
      } finally {
        await c.finish();
      }
    });

    it('consumes each confirmation by its own task, even after that task is edited', async () => {
      const nine = at('09:00:00');
      const c = await chat('每天九点分别提醒我喝水和写日报');
      try {
        const water = read(await createAutomation(c.call(nine, '提醒我喝水')));
        const report = read(
          await createAutomation(c.call(nine, '提醒我写日报')),
        );
        // Same rule, different work: two cards, both confirmed on one question.
        await c.answer(
          {
            questions: [
              ...water.askUserQuestion!.questions,
              ...report.askUserQuestion!.questions,
            ],
          },
          yes(water.askUserQuestion),
          yes(report.askUserQuestion),
        );
        await createAutomation(c.call(nine, '提醒我喝水'));
        await createAutomation(c.call(nine, '提醒我写日报'));
        expect((await c.tasks()).map((task) => task.prompt)).toEqual([
          expect.stringContaining('用户已确认的任务内容：提醒我喝水'),
          expect.stringContaining('用户已确认的任务内容：提醒我写日报'),
        ]);
        // Editing a task later does not free the confirmation it used.
        await f.db`update allrice_automations set schedule=${f.db.json({ frequency: 'native_recurring', rule: at('10:00:00') })},
          prompt='改过的任务内容' where session_id=${c.sessionId}`;
        expect(
          read(await createAutomation(c.call(nine, '提醒我喝水'))).status,
        ).toBe('confirmation_required');
        expect(await c.tasks()).toHaveLength(2);
      } finally {
        await c.finish();
      }
    });

    it('lets a later answer win over wording the server recognizes', async () => {
      const c = await chat('每 2 分钟提醒我去吃饭');
      try {
        const wrong = read(await createAutomation(c.call(every(180))));
        expect(wrong).toMatchObject({
          status: 'confirmation_required',
          recognizedFromUserWords: '每隔 2 分钟，在本聊天中执行',
        });
        await c.answer(wrong.askUserQuestion, '先不创建');
        expect(read(await createAutomation(c.call(every(180)))).status).toBe(
          'declined',
        );
        // The human's decline came after the words: no silent fast path.
        expect(read(await createAutomation(c.call(every(120)))).status).toBe(
          'confirmation_required',
        );
        expect(await c.tasks()).toHaveLength(0);
      } finally {
        await c.finish();
      }
    });

    const weeklyRequest = '每周一早上 9 点提醒我写周报';
    const weeklyRule = at('09:00:00', 'Asia/Shanghai', [1]);
    const weeklyLabel = '确认：每周一 09:00（Asia/Shanghai），在本聊天中执行';
    type Chat = Awaited<ReturnType<typeof chat>>;
    async function requiresConfirmation(c: Chat, call: RiceToolHandlerContext) {
      const result = read(await createAutomation(call));
      expect(result).toMatchObject({
        created: false,
        status: 'confirmation_required',
      });
      expect(result.askUserQuestion?.questions).toHaveLength(1);
      return result.askUserQuestion!;
    }
    const frequencyCard = {
      questions: [
        {
          id: 'frequency',
          question: '一次还是循环？',
          multi_select: false,
          options: [
            { label: '1 分钟后提醒一次' },
            { label: '2 分钟后提醒一次' },
            { label: '每隔 1 分钟提醒' },
            { label: '先不创建' },
          ],
        },
      ],
    };

    it.each([
      { name: 'decline', selected: ['先不创建'] },
      { name: 'free text', selected: [], custom: weeklyLabel },
      {
        name: 'selection plus free text',
        selected: [weeklyLabel],
        custom: '不要创建',
      },
      { name: 'multiple selections', selected: [weeklyLabel, '先不创建'] },
      { name: 'multi-select card', selected: [weeklyLabel], multiSelect: true },
      {
        name: 'unlisted label',
        selected: ['确认：每周二 09:00（Asia/Shanghai）'],
      },
      {
        name: 'wrong question ID',
        selected: [weeklyLabel],
        questionId: 'old-question',
      },
      { name: 'wrong item ID', selected: [weeklyLabel], itemId: 'other-item' },
    ])('does not enroll from $name', async (choice) => {
      const c = await chat(weeklyRequest);
      try {
        const call = c.call(weeklyRule);
        const card = await requiresConfirmation(c, call);
        card.questions[0]!.multi_select = choice.multiSelect ?? false;
        await c.answer(card, choice);
        if (choice.name === 'decline') {
          const declined = read(await createAutomation(call));
          expect(declined).toMatchObject({
            created: false,
            status: 'declined',
          });
          expect(declined).not.toHaveProperty('askUserQuestion');
        } else {
          await requiresConfirmation(c, call);
        }
        expect(await c.tasks()).toEqual([]);
      } finally {
        await c.finish();
      }
    });

    it.each([
      '确认：每周二 09:00（Asia/Shanghai）',
      '确认：每周一 09:01（Asia/Shanghai）',
      '确认：每周一 09:00（UTC）',
      '好的，按每周一 09:00（Asia/Shanghai）创建',
    ])(
      'does not accept the model-rewritten label %s for a different rule',
      async (label) => {
        const c = await chat(weeklyRequest);
        try {
          const card = await requiresConfirmation(c, c.call(weeklyRule));
          // Keep the original prose and ID: rewriting any option invalidates the whole card.
          card.questions[0]!.options[0]!.label = label;
          await c.answer(card, label);
          await requiresConfirmation(c, c.call(weeklyRule));
          expect(await c.tasks()).toEqual([]);
        } finally {
          await c.finish();
        }
      },
    );

    it.each(['reuse', 'new_each_run'] as const)(
      'binds the confirmed conversation mode %s and freezes the human work',
      async (conversationMode) => {
        const c = await chat(weeklyRequest);
        try {
          const original = c.call(weeklyRule, { conversationMode });
          const card = await requiresConfirmation(c, original);
          const label =
            conversationMode === 'new_each_run'
              ? '确认：每周一 09:00（Asia/Shanghai），每次新建聊天执行'
              : weeklyLabel;
          expect(card.questions[0]!.options[0]!.label).toBe(label);
          await c.answer(card, label);
          await requiresConfirmation(
            c,
            c.call(weeklyRule, {
              conversationMode:
                conversationMode === 'reuse' ? 'new_each_run' : 'reuse',
            }),
          );
          expect(await c.tasks()).toEqual([]);
          const first = read(await createAutomation(original));
          expect(read(await createAutomation(original)).automationId).toBe(
            first.automationId,
          );
          expect(await c.tasks()).toEqual([
            expect.objectContaining({
              id: first.automationId,
              rule: weeklyRule,
              conversation_mode: conversationMode,
              prompt: `${weeklyRequest}\n用户已确认的任务内容：到点提醒我原话里的事\n用户已确认的频率：${label.slice('确认：'.length)}`,
              version_prompt: `${weeklyRequest}\n用户已确认的任务内容：到点提醒我原话里的事\n用户已确认的频率：${label.slice('确认：'.length)}`,
            }),
          ]);
          await requiresConfirmation(
            c,
            c.call(weeklyRule, { conversationMode }),
          );
          expect(await c.tasks()).toHaveLength(1);
        } finally {
          await c.finish();
        }
      },
    );

    it('authorizes two successive rules in one run, and an old call replay does not consume the second answer', async () => {
      const text = '帮我安排喝水和活动提醒';
      const c = await chat(text);
      try {
        const firstCall = c.call(every(120));
        const firstCard = await requiresConfirmation(c, firstCall);
        await c.answer(firstCard, '确认：每隔 2 分钟，在本聊天中执行');
        const first = read(await createAutomation(firstCall));
        expect(read(await createAutomation(firstCall)).automationId).toBe(
          first.automationId,
        );
        await requiresConfirmation(c, c.call(every(120)));
        const secondCall = c.call(every(180));
        const secondCard = await requiresConfirmation(c, secondCall);
        await c.answer(secondCard, '确认：每隔 3 分钟，在本聊天中执行');
        expect(read(await createAutomation(firstCall)).automationId).toBe(
          first.automationId,
        );
        const second = read(await createAutomation(secondCall));
        expect(second.automationId).not.toBe(first.automationId);
        expect(read(await createAutomation(secondCall)).automationId).toBe(
          second.automationId,
        );
        await requiresConfirmation(c, c.call(every(180)));
        expect(await c.tasks()).toMatchObject([
          {
            rule: every(120),
            prompt: `${text}\n用户已确认的任务内容：到点提醒我原话里的事\n用户已确认的频率：每隔 2 分钟，在本聊天中执行`,
          },
          {
            rule: every(180),
            prompt: `${text}\n用户已确认的任务内容：到点提醒我原话里的事\n用户已确认的频率：每隔 3 分钟，在本聊天中执行`,
          },
        ]);
      } finally {
        await c.finish();
      }
    });

    it('serializes two different call IDs against one confirmation', async () => {
      const c = await chat(weeklyRequest);
      try {
        const card = await requiresConfirmation(c, c.call(weeklyRule));
        await c.answer(card, weeklyLabel);
        const results = (
          await Promise.all([
            createAutomation(c.call(weeklyRule)),
            createAutomation(c.call(weeklyRule)),
          ])
        ).map(read);
        expect(
          results.filter((r) => r.status === 'confirmation_required'),
        ).toHaveLength(1);
        expect(results.filter((r) => r.automationId)).toHaveLength(1);
        expect(await c.tasks()).toHaveLength(1);
      } finally {
        await c.finish();
      }
    });

    it('rejects changed arguments under a confirmed call ID while preserving exact replay', async () => {
      const c = await chat(weeklyRequest);
      try {
        const call = c.call(weeklyRule);
        const card = await requiresConfirmation(c, call);
        await c.answer(card, weeklyLabel);
        const saved = read(await createAutomation(call));
        for (const change of [
          { rule: at('09:01:00', 'Asia/Shanghai', [1]) },
          { prompt: '替换成别的工作' },
          { conversationMode: 'new_each_run' },
        ]) {
          const args = { ...call.arguments, ...change };
          await expect(
            createAutomation({
              ...call,
              arguments: args,
              input: {
                ...call.input,
                call: { ...call.input.call, arguments: args },
              },
            }),
          ).rejects.toMatchObject({ code: 'request_conflict' });
        }
        expect(read(await createAutomation(call)).automationId).toBe(
          saved.automationId,
        );
        expect(await c.tasks()).toHaveLength(1);
      } finally {
        await c.finish();
      }
    });

    it('keeps consumed confirmation consumed after the task is deleted', async () => {
      const c = await chat(weeklyRequest);
      try {
        const card = await requiresConfirmation(c, c.call(weeklyRule));
        await c.answer(card, weeklyLabel);
        const saved = read(await createAutomation(c.call(weeklyRule)));
        await f.db`update allrice_automations set deleted_at=clock_timestamp(),status='paused' where id=${saved.automationId!}`;
        await requiresConfirmation(c, c.call(weeklyRule));
        expect(await c.tasks()).toHaveLength(1);
      } finally {
        await c.finish();
      }
    });

    it.each(['same session, later run', 'different session'])(
      'does not reuse an old confirmation in %s',
      async (scope) => {
        const old = await chat(weeklyRequest);
        try {
          const card = await requiresConfirmation(old, old.call(weeklyRule));
          await old.answer(card, weeklyLabel);
        } finally {
          await old.finish();
        }
        const current = await chat(
          weeklyRequest,
          scope === 'same session, later run' ? old.sessionId : undefined,
        );
        try {
          expect(current.runId).not.toBe(old.runId);
          await requiresConfirmation(current, current.call(weeklyRule));
          expect(await current.tasks()).toEqual([]);
        } finally {
          await current.finish();
        }
      },
    );

    it.each(['command', 'followup', 'message'] as const)(
      'rejects another user owning the confirmation %s',
      async (source) => {
        const c = await chat(weeklyRequest);
        try {
          const card = await requiresConfirmation(c, c.call(weeklyRule));
          const proof = await c.answer(card, weeklyLabel);
          const otherOwner = randomUUID();
          await f.db`insert into allrice_users(id,email,display_name,password_hash)
            values(${otherOwner},${`${otherOwner}@example.test`},'Other answer owner','not-login')`;
          if (source === 'command')
            await f.db`update allrice_conversation_commands set owner_id=${otherOwner} where id=${proof.commandId}`;
          else if (source === 'followup')
            await f.db`update allrice_conversation_followups set owner_id=${otherOwner} where run_id=${proof.followup.run.id}`;
          else
            await f.db`update allrice_messages set owner_id=${otherOwner} where id=${proof.followup.userMessage.id}`;
          await requiresConfirmation(c, c.call(weeklyRule));
          expect(await c.tasks()).toEqual([]);
        } finally {
          await c.finish();
        }
      },
    );

    it('ignores a confirmed older card once a newer unanswered question exists', async () => {
      const c = await chat(weeklyRequest);
      try {
        const card = await requiresConfirmation(c, c.call(weeklyRule));
        const proof = await c.answer(card, weeklyLabel);
        await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
          select ${f.organizationId},${f.workspaceId},${c.runId},max(sequence)+1,'harness.native',
            ${f.db.json({
              sourceEventType: 'session/user-question',
              turnId: `${proof.turnId}-new`,
              generation: 1,
              nativePayload: {
                ...proof.nativePayload,
                questionId: `question-${randomUUID()}`,
              },
            })}
          from allrice_run_events where run_id=${c.runId}`;
        await requiresConfirmation(c, c.call(weeklyRule));
        expect(await c.tasks()).toEqual([]);
      } finally {
        await c.finish();
      }
    });

    it('preserves once-only replay and grants a later once confirmation despite an earlier task in the same run', async () => {
      const c = await chat('1 分钟尖叫一次');
      try {
        await c.answer(frequencyCard, '1 分钟后提醒一次');
        const firstCall = c.call(1);
        const first = read(await createAutomation(firstCall));
        expect(read(await createAutomation(firstCall)).automationId).toBe(
          first.automationId,
        );
        await expect(createAutomation(c.call(1))).rejects.toMatchObject({
          code: 'AUTOMATION_REQUEST_UNCLEAR',
        });
        expect(await c.onceTasks()).toHaveLength(1);
        await c.answer(frequencyCard, '2 分钟后提醒一次');
        const secondCall = c.call(2);
        const second = read(await createAutomation(secondCall));
        expect(second.automationId).not.toBe(first.automationId);
        expect(read(await createAutomation(secondCall)).automationId).toBe(
          second.automationId,
        );
        await expect(createAutomation(c.call(2))).rejects.toMatchObject({
          code: 'AUTOMATION_REQUEST_UNCLEAR',
        });
        expect(await c.onceTasks()).toMatchObject([
          { prompt: '1 分钟尖叫一次\n用户已确认的提醒频率：1 分钟后提醒一次' },
          { prompt: '1 分钟尖叫一次\n用户已确认的提醒频率：2 分钟后提醒一次' },
        ]);
      } finally {
        await c.finish();
      }
    });

    it.each(['once then recurring', 'recurring then once'])(
      'shares consumed-answer protection across schedule kinds: %s',
      async (order) => {
        const c = await chat('1 分钟尖叫一次');
        try {
          if (order === 'once then recurring') {
            await c.answer(frequencyCard, '1 分钟后提醒一次');
            await createAutomation(c.call(1));
            await requiresConfirmation(c, c.call(every(60)));
            await c.answer(frequencyCard, '每隔 1 分钟提醒');
            await createAutomation(c.call(every(60)));
          } else {
            await c.answer(frequencyCard, '每隔 1 分钟提醒');
            await createAutomation(c.call(every(60)));
            await expect(createAutomation(c.call(1))).rejects.toMatchObject({
              code: 'AUTOMATION_REQUEST_UNCLEAR',
            });
            await c.answer(frequencyCard, '1 分钟后提醒一次');
            await createAutomation(c.call(1));
          }
          await requiresConfirmation(c, c.call(every(60)));
          await expect(createAutomation(c.call(1))).rejects.toMatchObject({
            code: 'AUTOMATION_REQUEST_UNCLEAR',
          });
          expect(await c.tasks()).toHaveLength(1);
          expect(await c.onceTasks()).toHaveLength(1);
        } finally {
          await c.finish();
        }
      },
    );

    // A recognized original request must not overrule a later human choice.
    it.each(['先不创建', '1 分钟后提醒一次'])(
      'honors the latest choice %s even when the original recurring wording was recognized',
      async (label) => {
        const c = await chat('每隔1分钟提醒我喝水');
        try {
          const card =
            label === '先不创建'
              ? await requiresConfirmation(c, c.call(every(120)))
              : frequencyCard;
          await c.answer(card, label);
          const result = read(await createAutomation(c.call(every(60))));
          expect.soft(await c.tasks()).toHaveLength(0);
          expect(result).toMatchObject({
            created: false,
            status: 'confirmation_required',
          });
        } finally {
          await c.finish();
        }
      },
    );

    it('does not reuse a consumed confirmation by falling back to recognized original wording', async () => {
      const c = await chat('每隔1分钟提醒我喝水');
      try {
        const card = await requiresConfirmation(c, c.call(every(120)));
        await c.answer(card, '确认：每隔 2 分钟，在本聊天中执行');
        const confirmed = c.call(every(120));
        await createAutomation(confirmed);
        expect(await c.tasks()).toMatchObject([{ rule: every(120) }]);
        const result = read(await createAutomation(c.call(every(60))));
        expect.soft(await c.tasks()).toHaveLength(1);
        expect(result).toMatchObject({
          created: false,
          status: 'confirmation_required',
        });
      } finally {
        await c.finish();
      }
    });

    it.each([
      'id',
      'question',
      'header',
      'remove decline',
      'reorder options',
      'option description',
      'conversation mode',
    ])('does not confirm a server card with a forged %s', async (field) => {
      const c = await chat(weeklyRequest);
      try {
        const call = c.call(weeklyRule);
        const card = await requiresConfirmation(c, call);
        const item = card.questions[0]!;
        if (field === 'id') item.id = `schedule-confirm:${'0'.repeat(24)}`;
        if (field === 'question') item.question = '同意翻译这一段文字吗？';
        if (field === 'header') item.header = '翻译确认';
        if (field === 'remove decline') item.options.pop();
        if (field === 'reorder options') item.options.reverse();
        if (field === 'option description')
          Object.assign(item.options[0]!, {
            description: '只会翻译，不会创建任务',
          });
        if (field === 'conversation mode')
          item.options[0]!.label =
            '确认：每周一 09:00（Asia/Shanghai），每次新建聊天执行';
        const selected =
          field === 'conversation mode' ? item.options[0]!.label : weeklyLabel;
        await c.answer(card, selected);
        await requiresConfirmation(c, call);
        expect(await c.tasks()).toEqual([]);
      } finally {
        await c.finish();
      }
    });

    it('requires a new confirmation if the model changes the displayed work before enrollment', async () => {
      const c = await chat(weeklyRequest);
      try {
        const original = c.call(weeklyRule, '提醒我写周报');
        const card = await requiresConfirmation(c, original);
        await c.answer(card, yes(card));
        const changed = await requiresConfirmation(
          c,
          c.call(weeklyRule, '把周报发送给所有人'),
        );
        expect(changed.questions[0]!.id).not.toBe(card.questions[0]!.id);
        expect(changed.questions[0]!.question).toContain('把周报发送给所有人');
        expect(await c.tasks()).toHaveLength(0);
        await createAutomation(original);
        expect(await c.tasks()).toMatchObject([
          {
            prompt: `${weeklyRequest}\n用户已确认的任务内容：提醒我写周报\n用户已确认的频率：每周一 09:00（Asia/Shanghai），在本聊天中执行`,
          },
        ]);
      } finally {
        await c.finish();
      }
    });

    it('keeps decline final for the same content under old and new call IDs, without returning another card', async () => {
      const c = await chat(weeklyRequest);
      try {
        const original = c.call(weeklyRule);
        const card = await requiresConfirmation(c, original);
        await c.answer(card, '先不创建');
        for (const call of [original, c.call(weeklyRule)]) {
          const declined = read(await createAutomation(call));
          expect(declined).toMatchObject({
            created: false,
            status: 'declined',
          });
          expect(declined).not.toHaveProperty('askUserQuestion');
        }
        await requiresConfirmation(c, c.call(weeklyRule, '提醒我改做另一件事'));
        expect(await c.tasks()).toEqual([]);
      } finally {
        await c.finish();
      }
    });

    it('consumes the same rule independently for two conversation modes on one multi-question card', async () => {
      const c = await chat(weeklyRequest);
      try {
        const reuse = c.call(weeklyRule, { conversationMode: 'reuse' });
        const fresh = c.call(weeklyRule, { conversationMode: 'new_each_run' });
        const a = await requiresConfirmation(c, reuse);
        const b = await requiresConfirmation(c, fresh);
        expect(a.questions[0]!.id).not.toBe(b.questions[0]!.id);
        // Answer order differs from the question order; binding uses item IDs.
        await c.answer(
          { questions: [...a.questions, ...b.questions] },
          { itemId: String(b.questions[0]!.id), selected: [yes(b)] },
          { itemId: String(a.questions[0]!.id), selected: [yes(a)] },
        );
        const results = (
          await Promise.all([createAutomation(reuse), createAutomation(fresh)])
        ).map(read);
        expect(results.every((result) => result.automationId)).toBe(true);
        expect(new Set(results.map((result) => result.automationId)).size).toBe(
          2,
        );
        const tasks = await c.tasks();
        expect(tasks.map((task) => task.conversation_mode).sort()).toEqual([
          'new_each_run',
          'reuse',
        ]);
        for (const conversationMode of ['reuse', 'new_each_run'] as const)
          await requiresConfirmation(
            c,
            c.call(weeklyRule, { conversationMode }),
          );
        expect(await c.tasks()).toHaveLength(2);
      } finally {
        await c.finish();
      }
    });

    it('lets two confirmed tasks share one rule and mode, each consumed once', async () => {
      const c = await chat('帮我安排喝水和吃饭提醒');
      try {
        const first = c.call(every(120), '提醒我喝水');
        const second = c.call(every(120), '提醒我吃饭');
        const a = await requiresConfirmation(c, first);
        const b = await requiresConfirmation(c, second);
        await c.answer(
          { questions: [...a.questions, ...b.questions] },
          yes(a),
          yes(b),
        );
        await createAutomation(first);
        await createAutomation(second);
        expect(await c.tasks()).toHaveLength(2);
        // Each confirmation is spent by its own task.
        await requiresConfirmation(c, c.call(every(120), '提醒我喝水'));
        await requiresConfirmation(c, c.call(every(120), '提醒我吃饭'));
        expect(await c.tasks()).toHaveLength(2);
      } finally {
        await c.finish();
      }
    });

    it.each(['forged sibling', 'custom sibling', 'declined sibling'])(
      'preserves a valid item while processing a %s on the same card',
      async (kind) => {
        const c = await chat('帮我安排早上和晚上提醒');
        try {
          const aCall = c.call(at('09:00:00'));
          const bCall = c.call(at('21:00:00'));
          const a = await requiresConfirmation(c, aCall);
          const b = await requiresConfirmation(c, bCall);
          if (kind === 'forged sibling')
            b.questions[0]!.question = '要翻译文字吗？';
          await c.answer(
            { questions: [...a.questions, ...b.questions] },
            yes(a),
            kind === 'custom sibling'
              ? { selected: [yes(b)], custom: '不要创建' }
              : kind === 'declined sibling'
                ? '先不创建'
                : yes(b),
          );
          const second = read(await createAutomation(bCall));
          expect(second.status).toBe(
            kind === 'declined sibling' ? 'declined' : 'confirmation_required',
          );
          expect(await c.tasks()).toHaveLength(0);
          await createAutomation(aCall);
          expect(await c.tasks()).toMatchObject([{ rule: at('09:00:00') }]);
          await requiresConfirmation(c, c.call(at('09:00:00')));
          expect(read(await createAutomation(bCall)).status).toBe(
            second.status,
          );
        } finally {
          await c.finish();
        }
      },
    );

    it.each([2_000, 2_001])(
      'persists the full confirmed prompt or the human-only fallback at %i characters',
      async (length) => {
        const c = await chat(weeklyRequest);
        try {
          const prompt = '水'.repeat(length);
          const call = c.call(weeklyRule, prompt);
          const card = await requiresConfirmation(c, call);
          if (length === 2_000)
            expect(card.questions[0]!.question).toContain(prompt);
          else expect(card.questions[0]!.question).not.toContain(prompt);
          await c.answer(card, yes(card));
          const result = read(await createAutomation(call));
          const expected = `${weeklyRequest}\n${length <= 2_000 ? `用户已确认的任务内容：${prompt}\n` : ''}用户已确认的频率：每周一 09:00（Asia/Shanghai），在本聊天中执行`;
          expect(result.prompt).toBe(expected);
          expect(await c.tasks()).toMatchObject([
            { prompt: expected, version_prompt: expected },
          ]);
        } finally {
          await c.finish();
        }
      },
    );

    it('serializes once-only calls through the tool-call ledger and keeps deletion from renewing authorization', async () => {
      const c = await chat('1 分钟尖叫一次');
      try {
        await c.answer(frequencyCard, '1 分钟后提醒一次');
        const calls = [c.call(1), c.call(1)];
        const results = await Promise.allSettled(calls.map(createAutomation));
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === 'rejected'),
        ).toMatchObject([{ reason: { code: 'AUTOMATION_REQUEST_UNCLEAR' } }]);
        const [saved] = await c.onceTasks();
        expect(saved?.prompt).toBe(
          '1 分钟尖叫一次\n用户已确认的提醒频率：1 分钟后提醒一次',
        );
        expect(
          await f.db`select call_id from allrice_task_calls where run_id=${c.runId}`,
        ).toHaveLength(2);
        const winner =
          calls[results.findIndex((result) => result.status === 'fulfilled')]!;
        expect(read(await createAutomation(winner)).automationId).toBe(
          saved!.id,
        );
        await f.db`update allrice_automations set deleted_at=clock_timestamp(),status='paused' where id=${saved!.id}`;
        await expect(createAutomation(c.call(1))).rejects.toMatchObject({
          code: 'AUTOMATION_REQUEST_UNCLEAR',
        });
        await requiresConfirmation(c, c.call(every(60)));
        expect(await c.onceTasks()).toHaveLength(1);
        expect(await c.tasks()).toHaveLength(0);
      } finally {
        await c.finish();
      }
    });

    it('does not fall back to a recognized once request after declining or consuming a frequency answer', async () => {
      const c = await chat('1分钟后提醒我喝水');
      try {
        await c.answer(frequencyCard, '先不创建');
        await expect(createAutomation(c.call(1))).rejects.toMatchObject({
          code: 'AUTOMATION_REQUEST_UNCLEAR',
        });
        await c.answer(frequencyCard, '1 分钟后提醒一次');
        const call = c.call(1);
        const saved = read(await createAutomation(call));
        expect(read(await createAutomation(call)).automationId).toBe(
          saved.automationId,
        );
        await expect(createAutomation(c.call(1))).rejects.toMatchObject({
          code: 'AUTOMATION_REQUEST_UNCLEAR',
        });
        expect(await c.onceTasks()).toHaveLength(1);
      } finally {
        await c.finish();
      }
    });

    it.each([
      { kind: 'recurring', choice: 'declined' },
      { kind: 'recurring', choice: 'consumed' },
      { kind: 'once', choice: 'declined' },
      { kind: 'once', choice: 'consumed' },
    ])(
      'does not revive original $kind authority when a newer unanswered question follows a $choice answer',
      async ({ kind, choice }) => {
        const c = await chat(
          kind === 'once' ? '1分钟后提醒我喝水' : '每隔1分钟提醒我喝水',
        );
        try {
          const recurring = c.call(every(120));
          const card =
            kind === 'once'
              ? frequencyCard
              : await requiresConfirmation(c, recurring);
          const proof = await c.answer(
            card,
            choice === 'declined'
              ? '先不创建'
              : kind === 'once'
                ? '1 分钟后提醒一次'
                : yes(card),
          );
          if (choice === 'consumed')
            await createAutomation(kind === 'once' ? c.call(1) : recurring);
          await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
          select ${f.organizationId},${f.workspaceId},${c.runId},max(sequence)+1,'harness.native',
            ${f.db.json({
              sourceEventType: 'session/user-question',
              turnId: `${proof.turnId}-unanswered`,
              generation: 1,
              nativePayload: {
                questionId: `question-${randomUUID()}`,
                questions: [
                  {
                    id: 'unrelated',
                    question: '还有什么需要说明？',
                    options: [{ label: '没有' }],
                    multiSelect: false,
                  },
                ],
              },
            })}
          from allrice_run_events where run_id=${c.runId}`;
          // Asking another question cannot erase a prior decline/consumption.
          const result = await createAutomation(
            kind === 'once' ? c.call(1) : c.call(every(60)),
          ).then(
            (value) => ({ value: read(value), error: null }),
            (error: unknown) => ({ value: null, error }),
          );
          const rows = kind === 'once' ? await c.onceTasks() : await c.tasks();
          expect.soft(rows).toHaveLength(choice === 'consumed' ? 1 : 0);
          if (kind === 'once')
            expect(result.error).toMatchObject({
              code: 'AUTOMATION_REQUEST_UNCLEAR',
            });
          else
            expect(result.value).toMatchObject({
              created: false,
              status: 'confirmation_required',
            });
        } finally {
          await c.finish();
        }
      },
    );

    it.each(notRequests)(
      'enrolls nothing for “$text” ($source) when the human does not confirm',
      async ({ text }) => {
        const c = await chat(text);
        try {
          const first = read(await createAutomation(c.call(every(120))));
          expect(first.status).toBe('confirmation_required');
          await c.answer(first.askUserQuestion, '先不创建');
          expect(read(await createAutomation(c.call(every(120)))).status).toBe(
            'declined',
          );
          // A card for a different rule confirms nothing for this one.
          await c.answer(first.askUserQuestion, yes(first.askUserQuestion));
          expect(read(await createAutomation(c.call(every(180)))).status).toBe(
            'confirmation_required',
          );
          expect(await c.tasks()).toHaveLength(0);
        } finally {
          await c.finish();
        }
      },
    );
  },
);
