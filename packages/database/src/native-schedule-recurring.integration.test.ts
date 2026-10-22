import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createChatSession,
  sendChatMessage,
  getChatSessionHistory,
} from './workspace/service.ts';
import {
  createRecurringTask,
  createRecurringTaskFromExecutionContext,
  listRecurringTasks,
  getRecurringTask,
  changeRecurringTask,
  initializeNativeRecurringPartition,
  lockNativeRecurringAdmissions,
  dispatchNextNativeRecurringOccurrence,
} from './native-schedule-recurring-product.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import type {
  NativeRecurringSnapshot,
  NativeRecurringTask,
  NativeRecurringMutation,
} from './native-schedule-recurring-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import { lockNativeOnceJobAdmission } from './native-schedule-once-authority.ts';
import { updateWorkAutomation } from './work-automation.ts';
import * as client from './core/client.ts';
import type { TransactionSql } from 'postgres';
import {
  listAutomationCatalog,
  getAutomationCatalogTask,
  getAutomationCatalogOperation,
  changeAutomationCatalogTask,
  getAutomationCatalogOccurrenceRun,
  stopAutomationCatalogOccurrence,
} from './automation-catalog.ts';
import { listAutomations, runAutomationNow } from './execution/automation.ts';
import {
  runManualAutomation,
  getManualAutomationRun,
} from './automation-manual.ts';
import {
  claimNextJob,
  startClaimedJob,
  failJob,
  maintainQueue,
} from './execution/queue.ts';
import type { FixedRecurringScheduleRule as RecurringScheduleRule } from '@allrice/contracts';
import { employeeChatUuid } from './employees/employee-chat-authority.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'recurring isolated SQL receipts and ordinary queue (no model or clock acceptance)',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let chatVersionId: string,
      root: string,
      store: ReturnType<typeof createNativeRecurringSqlStore>,
      writer: NativeOnceWriter;
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
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
        name: 'Recurring chat fixture',
        description: 'Isolated SQL only',
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
      chatVersionId = randomUUID();
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        values(${chatVersionId},${f.organizationId},${f.workspaceId},${f.employeeId},2,${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${f.db.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},${f.db.json(manifest)},${f.db.json(manifest.provider)})`;
      await f.db`update allrice_employee_assignments set employee_version_id=${chatVersionId} where id=${f.assignmentId}`;
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-recurring-sql-')),
      );
      const reference = {
        artifactId: `sha256:${'b'.repeat(64)}`,
        profileId: 'allrice-recurring-control-v1',
        storageId: 'synthetic-sql-only',
        stateRoot: root,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(reference),
      );
      expect(await initializeNativeRecurringPartition(reference)).toMatchObject(
        { reference, activation: ready },
      );
      store = createNativeRecurringSqlStore({
        db: f.db,
        partitionId: 'allrice-recurring-v1',
        ownerId: randomUUID(),
        reference,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeRecurringTask,
        lockAdmission: lockNativeRecurringAdmissions,
        proveClosed: async () => null,
      });
      const grant = await store.acquireWriter();
      expect(grant).not.toBeNull();
      writer = grant!.writer;
    }, 120_000);
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 30_000);
    async function snapshot(id: string) {
      const [r] = await f.db<
        { snapshot: NativeRecurringSnapshot }[]
      >`select snapshot from allrice_native_recurring_controls where automation_id=${id}`;
      return r!.snapshot;
    }
    function taskScheduledAt(task: unknown) {
      if (!task || typeof task !== 'object' || !('record' in task))
        throw Error('expected saved recurring Task');
      const record = task.record;
      if (
        !record ||
        typeof record !== 'object' ||
        !('scheduledAt' in record) ||
        typeof record.scheduledAt !== 'string'
      )
        throw Error('expected saved recurring Task scheduledAt');
      return record.scheduledAt;
    }
    async function mutate(mutation: NativeRecurringMutation) {
      expect(await store.renewWriter(writer)).not.toBeNull();
      const write = {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      };
      expect(await store.commitMutation(writer, write)).toBe('committed');
      expect(await store.readExactCommit(writer, write)).toBe('committed');
      return write;
    }
    async function task(
      prompt = '核对固定测试数据，只输出本期结果。',
      rule: RecurringScheduleRule = { kind: 'every', seconds: 60 },
      options: {
        prepareNative?: boolean;
        conversationMode?: 'reuse' | 'new_each_run';
      } = {},
    ) {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Isolated recurring',
      });
      const input = {
        clientRequestId: randomUUID(),
        name: '每期核对',
        prompt,
        rule,
        ...(options.conversationMode === undefined
          ? {}
          : { conversationMode: options.conversationMode }),
      };
      const result = await createRecurringTask(f.context, session.id, input);
      if (options.prepareNative !== false) await prepareNativeTask(result.id);
      return { id: result.id, sessionId: session.id, input };
    }
    async function prepareNativeTask(
      id: string,
      scheduledAt = new Date(Date.now() - 180_000).toISOString(),
    ) {
      const c = (await snapshot(id)).control,
        rule = c.rule;
      await mutate({ kind: 'session_initializing', controlId: c.controlId });
      await mutate({ kind: 'session_ready', controlId: c.controlId });
      // Explicit synthetic component receipt. Actual timer behavior is separately
      // checked through the public Host and ordinary Dev page.
      const native: NativeRecurringTask = {
        sessionId: c.controlSessionId,
        status: 'active',
        record: {
          id: randomUUID(),
          ...(rule.kind === 'every'
            ? { kind: 'every', everySeconds: rule.seconds }
            : {
                kind: rule.kind,
                time: rule.time + '.000',
                timeZone: rule.timezone,
                ...(rule.kind === 'weekly' ? { weekdays: rule.weekdays } : {}),
              }),
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
          scheduledAt,
        },
      };
      await mutate({ kind: 'put_task', controlId: c.controlId, task: native });
      await mutate({
        kind: 'confirm_command',
        controlId: c.controlId,
        commandId: c.command.id,
        nativeTaskId: native.record.id,
      });
    }
    async function receipt(id: string) {
      const s = await snapshot(id),
        native = structuredClone(s.task) as NativeRecurringTask;
      const delivery = {
        scheduledAt: native.record.scheduledAt,
        deliveredAt: new Date().toISOString(),
        messageId: randomUUID(),
      };
      native.lastDelivery = delivery;
      native.deliveryHistory = {
        records: [
          ...(native.deliveryHistory?.records ?? []),
          { ...delivery, prompt: native.record.prompt },
        ],
        earlierRecordsUnavailable: false,
      };
      native.record.scheduledAt = new Date(
        Date.parse(delivery.scheduledAt) + 60_000,
      ).toISOString();
      return mutate({
        kind: 'put_task',
        controlId: s.control.controlId,
        task: native,
      });
    }
    async function cloud(enabled: boolean) {
      const [r] =
        await f.db`select revision from allrice_member_work_automation where organization_id=${f.organizationId} and workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
      return updateWorkAutomation(
        f.context,
        f.workspaceId,
        { expectedRevision: r?.revision ?? 0, capability: 'cloud', enabled },
        f.db,
      );
    }
    const chatRequest =
      '请每隔两分钟，在当前对话中只回复校验词「RECURRING-NL-A」。请实际创建周期任务，不要现在执行。';
    async function leasedChat(
      text = chatRequest,
      rule: RecurringScheduleRule = { kind: 'every', seconds: 120 },
      clientMessageId = randomUUID(),
      conversationMode?: 'reuse' | 'new_each_run',
    ) {
      // All rows belong to this disposable fixture schema, never shared Dev.
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Recurring chat admission',
      });
      const submitted = await sendChatMessage(
        f.context,
        f.workspaceId,
        session.id,
        { clientMessageId, text, deliveryMode: 'follow_up' },
      );
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 30_000);
      expect(job?.id).toBe(submitted.run.job.id);
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        job!.lease!.token,
      );
      const args = {
        name: '周期原话测试',
        prompt: '模型改写不能替换真人原文',
        rule,
        ...(conversationMode === undefined ? {} : { conversationMode }),
      };
      return {
        input: {
          context: execution!.context,
          sessionId: session.id,
          userMessageId: submitted.userMessage.id,
          callId: randomUUID(),
          arguments: args,
          worker: { attempt: job!.attempt, leaseToken: job!.lease!.token },
          ...args,
        },
        finish: () =>
          failJob({
            workerId,
            jobId: job!.id,
            leaseToken: job!.lease!.token,
            code: 'FIXTURE_DONE',
            message: 'Isolated recurring SQL assertion, no model called',
            retryable: false,
          }),
      };
    }
    async function enrollmentCounts() {
      const [row] = await f.db`select
        (select count(*)::int from allrice_automations) plans,
        (select count(*)::int from allrice_native_recurring_controls) controls,
        (select count(*)::int from allrice_native_recurring_versions) versions,
        (select count(*)::int from allrice_native_recurring_journal) journal`;
      return row!;
    }
    it.each(['reuse', 'new_each_run'] as const)(
      'conversation fixed parent rejects a pointerless new NULL snapshot at COMMIT (%s)',
      async (conversationMode) => {
        const t = await task(undefined, undefined, { conversationMode });
        const arId = randomUUID();
        let reachedCommit = false;
        await expect(
          f.db.begin(async (tx) => {
            const [born] = await tx`insert into allrice_automation_runs
              (id,organization_id,workspace_id,automation_id,session_id,scheduled_for,status)
              values(${arId},${f.organizationId},${f.workspaceId},${t.id},${t.sessionId},clock_timestamp(),'queued')
              returning conversation_snapshot,manual_request_id,native_once_occurrence_id,native_recurring_occurrence_id`;
            expect(born).toEqual({
              conversation_snapshot: null,
              manual_request_id: null,
              native_once_occurrence_id: null,
              native_recurring_occurrence_id: null,
            });
            reachedCommit = true;
          }),
        ).rejects.toMatchObject({ code: '23514' });
        expect(reachedCommit).toBe(true);
        expect(
          await f.db`select id from allrice_automation_runs where id=${arId}`,
        ).toHaveLength(0);
      },
    );

    it('conversation fixed periods freeze different targets or the source, preserve old Run admission and immutable original create input', async () => {
      const t = await task(
        '核对本期数据。',
        { kind: 'every', seconds: 60 },
        { conversationMode: 'new_each_run' },
      );
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [first] =
        await f.db`select ar.*,j.id job_id,allrice_automation_conversation_handoff_proved(ar.id) proof
        from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${t.id}`;
      expect(first!.session_id).not.toBe(t.sessionId);
      expect(first).toMatchObject({
        proof: true,
        conversation_snapshot: {
          mode: 'new_each_run',
          businessRevision: 1,
          sourceSessionId: t.sessionId,
        },
      });
      const before = await snapshot(t.id),
        policy = {
          operationId: randomUUID(),
          expectedRevision: 1,
          action: 'conversation',
          conversationMode: 'reuse',
        };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, policy),
      ).toMatchObject({
        status: 'applied',
        task: { revision: 2, conversationMode: 'reuse' },
      });
      expect(await snapshot(t.id)).toEqual(before);
      expect(
        (
          await listRecurringTasks(f.context, t.sessionId, {
            clientRequestId: t.input.clientRequestId,
          })
        ).request,
      ).toEqual(t.input);
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, first!.job_id)),
      ).toMatchObject({ allowed: true });
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const rows =
        await f.db`select ar.*,j.id job_id from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${t.id} order by ar.scheduled_for`;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        session_id: t.sessionId,
        conversation_snapshot: {
          mode: 'reuse',
          businessRevision: 2,
          targetSessionId: t.sessionId,
        },
      });
      for (const row of rows) {
        const [timeProof] = await f.db`select
          allrice_automation_conversation_scheduled_target_proved(ar.automation_id,ar.native_once_occurrence_id,
            ar.native_recurring_occurrence_id,ar.scheduled_for) exact_p,
          allrice_automation_conversation_scheduled_target_proved(ar.automation_id,ar.native_once_occurrence_id,
            ar.native_recurring_occurrence_id,ar.scheduled_for+interval '1 second') wrong_p
          from allrice_automation_runs ar where ar.id=${row.id}`;
        expect(timeProof).toEqual({ exact_p: true, wrong_p: false });
      }
      const history = await getAutomationCatalogTask(
        f.context,
        f.workspaceId,
        t.id,
      );
      expect(history.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: first!.session_id,
            runId: first!.run_id,
          }),
          expect.objectContaining({
            sessionId: t.sessionId,
            runId: rows[1]!.run_id,
          }),
        ]),
      );
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${first!.session_id}`;
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, first!.job_id)),
      ).toMatchObject({ allowed: false });
      expect(
        await f.db.begin((tx) =>
          lockNativeOnceJobAdmission(tx, rows[1]!.job_id),
        ),
      ).toMatchObject({ allowed: true });
      await f.db`update allrice_chat_sessions set archived_at=null where id=${first!.session_id}`;
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${t.sessionId}`;
      for (const row of rows)
        expect(
          await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, row.job_id)),
        ).toMatchObject({ allowed: false });
      await f.db`update allrice_chat_sessions set archived_at=null where id=${t.sessionId}`;
    });
    it.each(['schedule', 'folder'] as const)(
      'conversation NULL birth scope leaves legacy %s new_each_run records intact',
      async (triggerType) => {
        const source = await createChatSession(f.context, {
          workspaceId: f.workspaceId,
          employeeAssignmentId: f.assignmentId,
          title: 'Legacy conversation compatibility',
        });
        const id = randomUUID(),
          arId = randomUUID(),
          schedule = {
            frequency: 'daily',
            time: '08:30',
            timezone: 'Asia/Shanghai',
          },
          folder = {
            contractVersion: 1,
            deviceId: randomUUID(),
            folderGrantId: randomUUID(),
            folderGrantVersion: 1,
            relativePath: '.',
            extensions: ['csv'],
            ignorePaths: ['processed'],
          };
        await f.db`insert into allrice_automations
          (id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,folder,status,
            conversation_mode,employee_assignment_id,session_id)
          values(${id},${f.organizationId},${f.workspaceId},${f.ownerId},'Legacy scope','保留原有每轮新聊天语义。',${triggerType},
            ${triggerType === 'schedule' ? f.db.json(schedule) : null},${triggerType === 'folder' ? f.db.json(folder) : null},'paused',
            'new_each_run',${f.assignmentId},${source.id})`;
        await f.db.begin(async (tx) => {
          await tx`insert into allrice_automation_runs
            (id,organization_id,workspace_id,automation_id,scheduled_for,status)
            values(${arId},${f.organizationId},${f.workspaceId},${id},clock_timestamp(),'queued')`;
        });
        const [saved] =
          await f.db`select ar.conversation_snapshot,a.clock_owner,a.conversation_mode,a.native_create_conversation_mode
          from allrice_automation_runs ar join allrice_automations a on a.id=ar.automation_id where ar.id=${arId}`;
        expect(saved).toEqual({
          conversation_snapshot: null,
          clock_owner: 'legacy',
          conversation_mode: 'new_each_run',
          native_create_conversation_mode: null,
        });
      },
    );

    it('conversation fixed paid P survives an archived old target while the old Job stays denied', async () => {
      const t = await task(
        '同一个业务周期最多付费一次。',
        { kind: 'every', seconds: 60 },
        { conversationMode: 'new_each_run', prepareNative: false },
      );
      const P = new Date(
        Math.floor((Date.now() - 180_000) / 1000) * 1000,
      ).toISOString();
      await prepareNativeTask(t.id, P);
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [paid] =
        await f.db`select ar.id,ar.run_id,ar.session_id,j.id job_id,
        ar.native_recurring_occurrence_id occurrence_id
        from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${t.id}`;
      expect(paid).toBeDefined();
      expect(paid!.session_id).not.toBe(t.sessionId);
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${paid!.session_id}`;
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, paid!.job_id)),
      ).toMatchObject({
        scheduled: true,
        runId: paid!.run_id,
        allowed: false,
      });
      expect(
        (
          await f.db`select allrice_automation_conversation_handoff_proved(${paid!.id}::uuid) valid`
        )[0]?.valid,
      ).toBe(true);

      // Component-only legal rule change: the original put/receipt and journal
      // remain intact. Only an accepted update to a different native rule can
      // select another target; a bare scheduledAt rewind is forbidden.
      const daily = {
        kind: 'daily' as const,
        time: P.slice(11, 19),
        timezone: 'UTC',
      };
      const update = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'update' as const,
        name: '新规则保留原业务去重',
        prompt: t.input.prompt,
        rule: daily,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, update),
      ).toMatchObject({ status: 'pending' });
      const pending = await snapshot(t.id),
        previous = structuredClone(pending.task) as NativeRecurringTask,
        changed: NativeRecurringTask = {
          ...previous,
          record: {
            id: previous.record.id,
            kind: 'daily',
            title: previous.record.title,
            prompt: previous.record.prompt,
            time: `${daily.time}.000`,
            timeZone: daily.timezone,
            scheduledAt: P,
          },
        };
      // Prove that the same change without changing the rule is rejected by
      // the real SQL store, rather than permitting arbitrary Task rewrites.
      const rewind = structuredClone(previous);
      rewind.record.scheduledAt = P;
      const badMutation: NativeRecurringMutation = {
        kind: 'put_task',
        controlId: pending.control.controlId,
        task: rewind,
      };
      const badWrite = {
        writeId: randomUUID(),
        digest: nativeOnceDigest(badMutation),
        mutation: badMutation,
      };
      expect(await store.commitMutation(writer, badWrite)).toBe('rejected');
      expect(await store.readExactCommit(writer, badWrite)).toBe('absent');
      await mutate({
        kind: 'put_task',
        controlId: pending.control.controlId,
        task: changed,
      });
      await mutate({
        kind: 'confirm_command',
        controlId: pending.control.controlId,
        commandId: update.operationId,
        nativeTaskId: changed.record.id,
      });
      const delivery = {
          scheduledAt: P,
          deliveredAt: new Date().toISOString(),
          messageId: randomUUID(),
        },
        current = structuredClone(
          (await snapshot(t.id)).task,
        ) as NativeRecurringTask;
      current.lastDelivery = delivery;
      current.deliveryHistory = {
        ...current.deliveryHistory,
        records: [
          ...(current.deliveryHistory?.records ?? []),
          { ...delivery, prompt: current.record.prompt },
        ],
      };
      current.record.scheduledAt = new Date(
        Date.parse(P) + 86_400_000,
      ).toISOString();
      await mutate({
        kind: 'put_task',
        controlId: pending.control.controlId,
        task: current,
      });
      const [duplicate] =
        await f.db`select occurrence_id,outbox_state,payload from allrice_native_recurring_occurrences
        where automation_id=${t.id} and revision=2 and scheduled_at=${P}::timestamptz`;
      expect(duplicate).toMatchObject({
        outbox_state: 'pending',
        payload: { revision: { revision: 2 }, receipt: { scheduledAt: P } },
      });
      expect(duplicate!.occurrence_id).not.toBe(paid!.occurrence_id);
      const businessState = async () =>
        (
          await f.db`select
        (select count(*)::int from allrice_chat_sessions) chats,
        (select count(*)::int from allrice_messages) messages,
        (select count(*)::int from allrice_employee_runs) employee_runs,
        (select count(*)::int from allrice_automation_runs) automation_runs,
        (select count(*)::int from allrice_runs) runs,
        (select count(*)::int from allrice_jobs) jobs,
        (select count(*)::int from allrice_model_usage_ledger) usage,
        (select count(*)::int from allrice_runtime_reservations) reservations,
        (select to_jsonb(ar) from allrice_automation_runs ar where ar.id=${paid!.id}) original_ar,
        (select to_jsonb(r) from allrice_runs r where r.id=${paid!.run_id}) original_run,
        (select to_jsonb(j) from allrice_jobs j where j.id=${paid!.job_id}) original_job,
        (select to_jsonb(er) from allrice_employee_runs er where er.run_id=${paid!.run_id}) original_employee_run,
        (select to_jsonb(o) from allrice_native_recurring_occurrences o where o.occurrence_id=${paid!.occurrence_id}) original_occurrence,
        (select to_jsonb(s) from allrice_chat_sessions s where s.id=${paid!.session_id}) original_target`
        )[0];
      const before = await businessState();
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [terminal] =
        await f.db`select outbox_state,outbox_reason,business_binding from allrice_native_recurring_occurrences
        where occurrence_id=${duplicate!.occurrence_id}`;
      expect(terminal).toEqual({
        outbox_state: 'blocked',
        outbox_reason: 'ORDINARY_FIXED_ALREADY_CLAIMED',
        business_binding: null,
      });
      expect(await businessState()).toEqual(before);
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, paid!.job_id)),
      ).toMatchObject({ allowed: false });
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
    });

    it('conversation leaves the original fixed pause/resume native gap legal before another full update', async () => {
      const t = await task();
      await changeRecurringTask(f.context, t.sessionId, t.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'pause',
      });
      await changeRecurringTask(f.context, t.sessionId, t.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        action: 'resume',
      });
      const before = await snapshot(t.id);
      await changeRecurringTask(f.context, t.sessionId, t.id, {
        operationId: randomUUID(),
        expectedRevision: 3,
        action: 'conversation',
        conversationMode: 'new_each_run',
      });
      expect(await snapshot(t.id)).toEqual(before);
      const input = {
        operationId: randomUUID(),
        expectedRevision: 4,
        action: 'update',
        name: '完整新名称',
        prompt: '完整的新工作，不省略原文。',
        rule: t.input.rule,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, input),
      ).toMatchObject({
        status: 'pending',
        task: { revision: 5, conversationMode: 'new_each_run' },
      });
      const [p] =
        await f.db`select revision,native_recurring_revision from allrice_automations where id=${t.id}`;
      expect(Number(p!.revision)).toBe(5);
      expect(Number(p!.native_recurring_revision)).toBe(5);
    });

    it('maps two periods to two messages/Runs, exact retries never multiply work', async () => {
      const t = await task();
      expect(
        (await createRecurringTask(f.context, t.sessionId, t.input)).id,
      ).toBe(t.id);
      const first = await receipt(t.id);
      expect(await store.commitMutation(writer, first)).toBe('committed');
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const runs =
        await f.db`select ar.run_id,ar.session_id,j.id job_id from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${t.id}`;
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((r) => r.run_id)).size).toBe(2);
      for (const r of runs)
        expect(
          await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, r.job_id)),
        ).toMatchObject({ scheduled: true, allowed: true });
      const detail = await getRecurringTask(f.context, t.sessionId, t.id);
      expect(detail).toMatchObject({
        task: { status: 'enabled' },
        occurrences: expect.arrayContaining([
          expect.objectContaining({ status: 'queued' }),
        ]),
      });
      expect('occurrences' in detail && detail.occurrences).toHaveLength(2);
      const history = await getChatSessionHistory(
        f.context,
        f.workspaceId,
        t.sessionId,
      );
      const wakes = history.messages.filter((m) => m.role === 'user');
      // The second period waits in the ordinary inbox while the first Run is
      // pending. Both surfaces must retain the actual non-human attribution.
      expect(wakes).toHaveLength(1);
      expect(history.queuedMessages).toHaveLength(1);
      expect(history.queuedMessages[0]?.source).toMatchObject({
        kind: 'schedule',
        taskId: t.id,
      });
      for (const wake of wakes) {
        expect(wake.source).toEqual({
          kind: 'schedule',
          taskId: t.id,
          scheduledAt: expect.any(String),
          occurrenceId: expect.any(String),
        });
        // Presentation attribution must preserve the actual execution input.
        expect(wake.content.text).toContain('本轮只执行工作');
      }
      // The legacy management DTO cannot parse native recurring rules. Its
      // unchanged entries remain readable; the new panel owns these rows.
      expect(
        (await listAutomations(f.context, f.workspaceId)).automations.some(
          (a) => a.id === t.id,
        ),
      ).toBe(false);
    });
    it('hands a weekly receipt to the same ordinary queue exactly once and keeps original history after pause', async () => {
      const rule = {
        kind: 'weekly' as const,
        weekdays: [1, 3, 7],
        time: '09:30:05',
        timezone: 'Asia/Kathmandu',
      };
      const t = await task('只输出每周期核对结果。', rule);
      const before = await snapshot(t.id);
      const write = await receipt(t.id);
      expect(await store.commitMutation(writer, write)).toBe('committed');
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      const [counts] =
        await f.db`select count(*)::int count from allrice_automation_runs where automation_id=${t.id}`;
      expect(counts!.count).toBe(1);
      expect(
        await getRecurringTask(f.context, t.sessionId, t.id),
      ).toMatchObject({
        task: { rule },
        occurrences: [expect.objectContaining({ status: 'queued' })],
      });
      await changeRecurringTask(f.context, t.sessionId, t.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'pause',
      });
      const after = await snapshot(t.id);
      expect(after.control.controlSessionId).toBe(
        before.control.controlSessionId,
      );
      expect(after.control.nativeTaskId).toBe(before.control.nativeTaskId);
      expect(
        await getRecurringTask(f.context, t.sessionId, t.id),
      ).toMatchObject({
        task: { status: 'paused' },
        occurrences: [expect.objectContaining({ status: 'queued' })],
      });
    });
    it('pause/resume serializes with receipts; late pre-resume periods stay unexecuted', async () => {
      const t = await task();
      await receipt(t.id);
      const pause = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'pause' as const,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, pause),
      ).toMatchObject({
        status: 'applied',
        task: { status: 'paused', revision: 2 },
      });
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      await receipt(t.id);
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: randomUUID(),
          expectedRevision: 2,
          action: 'resume',
        }),
      ).toMatchObject({
        status: 'applied',
        task: { status: 'enabled', revision: 3 },
      });
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      const rows =
        await f.db`select outbox_state,outbox_reason from allrice_native_recurring_occurrences where automation_id=${t.id}`;
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.outbox_state === 'blocked')).toBe(true);
      expect(
        rows.some((r) => r.outbox_reason === 'before_resume_watermark'),
      ).toBe(true);
      expect(
        await getRecurringTask(f.context, t.sessionId, t.id, {
          operationId: pause.operationId,
        }),
      ).toMatchObject({ operation: { request: pause, status: 'applied' } });
    });
    it('same-rule content update keeps native identity and binds only the new version', async () => {
      const t = await task('第一版输入');
      const before = await snapshot(t.id);
      const input = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'update' as const,
        name: '新版核对',
        prompt: '第二版输入',
        rule: t.input.rule,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, input),
      ).toMatchObject({ status: 'pending' });
      const pending = await snapshot(t.id);
      await mutate({
        kind: 'confirm_command',
        controlId: pending.control.controlId,
        commandId: input.operationId,
        nativeTaskId: pending.control.nativeTaskId,
      });
      expect((await snapshot(t.id)).control).toMatchObject({
        controlSessionId: before.control.controlSessionId,
        nativeTaskId: before.control.nativeTaskId,
        appliedRevision: 2,
      });
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const [message] =
        await f.db`select m.content from allrice_automation_runs ar join allrice_employee_runs er on er.run_id=ar.run_id join allrice_messages m on m.id=er.user_message_id where ar.automation_id=${t.id}`;
      expect(message!.content.text).toContain('第二版输入');
      expect(message!.content.text).not.toContain('第一版输入');
      const exact = await listRecurringTasks(f.context, t.sessionId, {
        clientRequestId: t.input.clientRequestId,
      });
      expect(exact.request).toEqual(t.input);
      expect(exact.tasks[0]?.prompt).toBe('第二版输入');
      const stale = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'pause' as const,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, stale),
      ).toMatchObject({ status: 'rejected', request: stale });
      expect(
        await getRecurringTask(f.context, t.sessionId, t.id, {
          operationId: stale.operationId,
        }),
      ).toMatchObject({ operation: { status: 'rejected', request: stale } });
    });
    it('current cloud permission denies a queued receipt and retains immutable evidence', async () => {
      const t = await task();
      await receipt(t.id);
      await cloud(false);
      try {
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          true,
        );
        const [r] =
          await f.db`select outbox_state,business_binding from allrice_native_recurring_occurrences where automation_id=${t.id}`;
        expect(r).toMatchObject({
          outbox_state: 'blocked',
          business_binding: null,
        });
        await expect(
          changeRecurringTask(f.context, t.sessionId, t.id, {
            operationId: randomUUID(),
            expectedRevision: 1,
            action: 'pause',
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        await cloud(true);
      }
    });
    it('deletion retains task/history, blocks pending work, and exact readback remains scoped', async () => {
      const t = await task();
      await receipt(t.id);
      const op = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'delete' as const,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, op),
      ).toMatchObject({ status: 'pending', task: { status: 'deleting' } });
      const s = await snapshot(t.id);
      await mutate({
        kind: 'delete_task',
        controlId: s.control.controlId,
        nativeTaskId: s.control.nativeTaskId!,
      });
      await mutate({
        kind: 'confirm_command',
        controlId: s.control.controlId,
        commandId: op.operationId,
        nativeTaskId: s.control.nativeTaskId,
      });
      expect(
        await getRecurringTask(f.context, t.sessionId, t.id),
      ).toMatchObject({
        task: { status: 'deleted' },
        occurrences: [expect.objectContaining({ status: 'not_executed' })],
      });
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      const other = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Other chat',
      });
      await expect(
        getRecurringTask(f.context, other.id, t.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        f.db`delete from allrice_native_recurring_occurrences where automation_id=${t.id}`,
      ).rejects.toMatchObject({ code: '23514' });
    });
    it('stops only an exact recurring occurrence, preserves native plans/history and still dispatches the next period', async () => {
      const t = await task('MET192 exact occurrence stop');
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const history = await getAutomationCatalogTask(
        f.context,
        f.workspaceId,
        t.id,
      );
      const [newer, selected] = history.occurrences;
      expect(newer?.runId).toBeTruthy();
      expect(selected?.runId).toBeTruthy();
      const exact = { occurrenceId: selected!.id, runId: selected!.runId! };
      for (const wrong of [
        { ...exact, occurrenceId: newer!.id },
        { ...exact, runId: newer!.runId! },
      ])
        await expect(
          stopAutomationCatalogOccurrence(
            f.context,
            f.workspaceId,
            t.id,
            wrong,
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
      const other = await task('MET192 unrelated same-owner plan');
      await expect(
        stopAutomationCatalogOccurrence(
          f.context,
          f.workspaceId,
          other.id,
          exact,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        stopAutomationCatalogOccurrence(f.context, randomUUID(), t.id, exact),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        stopAutomationCatalogOccurrence(
          { ...f.context, actor: { type: 'user', id: randomUUID() } },
          f.workspaceId,
          t.id,
          exact,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const protectedState = async () => ({
        plan: (
          await f.db`select to_jsonb(a) data from allrice_automations a where id=${t.id}`
        )[0]!.data,
        native: await snapshot(t.id),
        counts: await enrollmentCounts(),
        occurrences:
          await f.db`select * from allrice_native_recurring_occurrences where automation_id=${t.id} order by occurrence_id`,
      });
      const before = await protectedState();
      const stopped = await stopAutomationCatalogOccurrence(
        f.context,
        f.workspaceId,
        t.id,
        exact,
      );
      expect(stopped.run).toMatchObject({
        id: exact.runId,
        status: 'queued',
        job: { status: 'queued' },
        cancelRequestedAt: expect.any(String),
      });
      const repeat = await stopAutomationCatalogOccurrence(
        f.context,
        f.workspaceId,
        t.id,
        exact,
      );
      expect(repeat.run.cancelRequestedAt).toBe(stopped.run.cancelRequestedAt);
      expect(await protectedState()).toEqual(before);
      expect(
        (
          await getAutomationCatalogOccurrenceRun(
            f.context,
            f.workspaceId,
            t.id,
            { occurrenceId: newer!.id, runId: newer!.runId! },
          )
        ).run.cancelRequestedAt,
      ).toBeNull();
      await maintainQueue(1000);
      const terminal = await getAutomationCatalogOccurrenceRun(
        f.context,
        f.workspaceId,
        t.id,
        exact,
      );
      expect(terminal.run.status).toBe('canceled');
      expect(
        (
          await stopAutomationCatalogOccurrence(
            f.context,
            f.workspaceId,
            t.id,
            exact,
          )
        ).run,
      ).toEqual(terminal.run);
      expect(await protectedState()).toEqual(before);
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      expect(
        (await getAutomationCatalogTask(f.context, f.workspaceId, t.id))
          .occurrences,
      ).toHaveLength(3);
    });
    it('uses the durable manual/legacy history identity without changing its schedule or selecting a later Run', async () => {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'MET192 manual stop',
      });
      const id = randomUUID(),
        schedule = {
          frequency: 'weekly',
          weekday: 2,
          time: '09:00',
          timezone: 'Asia/Shanghai',
        };
      await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,next_run_at) values(${id},${f.organizationId},${f.workspaceId},${f.ownerId},'MET192 manual stop','核对测试数据','schedule',${f.db.json(schedule)},'enabled','reuse',${f.assignmentId},${session.id},'2099-01-01T01:00:00Z')`;
      await runAutomationNow(f.context, f.workspaceId, id);
      const first = (
        await getAutomationCatalogTask(f.context, f.workspaceId, id)
      ).occurrences[0]!;
      await runAutomationNow(f.context, f.workspaceId, id);
      const before = (
        await f.db`select to_jsonb(a) data from allrice_automations a where id=${id}`
      )[0]!.data;
      const target = { occurrenceId: first.id, runId: first.runId! };
      const result = await stopAutomationCatalogOccurrence(
        f.context,
        f.workspaceId,
        id,
        target,
      );
      expect(result.run.id).toBe(first.runId);
      expect(result.run.cancelRequestedAt).not.toBeNull();
      const newer = (
        await getAutomationCatalogTask(f.context, f.workspaceId, id)
      ).occurrences[0]!;
      expect(newer.id).not.toBe(first.id);
      expect(
        (
          await getAutomationCatalogOccurrenceRun(
            f.context,
            f.workspaceId,
            id,
            { occurrenceId: newer.id, runId: newer.runId! },
          )
        ).run.cancelRequestedAt,
      ).toBeNull();
      expect(
        (
          await f.db`select to_jsonb(a) data from allrice_automations a where id=${id}`
        )[0]!.data,
      ).toEqual(before);
    });
    async function manualBoundary(id: string) {
      return {
        plan: (
          await f.db`select to_jsonb(a) data from allrice_automations a where id=${id}`
        )[0]!.data,
        native: await snapshot(id),
        versions:
          await f.db`select * from allrice_native_recurring_versions where automation_id=${id} order by revision`,
        journal:
          await f.db`select * from allrice_native_recurring_journal where control_id=(select control_id from allrice_native_recurring_controls where automation_id=${id}) order by write_id`,
        occurrences:
          await f.db`select * from allrice_native_recurring_occurrences where automation_id=${id} order by occurrence_id`,
      };
    }
    it('manual request is independent of native P, commits one real message/Run/Job, and never moves the timer', async () => {
      const t = await task('人工核对固定数据，只输出当前核对结果。'),
        before = await manualBoundary(t.id),
        input = { requestId: randomUUID(), expectedRevision: 1 };
      const [first, duplicate] = await Promise.all([
        runManualAutomation(f.context, f.workspaceId, t.id, input),
        runManualAutomation(f.context, f.workspaceId, t.id, input),
      ]);
      expect(duplicate).toEqual(first);
      expect(first).toMatchObject({
        source: 'manual',
        request: input,
        taskId: t.id,
        sessionId: t.sessionId,
      });
      expect(await manualBoundary(t.id)).toEqual(before);
      const rows =
        await f.db`select ar.*,j.id job_id,m.content->>'text' text from allrice_automation_runs ar
        join allrice_jobs j on j.run_id=ar.run_id join allrice_employee_runs er on er.run_id=ar.run_id
        join allrice_messages m on m.id=er.user_message_id where ar.automation_id=${t.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        manual_request_id: input.requestId,
        manual_request_digest: first.requestDigest,
        manual_source: 'user',
        native_once_occurrence_id: null,
        native_recurring_occurrence_id: null,
        native_root_origin: null,
      });
      expect(rows[0]!.text).toContain('不要创建、修改或再次安排定时任务');
      expect(rows[0]!.text).toContain(t.input.prompt);
      expect(rows[0]!.scheduled_for.toISOString()).toBe(first.requestedAt);
      expect(
        await f.db.begin((tx) =>
          lockNativeOnceJobAdmission(tx, first.run.job.id),
        ),
      ).toMatchObject({ scheduled: true, runId: first.run.id, allowed: true });
      expect(
        (await getAutomationCatalogTask(f.context, f.workspaceId, t.id))
          .occurrences,
      ).toEqual([
        expect.objectContaining({
          id: first.automationRunId,
          runId: first.run.id,
          revision: 1,
          source: {
            kind: 'manual',
            requestId: input.requestId,
            requestedAt: first.requestedAt,
          },
        }),
      ]);
      // Deliver the original legal P. Manual execution cannot move an existing
      // native target, and this fixture must obey the same production guard.
      const originalP = taskScheduledAt((await snapshot(t.id)).task);
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const both =
        await f.db`select run_id,scheduled_for,manual_request_id,native_recurring_occurrence_id from allrice_automation_runs where automation_id=${t.id}`;
      expect(both).toHaveLength(2);
      expect(new Set(both.map((x) => x.run_id)).size).toBe(2);
      expect(
        both
          .find((x) => x.native_recurring_occurrence_id !== null)!
          .scheduled_for.toISOString(),
      ).toBe(originalP);
      expect(
        both
          .find((x) => x.manual_request_id !== null)!
          .scheduled_for.toISOString(),
      ).toBe(first.requestedAt);
      expect(taskScheduledAt((await snapshot(t.id)).task)).toBe(
        new Date(Date.parse(originalP) + 60_000).toISOString(),
      );
      expect(
        both.filter((x) => x.native_recurring_occurrence_id !== null),
      ).toHaveLength(1);
    });
    it('manual metadata and the first legal native target can share an instant without competing for scheduled uniqueness', async () => {
      const t = await task(
          '同刻索引身份隔离',
          { kind: 'every', seconds: 60 },
          { prepareNative: false },
        ),
        manual = await runManualAutomation(f.context, f.workspaceId, t.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
        });
      // SQL component fixture only. This is the first Task, with no previous
      // native target or receipt; it never rewrites an already-existing P.
      expect((await snapshot(t.id)).task).toBeNull();
      await prepareNativeTask(t.id, manual.requestedAt);
      await receipt(t.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      const rows =
        await f.db`select run_id,scheduled_for,manual_request_id,native_recurring_occurrence_id
        from allrice_automation_runs where automation_id=${t.id}`;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.run_id)).size).toBe(2);
      expect(
        rows.every((r) => r.scheduled_for.toISOString() === manual.requestedAt),
      ).toBe(true);
      expect(
        rows.filter(
          (r) =>
            r.manual_request_id !== null &&
            r.native_recurring_occurrence_id === null,
        ),
      ).toHaveLength(1);
      expect(
        rows.filter(
          (r) =>
            r.manual_request_id === null &&
            r.native_recurring_occurrence_id !== null,
        ),
      ).toHaveLength(1);
    });
    it('paused manual execution stays paused; exact old request retains its original revision after edit and deletion', async () => {
      const t = await task();
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: randomUUID(),
          expectedRevision: 1,
          action: 'pause',
        }),
      ).toMatchObject({
        status: 'applied',
        task: { revision: 2, status: 'paused' },
      });
      const before = await manualBoundary(t.id),
        input = { requestId: randomUUID(), expectedRevision: 2 },
        first = await runManualAutomation(
          f.context,
          f.workspaceId,
          t.id,
          input,
        );
      expect(await manualBoundary(t.id)).toEqual(before);
      const update = {
        operationId: randomUUID(),
        expectedRevision: 2,
        action: 'update' as const,
        name: '改名后任务',
        prompt: '新的工作正文',
        rule: t.input.rule,
      };
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, update),
      ).toMatchObject({
        status: 'pending',
        task: { revision: 3, status: 'paused' },
      });
      expect(
        (await runManualAutomation(f.context, f.workspaceId, t.id, input)).run
          .id,
      ).toBe(first.run.id);
      await expect(
        runManualAutomation(f.context, f.workspaceId, t.id, {
          ...input,
          expectedRevision: 3,
        }),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      await expect(
        runManualAutomation(f.context, f.workspaceId, t.id, {
          requestId: randomUUID(),
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      // A rejected operation is not a persisted delete intent. The previous
      // same-rule update must be confirmed before a new delete is accepted.
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: randomUUID(),
          expectedRevision: 3,
          action: 'delete',
        }),
      ).toMatchObject({
        status: 'rejected',
        errorMessage: '上一项操作仍在确认，请稍后查看结果。',
        task: { revision: 3, status: 'paused' },
      });
      expect(
        (
          await f.db`select deleted_at,revision from allrice_automations where id=${t.id}`
        )[0],
      ).toMatchObject({ deleted_at: null, revision: 3 });
      const pendingUpdate = await snapshot(t.id);
      await mutate({
        kind: 'confirm_command',
        controlId: pendingUpdate.control.controlId,
        commandId: update.operationId,
        nativeTaskId: pendingUpdate.control.nativeTaskId,
      });
      expect(
        await changeRecurringTask(f.context, t.sessionId, t.id, {
          operationId: randomUUID(),
          expectedRevision: 3,
          action: 'delete',
        }),
      ).toMatchObject({
        status: 'pending',
        task: { revision: 4, status: 'deleting' },
      });
      const deleteIntent = (
        await f.db`select deleted_at,revision from allrice_automations where id=${t.id}`
      )[0]!;
      expect(deleteIntent.deleted_at).not.toBeNull();
      expect(deleteIntent.revision).toBe(4);
      expect((await snapshot(t.id)).control).toMatchObject({
        command: { kind: 'delete', status: 'pending' },
        taskDeleted: false,
      });
      expect((await snapshot(t.id)).task).not.toBeNull();
      const deleted = await manualBoundary(t.id);
      const countBefore = (
        await f.db`select count(*)::int n from allrice_automation_runs where automation_id=${t.id}`
      )[0]!.n;
      expect(
        (
          await getManualAutomationRun(
            f.context,
            f.workspaceId,
            t.id,
            input.requestId,
          )
        ).request,
      ).toEqual(input);
      expect(
        (await runManualAutomation(f.context, f.workspaceId, t.id, input)).run
          .id,
      ).toBe(first.run.id);
      await expect(
        runManualAutomation(f.context, f.workspaceId, t.id, {
          requestId: randomUUID(),
          expectedRevision: 4,
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        runManualAutomation(f.context, f.workspaceId, t.id, {
          requestId: randomUUID(),
          expectedRevision: 3,
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(
        (
          await f.db`select count(*)::int n from allrice_automation_runs where automation_id=${t.id}`
        )[0]!.n,
      ).toBe(countBefore);
      expect(await manualBoundary(t.id)).toEqual(deleted);
    });
    it('current viewer/cloud revocation and foreign scope create no manual work, even with a cached admin context', async () => {
      const t = await task(
          '核对本轮数据。',
          { kind: 'every', seconds: 60 },
          { conversationMode: 'new_each_run' },
        ),
        input = { requestId: randomUUID(), expectedRevision: 1 },
        before = await manualBoundary(t.id);
      const transactionalCounts = async () =>
        (
          await f.db`select
        (select count(*)::int from allrice_chat_sessions) chats,
        (select count(*)::int from allrice_messages) messages,
        (select count(*)::int from allrice_employee_runs) employee_runs,
        (select count(*)::int from allrice_automation_runs) automation_runs,
        (select count(*)::int from allrice_runs) runs,
        (select count(*)::int from allrice_jobs) jobs,
        (select count(*)::int from allrice_audit_events) audits`
        )[0];
      const beforeTransaction = await transactionalCounts();
      await f.db`update allrice_memberships set role='viewer' where user_id=${f.ownerId} and organization_id=${f.organizationId}`;
      try {
        await expect(
          runManualAutomation(f.context, f.workspaceId, t.id, input),
        ).rejects.toMatchObject({ code: 'authority_denied' });
      } finally {
        await f.db`update allrice_memberships set role='admin' where user_id=${f.ownerId} and organization_id=${f.organizationId}`;
      }
      await cloud(false);
      try {
        await expect(
          runManualAutomation(f.context, f.workspaceId, t.id, input),
        ).rejects.toMatchObject({ code: 'authority_denied' });
      } finally {
        await cloud(true);
      }
      await expect(
        runManualAutomation(
          { ...f.context, actor: { type: 'user', id: randomUUID() } },
          f.workspaceId,
          t.id,
          input,
        ),
      ).rejects.toMatchObject({ code: 'authority_denied' });
      await expect(
        runManualAutomation(f.context, randomUUID(), t.id, input),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(
        await f.db`select id from allrice_automation_runs where automation_id=${t.id}`,
      ).toHaveLength(0);
      expect(await transactionalCounts()).toEqual(beforeTransaction);
      expect(await manualBoundary(t.id)).toEqual(before);
    });
    it('confirmed rollback leaves zero work; lost manual COMMIT ACK only reads the original durable request', async () => {
      const t = await task(
          '核对本轮数据。',
          { kind: 'every', seconds: 60 },
          { conversationMode: 'new_each_run' },
        ),
        input = { requestId: randomUUID(), expectedRevision: 1 },
        before = await manualBoundary(t.id);
      const counts = async () =>
        (
          await f.db`select
        (select count(*)::int from allrice_chat_sessions) chats,
        (select count(*)::int from allrice_messages) messages,
        (select count(*)::int from allrice_employee_runs) employee_runs,
        (select count(*)::int from allrice_automation_runs) automation_runs,
        (select count(*)::int from allrice_runs) runs,
        (select count(*)::int from allrice_jobs) jobs,
        (select count(*)::int from allrice_audit_events) audits`
        )[0];
      const beforeCounts = await counts();
      function fault(afterCommit: boolean) {
        return new Proxy(f.db, {
          get(target, key, receiver) {
            if (key !== 'begin') return Reflect.get(target, key, receiver);
            return async (...args: unknown[]) => {
              if (afterCommit) {
                await Reflect.apply(target.begin, target, args);
                throw Error('lost manual COMMIT ACK');
              }
              const callback = args.at(-1) as (
                tx: TransactionSql,
              ) => Promise<unknown>;
              return target.begin(async (tx) => {
                await callback(tx);
                throw Error('known manual precommit rollback');
              });
            };
          },
        });
      }
      let spy = vi.spyOn(client, 'getDatabase').mockReturnValue(fault(false));
      try {
        await expect(
          runManualAutomation(f.context, f.workspaceId, t.id, input),
        ).rejects.toThrow('known manual precommit rollback');
      } finally {
        spy.mockRestore();
      }
      expect(
        await f.db`select id from allrice_automation_runs where automation_id=${t.id}`,
      ).toHaveLength(0);
      expect(await counts()).toEqual(beforeCounts);
      spy = vi.spyOn(client, 'getDatabase').mockReturnValue(fault(true));
      try {
        await expect(
          runManualAutomation(f.context, f.workspaceId, t.id, input),
        ).rejects.toThrow('lost manual COMMIT ACK');
      } finally {
        spy.mockRestore();
      }
      const original = await getManualAutomationRun(
        f.context,
        f.workspaceId,
        t.id,
        input.requestId,
      );
      expect(original.request).toEqual(input);
      expect(original.sessionId).not.toBe(t.sessionId);
      expect(
        await f.db`select ar.id from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${t.id}`,
      ).toHaveLength(1);
      expect(await manualBoundary(t.id)).toEqual(before);
    });
    it('stops only explicit manual identity on a native parent and preserves native history and the future plan', async () => {
      const t = await task();
      await receipt(t.id);
      await dispatchNextNativeRecurringOccurrence(randomUUID());
      const native = (
          await getAutomationCatalogTask(f.context, f.workspaceId, t.id)
        ).occurrences[0]!,
        manual = await runManualAutomation(f.context, f.workspaceId, t.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
        }),
        exact = {
          occurrenceId: manual.automationRunId,
          runId: manual.run.id,
          source: 'manual' as const,
        },
        before = await manualBoundary(t.id);
      for (const wrong of [
        { occurrenceId: exact.occurrenceId, runId: exact.runId },
        { ...exact, source: 'native_occurrence' },
        { ...exact, source: 'legacy_run' },
        { ...exact, runId: native.runId },
      ])
        await expect(
          stopAutomationCatalogOccurrence(
            f.context,
            f.workspaceId,
            t.id,
            wrong,
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
      const stopped = await stopAutomationCatalogOccurrence(
        f.context,
        f.workspaceId,
        t.id,
        exact,
      );
      expect(stopped).toMatchObject({
        source: 'manual',
        run: { id: manual.run.id, cancelRequestedAt: expect.any(String) },
      });
      expect(
        (
          await getAutomationCatalogOccurrenceRun(
            f.context,
            f.workspaceId,
            t.id,
            {
              occurrenceId: native.id,
              runId: native.runId,
              source: 'native_occurrence',
            },
          )
        ).run.cancelRequestedAt,
      ).toBeNull();
      const other = await task();
      await expect(
        getManualAutomationRun(
          f.context,
          f.workspaceId,
          other.id,
          manual.request.requestId,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(await manualBoundary(t.id)).toEqual(before);
    });
    it('manual SQL identity is immutable and an unbound fake request fails its deferred business fence', async () => {
      const t = await task(),
        manual = await runManualAutomation(f.context, f.workspaceId, t.id, {
          requestId: randomUUID(),
          expectedRevision: 1,
        });
      await expect(
        f.db`delete from allrice_automation_runs where id=${manual.automationRunId}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        f.db`update allrice_automation_runs set manual_request_digest=${'sha256:' + 'f'.repeat(64)} where id=${manual.automationRunId}`,
      ).rejects.toMatchObject({ code: '23514' });
      const fake = randomUUID();
      await expect(
        f.db.begin(async (tx) => {
          await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,session_id,scheduled_for,manual_request_id,manual_request_digest,manual_revision,manual_source,manual_requested_at)
        values(${fake},${f.organizationId},${f.workspaceId},${t.id},${t.sessionId},transaction_timestamp(),${randomUUID()},${'sha256:' + 'e'.repeat(64)},1,'user',transaction_timestamp())`;
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        await f.db`select id from allrice_automation_runs where id=${fake}`,
      ).toHaveLength(0);
    });
    it('catalog reads across sessions without seeding and rejects foreign scope', async () => {
      const first = await task('MET197 catalog group: first');
      const second = await task('MET197 catalog group: second');
      const [before] =
        await f.db`select count(*)::int n from allrice_automations`;
      const list = await listAutomationCatalog(f.context, {
        workspaceId: f.workspaceId,
        query: 'MET197 catalog group:',
      });
      expect(list.tasks.map((t) => t.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(new Set(list.tasks.map((t) => t.sessionId)).size).toBe(2);
      const found = list.tasks[0]!;
      expect(found.definition).toMatchObject({
        kind: 'recurring',
        task: { canManage: true },
      });
      expect(
        (
          await listAutomationCatalog(f.context, {
            workspaceId: f.workspaceId,
            employeeId: found.employeeId!,
            query: 'MET197 catalog group:',
          })
        ).tasks,
      ).toHaveLength(2);
      const [after] =
        await f.db`select count(*)::int n from allrice_automations`;
      expect(after!.n).toBe(before!.n);
      await expect(
        getAutomationCatalogTask(
          { ...f.context, actor: { type: 'user', id: randomUUID() } },
          f.workspaceId,
          first.id,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        listAutomationCatalog(f.context, { workspaceId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        listAutomationCatalog(f.context, {
          workspaceId: f.workspaceId,
          cursor: 'not-a-cursor',
        }),
      ).rejects.toThrow();
    });
    it('catalog stops an archived source with cloud off, resolves the exact operation and forbids resume', async () => {
      const t = await task('MET197 archived source');
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${t.sessionId}`;
      await cloud(false);
      try {
        const before = await getAutomationCatalogTask(
          f.context,
          f.workspaceId,
          t.id,
        );
        expect(before.task).toMatchObject({
          sourceArchived: true,
          canStop: true,
          definition: { kind: 'recurring', task: { canManage: false } },
        });
        const input = {
          action: 'pause' as const,
          operationId: randomUUID(),
          expectedRevision: 1,
        };
        expect(
          await changeAutomationCatalogTask(
            f.context,
            f.workspaceId,
            t.id,
            input,
          ),
        ).toMatchObject({
          operation: { status: 'applied', task: { status: 'paused' } },
        });
        expect(
          await getAutomationCatalogOperation(
            f.context,
            f.workspaceId,
            t.id,
            input.operationId,
          ),
        ).toMatchObject({ operation: { request: input, status: 'applied' } });
        await expect(
          changeAutomationCatalogTask(f.context, f.workspaceId, t.id, {
            action: 'resume',
            operationId: randomUUID(),
            expectedRevision: 2,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
        await changeAutomationCatalogTask(f.context, f.workspaceId, t.id, {
          action: 'delete',
          operationId: randomUUID(),
          expectedRevision: 2,
        });
        expect(
          (
            await listAutomationCatalog(f.context, {
              workspaceId: f.workspaceId,
              query: 'MET197 archived source',
            })
          ).tasks,
        ).toHaveLength(0);
        expect(
          (await getAutomationCatalogTask(f.context, f.workspaceId, t.id)).task
            .definition,
        ).toMatchObject({ kind: 'recurring', task: { status: 'deleting' } });
      } finally {
        await cloud(true);
      }
    });
    it('catalog preserves microsecond pagination across identical millisecond timestamps', async () => {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'MET197 paging',
      });
      const ids: string[] = [];
      for (let i = 0; i < 52; i++) {
        const t = await createRecurringTask(f.context, session.id, {
          clientRequestId: randomUUID(),
          name: 'MET197 microsecond paging',
          prompt: 'MET197 microsecond paging',
          rule: { kind: 'every', seconds: 60 },
        });
        ids.push(t.id);
        await f.db`update allrice_automations set created_at='2026-10-20T01:00:00Z'::timestamptz+${i}*interval '1 microsecond' where id=${t.id}`;
      }
      const page = await listAutomationCatalog(f.context, {
        workspaceId: f.workspaceId,
        query: 'MET197 microsecond paging',
      });
      expect(page.tasks).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      const rest = await listAutomationCatalog(f.context, {
        workspaceId: f.workspaceId,
        query: 'MET197 microsecond paging',
        cursor: page.nextCursor!,
      });
      expect(rest.tasks).toHaveLength(2);
      expect(rest.nextCursor).toBeNull();
      expect([...page.tasks, ...rest.tasks].map((t) => t.id).sort()).toEqual(
        ids.sort(),
      );
    });
    it('edits existing weekly legacy configuration without replacing its clock and preserves deleted history', async () => {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'MET197 legacy catalog',
      });
      const id = randomUUID(),
        schedule = {
          frequency: 'weekly',
          weekday: 2,
          time: '09:00',
          timezone: 'Asia/Shanghai',
        };
      await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,next_run_at) values(${id},${f.organizationId},${f.workspaceId},${f.ownerId},'MET197 legacy weekly','整理现有周报','schedule',${f.db.json(schedule)},'enabled','reuse',${f.assignmentId},${session.id},'2099-01-01T01:00:00Z')`;
      expect(
        (await getAutomationCatalogTask(f.context, f.workspaceId, id)).task
          .definition,
      ).toMatchObject({ kind: 'legacy', schedule, revision: 1 });
      const update = {
        action: 'update',
        expectedRevision: 1,
        name: 'MET197 weekly edited',
        prompt: '整理原周报',
        schedule: { ...schedule, time: '10:15' },
      };
      await changeAutomationCatalogTask(f.context, f.workspaceId, id, update);
      await expect(
        changeAutomationCatalogTask(f.context, f.workspaceId, id, update),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      const [actual] =
        await f.db`select clock_owner,revision,schedule from allrice_automations where id=${id}`;
      expect(actual).toMatchObject({
        clock_owner: 'legacy',
        revision: 2,
        schedule: { frequency: 'weekly', weekday: 2, time: '10:15' },
      });
      await changeAutomationCatalogTask(f.context, f.workspaceId, id, {
        action: 'delete',
        expectedRevision: 2,
      });
      expect(
        (
          await listAutomationCatalog(f.context, {
            workspaceId: f.workspaceId,
            query: 'MET197 weekly edited',
          })
        ).tasks,
      ).toHaveLength(0);
      expect(
        (await getAutomationCatalogTask(f.context, f.workspaceId, id)).task
          .definition,
      ).toMatchObject({ kind: 'legacy', status: 'deleted', revision: 3 });
    });
    it('PostgreSQL rejects an outbox lease expiring at COMMIT and rolls back the whole Run', async () => {
      const t = await task();
      await receipt(t.id);
      const [baseline] = await f.db`select count(*)::int n from allrice_runs`;
      let phase = 0;
      const db = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            const thisPhase = ++phase,
              callback = args.at(-1) as (
                tx: TransactionSql,
              ) => Promise<unknown>;
            const forwarded = [...args];
            forwarded[forwarded.length - 1] = async (tx: TransactionSql) => {
              const result = await callback(tx);
              if (thisPhase === 1)
                await tx`update allrice_native_recurring_occurrences set outbox_expires_at=clock_timestamp()+interval '1 second' where automation_id=${t.id}`;
              if (thisPhase === 2) {
                // Let the exact lease captured by the pending -> enqueued update
                // expire. Replacing its timestamp afterward is not that boundary.
                await tx`select pg_sleep(1.05)`;
              }
              return result;
            };
            return Reflect.apply(target.begin, target, forwarded);
          };
        },
      });
      const spy = vi.spyOn(client, 'getDatabase').mockReturnValue(db);
      try {
        await expect(
          dispatchNextNativeRecurringOccurrence(randomUUID()),
        ).rejects.toMatchObject({ code: 'P1921' });
      } finally {
        spy.mockRestore();
      }
      const [after] = await f.db`select count(*)::int n from allrice_runs`;
      expect(after!.n).toBe(baseline!.n);
      const [o] =
        await f.db`select outbox_state,business_binding from allrice_native_recurring_occurrences where automation_id=${t.id}`;
      expect(o).toMatchObject({
        outbox_state: 'pending',
        business_binding: null,
      });
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
    });
    it('writer expiry at COMMIT rolls back the recurring snapshot, receipt and journal together', async () => {
      const t = await task(),
        before = await snapshot(t.id);
      const native = structuredClone(before.task) as NativeRecurringTask;
      const delivery = {
        scheduledAt: native.record.scheduledAt,
        deliveredAt: new Date().toISOString(),
        messageId: randomUUID(),
      };
      native.lastDelivery = delivery;
      native.deliveryHistory = {
        records: [{ ...delivery, prompt: native.record.prompt }],
        earlierRecordsUnavailable: false,
      };
      native.record.scheduledAt = new Date(
        Date.parse(delivery.scheduledAt) + 60_000,
      ).toISOString();
      const mutation: NativeRecurringMutation = {
        kind: 'put_task',
        controlId: before.control.controlId,
        task: native,
      };
      const write = {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      };
      let commitError: unknown;
      const db = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            const callback = args.at(-1) as (
                tx: TransactionSql,
              ) => Promise<unknown>,
              forwarded = [...args];
            forwarded[forwarded.length - 1] = async (tx: TransactionSql) => {
              const result = await callback(tx);
              const [journal] =
                await tx`select write_id from allrice_native_recurring_journal where write_id=${write.writeId}`;
              expect(journal).toBeDefined();
              // All application checks already passed. Only PostgreSQL's deferred
              // fence can reject this transaction after the lease actually expires.
              await tx`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '20 milliseconds' where partition_id=${writer.partitionId}`;
              await tx`select pg_sleep(0.04)`;
              return result;
            };
            try {
              return await Reflect.apply(target.begin, target, forwarded);
            } catch (error) {
              commitError = error;
              throw error;
            }
          };
        },
      });
      const expiring = createNativeRecurringSqlStore({
        db,
        partitionId: writer.partitionId,
        ownerId: writer.ownerId,
        reference: JSON.parse(process.env.ALLRICE_NATIVE_RECURRING_REFERENCE!),
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeRecurringTask,
        lockAdmission: lockNativeRecurringAdmissions,
        proveClosed: async () => null,
      });
      expect(await expiring.commitMutation(writer, write)).toBe('rejected');
      expect(commitError).toMatchObject({ code: 'P1920' });
      expect(await snapshot(t.id)).toEqual(before);
      expect(
        await f.db`select occurrence_id from allrice_native_recurring_occurrences where automation_id=${t.id}`,
      ).toHaveLength(0);
      expect(await store.readExactCommit(writer, write)).toBe('absent');
      expect(await store.assertWriter(writer)).toBe(true);
    });
    it('a lost COMMIT ACK leaves one durable Run; retry consumes no second occurrence', async () => {
      const t = await task();
      await receipt(t.id);
      let phase = 0;
      const db = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            const thisPhase = ++phase;
            const result = await Reflect.apply(target.begin, target, args);
            if (thisPhase === 2)
              throw Error(
                'synthetic transport lost the successful COMMIT response',
              );
            return result;
          };
        },
      });
      const spy = vi.spyOn(client, 'getDatabase').mockReturnValue(db);
      try {
        await expect(
          dispatchNextNativeRecurringOccurrence(randomUUID()),
        ).rejects.toThrow('lost the successful COMMIT');
      } finally {
        spy.mockRestore();
      }
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      const runs =
        await f.db`select run_id from allrice_automation_runs where automation_id=${t.id}`;
      expect(runs).toHaveLength(1);
    });
    it('permission revocation after enqueue denies admission without erasing the result or plan', async () => {
      const t = await task();
      await receipt(t.id);
      await dispatchNextNativeRecurringOccurrence(randomUUID());
      const [j] =
        await f.db`select j.id from allrice_jobs j join allrice_automation_runs ar on ar.run_id=j.run_id where ar.automation_id=${t.id}`;
      await cloud(false);
      try {
        expect(
          await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, j!.id)),
        ).toMatchObject({ scheduled: true, allowed: false });
      } finally {
        await cloud(true);
      }
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, j!.id)),
      ).toMatchObject({ scheduled: true, allowed: true });
      const op = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'pause' as const,
      };
      await changeRecurringTask(f.context, t.sessionId, t.id, op);
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, j!.id)),
      ).toMatchObject({ scheduled: true, allowed: true });
    });
    it('does not skip tasks with PostgreSQL microseconds at the pagination boundary', async () => {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Pagination',
      });
      const ids: string[] = [];
      for (let i = 1; i <= 51; i++) {
        const p = await createRecurringTask(f.context, session.id, {
          clientRequestId: randomUUID(),
          name: `计划${i}`,
          prompt: '隔离分页检查',
          rule: { kind: 'every', seconds: 60 },
        });
        ids.push(p.id);
        await f.db`update allrice_automations set created_at='2000-01-01T00:00:00.123000Z'::timestamptz+${i}*interval '1 microsecond' where id=${p.id}`;
      }
      const first = await listRecurringTasks(f.context, session.id);
      expect(first.tasks.map((p) => p.id)).toEqual(ids.slice(1).reverse());
      expect(first.nextCursor).not.toBeNull();
      const last = await listRecurringTasks(f.context, session.id, {
        cursor: first.nextCursor!,
      });
      expect(last.tasks.map((p) => p.id)).toEqual([ids[0]]);
      expect(last.nextCursor).toBeNull();
    });
    it('conversation tool mode is authorized only by the current human and remains in exact create replay', async () => {
      const text = '请每隔两分钟回复本轮核对结果；每次新建聊天',
        r = await leasedChat(
          text,
          { kind: 'every', seconds: 120 },
          randomUUID(),
          'new_each_run',
        );
      try {
        const before = await enrollmentCounts();
        await expect(
          createRecurringTaskFromExecutionContext({
            ...r.input,
            conversationMode: 'reuse',
          }),
        ).rejects.toThrow('intent_required');
        expect(await enrollmentCounts()).toEqual(before);
        const created = await createRecurringTaskFromExecutionContext(r.input);
        expect(created).toMatchObject({
          conversationMode: 'new_each_run',
          prompt: text,
        });
        expect(await createRecurringTaskFromExecutionContext(r.input)).toEqual(
          created,
        );
        expect(
          (
            await listRecurringTasks(f.context, r.input.sessionId, {
              clientRequestId: created.clientRequestId,
            })
          ).request,
        ).toMatchObject({ conversationMode: 'new_each_run', prompt: text });
        await expect(
          createRecurringTaskFromExecutionContext({
            ...r.input,
            conversationMode: 'reuse',
          }),
        ).rejects.toThrow('request_conflict');
      } finally {
        await r.finish();
      }
      const denied = await leasedChat(
        '请每隔两分钟回复“每次新建聊天”',
        { kind: 'every', seconds: 120 },
        randomUUID(),
        'new_each_run',
      );
      try {
        const before = await enrollmentCounts();
        await expect(
          createRecurringTaskFromExecutionContext(denied.input),
        ).rejects.toThrow('intent_required');
        expect(await enrollmentCounts()).toEqual(before);
      } finally {
        await denied.finish();
      }
    });

    it('creates from the exact current human rule and preserves original bytes/version through duplicate calls', async () => {
      const r = await leasedChat();
      try {
        const before = await enrollmentCounts();
        const [first, duplicate] = await Promise.all([
          createRecurringTaskFromExecutionContext(r.input),
          createRecurringTaskFromExecutionContext(r.input),
        ]);
        expect(first).toEqual(duplicate);
        expect(first).toMatchObject({
          prompt: chatRequest,
          rule: { kind: 'every', seconds: 120 },
          status: 'preparing',
          nextRunAt: null,
        });
        expect(await enrollmentCounts()).toEqual({
          ...before,
          plans: before.plans + 1,
          controls: before.controls + 1,
          versions: before.versions + 1,
        });
        const [stored] =
          await f.db`select a.prompt,v.configuration->>'prompt' version_prompt from allrice_automations a join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=1 where a.id=${first.id}`;
        expect(stored).toEqual({
          prompt: chatRequest,
          version_prompt: chatRequest,
        });
        const exact = await listRecurringTasks(f.context, r.input.sessionId, {
          clientRequestId: first.clientRequestId,
        });
        expect(exact.request).toMatchObject({
          prompt: chatRequest,
          rule: first.rule,
        });
        await expect(
          createRecurringTaskFromExecutionContext({
            ...r.input,
            prompt: 'changed original call',
          }),
        ).rejects.toMatchObject({ code: 'request_conflict' });
        await expect(
          createRecurringTaskFromExecutionContext({
            ...r.input,
            rule: { kind: 'every', seconds: 180 },
          }),
        ).rejects.toMatchObject({ code: 'request_conflict' });
        const next = await createRecurringTaskFromExecutionContext({
          ...r.input,
          callId: randomUUID(),
        });
        expect(next.id).not.toBe(first.id);
      } finally {
        await r.finish();
      }
    });
    async function confirmedFrequency(
      r: Awaited<ReturnType<typeof leasedChat>>,
      label = '每隔 1 分钟提醒',
    ) {
      const followup = await sendChatMessage(
        f.context,
        f.workspaceId,
        r.input.sessionId,
        {
          clientMessageId: randomUUID(),
          text: 'Isolated typed answer fixture',
          deliveryMode: 'follow_up',
        },
      );
      const questionId = `question-${randomUUID()}`;
      const turnId = `dsh-${r.input.context.runId}:turn:1`;
      const question = {
        questionId,
        questions: [
          {
            id: 'frequency',
            question: '一次还是循环？',
            options: [
              { label: '1 分钟后提醒一次' },
              { label: '每隔 1 分钟提醒' },
            ],
            multiSelect: false,
          },
        ],
      };
      const answer = {
        questionId,
        answers: [{ id: 'frequency', selected: [label] }],
      };
      const clientId = followup.userMessage.clientMessageId;
      await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        select ${f.organizationId},${f.workspaceId},${r.input.context.runId},coalesce(max(sequence),0)+1,'harness.native',
          ${f.db.json({ sourceEventType: 'session/user-question', turnId, generation: 1, nativePayload: question })}
        from allrice_run_events where run_id=${r.input.context.runId}`;
      await f.db`update allrice_messages set content=${f.db.json({ text: `提醒频率：${label}`, citations: [], interaction: { type: 'user_question_answer', answer } })}
        where id=${followup.userMessage.id}`;
      await f.db`insert into allrice_conversation_followups(run_id,organization_id,workspace_id,session_id,owner_id,user_message_id,assistant_message_id,client_user_message_id,mode,state)
        values(${followup.run.id},${f.organizationId},${f.workspaceId},${r.input.sessionId},${r.input.context.policySnapshot.subjectId},
          ${followup.userMessage.id},${followup.assistantMessage.id},${clientId},'follow_up','consumed') on conflict(run_id) do nothing`;
      const [c] =
        await f.db`insert into allrice_conversation_commands(organization_id,workspace_id,session_id,owner_id,followup_run_id,command_type,
        client_user_message_id,expected_generation,expected_turn_id,message,input_kind,state,native_proof)
        values(${f.organizationId},${f.workspaceId},${r.input.sessionId},${r.input.context.policySnapshot.subjectId},${followup.run.id},'steer',
          ${clientId},1,${turnId},${'allrice:user-question:v1:' + JSON.stringify(answer)},'ask_user','consumed',
          ${f.db.json({ status: 'adopted', turnId, inputId: clientId, sequence: 18, messageId: questionId, checkpoint: 'question_resolved' })}) returning id`;
      return { commandId: c!.id, followup, questionId, turnId };
    }
    it('creates the reported recurring shorthand only after its same-Run typed confirmation, preserves both human sources, and compares the chosen rule', async () => {
      const r = await leasedChat('1 分钟尖叫一次', {
        kind: 'every',
        seconds: 60,
      });
      try {
        const before = await enrollmentCounts();
        await expect(
          createRecurringTaskFromExecutionContext(r.input),
        ).rejects.toMatchObject({ code: 'intent_required' });
        expect(await enrollmentCounts()).toEqual(before);
        const choice = await confirmedFrequency(r);
        for (const patch of [
          { state: 'claimed' },
          { expected_generation: 2 },
          { expected_turn_id: 'other:turn:1' },
          { native_proof: { status: 'pending' } },
        ]) {
          const [original] =
            await f.db`select * from allrice_conversation_commands where id=${choice.commandId}`;
          await f.db`update allrice_conversation_commands set ${f.db(patch)} where id=${choice.commandId}`;
          await expect(
            createRecurringTaskFromExecutionContext(r.input),
          ).rejects.toMatchObject({ code: 'intent_required' });
          await f.db`update allrice_conversation_commands set state=${original!.state},expected_generation=${original!.expected_generation},
            expected_turn_id=${original!.expected_turn_id},native_proof=${f.db.json(original!.native_proof)} where id=${choice.commandId}`;
          expect(await enrollmentCounts()).toEqual(before);
        }
        await expect(
          createRecurringTaskFromExecutionContext({
            ...r.input,
            rule: { kind: 'every', seconds: 120 },
          }),
        ).rejects.toMatchObject({ code: 'rule_mismatch' });
        const created = await createRecurringTaskFromExecutionContext(r.input);
        expect(created).toMatchObject({
          rule: { kind: 'every', seconds: 60 },
          prompt: '1 分钟尖叫一次\n用户已确认的提醒频率：每隔 1 分钟提醒',
        });
        expect(await createRecurringTaskFromExecutionContext(r.input)).toEqual(
          created,
        );
        expect((await enrollmentCounts()).plans).toBe(before.plans + 1);
        await f.db`insert into allrice_task_calls(run_id,native_session_id,call_id,kind,name,outcome,finished_at)
          values(${r.input.context.runId},'fixture-native-session',${r.input.callId},'tool','automation.create','success',clock_timestamp())`;
        await expect(
          createRecurringTaskFromExecutionContext({
            ...r.input,
            callId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'intent_required' });
        expect((await enrollmentCounts()).plans).toBe(before.plans + 1);
      } finally {
        await r.finish();
      }
    });
    it('does not override a selected one-time reminder with a recurring call', async () => {
      const r = await leasedChat('1 分钟尖叫一次', {
        kind: 'every',
        seconds: 60,
      });
      try {
        const before = await enrollmentCounts();
        await confirmedFrequency(r, '1 分钟后提醒一次');
        await expect(
          createRecurringTaskFromExecutionContext(r.input),
        ).rejects.toMatchObject({ code: 'intent_required' });
        expect(await enrollmentCounts()).toEqual(before);
      } finally {
        await r.finish();
      }
    });
    it('compares the full daily wall-clock and explicit IANA timezone before enrollment', async () => {
      const text =
        '请每天09:30，时区Asia/Shanghai，在这个对话中只回复校验词「RECURRING-NL-B」。请创建周期任务。';
      const rule = {
        kind: 'daily' as const,
        time: '09:30:00',
        timezone: 'Asia/Shanghai',
      };
      const r = await leasedChat(text, rule);
      try {
        const before = await enrollmentCounts();
        for (const wrong of [
          { ...rule, time: '09:31:00' },
          { ...rule, timezone: 'UTC' },
          { kind: 'every' as const, seconds: 86400 },
        ]) {
          await expect(
            createRecurringTaskFromExecutionContext({
              ...r.input,
              rule: wrong,
            }),
          ).rejects.toMatchObject({ code: 'rule_mismatch' });
          expect(await enrollmentCounts()).toEqual(before);
        }
        expect(
          await createRecurringTaskFromExecutionContext(r.input),
        ).toMatchObject({ prompt: text, rule });
      } finally {
        await r.finish();
      }
    });
    it.each([
      '请解释示例：“每十五分钟提醒我喝水”。',
      '如果我确认了，再每十五分钟提醒我。',
      '不要每天提醒我。',
      '每天九点提醒我。',
      '请每周一09:30提醒我。',
      '好，按照上面的安排。',
      '请在十五分钟后回复校验词。',
    ])(
      'rejects unsupported/quoted/conditional/history-only current wording with zero enrollment: %s',
      async (text) => {
        const r = await leasedChat(text);
        try {
          const before = await enrollmentCounts();
          await expect(
            createRecurringTaskFromExecutionContext(r.input),
          ).rejects.toMatchObject({ code: 'intent_required' });
          expect(await enrollmentCounts()).toEqual(before);
        } finally {
          await r.finish();
        }
      },
    );
    it('compares all weekly days, time and timezone with the current human request before any write', async () => {
      const rule = {
        kind: 'weekly' as const,
        weekdays: [1, 3],
        time: '09:30:00',
        timezone: 'Asia/Shanghai',
      };
      const c = await leasedChat(
        '请每周一、三09:30，时区Asia/Shanghai，在当前对话中只回复校验词「WEEKLY-EXACT」。请实际创建周期任务。',
        rule,
      );
      try {
        const before = await enrollmentCounts();
        for (const changed of [
          { ...rule, weekdays: [1, 4] },
          { ...rule, time: '10:30:00' },
          { ...rule, timezone: 'UTC' },
        ]) {
          await expect(
            createRecurringTaskFromExecutionContext({
              ...c.input,
              rule: changed,
            }),
          ).rejects.toMatchObject({ code: 'rule_mismatch' });
          expect(await enrollmentCounts()).toEqual(before);
        }
        const saved = await createRecurringTaskFromExecutionContext(c.input);
        expect(saved.rule).toEqual(rule);
        expect(saved.prompt).toBe(
          '请每周一、三09:30，时区Asia/Shanghai，在当前对话中只回复校验词「WEEKLY-EXACT」。请实际创建周期任务。',
        );
        expect(saved.prompt).not.toBe(c.input.prompt);
        expect(
          (await createRecurringTaskFromExecutionContext(c.input)).id,
        ).toBe(saved.id);
      } finally {
        await c.finish();
      }
    });
    it('requires the current matching job lease, message and permission even on exact ACK replay', async () => {
      const r = await leasedChat();
      try {
        const first = await createRecurringTaskFromExecutionContext(r.input),
          before = await enrollmentCounts();
        const wrongInputs = [
          {
            ...r.input,
            worker: { ...r.input.worker, leaseToken: randomUUID() },
          },
          {
            ...r.input,
            worker: { ...r.input.worker, attempt: r.input.worker.attempt + 1 },
          },
          { ...r.input, userMessageId: randomUUID() },
          {
            ...r.input,
            context: {
              ...r.input.context,
              policySnapshot: { ...r.input.context.policySnapshot, grants: [] },
            },
          },
        ];
        for (const input of wrongInputs) {
          await expect(
            createRecurringTaskFromExecutionContext(input),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          expect(await enrollmentCounts()).toEqual(before);
        }
        await cloud(false);
        try {
          await expect(
            createRecurringTaskFromExecutionContext(r.input),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
        } finally {
          await cloud(true);
        }
        vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '0');
        try {
          await expect(
            createRecurringTaskFromExecutionContext(r.input),
          ).rejects.toMatchObject({ code: 'disabled' });
        } finally {
          vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
        }
        expect(await enrollmentCounts()).toEqual(before);
        expect(
          (await createRecurringTaskFromExecutionContext(r.input)).id,
        ).toBe(first.id);
      } finally {
        await r.finish();
      }
    });
    it('does not gain a tool absent from the immutable execution snapshot after assignment update', async () => {
      await f.db`update allrice_employee_assignments set employee_version_id=${f.employeeVersionId} where id=${f.assignmentId}`;
      let r: Awaited<ReturnType<typeof leasedChat>> | undefined;
      try {
        r = await leasedChat();
        const [frozen] =
          await f.db`select execution_snapshot from allrice_employee_runs where run_id=${r.input.context.runId}`;
        expect(
          frozen!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
        ).not.toContain('automation.create');
        await f.db`update allrice_employee_assignments set employee_version_id=${chatVersionId} where id=${f.assignmentId}`;
        const before = await enrollmentCounts();
        await expect(
          createRecurringTaskFromExecutionContext(r.input),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await enrollmentCounts()).toEqual(before);
      } finally {
        await r?.finish();
        await f.db`update allrice_employee_assignments set employee_version_id=${chatVersionId} where id=${f.assignmentId}`;
      }
    });
    it('rejects a legacy internal message even before the dispatcher fills run_id', async () => {
      const t = await task(),
        occurrenceId = randomUUID();
      await f.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,status,scheduled_for)
        values(${occurrenceId},${f.organizationId},${f.workspaceId},${t.id},'queued',clock_timestamp())`;
      const r = await leasedChat(
        chatRequest,
        { kind: 'every', seconds: 120 },
        occurrenceId,
      );
      try {
        const before = await enrollmentCounts();
        await expect(
          createRecurringTaskFromExecutionContext(r.input),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await enrollmentCounts()).toEqual(before);
      } finally {
        await r.finish();
      }
    });
    it('rolls back enrollment on a known transaction failure and only reads back a lost COMMIT ACK', async () => {
      const r = await leasedChat();
      const before = await enrollmentCounts();
      function fault(afterCommit: boolean) {
        return new Proxy(f.db, {
          get(target, key, receiver) {
            if (key !== 'begin') return Reflect.get(target, key, receiver);
            return async (...args: unknown[]) => {
              if (afterCommit) {
                await Reflect.apply(target.begin, target, args);
                throw Error('lost recurring COMMIT ACK');
              }
              const callback = args.at(-1) as (
                tx: TransactionSql,
              ) => Promise<unknown>;
              return target.begin(async (tx) => {
                await callback(tx);
                throw Error('known precommit rollback');
              });
            };
          },
        });
      }
      try {
        let spy = vi.spyOn(client, 'getDatabase').mockReturnValue(fault(false));
        try {
          await expect(
            createRecurringTaskFromExecutionContext(r.input),
          ).rejects.toThrow('known precommit rollback');
        } finally {
          spy.mockRestore();
        }
        expect(await enrollmentCounts()).toEqual(before);
        spy = vi.spyOn(client, 'getDatabase').mockReturnValue(fault(true));
        try {
          await expect(
            createRecurringTaskFromExecutionContext(r.input),
          ).rejects.toThrow('lost recurring COMMIT ACK');
        } finally {
          spy.mockRestore();
        }
        const requestId = employeeChatUuid(
          'native-recurring-call',
          f.organizationId,
          f.workspaceId,
          r.input.context.runId,
          r.input.callId,
        );
        const readback = await listRecurringTasks(
          f.context,
          r.input.sessionId,
          { clientRequestId: requestId },
        );
        expect(readback.tasks).toHaveLength(1);
        expect(readback.request).toMatchObject({
          prompt: chatRequest,
          rule: { kind: 'every', seconds: 120 },
        });
        expect(await enrollmentCounts()).toEqual({
          ...before,
          plans: before.plans + 1,
          controls: before.controls + 1,
          versions: before.versions + 1,
        });
      } finally {
        await r.finish();
      }
    });
  },
);
