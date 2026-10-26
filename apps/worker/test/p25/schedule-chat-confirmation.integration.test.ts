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
import { createAutomation } from '../../src/tool-broker/handlers/automation.ts';
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
    let root: string;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
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
    }, 120_000);
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function chat(text: string) {
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const session = await createChatSession(f.context, {
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
      const call = (rule: Rule): RiceToolHandlerContext => {
        const args = { name: '提醒', prompt: '模型改写不会被执行', rule };
        return {
          arguments: args,
          input: {
            context: execution!.context,
            sessionId: session.id,
            userMessageId: sent.userMessage.id,
            storageRoot: '/unused-synthetic',
            capabilities: ['automation:write'],
            call: {
              id: randomUUID(),
              name: 'automation.create',
              arguments: args,
            },
            managedBrowserJobAttempt: job!.attempt,
            managedBrowserJobLeaseToken: job!.lease!.token,
          },
        };
      };
      let turn = 1;
      /** The native card as DSH records it, then the human's typed choice. */
      const answer = async (askUserQuestion: unknown, label: string) => {
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
        const reply = {
          questionId,
          answers: [{ id: String(questions[0]!.id), selected: [label] }],
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
        await f.db`update allrice_messages set content=${f.db.json({ text: label, citations: [], interaction: { type: 'user_question_answer', answer: reply } })}
          where id=${followup.userMessage.id}`;
        await f.db`insert into allrice_conversation_followups(run_id,organization_id,workspace_id,session_id,owner_id,user_message_id,assistant_message_id,client_user_message_id,mode,state)
          values(${followup.run.id},${f.organizationId},${f.workspaceId},${session.id},${f.ownerId},
            ${followup.userMessage.id},${followup.assistantMessage.id},${clientId},'follow_up','consumed') on conflict(run_id) do nothing`;
        await f.db`insert into allrice_conversation_commands(organization_id,workspace_id,session_id,owner_id,followup_run_id,command_type,
          client_user_message_id,expected_generation,expected_turn_id,message,input_kind,state,native_proof)
          values(${f.organizationId},${f.workspaceId},${session.id},${f.ownerId},${followup.run.id},'steer',
            ${clientId},1,${turnId},${'allrice:user-question:v1:' + JSON.stringify(reply)},'ask_user','consumed',
            ${f.db.json({ status: 'adopted', turnId, inputId: clientId, sequence: 18, messageId: questionId, checkpoint: 'question_resolved' })})`;
      };
      const tasks = () => f.db<{ rule: Rule; prompt: string }[]>`
        select v.configuration->'rule' rule,a.prompt from allrice_automations a
        join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=1
        where a.session_id=${session.id} and a.clock_owner='native_recurring' order by a.created_at`;
      const finish = () =>
        failJob({
          workerId,
          jobId: job!.id,
          leaseToken: job!.lease!.token,
          code: 'FIXTURE_DONE',
          message: 'Stub model; no provider call',
          retryable: false,
        });
      return { call, answer, tasks, finish };
    }
    const read = (result: { modelContent: string }) =>
      JSON.parse(result.modelContent) as {
        status: string;
        askUserQuestion?: {
          questions: { options: { label: string }[] }[];
        };
      };

    it.each(corpus)(
      'creates the reminder for “$text” ($source), directly or after one confirmation',
      async ({ text, rules }) => {
        const c = await chat(text);
        try {
          for (const [index, rule] of rules.entries()) {
            const first = read(await createAutomation(c.call(rule)));
            if (first.status === 'confirmation_required') {
              expect(await c.tasks()).toHaveLength(index);
              const card = first.askUserQuestion!;
              await c.answer(card, card.questions[0]!.options[0]!.label);
              expect(read(await createAutomation(c.call(rule)))).toMatchObject({
                status: expect.not.stringMatching('confirmation'),
              });
            }
            const saved = await c.tasks();
            expect(saved).toHaveLength(index + 1);
            expect(saved[index]!.rule).toEqual(rule);
            // What runs later is the human's own words, never the model's.
            expect(saved[index]!.prompt.startsWith(text)).toBe(true);
          }
        } finally {
          await c.finish();
        }
      },
    );

    it('creates the weekly report reminder after the timezone question (MET-202 #3)', async () => {
      const rule = at('09:00:00', 'Asia/Shanghai', [1]);
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
        expect(asked.askUserQuestion!.questions[0]!.options[0]!.label).toBe(
          '确认：每周一 09:00（Asia/Shanghai）',
        );
        expect(await c.tasks()).toHaveLength(0);
        await c.answer(
          asked.askUserQuestion,
          '确认：每周一 09:00（Asia/Shanghai）',
        );
        await createAutomation(c.call(rule));
        expect(await c.tasks()).toMatchObject([{ rule }]);
      } finally {
        await c.finish();
      }
      // A timezone question whose options already state the full rule needs
      // only that one click.
      const once = await chat('每周一早上 9 点提醒我写周报');
      try {
        await once.answer(
          {
            questions: [
              {
                id: 'tz',
                question: '按哪个时区？',
                options: [
                  { label: '确认：每周一 09:00（Asia/Shanghai）' },
                  { label: '确认：每周一 09:00（UTC）' },
                ],
                multi_select: false,
              },
            ],
          },
          '确认：每周一 09:00（Asia/Shanghai）',
        );
        await createAutomation(once.call(rule));
        expect(await once.tasks()).toMatchObject([{ rule }]);
      } finally {
        await once.finish();
      }
    });

    it.each(notRequests)(
      'enrolls nothing for “$text” ($source) when the human does not confirm',
      async ({ text }) => {
        const c = await chat(text);
        try {
          const first = read(await createAutomation(c.call(every(120))));
          expect(first.status).toBe('confirmation_required');
          await c.answer(first.askUserQuestion, '先不创建');
          expect(read(await createAutomation(c.call(every(120)))).status).toBe(
            'confirmation_required',
          );
          // A card for a different rule confirms nothing for this one.
          await c.answer(first.askUserQuestion, '确认：每隔 2 分钟');
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
